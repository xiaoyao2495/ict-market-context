'use strict';
var fs=require('fs'),path=require('path');
var ROOT=path.join(__dirname,'..','..'),OUT=path.join(ROOT,'research-output','same-process-wick-localization-v1');
var START=Date.parse('2026-09-05T16:00:00.000Z'),END=Date.parse('2026-09-12T16:00:00.000Z');
function read(name){return JSON.parse(fs.readFileSync(path.join(OUT,name),'utf8'));}
function map(rows,key){return new Map(rows.map(function(x){return[key(x),x];}));}
function diffKeys(oldRows,newRows,key){var a=map(oldRows,key),b=map(newRows,key),same=[],removed=[],added=[];a.forEach(function(v,k){if(b.has(k))same.push(k);else removed.push(k);});b.forEach(function(v,k){if(!a.has(k))added.push(k);});return{same:same,removed:removed,added:added,a:a,b:b};}
function partnerSemantic(e){return(e.historicalPartners||[]).map(function(p){return[p.price,p.occurredAt,p.confirmedAt];}).sort(function(a,b){return a[2]-b[2]||a[1]-b[1]||a[0]-b[0];});}
function eventSemantic(e){return JSON.stringify({type:e.type,price:e.price,occurredAt:e.occurredAt,confirmedAt:e.confirmedAt,currentPivot:e.currentPivot,partners:partnerSemantic(e)});}
function compareSymbol(oldS,newS){
    var oldH=oldS.historicalExtremes.filter(function(x){return x.selectorOccurredAt>=START&&x.selectorOccurredAt<END;}),newH=newS.historicalExtremes.filter(function(x){return x.selectorOccurredAt>=START&&x.selectorOccurredAt<END;});
    var hd=diffKeys(oldH,newH,function(x){return[x.side,x.selectorOccurredAt,x.confirmedAt].join('|');}),unchanged=0,changed=0;
    hd.same.forEach(function(k){var a=hd.a.get(k),b=hd.b.get(k);if(a.price===b.price&&a.occurredAt===b.occurredAt)unchanged++;else changed++;});
    var oldE=oldS.equalLiquidity.filter(function(x){return x.confirmedAt>=START&&x.confirmedAt<END;}),newE=newS.equalLiquidity.filter(function(x){return x.confirmedAt>=START&&x.confirmedAt<END;}),ed=diffKeys(oldE,newE,function(x){return x.id;});
    var exact=0,partnerOnly=0,currentChanged=0;ed.same.forEach(function(k){var a=ed.a.get(k),b=ed.b.get(k);if(JSON.stringify(a.currentPivot)!==JSON.stringify(b.currentPivot))currentChanged++;if(eventSemantic(a)===eventSemantic(b))exact++;else if(JSON.stringify(a.currentPivot)===JSON.stringify(b.currentPivot))partnerOnly++;});
    var oldW=oldS.watches.filter(function(x){return x.openedAt>=START&&x.openedAt<END;}),newW=newS.watches.filter(function(x){return x.openedAt>=START&&x.openedAt<END;}),wd=diffKeys(oldW,newW,function(x){return x.watchId;});
    var oldN=oldS.matchingNotifications.filter(function(x){var t=Number(x.rawFvgId.split(':').slice(-1)[0]);return t>=START&&t<END;}),newN=newS.matchingNotifications.filter(function(x){var t=Number(x.rawFvgId.split(':').slice(-1)[0]);return t>=START&&t<END;}),nd=diffKeys(oldN,newN,function(x){return[x.watchId,x.rawFvgId,x.ordinal].join('|');});
    var oldI=oldS.entryCandidates.filter(function(x){return x.decisionTime>=START&&x.decisionTime<END;}),newI=newS.entryCandidates.filter(function(x){return x.decisionTime>=START&&x.decisionTime<END;}),id=diffKeys(oldI,newI,function(x){return[x.watchId,x.rawFvgId].join('|');});
    return{historicalExtreme:{oldCount:oldH.length,newCount:newH.length,unchangedPriceAndTime:unchanged,changedPriceOrTime:changed,changedPct:oldH.length?changed/oldH.length:null,unmatchedProcessesOld:hd.removed.length,unmatchedProcessesNew:hd.added.length},
        equalLiquidity:{oldCount:oldE.length,newCount:newE.length,exactSame:exact,added:ed.added.length,removed:ed.removed.length,historicalPartnerChangedOnly:partnerOnly,currentPointChanged:currentChanged},
        watch:{oldCount:oldW.length,newCount:newW.length,same:wd.same.length,added:wd.added.length,removed:wd.removed.length},
        rawFvg:{oldCount:oldS.rawFvgCount,newCount:newS.rawFvgCount,changed:oldS.rawFvgCount!==newS.rawFvgCount},
        matchingFvgNotification:{oldCount:oldN.length,newCount:newN.length,same:nd.same.length,added:nd.added.length,removed:nd.removed.length},
        firstTouch:{status:'NOT_APPLICABLE_CURRENT_EQ_FVG_COUNT_WATCH_V1'},
        entryCandidate:{oldCount:oldI.length,newCount:newI.length,same:id.same.length,added:id.added.length,removed:id.removed.length},
        tradeAdmission:{status:'NOT_EVALUATED_REQUIRES_FROZEN_4H_BIAS_AND_ACCOUNT_RULES'}};
}
function report(result){var lines=['# SAME_PROCESS_WICK_LOCALIZATION_V1 Replay Impact','',
    'Fixed descriptive window: 2026-09-06 00:00 → 2026-09-13 00:00 UTC+8 (end exclusive). No outcome or parameter optimization is included.',''];
    Object.keys(result.symbols).forEach(function(s){var x=result.symbols[s];lines.push('## '+s,'',
        '- Historical Extreme old/new: '+x.historicalExtreme.oldCount+'/'+x.historicalExtreme.newCount+'; unchanged='+x.historicalExtreme.unchangedPriceAndTime+'; changed='+x.historicalExtreme.changedPriceOrTime+' ('+(x.historicalExtreme.changedPct*100).toFixed(2)+'%)',
        '- EQ old/new: '+x.equalLiquidity.oldCount+'/'+x.equalLiquidity.newCount+'; exact='+x.equalLiquidity.exactSame+'; added='+x.equalLiquidity.added+'; removed='+x.equalLiquidity.removed+'; partner-only changed='+x.equalLiquidity.historicalPartnerChangedOnly+'; current-point changed='+x.equalLiquidity.currentPointChanged,
        '- WATCH old/new: '+x.watch.oldCount+'/'+x.watch.newCount+'; same='+x.watch.same+'; added='+x.watch.added+'; removed='+x.watch.removed,
        '- Raw FVG old/new: '+x.rawFvg.oldCount+'/'+x.rawFvg.newCount+'; changed='+x.rawFvg.changed,
        '- Matching FVG notifications old/new: '+x.matchingFvgNotification.oldCount+'/'+x.matchingFvgNotification.newCount+'; same='+x.matchingFvgNotification.same+'; added='+x.matchingFvgNotification.added+'; removed='+x.matchingFvgNotification.removed,
        '- Entry candidates old/new: '+x.entryCandidate.oldCount+'/'+x.entryCandidate.newCount+'; same='+x.entryCandidate.same+'; added='+x.entryCandidate.added+'; removed='+x.entryCandidate.removed,
        '- FIRST_TOUCH: '+x.firstTouch.status,
        '- Trade admission: '+x.tradeAdmission.status,'');});
    lines.push('## Existing real trade case','',
        '`REAL_TRADE_CASE_001` was not present in the repository, research outputs, or local runtime-state files available to this worktree. No historical execution fact was inferred or rewritten.','');return lines.join('\n');}
function main(){var old=read('replay-old.json'),now=read('replay-new.json'),result={task:'SAME_PROCESS_WICK_LOCALIZATION_V1_REPLAY_IMPACT',window:{start:START,endExclusive:END},symbols:{},realTradeCase001:{status:'SOURCE_NOT_AVAILABLE_NO_INFERENCE',historicalExecutionRewritten:false}};Object.keys(old.symbols).forEach(function(s){result.symbols[s]=compareSymbol(old.symbols[s],now.symbols[s]);});fs.writeFileSync(path.join(OUT,'replay-impact.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(OUT,'REPLAY_IMPACT.md'),report(result).trimEnd()+'\n');console.log(JSON.stringify(result,null,2));}
if(require.main===module)main();module.exports={compareSymbol:compareSymbol};
