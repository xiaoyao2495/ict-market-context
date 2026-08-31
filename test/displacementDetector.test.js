var assert = require('assert');
var detector = require('../events/displacementDetector');
var passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.message); } }
function m5(open, high, low, close, t, closed) { return { openTime:t, closeTime:t+299999, open:open, high:high, low:low, close:close, closed:closed !== false, source:'futures' }; }
function base() { var a=[]; for(var i=0;i<20;i++) a.push(m5(90+i,100+i,90+i,95+i,1000000+i*300000)); return a; }
var OPTS={symbol:'BTCUSDT',timeframe:'5m'};
function run(candle, extra) { var cs=base(); cs.push(candle); return detector.detectDisplacement(cs, Object.assign({}, OPTS, extra || {})); }

test('explicit price-only contract creates bullish displacement', function(){
  var ev=run(m5(100,140,98,138,7000000))[0];
  assert.equal(ev.direction,'BULLISH'); assert.equal(ev.startAt,7000000); assert.equal(ev.endAt,7299999); assert.equal(ev.confirmedAt,7299999);
  assert.equal(ev.metadata.expansionPass,true); assert.equal(ev.metadata.directionalDeliveryPass,true);
});
test('direction comes from bearish price delivery', function(){ assert.equal(run(m5(140,142,98,100,7000000))[0].direction,'BEARISH'); });
test('failed close progress cannot be rescued by other passing facts', function(){ assert.equal(run(m5(95.3,108,95,104.1,7000000)).length,0); });
test('failed body expansion cannot be rescued by quality facts', function(){ assert.equal(run(m5(100,112.1,99.9,108.1,7000000)).length,0); });
test('doji, open candle, and insufficient ATR are excluded', function(){
  assert.equal(run(m5(100,140,98,100,7000000)).length,0); assert.equal(run(m5(100,140,98,138,7000000,false)).length,0);
  assert.equal(detector.detectDisplacement([m5(1,5,0,4,1)],OPTS).length,0);
});
test('identity and metadata contain no legacy score or structure fields', function(){
  var ev=run(m5(100,140,98,138,7000000))[0]; var s=JSON.stringify(ev);
  ['mss','MSS','minScore','scoreBreakdown','protectedBreak','mssGrade'].forEach(function(k){ assert.equal(s.indexOf(k),-1,k); });
  assert.equal(ev.id,'BTCUSDT:5m:DISPLACEMENT:BULLISH:7000000');
});
test('arbitrary legacy-shaped arguments cannot affect identical candles', function(){
  var cs=base(); cs.push(m5(100,140,98,138,7000000));
  var none=detector.detectDisplacement(cs,OPTS);
  var bullish=detector.detectDisplacement(cs,Object.assign({mssEvents:[{id:'M1',direction:'BULLISH',candleIndex:20}]},OPTS));
  var bearish=detector.detectDisplacement(cs,Object.assign({mssEvents:[{id:'M2',direction:'BEARISH',candleIndex:20}]},OPTS));
  assert.deepStrictEqual(bullish,none); assert.deepStrictEqual(bearish,none);
});
test('prefix output is immutable when future candles are appended', function(){
  var cs=base(); cs.push(m5(100,140,98,138,7000000)); var prefix=detector.detectDisplacement(cs,OPTS);
  cs.push(m5(138,180,137,178,7300000)); var full=detector.detectDisplacement(cs,OPTS).filter(function(e){return e.confirmedAt<=7299999;});
  assert.deepStrictEqual(full,prefix);
});
console.log('----'); console.log('displacementDetector: '+passed+' passed, '+failed+' failed'); if(failed) process.exit(1);
