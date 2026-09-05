'use strict';

function fallbackPrice(value) {
    if (value === null || value === undefined) return '-';
    return String(value);
}

function fallbackTime(ms) {
    return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' (UTC+8)';
}

function build(event, options) {
    var opts = options || {};
    var price = opts.formatPrice || fallbackPrice;
    var time = opts.formatTime || fallbackTime;
    var keyword = opts.keyword || '检测';
    var isBull = event.rawFvg.direction === 'BULLISH';
    var icon = isBull ? '🟢' : '🔴';
    var direction = isBull ? 'Bullish' : 'Bearish';
    var status = event.watchStatusAfterEvent === 'CLOSED' ? 'WATCH完成 / 关闭' : 'WATCH继续';
    return [
        keyword + ' · ' + icon + ' ' + event.symbol + ' ' + event.liquidityType + ' → ' + direction + ' FVG #' + event.ordinal,
        '',
        'Liquidity Type: ' + event.liquidityType,
        'Liquidity Price: ' + price(event.liquidityPrice),
        'Expected Direction: ' + event.expectedDirection,
        'FVG Ordinal: ' + event.ordinal,
        'FVG Direction: ' + event.rawFvg.direction,
        'FVG Low: ' + price(event.rawFvg.low),
        'FVG High: ' + price(event.rawFvg.high),
        'EQ确认: ' + time(event.eqConfirmedAt),
        'FVG确认: ' + time(event.rawFvg.confirmedAt),
        '状态: ' + status,
        '',
        '仅为市场结构监测，不是自动交易指令。'
    ].join('\n');
}

module.exports = { build: build };
