#!/usr/bin/env node
'use strict';
require('../config/loadEnv')();
var crypto = require('crypto');
var clientModule = require('../execution/binanceExecutionClientV1');
var rulesModule = require('../execution/executionRulesV1');
var rest = require('../data/binanceRest');
var streamModule = require('../execution/userDataStreamV1');
var safe = require('./execution-smoke');
var SYMBOLS = ['PROMUSDT','ETHUSDT','BNBUSDT','ZECUSDT','BTCUSDT'];
var OFFSETS = Object.freeze({ sl: 0.98, tp: 1.02 });
function arr(x){return Array.isArray(x)?x:(x?[x]:[]);} function qty(ps,s){return arr(ps).filter(p=>p.symbol===s).reduce((a,p)=>a+Math.abs(Number(p.positionAmt)||0),0);}
function id(symbol,role){return ('IMC_SMOKE2_'+symbol.replace(/USDT$/,'').slice(0,5)+'_'+crypto.randomBytes(4).toString('hex')+'_'+role).slice(0,36);}
function status(o){return String(o&&(o.algoStatus||o.status)||'UNKNOWN').toUpperCase();}
function active(o){return ['NEW','PENDING_NEW'].includes(status(o));}
function algoOrderFromEvent(event){
 if(!event||event.e!=='ALGO_UPDATE'||!event.o)return null;
 var x=event.o;
 return {algoId:x.algoId!=null?x.algoId:x.aid,clientAlgoId:x.clientAlgoId||x.caid,
  algoStatus:x.algoStatus||x.X,orderType:x.orderType||x.o,symbol:x.symbol||x.s,
  workingType:x.workingType||x.wt,closePosition:x.closePosition!=null?x.closePosition:x.cp,
  triggerPrice:x.triggerPrice!=null?x.triggerPrice:x.tp};
}
async function verifyProtectionV2(client, expected){
 var open=[],primaryError=null;
 try{open=arr(await client.getOpenAlgoOrders(expected.symbol));}catch(e){primaryError=e;}
 function valid(x){return !!x&&active(x)&&x.symbol===expected.symbol&&(x.orderType||x.type)===expected.orderType&&x.workingType==='MARK_PRICE'&&(x.closePosition===true||x.closePosition==='true')&&Math.abs(Number(x.triggerPrice)-Number(expected.triggerPrice))<1e-9;}
 function matches(x){return !!x&&((expected.algoId!=null&&String(x.algoId)===String(expected.algoId))||String(x.clientAlgoId||'')===String(expected.clientAlgoId));}
 var match=open.find(matches);
 if(valid(match))return{ok:true,source:'OPEN_ALGO_ORDERS',order:match,wsSeen:!!expected.wsSeen};
 var wsMatch=arr(expected.wsEvents).map(algoOrderFromEvent).find(matches);
 if(valid(wsMatch))return{ok:true,source:'USER_DATA_STREAM',order:wsMatch,wsSeen:true,primaryError:primaryError};
 try{var q=await client.queryAlgoOrder(expected.symbol,expected.algoId,expected.clientAlgoId);return{ok:valid(q),source:'QUERY_ALGO_ORDER',order:q,wsSeen:!!wsMatch,primaryError:primaryError,reason:valid(q)?null:'PROTECTION_FIELDS_INVALID'};}
 catch(e){if(Number(e.binanceCode||(e.response&&e.response.data&&e.response.data.code))===-2013)return{ok:false,pendingVisibility:true,source:'QUERY_ALGO_ORDER',wsSeen:!!wsMatch,primaryError:primaryError,reason:'POST_SUCCEEDED_QUERY_MINUS_2013',error:e};throw e;}
}
function protectionVerificationError(result, role){
 var error=result.error||new Error(result.reason||role+'_NOT_ACTIVE');
 error.code=result.reason||role+'_NOT_ACTIVE';
 return error;
}
function matchesAlgoTarget(order,target){
 return !!order&&!!target&&((target.algoId!=null&&String(order.algoId)===String(target.algoId))||
  (target.clientAlgoId&&String(order.clientAlgoId||'')===String(target.clientAlgoId)));
}
function cleanupInconsistent(target){
 return Object.assign(new Error('CLEANUP_INCONSISTENT'),{code:'CLEANUP_INCONSISTENT',critical:true,
  algoId:target&&target.algoId,clientAlgoId:target&&target.clientAlgoId});
}
async function cleanupProtection(options){
 var client=options.client,symbol=options.symbol,targets=arr(options.targets).filter(Boolean),
  counts=options.counts||{algoCancel:0},attempted=options.cancelAttemptedAlgoIds||new Set(),results=[];
 if(Number(options.positionQty)!==0)throw Object.assign(new Error('POSITION_NOT_FLAT_FOR_PROTECTION_CLEANUP'),
  {code:'POSITION_NOT_FLAT_FOR_PROTECTION_CLEANUP',critical:true});
 for(var target of targets){
  var open=arr(await client.getOpenAlgoOrders(symbol));
  var current=open.find(function(order){return active(order)&&matchesAlgoTarget(order,target);});
  if(!current){results.push({target:target,status:'ALREADY_NOT_OPEN'});continue;}
  var key=target.algoId!=null?'algo:'+String(target.algoId):'client:'+String(target.clientAlgoId);
  if(attempted.has(key))throw cleanupInconsistent(target);
  if(counts.algoCancel>=2)throw Object.assign(cleanupInconsistent(target),{code:'ALGO_CANCEL_MUTATION_LIMIT_EXCEEDED'});
  attempted.add(key);counts.algoCancel++;
  try{await client.cancelProtectionSmokeAlgo(symbol,target.clientAlgoId);}
  catch(error){
   var code=Number(error.binanceCode||(error.response&&error.response.data&&error.response.data.code));
   if(code!==-2011)throw error;
   var afterMinus2011=arr(await client.getOpenAlgoOrders(symbol));
   if(!afterMinus2011.some(function(order){return active(order)&&matchesAlgoTarget(order,target);})){
    results.push({target:target,status:'CANCEL_MINUS_2011_BUT_NOT_OPEN'});continue;
   }
   throw cleanupInconsistent(target);
  }
  var after=arr(await client.getOpenAlgoOrders(symbol));
  if(after.some(function(order){return active(order)&&matchesAlgoTarget(order,target);}))throw cleanupInconsistent(target);
  results.push({target:target,status:'CANCELED_AND_NOT_OPEN'});
 }
 return {ok:true,results:results,cancelAttemptedAlgoIds:attempted};
}
async function placeProtectionOnce(client, plan, role, clientAlgoId, wsEvents){
 var expected={symbol:plan.symbol,clientAlgoId:clientAlgoId,
  orderType:role==='SL'?'STOP_MARKET':'TAKE_PROFIT_MARKET',
  triggerPrice:role==='SL'?plan.stopPrice:plan.targetPrice,wsEvents:wsEvents};
 var placed;
 try{placed=await client.submitProtectionSmokeAlgo(plan,role,clientAlgoId);}
 catch(postError){
  var recovered=await verifyProtectionV2(client,expected);
  if(!recovered.ok)throw postError;
  return recovered.order;
 }
 var verified=await verifyProtectionV2(client,Object.assign({},expected,{algoId:placed.algoId}));
 if(!verified.ok)throw protectionVerificationError(verified,role);
 return verified.order;
}
async function run(options){
 var o=options||{}, env=o.env||process.env, out=o.write||console.log, enabled=env.EXECUTION_PROTECTION_SMOKE_ENABLED==='true', symbol=env.EXECUTION_PROTECTION_SMOKE_SYMBOL||'PROMUSDT';
 var key=env.BINANCE_FUTURES_API_KEY||'', secret=env.BINANCE_FUTURES_API_SECRET||'', client=o.client||clientModule.createClient({apiKey:key,secret:secret,liveTradingEnabled:enabled});
 var counts={entryPlace:0,entryCancel:0,slCreate:0,tpCreate:0,positionClose:0,algoCancel:0,leverage:0,margin:0,positionMode:0};
 var details={productionRepositoryTouched:false,eqConsumptionTouched:false,watchTouched:false,productionEntryPlanCreated:false,productionSlot:'FREE'};
 function finish(final,reason){var total=Object.keys(counts).reduce((a,k)=>a+counts[k],0); out('ENTRY_PLACE_MUTATIONS='+counts.entryPlace);out('ENTRY_CANCEL_MUTATIONS='+counts.entryCancel);out('SL_CREATE_MUTATIONS='+counts.slCreate);out('TP_CREATE_MUTATIONS='+counts.tpCreate);out('POSITION_CLOSE_MUTATIONS='+counts.positionClose);out('ALGO_CANCEL_MUTATIONS='+counts.algoCancel);out('LEVERAGE_MUTATIONS=0');out('MARGIN_MODE_MUTATIONS=0');out('POSITION_MODE_MUTATIONS=0');out('TOTAL_MUTATING_API_CALL_COUNT='+total);out('REAL_ORDERS_SENT='+counts.entryPlace);if(reason)out('REASON='+reason);out('FINAL='+final);return {final,reason,counts,details,exitCode:final==='PASS'||final==='DRY_RUN'?0:1};}
 out('MODE='+(enabled?'REAL_PROTECTION_SMOKE':'DRY_RUN'));out('SYMBOL='+symbol);out('LIVE_TRADING_ENABLED='+String(env.LIVE_TRADING_ENABLED));
 if(!key||!secret)return finish('FAIL','AUTH_CREDENTIALS_MISSING'); if(!SYMBOLS.includes(symbol))return finish('FAIL','SYMBOL_NOT_ALLOWED');
 var session=null, entry=null, sl=null, tp=null, slId=null, tpId=null, wsEvents=[],cancelAttemptedAlgoIds=new Set();
 try{
  await client.syncTime(); var v=await Promise.all([client.getPositionMode(),client.getSymbolConfig(symbol),client.getPositionRisk(symbol),client.getOpenOrders(symbol),client.getOpenAlgoOrders(symbol),client.getExchangeInfo(),client.getMarkPrices(),client.getBookTicker(symbol)]);
  var cfg=arr(v[1]).find(x=>x.symbol===symbol), ps=arr(v[2]), mark=Number((arr(v[6]).find(x=>x.symbol===symbol)||v[6]).markPrice), ask=Number(v[7].askPrice), r=rest.parseExchangeInfo(v[5],symbol,'futures');
  var reason=(v[0].dualSidePosition===true||v[0].dualSidePosition==='true')?'POSITION_MODE_NOT_ONE_WAY':!cfg?'CONFIG_UNAVAILABLE':String(cfg.marginType).toUpperCase()!=='CROSSED'?'NOT_CROSSED':Number(cfg.leverage)!==10?'LEVERAGE_NOT_10':qty(ps,symbol)!==0?'EXISTING_POSITION':arr(v[3]).length?'EXISTING_ORDER':arr(v[4]).length?'EXISTING_ALGO':null;
  if(reason)return finish('FAIL',reason); var entryPrice=rulesModule.legalize(ask*1.002,r.tickSize,'UP'); if(!(entryPrice>=ask))return finish('FAIL','UNSAFE_ENTRY');
  var sized=rulesModule.sizeOrder('LONG',entryPrice,entryPrice,entryPrice,r); if(!sized.ok)return finish('FAIL',sized.reasonCode);
  var plannedSl=rulesModule.legalize(entryPrice*OFFSETS.sl,r.tickSize,'NEAREST'), plannedTp=rulesModule.legalize(entryPrice*OFFSETS.tp,r.tickSize,'NEAREST');
  details.plan={markPrice:mark,bestAsk:ask,entryPrice,qty:sized.requestedQty,notional:sized.actualNotional,sl:plannedSl,tp:plannedTp}; out(JSON.stringify(details.plan));
  if(!enabled)return finish('DRY_RUN');
  session=(o.sessionFactory||streamModule.createReadOnlySession)({client,onEvent:function(event){if(event&&event.e==='ALGO_UPDATE')wsEvents.push(event);}});await session.start();
  var entryId=id(symbol,'ENTRY');counts.entryPlace++;entry=await client.submitProtectionSmokeEntry({symbol,side:'BUY',positionSide:'BOTH',type:'LIMIT',timeInForce:'GTC',quantity:sized.requestedQty,price:entryPrice,newClientOrderId:entryId,newOrderRespType:'ACK'});
  entry=await client.queryOrder(symbol,entry.orderId,entryId); var filled=Number(entry.executedQty||entry.cumQty||0); ps=await client.getPositionRisk(symbol);
  if(status(entry)==='PARTIALLY_FILLED'){counts.entryCancel++;await client.cancelSmokeOrder(symbol,entryId);ps=await client.getPositionRisk(symbol);filled=qty(ps,symbol);}
  if(!(filled>0)&&qty(ps,symbol)===0){if(active(entry)){counts.entryCancel++;await client.cancelSmokeOrder(symbol,entryId);}await session.stop();return finish('FAIL','FAIL_NO_FILL');}
  var actual=Number(entry.avgPrice||entry.averagePrice||entryPrice), plan={symbol,direction:'LONG',tradeId:entryId,stopPrice:rulesModule.legalize(actual*OFFSETS.sl,r.tickSize,'NEAREST'),targetPrice:rulesModule.legalize(actual*OFFSETS.tp,r.tickSize,'NEAREST')};
  slId=id(symbol,'SL');counts.slCreate++;sl=await placeProtectionOnce(client,plan,'SL',slId,wsEvents);
  tpId=id(symbol,'TP');counts.tpCreate++;tp=await placeProtectionOnce(client,plan,'TP',tpId,wsEvents);
  details.reconstructedState='PROTECTED';ps=await client.getPositionRisk(symbol);counts.positionClose++;await client.emergencyClose(symbol,'LONG',qty(ps,symbol),entryId);ps=await client.getPositionRisk(symbol);
  var targets=[sl&&{algoId:sl.algoId,clientAlgoId:slId},tp&&{algoId:tp.algoId,clientAlgoId:tpId}].filter(Boolean);
  await cleanupProtection({client,symbol,targets,counts,cancelAttemptedAlgoIds,positionQty:qty(ps,symbol)});
  var open=arr(await client.getOpenOrders(symbol)).filter(x=>String(x.clientOrderId||'').startsWith('IMC_SMOKE2_')), alg=arr(await client.getOpenAlgoOrders(symbol));
  var targetAlgoOpen=alg.some(function(order){return active(order)&&targets.some(function(target){return matchesAlgoTarget(order,target);});});
  await session.stop();session=null;if(qty(ps,symbol)!==0||open.length||targetAlgoOpen)return finish('FAIL','CLEAN_STATE_FAILED');return finish('PASS');
 }catch(e){
  if(e.executionOperation){out('operation='+e.executionOperation);out('endpoint='+e.executionEndpoint);out('method='+e.executionMethod);out('httpStatus='+String(e.httpStatus));out('binanceCode='+String(e.binanceCode));out('binanceMessage='+String(e.binanceMessage));out('request='+JSON.stringify(e.sanitizedRequest));}
  if(session)await session.stop().catch(()=>{}); var ps2=await client.getPositionRisk(symbol).catch(()=>null);if(ps2&&qty(ps2,symbol)>0){counts.positionClose++;await client.emergencyClose(symbol,'LONG',qty(ps2,symbol),'SMOKE2_FAIL').catch(()=>{});ps2=await client.getPositionRisk(symbol).catch(()=>null);}
  var catchTargets=[sl&&{algoId:sl.algoId,clientAlgoId:slId||sl.clientAlgoId},tp&&{algoId:tp.algoId,clientAlgoId:tpId||tp.clientAlgoId}].filter(Boolean),cleanupError=null;
  try{await cleanupProtection({client,symbol,targets:catchTargets,counts,cancelAttemptedAlgoIds,positionQty:ps2?qty(ps2,symbol):NaN});}catch(error){cleanupError=error;}
  var finalError=cleanupError&&cleanupError.critical?cleanupError:e;
  if(finalError&&finalError.critical)out('CRITICAL_CLEANUP='+JSON.stringify({reason:finalError.code,symbol:symbol,algoId:finalError.algoId,clientAlgoId:finalError.clientAlgoId}));
  return finish('FAIL',finalError.code||finalError.message);
 }
}
if(require.main===module)run().then(r=>{process.exitCode=r.exitCode;}).catch(e=>{console.error(safe.safeMessage(e));process.exitCode=2;});
module.exports={run,OFFSETS,SYMBOLS,id,verifyProtectionV2,algoOrderFromEvent,placeProtectionOnce,
 cleanupProtection,matchesAlgoTarget};
