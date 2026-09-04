/** Presentation-only formatter for RANGE_OBJECT_V1 confirmations. */
function decimalsFromTick(tickSize, fallback) {
    if (tickSize !== null && tickSize !== undefined && Number(tickSize) > 0) {
        var text = Number(tickSize).toFixed(12).replace(/0+$/, '');
        var dot = text.indexOf('.');
        return dot === -1 ? 0 : text.length - dot - 1;
    }
    return fallback !== null && fallback !== undefined ? Number(fallback) : 8;
}

function formatPrice(value, exchangeInfo) {
    if (value === null || value === undefined) return '-';
    var info = exchangeInfo || {};
    return Number(value).toFixed(decimalsFromTick(info.tickSize, info.pricePrecision));
}

function buildRangeConfirmationMessage(event, options) {
    var opts = options || {};
    var fmtTime = opts.formatTime || function (value) { return new Date(value).toISOString(); };
    var fmtPrice = opts.formatPrice || function (value) { return formatPrice(value, opts.exchangeInfo); };
    var keyword = opts.keyword ? opts.keyword + ' · ' : '';
    return [
        '📦 ' + keyword + event.symbol + ' 5m 震荡区间确认',
        '',
        '区间: ' + fmtPrice(event.lower) + ' - ' + fmtPrice(event.upper),
        '中轴: ' + fmtPrice(event.midpoint),
        '宽度: ' + Number(event.widthPct).toFixed(4) + '%',
        '',
        '开始形成: ' + fmtTime(event.visualStartAt),
        '确认时间: ' + fmtTime(event.confirmedAt),
        '',
        '状态: ACTIVE',
        '参数: L24 / ATR500 / 1.0',
        '版本: RANGE_OBJECT_V1',
        '',
        '观察: 等待价格离开区间'
    ].join('\n');
}

module.exports = {
    decimalsFromTick: decimalsFromTick,
    formatPrice: formatPrice,
    buildRangeConfirmationMessage: buildRangeConfirmationMessage
};
