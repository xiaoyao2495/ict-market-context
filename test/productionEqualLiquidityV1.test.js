'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var producer = require('../liquidity/productionEqualLiquidityV1');
var zigzag = require('../liquidity/atr50CausalZigZag');
var replayState = require('../replay/replayState');

var BAR = 300000;
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function state(points) {
    var value = producer.createState({ symbol:'X', timeframe:'5m' });
    value.fiveMinuteAtrValue = 10;
    value.zigzag.confirmedPoints = points || [];
    value.zigzag.recentSurvivalPoints = points || [];
    return value;
}
function point(id, side, index, price, options) {
    var opts = options || {};
    return {
        id:id, pointSide:side, price:price, occurredAt:index * BAR,
        confirmedAt:opts.confirmedAt === undefined ? (index + 3) * BAR : opts.confirmedAt,
        occurredBarIndex:index, status:opts.status || 'ACTIVE',
        violatedAt:opts.violatedAt === undefined ? null : opts.violatedAt
    };
}
function pivot(id, side, index, price, confirmedAt) {
    var type = side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id:id, symbol:'X', timeframe:'5m', type:type,
        side:side === 'HIGH' ? 'BSL' : 'SSL', price:price,
        sourceOpenTime:index * BAR, sourceCloseTime:(index + 1) * BAR - 1,
        occurredAt:index * BAR,
        confirmedAt:confirmedAt === undefined ? (index + 3) * BAR : confirmedAt,
        metadata:{ index:index, right:2 }
    };
}
function evaluate(points, current) { return producer.evaluatePivot(state(points), current); }

test('A HIGH match emits EQH at current 2/2 price', function () {
    var event = evaluate([point('Z','HIGH',10,100)], pivot('P','HIGH',20,104));
    assert.ok(event); assert.strictEqual(event.type,'EQH'); assert.strictEqual(event.price,104);
});
test('B LOW match emits EQL', function () {
    assert.strictEqual(evaluate([point('Z','LOW',10,100)], pivot('P','LOW',20,96)).type,'EQL');
});
test('C opposite side cannot pair', function () {
    assert.strictEqual(evaluate([point('Z','LOW',10,100)], pivot('P','HIGH',20,100)),null);
});
test('D 433 bars is outside the inclusive window', function () {
    assert.strictEqual(evaluate([point('Z','HIGH',1,100)], pivot('P','HIGH',434,100)),null);
});
test('E exactly 432 bars is eligible', function () {
    assert.ok(evaluate([point('Z','HIGH',1,100)], pivot('P','HIGH',433,100)));
});
test('F historical point confirmed after current pivot is excluded', function () {
    var p = pivot('P','HIGH',20,100);
    assert.strictEqual(evaluate([point('Z','HIGH',10,100,{confirmedAt:p.confirmedAt + 1})],p),null);
});
test('G HIGH strict trade-through before P excludes partner', function () {
    var p = pivot('P','HIGH',20,100);
    assert.strictEqual(evaluate([point('Z','HIGH',10,100,{status:'VIOLATED',violatedAt:p.occurredAt - 1})],p),null);
});
test('H HIGH equality touch is not a violation', function () {
    assert.strictEqual(zigzag.violationFor(point('Z','HIGH',10,100),{openTime:11*BAR,closeTime:12*BAR-1,high:100,closed:true}),null);
});
test('I LOW strict trade-through before P excludes partner', function () {
    var p = pivot('P','LOW',20,100);
    assert.strictEqual(evaluate([point('Z','LOW',10,100,{status:'VIOLATED',violatedAt:p.occurredAt - 1})],p),null);
});
test('J LOW equality touch is not a violation', function () {
    assert.strictEqual(zigzag.violationFor(point('Z','LOW',10,100),{openTime:11*BAR,closeTime:12*BAR-1,low:100,closed:true}),null);
});
test('K trade-through on current P bar does not remove the first pair', function () {
    var p = pivot('P','HIGH',20,104);
    var event = evaluate([point('Z','HIGH',10,100,{status:'VIOLATED',violatedAt:p.occurredAt})],p);
    assert.ok(event); assert.strictEqual(event.metadata.historicalPartners[0].currentTradesThroughHistorical,true);
});
test('L one current pivot emits one event retaining all matching partners', function () {
    var event = evaluate([point('A','HIGH',10,100),point('B','HIGH',12,103)],pivot('P','HIGH',20,104));
    assert.strictEqual(event.metadata.partnerCount,2);
    assert.deepStrictEqual(event.metadata.historicalPartners.map(function(x){return x.id;}),['A','B']);
});
test('M evaluating the same current pivot twice emits once', function () {
    var s=state([point('Z','HIGH',10,100)]),p=pivot('P','HIGH',20,100);
    assert.ok(producer.evaluatePivot(s,p)); assert.strictEqual(producer.evaluatePivot(s,p),null); assert.strictEqual(s.events.length,1);
});
test('two current observations do not merge or mutate the first event', function () {
    var s=state([point('Z','HIGH',10,100)]),first=producer.evaluatePivot(s,pivot('P1','HIGH',20,100));
    var before=JSON.stringify(first),second=producer.evaluatePivot(s,pivot('P2','HIGH',21,101));
    assert.ok(second); assert.notStrictEqual(first.id,second.id); assert.strictEqual(JSON.stringify(first),before);
    assert.strictEqual(first.metadata.persistentIdentity,false); assert.strictEqual(first.metadata.clusterLifecycle,false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(first.metadata,'members'),false);
});
test('a P-bar violation permits P1 but excludes later P2', function () {
    var p1=pivot('P1','HIGH',20,104),z=point('Z','HIGH',10,100,{status:'VIOLATED',violatedAt:p1.occurredAt});
    assert.ok(evaluate([z],p1)); assert.strictEqual(evaluate([z],pivot('P2','HIGH',21,101)),null);
});
test('frozen price tolerance is 0.7 times current 5m Wilder ATR14', function () {
    var event=evaluate([point('Z','HIGH',10,100)],pivot('P','HIGH',20,107));
    assert.ok(event); assert.strictEqual(event.metadata.pairwiseToleranceAtrPeriod,14);
    assert.strictEqual(event.metadata.pairwiseToleranceAtrMultiplier,0.7);
    assert.strictEqual(evaluate([point('Z','HIGH',10,100)],pivot('Q','HIGH',20,107.000001)),null);
});
test('4H ATR consumes only completed causal candles and persists across 36H', function () {
    var rows=[];
    for(var i=0;i<16;i++) rows.push({openTime:i*14400000,closeTime:(i+1)*14400000-1,open:100,high:110,low:90,close:100,closed:true});
    var s=zigzag.createState({fourHourCandles:rows});
    assert.strictEqual(zigzag.advanceFourHourAtr(s,rows[13].closeTime),null);
    assert.strictEqual(zigzag.advanceFourHourAtr(s,rows[14].closeTime),20);
    assert.strictEqual(s.fourHourIndex,14);
    assert.strictEqual(zigzag.advanceFourHourAtr(s,rows[14].closeTime),20);
    assert.strictEqual(s.fourHourIndex,14);
});
test('production replay imports no old V2/V3 EQ producer or qualified source', function () {
    var text=fs.readFileSync(path.join(__dirname,'../replay/replayState.js'),'utf8');
    ['persistentEqualLiquidityV3','equalLiquidity.js','eqProductionVersion','eqSwingSource','standardCausalSwingSegmentation'].forEach(function(token){assert.strictEqual(text.includes(token),false,token);});
});
test('ReplayState registers the replacement EQ as Narrative Liquidity', function () {
    var candles=[90,95,100,95,90].map(function(high,i){return{openTime:i*BAR,closeTime:(i+1)*BAR-1,open:80,high:high,low:70,close:80,closed:true};});
    var s=replayState.createReplayState({symbol:'X',timeframe:'5m'});
    for(var i=0;i<4;i++) replayState.incrementalLiquidity(s,candles,i,null,candles[i].closeTime);
    s.productionEq.fiveMinuteAtrValue=10;
    var z=point('Z','HIGH',0,100,{confirmedAt:candles[1].closeTime});
    s.productionEq.zigzag.confirmedPoints.push(z); s.productionEq.zigzag.recentSurvivalPoints.push(z);
    replayState.incrementalLiquidity(s,candles,4,null,candles[4].closeTime);
    var eq=s.registry.getByType('X','EQH');
    assert.strictEqual(eq.length,1); assert.strictEqual(eq[0].price,100);
    assert.strictEqual(eq[0].metadata.eqModelVersion,producer.VERSION);
});
test('live and inspect entrypoints identify only the replacement production model', function () {
    var live=fs.readFileSync(path.join(__dirname,'../scripts/live.js'),'utf8');
    var inspect=fs.readFileSync(path.join(__dirname,'../scripts/inspectLiquidity.js'),'utf8');
    assert.strictEqual(live.includes("require('../config/eqProductionVersion')"),false);
    assert.strictEqual(live.includes("require('../liquidity/productionEqualLiquidityV1')"),true);
    assert.strictEqual(inspect.includes("require('../liquidity/equalLiquidity')"),false);
    assert.strictEqual(inspect.includes('partners='),true);
});

console.log('\nProduction Equal Liquidity V1: '+passed+' passed, '+failed+' failed');
if(failed) process.exit(1);
