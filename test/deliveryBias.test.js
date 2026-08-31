var assert=require('assert'); var bias=require('../bias/deliveryBias'); var passed=0,failed=0,BAR=300000;
function test(n,f){try{f();passed++;console.log('PASS  '+n);}catch(e){failed++;console.log('FAIL  '+n+' -> '+e.message);}}
function ev(id,d,t){return{id:id,direction:d,confirmedAt:t};}
function run(s,d,t,extra){return bias.scoreDeliveryBias({evaluationTime:t||Math.max.apply(null,s.concat(d).map(function(x){return x.confirmedAt;}))+1,timeframe:'5m',events:Object.assign({sweeps:s,displacements:d},extra||{})},{});}
test('sweep only remains directional evidence',function(){var r=run([ev('s','BULLISH',1000)],[],1001);assert.equal(r.rawScore,8);assert.equal(r.displacement,null);});
test('sweep plus matching displacement is complete price chain',function(){var r=run([ev('s','BULLISH',1000)],[ev('d','BULLISH',1000+3*BAR)],1000+3*BAR+1);assert.equal(r.rawScore,18);assert.equal(r.displacement.id,'d');});
test('bearish chain is symmetric',function(){assert.equal(run([ev('s','BEARISH',1000)],[ev('d','BEARISH',1000+BAR)],1000+BAR+1).rawScore,-18);});
test('opposite displacement does not join',function(){assert.equal(run([ev('s','BULLISH',1000)],[ev('d','BEARISH',1000+BAR)],1000+BAR+1).rawScore,8);});
test('18-bar boundary is inclusive and 19 is excluded',function(){assert.equal(run([ev('s','BULLISH',1000)],[ev('d','BULLISH',1000+18*BAR)],1000+18*BAR+1).rawScore,18);assert.equal(run([ev('s','BULLISH',1000)],[ev('d','BULLISH',1000+19*BAR)],1000+19*BAR+1).rawScore,8);});
test('future events are excluded',function(){assert.equal(run([ev('s','BULLISH',9000)],[],5000).available,false);});
test('legacy-shaped MSS collections have zero effect',function(){var s=[ev('s','BULLISH',1000)],d=[ev('d','BULLISH',1000+BAR)],t=1000+BAR+1;assert.deepStrictEqual(run(s,d,t),run(s,d,t,{mss:[ev('m','BEARISH',1000)]}));});
test('freshness bands are unchanged',function(){assert.equal(bias.freshnessMultiplier(0,{freshnessBands:[{maxBars:6,multiplier:1}],freshnessFallback:.25}),1);});
console.log('----');console.log('deliveryBias: '+passed+' passed, '+failed+' failed');if(failed)process.exit(1);
