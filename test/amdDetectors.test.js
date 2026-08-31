var assert=require('assert');var dist=require('../amd/distributionDetector');var passed=0,failed=0,BAR=300000;
function test(n,f){try{f();passed++;console.log('PASS  '+n);}catch(e){failed++;console.log('FAIL  '+n+' -> '+e.message);}}
function input(direction,disps,now){return{symbol:'X',timeframe:'5m',evaluationTime:now,accumulation:{rangeHigh:110,rangeLow:90},manipulation:{direction:direction,confirmedAt:1000},displacementStore:{getAsOf:function(t,symbol){return disps.filter(function(d){return d.confirmedAt<=t&&(!symbol||d.symbol===symbol);});}},draw:null};}
function d(id,dir,t,close){return{id:id,symbol:'X',type:'DISPLACEMENT',direction:dir,confirmedAt:t,endPrice:close};}
test('matching price-only displacement confirms distribution',function(){var r=dist.detectDistribution(input('BULLISH',[d('d','BULLISH',1000+BAR,112)],1000+BAR));assert.equal(r.state,'DISTRIBUTION_CONFIRMED');assert.equal(r.displacementEvent.id,'d');});
test('opposite displacement cannot confirm',function(){assert.equal(dist.detectDistribution(input('BULLISH',[d('d','BEARISH',1000+BAR,80)],1000+BAR)),null);});
test('future displacement cannot confirm',function(){assert.equal(dist.detectDistribution(input('BULLISH',[d('d','BULLISH',9999999,112)],5000)),null);});
test('six-bar boundary is inclusive; later delivery excluded',function(){assert.ok(dist.detectDistribution(input('BULLISH',[d('d','BULLISH',1000+6*BAR,112)],1000+6*BAR)));assert.equal(dist.detectDistribution(input('BULLISH',[d('d','BULLISH',1000+7*BAR,112)],1000+7*BAR)),null);});
test('first matching displacement wins deterministically',function(){var r=dist.detectDistribution(input('BEARISH',[d('z','BEARISH',1000+2*BAR,88),d('a','BEARISH',1000+BAR,89)],1000+2*BAR));assert.equal(r.displacementEvent.id,'a');});
test('legacy-shaped structure input has no effect',function(){var i=input('BULLISH',[d('d','BULLISH',1000+BAR,112)],1000+BAR);var a=dist.detectDistribution(i);i.mssEvents=[{id:'m',direction:'BEARISH'}];assert.deepStrictEqual(dist.detectDistribution(i),a);});
console.log('----');console.log('amd detectors: '+passed+' passed, '+failed+' failed');if(failed)process.exit(1);
