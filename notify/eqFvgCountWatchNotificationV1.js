'use strict';

var eqSourceContextV1 = require('../live/eqSourceContextV1');
var biasContext = require('./4hBiasContext');
var notificationTime = require('./notificationTimeV1');

function fallbackPrice(value) {
    if (value === null || value === undefined) return '-';
    return String(value);
}

function fallbackTime(ms) {
    return notificationTime.formatNotificationTimeUtc8(ms);
}

function sourceLine(label, source, time, price) {
    if (!source || typeof source.occurredAt !== 'number') return label + ': -';
    var value = time(source.occurredAt);
    if (source.price !== null && source.price !== undefined) value += ' @ ' + price(source.price);
    return label + ': ' + value;
}

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §55–§56.
 *
 * Renders the frozen significance of one EQ historical anchor. Purely
 * presentational: every value shown is copied verbatim from an immutable
 * decision that was already frozen at (or before) the anchor's confirmedAt.
 * Nothing here re-decides, re-orders, or re-prices anything.
 */
function turningSignificanceLines(record) {
    if (!record) {
        return ['  Turning Significance: UNAVAILABLE（no frozen decision; fail-closed → 不作为 anchor）'];
    }
    var lines = ['  Turning Significance: ' + (record.significance || '-') + ' / ' + (record.confidence || '-'),
        '  Turning Reason: ' + (record.primaryReason || '-')];
    if (record.eligible === true) {
        lines.push('  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR');
    } else {
        lines.push('  Turning Status: ' + (record.gateReason || record.errorCode || 'NOT_ELIGIBLE'));
    }
    lines.push('  Turning Semantic Version: ' + (record.semanticVersion || '-'));
    return lines;
}

function anchorUniverseLine(filter) {
    if (filter === 'APPLIED') return 'Anchor Universe Filter: APPLIED（historical anchor universe 已按语义结果收窄）';
    if (filter === 'DISABLED') return 'Anchor Universe Filter: DISABLED（legacy Dynamic-D universe；语义结果仅作 shadow 记录）';
    return null;
}

function sourceContextLines(event, time, price) {
    var context = event.eqSourceContext;
    if (!context || context.status !== 'AVAILABLE') {
        return ['EQ Source Context: UNAVAILABLE', 'EQ确认: ' + time(event.eqConfirmedAt)];
    }
    var partners = eqSourceContextV1.historicalPartnersForDisplay(context);
    var significance = event.eqHistoricalAnchorSignificance || [];
    var byId = {};
    significance.forEach(function (record) {
        if (record && record.turningPointId != null) byId[String(record.turningPointId)] = record;
    });
    var lines = [
        'EQ Source Context:',
        sourceLine('Current Point', context.currentPivot, time, price),
        'Historical Partners: ' + partners.length
    ];
    partners.forEach(function (partner, index) {
        lines.push(sourceLine('Partner #' + (index + 1), partner, time, price));
        lines = lines.concat(turningSignificanceLines(byId[String(partner.id)] || null));
    });
    var universe = anchorUniverseLine(event.anchorUniverseFilter);
    if (universe) lines.push(universe);
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
    turningSignificanceLines: turningSignificanceLines,
    anchorUniverseLine: anchorUniverseLine,
    biasLines: biasContext.lines
};
