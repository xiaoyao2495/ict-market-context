'use strict';
var assert=require('assert'),crypto=require('crypto');
var flag=require('../config/watchNotificationZhV1');
var presentation=require('../notify/watchNotificationPresentationV1');
var live=require('../scripts/live');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function watch(direction){var bearish=direction==='BEARISH',primary={id:'SWEEP:1',sourceId:'BTCUSDT:5m:'+(bearish?'SWING_HIGH':'SWING_LOW')+':1',sourceType:bearish?'SWING_HIGH':'SWING_LOW',sourceTimeframe:'5m',sourcePrice:78690.1,side:bearish?'BSL':'SSL',confirmedAt:100,relation:'BEFORE_LEG'};return{id:'W1',symbol:'BTCUSDT',direction:direction||'BULLISH',state:'FVG_TOUCHED',updatedAt:200,liquidityTaken:{primary:primary,allCandidates:[primary]},displacement:{direction:direction||'BULLISH',quality:'EXPLOSIVE',startIndex:9364,endIndex:9367},nativeFvg:{low:78789.9,high:78871.8,midpoint:78830.85},mss:{exists:true,direction:direction||'BULLISH',referencePrice:79035.7,referenceRole:'LOCAL',protectedBreak:false},dailyBias:{bias:direction||'BULLISH',confidence:'MEDIUM',alignment:'MATCH',status:'VALID'}};}
function zh(w){return live.buildFvgRetracementMessage(w,78871.8,{zhEnabled:true});}

test('1 LONG title 中文',function(){assert.ok(zh(watch('BULLISH')).includes('做多机会观察'));});
test('2 SHORT title 中文',function(){assert.ok(zh(watch('BEARISH')).includes('做空机会观察'));});
test('3 SWING_LOW -> SSL',function(){assert.ok(zh(watch('BULLISH')).includes('卖方流动性（SSL）'));});
test('4 SWING_HIGH -> BSL',function(){assert.ok(zh(watch('BEARISH')).includes('买方流动性（BSL）'));});
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
test('15 multiple candidates display count',function(){var w=watch('BULLISH'),p=Object.assign({},w.liquidityTaken.primary,{id:'SWEEP:2',sourceId:'L2'});w.liquidityTaken.allCandidates.push(p);assert.ok(zh(w).includes('候选流动性：共 2 个'));});
test('16 single candidate hides redundant count',function(){assert.ok(!zh(watch('BULLISH')).includes('候选流动性：共'));});
test('17 non-causal primary has no causal wording',function(){var w=watch('BULLISH'),p=w.liquidityTaken.primary;w.liquidityEvidenceV1={liquidity:{liquiditySide:'SSL',lifecycleStatus:'SWEPT'},currentPrimary:{sweepEventId:p.id,sourceId:p.sourceId,selectionSemantic:'CURRENT_PRODUCTION_RECENCY_HEURISTIC',causalPrimaryClaim:false},candidates:[Object.assign({sweepEventId:p.id},p)]};var s=zh(w);assert.ok(!/因果|引发|causal primary/i.test(s));});
test('18 lifecycle SWEPT 中文',function(){var w=watch('BULLISH'),p=w.liquidityTaken.primary;w.liquidityEvidenceV1={liquidity:{liquiditySide:'SSL',lifecycleStatus:'SWEPT'},currentPrimary:{sweepEventId:p.id,sourceId:p.sourceId},candidates:[Object.assign({sweepEventId:p.id},p)]};assert.ok(zh(w).includes('已扫取（SWEPT）'));});
test('19 lifecycle BROKEN 中文',function(){var w=watch('BULLISH'),p=w.liquidityTaken.primary;w.liquidityEvidenceV1={liquidity:{liquiditySide:'SSL',lifecycleStatus:'BROKEN'},currentPrimary:{sweepEventId:p.id,sourceId:p.sourceId},candidates:[Object.assign({sweepEventId:p.id},p)]};assert.ok(zh(w).includes('已破坏（BROKEN）'));});
test('20 missing MSS safe',function(){var w=watch('BULLISH');delete w.mss;assert.ok(zh(w).includes('📐 市场结构转换（MSS）\n未提供'));});
test('21 missing FVG safe',function(){var w=watch('BULLISH');delete w.nativeFvg;assert.ok(zh(w).includes('🟦 原生 FVG\n未提供'));});
test('22 unknown enum fallback',function(){assert.strictEqual(presentation.translate('ALIEN'),'未知状态（ALIEN）');});
test('23 LONG summary has no short wording',function(){var section=zh(watch('BULLISH')).split('📌 当前结构解读')[1];assert.ok(!/做空|空头位移|Bearish MSS/.test(section));});
test('24 SHORT summary has no long wording',function(){var section=zh(watch('BEARISH')).split('📌 当前结构解读')[1];assert.ok(!/做多|多头位移|Bullish MSS/.test(section));});
test('25 WATCH wording has no execution advice',function(){assert.ok(!/建议做多|建议做空|立即入场|买入|卖出|开多|开空/.test(zh(watch('BULLISH'))));});
test('26 legacy flag OFF exact formatter',function(){var w=watch('BULLISH');assert.strictEqual(live.buildFvgRetracementMessage(w,78871.8,{zhEnabled:false}),live.buildLegacyFvgRetracementMessage(w,78871.8));assert.strictEqual(flag.DEFAULT_ENABLED,false);});
test('27 new flag ON Chinese formatter',function(){var w=watch('BULLISH');assert.strictEqual(live.buildFvgRetracementMessage(w,78871.8,{env:{WATCH_NOTIFICATION_ZH_V1_ENABLED:'true'}}),zh(w));});
test('28 notification population and WATCH immutable',function(){var ws=[watch('BULLISH'),watch('BEARISH')],before=hash(ws),legacy=ws.map(function(w){return live.buildFvgRetracementMessage(w,1,{zhEnabled:false});}),next=ws.map(function(w){return live.buildFvgRetracementMessage(w,1,{zhEnabled:true});});assert.strictEqual(next.length,legacy.length);assert.strictEqual(hash(ws),before);});

if(failed){console.error('WATCH Notification Presentation V1 failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('WATCH Notification Presentation V1 '+passed+'/'+passed);
