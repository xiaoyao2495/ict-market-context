'use strict';
var assert=require('assert');
var registryMod=require('../liquidity/liquidityRegistry');
var v3=require('../liquidity/persistentEqualLiquidityV3');
var lifecycle=require('../liquidity/liquidityLifecycle');
var sweepAdapter=require('../events/sweepEventAdapter');
var provenance=require('../stats/liquidityProvenance');
var displacementWatch=require('../stats/displacementWatch');
var replayState=require('../replay/replayState');
var version=require('../config/eqProductionVersion');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function candle(i,low,high,close){return{openTime:i*300000,closeTime:(i+1)*300000-1,open:90,high:high,low:low,close:close===undefined?90:close,closed:true};}
var candles=[]; for(var i=0;i<30;i++) candles.push(candle(i,84,96,90));
for(i=16;i<20;i++) candles[i]=candle(i,70,90,80);
function swing(id,index,price,type){return{id:id,symbol:'BTCUSDT',timeframe:'5m',type:type,side:type==='SWING_HIGH'?'BSL':'SSL',price:price,sourceOpenTime:candles[index].openTime,sourceCloseTime:candles[index].closeTime,createdAt:candles[index+2].closeTime,confirmedAt:candles[index+2].closeTime,status:'ACTIVE',touchedAt:null,sweptAt:null,brokenAt:null,metadata:{index:index,right:2}};}
function fixture(){var registry=registryMod.createRegistry(),a=swing('A',15,100,'SWING_HIGH'),b=swing('B',20,100.1,'SWING_HIGH');registry.add(a);registry.add(b);var state={symbol:'BTCUSDT',timeframe:'5m',registry:registry};v3.processCandidates(state,[b],{symbol:'BTCUSDT',evaluationTime:b.confirmedAt,tickSize:.1,candles:candles,index:22});return{state:state,registry:registry,a:a,b:b,cluster:registry.getByType('BTCUSDT','EQH')[0]};}

test('V3 is the default and V2 remains explicit rollback',function(){assert.strictEqual(version.get({}),'V3');assert.strictEqual(replayState.createReplayState({eqProductionVersion:'V2'}).eqProductionVersion,'V2');assert.strictEqual(replayState.createReplayState({env:{EQ_PRODUCTION_VERSION:'V2'}}).eqProductionVersion,'V2');});
test('V3 EQ enters Registry with stable cluster identity',function(){var f=fixture();assert.ok(f.cluster);assert.ok(f.cluster.id.indexOf('EQV3:BTCUSDT:5m:EQH:')===0);assert.strictEqual(f.cluster.liquidityType,'EQH');});
test('formation anchor and reference mean are preserved',function(){var f=fixture();assert.strictEqual(f.cluster.metadata.formationAnchorId,'A');assert.strictEqual(f.cluster.price,100.05);});
test('third member append keeps ID and records memberAddedAt',function(){var f=fixture(),id=f.cluster.id,c=swing('C',24,100.2,'SWING_HIGH');f.registry.add(c);v3.processCandidates(f.state,[c],{symbol:'BTCUSDT',evaluationTime:c.confirmedAt,tickSize:.1,candles:candles,index:26});assert.strictEqual(f.cluster.id,id);assert.strictEqual(f.cluster.metadata.memberCount,3);assert.strictEqual(f.cluster.metadata.members[2].memberAddedAt,c.confirmedAt);});
test('as-of projection excludes future member',function(){var f=fixture(),c=swing('C',24,100.2,'SWING_HIGH');f.registry.add(c);v3.processCandidates(f.state,[c],{symbol:'BTCUSDT',evaluationTime:c.confirmedAt,tickSize:.1,candles:candles,index:26});var p=v3.projectMembersAsOf(f.cluster,f.b.confirmedAt);assert.deepStrictEqual(p.members.map(function(x){return x.id;}),['A','B']);assert.strictEqual(p.referencePrice,100.05);});
test('Registry JSON roundtrip preserves identity and member temporal fields',function(){var f=fixture(),copy=JSON.parse(JSON.stringify(f.cluster));assert.strictEqual(copy.id,f.cluster.id);assert.deepStrictEqual(copy.metadata.members,f.cluster.metadata.members);});
test('deterministic restart reconstruction preserves cluster',function(){var one=fixture().cluster,two=fixture().cluster;assert.deepStrictEqual(JSON.parse(JSON.stringify(one)),JSON.parse(JSON.stringify(two)));});
test('existing lifecycle turns V3 EQ into SWEPT',function(){var f=fixture(),c=candle(23,95,101,99),event=lifecycle.evaluateLiquidity(f.cluster,c);assert.strictEqual(event.status,'SWEPT');});
test('existing Sweep adapter freezes V3 member identity and price',function(){var f=fixture(),c=candle(23,95,101,99),event=lifecycle.evaluateLiquidity(f.cluster,c);Object.assign(f.cluster,event);var sweep=sweepAdapter.buildSweepEvent(f.cluster,c,23);assert.strictEqual(sweep.source.liquidityType,'EQH');assert.strictEqual(sweep.source.eqMemberProvenance.memberCount,2);assert.strictEqual(sweep.price,100.05);});
test('V3 EQ Sweep reaches liquidityTaken using V3 cluster ID',function(){var f=fixture(),c=candle(23,95,101,99),event=lifecycle.evaluateLiquidity(f.cluster,c);Object.assign(f.cluster,event);var sweep=sweepAdapter.buildSweepEvent(f.cluster,c,23);var displacement={id:'D1',type:'DISPLACEMENT',direction:'BEARISH',startIndex:24,endIndex:24,startAt:c.closeTime+1,endAt:c.closeTime+1000,confirmedAt:c.closeTime+1000,sourceDetections:[]};var watch=displacementWatch.buildWatch({symbol:'BTCUSDT',displacement:displacement,evaluationTime:displacement.confirmedAt,sweepEvents:[sweep],candles:candles});assert.ok(watch);assert.strictEqual(watch.liquidityTaken.primary.sourceId,f.cluster.id);assert.strictEqual(watch.liquidityTaken.primary.eqMemberProvenance.memberCount,2);});
test('ordinary Swing remains excluded from Narrative WATCH candidates',function(){var f=fixture(),c=candle(23,95,101,99),s=sweepAdapter.buildSweepEvent(f.a,c,23),displacement={id:'D1',type:'DISPLACEMENT',direction:'BEARISH',startIndex:24,endIndex:24,startAt:c.closeTime+1,endAt:c.closeTime+1000,confirmedAt:c.closeTime+1000,sourceDetections:[]};assert.strictEqual(displacementWatch.buildWatch({symbol:'BTCUSDT',displacement:displacement,evaluationTime:displacement.confirmedAt,sweepEvents:[s],candles:candles}),null);});
test('historical Sweep snapshot cannot be mutated by later Registry members',function(){var f=fixture(),c=candle(23,95,101,99),sweep=sweepAdapter.buildSweepEvent(f.cluster,c,23);f.cluster.metadata.members.push(v3.memberRecord(swing('FUTURE',24,90,'SWING_HIGH'),c.closeTime+10000));f.cluster.price=96;assert.strictEqual(sweep.price,100.05);assert.deepStrictEqual(sweep.source.eqMemberProvenance.members.map(function(x){return x.id;}),['A','B']);});

if(failed){console.error('EQ V3 Production Migration failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('EQ V3 Production Migration '+passed+'/'+passed);
