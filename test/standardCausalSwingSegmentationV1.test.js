'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var segmentation = require('../structure/standardCausalSwingSegmentation');
var replayState = require('../replay/replayState');
var productionEq = require('../liquidity/productionEqualLiquidityV1');

var passed=0, failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS  '+name);}catch(error){failed++;console.log('FAIL  '+name+' -> '+error.stack);}}
function source(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

test('historical Standard Causal segmentation module remains independently loadable',function(){
    assert.strictEqual(segmentation.VERSION,'STANDARD_CAUSAL_SWING_SEGMENTATION_V1');
    assert.strictEqual(segmentation.ATR_PERIOD,14); assert.strictEqual(segmentation.DC_K,1.0);
});
test('production ReplayState declares only the replacement EQ model',function(){
    var state=replayState.createReplayState({symbol:'X',timeframe:'5m'});
    assert.strictEqual(state.eqProductionModel,productionEq.VERSION);
    assert.strictEqual(state.eqProductionVersion,undefined);
    assert.strictEqual(state.qualifiedSwingSegmentation,undefined);
});
test('production ReplayState does not import historical qualified segmentation',function(){
    assert.strictEqual(source('replay/replayState.js').includes('standardCausalSwingSegmentation'),false);
    assert.strictEqual(source('replay/replayState.js').includes('eqSwingSource'),false);
});
test('historical source-selection config is not reachable from live or replay runtime',function(){
    ['live/liveEngine.js','replay/replayEngine.js','replay/replayState.js'].forEach(function(file){
        assert.strictEqual(/eqSwingSource|EQ_SWING_SOURCE|STANDARD_CAUSAL_V1/.test(source(file)),false,file);
    });
});
test('replacement source has no research artifact import',function(){
    ['liquidity/productionEqualLiquidityV1.js','replay/replayState.js'].forEach(function(file){
        assert.strictEqual(/require\([^)]*research|research\//.test(source(file)),false,file);
    });
});
test('notification remains decoupled from both historical and replacement detectors',function(){
    assert.strictEqual(/standardCausalSwingSegmentation|atr50CausalZigZag|productionEqualLiquidityV1/.test(source('notify/watchNotificationPresentationV1.js')),false);
});

console.log('\nStandard Causal Swing historical isolation: '+passed+' passed, '+failed+' failed');
if(failed) process.exit(1);
