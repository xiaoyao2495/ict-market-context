'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var watchModel = require('../live/eqFvgCountWatchV1');
var alertService = require('../live/eqFvgCountWatchAlertServiceV1');
var notification = require('../notify/eqFvgCountWatchNotificationV1');
var replayState = require('../replay/replayState');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');

var BAR = 300000;

function eq(type, id, at) {
    return {
        id: id || 'EQ:' + type,
        symbol: 'BTCUSDT', timeframe: '5m', type: type, liquidityType: type,
        price: type === 'EQL' ? 77280 : 78120,
        confirmedAt: at === undefined ? 10 * BAR - 1 : at,
        metadata: { currentPivot: { price: type === 'EQL' ? 77280 : 78120 } }
    };
}
function fvg(direction, n, at) {
    return {
        id: 'F:' + direction + ':' + n, symbol: 'BTCUSDT', timeframe: '5m', direction: direction,
        low: direction === 'BULLISH' ? 77310 + n : 77900 - n,
        high: direction === 'BULLISH' ? 77345 + n : 77940 - n,
        confirmedAt: at === undefined ? (10 + n) * BAR - 1 : at
    };
}
function step(machine, equal, raw) {
    return machine.step({ evaluationTime: raw ? raw.confirmedAt : equal[0].confirmedAt,
        newEqualLiquidity: equal, rawFvg: raw || null });
}
function run(type, directions, gaps) {
    var machine = watchModel.createStateMachine();
    var liquidity = eq(type);
    step(machine, [liquidity], null);
    var notifications = [];
    directions.forEach(function (direction, index) {
        var at = (11 + index + ((gaps && gaps[index]) || 0)) * BAR - 1;
        notifications = notifications.concat(step(machine, [], fvg(direction, index + 1, at)).notifications);
    });
    return { watch: machine.get(watchModel.watchId(liquidity)), notifications: notifications };
}

test('raw FVG uses strict latest-three-candle formulas and touch is not a gap', function () {
    var rows = [
        {openTime:0,closeTime:BAR-1,high:100,low:90,closed:true},
        {openTime:BAR,closeTime:2*BAR-1,high:110,low:80,closed:true},
        {openTime:2*BAR,closeTime:3*BAR-1,high:120,low:101,closed:true}
    ];
    var bull = watchModel.rawFvgAt(rows, 2, 'BTCUSDT');
    assert.equal(bull.direction, 'BULLISH'); assert.equal(bull.low, 100); assert.equal(bull.high, 101);
    rows[2].low = 100; assert.equal(watchModel.rawFvgAt(rows, 2, 'BTCUSDT'), null);
    rows[0].low = 90; rows[2].low = 70; rows[2].high = 89;
    var bear = watchModel.rawFvgAt(rows, 2, 'BTCUSDT');
    assert.equal(bear.direction, 'BEARISH'); assert.equal(bear.low, 89); assert.equal(bear.high, 90);
    rows[2].high = 90; assert.equal(watchModel.rawFvgAt(rows, 2, 'BTCUSDT'), null);
});

test('EQL A opens without FVG and same-close Bull creates notification #1', function () {
    var machine = watchModel.createStateMachine(), liquidity = eq('EQL'), raw = fvg('BULLISH', 1, liquidity.confirmedAt);
    var opened = step(machine, [liquidity], null);
    assert.equal(opened.opened.length, 1); assert.equal(opened.notifications.length, 0);
    var sameStep = watchModel.createStateMachine();
    var result = step(sameStep, [liquidity], raw), watch = sameStep.get(watchModel.watchId(liquidity));
    assert.equal(watch.openedAt, raw.confirmedAt); assert.equal(watch.bullFvgCount, 1);
    assert.equal(result.notifications[0].ordinal, 1);
});

test('same-close opposite counts but historical FVG is rejected', function () {
    ['EQL','EQH'].forEach(function (type) {
        var expected = type === 'EQL' ? 'BULLISH' : 'BEARISH';
        var opposite = expected === 'BULLISH' ? 'BEARISH' : 'BULLISH';
        var liquidity = eq(type, 'EQ:SAME:' + type), machine = watchModel.createStateMachine();
        var result = step(machine, [liquidity], fvg(opposite, 1, liquidity.confirmedAt));
        assert.equal(result.notifications.length, 0);
        var watch = machine.get(watchModel.watchId(liquidity));
        assert.equal(watch[opposite === 'BULLISH' ? 'bullFvgCount' : 'bearFvgCount'], 1);
        var before = JSON.stringify(watch);
        machine.step({newEqualLiquidity:[],rawFvg:fvg(expected, 0, liquidity.confirmedAt - 1)});
        assert.equal(JSON.stringify(machine.get(watch.watchId)), before);
    });
});

test('EQL directed C-H accumulated state machine', function () {
    var c = run('EQL', ['BULLISH','BULLISH']);
    assert.equal(c.notifications.length, 2); assert.equal(c.watch.closeReason, 'SECOND_MATCHING_FVG');
    var d = run('EQL', ['BEARISH','BEARISH']);
    assert.equal(d.notifications.length, 0); assert.equal(d.watch.closeReason, 'SECOND_OPPOSITE_FVG');
    var e = run('EQL', ['BULLISH','BEARISH','BEARISH']);
    assert.equal(e.notifications.length, 1); assert.equal(e.watch.closeReason, 'SECOND_OPPOSITE_FVG');
    var f = run('EQL', ['BEARISH','BULLISH','BULLISH']);
    assert.equal(f.notifications.length, 2); assert.equal(f.watch.closeReason, 'SECOND_MATCHING_FVG');
    var g = run('EQL', ['BEARISH','BEARISH'], [0, 20]);
    assert.equal(g.watch.bearFvgCount, 2); assert.equal(g.watch.status, 'CLOSED');
    var h = run('EQL', ['BULLISH','BULLISH'], [0, 20]);
    assert.equal(h.watch.bullFvgCount, 2); assert.equal(h.watch.status, 'CLOSED');
});

test('EQH directed A-G mirror state machine', function () {
    var same = watchModel.createStateMachine(), liquidity = eq('EQH');
    assert.equal(step(same, [liquidity], fvg('BEARISH', 1, liquidity.confirmedAt)).notifications.length, 1);
    var b = run('EQH', ['BEARISH','BEARISH']); assert.equal(b.notifications.length, 2); assert.equal(b.watch.closeReason, 'SECOND_MATCHING_FVG');
    var c = run('EQH', ['BULLISH','BULLISH']); assert.equal(c.notifications.length, 0); assert.equal(c.watch.closeReason, 'SECOND_OPPOSITE_FVG');
    var d = run('EQH', ['BEARISH','BULLISH','BULLISH']); assert.equal(d.notifications.length, 1); assert.equal(d.watch.closeReason, 'SECOND_OPPOSITE_FVG');
    var e = run('EQH', ['BULLISH','BEARISH','BEARISH']); assert.equal(e.notifications.length, 2); assert.equal(e.watch.closeReason, 'SECOND_MATCHING_FVG');
    assert.equal(run('EQH', ['BEARISH','BEARISH'], [0,30]).watch.bearFvgCount, 2);
    assert.equal(run('EQH', ['BULLISH','BULLISH'], [0,30]).watch.bullFvgCount, 2);
});

test('closed WATCH is immutable and duplicate EQ/raw event cannot reopen or recount', function () {
    var machine = watchModel.createStateMachine(), liquidity = eq('EQL');
    step(machine, [liquidity], fvg('BULLISH', 1, liquidity.confirmedAt));
    step(machine, [], fvg('BULLISH', 2));
    var id = watchModel.watchId(liquidity), before = JSON.stringify(machine.get(id));
    step(machine, [liquidity], fvg('BEARISH', 3));
    assert.equal(JSON.stringify(machine.get(id)), before);
});

test('multiple EQ WATCHes consume the same raw FVG independently', function () {
    var machine = watchModel.createStateMachine(), a = eq('EQL','EQ:A'), b = eq('EQL','EQ:B');
    var result = step(machine, [a,b], fvg('BULLISH',1,a.confirmedAt));
    assert.equal(result.notifications.length, 2);
    assert.equal(machine.get(watchModel.watchId(a)).bullFvgCount, 1);
    assert.equal(machine.get(watchModel.watchId(b)).bullFvgCount, 1);
});

test('restart retains #1, opposite count, closed state, and notification delivery flags', async function () {
    var sent = [], snapshots = [], liquidity = eq('EQL');
    var service = alertService.createService({send:function(event){sent.push(event.ordinal);return Promise.resolve({errcode:0});},persist:function(s){snapshots.push(s);}});
    service.onStep({newEqualLiquidity:[liquidity],rawFvg:fvg('BULLISH',1,liquidity.confirmedAt)});
    await service.flush();
    service.onStep({newEqualLiquidity:[],rawFvg:fvg('BEARISH',1)});
    var saved = service.snapshot();
    var restarted = alertService.createService(Object.assign({}, saved, {send:function(event){sent.push(event.ordinal);return Promise.resolve({errcode:0});}}));
    restarted.onStep({newEqualLiquidity:[],rawFvg:fvg('BULLISH',2)});
    await restarted.flush();
    var watch = restarted.snapshot().watches[0];
    assert.deepEqual(sent,[1,2]); assert.equal(watch.notification1Delivered,true); assert.equal(watch.notification2Delivered,true);
    assert.equal(watch.bearFvgCount,1); assert.equal(watch.status,'CLOSED');
    var closedRestart = alertService.createService(restarted.snapshot());
    closedRestart.onStep({newEqualLiquidity:[],rawFvg:fvg('BEARISH',3)});
    assert.deepEqual(closedRestart.snapshot().watches[0],watch);
});

test('opposite restart closes without notification', function () {
    var liquidity=eq('EQL'), service=alertService.createService();
    service.onStep({newEqualLiquidity:[liquidity],rawFvg:fvg('BEARISH',1,liquidity.confirmedAt)});
    var restarted=alertService.createService(service.snapshot());
    var result=restarted.onStep({newEqualLiquidity:[],rawFvg:fvg('BEARISH',2)});
    assert.equal(result.notifications.length,0); assert.equal(restarted.snapshot().watches[0].closeReason,'SECOND_OPPOSITE_FVG');
});

test('delivery failure retries, success dedupes, replay does not resend, and #2 survives same-step close', async function () {
    var attempts=0, success=[], liquidity=eq('EQL');
    var service=alertService.createService({send:function(event){attempts++;if(attempts===1)return Promise.resolve({errcode:-1});success.push(event.ordinal);return Promise.resolve({errcode:0});}});
    var raw1=fvg('BULLISH',1,liquidity.confirmedAt);
    service.onStep({newEqualLiquidity:[liquidity],rawFvg:raw1});
    await service.flush(); assert.equal(service.snapshot().pending.length,1);
    await service.flush(); assert.deepEqual(success,[1]);
    service.onStep({newEqualLiquidity:[liquidity],rawFvg:raw1}); await service.flush();
    assert.deepEqual(success,[1]);
    service.onStep({newEqualLiquidity:[],rawFvg:fvg('BULLISH',2)});
    assert.equal(service.snapshot().watches[0].status,'CLOSED'); assert.equal(service.snapshot().pending.length,1);
    await service.flush(); assert.deepEqual(success,[1,2]); assert.equal(Object.keys(service.snapshot().delivered).length,2);
});

test('new message contains only EQ/FVG count semantics', function () {
    var event=run('EQL',['BULLISH']).notifications[0], message=notification.build(event);
    ['BTCUSDT','EQL','77280','BULLISH','FVG Ordinal: 1','FVG Low:','FVG High:','EQ确认:','FVG确认:','WATCH继续','📊 4H Bias','暂不可用'].forEach(function(value){assert.ok(message.includes(value),value);});
    assert.doesNotMatch(message,/Taken|Sweep|Displacement|FIRST_TOUCH|retracement/);
});

test('TWO_BAR_PRODUCTION_REPLACEMENT_V1: the live engine no longer emits the retired EQ/WATCH/FVG step stream', async function () {
    var original = replayState.incrementalLiquidity;
    var synthetic = eq('EQL','EQ:LIVE',3*BAR-1);
    replayState.incrementalLiquidity = function (state, candles, index, exchangeInfo, evaluationTime) {
        var swings = original(state, candles, index, exchangeInfo, evaluationTime);
        if (index === 2) state.productionEq.events.push(synthetic);
        return swings;
    };
    try {
        var engine = liveEngine.createLiveEngine({
            symbol:'BTCUSDT', exchangeInfo:{tickSize:0.1},
            structureCandles:{'4h':[],'1h':[],'1d':[]}, calendarCandles:{'1d':[],'1w':[],'1M':[]},
            fetcher:function(){return Promise.resolve([]);}, thresholds:thresholds
        });
        var candles=[
            {openTime:0,closeTime:BAR-1,open:95,high:100,low:90,close:96,closed:true,source:'futures'},
            {openTime:BAR,closeTime:2*BAR-1,open:96,high:105,low:91,close:100,closed:true,source:'futures'},
            {openTime:2*BAR,closeTime:3*BAR-1,open:101,high:110,low:101,close:108,closed:true,source:'futures'}
        ];
        for (var i=0;i<candles.length;i++) await engine.onBar(candles[i],i);
        // the retired handler/stream API is gone from the production engine
        assert.equal(typeof engine.drainEqFvgCountSteps,'undefined');
        assert.equal(typeof engine.setEqFvgCountStepHandler,'undefined');
        // the EQ registry itself still advances (structural provenance depends on it),
        // but it can no longer create a WATCH or an Entry.
        assert.equal(engine.getState().productionEq.events.some(function(e){return e.id==='EQ:LIVE';}),true);
    } finally {
        replayState.incrementalLiquidity = original;
    }
});

test('TWO_BAR_PRODUCTION_REPLACEMENT_V1: Two-Bar context aligned -> Dynamic-D EQ -> breakout planning', async function () {
    var L=require('../research/reversalPatternSemanticAuditV1');
    var twoBarSetup=require('../strategy/twoBarSetupV1');
    var entryRules=require('../execution/breakoutEntryRulesV1');
    var rows=[], close=105;
    for (var i=0;i<8;i++){var open=close;close-=0.7;
        rows.push({openTime:i*BAR,closeTime:(i+1)*BAR-1,open:open,high:open+0.2,low:close-0.3,close:close,closed:true,source:'futures'});}
    rows.push({openTime:8*BAR,closeTime:9*BAR-1,open:100.6,high:100.8,low:99.2,close:99.4,closed:true,source:'futures'});
    rows.push({openTime:9*BAR,closeTime:10*BAR-1,open:99.4,high:100.9,low:99.0,close:100.8,closed:true,source:'futures'});
    for (var j=10;j<20;j++){var prev=rows[j-1].close;
        rows.push({openTime:j*BAR,closeTime:(j+1)*BAR-1,open:prev,high:prev+0.5,low:prev-0.2,close:prev+0.4,closed:true,source:'futures'});}
    var k1=rows[8], k2=rows[9];
    var candidate={pattern:'TWO_BAR_REVERSAL',direction:'BULLISH',startIndex:8,endIndex:9,symbol:'BTCUSDT',
        windowBars:[k1,k2],windowFacts:[L.candleFacts(k1),L.candleFacts(k2)]};
    var service=twoBarSetup.createService({symbol:'BTCUSDT',decisionStore:twoBarSetup.createMemoryStore(),
        requestSemantic:function(systemPrompt){return Promise.resolve(systemPrompt===L.SYSTEM_PROMPT
            ? {matches:[{pattern:'TWO_BAR_REVERSAL',direction:'BULLISH',label:'CLEAR',confidence:'HIGH',
                supportingFacts:['t'],conflicts:[],reason:'t'}],overall:'CLEAR_PATTERN'}
            : {expectedDirection:'BEARISH',detectedDirection:'BEARISH',label:'CLEAR',confidence:'HIGH',
                estimatedLegBars:6,reason:'t'});}});
    var dynamicDState={recentSurvivalPoints:[
        {id:'DYN_LOW_1',pointSide:'LOW',price:98.6,state:'ACTIVE',occurredAt:6*BAR,confirmedAt:6*BAR-1,occurredBarIndex:5},
        {id:'DYN_HIGH_1',pointSide:'HIGH',price:106.0,state:'ACTIVE',occurredAt:7*BAR,confirmedAt:7*BAR-1,occurredBarIndex:6}]};
    var result=await service.evaluateCandidate(candidate,{candles:rows,atrValue:1.0,dynamicDState:dynamicDState,currentBarIndex:9});
    assert.equal(result.status,'SETUP',JSON.stringify(result.reason));
    assert.equal(result.setup.type,'EQL');
    assert.equal(result.setup.partners[0].id,'DYN_LOW_1');
    assert.equal(result.setup.availableAt,k2.closeTime);
    var built=entryRules.buildBreakoutPlan(result.setup,{
        symbolRules:{source:'futures',tickSize:0.1,stepSize:0.001,minQty:0.001,maxQty:1000,minNotional:5},
        bias:{status:'AVAILABLE',closedAt:1000,expectedClosedAt:1000,semantic:{direction:'BULLISH',strength:'WEAK',confidence:'LOW'}},
        currentContractPrice:100.0,dynamicDPoints:dynamicDState.recentSurvivalPoints,candles:rows});
    assert.equal(built.ok,true,built.reasonCode);
    assert.equal(built.plan.entryTrigger,result.setup.twoBarHigh);
    assert.equal(built.plan.entryWorkingType,'CONTRACT_PRICE');
    assert.equal(built.plan.initialSL,Math.min(result.setup.twoBarLow,98.6));
    assert.equal(built.plan.initialTP,106.0);
    // legacy FVG handler is not wired into the new entry chain
    var chain=['scripts/live.js','live/liveEngine.js','strategy/twoBarSetupV1.js',
        'strategy/twoBarLivePipelineV1.js','execution/breakoutEntryRulesV1.js',
        'execution/breakoutExecutionV1.js'].map(function(file){
            return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}).join('\n');
    assert.doesNotMatch(chain,/eqFvgCountWatchV1|eqFvgCountWatchAlertServiceV1|rawFvgAt|setEqFvgCountStepHandler/);
});

test('removed Taken/displacement/touch-shaped inputs cannot notify without raw FVG', function () {
    var machine=watchModel.createStateMachine(), liquidity=eq('EQL','EQ:OLD-PATH');
    var result=machine.step({newEqualLiquidity:[liquidity],rawFvg:null,
        liquidityTaken:{id:'TAKEN'},displacement:{id:'D'},firstTouch:{price:1}});
    assert.equal(result.notifications.length,0); assert.equal(machine.get(watchModel.watchId(liquidity)).status,'OPEN');
    result=machine.step({newEqualLiquidity:[],rawFvg:fvg('BULLISH',1,liquidity.confirmedAt)});
    assert.equal(result.notifications.length,1);
});

test('retired step builder can still rebuild the historical EQ/WATCH stream for research only', async function () {
    var originalLiquidity=replayState.incrementalLiquidity;
    var liquidity=eq('EQL','EQ:INDEPENDENT',BAR-1);
    replayState.incrementalLiquidity=function(state){state.productionEq.events.push(liquidity);return [];};
    try {
        var engine=liveEngine.createLiveEngine({symbol:'BTCUSDT',exchangeInfo:{tickSize:0.1},structureCandles:{'4h':[],'1h':[],'1d':[]},calendarCandles:{'1d':[],'1w':[],'1M':[]},fetcher:function(){return Promise.resolve([]);},thresholds:thresholds});
        var machine=watchModel.createStateMachine(), captured=[];
        var eqBefore=engine.getState().productionEq.events.length;
        await engine.onBar({openTime:0,closeTime:BAR-1,open:100,high:101,low:99,close:100,closed:true,source:'futures'},0);
        var step=watchModel.buildStep(engine.getWindowSnapshot(),0,'BTCUSDT',
            engine.getState().productionEq.events.slice(eqBefore),[],BAR-1);
        captured.push(machine.step({evaluationTime:step.evaluationTime,
            newEqualLiquidity:step.newEqualLiquidity,rawFvg:step.rawFvg}));
        assert.equal(captured.length,1); assert.equal(captured[0].opened.length,1);
        assert.equal(machine.get(watchModel.watchId(liquidity)).status,'OPEN');
        // ...but nothing in the production runner installs or consumes that stream
        var live=fs.readFileSync(path.join(__dirname,'../scripts/live.js'),'utf8');
        assert.doesNotMatch(live,/setEqFvgCountStepHandler|drainEqFvgCountSteps|eqFvgCountWatchAlertServiceV1|eqFvgAssociationSemanticV1/);
    } finally {
        replayState.incrementalLiquidity=originalLiquidity;
    }
});

test('active EQ notification call graph contains none of the removed prerequisites', function () {
    var root=path.join(__dirname,'..');
    var files=['scripts/live.js','live/eqFvgCountWatchV1.js','live/eqFvgCountWatchAlertServiceV1.js','notify/eqFvgCountWatchNotificationV1.js'];
    var source=files.map(function(file){return fs.readFileSync(path.join(root,file),'utf8');}).join('\n');
    assert.doesNotMatch(source,/require\(['"]\.\.\/stats\/displacementWatch['"]\)/);
    assert.doesNotMatch(source,/require\(['"]\.\.\/live\/futuresPriceStream['"]\)/);
    var eqOnly=files.slice(1).map(function(file){return fs.readFileSync(path.join(root,file),'utf8');}).join('\n');
    assert.doesNotMatch(eqOnly,/LIQUIDITY_TAKEN|SWEEP|Displacement|24_BAR|FIRST_TOUCH|chainLen|consecutive|merged FVG/);
});
