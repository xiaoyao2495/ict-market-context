/**
 * STRUCTURAL_SWING — ATR-normalized Directional Change（唯一实现，Phase 12.5A）
 *
 * 定义（Phase 12.1-12.4 冻结，用户 2026-08-20 定案）：
 *   STRUCTURAL_SWING := ATR-normalized Directional Change
 *     k            = 1.5（thresholds.structure.dc.k，audit 可覆盖）
 *     confirmWith  = close（收盘反转确认，非 wick）
 *     ATR frozen at extreme（candidate extreme 更新时锁定 extremeATR = atrAt(extremeIdx)，
 *       之后等待 extremePrice - close >= extremeATR × k；绝不用每根 K 的当前 ATR 重算——
 *       防 volatility 扩大导致确认门槛漂移）
 *     严格 confirmedAt / causal：swing 只在 reversal close 达阈值的那根 bar 确认，
 *       confirmedAt = 该 bar closeTime；确认前价格越位不产生 MSS（future-safety）
 *
 * 架构要求（用户 12.5A）：
 *   - 本文件是 buildDcSwings 的**唯一实现**；audit（stats/directionalChangeAudit）、
 *     production replay（replay/replayEngine）、live（live/liveEngine）全部调用同一实现，
 *     禁止任何"看起来一样"的复制算法。
 *   - 有状态：Live 用 warmup（历史逐根 step 重建 state）→ 每根 5m 增量 step；
 *     重启重放与连续运行用同一 step 函数 → 状态天然一致。
 *
 * MSS reference 池（12.5A 只换这一处）：
 *   stepDcState 确认的 swing → packageForMss（confirmedAt 转时间戳 + metadata.index，
 *     classifyMssReference 依赖 metadata.index 算 referenceAgeBars/wasLatestOpposingSwing）→
 *     加入 refPool → detectMss([candle], refPool, {consumedRefs: dc 独立})。
 *   Liquidity Registry / EQL/EQH / Sweep / Draw / Opportunity / Alert 全部不动。
 */
var thresholds = require('../config/thresholds');

/**
 * 配置：thresholds.structure.dc 优先，opts 显式覆盖（audit 用）。
 */
function cfgOf(opts) {
    var o = opts || {};
    var s = (thresholds.structure && thresholds.structure.dc) || {};
    return {
        k: o.k !== undefined ? o.k : (s.k !== undefined ? s.k : 1.5),
        atrN: o.atrN !== undefined ? o.atrN : (s.atrN !== undefined ? s.atrN : 14),
        confirmWith: o.confirmWith || s.confirmWith || 'close',
        baseIndex: o.baseIndex !== undefined ? o.baseIndex : 0
    };
}

function trueRange(c, prev) {
    if (!prev) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

/** ATR(N)：截止 upTo（含）前 N 根 True Range 均值 */
function atrAt(candles, upTo, n) {
    var sum = 0;
    var cnt = 0;
    for (var j = upTo; j >= 0 && cnt < n; j--) {
        var c = candles[j];
        if (!c) continue;
        sum += trueRange(c, candles[j - 1]);
        cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
}

/**
 * 创建 DC 状态机。cfg（k/atrN/confirmWith）冻结在 state 内——后续 step 不因调用方参数漂移。
 */
function createDcState(k, opts) {
    var cfg = cfgOf(opts);
    if (k !== undefined) cfg.k = k;
    return {
        cfg: cfg,
        direction: null,     // 'UP'(找 HIGH) | 'DOWN'(找 LOW)
        extremeIdx: -1,      // candidate 最后一次更新的 bar index（全局）
        extremePrice: null,
        extremeATR: 0,       // extreme 时点锁定的 ATR（冻结语义）
        occurredAt: -1,      // candidate 形成时点（= extremeIdx）
        replacements: 0      // 确认前吞掉的 local extreme 数
    };
}

/**
 * 逐根推进 DC 状态机（Live/Replay 共用，唯一实现）。
 * @param {Object} state createDcState 输出
 * @param {Object} candle 已收盘 5m K
 * @param {number} index 全局 bar index
 * @param {Array} candles 截至当前的完整窗口（index 对齐；ATR 需要历史 14 根 TR 均值，
 *   与全量 buildDcSwings 完全同口径 —— 保证 Live 增量与重放重建 parity）
 * @returns {Object|null} 本根确认的 swing（raw：{ direction:'HIGH'|'LOW', price, extremeIndex,
 *   occurredAt, confirmedAt(index), replacements, extremeATR }）或 null
 */
function stepDcState(state, candle, index, candles) {
    var cfg = state.cfg;
    var c = candle;
    if (!c) return null;
    var win = candles || [c];
    if (state.direction === null) {
        // 初始化：以首根 bar 的 high 为起始 candidate（边界 swing 对 90d 统计影响可忽略）
        state.direction = 'UP';
        state.extremeIdx = index;
        state.extremePrice = c.high;
        state.occurredAt = index;
        state.replacements = 0;
        state.extremeATR = atrAt(win, index, cfg.atrN);
        return null;
    }
    if (state.direction === 'UP') {
        if (c.high > state.extremePrice) {
            // candidate 更新：吞掉一个 local extreme，ATR 重新锁定（冻结语义）
            state.extremeIdx = index;
            state.extremePrice = c.high;
            state.occurredAt = index;
            state.replacements++;
            state.extremeATR = atrAt(win, index, cfg.atrN);
            return null;
        }
        var rev = cfg.confirmWith === 'extreme' ? state.extremePrice - c.low : state.extremePrice - c.close;
        if (rev >= state.extremeATR * cfg.k) {
            var sw = {
                direction: 'HIGH',
                price: state.extremePrice,
                extremeIndex: state.extremeIdx,
                occurredAt: state.occurredAt,
                confirmedAt: index,
                replacements: state.replacements,
                extremeATR: state.extremeATR
            };
            state.direction = 'DOWN';
            state.extremeIdx = index;
            state.extremePrice = c.low;
            state.occurredAt = index;
            state.replacements = 0;
            state.extremeATR = atrAt(win, index, cfg.atrN);
            return sw;
        }
        return null;
    }
    // DOWN
    if (c.low < state.extremePrice) {
        state.extremeIdx = index;
        state.extremePrice = c.low;
        state.occurredAt = index;
        state.replacements++;
        state.extremeATR = atrAt(win, index, cfg.atrN);
        return null;
    }
    var rev2 = cfg.confirmWith === 'extreme' ? c.high - state.extremePrice : c.close - state.extremePrice;
    if (rev2 >= state.extremeATR * cfg.k) {
        var sw2 = {
            direction: 'LOW',
            price: state.extremePrice,
            extremeIndex: state.extremeIdx,
            occurredAt: state.occurredAt,
            confirmedAt: index,
            replacements: state.replacements,
            extremeATR: state.extremeATR
        };
        state.direction = 'UP';
        state.extremeIdx = index;
        state.extremePrice = c.high;
        state.occurredAt = index;
        state.replacements = 0;
        state.extremeATR = atrAt(win, index, cfg.atrN);
        return sw2;
    }
    return null;
}

/**
 * 全量/重放构建 DC swings（init + 逐根 step，与 Live 增量同一实现）。
 * @param {Array} candles 已收盘 5m K 数组
 * @param {number} [k] ATR 倍率（缺省用 thresholds.structure.dc.k）
 * @param {Object} [opts] { atrN, confirmWith, baseIndex }
 * @returns {Array} raw swings [{ direction, price, extremeIndex, occurredAt, confirmedAt, replacements, extremeATR }]
 */
function buildDcSwings(candles, k, opts) {
    var state = createDcState(k, opts);
    var base = (opts && opts.baseIndex) || 0;
    var out = [];
    for (var i = 0; i < (candles || []).length; i++) {
        var sw = stepDcState(state, candles[i], base + i, candles);
        if (sw) out.push(sw);
    }
    return out;
}

/**
 * raw DC swing → mssDetector 兼容格式（MSS reference 池成员）。
 * 【必须】confirmedAt 转时间戳（candles[confirmedAt].closeTime）——detectMss 的 evalTime 是
 * candle.closeTime（ms），不转换则 future-safety 检查（confirmedAt <= evalTime）失效。
 * 【必须】metadata.index = extremeIndex —— classifyMssReference 依赖它算
 * referenceAgeBars/wasLatestOpposingSwing（缺失 → 永不到 PROTECTED_SWING → 无 HIGH）。
 */
function packageForMss(raw, symbol, timeframe, candles) {
    var type = raw.direction === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    var confTs = candles && candles[raw.confirmedAt] ? candles[raw.confirmedAt].closeTime : raw.confirmedAt;
    return {
        id: (symbol || 'X') + ':DC:' + type + ':' + confTs + ':' + raw.extremeIndex,
        symbol: symbol || 'X',
        timeframe: timeframe || '5m',
        type: type,
        side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: raw.price,
        confirmedAt: confTs,
        metadata: {
            source: 'dc',
            dcK: raw.cfgK !== undefined ? raw.cfgK : undefined,
            replacements: raw.replacements,
            extremeIndex: raw.extremeIndex,
            occurredAt: raw.occurredAt,
            extremeATR: raw.extremeATR,
            index: raw.extremeIndex
        }
    };
}

module.exports = {
    createDcState: createDcState,
    stepDcState: stepDcState,
    buildDcSwings: buildDcSwings,
    packageForMss: packageForMss,
    atrAt: atrAt,
    cfgOf: cfgOf
};
