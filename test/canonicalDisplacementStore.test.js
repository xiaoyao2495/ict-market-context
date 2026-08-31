'use strict';
var assert=require('assert'); var factory=require('../events/canonicalDisplacementStore').createCanonicalDisplacementStore;
var passed=0,failed=0;
function test(n,f){try{f();passed++;console.log('PASS  '+n);}catch(e){failed++;console.log('FAIL  '+n+' -> '+e.stack);}}
function raw(id,source,dir,start,end,confirmed){return{id:id,source:source,symbol:'X',timeframe:'5m',direction:dir,formationType:source==='SINGLE_CANDLE_A'?'SINGLE_CANDLE':'MULTI_CANDLE',startIndex:start,endIndex:end,startAt:start*10,endAt:end*10+9,confirmedAt:confirmed,startPrice:100,endPrice:dir==='BULLISH'?110:90,atr:5,metrics:{N:end-start}};}

test('same-batch same-direction transitive overlaps form one canonical event',function(){
 var s=factory(),r=s.process([raw('A','SINGLE_CANDLE_A','BULLISH',2,2,29),raw('C2','MULTI_CANDLE_C2','BULLISH',0,2,29),raw('C3','MULTI_CANDLE_C2','BULLISH',1,3,29)],29);
 assert.strictEqual(r.created.length,1);assert.strictEqual(s.size(),1);assert.strictEqual(r.created[0].sourceDetections.length,3);assert.deepStrictEqual([r.created[0].startIndex,r.created[0].endIndex],[0,3]);
});
test('opposite directions and non-overlapping formations remain separate',function(){
 var s=factory();s.process([raw('A','SINGLE_CANDLE_A','BULLISH',2,2,29),raw('B','SINGLE_CANDLE_A','BEARISH',2,2,29),raw('C','MULTI_CANDLE_C2','BULLISH',5,7,79)],79);assert.strictEqual(s.size(),3);
});
test('later overlap appends evidence without mutating canonical core',function(){
 var s=factory(),first=s.process([raw('A','SINGLE_CANDLE_A','BULLISH',2,2,29)],29).created[0];
 var core=JSON.stringify({id:first.id,startIndex:first.startIndex,endIndex:first.endIndex,startAt:first.startAt,endAt:first.endAt,confirmedAt:first.confirmedAt,startPrice:first.startPrice,endPrice:first.endPrice});
 var r=s.process([raw('C2','MULTI_CANDLE_C2','BULLISH',1,2,39)],39);assert.strictEqual(r.created.length,0);assert.strictEqual(r.updated.length,1);
 var now=s.getById(first.id);assert.strictEqual(JSON.stringify({id:now.id,startIndex:now.startIndex,endIndex:now.endIndex,startAt:now.startAt,endAt:now.endAt,confirmedAt:now.confirmedAt,startPrice:now.startPrice,endPrice:now.endPrice}),core);assert.strictEqual(now.sourceDetections.length,2);
 assert.strictEqual(s.getProjectedById(first.id,29).sourceDetections.length,1);assert.strictEqual(s.getProjectedById(first.id,39).sourceDetections.length,2);
 var r2=s.process([raw('C3','MULTI_CANDLE_C2','BULLISH',2,4,49)],49);assert.strictEqual(r2.created.length,0);
 now=s.getById(first.id);assert.strictEqual(JSON.stringify({id:now.id,startIndex:now.startIndex,endIndex:now.endIndex,startAt:now.startAt,endAt:now.endAt,confirmedAt:now.confirmedAt,startPrice:now.startPrice,endPrice:now.endPrice}),core);
 assert.strictEqual(now.sourceDetections.length,3);assert.strictEqual(s.getProjectedById(first.id,39).sourceDetections.length,2);assert.strictEqual(s.getProjectedById(first.id,49).sourceDetections.length,3);
});
test('later evidence cannot chain a canonical event beyond its immutable core',function(){
 var s=factory(),first=s.process([raw('A','SINGLE_CANDLE_A','BULLISH',2,2,29)],29).created[0];
 s.process([raw('C2','MULTI_CANDLE_C2','BULLISH',1,3,39)],39);
 var r=s.process([raw('C3','MULTI_CANDLE_C2','BULLISH',3,5,59)],59);
 assert.strictEqual(r.created.length,1);assert.notStrictEqual(r.created[0].id,first.id);assert.strictEqual(s.size(),2);
});
test('replay and restart rebuild deterministic IDs and projections',function(){
 function run(){var s=factory();s.process([raw('A','SINGLE_CANDLE_A','BULLISH',2,2,29)],29);s.process([raw('C2','MULTI_CANDLE_C2','BULLISH',1,2,39)],39);return s.getAll();}
 assert.deepStrictEqual(run(),run());
});
if(failed){console.error('FAILED '+failed+'/'+(passed+failed));process.exit(1);}console.log('PASSED '+passed+'/'+passed);
