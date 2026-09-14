'use strict';

var eqSourceContextV1 = require('../live/eqSourceContextV1');
var biasContext = require('./4hBiasContext');

function fallbackPrice(value) {
    if (value === null || value === undefined) return '-';
    return String(value);
}

function fallbackTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '-';
    return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' (UTC+8)';
}

function sourceLine(label, source, time, price) {
    if (!source || typeof source.occurredAt !== 'number') return label + ': -';
    var value = time(source.occurredAt);
    if (source.price !== null && source.price !== undefined) value += ' @ ' + price(source.price);
    return label + ': ' + value;
}

function sourceContextLines(event, time, price) {
    var context = event.eqSourceContext;
    if (!context || context.status !== 'AVAILABLE') {
        return ['EQ Source Context: UNAVAILABLE', 'EQ确认: ' + time(event.eqConfirmedAt)];
    }
    var partners = eqSourceContextV1.historicalPartnersForDisplay(context);
    var lines = [
        'EQ Source Context:',
        sourceLine('Current Point', context.currentPivot, time, price),
        'Historical Partners: ' + partners.length
    ];
    partners.forEach(function (partner, index) {
        lines.push(sourceLine('Partner #' + (index + 1), partner, time, price));
    });
    lines.push('EQ确认: ' + time(event.eqConfirmedAt));
    return lines;
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
    var lines = [
        keyword + ' · ' + icon + ' ' + event.symbol + ' ' + event.liquidityType + ' → ' + direction + ' FVG #' + event.ordinal,
        '',
        'Liquidity Type: ' + event.liquidityType,
        'Liquidity Price: ' + price(event.liquidityPrice),
        ''
    ];
    lines = lines.concat(sourceContextLines(event, time, price));
    lines.push('', 'Expected Direction: ' + event.expectedDirection, '');
    lines = lines.concat(biasContext.lines(event.current4hBias));
    lines.push(
        '',
        'FVG Ordinal: ' + event.ordinal,
        'FVG Direction: ' + event.rawFvg.direction,
        'FVG Low: ' + price(event.rawFvg.low),
        'FVG High: ' + price(event.rawFvg.high),
        'FVG确认: ' + time(event.rawFvg.confirmedAt),
        ''
    );
    if (event.eqFvgSemantic) {
        var semantic = event.eqFvgSemantic;
        lines.push('EQ→FVG Semantic: ' + (semantic.decision ?
            semantic.decision.association + ' / ' + semantic.decision.confidence : 'UNAVAILABLE'));
        lines.push('Reason: ' + (semantic.decision ? semantic.decision.primaryReason :
            (semantic.errorCode || 'EQ_FVG_SEMANTIC_UNAVAILABLE')));
        lines.push('Semantic Gate: ' + semantic.gateResult);
        if (semantic.gateResult === 'BLOCK') lines.push('Gate reason: ' + semantic.gateReason);
        lines.push('Semantic Version: ' + semantic.semanticVersion, '');
    }
    lines.push(
        '状态: ' + status,
        '',
        '仅为市场结构监测，不是自动交易指令。'
    );
    return lines.join('\n');
}

module.exports = {
    build: build,
    sourceContextLines: sourceContextLines,
    biasLines: biasContext.lines
};
