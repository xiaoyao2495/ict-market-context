/**
 * Stop Candidate V2 Counterfactual（Phase 11T.2）
 *
 * 纯诊断 / shadow 对照：正式 stopPlanner（baseline）零改动。
 *
 * 核心假设（Phase 11T.1 结论落地）：
 *   Stop 的问题不是"缺 0.75 ATR"，而是 baseline 常停在 micro structure 内，
 *   没有站到 Narrative Invalidation 之外。Stop 放置优先级：
 *     Narrative invalidation → Manipulation extreme / Accumulation boundary
 *     → Structural reference → ATR noise check → 真实 Liquidity Draw target → Natural RR
 *
 * V2 规则：
 *   LONG: stop 必须低于 manipulation extreme 或 accumulation rangeLow（SHORT 对称）
 *   两者都存在 → 不选最近，生成两套：MANIPULATION_INVALIDATION / ACCUMULATION_INVALIDATION
 *   buffer 与正式规则一致（max(tickSize*mult, ATR*mult)），不额外收紧
 *   ATR 只做诊断：TOO_CLOSE_TO_NOISE（distanceATR < 0.5/0.75/1.0），不拒单
 *   noise buffer 变体（*_NBUF）：在 V2 基础上保底 distanceATR >= noiseMult（默认 1.0 ATR），
 *     观察"加 ATR 最低 buffer"对 survival / RR 的增量代价
 *
 * 统计口径（Same Target：V2 与 baseline 共用同一 plan target）：
 *   horizon 内（默认 288 根 = 24h 5m）四态模拟：
 *     first === 'TARGET'          → survival（target 先到）
 *     first === 'STOP'            → stop-out，之后 horizon 内 target 到达 → stopOutThenTarget
 *     first === 'AMBIGUOUS'       → 同根同触，保守按 STOP 处理（不算 target first）
 *     first === 'NEITHER'         → horizon 内未触及
 *   矩阵列：Survival / Target Hit / Stop→Target / Median ATR / Median RR / RR≥1.5
 *
 * 决策原则（冻结）：
 *   - 不把 Win Rate 当 Stop 选择依据
 *   - V2 只是 counterfactual；四维度（Narrative survival / Target reach /
 *     Stop-out-then-target / RR preservation）稳定后才谈改正式 stopPlanner
 */
var stopPlanner = require('../trade/stopPlanner');

var NOISE_THRESHOLDS = [0.5, 0.75, 1.0];
var DEFAULT_HORIZON = 288; // 24h × 12 bars/h（5m）

var MATRIX_KEYS = [
    'BASELINE',
    'MANIPULATION_INVALIDATION',
    'ACCUMULATION_INVALIDATION',
    'MANIPULATION_INVALIDATION_NBUF',
    'ACCUMULATION_INVALIDATION_NBUF'
];

function median(arr) {
    if (!arr || arr.length === 0) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 从 entry 的 stopCandidates 提取 narrative 参考价（Manipulation extreme / Accumulation boundary）
 * @param {Object} entry 正式 trade（含 diagnostics.stopCandidates）
 * @returns {Object} { manipExtreme, accBoundary }（可为 null）
 */
function extractNarrativeRefs(entry) {
    var cands = (entry.diagnostics && entry.diagnostics.stopCandidates) || [];
    var manipExtreme = null;
    var accBoundary = null;
    cands.forEach(function (c) {
        if (c.source === 'MANIPULATION_SWEEP' && c.referencePrice !== null && c.referencePrice !== undefined) {
            manipExtreme = c.referencePrice;
        }
        if (c.source === 'ACCUMULATION_RANGE' && c.referencePrice !== null && c.referencePrice !== undefined) {
            accBoundary = c.referencePrice;
        }
    });
    return { manipExtreme: manipExtreme, accBoundary: accBoundary };
}

/**
 * V2 模型构建：从 entry 的 stopCandidates 中挑出越过 narrative 边界的 valid 候选，
 * 生成 MANIPULATION_INVALIDATION / ACCUMULATION_INVALIDATION（+ NBUF 变体）。
 * @returns {Array} [{ key, refType, referencePrice, price, distance, distanceAtr }]
 */
function buildV2Models(entry, opts) {
    var o = opts || {};
    var cands = (entry.diagnostics && entry.diagnostics.stopCandidates) || [];
    var direction = entry.direction;
    var entryPrice = entry.entryPrice;
    var atr = (entry.diagnostics && entry.diagnostics.atr) || 0;
    var noiseMult = o.noiseMult !== undefined ? o.noiseMult : 1.0;

    var models = [];

    function pushFor(source, refType, key) {
        var cand = null;
        cands.forEach(function (c) {
            if (c.source === source && c.valid && c.price !== null) {
                if (refType === 'manip' && c.isBeyondManipulationExtreme === true) cand = c;
                if (refType === 'acc' && c.isBeyondAccumulationRange === true) cand = c;
            }
        });
        if (!cand) return;
        var dist = Math.abs(entryPrice - cand.price);
        models.push({
            key: key,
            refType: refType,
            referencePrice: cand.referencePrice,
            price: cand.price,
            distance: dist,
            distanceAtr: atr > 0 ? dist / atr : null
        });
        // noise buffer 变体：保底 distanceATR >= noiseMult ATR（不破坏 narrative 外的位置）
        if (atr > 0) {
            var priceNBUF;
            if (direction === 'LONG') {
                priceNBUF = Math.min(cand.price, entryPrice - atr * noiseMult);
            } else {
                priceNBUF = Math.max(cand.price, entryPrice + atr * noiseMult);
            }
            var distNBUF = Math.abs(entryPrice - priceNBUF);
            models.push({
                key: key + '_NBUF',
                refType: refType,
                referencePrice: cand.referencePrice,
                price: priceNBUF,
                distance: distNBUF,
                distanceAtr: distNBUF / atr
            });
        }
    }

    pushFor('MANIPULATION_SWEEP', 'manip', 'MANIPULATION_INVALIDATION');
    pushFor('ACCUMULATION_RANGE', 'acc', 'ACCUMULATION_INVALIDATION');

    return models;
}

/**
 * 单 entry + 单 stop 的四态模拟（horizon 内）
 * @returns {Object} { first: 'TARGET'|'STOP'|'AMBIGUOUS'|'NEITHER', stopOutThenTarget: bool }
 */
function simulateOutcome(ex, stopPrice, candles, startIdx, opts) {
    var o = opts || {};
    var direction = ex.direction;
    var targetPrice = ex.targetPrice;
    var horizon = o.horizon !== undefined ? o.horizon : DEFAULT_HORIZON;
    var endIdx = Math.min(candles.length, startIdx + 1 + horizon);

    var first = 'NEITHER';
    var k;
    for (k = startIdx + 1; k < endIdx; k++) {
        var c = candles[k];
        if (!c || c.closed === false) continue;
        var stopHit, targetHit;
        if (direction === 'LONG') {
            stopHit = c.low <= stopPrice;
            targetHit = c.high >= targetPrice;
        } else {
            stopHit = c.high >= stopPrice;
            targetHit = c.low <= targetPrice;
        }
        if (stopHit && targetHit) { first = 'AMBIGUOUS'; break; }
        if (targetHit) { first = 'TARGET'; break; }
        if (stopHit) { first = 'STOP'; break; }
    }
    var stopOutThenTarget = false;
    if (first === 'STOP') {
        for (; k < endIdx; k++) {
            var c2 = candles[k];
            if (!c2 || c2.closed === false) continue;
            if (direction === 'LONG' && c2.high >= targetPrice) { stopOutThenTarget = true; break; }
            if (direction === 'SHORT' && c2.low <= targetPrice) { stopOutThenTarget = true; break; }
        }
    }
    return { first: first, stopOutThenTarget: stopOutThenTarget };
}

function emptyRow(key) {
    return {
        key: key,
        n: 0,
        survival: 0,
        targetHit: 0,
        stopOutN: 0,
        stopOutThenTarget: 0,
        stopToTargetRate: 0,
        distAtrs: [],
        rrs: [],
        tooClose: { '0.5': 0, '0.75': 0, '1': 0 }
    };
}

function record(row, ex, stopPrice, candles, startIdx, opts) {
    if (stopPrice === null || stopPrice === undefined) return;
    // stop 必须仍在风险方向（LONG: stop<entry；SHORT: stop>entry），否则跳过（异常候选）
    if (ex.direction === 'LONG' && stopPrice >= ex.entryPrice) return;
    if (ex.direction === 'SHORT' && stopPrice <= ex.entryPrice) return;

    var outcome = simulateOutcome(ex, stopPrice, candles, startIdx, opts);
    row.n++;
    if (outcome.first === 'TARGET') row.survival++;
    if (outcome.first === 'TARGET' || outcome.stopOutThenTarget) row.targetHit++;
    if (outcome.first === 'STOP') {
        row.stopOutN++;
        if (outcome.stopOutThenTarget) row.stopOutThenTarget++;
    }

    var distAtr = ex.atr > 0 ? Math.abs(ex.entryPrice - stopPrice) / ex.atr : null;
    if (distAtr !== null) row.distAtrs.push(distAtr);

    var risk = Math.abs(ex.entryPrice - stopPrice);
    var reward = ex.direction === 'LONG'
        ? ex.targetPrice - ex.entryPrice
        : ex.entryPrice - ex.targetPrice;
    if (risk > 0 && reward > 0) {
        row.rrs.push(reward / risk);
    }

    NOISE_THRESHOLDS.forEach(function (t) {
        if (distAtr !== null && distAtr < t) row.tooClose[String(t)]++;
    });
}

function finalizeRow(row) {
    return {
        key: row.key,
        n: row.n,
        survivalRate: row.n > 0 ? row.survival / row.n : 0,
        survivalN: row.survival,
        targetHitRate: row.n > 0 ? row.targetHit / row.n : 0,
        targetHitN: row.targetHit,
        stopOutN: row.stopOutN,
        stopOutThenTarget: row.stopOutThenTarget,
        stopToTargetRate: row.stopOutN > 0 ? row.stopOutThenTarget / row.stopOutN : null,
        medianDistAtr: median(row.distAtrs),
        medianRR: median(row.rrs),
        rrGe15: row.rrs.filter(function (r) { return r >= 1.5; }).length / (row.rrs.length > 0 ? row.rrs.length : 1),
        rrN: row.rrs.length,
        tooClose: NOISE_THRESHOLDS.map(function (t) {
            return { threshold: t, n: row.tooClose[String(t)], rate: row.n > 0 ? row.tooClose[String(t)] / row.n : 0 };
        })
    };
}

/**
 * V2 对照矩阵（Phase 11T.2 主输出）
 * @param {Array} entries 正式 trades（WIN/LOSS/AMBIGUOUS），含 entryPrice/targetPrice/stopPrice/entryIndex/diagnostics
 * @param {Array} candles 5m candles
 * @param {Object} [opts] { horizon, noiseMult }
 * @returns {Object} { rows: { key: finalizedRow }, coverage, pairs }
 */
function v2Matrix(entries, candles, opts) {
    var o = opts || {};
    var rows = {};
    MATRIX_KEYS.forEach(function (k) { rows[k] = emptyRow(k); });

    var coverage = { total: 0, manipOnly: 0, accOnly: 0, both: 0, none: 0 };

    (entries || []).forEach(function (e) {
        var atr = (e.diagnostics && e.diagnostics.atr) || null;
        if (!e.entryPrice || !e.targetPrice || !atr || atr <= 0) return;
        if (e.entryIndex === null || e.entryIndex === undefined) return;

        var ex = {
            direction: e.direction,
            entryPrice: e.entryPrice,
            targetPrice: e.targetPrice,
            atr: atr
        };
        var startIdx = e.entryIndex;

        var refs = extractNarrativeRefs(e);
        coverage.total++;
        if (refs.manipExtreme !== null && refs.accBoundary === null) coverage.manipOnly++;
        if (refs.manipExtreme === null && refs.accBoundary !== null) coverage.accOnly++;
        if (refs.manipExtreme !== null && refs.accBoundary !== null) coverage.both++;
        if (refs.manipExtreme === null && refs.accBoundary === null) coverage.none++;

        record(rows.BASELINE, ex, e.stopPrice, candles, startIdx, o);

        buildV2Models(e, o).forEach(function (m) {
            if (rows[m.key]) record(rows[m.key], ex, m.price, candles, startIdx, o);
        });
    });

    var out = {};
    MATRIX_KEYS.forEach(function (k) { out[k] = finalizeRow(rows[k]); });
    return { rows: out, coverage: coverage, horizon: o.horizon !== undefined ? o.horizon : DEFAULT_HORIZON };
}

/**
 * Baseline vs V2 配对统计（same target）——用户关心的两个门槛：
 *   1. V2 survival 提升但 RR<1.5 的比例（不能采用）
 *   2. RR≥1.5 保留率（V2 是否把 risk 拉大到毁掉大部分 RR）
 * @returns {Object} { models: { key: { pairs, baseSurv, v2Surv, baseSurvN, v2SurvN, survGain,
 *                          rrGe15, survGainButRrLt15, stopOutThenTargetBase, stopOutThenTargetV2 } } }
 */
function baselineVsV2(entries, candles, opts) {
    var o = opts || {};
    var models = {};
    var horizon = o.horizon !== undefined ? o.horizon : DEFAULT_HORIZON;

    function ensure(key) {
        if (!models[key]) {
            models[key] = {
                pairs: 0,
                baseSurv: 0, v2Surv: 0,
                baseStopOutThenTarget: 0, v2StopOutThenTarget: 0,
                rrGe15: 0, survGainButRrLt15: 0,
                bothSurvive: 0, neitherSurvive: 0
            };
        }
        return models[key];
    }

    (entries || []).forEach(function (e) {
        var atr = (e.diagnostics && e.diagnostics.atr) || null;
        if (!e.entryPrice || !e.targetPrice || !atr || atr <= 0) return;
        if (e.entryIndex === null || e.entryIndex === undefined) return;
        if (e.stopPrice === null || e.stopPrice === undefined) return;
        var ex = {
            direction: e.direction,
            entryPrice: e.entryPrice,
            targetPrice: e.targetPrice,
            atr: atr
        };
        var startIdx = e.entryIndex;

        var baseOutcome = simulateOutcome(ex, e.stopPrice, candles, startIdx, o);
        var baseSurv = baseOutcome.first === 'TARGET';
        var baseSot = baseOutcome.first === 'STOP' && baseOutcome.stopOutThenTarget;

        buildV2Models(e, o).forEach(function (m) {
            var row = ensure(m.key);
            var v2Outcome = simulateOutcome(ex, m.price, candles, startIdx, o);
            var v2Surv = v2Outcome.first === 'TARGET';
            var v2Sot = v2Outcome.first === 'STOP' && v2Outcome.stopOutThenTarget;

            var risk = Math.abs(ex.entryPrice - m.price);
            var reward = ex.direction === 'LONG'
                ? ex.targetPrice - ex.entryPrice
                : ex.entryPrice - ex.targetPrice;
            var rr = risk > 0 && reward > 0 ? reward / risk : null;

            row.pairs++;
            if (baseSurv) row.baseSurv++;
            if (v2Surv) row.v2Surv++;
            if (baseSot) row.baseStopOutThenTarget++;
            if (v2Sot) row.v2StopOutThenTarget++;
            if (rr !== null && rr >= 1.5) row.rrGe15++;
            if (v2Surv && !baseSurv && (rr === null || rr < 1.5)) row.survGainButRrLt15++;
            if (baseSurv && v2Surv) row.bothSurvive++;
            if (!baseSurv && !v2Surv) row.neitherSurvive++;
        });
    });

    Object.keys(models).forEach(function (k) {
        var r = models[k];
        r.baseSurvRate = r.pairs > 0 ? r.baseSurv / r.pairs : 0;
        r.v2SurvRate = r.pairs > 0 ? r.v2Surv / r.pairs : 0;
        r.survDelta = r.v2SurvRate - r.baseSurvRate;
        r.rrGe15Rate = r.pairs > 0 ? r.rrGe15 / r.pairs : 0;
        r.survGainButRrLt15Rate = r.pairs > 0 ? r.survGainButRrLt15 / r.pairs : 0;
    });

    return { models: models, horizon: horizon };
}

module.exports = {
    NOISE_THRESHOLDS: NOISE_THRESHOLDS,
    DEFAULT_HORIZON: DEFAULT_HORIZON,
    MATRIX_KEYS: MATRIX_KEYS,
    extractNarrativeRefs: extractNarrativeRefs,
    buildV2Models: buildV2Models,
    simulateOutcome: simulateOutcome,
    v2Matrix: v2Matrix,
    baselineVsV2: baselineVsV2
};
