'use strict';

/**
 * WATCH Notification Presentation V1.
 *
 * Pure presentation adapter. It reads an already-created WATCH and never
 * creates, filters, ranks, mutates, or feeds evidence back into production.
 */

var ENUM_ZH = {
    BULLISH: '看多', BEARISH: '看空', NEUTRAL: '中性',
    HIGH: '高置信度', MEDIUM: '中等置信度', LOW: '低置信度',
    MATCH: '方向一致', OPPOSITE: '方向相反', UNKNOWN: '未知',
    BYPASSED: '未参与判断', NOT_APPLICABLE: '不适用', VALID: '有效',
    EXPLOSIVE: '强势爆发', STRONG: '强', NORMAL: '常规', WEAK: '弱',
    LOCAL: '局部结构', INTERNAL: '内部结构', CONTROLLING: '控制结构',
    ACTIVE_PROTECTED: '活跃受保护结构', SUPERSEDED_PROTECTED: '已取代受保护结构',
    FIRST_TOUCH: '首次触及', UNTOUCHED: '尚未触及', PARTIAL: '部分回补',
    FULL: '完全回补', INVALIDATED: '已失效',
    BEFORE_LEG: '位移形成前', INSIDE_LEG: '位移过程中', AFTER_LEG: '位移形成后',
    ACTIVE: '活跃', TOUCHED: '已触及', SWEPT: '已扫取', BROKEN: '已破坏',
    WATCH_WAIT_FVG: '等待 FVG 回踩', WATCH_NO_FVG: '未形成原生 FVG',
    FVG_TOUCHED: 'FVG 已触及', NOTIFIED: '已通知', EXPIRED: '已过期'
};

function raw(value) {
    return value === null || value === undefined || value === '' ? null : String(value);
}

function translate(value) {
    var key = raw(value);
    if (!key) return '-';
    return (ENUM_ZH[key] || '未知状态') + '（' + key + '）';
}

function formatPrice(value, formatter) {
    if (value === null || value === undefined || typeof value !== 'number' || !isFinite(value)) return '-';
    return formatter ? formatter(value) : String(value);
}

function liquiditySide(primary, evidence) {
    var side = evidence && evidence.liquidity && evidence.liquidity.liquiditySide || primary && primary.side;
    if (side === 'BSL' || side === 'SSL') return side;
    var type = primary && primary.sourceType;
    if (type === 'SWING_HIGH' || type === 'EQH') return 'BSL';
    if (type === 'SWING_LOW' || type === 'EQL') return 'SSL';
    return null;
}

function sourceLabel(primary) {
    if (!primary) return '-';
    var type = primary.sourceType || 'UNKNOWN';
    var labels = { SWING_LOW:'Swing Low', SWING_HIGH:'Swing High', EQH:'Equal High', EQL:'Equal Low' };
    var timeframe = primary.sourceTimeframe && primary.sourceTimeframe !== 'UNKNOWN' ? primary.sourceTimeframe + ' ' : '';
    return timeframe + (labels[type] || type) + '（' + type + '）';
}

function evidencePrimary(watch) {
    var envelope = watch && watch.liquidityEvidenceV1;
    var legacy = watch && watch.liquidityTaken && watch.liquidityTaken.primary;
    if (!envelope) return legacy || null;
    var current = envelope.currentPrimary || {};
    var candidates = envelope.candidates || envelope.allCandidates || [];
    return candidates.filter(function (candidate) {
        return candidate.sweepEventId === current.sweepEventId && candidate.sourceId === current.sourceId;
    })[0] || legacy || null;
}

function candidateCount(watch) {
    var evidence = watch && watch.liquidityEvidenceV1;
    if (evidence) return (evidence.candidates || evidence.allCandidates || []).length;
    return watch && watch.liquidityTaken && (watch.liquidityTaken.allCandidates || []).length || 0;
}

function currentPrimarySemantic(watch) {
    var current = watch && watch.liquidityEvidenceV1 && watch.liquidityEvidenceV1.currentPrimary;
    return current && current.selectionSemantic || 'CURRENT_PRODUCTION_RECENCY_HEURISTIC';
}

function biasView(watch) {
    var evidenceBias = watch && watch.liquidityEvidenceV1 && watch.liquidityEvidenceV1.bias;
    var legacy = watch && watch.dailyBias;
    return {
        direction: evidenceBias && evidenceBias.direction || legacy && legacy.bias || 'UNKNOWN',
        confidence: legacy && legacy.confidence || null,
        alignment: evidenceBias && evidenceBias.alignment || legacy && legacy.alignment || 'UNKNOWN',
        status: evidenceBias && evidenceBias.status || legacy && legacy.status || 'UNKNOWN'
    };
}

function directionInfo(direction) {
    return direction === 'BEARISH'
        ? { side:'SHORT', title:'做空机会观察', liquidity:'上方买方流动性', displacement:'空头位移', move:'向下', mss:'Bearish MSS' }
        : { side:'LONG', title:'做多机会观察', liquidity:'下方卖方流动性', displacement:'多头位移', move:'向上', mss:'Bullish MSS' };
}

function buildSummary(watch, primary, bias, info) {
    var sentences = [];
    var hasLiquidity = !!primary;
    var hasDisplacement = !!(watch && watch.displacement);
    var hasMss = !!(watch && watch.mss && watch.mss.exists);
    if (hasLiquidity || hasDisplacement || hasMss) {
        var sentence = hasLiquidity ? info.liquidity + '已被扫取' : '';
        if (hasDisplacement) sentence += (sentence ? '，随后' : '') + '出现' + info.displacement;
        if (hasMss) sentence += (sentence ? '并' : '') + '确认 ' + info.mss;
        sentences.push(sentence + '。');
    } else {
        sentences.push('当前 WATCH 的结构证据未完整提供。');
    }
    if (bias.alignment === 'MATCH') sentences.push('当前 4H Bias 与本次' + info.title.replace('机会观察','方向') + '一致。');
    else if (bias.alignment === 'OPPOSITE') sentences.push('当前 4H Bias 与本次观察方向相反。');
    sentences.push('目前处于 WATCH 阶段，继续观察 FVG 回踩、价格接受与后续结构延续。');
    return sentences;
}

function build(watch, currentPrice, options) {
    var opts = options || {};
    var fmtPrice = opts.formatPrice;
    var info = directionInfo(watch && watch.direction);
    var primary = evidencePrimary(watch);
    var evidence = watch && watch.liquidityEvidenceV1;
    var side = liquiditySide(primary, evidence);
    var count = candidateCount(watch);
    var displacement = watch && watch.displacement;
    var mss = watch && watch.mss;
    var fvg = watch && watch.nativeFvg;
    var bias = biasView(watch);
    var lines = [
        '🔔 ' + (watch && watch.symbol || 'UNKNOWN') + ' · ' + info.title,
        '',
        '当前状态：' + info.side + ' WATCH 已触发',
        '系统状态：' + translate(watch && watch.state),
        '',
        '💧 流动性扫取'
    ];

    if (primary) {
        lines.push('检测到' + info.liquidity + (side ? '（' + side + '）' : '') + '被扫取');
        lines.push('来源：' + sourceLabel(primary) + ' @ ' + formatPrice(primary.sourcePrice, fmtPrice));
        lines.push('时机：' + translate(primary.relation || 'BEFORE_LEG'));
        if (evidence && evidence.liquidity) lines.push('当前流动性状态：' + translate(evidence.liquidity.lifecycleStatus));
        if (count > 1) {
            lines.push('候选流动性：共 ' + count + ' 个（另有 ' + (count - 1) + ' 个合法候选）');
            lines.push('当前主显示：' + sourceLabel(primary) + ' @ ' + formatPrice(primary.sourcePrice, fmtPrice));
            lines.push('选择方式：最近方向匹配扫取（' + currentPrimarySemantic(watch) + '）');
        }
    } else {
        lines.push('未提供');
    }

    lines.push('', '⚡ ' + info.displacement);
    if (displacement) {
        lines.push('方向：' + info.move + '（' + (displacement.direction || watch.direction || 'UNKNOWN') + '）');
        lines.push('强度：' + translate(displacement.quality));
        lines.push('位移区间：' + (displacement.startIndex === null || displacement.startIndex === undefined ? '-' : displacement.startIndex) +
            ' → ' + (displacement.endIndex === null || displacement.endIndex === undefined ? '-' : displacement.endIndex));
    } else lines.push('未提供');

    lines.push('', '📐 市场结构转换（MSS）');
    if (mss && mss.exists) {
        lines.push('方向：' + translate(mss.direction));
        lines.push('结构参考位：' + formatPrice(mss.referencePrice, fmtPrice));
        lines.push('结构级别：' + translate(mss.referenceRole));
        lines.push('Protected Break：' + (mss.protectedBreak === true ? '是' : mss.protectedBreak === false ? '否' : '-'));
    } else lines.push('未提供');

    lines.push('', '🟦 原生 FVG');
    if (fvg) {
        lines.push('区间：' + formatPrice(fvg.low, fmtPrice) + ' – ' + formatPrice(fvg.high, fmtPrice));
        lines.push('中点：' + formatPrice(fvg.midpoint, fmtPrice));
        lines.push('当前价格：' + formatPrice(currentPrice, fmtPrice));
        lines.push('触及状态：' + translate(watch.touchStatus || fvg.touchStatus || 'FIRST_TOUCH'));
    } else lines.push('未提供');

    lines.push('', '🧭 4H Daily Bias');
    if (bias.direction === 'UNKNOWN' && (bias.status === 'UNKNOWN' || bias.status === 'BYPASSED')) {
        lines.push('4H Daily Bias：未知 / ' + (bias.status === 'BYPASSED' ? '未参与判断（BYPASSED）' : '未知（UNKNOWN）'));
    } else {
        lines.push(translate(bias.direction) + ' / ' + (bias.confidence ? translate(bias.confidence) : '-'));
        lines.push('方向一致性：' + translate(bias.alignment));
        lines.push('Bias 状态：' + translate(bias.status));
    }

    lines.push('', '📌 当前结构解读');
    buildSummary(watch, primary, bias, info).forEach(function (sentence) { lines.push(sentence); });
    lines.push('', '仅用于市场结构监测，不构成自动交易或投资指令。');
    return lines.join('\n');
}

module.exports = {
    ENUM_ZH: ENUM_ZH,
    translate: translate,
    liquiditySide: liquiditySide,
    sourceLabel: sourceLabel,
    evidencePrimary: evidencePrimary,
    candidateCount: candidateCount,
    biasView: biasView,
    directionInfo: directionInfo,
    buildSummary: buildSummary,
    build: build
};
