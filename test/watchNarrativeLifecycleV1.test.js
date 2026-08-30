'use strict';

var assert = require('assert');
var lifecycle = require('../stats/watchNarrativeLifecycleV1');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
function watch(id, sweepId, direction, at, overrides) {
    var bearish = direction === 'BEARISH';
    var value = {
        id:id, symbol:'BTCUSDT', timeframe:'5m', direction:direction,
        state:'FVG_TOUCHED', firstTouchAt:at, updatedAt:at,
        notificationKey:'NOTIFY:' + id,
        liquidityTaken:{ primary:{
            id:sweepId, sourceId:'EQV3:SHARED', sourceTimeframe:'5m',
            side:bearish ? 'BSL' : 'SSL', occurredAt:at - 300, confirmedAt:at - 200
        } },
        displacementLegId:'LEG:' + id,
        displacementIds:['D:' + id],
        displacement:{ direction:direction, quality:'NORMAL' },
        nativeFvg:{ id:'FVG:' + id, confirmedAt:at - 100, low:1, high:2 },
        mss:{ exists:false },
        dailyBias:{ bias:'UNKNOWN', alignment:'UNKNOWN', status:'BYPASSED' }
    };
    Object.keys(overrides || {}).forEach(function (key) { value[key] = overrides[key]; });
    return value;
}
function observeAll(items) {
    var state = lifecycle.createState();
    var results = items.map(function (item) { return lifecycle.observeFirstTouch(state, item); });
    return { state:state, results:results };
}

test('1 deterministic narrative identity uses exact sweep', function () {
    var a = watch('W1', 'S1', 'BEARISH', 1000);
    assert.strictEqual(lifecycle.identityForWatch(a).narrativeId, lifecycle.identityForWatch(a).narrativeId);
    assert.notStrictEqual(lifecycle.identityForWatch(a).narrativeId,
        lifecycle.identityForWatch(watch('W2', 'S2', 'BEARISH', 2000)).narrativeId);
});
test('2 deterministic observation identity separates qualifying touches', function () {
    var a = lifecycle.identityForWatch(watch('W1', 'S1', 'BEARISH', 1000));
    var b = lifecycle.identityForWatch(watch('W2', 'S1', 'BEARISH', 2000));
    assert.strictEqual(a.observationId, lifecycle.identityForWatch(watch('W1', 'S1', 'BEARISH', 1000)).observationId);
    assert.notStrictEqual(a.observationId, b.observationId);
});
test('3 WATCH formation does not register an observation', function () {
    var item = watch('W1', 'S1', 'BEARISH', 1000); item.state = 'WATCH_WAIT_FVG';
    var state = lifecycle.createState(), result = lifecycle.observeFirstTouch(state, item);
    assert.strictEqual(result.accepted, false); assert.strictEqual(state.observationOrder.length, 0);
});
test('4 first touch creates NEW ACTIVE narrative', function () {
    var run = observeAll([watch('W1', 'S1', 'BEARISH', 1000)]);
    assert.strictEqual(run.results[0].observation.type, 'NEW');
    assert.strictEqual(run.results[0].narrative.state, 'ACTIVE');
});
test('5 same exact active sweep is CONTINUATION', function () {
    var run = observeAll([watch('W1', 'S1', 'BEARISH', 1000), watch('W2', 'S1', 'BEARISH', 2000)]);
    assert.deepStrictEqual(run.results.map(function (r) { return r.observation.type; }), ['NEW','CONTINUATION']);
    assert.strictEqual(Object.keys(run.state.narrativesById).length, 1);
});
test('6 same liquidity but different exact sweep is NEW narrative', function () {
    var run = observeAll([watch('W1', 'S1', 'BEARISH', 1000), watch('W2', 'S2', 'BEARISH', 2000)]);
    assert.strictEqual(run.results[1].observation.type, 'NEW');
    assert.strictEqual(Object.keys(run.state.narrativesById).length, 2);
});
test('7 same-direction new exact sweep supersedes current active', function () {
    var run = observeAll([watch('W1', 'S1', 'BEARISH', 1000), watch('W2', 'S2', 'BEARISH', 2000)]);
    assert.strictEqual(run.results[0].narrative.state, 'SUPERSEDED');
    assert.strictEqual(run.results[1].narrative.state, 'ACTIVE');
});
test('8 opposite-direction new exact sweep supersedes current active', function () {
    var run = observeAll([watch('W1', 'S1', 'BULLISH', 1000), watch('W2', 'S2', 'BEARISH', 2000)]);
    assert.strictEqual(run.results[0].narrative.state, 'SUPERSEDED');
    assert.strictEqual(run.results[1].observation.type, 'NEW');
});
test('9 superseded exact sweep returns as REACTIVATION', function () {
    var run = observeAll([watch('W1', 'S1', 'BULLISH', 1000), watch('W2', 'S2', 'BEARISH', 2000),
        watch('W3', 'S1', 'BULLISH', 3000)]);
    assert.strictEqual(run.results[2].observation.type, 'REACTIVATION');
    assert.strictEqual(run.results[2].narrative.state, 'ACTIVE');
    assert.strictEqual(run.results[1].narrative.state, 'SUPERSEDED');
});
test('10 A-B-A-B preserves one active owner', function () {
    var run = observeAll([watch('W1','S1','BULLISH',1000), watch('W2','S2','BEARISH',2000),
        watch('W3','S1','BULLISH',3000), watch('W4','S2','BEARISH',4000)]);
    assert.deepStrictEqual(run.results.map(function (r) { return r.observation.type; }),
        ['NEW','NEW','REACTIVATION','REACTIVATION']);
    assert.strictEqual(lifecycle.activeCount(run.state, 'BTCUSDT', '5m'), 1);
    assert.strictEqual(run.state.activeNarrativeCardinalityViolations, 0);
});
test('11 duplicate first touch is idempotent', function () {
    var item = watch('W1','S1','BULLISH',1000), state = lifecycle.createState();
    lifecycle.observeFirstTouch(state, item); var before = JSON.stringify(lifecycle.projection(state));
    var duplicate = lifecycle.observeFirstTouch(state, item);
    assert.strictEqual(duplicate.duplicate, true); assert.strictEqual(JSON.stringify(lifecycle.projection(state)), before);
});
test('12 observations and transition history are append-only', function () {
    var items = [watch('W1','S1','BULLISH',1000), watch('W2','S2','BEARISH',2000)];
    var state = lifecycle.createState(); lifecycle.observeFirstTouch(state, items[0]);
    var first = JSON.stringify(state.observationsById[state.observationOrder[0]]);
    var transitions = state.transitions.slice(); lifecycle.observeFirstTouch(state, items[1]);
    assert.strictEqual(JSON.stringify(state.observationsById[state.observationOrder[0]]), first);
    assert.deepStrictEqual(state.transitions.slice(0, transitions.length), transitions);
});
test('13 Bias snapshots remain prefix-stable', function () {
    var a=watch('W1','S1','BEARISH',1000), b=watch('W2','S1','BEARISH',2000);
    b.dailyBias={bias:'BEARISH',alignment:'MATCH',status:'VALID'};
    var run=observeAll([a,b]), observations=run.state.observationOrder.map(function(id){return run.state.observationsById[id];});
    assert.strictEqual(observations[0].biasSnapshot.bias,'UNKNOWN');
    assert.strictEqual(observations[1].biasSnapshot.bias,'BEARISH');
});
test('14 structure snapshots NONE-LOCAL-INTERNAL do not change narrative identity', function () {
    var a=watch('W1','S1','BEARISH',1000), b=watch('W2','S1','BEARISH',2000), c=watch('W3','S1','BEARISH',3000);
    b.mss={exists:true,referenceRole:'LOCAL'}; c.mss={exists:true,referenceRole:'INTERNAL'};
    var run=observeAll([a,b,c]), obs=run.state.observationOrder.map(function(id){return run.state.observationsById[id];});
    assert.strictEqual(new Set(obs.map(function(o){return o.narrativeId;})).size,1);
    assert.deepStrictEqual(obs.map(function(o){return o.structureSnapshot.mss.referenceRole || 'NONE';}),['NONE','LOCAL','INTERNAL']);
});
test('15 displacement and FVG are observation snapshots, not narrative identity', function () {
    var run=observeAll([watch('W1','S1','BEARISH',1000), watch('W2','S1','BEARISH',2000)]);
    var obs=run.state.observationOrder.map(function(id){return run.state.observationsById[id];});
    assert.strictEqual(obs[0].narrativeId,obs[1].narrativeId);
    assert.notStrictEqual(obs[0].displacementLegId,obs[1].displacementLegId);
    assert.notStrictEqual(obs[0].primaryNativeFvgId,obs[1].primaryNativeFvgId);
});
test('16 future-confirmed sweep cannot create narrative', function () {
    var item=watch('W1','S1','BULLISH',1000); item.liquidityTaken.primary.confirmedAt=1001;
    var state=lifecycle.createState(), result=lifecycle.observeFirstTouch(state,item);
    assert.strictEqual(result.reason,'SWEEP_NOT_CONFIRMED_AT_FIRST_TOUCH'); assert.strictEqual(Object.keys(state.narrativesById).length,0);
});
test('17 future-confirmed FVG cannot create observation', function () {
    var item=watch('W1','S1','BULLISH',1000); item.nativeFvg.confirmedAt=1001;
    var state=lifecycle.createState(), result=lifecycle.observeFirstTouch(state,item);
    assert.strictEqual(result.reason,'FVG_CONFIRMED_AFTER_FIRST_TOUCH'); assert.strictEqual(state.observationOrder.length,0);
});
test('18 WATCH state unavailable at FIRST_TOUCH cannot create observation', function () {
    var item=watch('W1','S1','BULLISH',1000); item.updatedAt=1001;
    var state=lifecycle.createState(), result=lifecycle.observeFirstTouch(state,item);
    assert.strictEqual(result.reason,'WATCH_NOT_AVAILABLE_AT_FIRST_TOUCH'); assert.strictEqual(state.observationOrder.length,0);
});
test('19 replay reconstruction equals incremental projection', function () {
    var items=[watch('W4','S2','BEARISH',4000),watch('W2','S2','BEARISH',2000),
        watch('W1','S1','BULLISH',1000),watch('W3','S1','BULLISH',3000)];
    var incremental=observeAll(items.slice().sort(lifecycle.compareTouchOrder));
    assert.deepStrictEqual(lifecycle.projection(lifecycle.reconstructFromWatches(items).state),lifecycle.projection(incremental.state));
});
test('20 same replay and prefix produce deterministic IDs and transitions', function () {
    var items=[watch('W1','S1','BULLISH',1000),watch('W2','S2','BEARISH',2000),watch('W3','S1','BULLISH',3000)];
    var a=lifecycle.projection(lifecycle.reconstructFromWatches(items).state);
    var b=lifecycle.projection(lifecycle.reconstructFromWatches(items).state);
    var prefix=lifecycle.projection(lifecycle.reconstructFromWatches(items.slice(0,2)).state);
    assert.deepStrictEqual(a,b); assert.deepStrictEqual(a.observations.slice(0,2),prefix.observations);
    assert.deepStrictEqual(a.transitions.slice(0,prefix.transitions.length),prefix.transitions);
});
test('21 restart reconstruction retains continuation classification and owner', function () {
    var items=[watch('W1','S1','BEARISH',1000),watch('W2','S1','BEARISH',2000)];
    var rebuilt=lifecycle.reconstructFromWatches(items);
    assert.deepStrictEqual(rebuilt.results.map(function(x){return x.result.observation.type;}),['NEW','CONTINUATION']);
    assert.strictEqual(lifecycle.activeCount(rebuilt.state,'BTCUSDT','5m'),1);
});
test('22 metadata attaches presentation fields without changing event identity', function () {
    var item=watch('W1','S1','BEARISH',1000), result=lifecycle.observeFirstTouch(lifecycle.createState(),item);
    lifecycle.attachMetadata(item,result);
    assert.strictEqual(item.observationType,'NEW'); assert.strictEqual(item.narrativeId,result.narrative.id);
    assert.strictEqual(item.notificationKey,'NOTIFY:W1');
});

if (failed) { console.error('WATCH Narrative Lifecycle V1 failed ' + failed + '/' + (passed + failed)); process.exit(1); }
console.log('WATCH Narrative Lifecycle V1 ' + passed + '/' + passed);
