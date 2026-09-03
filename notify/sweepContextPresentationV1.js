'use strict';

/** Pure, deterministic presentation of an existing candidate.sweepContextV1. */
var TIMEFRAME_ORDER = ['5m', '15m', '1h', '4h'];
var TIMEFRAME_LABEL = { '5m':'5m', '15m':'15m', '1h':'1H', '4h':'4H' };
var ROLE_ZH = {
    INTERNAL: '内部结构',
    LOCAL: '局部结构',
    LOCAL_SWING: '局部结构',
    CONTROLLING: '控制结构 Swing',
    CONTROLLING_SWING: '控制结构 Swing',
    ACTIVE_PROTECTED: '当前受保护结构',
    SUPERSEDED_PROTECTED: '已被替代的受保护结构',
    BROKEN: '已破坏结构'
};

function roleLabel(role) {
    if (!role) return null;
    return (ROLE_ZH[role] || '未知结构角色') + '（' + role + '）';
}

function confirmedTimeframes(contexts) {
    var seen = {};
    (contexts || []).forEach(function (context) {
        var memberships = context && context.timeframeMembership || {};
        TIMEFRAME_ORDER.forEach(function (timeframe) {
            if (memberships[timeframe] && memberships[timeframe].confirmed === true) seen[timeframe] = true;
        });
    });
    return TIMEFRAME_ORDER.filter(function (timeframe) { return seen[timeframe]; });
}

function timeframeLine(contexts) {
    var timeframes = confirmedTimeframes(contexts);
    if (!timeframes.length) return null;
    if (timeframes.length === 1 && timeframes[0] === '5m') return '周期层级：仅 5m';
    return '周期层级：' + timeframes.map(function (timeframe) { return TIMEFRAME_LABEL[timeframe]; }).join(' / ');
}

function highestTimeframeLine(contexts) {
    var timeframes = confirmedTimeframes(contexts);
    if (!timeframes.length) return null;
    return '最高已确认周期覆盖：' + TIMEFRAME_LABEL[timeframes[timeframes.length - 1]];
}

function nonSwingType(sourceType) {
    // calendar-named liquidity（PDH/PDL/PWH/PWL/PMH/PML）已于
    // REMOVE_CALENDAR_NAMED_LIQUIDITY_V1 正式删除，不再渲染「日线/周线/月线流动性」标签；
    // 若遗留数据到达此处，回退到通用「原生流动性」而非猜测日历层级。
    if (/^(SESSION|ASIA|LONDON|NEW_YORK)_(HIGH|LOW)$/.test(sourceType || '')) return '时段流动性';
    return '原生流动性';
}

function contextualSourceLabel(candidate) {
    var context = candidate && candidate.sweepContextV1;
    if (!context || context.contextApplicability !== 'SWING_DERIVED' || !context.swingContext) return null;
    if (candidate.sourceType === 'SWING_HIGH') return '摆动高点（SWING_HIGH）';
    if (candidate.sourceType === 'SWING_LOW') return '摆动低点（SWING_LOW）';
    return null;
}

function lines(candidate) {
    var context = candidate && candidate.sweepContextV1;
    if (!context) return [];
    if (context.contextApplicability === 'SWING_DERIVED' && context.swingContext) {
        var swing = context.swingContext;
        var out = [];
        var timeframes = timeframeLine([swing]);
        var role = roleLabel(swing.structural && swing.structural.currentRole);
        if (timeframes) out.push(timeframes);
        if (role) out.push('结构角色：' + role);
        return out;
    }
    if (context.contextApplicability === 'EQ_POINT_IN_TIME_CROSS_SOURCE') {
        return ['EQ 语义：当前 2/2 与未失效 ATR50 历史点配对'];
    }
    if (context.contextApplicability === 'NON_SWING_LIQUIDITY') {
        return ['类型：' + nonSwingType(candidate.sourceType)];
    }
    // UNRESOLVED remains identity-only. Never expose internal error reasons or
    // guess Swing/MTF/structural facts in presentation.
    return [];
}

module.exports = {
    HTF_ORDER: TIMEFRAME_ORDER.slice(1),
    HTF_LABEL: TIMEFRAME_LABEL,
    TIMEFRAME_ORDER: TIMEFRAME_ORDER,
    TIMEFRAME_LABEL: TIMEFRAME_LABEL,
    ROLE_ZH: ROLE_ZH,
    roleLabel: roleLabel,
    confirmedHtf: confirmedTimeframes,
    confirmedTimeframes: confirmedTimeframes,
    timeframeLine: timeframeLine,
    highestTimeframeLine: highestTimeframeLine,
    nonSwingType: nonSwingType,
    contextualSourceLabel: contextualSourceLabel,
    lines: lines
};
