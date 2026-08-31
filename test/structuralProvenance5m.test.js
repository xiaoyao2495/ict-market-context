'use strict';var assert=require('assert'),smod=require('../structure/structuralProvenance5m'),fs=require('fs'),path=require('path');var BAR=300000,passed=0,failed=0;
function test(n,f){try{f();passed++;console.log('PASS  '+n);}catch(e){failed++;console.log('FAIL  '+n+' -> '+e.message);}}
function c(i,o,h,l,x){return{openTime:i*BAR,closeTime:(i+1)*BAR-1,open:o,high:h,low:l,close:x,closed:true};}
function sw(side,i,p,ci){return{id:'S:'+side+':'+i,type:'SWING_'+side,price:p,sourceOpenTime:i*BAR,confirmedAt:(ci+1)*BAR-1,metadata:{index:i}};}
function seeded(){var s=smod.createState({symbol:'X',timeframe:'5m'});smod.step(s,c(4,99,100,98,99),4,[sw('HIGH',0,100,2),sw('LOW',1,90,3)]);smod.step(s,c(5,99,103,98,102),5,[]);return s;}
test('confirmed pivots can retain generic protected lifecycle',function(){var s=seeded();assert.equal(s.activeProtected.LOW.price,90);assert.equal(s.structuralState,'BULLISH');});
test('wick penetration remains a generic non-signal fact',function(){var s=seeded(),r=smod.step(s,c(6,92,94,89,91),6,[]);assert.equal(r.penetrations.length,1);assert.equal(s.activeProtected.LOW.status,'ACTIVE_PROTECTED');assert.equal(Object.prototype.hasOwnProperty.call(r,'mss'),false);});
test('close-through invalidates protected reference without directional signal',function(){var s=seeded(),r=smod.step(s,c(7,92,94,85,88),7,[]);assert.equal(s.structuralState,'UNKNOWN');assert.equal(s.activeProtected.LOW,null);assert.equal(r.events.filter(function(e){return /MSS|BREAK/.test(e.type);}).length,0);assert.equal(Object.prototype.hasOwnProperty.call(r,'structuralMss'),false);});
test('module exposes no structure-signal classifier',function(){assert.equal(typeof smod.qualityForMss,'undefined');});
test('production source contains no retired event vocabulary',function(){var t=fs.readFileSync(path.join(__dirname,'../structure/structuralProvenance5m.js'),'utf8');assert.equal(/STRUCTURAL_MSS|protectedBreak|mssGrade|mssSignalDetector/.test(t),false);});
console.log('structuralProvenance5m: '+passed+' passed, '+failed+' failed');if(failed)process.exit(1);
