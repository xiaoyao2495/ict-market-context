/**
 * Phase 12.2 — ATR Directional Change Structural Swing Shadow
 *
 * 背景（用户 2026-08-20）：Phase 12.1 修正后结论——2-2 LOCAL_PIVOT 作为局部转折检测器没问题，
 * 但 90d 有 75.1% 的 pivot 最终被附近更极端同向 pivot 包含（层级冗余），不能继续把
 * LOCAL_PIVOT 等价于 STRUCTURAL_SWING。Phase 12.2 不再给 2-2 打补丁（不用 nested=false +
 * separation>=12 + prominence 规则过滤器），直接 shadow 一套 ATR Directional Change 结构，
 * 让结构定义天然消掉 nested pivot。
 *
 * 算法（在线，纯价格结构，不看 HIGH/不碰 MSS/Liquidity）：
 *   状态方向交替寻找 Swing：
 *     UP   ：candidateHigh = 当前最高；每根 bar high 更高 → candidate 更新（吞掉 local extreme）
 *            直到 extremePrice - close >= extremeATR × k → 确认 STRUCTURAL_SWING_HIGH，翻 DOWN
 *     DOWN ：对称（candidateLow / close - extremePrice）
 *
 * 【ATR 冻结语义（用户要求，防参数漂移）】
 *   threshold = ATR_at_extreme × k。每次 candidate extreme 更新时重新锁定：
 *     candidateHigh 更新 → extremePrice 更新 → extremeATR = atrAt(extremeIdx) 更新
 *   之后等待阶段 ATR 保持该锁定值，绝不用每根 K 的当前 ATR 重算——
 *   否则极值后 volatility 扩大会让确认门槛越来越远，Swing 定义被波动状态移动。
 *
 * 每档输出指标（用户表）：
 *   n / swingsPerHour       降噪程度、是否过密
 *   medianBarsPerLeg        一个结构平均持续多久
 *   medianLegRangeAtr       是否形成有效 price leg
 *   alternationRate         H→L→H→L 稳定率（DC 天然交替，作 sanity）
 *   medianConfirmDelay      occurredAt → confirmedAt 等多久
 *   replacements           一个最终 Swing 确认前吞掉多少 local extremes（分布）
 *
 * 纯诊断：pivotDetector / swingLiquidity / MSS / EQL / 通知全部零改动。
 */
var DEFAULT_ATR_N = 14;

function cfgOf(opts) {
    var o = opts || {};
    return {
        atrN: o.atrN !== undefined ? o.atrN : DEFAULT_ATR_N,
        confirmWith: o.confirmWith || 'close' // 'close'（默认，wick 噪声小）| 'extreme'
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

function mkSwing(direction, price, extremeIndex, occurredAt, confirmedAt, replacements, extremeATR) {
    return {
        direction: direction,       // 'HIGH' | 'LOW'
        price: price,
        extremeIndex: extremeIndex, // candidate 最后一次更新的 bar
        occurredAt: occurredAt,     // candidate 形成时点（= extremeIndex）
        confirmedAt: confirmedAt,   // 反转确认的 bar
        replacements: replacements, // 确认前吞掉的 local extreme 数
        extremeATR: extremeATR      // extreme 时点锁定的 ATR（冻结语义）
    };
}

/**
 * ATR Directional Change 构建器（在线扫描，无未来泄漏）。
 * @param {Array} candles
 * @param {number} k ATR 倍率（0.5 / 0.75 / 1.0 / 1.5 / 2.0）
 * @param {Object} [opts] { atrN, confirmWith }
 * @returns {Array} 已确认 swings（末段未确认的 candidate 不输出）
 */
function buildDcSwings(candles, k, opts) {
    var cfg = cfgOf(opts);
    var swings = [];
    var dir = null;            // 'UP'(找 HIGH) | 'DOWN'(找 LOW)
    var extremeIdx = -1;
    var extremePrice = null;
    var extremeATR = 0;
    var occurredAt = -1;
    var replacements = 0;
    var len = candles ? candles.length : 0;

    for (var i = 0; i < len; i++) {
        var c = candles[i];
        if (!c) continue;
        if (dir === null) {
            // 初始化：以首根 bar 的 high 为起始 candidate（边界 swing 对 90d 统计影响可忽略）
            dir = 'UP';
            extremeIdx = i;
            extremePrice = c.high;
            occurredAt = i;
            replacements = 0;
            extremeATR = atrAt(candles, i, cfg.atrN);
            continue;
        }
        if (dir === 'UP') {
            if (c.high > extremePrice) {
                // candidate 更新：吞掉一个 local extreme，ATR 重新锁定
                extremeIdx = i;
                extremePrice = c.high;
                occurredAt = i;
                replacements++;
                extremeATR = atrAt(candles, i, cfg.atrN);
            } else {
                var rev = cfg.confirmWith === 'extreme' ? extremePrice - c.low : extremePrice - c.close;
                if (rev >= extremeATR * k) {
                    swings.push(mkSwing('HIGH', extremePrice, extremeIdx, occurredAt, i, replacements, extremeATR));
                    dir = 'DOWN';
                    extremeIdx = i;
                    extremePrice = c.low;
                    occurredAt = i;
                    replacements = 0;
                    extremeATR = atrAt(candles, i, cfg.atrN);
                }
            }
        } else { // DOWN
            if (c.low < extremePrice) {
                extremeIdx = i;
                extremePrice = c.low;
                occurredAt = i;
                replacements++;
                extremeATR = atrAt(candles, i, cfg.atrN);
            } else {
                var rev2 = cfg.confirmWith === 'extreme' ? c.high - extremePrice : c.close - extremePrice;
                if (rev2 >= extremeATR * k) {
                    swings.push(mkSwing('LOW', extremePrice, extremeIdx, occurredAt, i, replacements, extremeATR));
                    dir = 'UP';
                    extremeIdx = i;
                    extremePrice = c.high;
                    occurredAt = i;
                    replacements = 0;
                    extremeATR = atrAt(candles, i, cfg.atrN);
                }
            }
        }
    }
    return swings;
}

function medianSorted(arr) {
    if (arr.length === 0) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    if (a.length % 2 === 1) return a[mid];
    return (a[mid - 1] + a[mid]) / 2;
}
function mean(arr) {
    if (arr.length === 0) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}
function bucketReps(r) {
    if (r <= 1) return String(r);
    if (r <= 3) return '2-3';
    return '4+';
}

/**
 * 单档统计。
 */
function computeStats(swings, k, bars, cfg) {
    var n = swings.length;
    var legBars = [];
    var legRangeAtr = [];
    var delays = [];
    var reps = [];
    var repBuckets = {};
    var sameSide = 0;

    for (var i = 0; i < n; i++) {
        var s = swings[i];
        delays.push(s.confirmedAt - s.occurredAt);
        reps.push(s.replacements);
        var b = bucketReps(s.replacements);
        repBuckets[b] = (repBuckets[b] || 0) + 1;
        if (i < n - 1) {
            var s1 = swings[i + 1];
            legBars.push(s1.extremeIndex - s.extremeIndex);
            var avgAtr = (s.extremeATR + s1.extremeATR) / 2;
            if (avgAtr > 0) legRangeAtr.push(Math.abs(s1.price - s.price) / avgAtr);
            if (s1.direction === s.direction) sameSide++;
        }
    }
    var alternation = n >= 2 ? (n - 1 - sameSide) / (n - 1) : 1;
    return {
        k: k,
        n: n,
        swingsPerHour: bars > 0 ? n / (bars / 12) : 0,
        medianBarsPerLeg: medianSorted(legBars),
        medianLegRangeAtr: medianSorted(legRangeAtr),
        alternationRate: alternation,
        medianConfirmDelay: medianSorted(delays),
        delayMean: mean(delays),
        replacementBuckets: repBuckets,
        replacementMean: mean(reps),
        replacementMedian: medianSorted(reps)
    };
}

/**
 * 多档 ATR Directional Change 审计。
 * @param {Array} candles
 * @param {Array} ks [0.5, 0.75, 1.0, 1.5, 2.0]
 * @param {Object} [opts]
 * @returns {Array} 每档 stats
 */
function auditDc(candles, ks, opts) {
    var bars = candles ? candles.length : 0;
    return (ks || []).map(function (k) {
        return computeStats(buildDcSwings(candles, k, opts), k, bars, cfgOf(opts));
    });
}

module.exports = {
    buildDcSwings: buildDcSwings,
    auditDc: auditDc,
    computeStats: computeStats,
    atrAt: atrAt,
    cfgOf: cfgOf
};
