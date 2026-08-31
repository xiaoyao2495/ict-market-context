'use strict';
var assert=require('assert');var p=require('../notify/watchNotificationPresentationV1');var passed=0,failed=0;
function test(n,f){try{f();passed++;console.log('PASS  '+n);}catch(e){failed++;console.log('FAIL  '+n+' -> '+e.message);}}
function watch(direction){var bear=direction==='BEARISH',primary={id:'S1',sourceId:bear?'PDH:1':'PDL:1',sourceType:bear?'PDH':'PDL',sourceTimeframe:'1d',sourcePrice:100,side:bear?'BSL':'SSL',confirmedAt:100,relation:'BEFORE_LEG'};return{id:'W1',symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',updatedAt:200,notificationKey:'N1',liquidityTaken:{primary:primary,allCandidates:[primary]},displacement:{direction:direction,quality:'STRONG',startIndex:2,endIndex:3},nativeFvg:{low:101,high:102,midpoint:101.5},dailyBias:{bias:direction,confidence:'MEDIUM',alignment:'MATCH',status:'VALID'},firstTouchAt:300};}
function render(w){return p.build(w,{currentPrice:101.5,formatPrice:String});}
test('bullish WATCH renders liquidity displacement and FVG',function(){var s=render(watch('BULLISH'));assert.ok(s.includes('下方 SSL'));assert.ok(s.includes('多头位移'));assert.ok(s.includes('🟦 原生 FVG'));});
test('bearish rendering is symmetric',function(){var s=render(watch('BEARISH'));assert.ok(s.includes('上方 BSL'));assert.ok(s.includes('空头位移'));});
test('notification contains no legacy market-structure semantics',function(){var w=watch('BULLISH');w.mss={exists:true,protectedBreak:true,mssGrade:'PROTECTED'};var s=render(w);['MSS','Structural','局部结构突破','市场结构转换','protectedBreak','mssGrade'].forEach(function(x){assert.equal(s.indexOf(x),-1,x);});});
test('WATCH-not-entry disclaimer is price-behavior scoped',function(){var s=render(watch('BULLISH'));assert.ok(s.includes('这是 WATCH 观察事件，不是入场确认。'));assert.ok(s.includes('仅用于市场价格行为监测'));});
test('first touch remains WATCH presentation state',function(){assert.ok(render(watch('BULLISH')).includes('首次触及'));});
test('NEW narrative metadata is rendered without changing identity',function(){var w=watch('BULLISH');w.observationType='NEW';w.narrativeId='N';var before=w.id;assert.ok(render(w).includes('Narrative：新观察（NEW）'));assert.equal(w.id,before);});
test('formatter is pure',function(){var w=watch('BEARISH'),before=JSON.stringify(w);render(w);assert.equal(JSON.stringify(w),before);});
test('legacy structure input cannot affect bytes',function(){var a=watch('BULLISH'),b=JSON.parse(JSON.stringify(a));b.mss={exists:true,direction:'BEARISH'};assert.equal(render(a),render(b));});
console.log('WATCH Notification Presentation V1 '+passed+'/'+(passed+failed));if(failed)process.exit(1);
