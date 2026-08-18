/**
 * Liquidity Lifecycle 状态机
 *
 * 状态（V1 固定四种，单向不可回退）：
 *   ACTIVE (0) → TOUCHED (1) → SWEPT (2) → BROKEN (3)
 *
 * 判定（对 BSL，level = liquidity.price）：
 *   BROKEN : close > level
 *   SWEPT  : high > level AND close < level   （wick 穿过 + close reclaim）
 *   TOUCHED : high >= level
 * 对 SSL 对称：
 *   BROKEN : close < level
 *   SWEPT  : low < level AND close > level
 *   TOUCHED : low <= level
 *
 * 优先级固定：BROKEN > SWEPT > TOUCHED > ACTIVE
 * （一根 K 线同时满足多个条件时，只取最高优先级，不产生 TOUCHED 误报）
 *
 * 严格约束：
 * - 只处理已收盘 K 线（closed === true），未收盘一律返回 null
 * - 状态只升不降（SWEPT 不会被新的 touch 拉回 TOUCHED）
 * - 不修改传入的 liquidity / candle（纯函数，返回状态变化描述）
 * - 时间戳一律使用触发 candle 的 closeTime
 */
var STATUS_RANK = {
    ACTIVE: 0,
    TOUCHED: 1,
    SWEPT: 2,
    BROKEN: 3
};

/**
 * 判断 BSL 是否被 sweep（wick through + close reclaim）
 */
function isBSLSweep(candle, level) {
    return candle.high > level && candle.close < level;
}

/**
 * 判断 SSL 是否被 sweep
 */
function isSSLSweep(candle, level) {
    return candle.low < level && candle.close > level;
}

/**
 * 计算一根已收盘 K 线对 liquidity 的目标状态（只升不降）
 * @param {Object} liquidity 统一 liquidity object
 * @param {Object} candle 已收盘 K 线
 * @returns {Object|null} 状态变化描述；无法评估 / 无变化返回 null
 */
function evaluateLiquidity(liquidity, candle) {
    if (!liquidity || !candle) {
        return null;
    }
    if (candle.closed === false) {
        return null; // 未收盘 K 线不得改变状态
    }

    var level = liquidity.price;
    var side = liquidity.side;
    var target;

    if (side === 'BSL') {
        if (candle.close > level) {
            target = 'BROKEN';
        } else if (isBSLSweep(candle, level)) {
            target = 'SWEPT';
        } else if (candle.high >= level) {
            target = 'TOUCHED';
        } else {
            target = 'ACTIVE';
        }
    } else {
        // SSL
        if (candle.close < level) {
            target = 'BROKEN';
        } else if (isSSLSweep(candle, level)) {
            target = 'SWEPT';
        } else if (candle.low <= level) {
            target = 'TOUCHED';
        } else {
            target = 'ACTIVE';
        }
    }

    var current = liquidity.status || 'ACTIVE';

    // 状态只升不降：目标优先级必须高于当前
    if (STATUS_RANK[target] <= STATUS_RANK[current]) {
        return null;
    }

    // 时间戳：已有值保留（更早的 touch 更真实），缺失则用本次触发时间
    var touchedAt = liquidity.touchedAt || candle.closeTime;
    var sweptAt = liquidity.sweptAt || null;
    var brokenAt = liquidity.brokenAt || null;
    if (target === 'SWEPT') {
        sweptAt = candle.closeTime;
    }
    if (target === 'BROKEN') {
        brokenAt = candle.closeTime;
    }

    var eventType;
    if (target === 'TOUCHED') {
        eventType = 'LIQUIDITY_TOUCHED';
    } else if (target === 'SWEPT') {
        eventType = 'LIQUIDITY_SWEPT';
    } else {
        eventType = 'LIQUIDITY_BROKEN';
    }

    return {
        previousStatus: current,
        status: target,
        touchedAt: touchedAt,
        sweptAt: sweptAt,
        brokenAt: brokenAt,
        event: {
            type: eventType,
            side: side,
            at: candle.closeTime
        }
    };
}

module.exports = {
    isBSLSweep: isBSLSweep,
    isSSLSweep: isSSLSweep,
    evaluateLiquidity: evaluateLiquidity,
    STATUS_RANK: STATUS_RANK
};
