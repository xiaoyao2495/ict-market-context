/**
 * Entry Gate（Phase 9.2）
 *
 * 只在 Action = WATCH 时运行；WAIT / NO_TRADE → CLOSED（不扫描 FVG）。
 *
 * 状态：
 *   CLOSED          非 WATCH（或初始态）
 *   WAITING_FVG     WATCH 但无匹配 valid FVG
 *   WAITING_RETRACE WATCH + 有匹配 valid FVG，价格尚未进入 zone
 *   ENTRY_READY     价格已回踩进 zone（FVG ACTIVE/TOUCHED/MIDPOINT_TOUCHED）
 *   INVALIDATED     进入 retrace/ready 后失效（scenario 翻向 / AMD INVALIDATED /
 *                   alignment OPPOSITE / FVG INVALIDATED / opposite delivery）
 *
 * 规则：
 * - 只接受 displacementEventId 非空 且 score >= threshold 的 FVG
 * - primary FVG 选择：与 active distribution chain 匹配 → score 高 →
 *   confirmedAt 近 → 距离当前价格近 → id 字典序（deterministic）
 * - ENTRY_READY 只是 entry confirmation ready，不是自动交易
 * - preferredEntry 第一版 = midpoint
 *
 * replay-safe：INVALIDATED 判定需要 previousState（调用方在回放循环中传递）。
 */
var thresholds = require('../config/thresholds');
var fvgScorer = require('../fvg/fvgScorer');

var GATE_CLOSED = 'CLOSED';
var GATE_WAITING_FVG = 'WAITING_FVG';
var GATE_WAITING_RETRACE = 'WAITING_RETRACE';
var GATE_ENTRY_READY = 'ENTRY_READY';
var GATE_INVALIDATED = 'INVALIDATED';

/**
 * @param {Object} input {
 *   symbol, evaluationTime, currentPrice,
 *   scenario,   scenarioEngine 输出（scenarioState, direction, action）
 *   action,     'NO_TRADE' | 'WAIT' | 'WATCH' | 'SETUP_READY'
 *   amd,        amdStateMachine 输出
 *   alignment,  'MATCH' | 'OPPOSITE' | 'UNCONFIRMED'
 *   fvgs,       FVG 数组（已过滤 confirmedAt <= evaluationTime）
 *   previousState 可选（用于 INVALIDATED 判定）
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   state, reason, fvg, entryZone, preferredEntry, invalidatedReason
 * }
 */
function runEntryGate(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).entry;
    var symbol = input.symbol || 'UNKNOWN';
    var evaluationTime = input.evaluationTime;
    var currentPrice = input.currentPrice;
    var action = input.action;
    var scenario = input.scenario || {};
    var amd = input.amd || {};
    var alignment = input.alignment || null;
    var fvgs = (input.fvgs || []).filter(function (f) {
        // 防未来数据：confirmedAt > evaluationTime 的 FVG 不得参与
        return f && f.confirmedAt <= evaluationTime;
    });
    var previousState = input.previousState || null;

    // ---- 失效判定（需已进入 retrace/ready） ----
    if (
        (previousState === GATE_WAITING_RETRACE || previousState === GATE_ENTRY_READY) &&
        gateInvalidated(input, cfg, fvgs)
    ) {
        return {
            state: GATE_INVALIDATED,
            reason: null,
            fvg: null,
            entryZone: null,
            preferredEntry: null,
            invalidatedReason: invalidationReason(input, cfg, fvgs)
        };
    }

    // ---- 非 WATCH → CLOSED ----
    if (action !== 'WATCH') {
        return {
            state: GATE_CLOSED,
            reason: 'Entry Gate only runs when Action = WATCH',
            fvg: null,
            entryZone: null,
            preferredEntry: null,
            invalidatedReason: null
        };
    }

    var direction = scenario.direction; // BULLISH / BEARISH（WATCH 时必有方向）

    // ---- 候选 FVG：方向匹配 + displacement 关联 + score >= threshold ----
    var candidates = (fvgs || []).filter(function (f) {
        if (f.direction !== direction) {
            return false;
        }
        if (!f.displacementEventId) {
            return false;
        }
        var scored = fvgScorer.scoreFvg(f, {
            amdDirection: amd.direction,
            scenarioDirection: direction
        }, opts);
        if (!scored.passed) {
            return false;
        }
        f._score = scored.total;
        return true;
    });

    if (candidates.length === 0) {
        return {
            state: GATE_WAITING_FVG,
            reason: 'No matching valid FVG (direction + displacement + score >= threshold)',
            fvg: null,
            entryZone: null,
            preferredEntry: null,
            invalidatedReason: null,
            // Phase 11E.7：gate 语义 shadow（只诊断）
            stats: gateStats(input, fvgs, direction, opts)
        };
    }

    // ---- primary FVG 选择（deterministic） ----
    var primary = selectPrimaryFvg(candidates, amd, currentPrice);

    // ---- 价格是否进入 zone ----
    var inZone = priceInZone(primary, currentPrice);
    if (!inZone) {
        return {
            state: GATE_WAITING_RETRACE,
            reason: 'Valid FVG found; waiting for price retrace into zone',
            fvg: primary,
            entryZone: zoneOf(primary),
            preferredEntry: preferredOf(primary, cfg),
            invalidatedReason: null,
            // Phase 11E.7：gate 语义 shadow（wick-touch vs close-in-zone）
            stats: gateStats(input, fvgs, direction, opts, primary, currentPrice)
        };
    }

    // ---- 进入 zone → 检查 FVG 状态 ----
    if (
        primary.status === 'ACTIVE' ||
        primary.status === 'TOUCHED' ||
        primary.status === 'MIDPOINT_TOUCHED'
    ) {
        return {
            state: GATE_ENTRY_READY,
            reason: 'Price retraced into FVG; entry confirmation ready (not auto trade)',
            fvg: primary,
            entryZone: zoneOf(primary),
            preferredEntry: preferredOf(primary, cfg),
            invalidatedReason: null,
            // Phase 11E.7：gate 语义 shadow
            stats: gateStats(input, fvgs, direction, opts, primary, currentPrice)
        };
    }

    // FVG FILLED / INVALIDATED → 不能再入场
    return {
        state: GATE_WAITING_FVG,
        reason: 'Primary FVG consumed (' + primary.status + '); looking for fresh FVG',
        fvg: null,
        entryZone: null,
        preferredEntry: null,
        invalidatedReason: null,
        // Phase 11E.7：gate 语义 shadow
        stats: gateStats(input, fvgs, direction, opts, primary, currentPrice)
    };
}

/**
 * Phase 11E.7 — Gate 语义 shadow（只诊断，不改 gate 行为）
 * 量化两个最可疑瓶颈：
 *   a) close-in-zone vs wick-touch-zone：ICT 2022 是价格"触及"FVG（wick 进入即可），
 *      当前实现要求收盘价在 zone 内 → 统计"wick 触及但 close 在外"的频次
 *   b) score 分布：score >= 60（entryThreshold）是自研过滤器，ICT 无此概念 →
 *      统计候选 FVG 的 score 直方图（量化被 60 门槛过滤的量）
 */
function gateStats(input, fvgs, direction, opts, primary, currentPrice) {
    var out = {
        candidates: 0,
        scoreHist: { lt40: 0, ge40lt60: 0, ge60: 0 },
        noDisplacement: 0,
        wickTouchButCloseOutside: false
    };
    var cfg = (opts.thresholds || thresholds).fvg;
    var threshold = cfg && cfg.scorer && cfg.scorer.entryThreshold !== undefined ? cfg.scorer.entryThreshold : 60;
    (fvgs || []).forEach(function (f) {
        if (f.direction !== direction) return;
        if (!f.displacementEventId) { out.noDisplacement++; return; }
        var scored = fvgScorer.scoreFvg(f, {
            amdDirection: input.amd && input.amd.direction,
            scenarioDirection: direction
        }, opts);
        var s = scored.total || 0;
        if (s < 40) out.scoreHist.lt40++;
        else if (s < threshold) out.scoreHist.ge40lt60++;
        else out.scoreHist.ge60++;
        out.candidates++;
    });
    // wick-touch vs close-in-zone（仅 primary 已知时）
    if (primary && currentPrice !== undefined && currentPrice !== null && input.candle) {
        var inside = currentPrice >= primary.zoneLow && currentPrice <= primary.zoneHigh;
        var wickTouch = input.candle.low <= primary.zoneHigh && input.candle.high >= primary.zoneLow;
        out.wickTouchButCloseOutside = wickTouch && !inside;
    }
    return out;
}

/**
 * 失效条件（曾进入 retrace/ready 后）：
 * - scenario 不再 matching（方向变化 / 非 WATCH）
 * - AMD INVALIDATED
 * - alignment OPPOSITE
 * - FVG INVALIDATED
 * - opposite complete delivery
 */
function gateInvalidated(input, cfg, fvgs) {
    var inv = cfg.invalidation || {};
    var scenario = input.scenario || {};
    var amd = input.amd || {};
    var alignment = input.alignment || null;

    if (inv.scenarioMismatch !== false) {
        if (scenario.action !== 'WATCH' || !scenario.direction) {
            return true;
        }
        if (amd.direction && amd.direction !== scenario.direction) {
            return true;
        }
    }
    if (inv.amdInvalidated !== false && amd.state === 'INVALIDATED') {
        return true;
    }
    if (inv.alignmentOpposite !== false && alignment === 'OPPOSITE') {
        return true;
    }
    if (inv.oppositeDelivery !== false) {
        var delivery = scenario.inputs && scenario.inputs.delivery;
        if (delivery && delivery.available && delivery.direction) {
            var opposite = scenario.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH';
            if (delivery.direction === opposite) {
                return true;
            }
        }
    }
    return false;
}

function invalidationReason(input, cfg, fvgs) {
    var parts = [];
    var scenario = input.scenario || {};
    var amd = input.amd || {};
    var alignment = input.alignment || null;

    if (scenario.action !== 'WATCH' || !scenario.direction) {
        parts.push('Scenario no longer in matching WATCH state');
    }
    if (amd.state === 'INVALIDATED') {
        parts.push('AMD INVALIDATED');
    }
    if (alignment === 'OPPOSITE') {
        parts.push('Alignment OPPOSITE');
    }
    if (fvgs && fvgs.length) {
        var fvgActive = fvgs.some(function (f) {
            return f.status === 'ACTIVE' || f.status === 'TOUCHED' || f.status === 'MIDPOINT_TOUCHED';
        });
        if (!fvgActive) {
            parts.push('FVG INVALIDATED');
        }
    }
    if (parts.length === 0) {
        parts.push('Context invalidated');
    }
    return parts.join('; ');
}

/**
 * primary FVG 选择：
 * 1. 与 active distribution direction 匹配
 * 2. score 高
 * 3. confirmedAt 最近（更新的优先——老 FVG 价格早已离开，不应压过新 FVG）
 * 4. 距离当前价格近
 * 5. id 字典序
 */
function selectPrimaryFvg(candidates, amd, currentPrice) {
    var scored = candidates.slice().sort(function (a, b) {
        var chainA = chainMatchScore(a, amd);
        var chainB = chainMatchScore(b, amd);
        if (chainA !== chainB) {
            return chainB - chainA;
        }
        var sa = a._score || 0;
        var sb = b._score || 0;
        if (sa !== sb) {
            return sb - sa;
        }
        if (a.confirmedAt !== b.confirmedAt) {
            return b.confirmedAt - a.confirmedAt; // 最近优先
        }
        if (currentPrice !== undefined) {
            var da = Math.abs(a.midpoint - currentPrice);
            var db = Math.abs(b.midpoint - currentPrice);
            if (da !== db) {
                return da - db;
            }
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return scored[0];
}

function chainMatchScore(f, amd) {
    var score = 0;
    if (amd && amd.direction === f.direction && amd.state === 'DISTRIBUTION_CONFIRMED') {
        score += 1;
    }
    return score;
}

function priceInZone(f, currentPrice) {
    if (currentPrice === undefined || currentPrice === null) {
        return false;
    }
    return currentPrice >= f.zoneLow && currentPrice <= f.zoneHigh;
}

function zoneOf(f) {
    return {
        low: f.zoneLow,
        high: f.zoneHigh,
        midpoint: f.midpoint
    };
}

function preferredOf(f, cfg) {
    var mode = cfg && cfg.preferredEntry ? cfg.preferredEntry : 'MIDPOINT';
    if (mode === 'MIDPOINT') {
        return f.midpoint;
    }
    return f.midpoint; // 第一版统一 midpoint
}

module.exports = {
    runEntryGate: runEntryGate,
    selectPrimaryFvg: selectPrimaryFvg,
    priceInZone: priceInZone,
    STATES: {
        CLOSED: GATE_CLOSED,
        WAITING_FVG: GATE_WAITING_FVG,
        WAITING_RETRACE: GATE_WAITING_RETRACE,
        ENTRY_READY: GATE_ENTRY_READY,
        INVALIDATED: GATE_INVALIDATED
    }
};
