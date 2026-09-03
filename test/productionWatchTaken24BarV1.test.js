'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var takenAdapter = require('../events/liquidityTakenEventAdapter');
var association = require('../stats/liquidityTakenAssociation');
var watchEngine = require('../stats/displacementWatch');
var liveMessages = require('../scripts/live');

var BAR = 300000;
function candle(i, open, high, low, close) {
    return {openTime:i*BAR,closeTime:(i+1)*BAR-1,open:open,high:high,low:low,close:close,closed:true};
}
function liquidity(type, side, price) {
    return {id:'L:'+type,symbol:'X',timeframe:'5m',type:type,side:side,price:price,status:'ACTIVE',
        occurredAt:0,confirmedAt:BAR-1,metadata:type === 'EQH' || type === 'EQL' ? {
            currentPivot:{id:'P',price:price},historicalPartners:[{id:'A',price:price}],partnerCount:1
        }:{}};
}
function taken(side, index, sourceType) {
    return {id:'T:'+side+':'+index+':'+sourceType,type:'LIQUIDITY_TAKEN',symbol:'X',timeframe:'5m',side:side,
        liquidityId:'L:'+sourceType,price:100,occurredAt:index*BAR,confirmedAt:(index+1)*BAR-1,candleIndex:index,
        source:{liquidityId:'L:'+sourceType,liquidityType:sourceType,liquidityPrice:100,side:side}};
}
function displacement(direction, start, end) {
    end = end === undefined ? start : end;
    return {id:'D:'+direction+':'+start+':'+end,type:'DISPLACEMENT',symbol:'X',timeframe:'5m',direction:direction,
        formationType:start===end?'SINGLE_CANDLE':'MULTI_CANDLE',startIndex:start,endIndex:end,
        startAt:start*BAR,endAt:(end+1)*BAR-1,confirmedAt:(end+1)*BAR-1,sourceDetections:[]};
}
function watch(direction, start, events, candles) {
    var d=displacement(direction,start);
    return watchEngine.buildWatch({symbol:'X',displacement:d,evaluationTime:(start+2)*BAR-1,
        takenEvents:events,candles:candles||[]});
}

test('frozen Taken WATCH constants are 24 bars / 120 minutes', function () {
    assert.equal(association.WATCH_TAKEN_LOOKBACK_BARS,24);
    assert.equal(association.WATCH_TAKEN_LOOKBACK_TIME_MINUTES,120);
});

test('EQL strict trade-through emits SSL Taken and creates LONG WATCH', function () {
    var event=takenAdapter.buildTakenEvent(liquidity('EQL','SSL',100),candle(1,101,102,99,100),1,'5m');
    var result=watch('BULLISH',2,[event]);
    assert.ok(result); assert.equal(result.watchDirection,'WATCH_LONG');
    assert.equal(result.liquidityTrigger,'LIQUIDITY_TAKEN');
    assert.equal(result.liquidityTaken.primary.eventType,'LIQUIDITY_TAKEN');
    assert.equal(result.liquidityTaken.primary.sourceType,'EQL');
});

test('EQH strict trade-through emits BSL Taken and creates SHORT WATCH', function () {
    var event=takenAdapter.buildTakenEvent(liquidity('EQH','BSL',100),candle(1,99,101,98,100),1,'5m');
    var result=watch('BEARISH',2,[event]);
    assert.ok(result); assert.equal(result.watchDirection,'WATCH_SHORT');
    assert.equal(result.liquidityTaken.primary.sourceType,'EQH');
});

[0,1,23,24].forEach(function (distance) {
    test('Taken distance '+distance+' is eligible', function () {
        var start=30,event=taken('SSL',start-distance,'EQL');
        assert.ok(watch('BULLISH',start,[event]));
    });
});

test('Taken distance 25 is not eligible', function () {
    assert.equal(watch('BULLISH',30,[taken('SSL',5,'EQL')]),null);
});

test('wrong-direction Taken does not create WATCH', function () {
    assert.equal(watch('BULLISH',10,[taken('BSL',9,'EQH')]),null);
    assert.equal(watch('BEARISH',10,[taken('SSL',9,'EQL')]),null);
});

test('future Taken is never used', function () {
    assert.equal(watch('BULLISH',10,[taken('SSL',11,'EQL')]),null);
    var late=taken('SSL',9,'EQL'); late.confirmedAt=12*BAR-1;
    assert.equal(watch('BULLISH',10,[late]),null);
});

test('touch-only does not create Taken or WATCH', function () {
    var eql=takenAdapter.buildTakenEvent(liquidity('EQL','SSL',100),candle(1,101,102,100,101),1,'5m');
    var eqh=takenAdapter.buildTakenEvent(liquidity('EQH','BSL',100),candle(1,99,100,98,99),1,'5m');
    assert.equal(eql,null); assert.equal(eqh,null);
    assert.equal(watch('BULLISH',2,[]),null);
});

test('Sweep alone cannot satisfy WATCH and Taken without Sweep can', function () {
    var sweep={id:'S',type:'LIQUIDITY_SWEEP',side:'SSL',candleIndex:9,confirmedAt:10*BAR-1,
        liquidityId:'L:EQL',price:100,source:{liquidityType:'EQL'}};
    var d=displacement('BULLISH',10);
    assert.equal(watchEngine.buildWatch({symbol:'X',displacement:d,evaluationTime:d.confirmedAt,
        sweepEvents:[sweep],takenEvents:[sweep],candles:[]}),null);
    assert.ok(watchEngine.buildWatch({symbol:'X',displacement:d,evaluationTime:d.confirmedAt,
        sweepEvents:[],takenEvents:[taken('SSL',9,'EQL')],candles:[]}));
});

test('all Taken candidates are retained and nearest/latest candidate is primary', function () {
    var rows=[taken('SSL',5,'EQH'),taken('SSL',9,'EQL'),taken('SSL',8,'EQH')];
    var result=watch('BULLISH',10,rows);
    assert.equal(result.liquidityTaken.allCandidates.length,3);
    assert.equal(result.liquidityTaken.primary.id,rows[1].id);
});

test('persisted Sweep-based WATCH is not restored after cutover', function () {
    var old={id:'OLD',displacement:{startIndex:10},liquidityTaken:{primary:{id:'S'},allCandidates:[{id:'S',sourceType:'EQL'}]}};
    assert.equal(watchEngine.createWatchStore([old],{}).get('OLD'),null);
});

function fvgCandles(direction) {
    var rows=[]; for(var i=0;i<14;i++) rows.push(candle(i,100,101,99,100));
    if(direction==='BULLISH') {
        rows[10]=candle(10,100,101,99,100); rows[11]=candle(11,100,110,99,108); rows[12]=candle(12,106,111,105,109);
        rows[13]=candle(13,106,108,104,105);
    } else {
        rows[10]=candle(10,100,101,99,100); rows[11]=candle(11,100,101,90,92); rows[12]=candle(12,94,97,89,91);
        rows[13]=candle(13,94,98,92,96);
    }
    return rows;
}

['BULLISH','BEARISH'].forEach(function (direction) {
    test(direction+' Taken WATCH reaches FVG FIRST_TOUCH and notification payload boundary', function () {
        var side=direction==='BULLISH'?'SSL':'BSL',sourceType=direction==='BULLISH'?'EQL':'EQH';
        var rows=fvgCandles(direction),result=watch(direction,11,[taken(side,9,sourceType)],rows);
        assert.ok(result && result.nativeFvg); assert.equal(result.state,'WATCH_WAIT_FVG');
        var store=watchEngine.createWatchStore([],{}); store.upsert(result);
        var touched=store.onCandle(rows[13]); assert.equal(touched.length,1);
        var payload=liveMessages.buildFvgRetracementMessage(touched[0],touched[0].firstTouchPrice,
            {zhEnabled:true,sweepContextEnabled:true,notificationGeneratedAt:rows[13].closeTime});
        assert.match(payload,/Liquidity Taken/); assert.match(payload,new RegExp(sourceType));
        assert.doesNotMatch(payload,/流动性扫取|Liquidity Sweep|undefined/);
    });
});
