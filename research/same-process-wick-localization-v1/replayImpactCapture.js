'use strict';

var fs = require('fs');
var path = require('path');
var replayState = require('../../replay/replayState');
var eventRegistry = require('../../events/eventRegistry');
var watchModel = require('../../live/eqFvgCountWatchV1');

var ROOT = path.join(__dirname, '..', '..');
var OUTPUT = path.join(ROOT, 'research-output', 'same-process-wick-localization-v1');
var SPECS = {
    RAYSOLUSDT: path.join(ROOT, 'research-output', 'historical-turning-point-method-audit-v1', 'raysolusdt-20260906-20260913', 'candles-5m.csv'),
    BTCUSDT: path.join(ROOT, 'research-output', 'historical-extreme-localization-cross-symbol-confirmatory-audit-v1', '20260906-20260913', 'population', 'BTCUSDT', 'candles-5m.csv'),
    ETHUSDT: path.join(ROOT, 'research-output', 'historical-extreme-localization-cross-symbol-confirmatory-audit-v1', '20260906-20260913', 'population', 'ETHUSDT', 'candles-5m.csv'),
    DOGEUSDT: path.join(ROOT, 'research-output', 'historical-extreme-localization-cross-symbol-confirmatory-audit-v1', '20260906-20260913', 'population', 'DOGEUSDT', 'candles-5m.csv'),
    LSKUSDT: path.join(ROOT, 'research-output', 'historical-extreme-localization-cross-symbol-confirmatory-audit-v1', '20260906-20260913', 'population', 'LSKUSDT', 'candles-5m.csv')
};

function candles(file) {
    var lines=fs.readFileSync(file,'utf8').trim().split(/\r?\n/),head=lines.shift().split(',');
    return lines.map(function(line){var cells=line.split(','),r={};head.forEach(function(k,i){r[k]=cells[i];});return{openTime:Number(r.openTimeMs),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume),closeTime:Number(r.closeTime),closed:true,source:r.source};});
}
function partnerView(event){return(event.metadata.historicalPartners||[]).map(function(p){return{id:p.id,price:p.price,occurredAt:p.occurredAt,confirmedAt:p.confirmedAt};}).sort(function(a,b){return a.occurredAt-b.occurredAt||String(a.id).localeCompare(String(b.id));});}
function capture(symbol,rows){
    var state=replayState.createReplayState({symbol:symbol,timeframe:'5m',snapshotInterval:999999});
    state.eventRegistry=eventRegistry.createEventRegistry();var machine=watchModel.createStateMachine(),notifications=[],rawFvgCount=0;
    for(var i=0;i<rows.length;i++){
        var before=state.productionEq.events.length;
        replayState.incrementalLiquidity(state,rows,i,{symbol:symbol,tickSize:0.00000001,source:'futures'},rows[i].closeTime);
        var equal=state.productionEq.events.slice(before),raw=watchModel.rawFvgAt(rows,i,symbol);if(raw)rawFvgCount++;
        var result=machine.step({evaluationTime:rows[i].closeTime,newEqualLiquidity:equal,rawFvg:raw});notifications=notifications.concat(result.notifications);
    }
    return{symbol:symbol,historicalExtremes:state.productionEq.dynamicD.confirmedPoints.map(function(p){return{id:p.id,processId:p.processId||null,side:p.pointSide,price:p.price,occurredAt:p.occurredAt,confirmedAt:p.confirmedAt,selectorPrice:p.selectorPrice,selectorOccurredAt:p.selectorOccurredAt===undefined?p.occurredAt:p.selectorOccurredAt,thetaSnapshot:p.thetaAtExtreme,localizationMode:p.localizationMode||null};}),
        equalLiquidity:state.productionEq.events.map(function(e){return{id:e.id,type:e.type,price:e.price,occurredAt:e.occurredAt,confirmedAt:e.confirmedAt,currentPivot:e.metadata.currentPivot,historicalPartners:partnerView(e)};}),
        rawFvgCount:rawFvgCount,watches:machine.getAll().map(function(w){return{watchId:w.watchId,liquidityId:w.liquidityId,status:w.status,openedAt:w.openedAt,closeReason:w.closeReason,firstBullFvg:w.firstBullFvg&&w.firstBullFvg.id,firstBearFvg:w.firstBearFvg&&w.firstBearFvg.id,secondBullFvg:w.secondBullFvg&&w.secondBullFvg.id,secondBearFvg:w.secondBearFvg&&w.secondBearFvg.id};}),
        entryCandidates:notifications.filter(function(n){return n.ordinal===1;}).map(function(n){return{watchId:n.watchId,liquidityId:n.liquidityId,rawFvgId:n.rawFvg.id,direction:n.expectedDirection,decisionTime:n.rawFvg.confirmedAt};}),
        matchingNotifications:notifications.map(function(n){return{watchId:n.watchId,liquidityId:n.liquidityId,rawFvgId:n.rawFvg.id,ordinal:n.ordinal};})};
}
function main(){var label=process.argv[2];if(!/^(old|new)$/.test(label||''))throw new Error('Usage: node research/same-process-wick-localization-v1/replayImpactCapture.js <old|new>');var result={label:label,symbols:{},firstTouch:'NOT_APPLICABLE_EQ_FVG_COUNT_WATCH_V1',tradeAdmission:'NOT_EVALUATED_REQUIRES_FROZEN_4H_BIAS_AND_ACCOUNT_RULES'};Object.keys(SPECS).forEach(function(symbol){result.symbols[symbol]=capture(symbol,candles(SPECS[symbol]));});fs.mkdirSync(OUTPUT,{recursive:true});fs.writeFileSync(path.join(OUTPUT,'replay-'+label+'.json'),JSON.stringify(result,null,2)+'\n');console.log('REPLAY_CAPTURE='+label.toUpperCase());Object.keys(result.symbols).forEach(function(s){var x=result.symbols[s];console.log(s+' EXTREMES='+x.historicalExtremes.length+' EQ='+x.equalLiquidity.length+' WATCH='+x.watches.length+' ENTRY_CANDIDATE='+x.entryCandidates.length);});}
if(require.main===module)main();module.exports={capture:capture,candles:candles,SPECS:SPECS};
