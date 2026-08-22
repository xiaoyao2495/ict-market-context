/**
 * auditPivots.js —— Phase-2 审计专用 4H Pivot Detector（仅用于 DeepSeek A/B 实验）
 *
 * 重要定位：
 * - 这是给 DeepSeek 提供"已确认存在的 Swing 候选 Universe"的确定性工具，
 *   绝不是最终 ICT Structural Swing 定义。
 * - Pivot ≠ Structural Swing。模型仍需自行判断 internal / structural / protected。
 * - 不修改、不读取任何 production engine（Opportunity / Alert / engine / stats）。
 * - 纯函数、可复现、无外部依赖。
 *
 * 定义（用户指定，临时口径）：
 *   leftBars = 2, rightBars = 2
 *   Pivot High: high[i] > high[i-2..i-1] 且 high[i] > high[i+1..i+2]
 *   Pivot Low : low[i]  < low[i-2..i-1]  且 low[i]  < low[i+1..i+2]
 *
 * 时间纪律（防未来泄漏）：
 *   occurredAt   = candles[i].openTime   （该 pivot candle 开盘时刻）
 *   confirmedAt  = candles[i+rightBars].closeTime （右侧第 rightBars 根收盘时刻）
 *   —— 只有 confirmedAt <= evaluationTime 的 pivot 才允许进入候选集，
 *      因为 evaluationTime 之后发生的"确认"对模型是不可见的。
 */

function detectPivots(candles, evalIdx, opts) {
    var o = opts || {};
    var left = o.left != null ? o.left : 2;
    var right = o.right != null ? o.right : 2;
    var window = o.window != null ? o.window : 120;

    if (evalIdx == null || evalIdx < 0 || evalIdx >= candles.length) {
        throw new Error('detectPivots: evalIdx 越界 ' + evalIdx);
    }
    var evaluationTime = candles[evalIdx].closeTime;

    // 候选扫描区间：以 evalIdx 为右界，向前 window-1 根（与 buildCandleSlice 一致）
    var start = evalIdx - (window - 1);
    if (start < 0) start = 0;
    var end = evalIdx; // 含 evalIdx 本身

    var highs = [];
    var lows = [];

    for (var i = start; i <= end; i++) {
        // 需要左右各 left/right 根存在
        if (i - left < 0) continue;
        if (i + right >= candles.length) continue;

        var c = candles[i];
        var isHigh = true;
        var isLow = true;

        for (var k = 1; k <= left; k++) {
            if (candles[i - k].high >= c.high) isHigh = false;
            if (candles[i - k].low <= c.low) isLow = false;
        }
        for (var j = 1; j <= right; j++) {
            if (candles[i + j].high >= c.high) isHigh = false;
            if (candles[i + j].low <= c.low) isLow = false;
        }

        if (isHigh) {
            var confirmHi = candles[i + right].closeTime;
            if (confirmHi <= evaluationTime) {
                highs.push({
                    price: c.high,
                    occurredAt: new Date(c.openTime).toISOString(),
                    confirmedAt: new Date(confirmHi).toISOString(),
                    // 内部辅助字段（不发给模型，仅供复核）：candle 索引
                    _idx: i
                });
            }
        }
        if (isLow) {
            var confirmLo = candles[i + right].closeTime;
            if (confirmLo <= evaluationTime) {
                lows.push({
                    price: c.low,
                    occurredAt: new Date(c.openTime).toISOString(),
                    confirmedAt: new Date(confirmLo).toISOString(),
                    _idx: i
                });
            }
        }
    }

    // 按 occurredAt 升序
    highs.sort(function (a, b) { return a.price - b.price; }); // 先按价格（保持简单），复核时再排时间亦可
    lows.sort(function (a, b) { return a.price - b.price; });
    // 改为按时间升序（occurredAt），更符合 narrative 顺序
    highs.sort(function (a, b) { return Date.parse(a.occurredAt) - Date.parse(b.occurredAt); });
    lows.sort(function (a, b) { return Date.parse(a.occurredAt) - Date.parse(b.occurredAt); });

    return {
        highs: highs,
        lows: lows,
        evaluationTime: evaluationTime,
        params: { left: left, right: right, window: window }
    };
}

module.exports = {
    detectPivots: detectPivots
};
