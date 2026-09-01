'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var thresholds = require('../config/thresholds');
var atr = require('../indicators/atr');
var research = require('../audit/accumulationResearchV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.stack); }
}
var BAR = 300000;
function candle(i, close) { var t = 1000000 + i * BAR; return { openTime: t, closeTime: t + BAR - 1, open: close - 0.2, high: close + 1.5, low: close - 1.5, close: close, closed: true }; }
function chop(n) { var p = [100,98,102,99,103,97,101,99,103,98,102,100,104,97,101,99,102,98,100,101,99,103,100,102]; return Array.from({ length: n }, function (_, i) { return candle(i, p[i % p.length]); }); }
var config = { thresholds: thresholds, atrPeriod: 14, research: { touchToleranceRangeFraction: 0.1, preRangeBars: 8 }, control: { durationBars: 12, strideBars: 6, maxCandidateOverlap: 0.5 } };
function detect(cs, evaluationTime) { return research.detectCandidate({ candles: cs, index: cs.length - 1, evaluationTime: evaluationTime === undefined ? cs[cs.length - 1].closeTime : evaluationTime, timeframe: '5m', symbol: 'BTCUSDT' }, config); }

test('accumulation candidate deterministic', function () { var cs = chop(24); assert.deepStrictEqual(detect(cs), detect(cs)); });
test('confirmedAt no-future safety', function () { var cs = chop(24); assert.strictEqual(detect(cs, cs[22].closeTime), null); });
test('formation snapshot immutable after future candle append', function () { var cs = chop(24), c = detect(cs), frozen = JSON.stringify(c); cs.push(candle(24, 150)); assert.strictEqual(JSON.stringify(c), frozen); });
test('rangeHigh/rangeLow are correct as-of', function () { var cs = chop(24), c = detect(cs), view = cs.slice(c.startIndex, c.endIndex + 1); assert.strictEqual(c.rangeHighAtConfirmation, Math.max.apply(null, view.map(function (x) { return x.high; }))); assert.strictEqual(c.rangeLowAtConfirmation, Math.min.apply(null, view.map(function (x) { return x.low; }))); });
test('ATR feature equals Wilder ATR at confirmed index', function () { var cs = chop(24), c = detect(cs); assert.ok(Math.abs(c.features.atr14 - atr.atr(cs, 14, c.endIndex)) < 1e-12); });
test('interaction features deterministic', function () { var cs = chop(24), c = detect(cs); assert.deepStrictEqual(research.features(cs, c.startIndex, c.endIndex, c.features.atr14, config.research), c.features); });
test('pre-range features never read after confirmed index', function () { var cs = chop(24), c = detect(cs); assert.ok(c.features.featureSourceStartIndex <= c.startIndex); assert.strictEqual(c.features.featureSourceEndIndex, c.endIndex); });
test('dedupe is deterministic and does not mutate raw population', function () { var cs = chop(24), a = detect(cs), b = JSON.parse(JSON.stringify(a)); b.id += ':B'; b.confirmedAt += BAR; b.endIndex += 1; b.formationEndAt += BAR; var raw = [a,b], before = JSON.stringify(raw), x = research.dedupe(raw,{timeOverlapMin:0.7,priceIouMin:0.8}), y = research.dedupe(raw,{timeOverlapMin:0.7,priceIouMin:0.8}); assert.deepStrictEqual(x,y); assert.strictEqual(x.length,1); assert.strictEqual(JSON.stringify(raw),before); });
test('positive sampling deterministic', function () { var rows=[]; for(var i=0;i<100;i++){var r=JSON.parse(JSON.stringify(detect(chop(24))));r.id='R'+i;r.confirmedAt+=i*BAR;r.features.durationBars=12+i%25;r.features.rangeWidthATR=0.5+(i%20)/10;r.features.preRangeContext=['TREND_UP','TREND_DOWN','NEUTRAL'][i%3];rows.push(r);} assert.deepStrictEqual(research.deterministicSample(rows,60).map(function(x){return x.id;}),research.deterministicSample(rows,60).map(function(x){return x.id;})); });
test('chart cutoff allows no more than two post-confirmation bars', function () { var c=detect(chop(24)), b=research.chartBounds(c,100,24,2); assert.strictEqual(b.featureCutoffIndex,c.endIndex); assert.ok(b.cutoffIndex<=c.endIndex+2); });
test('control sampling deterministic and excludes candidate-overlap windows', function () { var cs=chop(80), c=detect(cs.slice(0,24)); c.startIndex=20;c.endIndex=43;var p1=research.buildControlPopulation(cs,[c],24,config),p2=research.buildControlPopulation(cs,[c],24,config);assert.deepStrictEqual(research.sampleControls(p1,20),research.sampleControls(p2,20));p1.forEach(function(x){var inter=Math.max(0,Math.min(x.endIndex,c.endIndex)-Math.max(x.startIndex,c.startIndex)+1);assert.ok(inter/config.control.durationBars<config.control.maxCandidateOverlap);}); });
test('research module causes no production source mutation', function () { var root=path.join(__dirname,'..'), files=['events/displacementDetector.js','live/liveEngine.js','notify/watchNotificationPresentationV1.js']; function hashes(){return files.map(function(f){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');});} var before=hashes(); detect(chop(24)); assert.deepStrictEqual(hashes(),before); });

console.log('\nAccumulation Research V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
