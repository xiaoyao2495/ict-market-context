'use strict';
var assert=require('assert');
var presentation=require('../notify/watchNotificationPresentationV1');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function partner(id,price,occurredAt){return{id:id,source:'CAUSAL_DYNAMIC_D_V1',price:price,occurredAt:occurredAt,confirmedAt:occurredAt+300000};}
function watch(type,partners){
    var side=type==='EQH'?'BSL':'SSL',direction=type==='EQH'?'BEARISH':'BULLISH';
    var p={id:'S1',sourceId:'EQX1:X',sourceType:type,sourceTimeframe:'5m',sourcePrice:100,side:side,confirmedAt:30,relation:'BEFORE_LEG'};
    if(partners!==undefined)p.eqPartnerProvenance={eqModelVersion:'DYNAMIC_D_36H_CROSS_SOURCE_V1',asOf:30,currentPivot:{id:'P',price:100,occurredAt:20,confirmedAt:30},partnerCount:partners.length,historicalPartners:partners};
    return{id:'W',symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',liquidityTaken:{primary:p,allCandidates:[p]},displacement:{direction:direction,quality:'NORMAL',startIndex:1,endIndex:1},nativeFvg:{low:1,high:2,midpoint:1.5},mss:{exists:false},dailyBias:{bias:'UNKNOWN',alignment:'UNKNOWN',status:'UNKNOWN'}};
}
function build(w){return presentation.build(w,1,{keyword:'检测',notificationGeneratedAt:100,formatPrice:function(v){return v.toFixed(1);}});}

test('EQH displays current 2/2 and ATR50 historical partners',function(){var s=build(watch('EQH',[partner('A',100.1,Date.parse('2026-08-27T20:05:00Z')),partner('B',99.9,Date.parse('2026-08-27T21:10:00Z'))]));assert.ok(s.includes('EQ 当前点：2/2 @ 100.0'));assert.ok(s.includes('Dynamic D 历史配对：2 个'));assert.ok(s.includes('历史点位：100.1 / 99.9'));assert.ok(s.includes('历史时间（北京时间）：08/28 04:05 / 08/28 05:10'));});
test('EQL uses the same non-cluster point-in-time wording',function(){var s=build(watch('EQL',[partner('A',90,10)]));assert.ok(s.includes('Dynamic D 历史配对：1 个'));assert.ok(!s.includes('EQ 构成'));assert.ok(!s.includes('成员'));});
test('partner order stays frozen input order',function(){var s=build(watch('EQH',[partner('A',101,10),partner('B',99,20),partner('C',100,25)]));assert.ok(s.includes('101.0 / 99.0 / 100.0'));});
test('missing EQ provenance degrades safely',function(){assert.ok(build(watch('EQH')).includes('EQ 配对：信息暂缺'));});
test('non-EQ notification has no EQ pairing line',function(){var w=watch('EQH',[partner('A',1,1)]);w.liquidityTaken.primary.sourceType='PDH';delete w.liquidityTaken.primary.eqPartnerProvenance;var s=build(w);assert.ok(!s.includes('EQ 配对'));assert.ok(!s.includes('Dynamic D 历史配对'));});
test('more than six partners truncates presentation only',function(){var ps=[];for(var i=0;i<7;i++)ps.push(partner(String(i),i,10+i));var s=build(watch('EQL',ps));assert.ok(s.includes('… 共 7 个'));assert.ok(s.includes('Dynamic D 历史配对：7 个'));});
test('MSS absent grammar remains correct',function(){var s=build(watch('EQL',[partner('A',1,1)]));assert.ok(s.includes('被获取后出现多头位移'));assert.ok(!s.includes('被获取后 与多头位移'));});

if(failed){console.error('EQ Partner Notification Provenance failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('EQ Partner Notification Provenance '+passed+'/'+passed);
