/**
 * UTC 时间工具（纯函数，全部基于 UTC）
 *
 * 核心原则：
 * - 所有日期边界都按 UTC 计算（Binance 也以 UTC 为准）
 * - 日：00:00:00.000 UTC → 次日 00:00:00.000 UTC
 * - 周：Monday 00:00:00.000 UTC → 下周一 00:00:00.000 UTC
 * - 历史回放时，任何“当前”概念都来自外部传入的 evaluationTime
 */

var DAY_MS = 86400000;

/**
 * 某时刻所在的 UTC 自然日 00:00:00.000
 */
function startOfDayUTC(ms) {
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 某时刻所在的 UTC 自然周的周一 00:00:00.000
 */
function startOfWeekUTC(ms) {
    var d = new Date(ms);
    var weekday = d.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
    var daysSinceMonday = (weekday + 6) % 7;
    var monday = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday)
    );
    return monday.getTime();
}

/**
 * 某时刻所在的 UTC 自然月 1 号 00:00:00.000
 */
function startOfMonthUTC(ms) {
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * 上一完整 UTC 自然月的 1 号 00:00:00.000
 * （1 月时自动跨到上一年 12 月，Date.UTC 负月份自动进位）
 */
function previousCompleteMonthStart(ms) {
    var d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}

/**
 * 格式化 UTC 月份为 YYYY-MM
 */
function formatMonthUTC(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

/**
 * 格式化 UTC 日期为 YYYY-MM-DD
 */
function formatDateUTC(ms) {
    var d = new Date(ms);
    var y = d.getUTCFullYear();
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return y + '-' + pad2(m) + '-' + pad2(day);
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

module.exports = {
    DAY_MS: DAY_MS,
    WEEK_MS: 7 * DAY_MS,
    startOfDayUTC: startOfDayUTC,
    startOfWeekUTC: startOfWeekUTC,
    startOfMonthUTC: startOfMonthUTC,
    previousCompleteMonthStart: previousCompleteMonthStart,
    formatDateUTC: formatDateUTC,
    formatMonthUTC: formatMonthUTC
};
