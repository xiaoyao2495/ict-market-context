/**
 * Trade Simulator（Phase 10）
 *
 * 逐 K 回放一个已生成（READY）的 Trade Plan：
 *   WAIT_ENTRY → OPEN → WIN / LOSS
 *   等待期超时 → EXPIRED
 *   等待期 context invalidated → CANCELLED
 *   同一根 K 同时碰 SL 与 TP → AMBIGUOUS（不猜先后，不算 WIN）
 *
 * 规则：
 * - 只使用 createdAt 之后的已收盘 candles（未来数据排除）
 * - Entry Fill：LONG 时 candle.low <= entry <= candle.high；SHORT 对称
 * - OPEN 后逐根检查 SL / TP：
 *   LONG: low <= stop → STOP；high >= target → TARGET
 *   SHORT: high >= stop；low <= target
 * - 同一根同时命中 → AMBIGUOUS（保守，不自动计 WIN）
 * - MAE / MFE 记录并转为 R 倍数（除以初始 risk）
 * - OPEN 后第一版不做动态取消（只认 SL/TP/ambiguous）
 */
var thresholds = require('../config/thresholds');

var S_WAIT = 'WAIT_ENTRY';
var S_OPEN = 'OPEN';
var S_WIN = 'WIN';
var S_LOSS = 'LOSS';
var S_EXPIRED = 'EXPIRED';
var S_CANCELLED = 'CANCELLED';
var S_AMBIGUOUS = 'AMBIGUOUS';

/**
 * @param {Object} plan tradePlan（status READY）或 { entry: {price}, stop: {price}, target: {price}, direction }
 * @param {Array} candles createdAt 之后的已收盘 candles（时间升序）
 * @param {Object} [options] {
 *   tradeId,
 *   cancelCheck: function(candle, index) → bool（等待期失效检查，可选）
 * }
 * @returns {Object} result
 */
function simulateTrade(plan, candles, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).trade;
    var direction = plan.direction;
    var entryPrice = plan.entry.price;
    var stopPrice = plan.stop.price;
    var targetPrice = plan.target.price;
    var tradeId = opts.tradeId || plan.id || 'TRADE_1';
    var cancelCheck = opts.cancelCheck || null;

    var initialRisk = direction === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;
    if (initialRisk <= 0) {
        return {
            tradeId: tradeId,
            status: 'INVALID',
            entryPrice: entryPrice,
            entryAt: null,
            exitPrice: null,
            exitAt: null,
            stopPrice: stopPrice,
            targetPrice: targetPrice,
            plannedRR: plan.rr || null,
            realizedR: 0,
            mae: 0,
            mfe: 0,
            maeR: 0,
            mfeR: 0,
            holdBars: 0,
            waitBars: 0,
            ambiguous: false,
            reasons: ['Invalid plan: risk not positive']
        };
    }

    var status = S_WAIT;
    var entryAt = null;
    var exitPrice = null;
    var exitAt = null;
    var holdBars = 0;
    var waitBars = 0;
    var mae = 0;
    var mfe = 0;
    var ambiguous = false;
    var reasons = [];

    var i;
    for (i = 0; i < candles.length; i++) {
        var c = candles[i];
        if (!c || c.closed === false) {
            continue; // 只处理已收盘 candle
        }

        if (status === S_WAIT) {
            // 等待期失效检查
            if (cancelCheck && cancelCheck(c, i)) {
                return finish(S_CANCELLED, tradeId, entryPrice, entryAt, exitPrice, exitAt, stopPrice, targetPrice, plan, initialRisk, holdBars, waitBars, mae, mfe, ambiguous, ['Context invalidated before entry']);
            }
            // 超时
            if (waitBars >= (cfg.simulator.maxEntryWaitBars !== undefined ? cfg.simulator.maxEntryWaitBars : 12)) {
                return finish(S_EXPIRED, tradeId, entryPrice, entryAt, exitPrice, exitAt, stopPrice, targetPrice, plan, initialRisk, holdBars, waitBars, mae, mfe, ambiguous, ['Entry wait timeout']);
            }
            // 尝试入场
            var fill = (direction === 'LONG' && c.low <= entryPrice && c.high >= entryPrice) ||
                       (direction === 'SHORT' && c.high >= entryPrice && c.low <= entryPrice);
            if (fill) {
                status = S_OPEN;
                entryAt = c.closeTime;
            } else {
                waitBars++;
                continue;
            }
        }

        if (status === S_OPEN) {
            holdBars++;

            // MAE / MFE
            var excursion = direction === 'LONG'
                ? { mae: Math.max(mae, entryPrice - c.low), mfe: Math.max(mfe, c.high - entryPrice) }
                : { mae: Math.max(mae, c.high - entryPrice), mfe: Math.max(mfe, entryPrice - c.low) };
            mae = excursion.mae;
            mfe = excursion.mfe;

            var stopHit = direction === 'LONG' ? c.low <= stopPrice : c.high >= stopPrice;
            var targetHit = direction === 'LONG' ? c.high >= targetPrice : c.low <= targetPrice;

            if (stopHit && targetHit) {
                // 同根 K 同时命中 → AMBIGUOUS，不猜先后
                status = S_AMBIGUOUS;
                ambiguous = true;
                exitPrice = null;
                exitAt = c.closeTime;
                reasons.push('Same candle hit both stop and target; ambiguous');
                break;
            }
            if (stopHit) {
                status = S_LOSS;
                exitPrice = stopPrice;
                exitAt = c.closeTime;
                break;
            }
            if (targetHit) {
                status = S_WIN;
                exitPrice = targetPrice;
                exitAt = c.closeTime;
                break;
            }
        }
    }

    if (status === S_OPEN) {
        // 数据结束仍未平仓
        status = 'OPEN';
    }

    var realizedR = 0;
    if (status === S_WIN) {
        realizedR = direction === 'LONG'
            ? (targetPrice - entryPrice) / initialRisk
            : (entryPrice - targetPrice) / initialRisk;
    } else if (status === S_LOSS) {
        realizedR = -1;
    } else if (status === S_AMBIGUOUS) {
        realizedR = 0; // 不参与核心胜率统计
    }

    return {
        tradeId: tradeId,
        status: status,
        entryPrice: entryPrice,
        entryAt: entryAt,
        exitPrice: exitPrice,
        exitAt: exitAt,
        stopPrice: stopPrice,
        targetPrice: targetPrice,
        plannedRR: plan.rr !== undefined ? plan.rr : null,
        realizedR: round4(realizedR),
        mae: round4(mae),
        mfe: round4(mfe),
        maeR: round4(mae / initialRisk),
        mfeR: round4(mfe / initialRisk),
        holdBars: holdBars,
        waitBars: waitBars,
        ambiguous: ambiguous,
        reasons: reasons
    };
}

function finish(status, tradeId, entryPrice, entryAt, exitPrice, exitAt, stopPrice, targetPrice, plan, initialRisk, holdBars, waitBars, mae, mfe, ambiguous, reasons) {
    // finish 只被 CANCELLED / EXPIRED 调用 → realizedR = 0（未成交）
    return {
        tradeId: tradeId,
        status: status,
        entryPrice: entryPrice,
        entryAt: entryAt,
        exitPrice: exitPrice,
        exitAt: exitAt,
        stopPrice: stopPrice,
        targetPrice: targetPrice,
        plannedRR: plan.rr !== undefined ? plan.rr : null,
        realizedR: 0,
        mae: round4(mae),
        mfe: round4(mfe),
        maeR: round4(mae / initialRisk),
        mfeR: round4(mfe / initialRisk),
        holdBars: holdBars,
        waitBars: waitBars,
        ambiguous: ambiguous,
        reasons: reasons
    };
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

module.exports = {
    simulateTrade: simulateTrade,
    STATES: {
        WAIT_ENTRY: S_WAIT,
        OPEN: S_OPEN,
        WIN: S_WIN,
        LOSS: S_LOSS,
        EXPIRED: S_EXPIRED,
        CANCELLED: S_CANCELLED,
        AMBIGUOUS: S_AMBIGUOUS
    }
};
