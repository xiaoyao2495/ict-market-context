'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var sourceModel = require('../live/eqSourceContextV1');
var contextModel = require('../live/eq4hDirectionalContextV2');
var watchModel = require('../live/eqFvgCountWatchV1');
var alertService = require('../live/eqFvgCountWatchAlertServiceV1');
var notification = require('../notify/eqFvgCountWatchNotificationV1');
var factsModule = require('../bias/directionalContext/4hDirectionalContextFactsV1');

var FOUR_HOURS = 4 * 60 * 60 * 1000;

function partner(n, occurredAt, confirmedAt) {
    return {id:'LOW:partner:' + n,source:'productionSwing',price:100 + n,
        occurredAt:occurredAt,confirmedAt:confirmedAt,sourceIndex:n};
}

function equalLiquidity(type, partners, confirmedAt) {
    var at = confirmedAt || 5000000;
    return {
        id:'EQ:' + type + ':' + at,symbol:'BTCUSDT',timeframe:'5m',type:type,
        liquidityType:type,price:type === 'EQL' ? 100 : 110,confirmedAt:at,
        metadata:{
            currentPivot:{id:'LOW:current',source:'productionSwing',price:100.2,
                occurredAt:at - 300000,confirmedAt:at,sourceIndex:99},
            historicalPartners:partners || [partner(1,at - 1200000,at - 900000)],
            partnerCount:(partners || [1]).length,
            primaryPartnerSelection:false
        }
    };
}

function rawFvg(direction, n, confirmedAt) {
    return {id:'FVG:' + direction + ':' + n,symbol:'BTCUSDT',timeframe:'5m',
        direction:direction,low:120 + n,high:121 + n,confirmedAt:confirmedAt || 6000000 + n};
}

function available(direction, evaluationTime) {
    return contextModel.availableContext(evaluationTime || 5000000, 4000000, {
        direction:direction || 'BULLISH',confidence:'MEDIUM',dominantFacts:['delivery'],
        conflictingFacts:['minor'],stateInterpretation:'coherent',
        whatWouldChangeTheAssessment:['opposite delivery']
    });
}

function decision(direction) {
    return {direction:direction || 'BULLISH',confidence:'MEDIUM',dominantFacts:['d'],
        conflictingFacts:['c'],stateInterpretation:'s',whatWouldChangeTheAssessment:['w']};
}

function nativeCandles(count, endOpenTime) {
    var end = endOpenTime === undefined ? (count - 1) * FOUR_HOURS : endOpenTime;
    var start = end - (count - 1) * FOUR_HOURS;
    return Array.from({length:count}, function (_, i) {
        var openTime = start + i * FOUR_HOURS;
        var open = 10000 + i * 2 + Math.sin(i / 5) * 20;
        var close = open + Math.sin(i / 3) * 8 + 1;
        return {openTime:openTime,closeTime:openTime + FOUR_HOURS - 1,
            open:open,high:Math.max(open,close) + 10,low:Math.min(open,close) - 10,
            close:close,closed:true,source:'futures'};
    });
}

function serviceFor(candles, extra) {
    var opts = Object.assign({symbol:'BTCUSDT',getFourHourCandles:function(){return candles;},
        requestDecision:function(){return Promise.resolve(decision());}}, extra || {});
    return contextModel.createService(opts);
}

function stripResearch(watch) {
    var copy = JSON.parse(JSON.stringify(watch));
    delete copy.researchContext4hV2;
    return copy;
}

test('SRC-01 one historical partner and current pivot are preserved exactly', function () {
    var eq=equalLiquidity('EQL'), out=sourceModel.fromLiquidity(eq);
    assert.deepEqual(out.currentPivot,eq.metadata.currentPivot);
    assert.deepEqual(out.historicalPartners,eq.metadata.historicalPartners);
});
test('SRC-02 two historical partners are preserved exactly', function () {
    var ps=[partner(1,100,200),partner(2,300,400)],eq=equalLiquidity('EQL',ps,500);
    assert.deepEqual(sourceModel.fromLiquidity(eq).historicalPartners,ps);
});
test('SRC-03 three or more partners are not truncated', function () {
    var ps=[partner(1,10,20),partner(2,30,40),partner(3,50,60),partner(4,70,80)];
    assert.equal(sourceModel.fromLiquidity(equalLiquidity('EQL',ps,100)).historicalPartners.length,4);
});
test('SRC-04 primary partner selection remains false', function () {
    assert.equal(sourceModel.fromLiquidity(equalLiquidity('EQL')).primaryPartnerSelection,false);
});
test('SRC-05 no source pair or duplicate identity is invented', function () {
    var eq=equalLiquidity('EQL'),out=sourceModel.fromLiquidity(eq);
    assert.deepEqual([out.currentPivot.id].concat(out.historicalPartners.map(function(x){return x.id;})),
        [eq.metadata.currentPivot.id].concat(eq.metadata.historicalPartners.map(function(x){return x.id;})));
    assert.equal(Object.prototype.hasOwnProperty.call(out,'point1'),false);
});
test('SRC-06 current point display uses occurredAt', function () {
    var eq=equalLiquidity('EQL'),watch=watchModel.buildWatch(eq),event={eqSourceContext:watch.eqSourceContext,eqConfirmedAt:eq.confirmedAt};
    var lines=notification.sourceContextLines(event,String,String).join('\n');
    assert.match(lines,new RegExp('Current Point: ' + eq.metadata.currentPivot.occurredAt));
});
test('SRC-07 every partner display uses occurredAt', function () {
    var ps=[partner(1,101,201),partner(2,301,401)],eq=equalLiquidity('EQL',ps,500);
    var lines=notification.sourceContextLines({eqSourceContext:sourceModel.fromLiquidity(eq),eqConfirmedAt:500},String,String).join('\n');
    assert.match(lines,/Partner #1: 101/); assert.match(lines,/Partner #2: 301/);
});
test('SRC-08 source confirmedAt is not displayed as occurrence time', function () {
    var eq=equalLiquidity('EQL',[partner(1,101,987654)],1000000);
    var lines=notification.sourceContextLines({eqSourceContext:sourceModel.fromLiquidity(eq),eqConfirmedAt:eq.confirmedAt},String,String).join('\n');
    assert.doesNotMatch(lines,/987654/);
});
test('SRC-09 partner display sort is chronological only', function () {
    var eq=equalLiquidity('EQL',[partner(3,300,310),partner(1,100,110),partner(2,200,210)],500);
    assert.deepEqual(sourceModel.historicalPartnersForDisplay(sourceModel.fromLiquidity(eq)).map(function(p){return p.occurredAt;}),[100,200,300]);
});
test('SRC-10 presentation sorting does not mutate detector metadata', function () {
    var ps=[partner(2,200,210),partner(1,100,110)],eq=equalLiquidity('EQL',ps,500),before=JSON.stringify(eq.metadata);
    sourceModel.historicalPartnersForDisplay(sourceModel.fromLiquidity(eq));
    assert.equal(JSON.stringify(eq.metadata),before);
});
test('SRC-11 full source set is frozen into WATCH', function () {
    var eq=equalLiquidity('EQL',[partner(1,100,200),partner(2,300,400)],500),watch=watchModel.buildWatch(eq);
    eq.metadata.historicalPartners.pop();
    assert.equal(watch.eqSourceContext.historicalPartners.length,2);
});
test('SRC-12 FVG one and two retain identical frozen sources', function () {
    var eq=equalLiquidity('EQL'),m=watchModel.createStateMachine();
    var one=m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)}).notifications[0];
    var two=m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',2,eq.confirmedAt+1)}).notifications[0];
    assert.deepEqual(one.eqSourceContext,two.eqSourceContext);
});
test('SRC-13 persist and reload preserve exact source set', function () {
    var eq=equalLiquidity('EQL'),svc=alertService.createService(); svc.onStep({newEqualLiquidity:[eq],rawFvg:null});
    var saved=svc.snapshot(),reloaded=alertService.createService(saved).snapshot();
    assert.deepEqual(reloaded.watches[0].eqSourceContext,saved.watches[0].eqSourceContext);
});
test('SRC-14 legacy WATCH without source context loads safely', function () {
    var watch=watchModel.buildWatch(equalLiquidity('EQL')); delete watch.eqSourceContext;
    var m=watchModel.createStateMachine({watches:[watch]});
    assert.doesNotThrow(function(){m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',1,watch.openedAt)});});
});
test('SRC-15 legacy WATCH receives no invented source backfill', function () {
    var watch=watchModel.buildWatch(equalLiquidity('EQL')); delete watch.eqSourceContext;
    var m=watchModel.createStateMachine({watches:[watch]});
    var event=m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',1,watch.openedAt)}).notifications[0];
    assert.equal(event.eqSourceContext.status,'UNAVAILABLE'); assert.equal(event.eqSourceContext.currentPivot,null);
});
test('SRC-16 every frozen source satisfies causal ordering', function () {
    var eq=equalLiquidity('EQL',[partner(1,100,200),partner(2,300,400)],500),ctx=sourceModel.fromLiquidity(eq);
    assert.equal(sourceModel.sourceIsCausal(ctx.currentPivot,500),true);
    assert.equal(ctx.historicalPartners.every(function(p){return sourceModel.sourceIsCausal(p,500);}),true);
});
test('SRC-17 a partner confirmed after EQ is rejected', function () {
    var ctx=sourceModel.fromLiquidity(equalLiquidity('EQL',[partner(1,100,501)],500));
    assert.equal(ctx.status,'UNAVAILABLE'); assert.equal(ctx.errorCode,'EQ_SOURCE_CAUSALITY_INVALID');
});
test('SRC-18 notification layer contains no source rediscovery input', function () {
    var source=fs.readFileSync(path.join(__dirname,'../notify/eqFvgCountWatchNotificationV1.js'),'utf8');
    assert.doesNotMatch(source,/structureCandles|calendarCandles|fetcher|tickSize|priceTolerance/);
});
test('SRC-19 UTC to UTC+8 conversion occurs exactly once', function () {
    var at=Date.UTC(2026,8,6,11,35),eq=equalLiquidity('EQL',[partner(1,at-300000,at-1)],at+300000);
    eq.metadata.currentPivot.occurredAt=at; eq.metadata.currentPivot.confirmedAt=at+300000;
    var event={symbol:'BTCUSDT',liquidityType:'EQL',liquidityPrice:100,
        expectedDirection:'BULLISH',eqSourceContext:sourceModel.fromLiquidity(eq),
        eqConfirmedAt:eq.confirmedAt,researchContext4hV2:contextModel.unavailable(eq.confirmedAt,'X'),
        ordinal:1,rawFvg:rawFvg('BULLISH',1,eq.confirmedAt),watchStatusAfterEvent:'OPEN'};
    var line=notification.build(event).split('\n').filter(function(value){return /^Current Point:/.test(value);})[0];
    assert.equal(line,'Current Point: 2026-09-06 19:35 (UTC+8) @ 100.2');
});
test('SRC-20 rendered partner count equals exact array length', function () {
    var eq=equalLiquidity('EQL',[partner(1,100,200),partner(2,300,400),partner(3,410,420)],500);
    assert.ok(notification.sourceContextLines({eqSourceContext:sourceModel.fromLiquidity(eq),eqConfirmedAt:500},String,String).includes('Historical Partners: 3'));
});

test('CTX-01 unavailable V2 does not gate WATCH creation', function () {
    var eq=equalLiquidity('EQL'),cs=nativeCandles(320);
    eq.researchContext4hV2=serviceFor(cs).peek(eq.confirmedAt);
    assert.equal(eq.researchContext4hV2.status,'UNAVAILABLE');
    assert.equal(watchModel.createStateMachine().step({newEqualLiquidity:[eq],rawFvg:null}).opened.length,1);
});
test('CTX-02 V2 cannot alter expected direction', function () {
    ['EQL','EQH'].forEach(function(t){var eq=equalLiquidity(t);eq.researchContext4hV2=available(t==='EQL'?'BEARISH':'BULLISH',eq.confirmedAt);
        assert.equal(watchModel.buildWatch(eq).expectedDirection,t==='EQL'?'BULLISH':'BEARISH');});
});
test('CTX-03 V2 cannot alter raw FVG detection', function () {
    var cs=[{openTime:0,closeTime:1,high:100,low:90},{},{openTime:2,closeTime:3,high:110,low:101,closed:true}];
    assert.equal(watchModel.rawFvgAt(cs,2,'BTCUSDT').direction,'BULLISH');
});
test('CTX-04 available and unavailable V2 produce identical FVG counts', function () {
    function run(ctx){var eq=equalLiquidity('EQL');eq.researchContext4hV2=ctx;var m=watchModel.createStateMachine();m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)});return stripResearch(m.getAll()[0]);}
    assert.deepEqual(run(available('BULLISH')),run(contextModel.unavailable(5000000,'FAIL')));
});
test('CTX-05 available and unavailable V2 produce identical ordinals', function () {
    function run(ctx){var eq=equalLiquidity('EQL');eq.researchContext4hV2=ctx;var m=watchModel.createStateMachine(),out=[];out=out.concat(m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)}).notifications);out=out.concat(m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',2,eq.confirmedAt+1)}).notifications);return out.map(function(e){return e.ordinal;});}
    assert.deepEqual(run(available('BULLISH')),run(contextModel.unavailable(5000000,'FAIL')));
});
test('CTX-06 available and unavailable V2 close WATCH identically', function () {
    function run(ctx){var eq=equalLiquidity('EQH');eq.researchContext4hV2=ctx;var m=watchModel.createStateMachine();m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BEARISH',1,eq.confirmedAt)});m.step({newEqualLiquidity:[],rawFvg:rawFvg('BEARISH',2,eq.confirmedAt+1)});return stripResearch(m.getAll()[0]);}
    assert.deepEqual(run(available('BEARISH')),run(contextModel.unavailable(5000000,'FAIL')));
});
test('CTX-07 available and unavailable V2 preserve notification eligibility and dedup keys', function () {
    function run(ctx){var eq=equalLiquidity('EQL');eq.researchContext4hV2=ctx;var m=watchModel.createStateMachine();return m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)}).notifications.map(alertService.notificationKey);}
    assert.deepEqual(run(available('BEARISH')),run(contextModel.unavailable(5000000,'FAIL')));
});
test('CTX-08 DeepSeek failure is fail-open', async function () {
    var cs=nativeCandles(320),ctx=await serviceFor(cs,{requestDecision:function(){return Promise.reject(new Error('timeout'));}}).resolve(cs[319].closeTime+1);
    assert.equal(ctx.status,'UNAVAILABLE');
});
test('CTX-09 4H load failure is fail-open', async function () {
    var ctx=await contextModel.createService({symbol:'BTCUSDT',getFourHourCandles:function(){throw new Error('offline');}}).resolve(1);
    assert.equal(ctx.status,'UNAVAILABLE');
});
test('CTX-10 19:39 EQ cannot see the 20:00 closing 4H candle', async function () {
    var cutoff=Date.UTC(2026,8,6,11,39),cs=nativeCandles(320,Date.UTC(2026,8,6,8,0)),seen;
    var ctx=await serviceFor(cs,{requestDecision:function(f){seen=f;return decision();}}).resolve(cutoff);
    assert.equal(ctx.status,'AVAILABLE'); assert.equal(Date.parse(seen.latestClosedCandleCloseTime),Date.UTC(2026,8,6,8,0)-1);
});
test('CTX-11 evaluationTime is exactly EQ confirmedAt', async function () {
    var cs=nativeCandles(320),at=cs[319].closeTime+1,ctx=await serviceFor(cs).resolve(at);
    assert.equal(ctx.evaluationTime,at);
});
test('CTX-12 FVG one does not refresh frozen context', function () {
    var eq=equalLiquidity('EQL');eq.researchContext4hV2=available('BULLISH',eq.confirmedAt);var m=watchModel.createStateMachine();m.step({newEqualLiquidity:[eq],rawFvg:null});var before=m.getAll()[0].researchContext4hV2;
    m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)});assert.deepEqual(m.getAll()[0].researchContext4hV2,before);
});
test('CTX-13 FVG two does not refresh frozen context', function () {
    var eq=equalLiquidity('EQL');eq.researchContext4hV2=available('BULLISH',eq.confirmedAt);var m=watchModel.createStateMachine();m.step({newEqualLiquidity:[eq],rawFvg:rawFvg('BULLISH',1,eq.confirmedAt)});var before=m.getAll()[0].researchContext4hV2;
    m.step({newEqualLiquidity:[],rawFvg:rawFvg('BULLISH',2,eq.confirmedAt+1)});assert.deepEqual(m.getAll()[0].researchContext4hV2,before);
});
test('CTX-14 later 4H result cannot mutate WATCH context', function () {
    var ctx=available('BULLISH'),eq=equalLiquidity('EQL');eq.researchContext4hV2=ctx;var watch=watchModel.buildWatch(eq);ctx.direction='BEARISH';assert.equal(watch.researchContext4hV2.direction,'BULLISH');
});
test('CTX-15 causal cache reuse', async function () {
    var cs=nativeCandles(320),calls=0,svc=serviceFor(cs,{requestDecision:function(){calls++;return decision();}}),at=cs[319].closeTime+1;
    await svc.resolve(at);await svc.resolve(at+60000);assert.equal(calls,1);assert.equal(svc.peek(at+60000).status,'AVAILABLE');
});
test('CTX-16 cache cannot leak a later evaluation backward', async function () {
    var cs=nativeCandles(320),calls=0,svc=serviceFor(cs,{requestDecision:function(){calls++;return decision();}}),at=cs[319].closeTime+1;
    await svc.resolve(at+60000);await svc.resolve(at);assert.equal(calls,2);
});
test('CTX-17 EQL bullish is aligned', function () { assert.equal(contextModel.alignment(available('BULLISH'),'BULLISH'),'ALIGNED'); });
test('CTX-18 EQL bearish is conflict', function () { assert.equal(contextModel.alignment(available('BEARISH'),'BULLISH'),'CONFLICT'); });
test('CTX-19 EQH bearish is aligned', function () { assert.equal(contextModel.alignment(available('BEARISH'),'BEARISH'),'ALIGNED'); });
test('CTX-20 EQH bullish is conflict', function () { assert.equal(contextModel.alignment(available('BULLISH'),'BEARISH'),'CONFLICT'); });
test('CTX-21 no priority alignment', function () { assert.equal(contextModel.alignment(available('NO_PRIORITY'),'BULLISH'),'NO_PRIORITY'); });
test('CTX-22 unavailable alignment is unknown', function () { assert.equal(contextModel.alignment(contextModel.unavailable(1,'X'),'BULLISH'),'UNKNOWN'); });
test('CTX-23 frozen prompt hash parity', function () { assert.equal(contextModel.actualPromptHash(),contextModel.PROMPT_HASH); });
test('CTX-24 exact fact schema parity', async function () {
    var cs=nativeCandles(320),seen,at=cs[319].closeTime+1;await serviceFor(cs,{requestDecision:function(f){seen=f;return decision();}}).resolve(at);
    assert.equal(seen.schemaVersion,'LLM_INPUT_FACT_SET_V1');assert.equal(seen.rawOhlc32.length,32);
    assert.deepEqual(Object.keys(seen.priceDelivery),['bars6','bars12','bars24']);
});
test('CTX-25 native Binance USD-M futures 4H only', async function () {
    var cs=nativeCandles(320);cs[10].source='spot';var ctx=await serviceFor(cs).resolve(cs[319].closeTime+1);
    assert.equal(ctx.status,'UNAVAILABLE');assert.equal(ctx.errorCode,'FOUR_HOUR_DATA_INVALID');
});
test('CTX-26 only closed 4H candles enter facts', async function () {
    var cs=nativeCandles(321);cs[320].closed=false;var seen,ctx=await serviceFor(cs,{requestDecision:function(f){seen=f;return decision();}}).resolve(cs[320].closeTime+1);
    assert.equal(ctx.status,'AVAILABLE');assert.equal(Date.parse(seen.latestClosedCandleCloseTime),cs[319].closeTime);
});
test('CTX-27 frozen facts have prefix invariance', function () {
    var cs=nativeCandles(321),at=cs[319].closeTime+1;
    assert.deepEqual(factsModule.buildFacts(cs.slice(0,320),at,{symbol:'BTCUSDT'}),factsModule.buildFacts(cs,at,{symbol:'BTCUSDT'}));
});
test('CTX-28 no EQ source or FVG facts enter LLM input', async function () {
    var cs=nativeCandles(320),seen;await serviceFor(cs,{requestDecision:function(f){seen=f;return decision();}}).resolve(cs[319].closeTime+1);
    assert.doesNotMatch(JSON.stringify(seen),/EQL|EQH|currentPivot|historicalPartners|partnerCount|expectedDirection|FVG|WATCH|Taken|Sweep|Displacement|PnL|5m/);
});
