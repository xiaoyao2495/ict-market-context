/**
 * Stop Placement Diagnostics（Phase 11S）
 *
 * 只诊断，不调参。回答 5 个问题：
 *   1. Stop 到底来自哪里（source 分布）
 *   2. stopDistanceAtr 分桶（绝对价格无意义，必须 ATR 标准化）
 *   3. reference 是否真的代表 narrative invalidation（候选对比）
 *   4. Stop Candidates 模型（旁路，不自动选择）
 *   5. minRR 不参与 Stop 选择（锁定：RR 不足 → REJECT，绝不收紧 stop）
 *
 * 指标：
 *   - stopSource 分布
 *   - stopDistanceAtr 分桶：<0.10 / 0.10-0.25 / 0.25-0.50 / 0.50-1.00 / >1.00
 *   - per-trade 候选对比（risk / rr / isBaseline）
 *   - Winner / Loss MAE-MFE 分布（median / p90）
 *   - STOP_OUT_THEN_TARGET：LOSS 后 12/24 bars 内到达原 Target 的占比
 *   - Stop Efficiency：initialRiskAtr / MAE_R / MFE_R
 */
function analyzeStopSources(trades) {
    var sources = {};
    trades.forEach(function (t) {
        var src = (t.diagnostics && t.diagnostics.stopSource) || 'UNKNOWN';
        if (!sources[src]) {
            sources[src] = { count: 0, wins: 0, losses: 0 };
        }
        sources[src].count++;
        if (t.status === 'WIN') sources[src].wins++;
        if (t.status === 'LOSS') sources[src].losses++;
    });
    return sources;
}

var BUCKETS = [
    { label: '< 0.10 ATR', max: 0.10 },
    { label: '0.10-0.25 ATR', max: 0.25 },
    { label: '0.25-0.50 ATR', max: 0.50 },
    { label: '0.50-1.00 ATR', max: 1.00 },
    { label: '> 1.00 ATR', max: Infinity }
];

function bucketOf(distanceAtr) {
    if (distanceAtr === null || distanceAtr === undefined) {
        return 'N/A';
    }
    for (var i = 0; i < BUCKETS.length; i++) {
        if (distanceAtr < BUCKETS[i].max) {
            return BUCKETS[i].label;
        }
    }
    return BUCKETS[BUCKETS.length - 1].label;
}

function analyzeStopDistance(trades) {
    var buckets = {};
    trades.forEach(function (t) {
        var da = t.diagnostics ? t.diagnostics.stopDistanceAtr : null;
        var b = bucketOf(da);
        if (!buckets[b]) {
            buckets[b] = { count: 0, wins: 0, losses: 0 };
        }
        buckets[b].count++;
        if (t.status === 'WIN') buckets[b].wins++;
        if (t.status === 'LOSS') buckets[b].losses++;
    });
    return buckets;
}

/**
 * per-trade 候选对比：baseline 选择 vs 其他候选的 risk/rr
 */
function analyzeCandidates(trades) {
    var rows = [];
    trades.forEach(function (t) {
        var diag = t.diagnostics;
        if (!diag || !diag.stopCandidates) {
            return;
        }
        diag.stopCandidates.forEach(function (c) {
            if (!c.valid) {
                return;
            }
            rows.push({
                tradeId: t.planId,
                status: t.status,
                source: c.source,
                isBaseline: c.isBaseline,
                distanceAtr: c.distanceAtr,
                risk: c.risk,
                rr: c.rr
            });
        });
    });
    return rows;
}

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return null;
    }
    var idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
}

function summarize(values) {
    if (values.length === 0) {
        return { count: 0, median: null, p90: null, min: null, max: null };
    }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return {
        count: sorted.length,
        median: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        min: sorted[0],
        max: sorted[sorted.length - 1]
    };
}

/**
 * WIN / LOSS 的 MAE_R / MFE_R 分布
 */
function analyzeMaeMfe(trades) {
    var out = { win: {}, loss: {} };
    var wins = trades.filter(function (t) { return t.status === 'WIN'; });
    var losses = trades.filter(function (t) { return t.status === 'LOSS'; });
    out.win.maeR = summarize(wins.map(function (t) { return t.maeR; }));
    out.win.mfeR = summarize(wins.map(function (t) { return t.mfeR; }));
    out.loss.maeR = summarize(losses.map(function (t) { return t.maeR; }));
    out.loss.mfeR = summarize(losses.map(function (t) { return t.mfeR; }));
    return out;
}

/**
 * STOP_OUT_THEN_TARGET：LOSS 结算后，未来 lookahead bars 内到达原 Target 的占比
 * @param {Array} trades replay trades（含 exitIndex / direction / targetPrice）
 * @param {Array} candles 完整 5m candles
 * @param {Array<number>} lookaheads 默认 [12, 24]
 */
function analyzeStopOutThenTarget(trades, candles, lookaheads) {
    var lookaheadList = lookaheads || [12, 24];
    var out = {};
    lookaheadList.forEach(function (lb) {
        out['lookahead_' + lb] = { losses: 0, hitTarget: 0, trades: [] };
    });

    trades.forEach(function (t) {
        if (t.status !== 'LOSS' || t.exitIndex === null || t.exitIndex === undefined) {
            return;
        }
        var start = t.exitIndex + 1;
        lookaheadList.forEach(function (lb) {
            var o = out['lookahead_' + lb];
            o.losses++;
            var end = Math.min(start + lb, candles.length);
            var hit = false;
            for (var i = start; i < end; i++) {
                var c = candles[i];
                if (t.direction === 'LONG' && c.high >= t.targetPrice) {
                    hit = true;
                    break;
                }
                if (t.direction === 'SHORT' && c.low <= t.targetPrice) {
                    hit = true;
                    break;
                }
            }
            if (hit) {
                o.hitTarget++;
                o.trades.push({
                    tradeId: t.planId,
                    hitBars: i - start
                });
            }
        });
    });

    lookaheadList.forEach(function (lb) {
        var o = out['lookahead_' + lb];
        o.rate = o.losses > 0 ? Math.round(o.hitTarget / o.losses * 10000) / 100 : null;
    });
    return out;
}

/**
 * Stop Efficiency：initialRiskAtr / MAE_R / MFE_R 逐笔
 */
function stopEfficiencyRows(trades) {
    return trades.filter(function (t) {
        return t.status === 'WIN' || t.status === 'LOSS';
    }).map(function (t) {
        var d = t.diagnostics || {};
        return {
            tradeId: t.planId,
            status: t.status,
            direction: t.direction,
            initialRiskAtr: d.initialRiskAtr !== undefined ? d.initialRiskAtr : null,
            stopDistanceAtr: d.stopDistanceAtr !== undefined ? d.stopDistanceAtr : null,
            stopSource: d.stopSource || null,
            maeR: t.maeR,
            mfeR: t.mfeR,
            rr: t.rr
        };
    });
}

module.exports = {
    analyzeStopSources: analyzeStopSources,
    analyzeStopDistance: analyzeStopDistance,
    analyzeCandidates: analyzeCandidates,
    analyzeMaeMfe: analyzeMaeMfe,
    analyzeStopOutThenTarget: analyzeStopOutThenTarget,
    stopEfficiencyRows: stopEfficiencyRows
};
