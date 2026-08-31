'use strict';
var assert = require('assert');
var dw = require('../stats/displacementWatch');
var BAR = 300000, passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.stack); } }
function c(i, o, h, l, close) { return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: o, high: h, low: l, close: close, closed: true }; }
function disp(direction, start, end, sources) {
    return { id: 'X:5m:DISPLACEMENT:' + direction + ':' + end, type: 'DISPLACEMENT', symbol: 'X', timeframe: '5m',
        direction: direction, formationType: start === end ? 'SINGLE_CANDLE' : 'MULTI_CANDLE', startIndex: start,
        endIndex: end, startAt: start * BAR, endAt: (end + 1) * BAR - 1, confirmedAt: (end + 1) * BAR - 1,
        startPrice: 100, endPrice: direction === 'BULLISH' ? 107 : 93,
        sourceDetections: sources || [{ sourceDetectionId: 'RAW:A', source: 'SINGLE_CANDLE_A', attachedAt: (end + 1) * BAR - 1 }] };
}
function sweep(side, i, type) { return { id: 'SW:' + side + ':' + i, side: side, candleIndex: i, confirmedAt: (i + 1) * BAR - 1, liquidityId: 'L:' + i, price: 99, timeframe: '5m', source: { liquidityType: type || (side === 'SSL' ? 'EQL' : 'EQH') } }; }

test('native FVG belongs to canonical formation K2 and needs closed K3', function () {
    var d = disp('BULLISH', 2, 2);
    var candles = [c(0, 99, 100, 98, 99), c(1, 99, 101, 98, 100), c(2, 100, 108, 99, 107)];
    assert.strictEqual(dw.nativeFvgForDisplacement(d, candles), null);
    candles.push(c(3, 107, 111, 105, 110));
    var f = dw.nativeFvgForDisplacement(d, candles);
    assert.deepStrictEqual([f.low, f.high, f.k1OpenTime, f.k2OpenTime, f.k3OpenTime], [101, 105, BAR, 2 * BAR, 3 * BAR]);
});

test('matching liquidity creates one WATCH_NO_FVG direct from canonical displacement', function () {
    var d = disp('BULLISH', 2, 2);
    var w = dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: d.confirmedAt,
        sweepEvents: [sweep('SSL', 1)], candles: [c(0, 99, 100, 98, 99), c(1, 99, 101, 98, 100), c(2, 100, 108, 99, 107)],
        structuralState: { structuralState: 'UNKNOWN', activeProtected: {} }, dailyBias: { bias: 'OPPOSITE' } });
    assert.ok(w); assert.strictEqual(w.state, 'WATCH_NO_FVG'); assert.strictEqual(w.canonicalDisplacementId, d.id);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(w, 'displacementLegId'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(w, 'mss'), false);
    assert.strictEqual(w.dailyBias.bias, 'OPPOSITE');
});

test('A+C2 provenance does not create duplicate WATCH identity', function () {
    var d1 = disp('BULLISH', 2, 2), d2 = JSON.parse(JSON.stringify(d1));
    d2.sourceDetections.push({ sourceDetectionId: 'RAW:C2:N2', source: 'MULTI_CANDLE_C2', attachedAt: d1.confirmedAt + BAR });
    var args = { symbol: 'X', evaluationTime: d1.confirmedAt, sweepEvents: [sweep('SSL', 1)], candles: [], displacement: d1 };
    var w1 = dw.buildWatch(args); args.displacement = d2; args.evaluationTime += BAR; args.existing = w1;
    var w2 = dw.buildWatch(args); assert.strictEqual(w1.id, w2.id); assert.strictEqual(w1.canonicalDisplacementId, w2.canonicalDisplacementId);
});

test('A-only and C2-only canonical events each create a WATCH', function () {
    var a=disp('BULLISH',2,2,[{sourceDetectionId:'RAW:A',source:'SINGLE_CANDLE_A',attachedAt:3*BAR-1}]);
    var c2=disp('BULLISH',4,5,[{sourceDetectionId:'RAW:C2',source:'MULTI_CANDLE_C2',attachedAt:6*BAR-1}]);
    var wa=dw.buildWatch({symbol:'X',displacement:a,evaluationTime:a.confirmedAt,sweepEvents:[sweep('SSL',1,'EQL')],candles:[]});
    var wc=dw.buildWatch({symbol:'X',displacement:c2,evaluationTime:c2.confirmedAt,sweepEvents:[sweep('SSL',3,'EQL')],candles:[]});
    assert.ok(wa);assert.ok(wc);assert.notStrictEqual(wa.id,wc.id);
});

test('opposite canonical directions remain separately WATCH-eligible', function () {
    var bull=disp('BULLISH',2,2),bear=disp('BEARISH',2,2);
    var wb=dw.buildWatch({symbol:'X',displacement:bull,evaluationTime:bull.confirmedAt,sweepEvents:[sweep('SSL',1,'EQL')],candles:[]});
    var ws=dw.buildWatch({symbol:'X',displacement:bear,evaluationTime:bear.confirmedAt,sweepEvents:[sweep('BSL',1,'EQH')],candles:[]});
    assert.ok(wb);assert.ok(ws);assert.notStrictEqual(wb.id,ws.id);
});

test('later A/C2 evidence cannot duplicate FIRST_TOUCH identity', function () {
    var d1=disp('BULLISH',2,2),d2=JSON.parse(JSON.stringify(d1));
    d2.sourceDetections.push({sourceDetectionId:'RAW:C2',source:'MULTI_CANDLE_C2',attachedAt:4*BAR-1});
    var candles=[c(0,99,100,98,99),c(1,99,101,98,100),c(2,100,108,99,107),c(3,107,111,105,110)];
    var args={symbol:'X',displacement:d1,evaluationTime:candles[3].closeTime,sweepEvents:[sweep('SSL',1,'EQL')],candles:candles};
    var w1=dw.buildWatch(args);args.displacement=d2;args.existing=w1;var w2=dw.buildWatch(args);
    assert.strictEqual(w1.notificationKey,w2.notificationKey);var store=dw.createWatchStore([],{});store.upsert(w1);store.upsert(w2);
    assert.strictEqual(store.onPrice(106,5*BAR).length,0);assert.strictEqual(store.onPrice(104,5*BAR+1).length,1);assert.strictEqual(store.onPrice(103,5*BAR+2).length,0);
});

test('later backward-reaching evidence cannot retroactively associate an old sweep', function () {
    var d=disp('BULLISH',60,60);d.sourceDetections.push({sourceDetectionId:'RAW:C2:LATER',source:'MULTI_CANDLE_C2',startIndex:0,endIndex:61,startAt:0,endAt:62*BAR-1,attachedAt:62*BAR-1});
    assert.strictEqual(dw.buildWatch({symbol:'X',displacement:d,evaluationTime:62*BAR-1,sweepEvents:[sweep('SSL',11,'EQL')],candles:[]}),null);
});

test('opposite or Swing-only liquidity cannot create WATCH', function () {
    var d = disp('BULLISH', 2, 2);
    assert.strictEqual(dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: d.confirmedAt, sweepEvents: [sweep('BSL', 1)], candles: [] }), null);
    assert.strictEqual(dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: d.confirmedAt, sweepEvents: [sweep('SSL', 1, 'SWING_LOW')], candles: [] }), null);
});

test('mixed Swing + EQL keeps only EQL and uses it as primary', function () {
    var d = disp('BULLISH', 3, 3);
    var w = dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: d.confirmedAt,
        sweepEvents: [sweep('SSL', 2, 'SWING_LOW'), sweep('SSL', 1, 'EQL')], candles: [] });
    assert.ok(w); assert.deepStrictEqual(w.liquidityTaken.allCandidates.map(function (x) { return x.sourceType; }), ['EQL']);
    assert.strictEqual(w.liquidityTaken.primary.sourceType, 'EQL');
});

test('sweep confirmed after immutable canonical end cannot create WATCH', function () {
    var d = disp('BULLISH', 2, 2), future = sweep('SSL', 3, 'EQL');
    assert.strictEqual(dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: future.confirmedAt, sweepEvents: [future], candles: [] }), null);
});

test('persisted non-canonical WATCH is dropped at destructive cutover', function () {
    var store = dw.createWatchStore([{ id: 'OLD', displacementLegId: 'LEG:1', liquidityTaken: { matched: true, allCandidates: [] } }], {});
    assert.strictEqual(store.get('OLD'), null);
});

test('K3 upgrade uses native geometry across canonical formation, not global registry', function () {
    var d = disp('BEARISH', 2, 2);
    var candles = [c(0, 101, 102, 100, 101), c(1, 101, 103, 99, 100), c(2, 100, 101, 92, 93), c(3, 93, 97, 90, 91)];
    var w = dw.buildWatch({ symbol: 'X', displacement: d, evaluationTime: candles[3].closeTime,
        sweepEvents: [sweep('BSL', 1)], candles: candles, globalFvgRegistry: [{ id: 'MUST_NOT_BE_READ' }] });
    assert.strictEqual(w.state, 'WATCH_WAIT_FVG'); assert.deepStrictEqual([w.nativeFvg.low, w.nativeFvg.high], [97, 99]);
    assert.ok(/:FIRST_TOUCH$/.test(w.notificationKey));
});

test('first real-time entry touches once and successful delivery dedupes', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id: 'W', canonicalDisplacementId: 'D', direction: 'BULLISH', state: 'WATCH_WAIT_FVG', updatedAt: 100,
        notificationKey: 'W:F:FIRST_TOUCH', nativeFvg: { id: 'F', low: 100, high: 105 } });
    assert.strictEqual(store.onPrice(106, 200).length, 0); assert.strictEqual(store.onPrice(104, 201).length, 1);
    assert.strictEqual(store.onPrice(103, 202).length, 0); store.markNotified('W', 203);
    assert.strictEqual(store.get('W').state, 'NOTIFIED'); assert.strictEqual(store.onPrice(102, 204).length, 0);
});

test('historical replay cannot self-touch formation candle', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id: 'W', canonicalDisplacementId: 'D', direction: 'BULLISH', state: 'WATCH_WAIT_FVG', updatedAt: 100,
        notificationKey: 'W:F:FIRST_TOUCH', nativeFvg: { id: 'F', low: 100, high: 105 } });
    assert.strictEqual(store.onCandle({ closeTime: 100, open: 106, high: 107, low: 103, close: 104 }).length, 0);
    assert.strictEqual(store.onCandle({ closeTime: 200, open: 106, high: 107, low: 104, close: 105 }).length, 1);
});

test('terminal formation is frozen against later evidence enrichment', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id:'W', canonicalDisplacementId:'D', direction:'BULLISH', state:'WATCH_WAIT_FVG', updatedAt:100,
        notificationKey:'W:F:FIRST_TOUCH', nativeFvg:{id:'F',low:100,high:105}, liquidityTaken:{primary:{id:'OLD'}} });
    store.onPrice(103, 200);
    store.upsert({ id:'W', canonicalDisplacementId:'D', direction:'BULLISH', state:'WATCH_WAIT_FVG', updatedAt:300,
        notificationKey:'W:F:FIRST_TOUCH', nativeFvg:{id:'F',low:100,high:105}, liquidityTaken:{primary:{id:'FUTURE'}} });
    assert.strictEqual(store.get('W').liquidityTaken.primary.id, 'OLD'); assert.strictEqual(store.get('W').updatedAt, 100);
});

if (failed) { console.error('FAILED ' + failed + '/' + (passed + failed)); process.exit(1); }
console.log('PASSED ' + passed + '/' + passed);
