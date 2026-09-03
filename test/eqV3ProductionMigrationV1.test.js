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

console.log('\nEQ V3 historical isolation: '+passed+' passed, '+failed+' failed');
if(failed) process.exit(1);
