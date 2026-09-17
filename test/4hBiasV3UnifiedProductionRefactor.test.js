'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var metrics = require('../bias/directionalContext/4hDirectionalMetrics');
var leg = require('../bias/directionalContext/4hDirectionalLegV1');
var ts = require('../bias/directionalContext/theilSen48');
var factsV3 = require('../bias/directionalContext/4hBiasFactsV3');
var factsV1 = require('../bias/directionalContext/4hDirectionalContextFactsV1');
var semantic = require('../bias/4hBiasSemanticV3');
var biasV3 = require('../live/4hBiasV3');
var decisionStoreV1 = require('../bias/4hBiasDecisionStoreV1');
var context = require('../notify/4hBiasContext');
var eqNotification = require('../notify/eqFvgCountWatchNotificationV1');
var rangeNotification = require('../notify/rangeNotificationV1');
var watchModel = require('../live/eqFvgCountWatchV1');

var H4 = 4 * 60 * 60 * 1000;

function candles(count) {
    return Array.from({length:count}, function (_, i) {
        var open = 10000 + i * 7 + Math.sin(i / 4) * 80;
        var close = open + Math.sin(i / 3) * 35 + 2;
        return {openTime:i*H4,closeTime:(i+1)*H4-1,open:open,
            high:Math.max(open,close)+30+(i%5),low:Math.min(open,close)-25-(i%3),
            close:close,closed:true,source:'futures'};
    });
}

function decision(direction) {
    return {direction:direction||'BULLISH',strength:'MODERATE',confidence:'HIGH',
        summary:'当前方向事实总体一致。',conflicts:'NONE'};
}

function compactFacts(symbol, closeTime) {
    return {version:factsV3.VERSION,symbol:symbol,timeframe:'4h',closedAt:closeTime,
        facts:{normalizedDirectionalSpread:.2,adx14:18,signedMoveAtr24:1.1,
            signedEfficiency24:.3,theilSenSlope48:.001,structureDirection:'UP'}};
}

function lightweightService(symbol, source, request, extra) {
    return biasV3.createService(Object.assign({symbol:symbol,getFourHourCandles:function(){return source;},
        buildFacts:function(cs,at){return compactFacts(symbol,at);},requestSemantic:request||function(){return Promise.resolve(decision());},
        decisionStore:decisionStoreV1.createMemoryStore()},extra||{}));
}

function referenceDmi(candles0, p, ap) {
    var n=candles0.length,tr=new Array(n).fill(null),plusDm=new Array(n).fill(0),minusDm=new Array(n).fill(0),plusDi=new Array(n).fill(null),minusDi=new Array(n).fill(null),dx=new Array(n).fill(null),adx=new Array(n).fill(null);
    for(var i=1;i<n;i++){tr[i]=leg.trueRange(candles0[i],candles0[i-1].close);var up=candles0[i].high-candles0[i-1].high,down=candles0[i-1].low-candles0[i].low;plusDm[i]=up>down&&up>0?up:0;minusDm[i]=down>up&&down>0?down:0;}
    var st=0,sp=0,sm=0;for(i=1;i<=p;i++){st+=tr[i];sp+=plusDm[i];sm+=minusDm[i];}
    function set(k){plusDi[k]=st===0?0:100*sp/st;minusDi[k]=st===0?0:100*sm/st;var d=plusDi[k]+minusDi[k];dx[k]=d===0?0:100*Math.abs(plusDi[k]-minusDi[k])/d;}
    set(p);for(i=p+1;i<n;i++){st=st-st/p+tr[i];sp=sp-sp/p+plusDm[i];sm=sm-sm/p+minusDm[i];set(i);}
    var first=p+ap-1;if(first<n){var sum=0;for(i=p;i<=first;i++)sum+=dx[i];adx[first]=sum/ap;for(i=first+1;i<n;i++)adx[i]=(adx[i-1]*(ap-1)+dx[i])/ap;}
    return {plusDI:plusDi,minusDI:minusDi,adx:adx};
}

test('01 DMI14 exact frozen parity', function () {
    var cs=candles(160),actual=metrics.dmiAdx(cs,14,14),expected=referenceDmi(cs,14,14);
    assert.deepEqual(actual.plusDI,expected.plusDI);assert.deepEqual(actual.minusDI,expected.minusDI);
});
test('02 ADX14 exact frozen parity', function () {var cs=candles(160);assert.deepEqual(metrics.dmiAdx(cs,14,14).adx,referenceDmi(cs,14,14).adx);});
test('03 normalized DMI spread formula and zero denominator', function () {assert.equal(metrics.normalizedDirectionalSpread(30,10),.5);assert.equal(metrics.normalizedDirectionalSpread(0,0),0);});
test('04 Delivery24 reuses exact existing Production formula', function () {var cs=candles(130),atr=leg.calculateAtrWilder(cs,14);assert.deepEqual(metrics.priceDelivery(cs,atr,24),factsV1.priceDelivery(cs,atr,24));});
test('05 Delivery24 manual move parity', function () {var cs=candles(130),atr=leg.calculateAtrWilder(cs,14),x=metrics.priceDelivery(cs,atr,24),t=cs.length-1;assert.equal(x.signedMoveAtr,(cs[t].close-cs[t-24].close)/atr[t]);});
test('06 Efficiency24 manual path parity', function () {var cs=candles(130),atr=leg.calculateAtrWilder(cs,14),x=metrics.priceDelivery(cs,atr,24),t=cs.length-1,sum=0;for(var i=t-23;i<=t;i++)sum+=Math.abs(cs[i].close-cs[i-1].close);assert.equal(x.signedEfficiency,(cs[t].close-cs[t-24].close)/sum);});
test('07 Theil-Sen48 matches frozen SciPy benchmark value', function () {var closes=[80735.1,80695.9,80782.1,81381.4,81398,82177.7,80693.4,80708.9,81167.1,81403.4,81917.1,81699.1,81028.3,80809.2,80742.7,80301.6,80799.5,80461,81217.1,80981.9,80460.1,78794.7,79604.8,79288.3,79005.3,79699.9,79216.6,81245.5,81373.7,81048.9,81022.7,80782.8,80582.1,79118,79104.2,79074,79041.7,78334.3,78042.5,78194.1,78223.8,78104.2,77990.2,78137.2,78371.5,78006.9,78369,77430.4];var actual=ts.slope48(closes.map(function(close){return {close:close};}));assert.ok(Math.abs(actual-(-0.0009715344112457558))<=1e-15);});
test('08 Theil-Sen48 warmup is exactly 48', function () {assert.throws(function(){ts.slope48(candles(47));},/WARMUP/);assert.doesNotThrow(function(){ts.slope48(candles(48));});});
test('09 V3 warmup binding requirement is causal structure 120', function () {assert.equal(factsV3.MIN_WARMUP,120);});
test('10 V3 deterministic schema is exact', function () {var cs=candles(130),x=factsV3.build(cs,cs[129].closeTime,{symbol:'BTCUSDT'});assert.deepEqual(Object.keys(x.facts).sort(),semantic.FACT_FIELDS.slice().sort());});
test('11 incomplete current 4H candle is excluded', function () {var cs=candles(131);cs[130].closed=false;var x=factsV3.build(cs,cs[130].closeTime,{symbol:'BTCUSDT'});assert.equal(x.closedAt,cs[129].closeTime);});
test('12 native Futures-only gate', function () {var cs=candles(130);cs[20].source='spot';assert.throws(function(){factsV3.build(cs,cs[129].closeTime);},/NON_FUTURES/);});
test('13 structure direction parity with existing causal builder', function () {var cs=candles(130),at=cs[129].closeTime,v3=factsV3.build(cs,at),v1=factsV1.buildFacts(cs,at+1,{minimumWarmup:120});assert.equal(v3.facts.structureDirection,v1.structuralState.direction);});
test('14 prefix invariance at twenty deterministic cutoffs', function () {var cs=candles(150);for(var i=129;i<149;i++){var at=cs[i].closeTime;assert.deepEqual(factsV3.build(cs.slice(0,i+1),at),factsV3.build(cs,at));}});
test('15 semantic input has only exact authorized fields', function () {var input=semantic.buildInput(compactFacts('BTCUSDT',123));assert.deepEqual(Object.keys(input).sort(),['closedAt','facts','symbol','timeframe']);assert.deepEqual(Object.keys(input.facts).sort(),semantic.FACT_FIELDS.slice().sort());});
test('16 semantic input contains no raw OHLC, 6/12, EQ, WATCH, Persistence, Transition, or Kalman', function () {var text=JSON.stringify(semantic.buildInput(compactFacts('BTCUSDT',123)));assert.doesNotMatch(text,/raw|ohlc|candle|bars6|bars12|EQL|EQH|FVG|WATCH|persistence|transition|kalman/i);});
test('17 prompt says ADX has no direction', function () {assert.match(semantic.SYSTEM_PROMPT,/ADX has no bullish or bearish direction/);});
test('18 prompt governs sign versus magnitude', function () {assert.match(semantic.SYSTEM_PROMPT,/sign contributes to Direction and the magnitude contributes to Strength/);});
test('19 prompt governs correlated Delivery family', function () {assert.match(semantic.SYSTEM_PROMPT,/correlated members of one Delivery family/);assert.match(semantic.SYSTEM_PROMPT,/Do not double-count/);});
test('20 prompt forbids hard strength threshold and composite scores', function () {assert.match(semantic.SYSTEM_PROMPT,/Do not use hard Strength thresholds/);assert.match(semantic.SYSTEM_PROMPT,/composite scores/);});
test('21 prompt forbids future, Transition, Persistence, candles, and advice', function () {['Transition','Persistence','future price','next candle','trading advice','candlestick patterns'].forEach(function(x){assert.ok(semantic.SYSTEM_PROMPT.includes(x),x);});});
test('22 semantic output contract is exact', function () {assert.deepEqual(semantic.validateOutput(decision()),decision());assert.throws(function(){semantic.validateOutput(Object.assign({extra:true},decision()));},/SCHEMA/);});
test('23 same 4H never rebuilds or recalls LLM', async function () {var cs=candles(2),svc=lightweightService('BTCUSDT',cs);var first=await svc.refresh(cs[1].closeTime);for(var i=0;i<20;i++)assert.strictEqual(await svc.refresh(cs[1].closeTime+1000+i),first);assert.deepEqual(svc.getStats(),{biasBuildCount:1,llmCallCount:1});});
test('24 new fully closed 4H replaces snapshot once', async function () {var cs=candles(2),svc=lightweightService('BTCUSDT',cs);var first=await svc.refresh(cs[1].closeTime);cs.push(candles(3)[2]);var second=await svc.refresh(cs[2].closeTime);assert.notStrictEqual(second,first);assert.equal(second.closedAt,cs[2].closeTime);assert.deepEqual(svc.getStats(),{biasBuildCount:2,llmCallCount:2});});
test('25 in-flight same-key refresh dedupes one LLM call', async function () {var cs=candles(2),resolve,calls=0,svc=lightweightService('BTCUSDT',cs,function(){calls++;return new Promise(function(r){resolve=r;});});var a=svc.refresh(cs[1].closeTime),b=svc.refresh(cs[1].closeTime);await Promise.resolve();assert.equal(calls,1);resolve(decision());assert.strictEqual(await a,await b);assert.equal(calls,1);});
test('26 per-symbol services are isolated', async function () {var cs=candles(2),a=lightweightService('BTCUSDT',cs),b=lightweightService('ZECUSDT',cs);await a.refresh(cs[1].closeTime);assert.ok(a.getCurrent());assert.equal(b.getCurrent(),null);});
test('27 authoritative snapshot is deeply immutable', async function () {var cs=candles(2),x=await lightweightService('BTCUSDT',cs).refresh(cs[1].closeTime);assert.equal(Object.isFrozen(x),true);assert.equal(Object.isFrozen(x.facts),true);assert.equal(Object.isFrozen(x.semantic),true);});
test('28 LLM failure yields PARTIAL and retains facts', async function () {var cs=candles(2),x=await lightweightService('BTCUSDT',cs,function(){return Promise.reject(new Error('timeout'));}).refresh(cs[1].closeTime);assert.equal(x.status,'PARTIAL');assert.ok(x.facts);assert.equal(x.semantic,null);});
test('29 deterministic failure yields UNAVAILABLE and does not call LLM', async function () {var cs=candles(2),calls=0,svc=lightweightService('BTCUSDT',cs,function(){calls++;return decision();},{buildFacts:function(){throw Object.assign(new Error('short'),{code:'INSUFFICIENT_WARMUP'});}}),x=await svc.refresh(cs[1].closeTime);assert.equal(x.status,'UNAVAILABLE');assert.equal(x.facts,null);assert.equal(calls,0);});
test('30 available notification separates frozen semantic decision from deterministic facts', function () {var b={status:'AVAILABLE',semantic:decision(),facts:compactFacts('BTCUSDT',123).facts},text=context.lines(b).join('\n');assert.match(text,/📊 4H Bias/);assert.match(text,/方向:/);assert.match(text,/Deterministic Facts:/);assert.match(text,/ADX14: 18/);assert.doesNotMatch(text,/当前方向事实总体一致|解读:|冲突:/);});
test('31 PARTIAL and UNAVAILABLE are fail-open presentation states', function () {assert.deepEqual(context.lines({status:'PARTIAL'}),['📊 4H Bias','语义解析暂不可用']);assert.deepEqual(context.lines({status:'UNAVAILABLE'}),['📊 4H Bias','暂不可用']);});
test('32 EQ notification uses notification-time current snapshot', function () {var event={symbol:'BTCUSDT',liquidityType:'EQL',liquidityPrice:100,expectedDirection:'BULLISH',eqConfirmedAt:1,eqSourceContext:null,ordinal:1,rawFvg:{direction:'BULLISH',low:101,high:102,confirmedAt:2},watchStatusAfterEvent:'OPEN'},old=context.attach(event,{status:'AVAILABLE',semantic:decision('BEARISH')}),latest=context.attach(event,{status:'AVAILABLE',semantic:decision('BULLISH')});assert.match(eqNotification.build(latest),/BULLISH/);assert.notEqual(eqNotification.build(old),eqNotification.build(latest));});
test('33 Range notification carries common 4H Bias', function () {var event=context.attach({symbol:'BTCUSDT',lower:1,upper:2,midpoint:1.5,widthPct:1,visualStartAt:1,confirmedAt:2},{status:'AVAILABLE',semantic:decision()});assert.match(rangeNotification.buildRangeConfirmationMessage(event),/📊 4H Bias/);});
test('34 the live entry gate is direction-only and the surviving emitter attaches the current Bias', function () {
    var source=fs.readFileSync(path.join(__dirname,'../scripts/live.js'),'utf8');
    // The remaining DingTalk emitter still attaches the authoritative 4H snapshot.
    var start=source.indexOf('function sendRangeConfirmation'),end=source.indexOf('\n    function ',start+20);
    assert.match(source.slice(start,end<0?source.length:end),/notificationMarketContext\.attach\(event, current4hBias\.getCurrent\(\)\)/);
    // The retired EQ-FVG emitter is no longer part of the live call graph.
    assert.strictEqual(source.indexOf('sendEqFvgNotification')>=0,false);
    // TWO_BAR_PRODUCTION_REPLACEMENT_V1 §33: DIRECTION ONLY admission. Strength and
    // confidence are recorded on the plan but can never gate an entry.
    var entryRules=require('../execution/breakoutEntryRulesV1');
    function gate(direction,d,strength,confidence){
        return entryRules.htfDirectionGate(direction,{status:'AVAILABLE',closedAt:1,expectedClosedAt:1,
            semantic:{direction:d,strength:strength,confidence:confidence}});
    }
    assert.strictEqual(gate('LONG','BULLISH','WEAK','LOW').ok,true);
    assert.strictEqual(gate('SHORT','BEARISH','WEAK','LOW').ok,true);
    assert.strictEqual(gate('LONG','BEARISH','WEAK','LOW').reasonCode,'HTF_NOT_ALIGNED');
    assert.strictEqual(gate('SHORT','BULLISH','WEAK','LOW').reasonCode,'HTF_NOT_ALIGNED');
    assert.strictEqual(gate('LONG','BULLISH','STRONG','HIGH').ok,true);
    assert.strictEqual(gate('LONG','NO_PRIORITY','STRONG','HIGH').reasonCode,'HTF_NEUTRAL');
    var live=source;
    assert.doesNotMatch(live,/HTF_STRENGTH_REQUIRED\s*=\s*true|HTF_CONFIDENCE_REQUIRED\s*=\s*true/);
});
test('35 WATCH control output is independent of Bias payload', function () {function run(extra){var m=watchModel.createStateMachine(),eq=Object.assign({id:'EQ',symbol:'BTCUSDT',type:'EQL',price:100,confirmedAt:10,metadata:{}},extra||{});m.step({newEqualLiquidity:[eq],rawFvg:{id:'F1',direction:'BULLISH',confirmedAt:10,low:101,high:102}});m.step({newEqualLiquidity:[],rawFvg:{id:'F2',direction:'BULLISH',confirmedAt:11,low:102,high:103}});return m.getAll();}assert.deepEqual(run(),run({current4hBias:{status:'AVAILABLE'}}));});
test('36 restored WATCH discards historical frozen V2 context', function () {var eq={id:'EQ',symbol:'BTCUSDT',type:'EQL',price:100,confirmedAt:10,metadata:{}},m=watchModel.createStateMachine();m.step({newEqualLiquidity:[eq],rawFvg:null});var saved=m.getAll()[0];saved.researchContext4hV2={direction:'BEARISH'};var restored=watchModel.createStateMachine({watches:[saved]}).getAll()[0];assert.equal(Object.prototype.hasOwnProperty.call(restored,'researchContext4hV2'),false);});
test('37 active V3 runtime has no legacy runtime imports or raw-candle semantic payload', function () {var files=['../scripts/live.js','../live/4hBiasV3.js','../bias/4hBiasSemanticV3.js','../notify/4hBiasContext.js'];var source=files.map(function(f){return fs.readFileSync(path.join(__dirname,f),'utf8');}).join('\n');assert.doesNotMatch(source,/dailyBiasService|eq4hDirectionalContextV2|rawOhlc32|recentCandles|bars6|bars12|Kalman/);});
test('38 data failure replaces prior snapshot instead of presenting it as current', async function () {var cs=candles(2),broken=false,svc=lightweightService('BTCUSDT',cs,null,{getFourHourCandles:function(){if(broken)throw Object.assign(new Error('offline'),{code:'OFFLINE'});return cs;}});await svc.refresh(cs[1].closeTime);broken=true;var x=await svc.refresh(cs[1].closeTime+1);assert.equal(x.status,'UNAVAILABLE');assert.strictEqual(svc.getCurrent(),x);});
test('39 multiple notifications in one 4H reference the same snapshot identity', async function () {var cs=candles(2),svc=lightweightService('BTCUSDT',cs),bias=await svc.refresh(cs[1].closeTime),a=context.attach({id:'A'},svc.getCurrent()),b=context.attach({id:'B'},svc.getCurrent());assert.strictEqual(a.current4hBias,b.current4hBias);assert.strictEqual(a.current4hBias,bias);});
test('40 synchronous DeepSeek client failure also degrades to PARTIAL', async function () {var cs=candles(2),svc=lightweightService('BTCUSDT',cs,function(){throw Object.assign(new Error('missing key'),{code:'MISSING_API_KEY'});}),x=await svc.refresh(cs[1].closeTime);assert.equal(x.status,'PARTIAL');assert.equal(x.error.code,'MISSING_API_KEY');assert.ok(x.facts);});
test('41 observation log is one flat structured record per new 4H snapshot', async function () {var cs=candles(2),records=[],svc=lightweightService('BTCUSDT',cs,null,{observe:function(record){records.push(record);},now:function(){return 12345;}}),first=await svc.refresh(cs[1].closeTime);await svc.refresh(cs[1].closeTime+1000);assert.equal(records.length,1);assert.deepEqual(Object.keys(records[0]).sort(),['buildDurationMs','closedAt','confidence','decisionKey','decisionSource','direction','facts','factsHash','generatedAt','llmDurationMs','modelId','promptHash','promptVersion','status','strength','symbol']);assert.equal(records[0].generatedAt,first.generatedAt);assert.equal(records[0].direction,'BULLISH');assert.equal(records[0].strength,'MODERATE');assert.equal(records[0].confidence,'HIGH');assert.deepEqual(records[0].facts,first.facts);});
