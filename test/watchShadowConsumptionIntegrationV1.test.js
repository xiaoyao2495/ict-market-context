'use strict';
var assert = require('assert');
var fs = require('fs');
var crypto = require('crypto');
var adapter = require('../audit/shadowWatchConsumptionAdapterV1');
var passed=0, failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function sweep(overrides){return Object.assign({id:'SWEEP:S1',sourceId:'BTCUSDT:5m:SWING_LOW:1',sourceType:'SWING_LOW',sourceTimeframe:'5m',sourcePrice:99,side:'SSL',confirmedAt:150,candleIndex:5,relation:'BEFORE_LEG',barsBeforeLegStart:2},overrides||{});}
function watch(candidates,primary,bias){return{id:'W',updatedAt:200,direction:'BULLISH',liquidityTaken:{allCandidates:candidates,primary:primary||candidates[0]},dailyBias:bias||{bias:'BULLISH',evaluationTime:190}};}
function life(id,type,status,at){return{eventId:id,eventType:type,status:status,availableAt:at,source:'TEST'};}
function eventsFor(candidate,extra){return Object.assign({},extra||{},((function(){var o={};o[candidate.sourceId]=[life(candidate.id,'LIQUIDITY_SWEPT','SWEPT',candidate.confirmedAt)];return o;})()));}
function snap(candidate,extra){return adapter.buildShadowWatchEvidenceSnapshot({watch:watch([candidate]),evaluationTime:200,temporalEventsBySourceId:eventsFor(candidate,extra)});}
function fileHash(f){return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}

test('1 canonicalSwingId mapping',function(){assert.strictEqual(snap(sweep()).swing.canonicalSwingId,'BTCUSDT:5m:SWING_LOW:1');});
test('2 SWING_HIGH -> BSL',function(){var c=sweep({sourceId:'H',sourceType:'SWING_HIGH',side:'BSL'});assert.strictEqual(snap(c).swing.liquiditySide,'BSL');});
test('3 SWING_LOW -> SSL',function(){assert.strictEqual(snap(sweep()).swing.liquiditySide,'SSL');});
test('4 ACTIVE lifecycle at correct time',function(){var p=adapter.projectTemporalEvidence([life('A','LIQUIDITY_ACTIVE','ACTIVE',100)],110);assert.strictEqual(p.lifecycle.status,'ACTIVE');});
test('5 TOUCHED lifecycle at correct time',function(){var p=adapter.projectTemporalEvidence([life('A','LIQUIDITY_ACTIVE','ACTIVE',100),life('T','LIQUIDITY_TOUCHED','TOUCHED',120)],130);assert.strictEqual(p.lifecycle.status,'TOUCHED');});
test('6 SWEPT lifecycle at correct time',function(){var p=adapter.projectTemporalEvidence([life('S','LIQUIDITY_SWEPT','SWEPT',150)],160);assert.strictEqual(p.lifecycle.status,'SWEPT');});
test('7 BROKEN lifecycle at correct time',function(){var p=adapter.projectTemporalEvidence([life('S','LIQUIDITY_SWEPT','SWEPT',150),life('B','LIQUIDITY_BROKEN','BROKEN',180)],190);assert.strictEqual(p.lifecycle.status,'BROKEN');});
test('8 future lifecycle hidden',function(){var es=[life('A','LIQUIDITY_ACTIVE','ACTIVE',100),life('S','LIQUIDITY_SWEPT','SWEPT',150),life('B','LIQUIDITY_BROKEN','BROKEN',180)];assert.strictEqual(adapter.projectTemporalEvidence(es,160).lifecycle.status,'SWEPT');});
test('9 sweep provenance complete',function(){var x=snap(sweep());assert.strictEqual(x.productionPrimaryMirror.provenance.complete,true);assert.ok(x.sweep.eventId&&x.sweep.sourceId&&x.sweep.confirmedAt);});
test('10 future sweep hidden',function(){var a=sweep(),f=sweep({id:'F',sourceId:'F',confirmedAt:250});var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([a,f],a),evaluationTime:200,temporalEventsBySourceId:eventsFor(a)});assert.strictEqual(x.allDirectionMatchingSweepCandidates.length,1);});
test('11 EQ membership temporal-safe',function(){var c=sweep({id:'SE',sourceId:'EQ1',sourceType:'EQL'});var ev=[life('SE','LIQUIDITY_SWEPT','SWEPT',150),{eventId:'M1',eventType:'EQ_MEMBER_ATTACHED',eqObjectId:'EQ1',canonicalSwingId:'L1',availableAt:160},{eventId:'M2',eventType:'EQ_MEMBER_ATTACHED',eqObjectId:'EQ1',canonicalSwingId:'L2',availableAt:210}];var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([c]),evaluationTime:200,temporalEventsBySourceId:{EQ1:ev}});assert.deepStrictEqual(x.swing.canonicalSwingIds,['L1']);});
test('12 multiple sweep candidates preserved',function(){var a=sweep(),b=sweep({id:'SWEEP:S2',sourceId:'S2',confirmedAt:140});var map=eventsFor(a);map.S2=[life(b.id,'LIQUIDITY_SWEPT','SWEPT',140)];var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([a,b],a),evaluationTime:200,temporalEventsBySourceId:map});assert.strictEqual(x.allDirectionMatchingSweepCandidates.length,2);});
test('13 primary semantic is recency heuristic',function(){assert.strictEqual(snap(sweep()).primarySelectionSemantic,'CURRENT_PRODUCTION_RECENCY_HEURISTIC');});
test('14 no causal-primary claim',function(){assert.strictEqual(snap(sweep()).causalPrimaryClaim,false);});
test('15 Bullish + SSL = MATCH',function(){assert.strictEqual(adapter.alignBiasToLiquidity('BULLISH','SSL'),'MATCH');});
test('16 Bearish + BSL = MATCH',function(){assert.strictEqual(adapter.alignBiasToLiquidity('BEARISH','BSL'),'MATCH');});
test('17 Bullish + BSL = OPPOSITE',function(){assert.strictEqual(adapter.alignBiasToLiquidity('BULLISH','BSL'),'OPPOSITE');});
test('18 Bearish + SSL = OPPOSITE',function(){assert.strictEqual(adapter.alignBiasToLiquidity('BEARISH','SSL'),'OPPOSITE');});
test('19 B/C SAFE_NOW snapshot identical',function(){var c=sweep(),opts={watch:watch([c]),evaluationTime:200,temporalEventsBySourceId:eventsFor(c)};var b=adapter.buildShadowWatchEvidenceSnapshot(Object.assign({reactionPolicy:'B'},opts));var d=adapter.buildShadowWatchEvidenceSnapshot(Object.assign({reactionPolicy:'C'},opts));assert.strictEqual(b.evidenceHash,d.evidenceHash);});
test('20 policy-dependent causal evidence blocked',function(){var b=snap(sweep()).blockedCausalEvidence;assert.strictEqual(b.reactionLegProductionAllowed,false);assert.strictEqual(b.attributedMssProductionAllowed,false);assert.strictEqual(b.sameDeliveryDisplacementProductionAllowed,false);});
test('21 missing Swing identity remains UNRESOLVED',function(){var c=sweep({sourceId:null});var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([c]),evaluationTime:200,temporalEventsBySourceId:{}});assert.strictEqual(x.swing.identityResolution,'UNRESOLVED');});
test('22 no nearest-Swing guessing',function(){var c=sweep({sourceId:'PDH:1',sourceType:'PDH',side:'BSL'});var x=snap(c);assert.strictEqual(x.swing.canonicalSwingId,null);assert.deepStrictEqual(x.swing.canonicalSwingIds,[]);});
test('23 incremental = full',function(){var es=[life('A','LIQUIDITY_ACTIVE','ACTIVE',100),life('T','LIQUIDITY_TOUCHED','TOUCHED',120),life('S','LIQUIDITY_SWEPT','SWEPT',150)];var p=adapter.projectTemporalEvidence(es,120);var inc=adapter.advanceTemporalEvidence(p,es,160);var full=adapter.projectTemporalEvidence(es,160);assert.strictEqual(adapter.stable(inc),adapter.stable(full));});
test('24 past snapshot immutable',function(){var es=[life('A','LIQUIDITY_ACTIVE','ACTIVE',100),life('S','LIQUIDITY_SWEPT','SWEPT',150)];var old=adapter.projectTemporalEvidence(es,120),hash=adapter.evidenceHash(old);adapter.advanceTemporalEvidence(old,es,160);assert.strictEqual(adapter.evidenceHash(old),hash);});
test('25 deterministic candidate ordering',function(){var a=sweep(),b=sweep({id:'A',sourceId:'S2',confirmedAt:140}),map=eventsFor(a);map.S2=[life('A','LIQUIDITY_SWEPT','SWEPT',140)];var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([a,b],a),evaluationTime:200,temporalEventsBySourceId:map});assert.deepStrictEqual(x.allDirectionMatchingSweepCandidates.map(function(c){return c.sweepEventId;}),['A','SWEEP:S1']);});
test('26 deterministic serialization',function(){var c=sweep(),a=snap(c),b=snap(c);assert.strictEqual(a.serialization,b.serialization);assert.strictEqual(a.evidenceHash,b.evidenceHash);});
test('27 missing provenance rejected/flagged',function(){var c=sweep({sourceId:null});var x=adapter.buildShadowWatchEvidenceSnapshot({watch:watch([c]),evaluationTime:200,temporalEventsBySourceId:{}});assert.strictEqual(x.provenance.safeNowMissingProvenance,1);});
test('28 production WATCH behavior unchanged',function(){var f=require.resolve('../stats/displacementWatch'),before=fileHash(f),c=sweep();snap(c);assert.strictEqual(fileHash(f),before);});

if(failed){console.error('WATCH Shadow Consumption Integration V1 failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('WATCH Shadow Consumption Integration V1 '+passed+'/'+passed);
