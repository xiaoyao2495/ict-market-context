'use strict';

/** Pure, deterministic presentation of an existing candidate.sweepContextV1. */
var HTF_ORDER = ['15m', '1h', '4h'];
var HTF_LABEL = { '15m':'15m', '1h':'1H', '4h':'4H' };
var ROLE_ZH = {
    LOCAL_SWING: '局部摆动',
    INTERNAL: '内部结构',
    CONTROLLING_SWING: '控制结构',
    ACTIVE_PROTECTED: '受保护',
    SUPERSEDED_PROTECTED: '已取代的受保护',
    BROKEN: '已破坏结构'
};

function sideSuffix(side) {
    if (side === 'HIGH') return '高点';
    if (side === 'LOW') return '低点';
    return '点位';
}
function roleLabel(role, side) {
    if (!role) return null;
    return (ROLE_ZH[role] || role) + sideSuffix(side);
}
function confirmedHtf(contexts) {
    var seen={};(contexts||[]).forEach(function(context){var memberships=context&&context.timeframeMembership||{};HTF_ORDER.forEach(function(tf){if(memberships[tf]&&memberships[tf].confirmed)seen[tf]=true;});});
    return HTF_ORDER.filter(function(tf){return seen[tf];});
}
function htfLine(contexts, side, prefix) {
    var timeframes=confirmedHtf(contexts);if(!timeframes.length)return null;
    return (prefix||'高周期')+'：'+timeframes.map(function(tf){return HTF_LABEL[tf];}).join(' / ')+' 摆动'+sideSuffix(side);
}
function lines(candidate) {
    var context=candidate&&candidate.sweepContextV1;if(!context)return[];
    if(context.contextApplicability==='SWING_DERIVED'&&context.swingContext){
        var swing=context.swingContext,role=swing.structural&&swing.structural.currentRole,out=[];
        var structural=roleLabel(role,swing.side);if(structural)out.push('结构：'+structural);
        var higher=htfLine([swing],swing.side,'高周期');if(higher)out.push(higher);
        return out;
    }
    if(context.contextApplicability==='EQ_MULTI_MEMBER'){
        var members=context.memberSwingContexts||[],side=members[0]&&members[0].side;
        var eq=['结构：EQ 多成员（'+members.length+' 个，不指定主成员）'];
        var memberHtf=htfLine(members,side,'成员高周期');if(memberHtf)eq.push(memberHtf);
        return eq;
    }
    // NON_SWING_LIQUIDITY / UNRESOLVED / missing remain concise. Native
    // identity is already displayed by the parent formatter; no error wording.
    return [];
}

module.exports={HTF_ORDER:HTF_ORDER,HTF_LABEL:HTF_LABEL,ROLE_ZH:ROLE_ZH,sideSuffix:sideSuffix,roleLabel:roleLabel,confirmedHtf:confirmedHtf,lines:lines};
