'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var segmentation = require('../structure/standardCausalSwingSegmentation');
var pivotDetector = require('../structure/pivotDetector');
var replayState = require('../replay/replayState');
var persistentEqV3 = require('../liquidity/persistentEqualLiquidityV3');
var eqSwingSource = require('../config/eqSwingSource');
var thresholds = require('../config/thresholds');
var eligibility = require('../events/sweepNarrativeEligibilityV1');

var BAR = 300000;
var BASE = 1700000000000;
var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function candle(i, close, high, low) {
    var c = close === undefined ? 100 : close;
    return { openTime: BASE + i * BAR, closeTime: BASE + (i + 1) * BAR - 1,
        open: c, high: high === undefined ? c + 1 : high,
        low: low === undefined ? c - 1 : low, close: c, closed: true, source: 'fixture' };
}
function buildDeterministicCandles(count) {
    var out=[],previousClose=80000,seed=246813579;
    function random(){seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;}
    for(var i=0;i<count;i++){
        var center=80000+500*Math.sin(i*2*Math.PI/48)+140*Math.sin(i*2*Math.PI/11)+80*Math.sin(i*2*Math.PI/7);
        var close=center+(random()-.5)*35,open=previousClose;
        var high=Math.max(open,close)+20+random()*35,low=Math.min(open,close)-20-random()*35;
        out.push({openTime:BASE+i*BAR,closeTime:BASE+(i+1)*BAR-1,open:+open.toFixed(1),high:+high.toFixed(1),low:+low.toFixed(1),close:+close.toFixed(1),closed:true,source:'fixture'});
        previousClose=close;
    }
    return out;
}
function raw(side, price, confirmedIndex, serial) {
    var sourceIndex = confirmedIndex - 2;
    return { id: 'X:5m:SWING_' + side + ':' + (BASE + sourceIndex * BAR) + ':' + (serial || 0),
        symbol: 'X', timeframe: '5m', type: 'SWING_' + side,
        side: side === 'HIGH' ? 'BSL' : 'SSL', price: price,
        sourceOpenTime: BASE + sourceIndex * BAR, sourceCloseTime: BASE + (sourceIndex + 1) * BAR - 1,
        confirmedAt: BASE + (confirmedIndex + 1) * BAR - 1, createdAt: BASE + (confirmedIndex + 1) * BAR - 1,
        status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null,
        metadata: { index: sourceIndex, right: 2, source: 'fixture' } };
}
function seeded() {
    var state = segmentation.createState({ symbol: 'X', timeframe: '5m' });
    var candles = [];
    for (var i = 0; i < 15; i++) {
        candles.push(candle(i));
        segmentation.step(state, candles[i], i, [], i ? candles[i - 1] : null);
    }
    return { state: state, candles: candles };
}
function advance(f, index, close, raws, high, low) {
    var c = candle(index, close, high, low);
    f.candles.push(c);
    return segmentation.step(f.state, c, index, raws || [], f.candles[index - 1]);
}
function core(swing) {
    return { id:swing.id,type:swing.type,side:swing.side,price:swing.price,
        occurredAt:swing.occurredAt,pivotConfirmedAt:swing.pivotConfirmedAt,
        qualifiedConfirmedAt:swing.qualifiedConfirmedAt,sourceRawPivotId:swing.sourceRawPivotId };
}
function runReplay(candles, growing, source) {
    var state = replayState.createReplayState({ symbol:'BTCUSDT', timeframe:'5m', eqProductionVersion:'V3', eqSwingSource:source || 'STANDARD_CAUSAL_V1' });
    var visible = [];
    candles.forEach(function (c, i) {
        if (growing) visible.push(c);
        replayState.incrementalLiquidity(state, growing ? visible : candles, i, {tickSize:0.1}, c.closeTime);
    });
    return state;
}
function eqProjection(state, evaluationTime) {
    return state.registry.getByType('BTCUSDT','EQH').concat(state.registry.getByType('BTCUSDT','EQL'))
        .filter(function (eq) { return eq.confirmedAt <= evaluationTime; })
        .map(function (eq) { var p=persistentEqV3.projectMembersAsOf(eq,evaluationTime); return {id:eq.id,type:eq.type,members:p.members.map(function(m){return m.id;})}; })
        .sort(function(a,b){return a.id.localeCompare(b.id);});
}
function gitBlob(relative) {
    var body=fs.readFileSync(path.join(__dirname,'..',relative));
    return crypto.createHash('sha1').update(Buffer.from('blob '+body.length+'\0')).update(body).digest('hex');
}

var actualCandles = buildDeterministicCandles(1800);
var actualState = runReplay(actualCandles, false);

test('01 raw 2L2R detector functional fingerprint recorded',function(){assert.strictEqual(gitBlob('structure/pivotDetector.js'),'9ff2260cdec9c30e213ce6fb57010395b4248729');});
test('02 DC k remains exactly 1.0',function(){assert.strictEqual(segmentation.DC_K,1.0);});
test('03 production module owns frozen Algorithm B parameters without research dependency',function(){assert.strictEqual(segmentation.VERSION,'STANDARD_CAUSAL_SWING_SEGMENTATION_V1');assert.strictEqual(segmentation.ATR_PERIOD,14);assert.strictEqual(segmentation.DC_K,1.0);assert.strictEqual(fs.readFileSync(path.join(__dirname,'../structure/standardCausalSwingSegmentation.js'),'utf8').includes('auditQualifiedSwingFilters'),false);});
test('04 production segmentation matches frozen deterministic semantic projection',function(){
    var tuples=actualState.qualifiedSwings.map(function(x){return[x.type.slice(6),x.price,x.sourceOpenTime,x.pivotConfirmedAt,x.qualifiedConfirmedAt];});
    assert.strictEqual(tuples.length,217);
    assert.strictEqual(crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex'),'30d3c81d0529d6d2287a673d96d46fd615b64b259ab66702b0f499798638f0c6');
});
test('05 HIGH provisional extreme replacement keeps only higher HIGH',function(){var f=seeded();advance(f,15,100,[raw('HIGH',100,15,1)]);advance(f,16,101,[raw('HIGH',102,16,2)]);advance(f,17,102,[raw('HIGH',105,17,3)]);var out=advance(f,18,90,[],101,89);assert.strictEqual(out.length,1);assert.strictEqual(out[0].price,105);assert.strictEqual(f.state.replacementLedger.length,2);});
test('06 LOW provisional extreme replacement is symmetric',function(){var f=seeded();advance(f,15,100,[raw('LOW',100,15,1)]);advance(f,16,99,[raw('LOW',98,16,2)]);advance(f,17,98,[raw('LOW',95,17,3)]);var out=advance(f,18,110,[],111,99);assert.strictEqual(out.length,1);assert.strictEqual(out[0].price,95);assert.strictEqual(f.state.replacementLedger.length,2);});
test('07 equal HIGH tie retains earlier raw identity',function(){var f=seeded(),a=raw('HIGH',105,15,1),b=raw('HIGH',105,16,2);advance(f,15,104,[a],106,103);advance(f,16,104,[b],106,103);advance(f,17,90,[],101,89);assert.strictEqual(f.state.emitted[0].sourceRawPivotId,a.id);assert.strictEqual(f.state.replacementLedger.length,0);});
test('08 equal LOW tie retains earlier raw identity',function(){var f=seeded(),a=raw('LOW',95,15,1),b=raw('LOW',95,16,2);advance(f,15,96,[a],97,94);advance(f,16,96,[b],97,94);advance(f,17,110,[],111,99);assert.strictEqual(f.state.emitted[0].sourceRawPivotId,a.id);assert.strictEqual(f.state.replacementLedger.length,0);});
test('09 confirmed HIGH identity remains immutable after later higher HIGH',function(){var f=seeded(),a=raw('HIGH',105,15,1);advance(f,15,100,[a]);var q=advance(f,16,90,[],101,89)[0],before=JSON.stringify(q);advance(f,17,100,[raw('HIGH',110,17,2)],111,99);assert.strictEqual(JSON.stringify(q),before);});
test('10 confirmed LOW identity remains immutable after later lower LOW',function(){var f=seeded(),a=raw('LOW',95,15,1);advance(f,15,100,[a]);var q=advance(f,16,110,[],111,99)[0],before=JSON.stringify(q);advance(f,17,90,[raw('LOW',90,17,2)],101,89);assert.strictEqual(JSON.stringify(q),before);});
test('11 strict HIGH LOW alternation',function(){var f=seeded();advance(f,15,100,[raw('HIGH',105,15,1)]);advance(f,16,90,[raw('LOW',95,16,2)],101,89);advance(f,17,110,[],111,99);advance(f,18,110,[raw('HIGH',108,18,3)],111,99);advance(f,19,90,[],101,89);assert.deepStrictEqual(f.state.emitted.map(function(x){return x.type;}),['SWING_HIGH','SWING_LOW','SWING_HIGH']);});
test('12 deterministic population has zero alternation violations',function(){assert.strictEqual(actualState.qualifiedSwings.filter(function(x,i,a){return i&&x.type===a[i-1].type;}).length,0);});
test('13 bootstrap emits nothing before causal reversal',function(){var f=seeded();advance(f,15,100,[raw('HIGH',105,15,1)]);assert.strictEqual(f.state.emitted.length,0);});
test('14 bootstrap first result is prefix-safe',function(){var f=seeded();advance(f,15,100,[raw('HIGH',105,15,1)]);advance(f,16,90,[],101,89);assert.strictEqual(f.state.emitted.length,1);assert.ok(f.state.emitted[0].qualifiedConfirmedAt===f.candles[16].closeTime);});
test('15 occurredAt preserves raw source time',function(){var q=actualState.qualifiedSwings[0];assert.strictEqual(q.occurredAt,q.sourceOpenTime);});
test('16 pivotConfirmedAt preserves raw 2R confirmation',function(){var q=actualState.qualifiedSwings[0];assert.strictEqual(q.pivotConfirmedAt,q.metadata.pivotConfirmedAt);});
test('17 qualifiedConfirmedAt is the DC candle close',function(){actualState.qualifiedSwings.forEach(function(q){assert.strictEqual(q.qualifiedConfirmedAt,q.confirmedAt);});});
test('18 temporal order holds for every qualified swing',function(){actualState.qualifiedSwings.forEach(function(q){assert.ok(q.occurredAt<=q.pivotConfirmedAt&&q.pivotConfirmedAt<=q.qualifiedConfirmedAt);});});
test('19 no visibility before qualifiedConfirmedAt',function(){var q=actualState.qualifiedSwings[10],p=segmentation.projectAsOf(actualState.qualifiedSwingSegmentation,q.qualifiedConfirmedAt-1);assert.strictEqual(p.qualifiedSwings.some(function(x){return x.id===q.id;}),false);});
test('20 visibility begins exactly at qualifiedConfirmedAt',function(){var q=actualState.qualifiedSwings[10],p=segmentation.projectAsOf(actualState.qualifiedSwingSegmentation,q.qualifiedConfirmedAt);assert.strictEqual(p.qualifiedSwings.some(function(x){return x.id===q.id;}),true);});
test('21 qualifiedHighPool contains confirmed HIGH only',function(){assert.ok(actualState.qualifiedHighPool.length>0);actualState.qualifiedHighPool.forEach(function(x){assert.strictEqual(x.type,'SWING_HIGH');assert.ok(x.confirmedAt!=null);});});
test('22 qualifiedLowPool contains confirmed LOW only',function(){assert.ok(actualState.qualifiedLowPool.length>0);actualState.qualifiedLowPool.forEach(function(x){assert.strictEqual(x.type,'SWING_LOW');assert.ok(x.confirmedAt!=null);});});
test('23 raw unqualified LOW cannot form EQL under standard source',function(){var memberIds=actualState.registry.getByType('BTCUSDT','EQL').flatMap(function(eq){return eq.metadata.members.map(function(m){return m.id;});});assert.ok(memberIds.length>0);assert.ok(memberIds.every(function(id){return id.indexOf('QS:')===0;}));});
test('24 raw unqualified HIGH cannot form EQH under standard source',function(){var memberIds=actualState.registry.getByType('BTCUSDT','EQH').flatMap(function(eq){return eq.metadata.members.map(function(m){return m.id;});});assert.ok(memberIds.length>0);assert.ok(memberIds.every(function(id){return id.indexOf('QS:')===0;}));});
test('25 two qualified LOWs may form EQL',function(){assert.ok(actualState.registry.getByType('BTCUSDT','EQL').some(function(eq){return eq.metadata.members.length>=2;}));});
test('26 two qualified HIGHs may form EQH',function(){assert.ok(actualState.registry.getByType('BTCUSDT','EQH').some(function(eq){return eq.metadata.members.length>=2;}));});
test('27 bottom same-formation provisional LOWs compress to one',function(){var f=seeded();advance(f,15,100,[raw('LOW',98,15,1)]);advance(f,16,100,[raw('LOW',97,16,2)]);advance(f,17,100,[raw('LOW',96,17,3)]);advance(f,18,110,[],111,99);assert.strictEqual(f.state.qualifiedLowPool.length,1);assert.strictEqual(f.state.qualifiedLowPool[0].price,96);});
test('28 top same-formation provisional HIGHs compress to one',function(){var f=seeded();advance(f,15,100,[raw('HIGH',102,15,1)]);advance(f,16,100,[raw('HIGH',103,16,2)]);advance(f,17,100,[raw('HIGH',104,17,3)]);advance(f,18,90,[],101,89);assert.strictEqual(f.state.qualifiedHighPool.length,1);assert.strictEqual(f.state.qualifiedHighPool[0].price,104);});
test('29 true alternating range retains multiple same-side swings',function(){assert.ok(actualState.qualifiedHighPool.length>1&&actualState.qualifiedLowPool.length>1);});
test('30 EQ V3 price gate thresholds unchanged',function(){assert.deepStrictEqual(thresholds.equalLiquidity,{version:2,atrPeriod:14,priceStrongMaxATR:.7,priceFailAboveATR:1.1,formationDepartureMinATR:1.75,formationZoneATR:.5,formationMinConsecutiveOutsideBars:1,percentageTolerance:.0002,minBarsApart:3,maxBarsApart:200,minTouches:2});});
test('31 EQ V3 IDs still derive from first two canonical member IDs',function(){var eq=actualState.registry.getByType('BTCUSDT','EQH')[0],m=eq.metadata.members;assert.strictEqual(eq.id,persistentEqV3.clusterId('BTCUSDT','5m','EQH',actualState.qualifiedSwingById[m[0].id],actualState.qualifiedSwingById[m[1].id]));});
test('32 EQ V3 formation anchor remains immutable first member',function(){actualState.registry.getByType('BTCUSDT','EQH').concat(actualState.registry.getByType('BTCUSDT','EQL')).forEach(function(eq){assert.strictEqual(eq.metadata.formationAnchorId,eq.metadata.formationMemberIds[0]);});});
test('33 EQ V3 ambiguity ledger remains explicit',function(){(actualState.eqV3DecisionLedger||[]).filter(function(x){return x.eventType==='AMBIGUOUS_UNASSIGNED';}).forEach(function(x){assert.ok(x.compatibleClusterIds.length>1);});});
test('34 EQ V3 lifecycle fields remain standard',function(){actualState.registry.getByType('BTCUSDT','EQH').concat(actualState.registry.getByType('BTCUSDT','EQL')).forEach(function(eq){assert.ok(['ACTIVE','TOUCHED','SWEPT','BROKEN'].indexOf(eq.status)>=0);});});
test('35 EQ member as-of projection hides later members',function(){var eq=actualState.registry.getByType('BTCUSDT','EQH').concat(actualState.registry.getByType('BTCUSDT','EQL')).find(function(x){return x.metadata.members.length>2;});assert.ok(eq);var t=eq.metadata.members[1].memberAddedAt,p=persistentEqV3.projectMembersAsOf(eq,t);assert.strictEqual(p.members.length,2);});
test('36 Sweep-time projection cannot see future Qualified member',function(){var eq=actualState.registry.getByType('BTCUSDT','EQH').concat(actualState.registry.getByType('BTCUSDT','EQL')).find(function(x){return x.metadata.members.length>2;});var t=eq.metadata.members[1].confirmedAt,p=persistentEqV3.projectMembersAsOf(eq,t);p.members.forEach(function(m){assert.ok(m.confirmedAt<=t&&m.memberAddedAt<=t);});});
test('37 generic structural lifecycle emits no market-structure signal',function(){var text=fs.readFileSync(path.join(__dirname,'../structure/structuralProvenance5m.js'),'utf8');assert.strictEqual(/STRUCTURAL_MSS|mssSignalDetector/.test(text),false);});
test('38 WATCH source contains no legacy structure dependency',function(){var text=fs.readFileSync(path.join(__dirname,'../stats/displacementWatch.js'),'utf8');assert.strictEqual(/mssGrade|protectedBreak|structuralProvenance/.test(text),false);});
test('39 Narrative Liquidity eligible type set unchanged',function(){['EQH','EQL','PDH','PDL','PWH','PWL','PMH','PML'].forEach(function(t){assert.strictEqual(eligibility.isNarrativeLiquiditySourceV1(t),true);});});
test('40 standard source is production default',function(){assert.strictEqual(eqSwingSource.get({}),'STANDARD_CAUSAL_V1');});
test('41 RAW_LEGACY rollback executes without Qualified Swing member mixing',function(){var legacy=runReplay(actualCandles,false,'RAW_LEGACY'),eqs=legacy.registry.getByType('BTCUSDT','EQH').concat(legacy.registry.getByType('BTCUSDT','EQL'));assert.ok(eqs.length>0);assert.ok(eqs.every(function(eq){return eq.metadata.members.every(function(m){return m.id.indexOf('QS:')!==0;});}));});
test('42 invalid or dual source selection is rejected',function(){assert.throws(function(){eqSwingSource.normalize('STANDARD_CAUSAL_V1+RAW_LEGACY');});});
test('43 standard clusters never mix raw and qualified IDs',function(){actualState.registry.getByType('BTCUSDT','EQH').concat(actualState.registry.getByType('BTCUSDT','EQL')).forEach(function(eq){assert.ok(eq.metadata.members.every(function(m){return m.id.indexOf('QS:')===0;}));});});
test('44 Qualified Swing prefix equality at multiple checkpoints',function(){[500,1000,1500,actualCandles.length-1].forEach(function(i){var prefix=runReplay(actualCandles.slice(0,i+1),false),a=actualState.qualifiedSwings.filter(function(q){return q.confirmedAt<=actualCandles[i].closeTime;}).map(core),b=prefix.qualifiedSwings.map(core);assert.deepStrictEqual(a,b);});});
test('45 EQ prefix equality at multiple checkpoints',function(){[500,1000,1500,actualCandles.length-1].forEach(function(i){var prefix=runReplay(actualCandles.slice(0,i+1),false);assert.deepStrictEqual(eqProjection(actualState,actualCandles[i].closeTime),eqProjection(prefix,actualCandles[i].closeTime));});});
test('46 deterministic repeated replay',function(){var second=runReplay(actualCandles,false);assert.deepStrictEqual(second.qualifiedSwings.map(core),actualState.qualifiedSwings.map(core));assert.deepStrictEqual(eqProjection(second,actualCandles.at(-1).closeTime),eqProjection(actualState,actualCandles.at(-1).closeTime));});
test('47 live-style growing feed equals full-array replay',function(){var live=runReplay(actualCandles,true);assert.deepStrictEqual(live.qualifiedSwings.map(core),actualState.qualifiedSwings.map(core));assert.deepStrictEqual(eqProjection(live,actualCandles.at(-1).closeTime),eqProjection(actualState,actualCandles.at(-1).closeTime));});
test('48 Qualified Swing has no advanced semantic fields',function(){var text=JSON.stringify(actualState.qualifiedSwings);assert.strictEqual(/independentScore|prominenceScore|hierarchyScore|structuralScore|departureScore|departureEfficiency/.test(text),false);});
test('49 production implementation imports no research artifact',function(){['structure/standardCausalSwingSegmentation.js','replay/replayState.js','liquidity/persistentEqualLiquidityV3.js'].forEach(function(file){var text=fs.readFileSync(path.join(__dirname,'..',file),'utf8');assert.strictEqual(/research\/|qualified-swing-prominence|qualified-swing-departure|online-causal|role-maturation/.test(text),false);});});
test('50 notification presentation remains decoupled from Swing source selection',function(){var text=fs.readFileSync(path.join(__dirname,'../notify/watchNotificationPresentationV1.js'),'utf8');assert.strictEqual(/standardCausalSwingSegmentation|eqSwingSource|EQ_SWING_SOURCE|qualifiedSwingSegmentation/.test(text),false);});

console.log('\nStandard Causal Swing Segmentation V1: '+passed+' passed, '+failed+' failed');
if(failed) process.exit(1);
