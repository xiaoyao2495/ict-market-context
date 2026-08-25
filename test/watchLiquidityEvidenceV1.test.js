'use strict';
var assert=require('assert'),crypto=require('crypto');
var flag=require('../config/watchLiquidityEvidenceV1');
var evidence=require('../stats/watchLiquidityEvidenceV1');
var shadow=require('../audit/shadowWatchConsumptionAdapterV1');
var scenario=require('../scenario/scenarioEngine');
var liveEngine=require('../live/liveEngine');
var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(e){failed++;console.log('FAIL  '+name+' -> '+e.stack);}}
function clone(v){return JSON.parse(JSON.stringify(v));}function stable(v){if(Array.isArray(v))return'['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return'{'+Object.keys(v).sort().map(function(k){return JSON.stringify(k)+':'+stable(v[k]);}).join(',')+'}';return JSON.stringify(v);}function hash(v){return crypto.createHash('sha256').update(stable(v)).digest('hex');}
function candidate(o){return Object.assign({id:'SW1',sourceId:'BTCUSDT:5m:SWING_LOW:1',sourceType:'SWING_LOW',sourceTimeframe:'5m',sourcePrice:100,side:'SSL',confirmedAt:150,candleIndex:1,relation:'BEFORE_LEG',barsBeforeLegStart:2},o||{});}
function watch(cs,p,bias){return{id:'W',updatedAt:200,createdAt:200,direction:'BULLISH',state:'WATCH_NO_FVG',notificationKey:null,liquidityTaken:{primary:p||cs[0],allCandidates:cs},dailyBias:bias||{bias:'UNKNOWN',alignment:'UNKNOWN',status:'UNKNOWN',evaluationTime:null}};}
function registry(objects){var by={};(objects||[]).forEach(function(o){by[o.id]=o;});return{getById:function(id){return by[id]||null;}};}
function source(c,o){return Object.assign({id:c.sourceId,type:c.sourceType,side:c.side,price:c.sourcePrice,confirmedAt:100,status:'SWEPT',touchedAt:c.confirmedAt,sweptAt:c.confirmedAt,brokenAt:null,metadata:{}},o||{});}
function candle(i,close){return{openTime:i*10,closeTime:i*10+9,open:100,high:101,low:99,close:close,closed:true};}
function opts(c,extra){return Object.assign({enabled:true,evaluationTime:200,registry:registry([source(c)]),candles:[candle(0,100),candle(1,100),candle(2,100)]},extra||{});}
function built(c,extra){var w=watch([c]);return evidence.attach(w,opts(c,extra)).liquidityEvidenceV1;}

test('1 flag default false',function(){assert.strictEqual(flag.DEFAULT_ENABLED,false);assert.strictEqual(flag.isEnabled({}),false);});
test('2 flag OFF no liquidityEvidenceV1',function(){var c=candidate(),w=watch([c]);evidence.attach(w,{enabled:false});assert.strictEqual(w.liquidityEvidenceV1,undefined);});
test('3 flag OFF exact old behavior',function(){var c=candidate(),w=watch([c]),before=hash(w);evidence.attach(w,{enabled:false});assert.strictEqual(hash(w),before);});
test('4 flag ON adds liquidityEvidenceV1',function(){assert.strictEqual(built(candidate()).schemaVersion,'WatchLiquidityEvidenceV1');});
test('5 flag ON WATCH count unchanged',function(){var c=candidate(),ws=[watch([c]),watch([c])];ws.forEach(function(w){evidence.attach(w,opts(c));});assert.strictEqual(ws.length,2);});
test('6 WATCH timing unchanged',function(){var c=candidate(),w=watch([c]),before=[w.createdAt,w.updatedAt];evidence.attach(w,opts(c));assert.deepStrictEqual([w.createdAt,w.updatedAt],before);});
test('7 WATCH direction unchanged',function(){var c=candidate(),w=watch([c]),before=w.direction;evidence.attach(w,opts(c));assert.strictEqual(w.direction,before);});
test('8 Scenario unchanged',function(){var input={symbol:'X',evaluationTime:200,bias:{direction:'BULLISH',confidence:'HIGH'},draw:{direction:'BSL'},amd:{direction:'BULLISH',state:'MANIPULATION_CONFIRMED',confirmedAt:190},alignment:'MATCH',conflicts:[]};var before=scenario.runScenarioEngine(input);built(candidate());var after=scenario.runScenarioEngine(input);assert.deepStrictEqual(after,before);});
test('9 canonicalSwingId mapping',function(){assert.strictEqual(built(candidate()).liquidity.canonicalSwingId,'BTCUSDT:5m:SWING_LOW:1');});
test('10 SWING_HIGH -> BSL',function(){var c=candidate({sourceId:'H',sourceType:'SWING_HIGH',side:'BSL'});assert.strictEqual(built(c).liquidity.liquiditySide,'BSL');});
test('11 SWING_LOW -> SSL',function(){assert.strictEqual(built(candidate()).liquidity.liquiditySide,'SSL');});
test('12 EQ identity mapping',function(){var c=candidate({sourceId:'EQ1',sourceType:'EQL'}),m1={id:'L1',confirmedAt:100},m2={id:'L2',confirmedAt:250};var x=built(c,{registry:registry([source(c,{metadata:{members:[m1,m2]}})])});assert.strictEqual(x.liquidity.eqObjectId,'EQ1');assert.deepStrictEqual(x.liquidity.canonicalSwingIds,['L1']);});
test('13 lifecycle metadata',function(){var c=candidate(),x=built(c);assert.strictEqual(x.liquidity.lifecycleStatus,'SWEPT');assert.strictEqual(x.liquidity.lifecycleTransitionEventId,c.id);});
test('14 future lifecycle hidden',function(){var c=candidate(),rows=[candle(0,100),candle(1,100),Object.assign(candle(2,99),{closeTime:250,low:98})];var x=built(c,{candles:rows});assert.strictEqual(x.liquidity.lifecycleStatus,'SWEPT');});
test('15 sweep provenance',function(){var c=candidate(),x=built(c);assert.deepStrictEqual([x.sweep.eventId,x.sweep.sourceId,x.sweep.side,x.sweep.direction,x.sweep.confirmedAt],[c.id,c.sourceId,'SSL','BULLISH',150]);});
test('16 future sweep hidden',function(){var a=candidate(),f=candidate({id:'F',sourceId:'F',confirmedAt:250}),w=watch([a,f],a);var x=evidence.attach(w,opts(a)).liquidityEvidenceV1;assert.strictEqual(x.allCandidates.length,1);});
test('17 allCandidates preserved',function(){var a=candidate(),b=candidate({id:'B',sourceId:'B',confirmedAt:140,candleIndex:0}),w=watch([a,b],a);var x=evidence.attach(w,{enabled:true,evaluationTime:200,registry:registry([source(a),source(b)]),candles:[]}).liquidityEvidenceV1;assert.strictEqual(x.allCandidates.length,2);});
test('18 currentPrimary preserved',function(){var c=candidate(),x=built(c);assert.strictEqual(x.currentPrimary.sweepEventId,c.id);assert.strictEqual(x.currentPrimary.sourceId,c.sourceId);});
test('19 selectionSemantic correct',function(){assert.strictEqual(built(candidate()).currentPrimary.selectionSemantic,'CURRENT_PRODUCTION_RECENCY_HEURISTIC');});
test('20 causalPrimaryClaim false',function(){assert.strictEqual(built(candidate()).currentPrimary.causalPrimaryClaim,false);});
test('21 UNKNOWN Bias safe',function(){var x=built(candidate());assert.deepStrictEqual([x.bias.direction,x.bias.alignment],['UNKNOWN','NOT_APPLICABLE']);});
test('22 MATCH mapping',function(){var c=candidate(),x=built(c,{dailyBias:{bias:'BULLISH',alignment:'MATCH',status:'VALID',evaluationTime:100}});assert.strictEqual(x.bias.alignment,'MATCH');});
test('23 OPPOSITE mapping',function(){var c=candidate(),x=built(c,{dailyBias:{bias:'BEARISH',alignment:'OPPOSITE',status:'VALID',evaluationTime:100}});assert.strictEqual(x.bias.alignment,'OPPOSITE');});
test('24 missing identity -> UNRESOLVED',function(){var c=candidate({sourceId:null}),w=watch([c]);var x=evidence.attach(w,{enabled:true,evaluationTime:200,registry:registry([]),candles:[]}).liquidityEvidenceV1;assert.strictEqual(x.identityStatus,'UNRESOLVED');});
test('25 no nearest-Swing guessing',function(){var c=candidate({sourceId:'PDH:1',sourceType:'PDH',side:'BSL'}),x=built(c);assert.strictEqual(x.liquidity.canonicalSwingId,null);assert.deepStrictEqual(x.liquidity.canonicalSwingIds,[]);});
test('26 deterministic candidate ordering',function(){var a=candidate(),b=candidate({id:'B',sourceId:'B',confirmedAt:140,candleIndex:0}),w=watch([a,b],a);var x=evidence.attach(w,{enabled:true,evaluationTime:200,registry:registry([source(a),source(b)]),candles:[]}).liquidityEvidenceV1;assert.deepStrictEqual(x.allCandidates.map(function(c){return c.sweepEventId;}),['B','SW1']);});
test('27 shadow vs production equality',function(){var c=candidate(),prod=built(c),tem={};tem[c.sourceId]=[{eventId:c.id,eventType:'LIQUIDITY_SWEPT',status:'SWEPT',availableAt:c.confirmedAt,source:'TEST'}];var sh=shadow.buildShadowWatchEvidenceSnapshot({watch:watch([c]),evaluationTime:200,temporalEventsBySourceId:tem});assert.deepStrictEqual([prod.liquidity.canonicalSwingId,prod.liquidity.liquiditySide,prod.sweep.eventId,prod.currentPrimary.sourceId],[sh.swing.canonicalSwingId,sh.swing.liquiditySide,sh.sweep.eventId,sh.productionPrimaryMirror.sourceId]);});
test('28 incremental/full equivalence',function(){var c=candidate(),short=built(c,{candles:[candle(0,100),candle(1,100)]}),full=built(c,{candles:[candle(0,100),candle(1,100),Object.assign(candle(2,99),{closeTime:250})]});assert.deepStrictEqual(short,full);});
test('29 past-state immutability',function(){var c=candidate(),x=built(c),before=hash(x);built(c,{candles:[candle(0,100),candle(1,100),Object.assign(candle(2,99),{closeTime:250})]});assert.strictEqual(hash(x),before);});
test('30 blocked causal fields absent',function(){var x=built(candidate()),s=JSON.stringify(x);assert.strictEqual(x.blockedCausalEvidence.attributedMssProductionAllowed,false);assert.ok(!/reactionLegId|attributedMss\"|sameDeliveryDisplacement\"|followThrough\"/.test(s));});
test('31 liveEngine helper flag OFF exact legacy object',function(){var c=candidate(),w=watch([c]),before=hash(w);liveEngine.attachWatchLiquidityEvidenceV1(w,{enabled:false});assert.strictEqual(hash(w),before);});
test('32 liveEngine helper flag ON attaches only envelope',function(){var c=candidate(),w=watch([c]),legacy=clone(w);liveEngine.attachWatchLiquidityEvidenceV1(w,opts(c));var envelope=w.liquidityEvidenceV1;delete w.liquidityEvidenceV1;assert.ok(envelope);assert.deepStrictEqual(w,legacy);});
test('33 liveEngine helper adapter error fails open',function(){var c=candidate(),w=watch([c]),before=hash(w),old=evidence.attach,errors=[];evidence.attach=function(){throw new Error('synthetic');};try{liveEngine.attachWatchLiquidityEvidenceV1(w,{enabled:true,evaluationTime:200,errors:errors});}finally{evidence.attach=old;}assert.strictEqual(hash(w),before);assert.strictEqual(errors.length,1);});
test('34 authoritative registry BROKEN is projected when time-local',function(){var c=candidate(),x=built(c,{registry:registry([source(c,{status:'BROKEN',brokenAt:180})])});assert.strictEqual(x.liquidity.lifecycleStatus,'BROKEN');assert.strictEqual(x.liquidity.lifecycleTransitionAt,180);});
test('35 future registry BROKEN is hidden',function(){var c=candidate(),x=built(c,{registry:registry([source(c,{status:'BROKEN',brokenAt:250})])});assert.strictEqual(x.liquidity.lifecycleStatus,'SWEPT');});
test('36 frozen candidates field and allCandidates alias agree',function(){var x=built(candidate());assert.deepStrictEqual(x.candidates,x.allCandidates);assert.notStrictEqual(x.candidates,x.allCandidates);});

if(failed){console.error('WATCH Liquidity Evidence V1 failed '+failed+'/'+(passed+failed));process.exit(1);}console.log('WATCH Liquidity Evidence V1 '+passed+'/'+passed);
