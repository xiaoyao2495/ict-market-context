'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var live = require('../scripts/live');
var helper = require('../notify/sweepContextPresentationV1');

var FIXED_TIME = Date.parse('2026-08-26T00:12:00.000Z');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function membership(confirmed) {
    var out = {};
    ['5m', '15m', '1h', '4h'].forEach(function (timeframe) {
        out[timeframe] = { confirmed: confirmed.indexOf(timeframe) >= 0, swingId:null, occurredAt:null, confirmedAt:null, provenance:null };
    });
    return out;
}
function swingContext(side, role, confirmed) {
    return {
        schemaVersion:'SweepContextV1', contextApplicability:'SWING_DERIVED', canonicalSwingId:'S',
        swingContext:{ canonicalSwingId:'S', side:side, structural:{currentRole:role,currentStatus:'CANDIDATE',roleAsOf:20,provenance:{}}, timeframeMembership:membership(confirmed || ['5m']) },
        memberSwingContexts:[], evaluationTime:50, provenance:{}
    };
}
function eqContext(side, partnerCount) {
    return {
        schemaVersion:'SweepContextV1', contextApplicability:'EQ_POINT_IN_TIME_CROSS_SOURCE', canonicalSwingId:null,
        swingContext:null, memberSwingContexts:[], evaluationTime:50,
        provenance:{eqSemantic:'POINT_IN_TIME_2X2_VS_ATR50_PARTNERS',historicalPartnerIds:Array.from({length:partnerCount||1},function(_,i){return 'Z'+i;}),clusterIdentity:false}
    };
}
function nonSwingContext() { return {schemaVersion:'SweepContextV1',contextApplicability:'NON_SWING_LIQUIDITY',canonicalSwingId:null,swingContext:null,memberSwingContexts:[],evaluationTime:50,provenance:{}}; }
function candidate(type, side, context, id) {
    return {id:id||'SWEEP:1',sweepEventId:id||'SWEEP:1',sourceId:'SOURCE:'+(id||'1'),sourceType:type,sourceTimeframe:'5m',sourcePrice:78690.1,side:side,confirmedAt:50,relation:'BEFORE_LEG',sweepContextV1:context};
}
function watch(direction, type, context) {
    var short = direction === 'BEARISH';
    var primary = candidate(type || (short ? 'SWING_HIGH' : 'SWING_LOW'), short ? 'BSL' : 'SSL', context);
    var legacyPrimary = {id:primary.id,sourceId:primary.sourceId,sourceType:primary.sourceType,sourceTimeframe:primary.sourceTimeframe,sourcePrice:primary.sourcePrice,side:primary.side,confirmedAt:primary.confirmedAt,relation:primary.relation};
    return {
        id:'W',symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',createdAt:100,updatedAt:100,notificationKey:'N',
        liquidityTaken:{primary:legacyPrimary,allCandidates:[primary]},
        liquidityEvidenceV1:{currentPrimary:{sweepEventId:primary.id,sourceId:primary.sourceId,selectionSemantic:'CURRENT_PRODUCTION_RECENCY_HEURISTIC',causalPrimaryClaim:false},candidates:[primary],allCandidates:[primary],liquidity:{liquiditySide:primary.side}},
        displacement:{direction:direction,quality:'NORMAL',startIndex:1,endIndex:1},nativeFvg:{low:1,high:2,midpoint:1.5},
        mss:{exists:true,direction:direction,referencePrice:3,referenceRole:'LOCAL',protectedBreak:false,mssGrade:'LOCAL'},
        dailyBias:{bias:direction,confidence:'MEDIUM',alignment:'MATCH',status:'VALID'}
    };
}
function render(watchValue, enabled, at) {
    return live.buildFvgRetracementMessage(watchValue, 1.5, {zhEnabled:true,sweepContextEnabled:enabled,notificationGeneratedAt:at === undefined ? FIXED_TIME : at});
}
function liquiditySection(message) { return (message.split('💧 流动性获取（Liquidity Taken）')[1] || '').split('⚡')[0]; }
function summarySection(message) { return (message.split('📌 当前结构解读')[1] || '').split('仅用于')[0]; }

test('1 SWING_HIGH with 5m-only context', function () { var s=liquiditySection(render(watch('BEARISH','SWING_HIGH',swingContext('HIGH','LOCAL',['5m'])),true));assert.ok(s.includes('BSL：摆动高点（SWING_HIGH）'));assert.ok(s.includes('周期层级：仅 5m')); });
test('2 SWING_LOW with 15m membership', function () { var s=liquiditySection(render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m','15m'])),true));assert.ok(s.includes('SSL：摆动低点（SWING_LOW）'));assert.ok(s.includes('周期层级：5m / 15m')); });
test('3 1H membership display', function () { assert.ok(render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m','15m','1h'])),true).includes('周期层级：5m / 15m / 1H')); });
test('4 4H membership display', function () { assert.ok(render(watch('BEARISH','SWING_HIGH',swingContext('HIGH','LOCAL',['5m','15m','1h','4h'])),true).includes('周期层级：5m / 15m / 1H / 4H')); });
test('5 non-confirmed timeframes are hidden', function () { var s=liquiditySection(render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),true));assert.ok(!/15m|1H|4H/.test(s)); });
test('6 INTERNAL Chinese mapping', function () { assert.equal(helper.roleLabel('INTERNAL'),'内部结构（INTERNAL）'); });
test('7 LOCAL Chinese mapping', function () { assert.equal(helper.roleLabel('LOCAL'),'局部结构（LOCAL）'); });
test('8 CONTROLLING Chinese mapping', function () { assert.equal(helper.roleLabel('CONTROLLING_SWING'),'控制结构 Swing（CONTROLLING_SWING）'); });
test('9 ACTIVE_PROTECTED Chinese mapping', function () { assert.equal(helper.roleLabel('ACTIVE_PROTECTED'),'当前受保护结构（ACTIVE_PROTECTED）'); });
test('10 SUPERSEDED_PROTECTED Chinese mapping', function () { assert.equal(helper.roleLabel('SUPERSEDED_PROTECTED'),'已被替代的受保护结构（SUPERSEDED_PROTECTED）'); });
test('11 BROKEN Chinese mapping', function () { assert.equal(helper.roleLabel('BROKEN'),'已破坏结构（BROKEN）'); });
test('12 unknown structural enum fallback', function () { assert.equal(helper.roleLabel('CUSTOM_ROLE'),'未知结构角色（CUSTOM_ROLE）'); });
test('13 EQH point-in-time cross-source summary', function () { var s=liquiditySection(render(watch('BEARISH','EQH',eqContext('HIGH',3)),true));assert.ok(s.includes('BSL：等高点（EQH）'));assert.ok(s.includes('EQ 语义：当前 2/2 与未失效 ATR50 历史点配对'));assert.ok(!s.includes('成员 Swing')); });
test('14 EQL point-in-time cross-source summary', function () { var s=liquiditySection(render(watch('BULLISH','EQL',eqContext('LOW',2)),true));assert.ok(s.includes('SSL：等低点（EQL）'));assert.ok(s.includes('ATR50 历史点配对')); });
test('15 EQ presentation never selects a cluster member or primary partner', function () { var s=render(watch('BEARISH','EQH',eqContext('HIGH',2)),true);assert.ok(!/主成员|primary member|成员 Swing/i.test(s)); });
test('16 PDH non-swing display', function () { var s=liquiditySection(render(watch('BEARISH','PDH',nonSwingContext()),true));assert.ok(s.includes('前一日高点（PDH）'));assert.ok(s.includes('类型：日线流动性'));assert.ok(!/周期层级|结构角色/.test(s)); });
test('17 PDL non-swing display', function () { var s=liquiditySection(render(watch('BULLISH','PDL',nonSwingContext()),true));assert.ok(s.includes('前一日低点（PDL）'));assert.ok(s.includes('类型：日线流动性')); });
test('18 NEW_YORK_HIGH non-swing display', function () { var s=liquiditySection(render(watch('BEARISH','NEW_YORK_HIGH',nonSwingContext()),true));assert.ok(s.includes('纽约时段高点（NEW_YORK_HIGH）'));assert.ok(s.includes('类型：时段流动性')); });
test('19 SESSION_LOW non-swing display', function () { var s=liquiditySection(render(watch('BULLISH','SESSION_LOW',nonSwingContext()),true));assert.ok(s.includes('时段低点（SESSION_LOW）'));assert.ok(s.includes('类型：时段流动性')); });
test('20 UNRESOLVED safely preserves raw identity', function () { var c={contextApplicability:'UNRESOLVED',swingContext:null,memberSwingContexts:[],unresolvedReason:'MISSING_PROVENANCE'},s=liquiditySection(render(watch('BULLISH','SWING_LOW',c),true));assert.ok(s.includes('5m 摆动低点（SWING_LOW）'));assert.ok(!/MISSING_PROVENANCE|周期层级|结构角色/.test(s)); });
test('21 missing context uses exact legacy display', function () { var w=watch('BULLISH','SWING_LOW',null);delete w.liquidityEvidenceV1.candidates[0].sweepContextV1;delete w.liquidityEvidenceV1.allCandidates[0].sweepContextV1;assert.equal(render(w,true),render(w,false)); });
test('22 multiple candidate count is preserved', function () { var w=watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),extra=candidate('PDL','SSL',nonSwingContext(),'SWEEP:2');w.liquidityEvidenceV1.candidates.push(extra);w.liquidityEvidenceV1.allCandidates.push(extra);assert.ok(render(w,true).includes('候选：2 个 · 当前按最近方向匹配 Taken 显示')); });
test('23 current primary remains unchanged', function () { var w=watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m','1h'])),before=hash(w.liquidityEvidenceV1.currentPrimary);render(w,true);assert.equal(hash(w.liquidityEvidenceV1.currentPrimary),before);assert.equal(w.liquidityEvidenceV1.currentPrimary.causalPrimaryClaim,false); });
test('24 LONG and SHORT mapping is symmetric', function () { var long=liquiditySection(render(watch('BULLISH','SWING_LOW',swingContext('LOW','ACTIVE_PROTECTED',['5m','15m'])),true)),short=liquiditySection(render(watch('BEARISH','SWING_HIGH',swingContext('HIGH','ACTIVE_PROTECTED',['5m','15m'])),true));assert.ok(long.includes('SSL：摆动低点'));assert.ok(short.includes('BSL：摆动高点'));assert.ok(long.includes('周期层级：5m / 15m'));assert.ok(short.includes('周期层级：5m / 15m')); });
test('25 legacy structure payload is ignored by summary', function () { var w=watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),base=summarySection(render(w,true));w.mss={exists:true,direction:'BEARISH'};assert.equal(summarySection(render(w,true)),base); });
test('26 notification contains no structure signal', function () { var s=render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),true);assert.ok(!/结构突破|市场结构转换/.test(s)); });
test('27 OPPOSITE Bias warning is preserved', function () { var w=watch('BEARISH','SWING_HIGH',swingContext('HIGH','LOCAL',['5m']));w.dailyBias={bias:'BULLISH',confidence:'MEDIUM',alignment:'OPPOSITE',status:'VALID'};var s=render(w,true);assert.ok(s.includes('做空机会观察 ⚠️ 逆 4H Bias'));assert.ok(s.indexOf('⚠️ 高周期方向冲突')<s.indexOf('💧 流动性获取（Liquidity Taken）')); });
test('28 Beijing notification time is preserved', function () { assert.ok(render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),true,Date.parse('2026-08-25T17:30:00Z')).includes('时间：08/26 01:30')); });
test('29 notification trigger identity remains unchanged', function () { var w=watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),key=w.notificationKey,state=w.state;render(w,true);assert.equal(w.notificationKey,key);assert.equal(w.state,state); });
test('30 no importance or ranking wording', function () { var s=render(watch('BEARISH','SWING_HIGH',swingContext('HIGH','ACTIVE_PROTECTED',['5m','15m','1h','4h'])),true);assert.ok(!/重要 Swing|高质量 Swing|高级流动性|核心流动性|主导流动性|最重要候选|更高胜率|推荐交易|建议入场/.test(s)); });
test('31 flag OFF preserves legacy notification exactly', function () { var w=watch('BULLISH','SWING_LOW',swingContext('LOW','ACTIVE_PROTECTED',['5m','15m'])),without=JSON.parse(JSON.stringify(w));delete without.liquidityEvidenceV1.candidates[0].sweepContextV1;delete without.liquidityEvidenceV1.allCandidates[0].sweepContextV1;assert.equal(render(w,false),render(without,false)); });
test('32 formatter never mutates WATCH or evidence', function () { var w=watch('BEARISH','SWING_HIGH',swingContext('HIGH','BROKEN',['5m','1h'])),before=hash(w);render(w,true);assert.equal(hash(w),before); });
test('33 unknown non-swing source remains raw and null-safe', function () { var w=watch('BEARISH','CUSTOM_HIGH',nonSwingContext());assert.doesNotThrow(function(){render(w,true);});assert.ok(render(w,true).includes('CUSTOM_HIGH @')); });
test('34 context lines stay inside liquidity section only', function () { var s=render(watch('BULLISH','SWING_LOW',swingContext('LOW','ACTIVE_PROTECTED',['5m','15m'])),true),parts=s.split('⚡');assert.ok(parts[0].includes('结构角色：'));assert.ok(!parts.slice(1).join('⚡').includes('结构角色：')); });
test('35 notification has no structure-signal section', function () { var s=render(watch('BULLISH','SWING_LOW',swingContext('LOW','LOCAL',['5m'])),true);assert.ok(!s.includes('📐'));assert.ok(s.includes('⚡ 多头位移')); });
test('36 protected lifecycle context does not become a signal', function () { var w=watch('BEARISH','SWING_HIGH',swingContext('HIGH','ACTIVE_PROTECTED',['5m','15m'])),base=render(w,true);w.mss={exists:true,referenceRole:'ACTIVE_PROTECTED',protectedBreak:true,mssGrade:'PROTECTED'};assert.equal(render(w,true),base); });
test('37 execution state and WATCH disclaimer coexist with sweep context', function () { var s=render(watch('BULLISH','EQH',eqContext('LOW',2)),true);assert.ok(s.includes('执行状态：等待人工确认（WAIT FOR MANUAL CONFIRMATION）'));assert.ok(s.includes('这是 WATCH 观察事件，不是入场确认。')); });
test('38 sweep and EQ presentation contain no former cluster structure classification', function () { var s=liquiditySection(render(watch('BEARISH','EQH',eqContext('HIGH',2)),true));assert.ok(s.includes('BSL：等高点（EQH）'));assert.ok(s.includes('当前 2/2'));assert.ok(!/成员 Swing|最高已确认周期覆盖/.test(s)); });
