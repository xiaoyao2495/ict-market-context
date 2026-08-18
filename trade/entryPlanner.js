/**
 * Entry Planner（Phase 10）
 *
 * 只接受 entryGate.state = ENTRY_READY，否则 NOT_AVAILABLE。
 *
 * Entry 模式（config 化）：
 *   MIDPOINT               默认，entry = FVG midpoint
 *   ZONE_EDGE              LONG 用 zoneLow / SHORT 用 zoneHigh（最靠近价格的一端）
 *   MARKET_ON_CONFIRMATION 当前价（确认后立即入场）
 *
 * LONG/SHORT 对称。
 * 如果当前价格已经明显越过 entry（超出 missedTolerancePct 比例且无法合理回踩），
 * 输出 ENTRY_MISSED，而不是硬给一个追价 entry。
 */
var thresholds = require('../config/thresholds');

var MODE_MIDPOINT = 'MIDPOINT';
var MODE_ZONE_EDGE = 'ZONE_EDGE';
var MODE_MARKET = 'MARKET_ON_CONFIRMATION';

/**
 * @param {Object} input {
 *   entryGate,       entryGate 输出（state, entryZone, preferredEntry, currentPrice）
 *   currentPrice,
 *   direction        'LONG' | 'SHORT'
 *   evaluationTime
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   status: 'NOT_AVAILABLE' | 'ENTRY_MISSED' | 'READY',
 *   type, price, zoneLow, zoneHigh, reason
 * }
 */
function planEntry(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).trade;
    var gate = input.entryGate || {};
    var currentPrice = input.currentPrice;
    var direction = input.direction;

    // 只接受 ENTRY_READY
    if (gate.state !== 'ENTRY_READY' || !gate.entryZone) {
        return {
            status: 'NOT_AVAILABLE',
            type: null,
            price: null,
            zoneLow: null,
            zoneHigh: null,
            reason: 'Entry Gate must be ENTRY_READY'
        };
    }

    var zone = gate.entryZone;
    var mode = cfg.entry.mode || MODE_MIDPOINT;

    var price;
    var type;
    if (mode === MODE_MARKET) {
        price = currentPrice;
        type = 'MARKET_ON_CONFIRMATION';
    } else if (mode === MODE_ZONE_EDGE) {
        // LONG 从下沿入场（贴近价格侧），SHORT 从上沿
        price = direction === 'LONG' ? zone.low : zone.high;
        type = 'ZONE_EDGE';
    } else {
        price = zone.midpoint;
        type = 'FVG_MIDPOINT';
    }

    // ENTRY_MISSED：价格已明显越过 entry 且无法合理回踩
    var tolerance = zone.midpoint * (cfg.entry.missedTolerancePct || 0.0015);
    if (direction === 'LONG') {
        if (currentPrice > price + tolerance) {
            return {
                status: 'ENTRY_MISSED',
                type: type,
                price: price,
                zoneLow: zone.low,
                zoneHigh: zone.high,
                reason: 'Price already moved above entry; no chase entry'
            };
        }
    } else {
        if (currentPrice < price - tolerance) {
            return {
                status: 'ENTRY_MISSED',
                type: type,
                price: price,
                zoneLow: zone.low,
                zoneHigh: zone.high,
                reason: 'Price already moved below entry; no chase entry'
            };
        }
    }

    return {
        status: 'READY',
        type: type,
        price: round2(price),
        zoneLow: zone.low,
        zoneHigh: zone.high,
        reason: null
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = {
    planEntry: planEntry,
    MODES: {
        MIDPOINT: MODE_MIDPOINT,
        ZONE_EDGE: MODE_ZONE_EDGE,
        MARKET: MODE_MARKET
    }
};
