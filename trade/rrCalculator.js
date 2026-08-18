/**
 * RR Calculator（Phase 10）
 *
 * LONG：
 *   risk   = entry - stop
 *   reward = target - entry
 * SHORT：
 *   risk   = stop - entry
 *   reward = entry - target
 * rr = reward / risk
 *
 * 要求 risk > 0 且 reward > 0，否则 invalid。
 * rr < minRR（默认 1.5）→ REJECTED / INSUFFICIENT_RR。
 *
 * 注意：RR 不是 win probability。
 * 注意：不为了满足 RR 人工修改 target —— 真实 RR 不足就拒绝。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} input {
 *   direction, entryPrice, stopPrice, targetPrice
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   status: 'READY' | 'INVALID' | 'REJECTED',
 *   risk, reward, rr, reason
 * }
 */
function calculateRR(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).trade;
    var direction = input.direction;
    var entry = input.entryPrice;
    var stop = input.stopPrice;
    var target = input.targetPrice;

    if (entry === undefined || entry === null || entry <= 0) {
        return invalid('Entry price required');
    }
    if (stop === undefined || stop === null || stop <= 0) {
        return invalid('Stop price required');
    }
    if (target === undefined || target === null || target <= 0) {
        return invalid('Target price required');
    }

    var risk;
    var reward;
    if (direction === 'LONG') {
        risk = entry - stop;
        reward = target - entry;
    } else if (direction === 'SHORT') {
        risk = stop - entry;
        reward = entry - target;
    } else {
        return invalid('Direction must be LONG or SHORT');
    }

    if (risk <= 0) {
        return invalid('Risk must be positive (stop on correct side)');
    }
    if (reward <= 0) {
        return invalid('Reward must be positive (target on profit side)');
    }

    var rr = reward / risk;
    var minRR = cfg.rr.minRR !== undefined ? cfg.rr.minRR : 1.5;
    if (rr < minRR) {
        return {
            status: 'REJECTED',
            risk: round2(risk),
            reward: round2(reward),
            rr: round2(rr),
            reason: 'INSUFFICIENT_RR (rr ' + round2(rr) + ' < min ' + minRR + ')'
        };
    }

    return {
        status: 'READY',
        risk: round2(risk),
        reward: round2(reward),
        rr: round2(rr),
        reason: null
    };
}

function invalid(reason) {
    return {
        status: 'INVALID',
        risk: null,
        reward: null,
        rr: null,
        reason: reason
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = {
    calculateRR: calculateRR
};
