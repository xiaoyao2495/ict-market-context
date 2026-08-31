'use strict';
var assert = require('assert');
var detector = require('../events/multiCandleDisplacementDetector');
var BAR = 300000, passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.stack); } }
function candles(closes) { return closes.map(function (close, i) { return { openTime:i*BAR, closeTime:(i+1)*BAR-1, open:close, high:close+1, low:close-1, close:close, closed:true }; }); }
function opts(n, atr) { var a=[]; for(var i=0;i<n;i++) a.push(atr); return {symbol:'X',timeframe:'5m',atrSeries:a}; }

test('C2 evaluates N2-N5 independently at the same closed end candle', function () {
    var cs = candles([100,101,102,103,104,110]);
    var rows = detector.detectAt(cs, 5, opts(cs.length, 5));
    assert.deepStrictEqual(rows.map(function(r){return r.metrics.N;}), [2,3,4,5]);
    rows.forEach(function(r){ assert.strictEqual(r.source,'MULTI_CANDLE_C2'); assert.strictEqual(r.direction,'BULLISH'); assert.strictEqual(r.endIndex,5); });
});

test('move, efficiency, and speed thresholds are all inclusive and required', function () {
    var cfg={events:{displacement:{multiCandle:{nVariants:[2],normalizedMoveThreshold:1,directionalEfficiencyThreshold:0.7,normalizedSpeedThreshold:0.3}}}};
    var exact=candles([100,100,105]);
    assert.strictEqual(detector.detectAt(exact,2,{symbol:'X',timeframe:'5m',atrSeries:[5,5,5],thresholds:cfg}).length,1);
    var inefficient=candles([100,107,105]);
    assert.strictEqual(detector.detectAt(inefficient,2,{symbol:'X',timeframe:'5m',atrSeries:[5,5,5],thresholds:cfg}).length,0);
    var slowCfg=JSON.parse(JSON.stringify(cfg)); slowCfg.events.displacement.multiCandle.normalizedSpeedThreshold=0.51;
    assert.strictEqual(detector.detectAt(exact,2,{symbol:'X',timeframe:'5m',atrSeries:[5,5,5],thresholds:slowCfg}).length,0);
});

test('open candle, missing ATR, and flat delivery fail closed', function () {
    var cs=candles([100,101,105]); var o=opts(3,5);
    cs[2].closed=false; assert.strictEqual(detector.detectAt(cs,2,o).length,0);
    cs[2].closed=true; o.atrSeries[2]=null; assert.strictEqual(detector.detectAt(cs,2,o).length,0);
    assert.strictEqual(detector.detectAt(candles([100,100,100]),2,opts(3,5)).length,0);
});

test('prefix output is unchanged after future candles append', function () {
    var cs=candles([100,101,102,108]); var a=detector.detectMultiCandleDisplacement(cs,opts(4,5));
    var full=cs.concat([{openTime:4*BAR,closeTime:5*BAR-1,open:110,high:111,low:109,close:110,closed:true}]);
    var b=detector.detectMultiCandleDisplacement(full,opts(full.length,5)).filter(function(r){return r.confirmedAt<=cs[3].closeTime;});
    assert.deepStrictEqual(b,a);
});

if (failed) { console.error('FAILED ' + failed + '/' + (passed + failed)); process.exit(1); }
console.log('PASSED ' + passed + '/' + passed);
