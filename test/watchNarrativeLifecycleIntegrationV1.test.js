'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var lifecycle = require('../stats/watchNarrativeLifecycleV1');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.stack); }
}
function load(symbol) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research',
        'watch-narrative-sweep-association-audit-v1', symbol + '-forensic-replay.json'), 'utf8'));
}
function rowAt(fixture, time) {
    return fixture.touchesOnTargetDate.filter(function (row) { return row.watchTime === time; })[0];
}
function toWatch(row, symbol) {
    return {
        id:row.watchId, symbol:symbol, timeframe:'5m', direction:row.direction,
        state:'FVG_TOUCHED', firstTouchAt:row.firstTouchAt, updatedAt:row.firstTouchAt,
        notificationKey:row.notificationKey,
        liquidityTaken:{ primary:{
            id:'TAKEN:'+row.sweepId, eventType:'LIQUIDITY_TAKEN', sourceId:row.liquidityId, sourceType:row.liquidityType,
            sourceTimeframe:'5m', sourcePrice:row.liquidityPrice,
            side:row.direction === 'BEARISH' ? 'BSL' : 'SSL',
            occurredAt:row.sweepOccurredAt, confirmedAt:row.sweepConfirmedAt,
            relation:row.primarySweepTiming
        } },
        canonicalDisplacementId:row.legId,
        displacement:{ id:row.legId, type:'DISPLACEMENT', direction:row.legDirection, quality:row.legStrength, bars:row.legBars },
        mss:{ exists:row.mssExists, referenceRole:row.mssReferenceRole, protectedBreak:row.mssProtectedBreak },
        nativeFvg:{ id:row.fvgId, confirmedAt:row.fvgFormedAt },
        touchStatus:'FIRST_TOUCH'
    };
}
function projectionFor(watches) { return lifecycle.projection(lifecycle.reconstructFromWatches(watches).state); }
function counts(watches) {
    function unique(read) { return new Set(watches.map(read).filter(Boolean)).size; }
    return {
        RAW_SWEEP_EVENT_COUNT:unique(function(w){return w.liquidityTaken.primary.id;}),
        LIQUIDITY_EVENT_COUNT:unique(function(w){return w.liquidityTaken.primary.sourceId;}),
        CANONICAL_DISPLACEMENT_COUNT:unique(function(w){return w.canonicalDisplacementId;}),
        MSS_EVENT_COUNT:watches.filter(function(w){return w.mss.exists;}).length,
        FVG_COUNT:unique(function(w){return w.nativeFvg.id;}),
        WATCH_COUNT:unique(function(w){return w.id;}),
        FIRST_TOUCH_COUNT:watches.filter(function(w){return typeof w.firstTouchAt === 'number';}).length
    };
}

var zecFixture=load('ZECUSDT'), btcFixture=load('BTCUSDT');
var zecTimes=['2026-08-30 08:55','2026-08-30 09:40','2026-08-30 10:25'];
var btcTimes=['2026-08-30 10:00','2026-08-30 11:35','2026-08-30 11:55','2026-08-30 13:05'];
var zec=zecTimes.map(function(time){return toWatch(rowAt(zecFixture,time),'ZECUSDT');});
var btc=btcTimes.map(function(time){return toWatch(rowAt(btcFixture,time),'BTCUSDT');});

test('1 ZEC frozen fixture is NEW then two CONTINUATION observations', function () {
    var rebuilt=lifecycle.reconstructFromWatches(zec);
    assert.deepStrictEqual(rebuilt.results.map(function(x){return x.result.observation.type;}),
        ['NEW','CONTINUATION','CONTINUATION']);
});
test('2 ZEC frozen fixture has one narrative, three observations, one active', function () {
    var state=lifecycle.reconstructFromWatches(zec).state;
    assert.strictEqual(Object.keys(state.narrativesById).length,1);
    assert.strictEqual(state.observationOrder.length,3);
    assert.strictEqual(lifecycle.activeCount(state,'ZECUSDT','5m'),1);
    assert.strictEqual(new Set(state.observationOrder).size,3);
});
test('3 BTC frozen fixture is NEW A, NEW B, REACTIVATION A, REACTIVATION B', function () {
    var rebuilt=lifecycle.reconstructFromWatches(btc);
    assert.deepStrictEqual(rebuilt.results.map(function(x){return x.result.observation.type;}),
        ['NEW','NEW','REACTIVATION','REACTIVATION']);
});
test('4 BTC final active owner is B and active cardinality is one', function () {
    var state=lifecycle.reconstructFromWatches(btc).state;
    var narrativeB=lifecycle.identityForWatch(btc[1]).narrativeId;
    assert.strictEqual(state.activeByScope['BTCUSDT:5m'],narrativeB);
    assert.strictEqual(lifecycle.activeCount(state,'BTCUSDT','5m'),1);
    assert.strictEqual(state.activeNarrativeCardinalityViolations,0);
});
test('5 frozen sequence projection uses exact stable Taken identities', function () {
    assert.strictEqual(new Set(zec.map(function(w){return w.liquidityTaken.primary.id;})).size,1);
    assert.strictEqual(btc[0].liquidityTaken.primary.id,btc[2].liquidityTaken.primary.id);
    assert.strictEqual(btc[1].liquidityTaken.primary.id,btc[3].liquidityTaken.primary.id);
    assert.notStrictEqual(btc[0].liquidityTaken.primary.id,btc[1].liquidityTaken.primary.id);
});
test('6 historical and incremental live-style projections are equivalent', function () {
    var watches=zec.concat(btc), state=lifecycle.createState();
    watches.slice().sort(lifecycle.compareTouchOrder).forEach(function(w){lifecycle.observeFirstTouch(state,w);});
    assert.deepStrictEqual(lifecycle.projection(state),projectionFor(watches));
});
test('7 restart reconstruction is deterministic and does not reclassify continuation as NEW', function () {
    var first=lifecycle.reconstructFromWatches(zec.concat(btc));
    var restarted=lifecycle.reconstructFromWatches(zec.concat(btc));
    assert.deepStrictEqual(lifecycle.projection(first.state),lifecycle.projection(restarted.state));
    assert.strictEqual(restarted.results.filter(function(x){return x.watchId===zec[1].id;})[0].result.observation.type,'CONTINUATION');
});
test('8 lifecycle metadata leaves all event population counts unchanged', function () {
    var watches=zec.concat(btc), before=counts(watches), state=lifecycle.createState();
    watches.slice().sort(lifecycle.compareTouchOrder).forEach(function(w){
        var result=lifecycle.observeFirstTouch(state,w); lifecycle.attachMetadata(w,result);
    });
    assert.deepStrictEqual(counts(watches),before);
});

if (failed) { console.error('WATCH Narrative Lifecycle Frozen Fixtures V1 failed ' + failed + '/' + (passed + failed)); process.exit(1); }
console.log('WATCH Narrative Lifecycle Frozen Fixtures V1 ' + passed + '/' + passed);
