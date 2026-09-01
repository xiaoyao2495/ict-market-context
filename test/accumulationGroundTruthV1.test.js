'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var audit = require('../audit/accumulationGroundTruthV1');

var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function c(i,o,h,l,cl){return{openTime:i*300000,closeTime:(i+1)*300000-1,open:o,high:h,low:l,close:cl,closed:true};}
var candles=[c(0,5,6,4,5),c(1,5,9,4,8),c(2,8,9,3,4),c(3,4,8,3,7),c(4,7,10,5,9),c(5,9,10,4,5),c(6,5,8,2,3),c(7,3,8,2,7),c(8,7,9,3,4),c(9,4,8,3,7),c(10,7,9,4,5),c(11,5,8,3,7)];
var row={id:'R',startIndex:0,endIndex:11,confirmedAt:candles[11].closeTime,rangeHighAtConfirmation:10,rangeLowAtConfirmation:2,detectorScore:64,detectorBreakdown:{rangeCompression:15,lowEfficiency:20,midCrosses:20,equalLiquidity:8,duration:1},features:{durationBars:12,rangeWidthATR:2.5,upperTouchCount:3,lowerTouchCount:2,midCrossCount:6,rangeOccupancy:.9,directionalDriftATR:.2,preRangeDirectionalMoveATR:-1,preRangeSlope:-.1,preRangeContext:'TREND_DOWN',featureSourceStartIndex:0,featureSourceEndIndex:11}};
var baseline={researchFeatures:{touchToleranceRangeFraction:.1},detector:{confirmThreshold:60}};
var displacement={id:'D',direction:'BULLISH',confirmedAt:candles[5].closeTime,candleIndex:5,metadata:{score:4,rangeAtr:1.7}};

test('human label parser preserves explicit and unreviewed semantics',function(){assert.strictEqual(audit.humanLabel('case003'),'NO_A');assert.strictEqual(audit.humanLabel('case022'),'BORDERLINE_A');assert.strictEqual(audit.humanLabel('case001'),'UNREVIEWED');});
test('unreviewed case remains UNREVIEWED',function(){assert.strictEqual(audit.humanLabel('case060'),'UNREVIEWED');});
test('false-positive cohort exactly 13',function(){assert.strictEqual(audit.FALSE_POSITIVE_CASES.length,13);assert.strictEqual(new Set(audit.FALSE_POSITIVE_CASES).size,13);});
test('borderline cohorts are exactly 3 machine positives + 1 control',function(){assert.deepStrictEqual(audit.BORDERLINE_POSITIVE_CASES,['case022','case036','case037']);assert.deepStrictEqual(audit.BORDERLINE_CONTROL_CASES,['case071']);});
test('case071 remains BORDERLINE_A',function(){assert.strictEqual(audit.humanLabel('case071'),'BORDERLINE_A');});
test('feature extraction is formation-only and ignores appended future candles',function(){var a=audit.buildDiagnostic(row,candles,[displacement],baseline);var extended=candles.concat([c(12,100,200,1,150)]);var b=audit.buildDiagnostic(row,extended,[displacement,{id:'F',direction:'BEARISH',confirmedAt:extended[12].closeTime,candleIndex:12,metadata:{score:5,rangeAtr:9}}],baseline);assert.deepStrictEqual(a,b);assert.strictEqual(a.featureSourceEndIndex,row.endIndex);});
test('temporal interaction deterministic',function(){assert.deepStrictEqual(audit.buildDiagnostic(row,candles,[],baseline),audit.buildDiagnostic(row,candles,[],baseline));});
test('occupancy thirds deterministic and sum to one',function(){var f=audit.buildDiagnostic(row,candles,[],baseline);assert.ok(Math.abs(f.lowerOccupancyPct+f.midOccupancyPct+f.upperOccupancyPct-1)<1e-12);});
test('boundary stability deterministic and as-of correct',function(){var f=audit.buildDiagnostic(row,candles,[],baseline);assert.strictEqual(f.highEstablishedBar,5);assert.strictEqual(f.lowEstablishedBar,7);assert.ok(f.rangeExpansionEvents>=1);});
test('migration deterministic',function(){var a=audit.buildDiagnostic(row,candles,[],baseline),b=audit.buildDiagnostic(row,candles,[],baseline);assert.strictEqual(a.formationPositionShift,b.formationPositionShift);});
test('EQ score counterfactual deterministic',function(){var f=audit.buildDiagnostic(row,candles,[],baseline);assert.strictEqual(f.scoreWithEQ,64);assert.strictEqual(f.scoreWithoutEQ,56);assert.strictEqual(f.eqDependentConfirmation,true);});
test('production baseline files remain byte-identical after audit call',function(){var root=path.join(__dirname,'..'),files=['amd/accumulationDetector.js','config/thresholds.js','events/displacementDetector.js','live/liveEngine.js','notify/watchNotificationPresentationV1.js'];function h(){return files.map(function(f){return crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex');});}var before=h();audit.buildDiagnostic(row,candles,[displacement],baseline);assert.deepStrictEqual(h(),before);});

console.log('\nAccumulation Ground Truth V1: '+passed+' passed, '+failed+' failed');
if(failed)process.exit(1);
