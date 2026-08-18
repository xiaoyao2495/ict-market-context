/**
 * Shadow Entry（Phase 11S.1 — DIAGNOSTIC_SHADOW_ENTRY）
 *
 * 旁路诊断：假设 WATCH 期间价格接近/进入 FVG zone 即成交，
 * 用【当前冻结的】Stop/Target 逻辑逐 K 模拟，回答：
 *   "如果允许极小 ATR tolerance，能否产生有意义的样本与 expectancy？"
 *
 * 关键约束：
 * - 不产生正式 plan；正式 ENTRY_READY 判定冻结不变
 * - 准入距离是诊断参数：[0（真实 zone touch）, 0.05, 0.10, 0.25] ATR
 * - Shadow 成交价 = 触发那根 K 的 close（诊断约定，非挂单模拟）
 * - Stop/Target 复用冻结规则：stopPlanner.planStop + Draw primary/secondary
 * - 只做诊断统计，不得据此调整正式规则
 */
var stopPlanner = require('../trade/stopPlanner');
var tradeSimulator = require('../trade/tradeSimulator');
var retraceTracker = require('../replay/retraceTracker');
var narrativeBoundary = require('./narrativeBoundary');

var TOLERANCES = [0, 0.05, 0.10, 0.25]; // 单位：ATR

/**
 * @param {Object} retrace 已关闭（或进行中）的 retrace 记录（含 zone/direction/draw/amd/swings/tickSize）
 * @param {Object} ctx {
 *   candles,      完整 5m 数组（时间升序）
 *   atrSeries,    增量 ATR 序列（index → atr）或 null（回退 retrace.atrAtWatch）
 *   amdTrace,     逐根 AMD boundary trace（index → boundary snapshot，Phase 11T.3）
 *   thresholds,   完整配置（可选，默认 require）
 * }
 * @returns {Array} 每个准入一个结果：
 *   {
 *     tolerance,            ATR 准入（0 = 真实 zone touch）
 *     toleranceLabel,       'zone_touch' | '0.05_atr' | ...
 *     triggered,            bool
 *     triggerIndex, triggerAt, triggerPrice,
 *     distanceAtTrigger,    distanceToZone（触发那根）
 *     stop: {status, price, source, referencePrice, buffer},
 *     target: {price, source, candidateId} | null,
 *     risk, reward, rr,
 *     sim: tradeSimulator 输出 | null
 *     boundaryAtWatch,      WATCH 建立时冻结的 boundary snapshot（Phase 11T.3）
 *     amdAtTrigger,         trigger 那根收盘后的实时 boundary snapshot（Phase 11T.3）
 *     alignmentAtWatch, biasAtWatch, fvgScoreAtWatch
 *   }
 */
function runShadowEntries(retrace, ctx) {
    var o = ctx || {};
    var candles = o.candles || [];
    var atrSeries = o.atrSeries || {};
    var amdTrace = o.amdTrace || [];
    var cfg = o.thresholds || require('../config/thresholds');
    var direction = retrace.direction;
    var zoneLow = retrace.zoneLow;
    var zoneHigh = retrace.zoneHigh;
    var startIdx = retrace.watchIndex + 1; // formation 之后
    var endIdx = retrace.closeIndex !== null && retrace.closeIndex !== undefined
        ? retrace.closeIndex
        : candles.length - 1;

    var out = [];
    TOLERANCES.forEach(function (tol) {
        var res = {
            tolerance: tol,
            toleranceLabel: tol === 0 ? 'zone_touch'
                : tol === 0.05 ? '0.05_atr' : tol === 0.10 ? '0.10_atr' : '0.25_atr',
            triggered: false,
            triggerIndex: null,
            triggerAt: null,
            triggerPrice: null,
            distanceAtTrigger: null,
            stop: null,
            target: null,
            risk: null,
            reward: null,
            rr: null,
            sim: null
        };

        // 1. 找第一根满足距离 <= tol * ATR 的 K
        var i;
        var triggerIdx = null;
        for (i = startIdx; i <= endIdx && i < candles.length; i++) {
            var c = candles[i];
            if (!c || c.closed === false) {
                continue;
            }
            var d = retraceTracker.distanceToZone(direction, c, zoneLow, zoneHigh);
            var atr = (atrSeries[i] !== undefined && atrSeries[i] > 0) ? atrSeries[i] : (retrace.atrAtWatch || 0);
            var threshold = atr > 0 ? tol * atr : (tol === 0 ? 0 : Infinity);
            if (d <= threshold + 1e-12) {
                triggerIdx = i;
                res.distanceAtTrigger = Math.round(d * 100) / 100;
                break;
            }
        }
        if (triggerIdx === null) {
            out.push(res);
            return;
        }

        var triggerCandle = candles[triggerIdx];
        res.triggered = true;
        res.triggerIndex = triggerIdx;
        res.triggerAt = triggerCandle.closeTime;
        res.triggerPrice = triggerCandle.close;

        // ---- Phase 11T.3/11T.4：boundary 快照（WATCH 冻结 vs trigger 实时 + lastNarrative） ----
        res.boundaryAtWatch = retrace.boundaryAtWatch || null;
        var tr = (amdTrace && amdTrace[triggerIdx]) || null;
        // 兼容两种 amdTrace 格式：{boundary, lastNarrative}（11T.4）或 boundary 对象（11T.3）
        res.amdAtTrigger = tr ? (tr.boundary || tr) : null;
        res.lastNarrativeAtTrigger = tr ? (tr.lastNarrative || null) : null;
        res.alignmentAtWatch = retrace.alignmentAtWatch || null;
        res.biasAtWatch = retrace.biasAtWatch || null;
        res.fvgScoreAtWatch = retrace.fvgScoreAtWatch || null;

        var dir = direction === 'BULLISH' ? 'LONG' : 'SHORT';

        // 2. Stop（冻结规则）
        var stop = stopPlanner.planStop({
            direction: dir,
            entryPrice: res.triggerPrice,
            amd: retrace.amd || {},
            swings: retrace.swings || [],
            fvg: { zoneLow: zoneLow, zoneHigh: zoneHigh },
            evaluationTime: retrace.watchAt,
            tickSize: retrace.tickSize || 0,
            atr: retrace.atrAtWatch || 0
        }, { thresholds: cfg });
        res.stop = stop;

        // ---- Phase 11T.4：shadow stop reference reconstruction（只统计，不替换正式 stop） ----
        // stopLive    = trigger 实时 AMD（模拟正式 TradePlan 在 trigger 时的行为）
        // stopRetain  = 实时 AMD 优先 + lastNarrative 补边界（Snapshot Retention Shadow）
        var stopLive = stopPlanner.planStop({
            direction: dir,
            entryPrice: res.triggerPrice,
            amd: narrativeBoundary.amdFromBoundary(res.amdAtTrigger),
            swings: retrace.swings || [],
            fvg: { zoneLow: zoneLow, zoneHigh: zoneHigh },
            evaluationTime: retrace.watchAt,
            tickSize: retrace.tickSize || 0,
            atr: retrace.atrAtWatch || 0
        }, { thresholds: cfg });
        res.stopLive = stopLive;
        var stopRetain = stopPlanner.planStop({
            direction: dir,
            entryPrice: res.triggerPrice,
            amd: narrativeBoundary.synthAmdForStop(res.amdAtTrigger, res.lastNarrativeAtTrigger),
            swings: retrace.swings || [],
            fvg: { zoneLow: zoneLow, zoneHigh: zoneHigh },
            evaluationTime: retrace.watchAt,
            tickSize: retrace.tickSize || 0,
            atr: retrace.atrAtWatch || 0
        }, { thresholds: cfg });
        res.stopRetain = stopRetain;

        if (stop.status !== 'READY') {
            out.push(res);
            return;
        }

        // 3. Target（Draw primary → secondary → 最近 candidate）
        var target = pickTarget(retrace.draw, dir, res.triggerPrice);
        res.target = target;
        if (!target) {
            out.push(res);
            return;
        }

        // 4. RR（方向用 LONG/SHORT 的 dir）
        var risk = dir === 'LONG' ? res.triggerPrice - stop.price : stop.price - res.triggerPrice;
        var reward = dir === 'LONG' ? target.price - res.triggerPrice : res.triggerPrice - target.price;
        if (risk <= 0 || reward <= 0) {
            out.push(res);
            return;
        }
        res.risk = Math.round(risk * 100) / 100;
        res.reward = Math.round(reward * 100) / 100;
        res.rr = Math.round((reward / risk) * 100) / 100;

        // 5. 逐 K 模拟（触发 K 之后）
        var after = candles.slice(triggerIdx + 1);
        var plan = {
            id: 'SHADOW:' + retrace.watchId + ':' + res.toleranceLabel,
            direction: dir,
            entry: { price: res.triggerPrice },
            stop: { price: stop.price },
            target: { price: target.price },
            rr: res.rr
        };
        res.sim = tradeSimulator.simulateTrade(plan, after, {
            tradeId: plan.id,
            thresholds: cfg
        });

        out.push(res);
    });

    return out;
}

/**
 * 从 draw 快照选 target：primary → secondary → 价格上最近的有效 candidate
 */
function pickTarget(draw, direction, entryPrice) {
    if (!draw) {
        return null;
    }
    var side = direction === 'LONG' ? 'bsl' : 'ssl';
    var section = draw[side];
    if (!section) {
        return null;
    }
    if (section.primary && section.primary.targetPrice !== undefined) {
        var p = section.primary;
        if ((direction === 'LONG' && p.targetPrice > entryPrice) ||
            (direction === 'SHORT' && p.targetPrice < entryPrice)) {
            return {
                price: p.targetPrice,
                source: 'PRIMARY_DRAW',
                candidateId: p.id || null,
                drawScore: p.drawScore !== undefined ? p.drawScore : null
            };
        }
    }
    if (section.secondary && section.secondary.targetPrice !== undefined) {
        var s = section.secondary;
        if ((direction === 'LONG' && s.targetPrice > entryPrice) ||
            (direction === 'SHORT' && s.targetPrice < entryPrice)) {
            return {
                price: s.targetPrice,
                source: 'SECONDARY_DRAW',
                candidateId: s.id || null,
                drawScore: s.drawScore !== undefined ? s.drawScore : null
            };
        }
    }
    // 最近有效 candidate（不满足盈利方向的排除）
    var best = null;
    (section.candidates || []).forEach(function (c) {
        if (c.targetPrice === undefined) {
            return;
        }
        if (direction === 'LONG' && c.targetPrice <= entryPrice) {
            return;
        }
        if (direction === 'SHORT' && c.targetPrice >= entryPrice) {
            return;
        }
        var d = Math.abs(c.targetPrice - entryPrice);
        if (!best || d < best.dist) {
            best = { cand: c, dist: d };
        }
    });
    if (best) {
        return {
            price: best.cand.targetPrice,
            source: 'NEAREST_CANDIDATE',
            candidateId: best.cand.id || null,
            drawScore: best.cand.drawScore !== undefined ? best.cand.drawScore : null
        };
    }
    return null;
}

/**
 * 汇总 shadow 对比表（report 用）
 * @param {Array} retraces 全部关闭的 retrace 记录
 * @returns {Array} 每个 tolerance 一行：
 *   { tolerance, toleranceLabel, entries, filled, wins, losses, ambiguous,
 *     expired, cancelled, avgR, totalR, avgStopDistanceAtr, stopOutThenTarget }
 */
function summarizeShadows(retraces) {
    var rows = TOLERANCES.map(function (tol) {
        return {
            tolerance: tol,
            toleranceLabel: tol === 0 ? 'zone_touch' : tol + '_atr',
            entries: 0,
            filled: 0,
            wins: 0,
            losses: 0,
            ambiguous: 0,
            expired: 0,
            cancelled: 0,
            avgR: 0,
            totalR: 0,
            rSum: 0,
            stopDistanceAtrSum: 0,
            stopDistanceAtrN: 0,
            stopOutThenTarget: 0
        };
    });
    var idx = {};
    TOLERANCES.forEach(function (tol, i) { idx[tol] = i; });

    retraces.forEach(function (r) {
        (r.shadowResults || []).forEach(function (sr) {
            var row = idx[sr.tolerance] !== undefined ? rows[idx[sr.tolerance]] : null;
            if (!row) {
                return;
            }
            if (!sr.triggered) {
                return;
            }
            row.entries++;
            if (!sr.sim) {
                return;
            }
            row.filled++;
            var st = sr.sim.status;
            if (st === 'WIN') row.wins++;
            else if (st === 'LOSS') row.losses++;
            else if (st === 'AMBIGUOUS') row.ambiguous++;
            else if (st === 'EXPIRED') row.expired++;
            else if (st === 'CANCELLED') row.cancelled++;
            row.rSum += (sr.sim.realizedR || 0);
            if (sr.sim.maeR !== undefined && sr.sim.maeR !== null && sr.sim.maeR !== 0) {
                // 仅 closed（WIN/LOSS）计 stopOutThenTarget
            }
            if (sr.stop && sr.stop.status === 'READY' && sr.risk) {
                var atr = r.atrAtWatch || 0;
                if (atr > 0) {
                    row.stopDistanceAtrSum += sr.risk / atr;
                    row.stopDistanceAtrN++;
                }
            }
        });
    });

    rows.forEach(function (row) {
        row.avgR = row.filled > 0 ? Math.round((row.rSum / row.filled) * 1000) / 1000 : 0;
        row.totalR = Math.round(row.rSum * 1000) / 1000;
        row.avgStopDistanceAtr = row.stopDistanceAtrN > 0
            ? Math.round((row.stopDistanceAtrSum / row.stopDistanceAtrN) * 1000) / 1000
            : null;
    });
    return rows;
}

/**
 * Phase 11E.3 — Entry Confirmation Counterfactual（只诊断，不落正式）
 *
 * 对每个 WATCH+FVG 的 retrace，比较 4 种 entry 确认变体：
 *   ENTRY_NOW              trigger（价格 touch zone）即 entry —— 当前正式语义
 *   AFTER_1_BAR_CONFIRM    trigger 后一根方向性确认 K（bullish: close > open 且 close > trigger close）
 *   AFTER_RECLAIM          trigger 后 close 重新站回 zone 上沿（bullish: close > zoneHigh）
 *   AFTER_MIDPOINT_RECLAIM trigger 后 close 重新站回 midpoint 之上
 *
 * 每个变体：entry = 确认 K 的 close；stop/target 复用冻结规则（WATCH 快照 amd）；
 * 逐 K 模拟（确认 K 之后）。回答：正式 ENTRY NOW 是否系统性领先于重新定价确认。
 *
 * @returns {Array} [{ variant, triggered, entryIndex, entryPrice, stop, target, sim }]
 */
function runEntryConfirmation(retrace, ctx) {
    var o = ctx || {};
    var candles = o.candles || [];
    var cfg = o.thresholds || require('../config/thresholds');
    var direction = retrace.direction;
    var zoneLow = retrace.zoneLow;
    var zoneHigh = retrace.zoneHigh;
    var midpoint = retrace.midpoint;
    var startIdx = retrace.watchIndex + 1;
    var endIdx = retrace.closeIndex !== null && retrace.closeIndex !== undefined
        ? retrace.closeIndex : candles.length - 1;

    // 1. 找 ENTRY_NOW trigger（真实 zone touch，tol=0）
    var triggerIdx = null;
    var i;
    for (i = startIdx; i <= endIdx && i < candles.length; i++) {
        var c = candles[i];
        if (!c || c.closed === false) continue;
        var d = retraceTracker.distanceToZone(direction, c, zoneLow, zoneHigh);
        if (d <= 1e-12) { triggerIdx = i; break; }
    }
    if (triggerIdx === null) {
        return [];
    }
    var triggerPrice = candles[triggerIdx].close;
    var dir = direction === 'BULLISH' ? 'LONG' : 'SHORT';

    var variants = [
        { key: 'ENTRY_NOW', entryIndex: triggerIdx, entryPrice: triggerPrice, source: 'trigger' }
    ];

    // 2. 扫描后续确认 K
    for (i = triggerIdx + 1; i <= endIdx && i < candles.length; i++) {
        var ci = candles[i];
        if (!ci || ci.closed === false) continue;
        var bullish = direction === 'BULLISH';
        // AFTER_1_BAR_CONFIRM：方向性确认 K（第一根满足即用）
        if (bullish ? (ci.close > ci.open && ci.close > triggerPrice) : (ci.close < ci.open && ci.close < triggerPrice)) {
            if (!variants.some(function (v) { return v.key === 'AFTER_1_BAR_CONFIRM'; })) {
                variants.push({ key: 'AFTER_1_BAR_CONFIRM', entryIndex: i, entryPrice: ci.close, source: 'confirm1' });
            }
        }
        // AFTER_RECLAIM：close 站回 zone 上沿（bullish: close > zoneHigh；bearish: close < zoneLow）
        if (bullish ? ci.close > zoneHigh : ci.close < zoneLow) {
            if (!variants.some(function (v) { return v.key === 'AFTER_RECLAIM'; })) {
                variants.push({ key: 'AFTER_RECLAIM', entryIndex: i, entryPrice: ci.close, source: 'reclaim' });
            }
        }
        // AFTER_MIDPOINT_RECLAIM：close 站回 midpoint
        if (bullish ? ci.close > midpoint : ci.close < midpoint) {
            if (!variants.some(function (v) { return v.key === 'AFTER_MIDPOINT_RECLAIM'; })) {
                variants.push({ key: 'AFTER_MIDPOINT_RECLAIM', entryIndex: i, entryPrice: ci.close, source: 'midpoint' });
            }
        }
    }

    // 3. 每个变体：stop/target + 模拟
    var out = [];
    variants.forEach(function (v) {
        var stop = stopPlanner.planStop({
            direction: dir,
            entryPrice: v.entryPrice,
            amd: retrace.amd || {},
            swings: retrace.swings || [],
            fvg: { zoneLow: zoneLow, zoneHigh: zoneHigh },
            evaluationTime: retrace.watchAt,
            tickSize: retrace.tickSize || 0,
            atr: retrace.atrAtWatch || 0
        }, { thresholds: cfg });
        if (stop.status !== 'READY') {
            out.push({ variant: v.key, triggered: false, reason: 'stop not ready' });
            return;
        }
        var target = pickTarget(retrace.draw, dir, v.entryPrice);
        if (!target) {
            out.push({ variant: v.key, triggered: false, reason: 'no target' });
            return;
        }
        var risk = dir === 'LONG' ? v.entryPrice - stop.price : stop.price - v.entryPrice;
        var reward = dir === 'LONG' ? target.price - v.entryPrice : v.entryPrice - target.price;
        if (risk <= 0 || reward <= 0) {
            out.push({ variant: v.key, triggered: false, reason: 'rr invalid' });
            return;
        }
        var after = candles.slice(v.entryIndex + 1);
        var plan = {
            id: 'CONFIRM:' + retrace.watchId + ':' + v.key,
            direction: dir,
            entry: { price: v.entryPrice },
            stop: { price: stop.price },
            target: { price: target.price },
            rr: Math.round((reward / risk) * 100) / 100
        };
        out.push({
            variant: v.key,
            triggered: true,
            entryIndex: v.entryIndex,
            entryPrice: v.entryPrice,
            stop: stop,
            target: target,
            rr: plan.rr,
            sim: tradeSimulator.simulateTrade(plan, after, { tradeId: plan.id, thresholds: cfg })
        });
    });
    return out;
}

/**
 * Phase 11E.5：汇总确认变体对比（report 用）
 * 3 个确认模型 + ENTRY_NOW：
 *   ENTRY_NOW               当前正式语义（touch 即 entry）
 *   AFTER_1_DIRECTIONAL_BAR 下一根同方向 close（= AFTER_1_BAR_CONFIRM）
 *   MIDPOINT_RECLAIM        close 重新站回 midpoint 另一侧
 *   FVG_RECLAIM             close 重新出 zone 朝 narrative 方向（= AFTER_RECLAIM）
 * @param {Array} retraces
 * @returns {Array} [{ variant, entries, avgMaeR, avgMfeR, targetHit, stopOut, avgRr }]
 */
function summarizeConfirmations(retraces) {
    var rows = {};
    retraces.forEach(function (r) {
        (r.confirmationResults || []).forEach(function (v) {
            if (!v.triggered || !v.sim) return;
            var row = rows[v.variant] || (rows[v.variant] = {
                variant: v.variant, entries: 0, maeRSum: 0, mfeRSum: 0, rrSum: 0, targetHit: 0, stopOut: 0
            });
            row.entries++;
            var st = v.sim.status;
            if (st === 'WIN') row.targetHit++;
            if (st === 'LOSS' || st === 'AMBIGUOUS') row.stopOut++;
            if (v.sim.maeR !== undefined) row.maeRSum += v.sim.maeR;
            if (v.sim.mfeR !== undefined) row.mfeRSum += v.sim.mfeR;
            if (v.rr !== undefined && v.rr !== null && v.rr > 0) row.rrSum += v.rr;
        });
    });
    Object.keys(rows).forEach(function (k) {
        var row = rows[k];
        row.avgRr = row.entries > 0 ? row.rrSum / row.entries : null;
    });
    return Object.keys(rows).map(function (k) { return rows[k]; });
}

module.exports = {
    runShadowEntries: runShadowEntries,
    summarizeShadows: summarizeShadows,
    runEntryConfirmation: runEntryConfirmation,
    summarizeConfirmations: summarizeConfirmations,
    TOLERANCES: TOLERANCES
};
