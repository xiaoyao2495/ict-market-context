'use strict';

var assert=require('assert');
var fs=require('fs');
var path=require('path');
var replayState=require('../replay/replayState');
var productionEq=require('../liquidity/productionEqualLiquidityV1');
var partnerProvenance=require('../liquidity/productionEqProvenance');

var passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(error){failed++;console.log('FAIL  '+name+' -> '+error.stack);}}
function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

test('ReplayState ignores old version/source toggles and selects replacement model',function(){
    var state=replayState.createReplayState({eqProductionVersion:'V3',eqSwingSource:'STANDARD_CAUSAL_V1'});
    assert.strictEqual(state.eqProductionModel,productionEq.VERSION);
    assert.strictEqual(state.eqProductionVersion,undefined);
});
test('no production runtime imports persistent V3 or old EQ version config',function(){
    ['replay/replayState.js','replay/replayEngine.js','live/liveEngine.js','events/sweepEventAdapter.js','events/liquidityTakenEventAdapter.js'].forEach(function(file){
        assert.strictEqual(/persistentEqualLiquidityV3|eqProductionVersion|EQ_PRODUCTION_VERSION/.test(source(file)),false,file);
    });
    assert.strictEqual(source('scripts/live.js').includes("require('../config/eqProductionVersion')"),false);
});
test('historical selector configs explicitly declare production deprecation',function(){
    assert.strictEqual(require('../config/eqProductionVersion').DEPRECATED_FOR_PRODUCTION,true);
    assert.strictEqual(require('../config/eqSwingSource').DEPRECATED_FOR_PRODUCTION,true);
});
test('old V3 cluster cannot masquerade as replacement partner provenance',function(){
    var old={type:'EQH',side:'BSL',confirmedAt:10,metadata:{eqModelVersion:'V3',members:[{id:'A'},{id:'B'}]}};
    assert.strictEqual(partnerProvenance.fromLiquidity(old),null);
});
test('replacement metadata explicitly rejects persistent identity and member evolution',function(){
    var state=productionEq.createState({symbol:'X',timeframe:'5m'}); state.fiveMinuteAtrValue=10;
    state.dynamicD.recentSurvivalPoints=[{id:'Z',pointSide:'HIGH',price:100,selectorPrice:100,occurredAt:0,confirmedAt:1,occurredBarIndex:0,state:'ACTIVE',inactivatedBy:null,inactivatedAt:null}];
    var event=productionEq.evaluatePivot(state,{id:'P',symbol:'X',type:'SWING_HIGH',price:100,sourceOpenTime:3000000,sourceCloseTime:3299999,confirmedAt:3900000,metadata:{index:10}});
    assert.ok(event); assert.strictEqual(event.metadata.persistentIdentity,false);
    assert.strictEqual(event.metadata.memberEvolution,false); assert.strictEqual(event.metadata.members,undefined);
});

// TWO_BAR_PRODUCTION_REPLACEMENT_V1 §32: the production EQ source is no longer a
// 2L/2R Current Point. A Two-Bar Current Point is matched against the same causal
// Dynamic-D anchors, and the resulting EQL/EQH is the only new Entry setup.
test('TwoBarCurrentPoint -> Dynamic-D -> EQ is the production EQ source',function(){
    var twoBar=require('../strategy/twoBarReversalV1');
    var BAR=300000;
    function bar(i,o,h,l,c){return {openTime:i*BAR,closeTime:(i+1)*BAR-1,open:o,high:h,low:l,close:c,closed:true,source:'futures'};}
    var k1=bar(0,105,106,100,101), k2=bar(1,101,103,99,102.5);
    var candidate={pattern:'TWO_BAR_REVERSAL',direction:'BULLISH',startIndex:0,endIndex:1,
        windowBars:[k1,k2],windowFacts:[]};
    var currentPoint=twoBar.buildCurrentPoint(candidate,{symbol:'BTCUSDT',patternConfidence:'HIGH',contextConfidence:'HIGH'});
    assert.strictEqual(currentPoint.source,'TWO_BAR_REVERSAL_V1');
    assert.strictEqual(currentPoint.confirmedAt,k2.closeTime);
    assert.strictEqual(currentPoint.occurredAt,k2.openTime);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(currentPoint,'currentPivot'),false);
    // a same-side ACTIVE anchor confirmed before the Two-Bar pairs inside tolerance
    var partners=twoBar.matchDynamicDPartners({recentSurvivalPoints:[
        {id:'DYN_LOW_1',pointSide:'LOW',price:98.5,state:'ACTIVE',occurredAt:900,confirmedAt:1000,
            occurredBarIndex:0,localizedExtremePrice:98.5,localizationMode:'SAME_PROCESS_WICK_V1'},
        {id:'DYN_HIGH_1',pointSide:'HIGH',price:110,state:'ACTIVE',occurredAt:900,confirmedAt:1000,
            occurredBarIndex:0,localizedExtremePrice:110,localizationMode:'SAME_PROCESS_WICK_V1'}]},
        currentPoint,1.5,1);
    assert.strictEqual(partners.length,1);
    assert.strictEqual(partners[0].id,'DYN_LOW_1');
    var setup=twoBar.buildEqSetup(currentPoint,partners,1.5);
    assert.strictEqual(setup.type,'EQL');
    assert.strictEqual(setup.direction,'LONG');
    assert.strictEqual(setup.liquidityType,'EQL');
    assert.strictEqual(setup.availableAt>=setup.confirmedAt,true);
    assert.strictEqual(setup.nearestPartnerId,'DYN_LOW_1');
    // an anchor confirmed AFTER the Two-Bar can never pair, and the retired
    // Current Point provider is not reachable from the new Entry modules
    var late=twoBar.matchDynamicDPartners({recentSurvivalPoints:[
        {id:'TOO_LATE',pointSide:'LOW',price:98.5,state:'ACTIVE',occurredAt:k2.closeTime+1,
            confirmedAt:k2.closeTime+2,occurredBarIndex:9}]},currentPoint,1.5,1);
    assert.deepStrictEqual(late,[]);
    ['strategy/twoBarReversalV1.js','strategy/twoBarSetupV1.js','strategy/twoBarLivePipelineV1.js'].forEach(function(file){
        assert.strictEqual(/productionEqualLiquidityV1|evaluatePivot/.test(source(file)),false,file);
    });
});

console.log('\nEQ V3 historical isolation: '+passed+' passed, '+failed+' failed');
if(failed) process.exit(1);
