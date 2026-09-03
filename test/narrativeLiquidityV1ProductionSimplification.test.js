'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var classifier = require('../events/sweepNarrativeEligibilityV1');
var provenance = require('../stats/liquidityProvenance');
var watches = require('../stats/displacementWatch');
var adapter = require('../events/sweepEventAdapter');
var amdState = require('../amd/amdState');

var BAR = 300000;
function source(type, side, index) {
    return {id:'S:'+type+':'+index, side:side, candleIndex:index, confirmedAt:(index+1)*BAR-1,
        liquidityId:'L:'+type+':'+index, price:100, timeframe:'5m', source:{liquidityType:type}};
}
function displacement(direction) { return {id:'D',type:'DISPLACEMENT',direction:direction,startIndex:10,endIndex:10,startAt:10*BAR,endAt:11*BAR-1,confirmedAt:11*BAR-1}; }
function project(direction, rows) { return provenance.associateSweeps({direction:direction,displacement:displacement(direction),availableAt:11*BAR-1,sweepEvents:rows,excludeStructuralPrimitives:true}); }

['EQH','EQL'].forEach(function (type) {
    test(type + ' is frozen Narrative Liquidity V1', function () { assert.equal(classifier.isNarrativeLiquiditySourceV1(type), true); });
});
['PDH','PDL','PWH','PWL','PMH','PML'].forEach(function (type) {
    test(type + ' is removed from Narrative Liquidity V1', function () { assert.equal(classifier.isNarrativeLiquiditySourceV1(type), false); });
});
test('SWING_HIGH is structural primitive only', function () { assert.equal(classifier.isStructuralPrimitive('SWING_HIGH'), true); assert.equal(classifier.isNarrativeLiquiditySourceV1('SWING_HIGH'), false); });
test('SWING_LOW is structural primitive only', function () { assert.equal(classifier.isStructuralPrimitive('SWING_LOW'), true); assert.equal(classifier.isNarrativeLiquiditySourceV1('SWING_LOW'), false); });
test('Session remains out of scope', function () { var x=classifier.classifySourceType('NEW_YORK_HIGH'); assert.equal(x.narrativeEligible,null); assert.equal(x.status,'OUT_OF_SCOPE_FROZEN'); });
test('SHORT mixed candidate projection keeps EQH only', function () { var x=project('BEARISH',[source('SWING_HIGH','BSL',9),source('EQH','BSL',8)]); assert.deepEqual(x.allCandidates.map(function(c){return c.sourceType;}),['EQH']); });
test('LONG mixed candidate projection keeps EQL only', function () { var x=project('BULLISH',[source('SWING_LOW','SSL',9),source('EQL','SSL',8)]); assert.deepEqual(x.allCandidates.map(function(c){return c.sourceType;}),['EQL']); });
test('Swing plus EQH keeps EQH only (multiple swings dropped)', function () { var x=project('BEARISH',[source('SWING_HIGH','BSL',9),source('SWING_LOW','SSL',6),source('EQH','BSL',8)]); assert.deepEqual(x.allCandidates.map(function(c){return c.sourceType;}),['EQH']); });
test('Swing-only cannot silently promote', function () { assert.equal(project('BULLISH',[source('SWING_LOW','SSL',9)]),null); });
test('existing 48-bar temporal boundary is unchanged', function () { assert.ok(project('BEARISH',[source('EQH','BSL',-38)])); assert.equal(project('BEARISH',[source('EQH','BSL',-39)]),null); });
test('persisted mixed WATCH reuses existing distance/recency primary heuristic', function () {
    var swing={id:'S',sourceType:'SWING_LOW',candleIndex:10,confirmedAt:100,eventType:'SWEEP'};
    var far={id:'F',sourceType:'EQL',candleIndex:5,confirmedAt:200,eventType:'LIQUIDITY_TAKEN'};
    var near={id:'N',sourceType:'EQL',candleIndex:9,confirmedAt:150,eventType:'LIQUIDITY_TAKEN'};
    var normalized=watches.normalizeNarrativeLiquidityV1Watch({id:'W',displacement:{startIndex:10},liquidityTaken:{primary:swing,allCandidates:[far,swing,near]}});
    assert.deepEqual(normalized.liquidityTaken.allCandidates.map(function(c){return c.id;}),['F','N']); assert.equal(normalized.liquidityTaken.primary.id,'N');
});
test('persisted Swing-only WATCH is not loaded', function () { assert.equal(watches.normalizeNarrativeLiquidityV1Watch({id:'W',displacement:{startIndex:10},liquidityTaken:{primary:{sourceType:'SWING_LOW',eventType:'SWEEP'},allCandidates:[{sourceType:'SWING_LOW',eventType:'SWEEP'}]}}),null); });
test('raw Swing Sweep ID and source identity remain unchanged', function () {
    var liquidity={id:'X:5m:SWING_LOW:1',symbol:'X',timeframe:'5m',type:'SWING_LOW',side:'SSL',price:100,status:'SWEPT',sweptAt:BAR-1,metadata:{}};
    var event=adapter.buildSweepEvent(liquidity,{openTime:0,closeTime:BAR-1,open:101,high:102,low:99,close:100,closed:true},0);
    assert.equal(event.id,'X:5m:SWEEP:X:5m:SWING_LOW:1'); assert.equal(event.source.liquidityType,'SWING_LOW');
});
test('AMD still consumes raw Swing Sweep', function () {
    var state=amdState.createAmdState(); state.phase='ACCUMULATION'; state.lastPhase='ACCUMULATION';
    state.accumulation={rangeLow:100,rangeHigh:110,atr:5,confirmedAt:2*BAR-1}; state.confirmedAt=state.accumulation.confirmedAt;
    var candles=[]; for(var i=0;i<6;i++) candles.push({openTime:i*BAR,closeTime:(i+1)*BAR-1,open:101,high:102,low:99,close:101,closed:true});
    var sweep=source('SWING_LOW','SSL',4); sweep.id='RAW-SWING';
    amdState.updateAmdState(state,{candle:candles[5],candleIndex:5,candles:candles,evaluationTime:candles[5].closeTime,symbol:'X',timeframe:'5m',newSweeps:[sweep],newMss:[],newDisplacements:[]});
    assert.equal(state.manipulation.sweepEvent.id,'RAW-SWING');
});
