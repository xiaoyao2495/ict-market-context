/**
 * Stop Semantics Audit（Phase 11T / 11T.1 — Stop Semantics Audit）
 *
 * 纯诊断，不修改正式 planStop / baseline 行为。
 *
 * 目标：回答"当前 SWING_HIGH/LOW Stop 到底是在保护 Narrative，
 * 还是只是在保护一个太小的 5m micro swing？"
 *
 * 1. STOP_TOO_TIGHT_CANDIDATE 桶：stopDistanceAtr < 0.5 或 rr > 10 的 plan
 *    （标记为候选异常，不拒单——先观察，不因单笔改规则）
 * 2. STOP SURVIVAL CURVE（0.25/0.50/0.75/1.00/1.50/2.00 ATR）：
 *    若风险边界距离 Entry 分别为各 ATR 档，Narrative 活到 Primary Draw 的比例。
 *    Phase 11T.1 增强：二维 —— 按该档 stop 是否【越过 narrative invalidation 边界】
 *    （manipulation extreme / accumulation boundary）分成 Narrative Valid vs Micro Structure Only。
 * 3. REFERENCE SURVIVAL：Manipulation Extreme / Accumulation Boundary / Swing / FVG
 *    四类 reference stop（+baseline）逐 K 模拟，按 source 分组 survival/DrawHit/MAE/MFE/RR。
 *    —— 目标不是找"胜率最高"的 stop，而是找最符合叙事失效语义且没毁掉 RR 的 stop。
 *
 * 原则（冻结）：
 *   Narrative → Invalidation Point → Stop → Risk → Target → RR → RR 不够 NO TRADE
 *   绝不为了 RR 反推 Stop；ATR 只作为诊断 / minimum buffer，不决定 Stop。
 */
var thresholds = require('../config/thresholds');
var stopPlanner = require('../trade/stopPlanner');

var SURVIVAL_TIERS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];

/**
 * 提取 per-entry 诊断所需字段（正式 trades 或 shadow entries）
 * @param {Object} t trade/entry：{ direction, entryPrice, entryAt?, entryIndex?, targetPrice, stopPrice, diagnostics?, amd? }
 * @returns {Object} { direction, entryPrice, targetPrice, stopPrice, atr, entryIndex,
 *   manipExtreme, accBoundary, candidates }
 */
function extractEntry(t) {
    var cands = (t.diagnostics && t.diagnostics.stopCandidates) || t.candidates || null;
    // narrative invalidation 边界：优先顶层字段，否则从 entry.amd 反推
    var manipExtreme = t.manipExtreme !== undefined ? t.manipExtreme : null;
    var accBoundary = t.accBoundary !== undefined ? t.accBoundary : null;
    if (manipExtreme === null && t.amd) {
        if (t.amd.manipulation && t.amd.manipulation.sweepEvent) {
            manipExtreme = t.amd.manipulation.sweepEvent.price;
        }
    }
    if (accBoundary === null && t.amd) {
        if (t.amd.accumulation) {
            accBoundary = t.direction === 'LONG'
                ? t.amd.accumulation.rangeLow : t.amd.accumulation.rangeHigh;
        }
    }
    return {
        direction: t.direction,
        entryPrice: t.entryPrice !== undefined ? t.entryPrice : (t.plan && t.plan.entry ? t.plan.entry.price : null),
        targetPrice: t.targetPrice !== undefined ? t.targetPrice : (t.plan && t.plan.target ? t.plan.target.price : null),
        stopPrice: t.stopPrice !== undefined ? t.stopPrice : (t.plan && t.plan.stop ? t.plan.stop.price : null),
        atr: t.diagnostics && t.diagnostics.atr ? t.diagnostics.atr : t.atr || null,
        entryIndex: t.entryIndex !== undefined ? t.entryIndex : null,
        manipExtreme: manipExtreme,
        accBoundary: accBoundary,
        candidates: cands
    };
}

/**
 * 1. STOP_TOO_TIGHT_CANDIDATE 桶（诊断标记，不拒单）
 */
function flagTooTight(trades) {
    return (trades || []).map(function (t) {
        var distAtr = t.diagnostics && t.diagnostics.stopDistanceAtr !== undefined
            ? t.diagnostics.stopDistanceAtr
            : null;
        var atr = t.diagnostics && t.diagnostics.atr ? t.diagnostics.atr : null;
        var initialRiskAtr = t.diagnostics && t.diagnostics.initialRiskAtr ? t.diagnostics.initialRiskAtr : null;
        var initialRisk = atr && initialRiskAtr ? atr * initialRiskAtr : null;
        var reasons = [];
        if (distAtr !== null && distAtr < 0.5) {
            reasons.push('stopDistanceAtr ' + distAtr.toFixed(2) + ' < 0.5');
        }
        if (t.rr !== null && t.rr !== undefined && t.rr > 10) {
            reasons.push('rr ' + t.rr + ' > 10');
        }
        return {
            tradeId: t.tradeId || t.planId,
            direction: t.direction,
            entryPrice: t.entryPrice,
            stopPrice: t.stopPrice,
            targetPrice: t.targetPrice,
            stopDistanceAtr: distAtr,
            rr: t.rr,
            mfeBeforeStopR: initialRisk && t.mfeBeforeStop !== null && t.mfeBeforeStop !== undefined
                ? Math.round((t.mfeBeforeStop / initialRisk) * 100) / 100 : null,
            maeAtMfePeak: t.maeAtMfePeak,
            flag: reasons.length > 0,
            reasons: reasons
        };
    });
}

/**
 * 单 entry + 单 stop 的逐 K 模拟
 * @returns {Object} { survived, maeAtr, mfeAtr }（survived = target 先于 stop；同根触碰保守不算）
 */
function simulateStop(ex, stopPrice, candles, startIdx) {
    var direction = ex.direction;
    var mfe = 0;
    var mae = 0;
    var survived = false;
    var k;
    for (k = startIdx + 1; k < candles.length; k++) {
        var c = candles[k];
        if (!c || c.closed === false) continue;
        var stopHit;
        var targetHit;
        if (direction === 'LONG') {
            mfe = Math.max(mfe, c.high - ex.entryPrice);
            mae = Math.max(mae, ex.entryPrice - c.low);
            stopHit = c.low <= stopPrice;
            targetHit = c.high >= ex.targetPrice;
        } else {
            mfe = Math.max(mfe, ex.entryPrice - c.low);
            mae = Math.max(mae, c.high - ex.entryPrice);
            stopHit = c.high >= stopPrice;
            targetHit = c.low <= ex.targetPrice;
        }
        if (stopHit && targetHit) break; // AMBIGUOUS：不算 survive
        if (targetHit) { survived = true; break; }
        if (stopHit) break;
    }
    return {
        survived: survived,
        maeAtr: ex.atr > 0 ? mae / ex.atr : 0,
        mfeAtr: ex.atr > 0 ? mfe / ex.atr : 0
    };
}

/**
 * 2. STOP SURVIVAL CURVE（Phase 11T.1：二维 — ATR 档 × Narrative Validity）
 * @param {Array} entries 含 direction/entryPrice/targetPrice/atr/entryIndex（可选 manipExtreme/accBoundary）
 * @returns {Object} {
 *   tiers: { mult: { total, survived, rate, validTotal, validSurvived, validRate,
 *                     microTotal, microSurvived, microRate, avgMfeR, avgMaeR } },
 *   entries
 * }
 */
function survivalCurve(entries, candles, opts) {
    var o = opts || {};
    var tiers = o.tiers || SURVIVAL_TIERS;
    var byClose = {};
    (candles || []).forEach(function (c, i) { byClose[c.closeTime] = i; });

    var result = { tiers: {}, entries: 0, skipped: 0 };
    tiers.forEach(function (t) {
        result.tiers[t] = {
            total: 0, survived: 0, rate: 0,
            validTotal: 0, validSurvived: 0, validRate: 0,
            microTotal: 0, microSurvived: 0, microRate: 0,
            mfeSum: 0, maeSum: 0, avgMfeR: 0, avgMaeR: 0
        };
    });

    (entries || []).forEach(function (e) {
        var ex = extractEntry(e);
        if (!ex.entryPrice || !ex.targetPrice || !ex.atr || ex.atr <= 0) {
            result.skipped++;
            return;
        }
        var startIdx = ex.entryIndex !== null && ex.entryIndex !== undefined
            ? ex.entryIndex
            : (e.entryAt !== undefined && byClose[e.entryAt] !== undefined ? byClose[e.entryAt] : null);
        if (startIdx === null) {
            result.skipped++;
            return;
        }
        var direction = ex.direction;
        result.entries++;

        tiers.forEach(function (mult) {
            var row = result.tiers[mult];
            row.total++;
            var stop = direction === 'LONG'
                ? ex.entryPrice - ex.atr * mult
                : ex.entryPrice + ex.atr * mult;
            // Narrative Validity：stop 是否越过 manipulation extreme / accumulation boundary
            var beyondManip = ex.manipExtreme !== null
                ? (direction === 'LONG' ? stop < ex.manipExtreme : stop > ex.manipExtreme) : false;
            var beyondAcc = ex.accBoundary !== null
                ? (direction === 'LONG' ? stop < ex.accBoundary : stop > ex.accBoundary) : false;
            var narrativeValid = beyondManip || beyondAcc;

            var sim = simulateStop(ex, stop, candles, startIdx);
            row.mfeSum += sim.mfeAtr;
            row.maeSum += sim.maeAtr;
            if (sim.survived) row.survived++;
            if (narrativeValid) {
                row.validTotal++;
                if (sim.survived) row.validSurvived++;
            } else {
                row.microTotal++;
                if (sim.survived) row.microSurvived++;
            }
        });
    });

    tiers.forEach(function (t) {
        var row = result.tiers[t];
        row.rate = row.total > 0 ? row.survived / row.total : 0;
        row.validRate = row.validTotal > 0 ? row.validSurvived / row.validTotal : 0;
        row.microRate = row.microTotal > 0 ? row.microSurvived / row.microTotal : 0;
        row.avgMfeR = row.total > 0 ? row.mfeSum / row.total : 0;
        row.avgMaeR = row.total > 0 ? row.maeSum / row.total : 0;
    });
    return result;
}

/**
 * 3. REFERENCE SURVIVAL：四类 reference（+baseline/ATR 档）逐 K 模拟，按 source 分组
 * @param {Array} entries 含 candidates（[{source, price, distanceAtr, rr, isBaseline}]）或可由 amd/swings/fvg 重建
 * @returns {Object} { bySource: { source: {n, survived, rate, drawHit, avgMaeR, avgMfeR, avgRr} }, entries }
 */
function referenceSurvival(entries, candles) {
    var byClose = {};
    (candles || []).forEach(function (c, i) { byClose[c.closeTime] = i; });
    var bySource = {};
    var entryCount = 0;

    (entries || []).forEach(function (e) {
        var ex = extractEntry(e);
        if (!ex.entryPrice || !ex.targetPrice || !ex.atr || ex.atr <= 0) {
            return;
        }
        var startIdx = ex.entryIndex !== null && ex.entryIndex !== undefined
            ? ex.entryIndex
            : (e.entryAt !== undefined && byClose[e.entryAt] !== undefined ? byClose[e.entryAt] : null);
        if (startIdx === null) {
            return;
        }
        // candidates：优先用 entry 自带，否则用 amd/swings/fvg 重建（shadow entries）
        var cands = ex.candidates;
        if (!cands && e.amd) {
            try {
                cands = stopPlanner.buildStopCandidates({
                    direction: e.direction === 'LONG' ? 'LONG' : 'SHORT',
                    entryPrice: ex.entryPrice,
                    targetPrice: ex.targetPrice,
                    amd: e.amd,
                    swings: e.swings || [],
                    fvg: e.fvg || {},
                    evaluationTime: e.watchAt || ex.entryIndex,
                    tickSize: e.tickSize || 0,
                    atr: ex.atr
                }, {});
            } catch (err) {
                cands = null;
            }
        }
        if (!cands || cands.length === 0) {
            return;
        }
        entryCount++;

        cands.forEach(function (c) {
            if (!c.valid || c.price === null) return;
            var key = c.source;
            if (!bySource[key]) {
                bySource[key] = { n: 0, survived: 0, rate: 0, drawHit: 0, maeSum: 0, mfeSum: 0, rrSum: 0, rrN: 0, avgMaeR: 0, avgMfeR: 0, avgRr: 0, baseline: 0 };
            }
            var row = bySource[key];
            row.n++;
            if (c.isBaseline) row.baseline++;
            var sim = simulateStop(ex, c.price, candles, startIdx);
            if (sim.survived) row.survived++;
            row.maeSum += sim.maeAtr;
            row.mfeSum += sim.mfeAtr;
            if (c.rr !== null && c.rr !== undefined) {
                row.rrSum += c.rr;
                row.rrN++;
            }
        });
    });

    Object.keys(bySource).forEach(function (k) {
        var row = bySource[k];
        row.rate = row.n > 0 ? row.survived / row.n : 0;
        row.drawHit = row.rate;
        row.avgMaeR = row.n > 0 ? row.maeSum / row.n : 0;
        row.avgMfeR = row.n > 0 ? row.mfeSum / row.n : 0;
        row.avgRr = row.rrN > 0 ? row.rrSum / row.rrN : 0;
    });

    return { bySource: bySource, entries: entryCount };
}

/**
 * per-entry 候选诊断汇总（正式 trades 的 stopCandidates）
 */
function candidateRows(trades) {
    var rows = [];
    (trades || []).forEach(function (t) {
        var cands = t.diagnostics && t.diagnostics.stopCandidates;
        if (!cands) return;
        cands.forEach(function (c) {
            rows.push({
                tradeId: t.tradeId || t.planId,
                status: t.status,
                source: c.source,
                structureRole: c.structureRole,
                distanceAtr: c.distanceAtr,
                rr: c.rr,
                isBaseline: c.isBaseline,
                narrativeInvalidation: c.narrativeInvalidation,
                beyondManip: c.isBeyondManipulationExtreme,
                beyondAcc: c.isBeyondAccumulationRange
            });
        });
    });
    return rows;
}

module.exports = {
    SURVIVAL_TIERS: SURVIVAL_TIERS,
    extractEntry: extractEntry,
    flagTooTight: flagTooTight,
    simulateStop: simulateStop,
    survivalCurve: survivalCurve,
    referenceSurvival: referenceSurvival,
    candidateRows: candidateRows
};
