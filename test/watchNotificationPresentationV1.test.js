'use strict';
var assert=require('assert'),crypto=require('crypto');
var flag=require('../config/watchNotificationZhV1');
var presentation=require('../notify/watchNotificationPresentationV1');
var live=require('../scripts/live');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function watch(direction){var bearish=direction==='BEARISH',primary={id:'SWEEP:1',sourceId:'BTCUSDT:5m:'+(bearish?'SWING_HIGH':'SWING_LOW')+':1',sourceType:bearish?'SWING_HIGH':'SWING_LOW',sourceTimeframe:'5m',sourcePrice:78690.1,side:bearish?'BSL':'SSL',confirmedAt:100,relation:'BEFORE_LEG'};return{id:'W1',symbol:'BTCUSDT',direction:direction||'BULLISH',state:'FVG_TOUCHED',updatedAt:200,liquidityTaken:{primary:primary,allCandidates:[primary]},displacement:{direction:direction||'BULLISH',quality:'EXPLOSIVE',startIndex:9364,endIndex:9367},nativeFvg:{low:78789.9,high:78871.8,midpoint:78830.85},mss:{exists:true,direction:direction||'BULLISH',referencePrice:79035.7,referenceRole:'LOCAL',protectedBreak:false},dailyBias:{bias:direction||'BULLISH',confidence:'MEDIUM',alignment:'MATCH',status:'VALID'}};}
var FIXED_TIME=Date.parse('2026-08-26T00:12:00.000Z');
function zh(w,t){return live.buildFvgRetracementMessage(w,78871.8,{zhEnabled:true,notificationGeneratedAt:t===undefined?FIXED_TIME:t});}

test('1 LONG title 中文',function(){assert.ok(zh(watch('BULLISH')).includes('做多机会观察'));});
test('2 SHORT title 中文',function(){assert.ok(zh(watch('BEARISH')).includes('做空机会观察'));});
test('3 SWING_LOW -> compact SSL',function(){assert.ok(zh(watch('BULLISH')).includes('SSL：5m 摆动低点（SWING_LOW）'));});
test('4 SWING_HIGH -> compact BSL',function(){assert.ok(zh(watch('BEARISH')).includes('BSL：5m 摆动高点（SWING_HIGH）'));});
test('5 BULLISH mapping',function(){assert.strictEqual(presentation.translate('BULLISH'),'看多（BULLISH）');});
test('6 BEARISH mapping',function(){assert.strictEqual(presentation.translate('BEARISH'),'看空（BEARISH）');});
test('7 EXPLOSIVE mapping',function(){assert.strictEqual(presentation.translate('EXPLOSIVE'),'强势爆发（EXPLOSIVE）');});
test('8 LOCAL mapping',function(){assert.strictEqual(presentation.translate('LOCAL'),'局部结构（LOCAL）');});
test('9 FIRST_TOUCH mapping',function(){assert.strictEqual(presentation.translate('FIRST_TOUCH'),'首次触及（FIRST_TOUCH）');});
test('10 BEFORE_LEG mapping',function(){assert.strictEqual(presentation.translate('BEFORE_LEG'),'位移形成前（BEFORE_LEG）');});
test('11 INSIDE_LEG mapping',function(){assert.strictEqual(presentation.translate('INSIDE_LEG'),'位移过程中（INSIDE_LEG）');});
test('12 MATCH mapping',function(){assert.strictEqual(presentation.translate('MATCH'),'方向一致（MATCH）');});
test('13 OPPOSITE mapping',function(){assert.strictEqual(presentation.translate('OPPOSITE'),'方向相反（OPPOSITE）');});
test('14 UNKNOWN Bias handling',function(){var w=watch('BULLISH');w.dailyBias={bias:'UNKNOWN',confidence:null,alignment:'UNKNOWN',status:'BYPASSED'};assert.ok(zh(w).includes('未知 / 未参与判断（BYPASSED）'));});
test('15 multiple candidates compact heuristic wording',function(){var w=watch('BULLISH'),p=Object.assign({},w.liquidityTaken.primary,{id:'SWEEP:2',sourceId:'L2'});w.liquidityTaken.allCandidates.push(p);assert.ok(zh(w).includes('候选：2 个 · 当前按最近方向匹配扫取显示'));});
test('16 single candidate hides redundant count',function(){assert.ok(!zh(watch('BULLISH')).includes('候选：1 个'));});
test('17 non-causal primary has no causal wording',function(){var w=watch('BULLISH'),p=w.liquidityTaken.primary;w.liquidityEvidenceV1={liquidity:{liquiditySide:'SSL',lifecycleStatus:'SWEPT'},currentPrimary:{sweepEventId:p.id,sourceId:p.sourceId,selectionSemantic:'CURRENT_PRODUCTION_RECENCY_HEURISTIC',causalPrimaryClaim:false},candidates:[Object.assign({sweepEventId:p.id},p)]};var s=zh(w);assert.ok(!/因果|引发|causal primary/i.test(s));});
test('18 internal primary semantic remains unchanged',function(){var w=watch('BULLISH'),p=w.liquidityTaken.primary;w.liquidityEvidenceV1={liquidity:{liquiditySide:'SSL',lifecycleStatus:'SWEPT'},currentPrimary:{sweepEventId:p.id,sourceId:p.sourceId,selectionSemantic:'CURRENT_PRODUCTION_RECENCY_HEURISTIC',causalPrimaryClaim:false},candidates:[Object.assign({sweepEventId:p.id},p)]};zh(w);assert.strictEqual(w.liquidityEvidenceV1.currentPrimary.selectionSemantic,'CURRENT_PRODUCTION_RECENCY_HEURISTIC');assert.strictEqual(w.liquidityEvidenceV1.currentPrimary.causalPrimaryClaim,false);});
test('19 source Chinese mapping avoids duplicated raw enum',function(){var w=watch('BEARISH');w.liquidityTaken.primary.sourceType='NEW_YORK_HIGH';assert.ok(zh(w).includes('纽约时段高点（NEW_YORK_HIGH）'));assert.ok(!zh(w).includes('NEW_YORK_HIGH（NEW_YORK_HIGH）'));});
test('20 missing MSS safe',function(){var w=watch('BULLISH');delete w.mss;assert.ok(zh(w).includes('📐 市场结构转换（MSS）\n未提供'));});
test('21 missing FVG safe',function(){var w=watch('BULLISH');delete w.nativeFvg;assert.ok(zh(w).includes('🟦 原生 FVG\n未提供'));});
test('22 unknown enum fallback',function(){assert.strictEqual(presentation.translate('ALIEN'),'未知状态（ALIEN）');});
test('23 LONG summary has no short wording',function(){var section=zh(watch('BULLISH')).split('📌 当前结构解读')[1];assert.ok(!/做空|空头位移|Bearish MSS/.test(section));});
test('24 SHORT summary has no long wording',function(){var section=zh(watch('BEARISH')).split('📌 当前结构解读')[1];assert.ok(!/做多|多头位移|Bullish MSS/.test(section));});
test('25 WATCH wording has no execution advice',function(){assert.ok(!/建议做多|建议做空|立即入场|买入|卖出|开多|开空/.test(zh(watch('BULLISH'))));});
test('26 legacy flag OFF exact formatter',function(){var w=watch('BULLISH');assert.strictEqual(live.buildFvgRetracementMessage(w,78871.8,{zhEnabled:false}),live.buildLegacyFvgRetracementMessage(w,78871.8));assert.strictEqual(flag.DEFAULT_ENABLED,false);});
test('27 new flag ON Chinese formatter',function(){var w=watch('BULLISH');assert.strictEqual(live.buildFvgRetracementMessage(w,78871.8,{env:{WATCH_NOTIFICATION_ZH_V1_ENABLED:'true'},notificationGeneratedAt:FIXED_TIME}),zh(w));});
test('28 notification population and WATCH immutable',function(){var ws=[watch('BULLISH'),watch('BEARISH')],before=hash(ws),legacy=ws.map(function(w){return live.buildFvgRetracementMessage(w,1,{zhEnabled:false});}),next=ws.map(function(w){return live.buildFvgRetracementMessage(w,1,{zhEnabled:true,notificationGeneratedAt:FIXED_TIME});});assert.strictEqual(next.length,legacy.length);assert.strictEqual(hash(ws),before);});
test('29 Beijing time fixed UTC+8',function(){assert.ok(zh(watch('BULLISH'),Date.parse('2026-08-26T00:12:00.000Z')).includes('时间：08/26 08:12'));});
test('30 Beijing time crosses UTC date',function(){assert.ok(zh(watch('BULLISH'),Date.parse('2026-08-25T17:30:00.000Z')).includes('时间：08/26 01:30'));});
test('31 OPPOSITE adds title warning and moves Bias before liquidity',function(){var w=watch('BEARISH');w.dailyBias={bias:'BULLISH',confidence:'MEDIUM',alignment:'OPPOSITE',status:'VALID'};var s=zh(w);assert.ok(s.includes('做空机会观察 ⚠️ 逆 4H Bias'));assert.ok(s.includes('⚠️ 高周期方向冲突'));assert.ok(s.indexOf('⚠️ 高周期方向冲突')<s.indexOf('💧 流动性扫取'));});
test('32 MATCH has no conflict warning',function(){var s=zh(watch('BULLISH'));assert.ok(s.includes('方向关系：✅ 一致（MATCH）'));assert.ok(!/逆 4H Bias|高周期方向冲突/.test(s));});
test('33 UNKNOWN never claims MATCH or OPPOSITE',function(){var w=watch('BULLISH');w.dailyBias={bias:'UNKNOWN',confidence:null,alignment:'OPPOSITE',status:'BYPASSED'};var s=zh(w);assert.ok(!/逆 4H Bias|高周期方向冲突|相反（OPPOSITE）|一致（MATCH）/.test(s));});
test('34 displacement shows duration, never index interval label',function(){var s=zh(watch('BEARISH'));assert.ok(s.includes('持续：4 根 5m K线'));assert.ok(!s.includes('位移区间'));});
test('35 single-bar displacement duration is one',function(){var w=watch('BEARISH');w.displacement.startIndex=9530;w.displacement.endIndex=9530;assert.ok(zh(w).includes('持续：1 根 5m K线'));});
test('36 friendly state replaces debug state lines',function(){var s=zh(watch('BULLISH'));assert.ok(s.includes('状态：FVG 已首次触及'));assert.ok(!/当前状态：|系统状态：/.test(s));});
test('37 LONG MATCH mirror has no SHORT leakage',function(){var s=zh(watch('BULLISH'));assert.ok(/SSL：.*SWING_LOW/.test(s));assert.ok(s.includes('Bullish MSS'));assert.ok(s.includes('向上（BULLISH）'));assert.ok(!/SHORT|做空|空头位移|Bearish MSS/.test(s));});
test('38 source unknown falls back raw without throw',function(){var w=watch('BULLISH');w.liquidityTaken.primary.sourceType='CUSTOM_HIGH';assert.ok(zh(w).includes('SSL：CUSTOM_HIGH @'));});
test('39 INTERNAL remains neutral translation',function(){assert.strictEqual(presentation.translate('INTERNAL'),'内部结构（INTERNAL）');});
test('40 Chinese notification includes configured DingTalk keyword',function(){assert.ok(zh(watch('BULLISH')).startsWith('🔔 检测 · BTCUSDT'));});
test('41 custom DingTalk keyword is forwarded to Chinese formatter',function(){var s=live.buildFvgRetracementMessage(watch('BULLISH'),78871.8,{zhEnabled:true,keyword:'监测',notificationGeneratedAt:FIXED_TIME});assert.ok(s.startsWith('🔔 监测 · BTCUSDT'));});
test('42 LONG summary honors raw bullish MSS',function(){var s=zh(watch('BULLISH')).split('📌 当前结构解读')[1];assert.ok(s.includes('Bullish MSS'));assert.ok(!s.includes('Bearish MSS'));});
test('43 SHORT summary honors raw bearish MSS',function(){var s=zh(watch('BEARISH')).split('📌 当前结构解读')[1];assert.ok(s.includes('Bearish MSS'));assert.ok(!s.includes('Bullish MSS'));});
test('44 LONG without MSS summary does not invent MSS direction',function(){var w=watch('BULLISH');w.mss={exists:false,direction:null};var s=zh(w).split('📌 当前结构解读')[1];assert.ok(!/Bullish MSS|Bearish MSS/.test(s));});
test('45 SHORT without MSS summary does not invent MSS direction',function(){var w=watch('BEARISH');w.mss={exists:false,direction:null};var s=zh(w).split('📌 当前结构解读')[1];assert.ok(!/Bullish MSS|Bearish MSS/.test(s));});
test('46 LONG formatter defensively honors raw opposite bearish MSS',function(){var w=watch('BULLISH');w.mss.direction='BEARISH';var s=zh(w).split('📌 当前结构解读')[1];assert.ok(s.includes('Bearish MSS'));assert.ok(!s.includes('Bullish MSS'));});
test('47 SHORT formatter defensively honors raw opposite bullish MSS',function(){var w=watch('BEARISH');w.mss.direction='BULLISH';var s=zh(w).split('📌 当前结构解读')[1];assert.ok(s.includes('Bullish MSS'));assert.ok(!s.includes('Bearish MSS'));});
test('48 MSS-absent summary grammar uses 被扫后出现',function(){var w=watch('BULLISH');w.mss={exists:false,direction:null};var s=zh(w);assert.ok(s.includes('被扫后出现多头位移'));assert.ok(!s.includes('被扫后 与多头位移'));});

if(failed){console.error('WATCH Notification Presentation V1 failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('WATCH Notification Presentation V1 '+passed+'/'+passed);
