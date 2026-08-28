'use strict';
var assert=require('assert');
var presentation=require('../notify/watchNotificationPresentationV1');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function watch(type,members){var side=type==='EQH'?'BSL':'SSL',direction=type==='EQH'?'BEARISH':'BULLISH';var p={id:'S1',sourceId:'EQV3:X',sourceType:type,sourceTimeframe:'5m',sourcePrice:100,side:side,confirmedAt:30,relation:'BEFORE_LEG'};if(members!==undefined)p.eqMemberProvenance={asOf:30,memberCount:members.length,members:members};return{id:'W',symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',liquidityTaken:{primary:p,allCandidates:[p]},displacement:{direction:direction,quality:'NORMAL',startIndex:1,endIndex:1},nativeFvg:{low:1,high:2,midpoint:1.5},mss:{exists:false},dailyBias:{bias:'UNKNOWN',alignment:'UNKNOWN',status:'UNKNOWN'}};}
function member(id,price,t,occurredAt){return{id:id,canonicalSwingId:id,price:price,occurredAt:occurredAt,confirmedAt:t,memberAddedAt:t};}
function build(w){return presentation.build(w,1,{keyword:'检测',notificationGeneratedAt:100,formatPrice:function(v){return v.toFixed(1);}});}
test('EQH members displayed',function(){var s=build(watch('EQH',[member('A',100.1,10),member('B',99.9,20)]));assert.ok(s.includes('EQ 构成：2 个高点'));assert.ok(s.includes('构成点位：100.1 / 99.9'));});
test('EQL members displayed',function(){assert.ok(build(watch('EQL',[member('A',90,10),member('B',91,20),member('C',90.5,25)])).includes('EQ 构成：3 个低点'));});
test('member order remains temporal input order, not price order',function(){var s=build(watch('EQH',[member('A',101,10),member('B',99,20),member('C',100,25)]));assert.ok(s.includes('101.0 / 99.0 / 100.0'));});
test('member Swing occurredAt is displayed in Beijing time and aligned with price order',function(){var s=build(watch('EQL',[member('A',90,10,Date.parse('2026-08-27T20:05:00Z')),member('B',91,20,Date.parse('2026-08-27T21:10:00Z'))]));assert.ok(s.includes('对应时间（北京时间）：08/28 04:05 / 08/28 05:10'));});
test('member time never falls back to confirmedAt',function(){var s=build(watch('EQH',[member('A',100,10),member('B',101,20)]));assert.ok(s.includes('对应时间（北京时间）：信息暂缺'));});
test('frozen as-of snapshot hides future append',function(){var w=watch('EQH',[member('A',100,10),member('B',101,20),member('C',102,40)]);var s=build(w);assert.ok(!s.includes('102.0'));assert.ok(s.includes('EQ 构成：2 个高点'));});
test('missing EQ provenance degrades safely',function(){assert.ok(build(watch('EQH')).includes('EQ 构成：信息暂缺'));});
test('non-EQ notification has no EQ member line',function(){var w=watch('EQH',[member('A',1,1),member('B',2,2)]);w.liquidityTaken.primary.sourceType='PDH';delete w.liquidityTaken.primary.eqMemberProvenance;var s=build(w);assert.ok(!s.includes('EQ 构成'));});
test('more than six members truncates only presentation',function(){var ms=[];for(var i=0;i<7;i++)ms.push(member(String(i),i,10+i));var s=build(watch('EQL',ms));assert.ok(s.includes('… 共 7 个'));assert.ok(s.includes('EQ 构成：7 个低点'));});
test('MSS absent grammar remains correct',function(){var s=build(watch('EQL',[member('A',1,1),member('B',2,2)]));assert.ok(s.includes('被扫后出现多头位移'));assert.ok(!s.includes('被扫后 与多头位移'));});
if(failed){console.error('EQ Member Notification Provenance failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('EQ Member Notification Provenance '+passed+'/'+passed);
