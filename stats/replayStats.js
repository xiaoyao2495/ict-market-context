/**
 * Replay Stats（Phase 11 — transition-based funnel）
 *
 * 1. Funnel：状态【跃迁】计数（unique opportunities），不是采样占用
 *    - SCENARIO_ENTER_WATCH / ENTRY_GATE_ENTER_READY / PLAN_CREATED / TRADE_FILLED
 * 2. Expectancy：按 Bias/AMD/Draw 组合分组的胜率与期望值
 *    - WIN rate（AMBIGUOUS 排除）
 *    - avg R / total R / max consecutive losses
 *
 * 说明：R 是 risk 倍数（非 probability）；AMBIGUOUS 不参与胜率统计。
 */
/**
 * 从 transitions 数组计算漏斗（状态跃迁口径）
 * @param {Array} transitions replay 的 transitions
 * @returns {Object} { watchEntries, entryReadyEntries, plansReady, tradeFilled }
 */
function computeFunnel(transitions) {
    var funnel = {
        evaluations: 0,
        watchEntries: 0,
        entryReadyEntries: 0,
        plansReady: 0,
        tradeFilled: 0
    };
    (transitions || []).forEach(function (t) {
        if (t.type === 'SCENARIO_ENTER_WATCH') {
            funnel.watchEntries++;
        } else if (t.type === 'ENTRY_GATE_ENTER_READY') {
            funnel.entryReadyEntries++;
        } else if (t.type === 'PLAN_CREATED') {
            funnel.plansReady++;
        } else if (t.type === 'TRADE_FILLED') {
            funnel.tradeFilled++;
        } else if (t.type === 'SCENARIO_TRANSITION' || t.type === 'GATE_TRANSITION' || t.type === 'AMD_TRANSITION') {
            funnel.evaluations++;
        }
    });
    return funnel;
}

/**
 * 兼容旧口径：按 steps 采样占用计数（诊断用，非主口径）
 */
function computeFunnelBySteps(steps) {
    var funnel = {
        evaluations: steps.length,
        directionalBias: 0,
        watch: 0,
        entryReady: 0,
        plansReady: 0
    };
    steps.forEach(function (s) {
        if (s.biasDirection !== 'NEUTRAL') {
            funnel.directionalBias++;
        }
        if (s.action === 'WATCH') {
            funnel.watch++;
        }
        if (s.gateState === 'ENTRY_READY') {
            funnel.entryReady++;
        }
        if (s.planStatus === 'READY') {
            funnel.plansReady++;
        }
    });
    return funnel;
}

/**
 * 按组合分组的 expectancy
 * @param {Array} trades replay 产生的 trades
 * @param {Array<string>} keys 分组维度（如 ['context.bias'] / ['context.amd'] / ['context.draw']）
 */
function groupExpectancy(trades, keys) {
    var groups = {};
    trades.forEach(function (t) {
        if (t.status !== 'WIN' && t.status !== 'LOSS') {
            return; // AMBIGUOUS / EXPIRED / CANCELLED 不参与 expectancy
        }
        var key = keys.map(function (k) {
            var v = t;
            k.split('.').forEach(function (part) { v = v && v[part]; });
            return String(v === undefined || v === null ? 'NONE' : v);
        }).join('|');
        if (!groups[key]) {
            groups[key] = { wins: 0, losses: 0, totalR: 0, maxConsecLosses: 0, currentConsecLosses: 0 };
        }
        var g = groups[key];
        if (t.status === 'WIN') {
            g.wins++;
            g.totalR += t.realizedR;
            g.currentConsecLosses = 0;
        } else {
            g.losses++;
            g.totalR += t.realizedR;
            g.currentConsecLosses++;
            if (g.currentConsecLosses > g.maxConsecLosses) {
                g.maxConsecLosses = g.currentConsecLosses;
            }
        }
    });
    Object.keys(groups).forEach(function (key) {
        var g = groups[key];
        var total = g.wins + g.losses;
        g.total = total;
        g.winRate = total > 0 ? round4(g.wins / total) : 0;
        g.avgR = total > 0 ? round4(g.totalR / total) : 0;
        g.expectancyR = g.avgR; // avg realized R per trade
    });
    return groups;
}

/**
 * 总体统计
 */
function computeOverall(trades) {
    var wins = 0;
    var losses = 0;
    var ambiguous = 0;
    var expired = 0;
    var cancelled = 0;
    var openEnd = 0;
    var totalR = 0;
    var maxConsecLosses = 0;
    var currentConsecLosses = 0;
    var holdBars = [];
    var mfeRSum = 0;
    var maeRSum = 0;
    var mfeCount = 0;
    var maeCount = 0;
    var rArr = [];
    var grossWinR = 0;
    var grossLossR = 0;

    trades.forEach(function (t) {
        if (t.status === 'WIN') {
            wins++;
            totalR += t.realizedR;
            grossWinR += t.realizedR;
            rArr.push(t.realizedR);
            currentConsecLosses = 0;
            holdBars.push(t.holdBars);
            if (t.mfeR !== undefined) { mfeRSum += t.mfeR; mfeCount++; }
            if (t.maeR !== undefined) { maeRSum += t.maeR; maeCount++; }
        } else if (t.status === 'LOSS') {
            losses++;
            totalR += t.realizedR;
            grossLossR += Math.abs(t.realizedR);
            rArr.push(t.realizedR);
            currentConsecLosses++;
            if (currentConsecLosses > maxConsecLosses) {
                maxConsecLosses = currentConsecLosses;
            }
            holdBars.push(t.holdBars);
            if (t.mfeR !== undefined) { mfeRSum += t.mfeR; mfeCount++; }
            if (t.maeR !== undefined) { maeRSum += t.maeR; maeCount++; }
        } else if (t.status === 'AMBIGUOUS') {
            ambiguous++;
        } else if (t.status === 'EXPIRED') {
            expired++;
        } else if (t.status === 'CANCELLED') {
            cancelled++;
        } else if (t.status === 'OPEN_AT_END') {
            openEnd++;
        }
    });

    var closed = wins + losses;
    var total = trades.length;
    var sortedR = rArr.slice().sort(function (a, b) { return a - b; });
    var medianR = sortedR.length > 0
        ? (sortedR.length % 2 === 1
            ? sortedR[Math.floor(sortedR.length / 2)]
            : (sortedR[sortedR.length / 2 - 1] + sortedR[sortedR.length / 2]) / 2)
        : 0;
    return {
        total: total,
        wins: wins,
        losses: losses,
        ambiguous: ambiguous,
        expired: expired,
        cancelled: cancelled,
        openEnd: openEnd,
        closed: closed,
        winRate: closed > 0 ? round4(wins / closed) : 0,
        avgR: closed > 0 ? round4(totalR / closed) : 0,
        medianR: round4(medianR),
        totalR: round4(totalR),
        profitFactor: grossLossR > 0 ? round4(grossWinR / grossLossR) : (grossWinR > 0 ? Infinity : 0),
        maxConsecLosses: maxConsecLosses,
        avgHoldBars: holdBars.length > 0 ? round2(holdBars.reduce(function (a, b) { return a + b; }, 0) / holdBars.length) : 0,
        avgMfeR: mfeCount > 0 ? round4(mfeRSum / mfeCount) : 0,
        avgMaeR: maeCount > 0 ? round4(maeRSum / maeCount) : 0
    };
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = {
    computeFunnel: computeFunnel,
    computeFunnelBySteps: computeFunnelBySteps,
    groupExpectancy: groupExpectancy,
    computeOverall: computeOverall
};
