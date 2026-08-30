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
var sweepContextPresentationV1 = require('./sweepContextPresentationV1');

var BEIJING_TIMEZONE = 'Asia/Shanghai';
var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
var SOURCE_ZH = {
    NEW_YORK_HIGH: '纽约时段高点', NEW_YORK_LOW: '纽约时段低点',
    LONDON_HIGH: '伦敦时段高点', LONDON_LOW: '伦敦时段低点',
    ASIA_HIGH: '亚洲时段高点', ASIA_LOW: '亚洲时段低点',
    SESSION_HIGH: '时段高点', SESSION_LOW: '时段低点',
    SWING_HIGH: '5m 摆动高点', SWING_LOW: '5m 摆动低点',
    PDH: '前一日高点', PDL: '前一日低点',
    PWH: '前一周高点', PWL: '前一周低点',
    PMH: '前一月高点', PML: '前一月低点',
    EQH: '等高点', EQL: '等低点'
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
    return SOURCE_ZH[type] ? SOURCE_ZH[type] + '（' + type + '）' : type;
}

function eqMemberLines(primary, formatter) {
    if (!primary || (primary.sourceType !== 'EQH' && primary.sourceType !== 'EQL')) return [];
    var provenance = primary.eqMemberProvenance;
    var asOf = provenance && typeof provenance.asOf === 'number'
        ? provenance.asOf : primary.confirmedAt;
    var members = provenance && provenance.members;
    if (Array.isArray(members) && typeof asOf === 'number') {
        members = members.filter(function (member) {
            var addedAt = member.memberAddedAt === undefined ? member.confirmedAt : member.memberAddedAt;
            return member.confirmedAt <= asOf && addedAt <= asOf;
        });
    }
    if (!Array.isArray(members) || members.length === 0) return ['EQ 构成：信息暂缺'];
    var noun = primary.sourceType === 'EQH' ? '高点' : '低点';
    var displayed = members.slice(0, 6);
    var prices = displayed.map(function (member) {
        return formatPrice(member.price, formatter);
    }).join(' / ');
    var memberTimes = displayed.map(function (member) {
        var occurredAt = typeof member.occurredAt === 'number'
            ? member.occurredAt : member.sourceOpenTime;
        return typeof occurredAt === 'number' && isFinite(occurredAt)
            ? formatBeijingTime(occurredAt) : '-';
    });
    var hasMemberTime = memberTimes.some(function (value) { return value !== '-'; });
    var times = hasMemberTime ? memberTimes.join(' / ') : '信息暂缺';
    if (members.length > 6) prices += ' … 共 ' + members.length + ' 个';
    if (members.length > 6 && hasMemberTime) times += ' … 共 ' + members.length + ' 个';
    return [
        'EQ 构成：' + members.length + ' 个' + noun,
        '构成点位：' + prices,
        '对应时间（北京时间）：' + times
    ];
}

function formatBeijingTime(epochMs) {
    var value = typeof epochMs === 'number' && isFinite(epochMs) ? epochMs : Date.now();
    var text = new Date(value + BEIJING_OFFSET_MS).toISOString();
    return text.slice(5, 10).replace('-', '/') + ' ' + text.slice(11, 16);
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
        ? { side:'SHORT', title:'做空机会观察', liquidity:'上方 BSL', displacement:'空头位移', move:'向下', mss:'Bearish MSS', watchIcon:'🔴' }
        : { side:'LONG', title:'做多机会观察', liquidity:'下方 SSL', displacement:'多头位移', move:'向上', mss:'Bullish MSS', watchIcon:'🟢' };
}

function narrativePresentation(watch, info) {
    var type = watch && watch.observationType;
    if (type === 'NEW') {
        return { icon:'🔔', title:info.title, line:'Narrative：新观察（NEW）' };
    }
    if (type === 'CONTINUATION') {
        return { icon:'🔄', title:info.side === 'SHORT' ? '做空观察更新' : '做多观察更新',
            line:'Narrative：延续观察（CONTINUATION）' };
    }
    if (type === 'REACTIVATION') {
        return { icon:'🔁', title:info.side === 'SHORT' ? '做空观察重新激活' : '做多观察重新激活',
            line:'Narrative：重新激活（REACTIVATION）' };
    }
    return null;
}

function biasIsUnknown(bias) {
    return !bias || bias.direction === 'UNKNOWN' || bias.status === 'UNKNOWN' ||
        bias.status === 'BYPASSED' || bias.status === 'NOT_APPLICABLE';
}

function biasConflict(bias) {
    return !biasIsUnknown(bias) && bias.alignment === 'OPPOSITE';
}

function biasDirectionLine(bias, withPrefix) {
    var icon = bias.direction === 'BULLISH' ? '🟢 ' : bias.direction === 'BEARISH' ? '🔴 ' : '';
    var value = icon + translate(bias.direction) + '/ ' + (bias.confidence ? translate(bias.confidence) : '-');
    return (withPrefix ? '4H Daily Bias：' : '') + value;
}

function buildBiasLines(bias, info, conflict) {
    if (biasIsUnknown(bias)) {
        var status = bias && bias.status || 'UNKNOWN';
        var wording = status === 'BYPASSED' ? '未知 / 未参与判断（BYPASSED）'
            : status === 'NOT_APPLICABLE' ? '未知 / 不适用（NOT_APPLICABLE）'
                : '未知（' + status + '）';
        return ['🧭 4H Daily Bias', '状态：' + wording];
    }
    if (conflict) return [
        '⚠️ 高周期方向冲突',
        biasDirectionLine(bias, true),
        '当前观察：' + info.watchIcon + ' ' + (info.side === 'SHORT' ? '做空' : '做多') + '（' + info.side + '）',
        '方向关系：⚠️ 相反（OPPOSITE）',
        'Bias 状态：' + translate(bias.status)
    ];
    return [
        '🧭 4H Daily Bias',
        biasDirectionLine(bias, false),
        '方向关系：' + (bias.alignment === 'MATCH' ? '✅ 一致（MATCH）' : translate(bias.alignment)),
        'Bias 状态：' + translate(bias.status)
    ];
}

function friendlyWatchState(state) {
    if (state === 'FVG_TOUCHED' || state === 'NOTIFIED') return 'FVG 已首次触及';
    if (state === 'WATCH_WAIT_FVG') return '等待 FVG 回踩';
    if (state === 'WATCH_NO_FVG') return '尚未形成原生 FVG';
    if (state === 'INVALIDATED') return '观察已失效';
    if (state === 'EXPIRED') return '观察已过期';
    return translate(state);
}

/**
 * Presentation-only classification of the existing coverage MSS payload.
 * Signal existence is deliberately kept separate from the strength of the
 * structural claim shown to a human. This function never mutates the payload.
 */
function classifyStructurePresentation(mss) {
    if (!mss || mss.exists !== true) {
        return { kind:'NONE', heading:'📐 结构突破信号', summaryLabel:null,
            warning:null, highQualityStructuralMss:false };
    }
    var role = raw(mss.referenceRole);
    var grade = raw(mss.mssGrade);
    var direction = raw(mss.direction);
    var bullish = direction === 'BULLISH';
    var bearish = direction === 'BEARISH';
    var directionZh = bullish ? '看多' : bearish ? '看空' : '';
    var directionEn = bullish ? 'Bullish' : bearish ? 'Bearish' : '';
    if (mss.protectedBreak === true || grade === 'PROTECTED' || role === 'ACTIVE_PROTECTED') {
        return {
            kind:'STRUCTURAL_MSS',
            heading:'📐 市场结构转换（Structural MSS）',
            summaryLabel:(directionEn ? directionEn + ' ' : '') + 'Structural MSS',
            warning:null,
            highQualityStructuralMss:true
        };
    }
    if (grade === 'STRUCTURAL' || role === 'CONTROLLING' || role === 'CONTROLLING_SWING' || role === 'SUPERSEDED_PROTECTED') {
        return {
            kind:'STRUCTURAL_BREAK', heading:'📐 结构突破',
            summaryLabel:(directionZh ? directionZh : '') + '结构突破',
            warning:'⚠️ 尚未确认 Structural MSS', highQualityStructuralMss:false
        };
    }
    if (role === 'INTERNAL') {
        return {
            kind:'INTERNAL_BREAK', heading:'📐 内部结构突破',
            summaryLabel:'内部' + (directionZh || '') + '结构突破',
            warning:'⚠️ 尚未确认 Structural MSS', highQualityStructuralMss:false
        };
    }
    if (role === 'LOCAL' || grade === 'LOCAL') {
        return {
            kind:'LOCAL_BREAK', heading:'📐 局部结构突破',
            summaryLabel:'局部' + (directionZh || '') + '结构突破',
            warning:'⚠️ 尚未确认 Structural MSS', highQualityStructuralMss:false
        };
    }
    return {
        kind:'BREAK_SIGNAL', heading:'📐 结构突破信号',
        summaryLabel:(directionZh || '') + '结构突破信号',
        warning:'⚠️ 结构 provenance 不足，尚未确认 Structural MSS',
        highQualityStructuralMss:false
    };
}

function displacementSummaryLabel(displacement, info) {
    return displacement && displacement.quality === 'WEAK' ? '弱' + info.displacement : info.displacement;
}

function buildSummary(watch, primary, bias, info) {
    var sentences = [];
    var hasLiquidity = !!primary;
    var hasDisplacement = !!(watch && watch.displacement);
    var structure = classifyStructurePresentation(watch && watch.mss);
    var hasStructure = structure.kind !== 'NONE';
    if (hasLiquidity || hasDisplacement || hasStructure) {
        var sentence = hasLiquidity ? info.liquidity + ' 被扫后' : '';
        if (hasStructure) {
            sentence += (sentence ? '出现' : '') + structure.summaryLabel;
        }
        if (hasDisplacement) {
            var displacementLabel = displacementSummaryLabel(watch.displacement, info);
            sentence += hasLiquidity && !hasStructure ? '出现' + displacementLabel
                : (sentence ? '与' : '出现') + displacementLabel;
        }
        if (watch && watch.nativeFvg) sentence += (sentence ? '，并' : '') + (biasConflict(bias) ? '回到' : '形成') + '原生 FVG';
        sentences.push(sentence + '。');
    } else {
        sentences.push('当前 WATCH 的结构证据未完整提供。');
    }
    if (!biasIsUnknown(bias) && bias.alignment === 'MATCH') {
        sentences.push('当前 4H Daily Bias 与本次 ' + info.side + ' WATCH 方向一致。');
        sentences.push('继续观察 FVG 回踩、价格接受及 ' + (info.side === 'SHORT' ? 'bearish' : 'bullish') + ' delivery 是否延续。');
    } else if (biasConflict(bias)) {
        sentences.push('但当前有效的 4H Daily Bias 为' + (bias.direction === 'BULLISH' ? '看多' : '看空') + '，本次 ' + info.side + ' WATCH 属于反 HTF 方向观察，不是当前优先 Narrative。');
        sentences.push('继续观察价格对 FVG 的接受情况及 ' + (info.side === 'SHORT' ? 'bearish' : 'bullish') + ' delivery 是否延续。');
    } else {
        sentences.push('继续观察 FVG 回踩、价格接受与后续结构延续。');
    }
    return sentences;
}

function build(watch, currentPrice, options) {
    var opts = options || {};
    var keyword = raw(opts.keyword) || '检测';
    var fmtPrice = opts.formatPrice;
    var info = directionInfo(watch && watch.direction);
    var primary = evidencePrimary(watch);
    var evidence = watch && watch.liquidityEvidenceV1;
    var side = liquiditySide(primary, evidence);
    var count = candidateCount(watch);
    var displacement = watch && watch.displacement;
    var mss = watch && watch.mss;
    var fvg = watch && watch.nativeFvg;
    var structurePresentation = classifyStructurePresentation(mss);
    var bias = biasView(watch);
    var conflict = biasConflict(bias);
    var narrative = narrativePresentation(watch, info);
    var generatedAt = opts.notificationGeneratedAt !== undefined ? opts.notificationGeneratedAt : Date.now();
    var lines = [
        (narrative ? narrative.icon : '🔔') + ' ' + keyword + ' · ' + (watch && watch.symbol || 'UNKNOWN') + ' · ' +
            (narrative ? narrative.title : info.title) + (conflict ? ' ⚠️ 逆 4H Bias' : ''),
        '',
        '时间：' + formatBeijingTime(generatedAt),
        '状态：' + friendlyWatchState(watch && watch.state),
        '执行状态：等待人工确认（WAIT FOR MANUAL CONFIRMATION）'
    ];
    if (narrative) lines.push(narrative.line);

    if (conflict) lines.push('', ...buildBiasLines(bias, info, true));
    lines.push('', '💧 流动性扫取');

    if (primary) {
        var contextSourceLabel = opts.sweepContextEnabled
            ? sweepContextPresentationV1.contextualSourceLabel(primary) : null;
        lines.push((side || '流动性') + '：' + (contextSourceLabel || sourceLabel(primary)) + ' @ ' + formatPrice(primary.sourcePrice, fmtPrice));
        eqMemberLines(primary, fmtPrice).forEach(function (line) { lines.push(line); });
        if (opts.sweepContextEnabled) {
            sweepContextPresentationV1.lines(primary).forEach(function (line) { lines.push(line); });
        }
        lines.push('时机：' + translate(primary.relation || 'BEFORE_LEG'));
        if (count > 1) {
            lines.push('候选：' + count + ' 个 · 当前按最近方向匹配扫取显示');
        }
    } else {
        lines.push('未提供');
    }

    lines.push('', '⚡ ' + info.displacement);
    if (displacement) {
        lines.push('方向：' + info.move + '（' + (displacement.direction || watch.direction || 'UNKNOWN') + '）');
        lines.push('强度：' + translate(displacement.quality));
        if (typeof displacement.startIndex === 'number' && typeof displacement.endIndex === 'number' && displacement.endIndex >= displacement.startIndex) {
            lines.push('持续：' + (displacement.endIndex - displacement.startIndex + 1) + ' 根 5m K线');
        }
    } else lines.push('未提供');

    lines.push('', structurePresentation.heading);
    if (mss && mss.exists) {
        lines.push('方向：' + translate(mss.direction));
        lines.push('结构参考位：' + formatPrice(mss.referencePrice, fmtPrice));
        lines.push('结构级别：' + translate(mss.referenceRole));
        lines.push('Protected Break：' + (mss.protectedBreak === true ? '是' : mss.protectedBreak === false ? '否' : '-'));
        if (structurePresentation.warning) lines.push(structurePresentation.warning);
    } else lines.push('未提供');

    lines.push('', '🟦 原生 FVG');
    if (fvg) {
        lines.push('区间：' + formatPrice(fvg.low, fmtPrice) + ' – ' + formatPrice(fvg.high, fmtPrice));
        lines.push('中点：' + formatPrice(fvg.midpoint, fmtPrice));
        lines.push('当前价格：' + formatPrice(currentPrice, fmtPrice));
        lines.push('状态：' + translate(watch.touchStatus || fvg.touchStatus || 'FIRST_TOUCH'));
    } else lines.push('未提供');

    if (!conflict) lines.push('', ...buildBiasLines(bias, info, false));

    lines.push('', '📌 当前结构解读');
    buildSummary(watch, primary, bias, info).forEach(function (sentence) { lines.push(sentence); });
    lines.push('', '这是 WATCH 观察事件，不是入场确认。');
    lines.push('仅用于市场结构监测，不构成自动交易或投资指令。');
    return lines.join('\n');
}

module.exports = {
    ENUM_ZH: ENUM_ZH,
    translate: translate,
    liquiditySide: liquiditySide,
    sourceLabel: sourceLabel,
    eqMemberLines: eqMemberLines,
    formatBeijingTime: formatBeijingTime,
    BEIJING_TIMEZONE: BEIJING_TIMEZONE,
    SOURCE_ZH: SOURCE_ZH,
    evidencePrimary: evidencePrimary,
    candidateCount: candidateCount,
    biasView: biasView,
    directionInfo: directionInfo,
    narrativePresentation: narrativePresentation,
    classifyStructurePresentation: classifyStructurePresentation,
    buildSummary: buildSummary,
    buildBiasLines: buildBiasLines,
    sweepContextLines: sweepContextPresentationV1.lines,
    build: build
};
