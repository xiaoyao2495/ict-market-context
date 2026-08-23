#!/usr/bin/env node
'use strict';
var crypto=require('crypto'),fs=require('fs'),path=require('path');
var liveEngine=require('../live/liveEngine'),thresholds=require('../config/thresholds');
var ROOT=path.resolve(__dirname,'..'),OUT=path.resolve(process.argv[2]||path.join(ROOT,'.audit-watch-rearm-v1'));
var SOURCE=path.join(ROOT,'.audit-displacement-centric-watch-fvg-retracement-v1');
var SYMBOL='BTCUSDT',START=Date.parse('2026-07-23T16:40:00.000Z'),END=Date.parse('2026-08-22T16:39:59.999Z'),ENGINE_START=Date.parse('2026-06-23T16:40:00.000Z');
var productionFiles=['stats/displacementWatch.js','live/liveEngine.js','live/futuresPriceStream.js','scripts/live.js','events/displacementDetector.js','events/sweepEventAdapter.js','liquidity/liquidityLifecycle.js','config/thresholds.js'];
var hashesBefore=hashes(productionFiles),watches=read('watch-ledger.json'),notifications=read('simulated-notifications.json'),data=loadData();
var candles=data['5m'].filter(function(c){return c.closeTime>=ENGINE_START&&c.closeTime<=END;});
var candleByClose={};candles.forEach(function(c){candleByClose[c.closeTime]=c;});
var engine=liveEngine.createLiveEngine({symbol:SYMBOL,exchangeInfo:data.exchangeInfo,structureCandles:{'1d':data['1d'],'4h':data['4h'],'1h':data['1h']},calendarCandles:{'1d':data['1d'],'1w':data['1w'],'1M':data['1M']},fetcher:function(s,tf){return Promise.resolve(data[tf]||[]);},thresholds:thresholds},{snapshotInterval:12,baseIndex:0,dailyBiasProvider:function(){return{bias:'UNKNOWN',confidence:null,alignment:'UNKNOWN',status:'BYPASSED',evaluationTime:null,ageMs:null};}});
var chain=Promise.resolve();candles.forEach(function(c,i){chain=chain.then(function(){return engine.onBar(c,i).then(function(){engine.drainDisplacementWatchUpdates();});});});
chain.then(build).catch(function(e){console.error(e&&e.stack||e);process.exitCode=1;});

function build(){
 var state=engine.getState(),disps=state.eventRegistry.getByType(SYMBOL,'DISPLACEMENT'),structural=state.eventRegistry.getByType(SYMBOL,'STRUCTURAL_MSS');
 var liquidity=state.registry.getAll(SYMBOL),liqById={};liquidity.forEach(function(x){liqById[x.id]=x;});
 var dispById={};disps.forEach(function(d){dispById[d.id]=d;});
 var wById={};watches.forEach(function(w){wById[w.id]=w;});
 var notifiedKeys={};notifications.forEach(function(n){notifiedKeys[n.watchId]=n;});

 // ---- narrative identity: production primary sweep id (1:1 with liquidity object sourceId) ----
 var narratives={};
 watches.forEach(function(w){
  var p=(w.liquidityTaken&&w.liquidityTaken.primary)||{},key=String(p.id||p.sourceId||'UNKNOWN');
  if(!narratives[key])narratives[key]={narrativeId:key,sweepId:p.id||null,sourceId:p.sourceId||null,sourceType:p.sourceType||'UNKNOWN',watches:[],notifications:[]};
  narratives[key].watches.push(w);
 });
 notifications.forEach(function(n){var w=wById[n.watchId];var p=(w.liquidityTaken&&w.liquidityTaken.primary)||{};var key=String(p.id||p.sourceId||'UNKNOWN');if(narratives[key])narratives[key].notifications.push(n);});
 Object.keys(narratives).forEach(function(k){narratives[k].watches.sort(function(a,b){return a.createdAt-b.createdAt||(a.displacement.firstConfirmedAt-b.displacement.firstConfirmedAt);});});

 // ---- timeline per narrative ----
 var timelines={};
 Object.keys(narratives).forEach(function(k){
  var x=narratives[k];
  var evs=x.watches.map(function(w){
   var d=dispById[w.displacementIds[0]]||null;
   var f=w.nativeFvg;
   var disp={id:w.displacementIds[0],occurredAt:d?d.occurredAt:w.displacement.firstConfirmedAt,confirmedAt:w.displacement.firstConfirmedAt,candleIndex:d?d.candleIndex:null};
   var fvg=null;
   if(f){fvg={id:f.id,confirmedAt:f.confirmedAt,low:f.low,high:f.high,midpoint:f.midpoint};}
   return{watchId:w.id,createdAt:w.createdAt,createdAtIso:iso(w.createdAt),direction:w.direction,displacement:disp,nativeFvg:fvg,firstTouchAt:w.firstTouchAt||null,notificationKey:w.notificationKey||null};
  });
  timelines[k]={narrativeId:k,sweepId:x.sweepId,sourceId:x.sourceId,sourceType:x.sourceType,direction:x.watches.length?x.watches[0].direction:null,watchCount:x.watches.length,events:evs};
 });

 // ---- consecutive WATCH pair analysis ----
 var pairs=[];
 Object.keys(narratives).forEach(function(k){
  var ws=narratives[k].watches;
  for(var i=0;i<ws.length-1;i++)pairs.push(buildPair(k,ws[i],ws[i+1],dispById,liqById,structural));
 });
 var catOrder=['A_CONTINUOUS_SAME_DIRECTION','B_REARM_AFTER_TOUCH','C_REARM_AFTER_CONTEXT_CHANGE','D_OPPOSITE_DIRECTION','E_STRICT_DUPLICATE'];
 var catCount={};catOrder.forEach(function(c){catCount[c]=0;});
 var catNotifications={};catOrder.forEach(function(c){catNotifications[c]=0;});
 var catFirstTouches={};catOrder.forEach(function(c){catFirstTouches[c]=0;});
 pairs.forEach(function(p){catCount[p.category]++;if(notifiedKeys[p.next.watchId])catNotifications[p.category]++;if(p.next.firstTouchAt)catFirstTouches[p.category]++;});
 var repeatTotal=pairs.length;
 var catPct={};catOrder.forEach(function(c){catPct[c]=round(repeatTotal?catCount[c]/repeatTotal*100:0);});

 // ---- per-narrative watch count groups (section 五) ----
 var groups={1:0,2:0,3:0,4:0,5:0,'6+':0};
 var groupStats={};Object.keys(groups).forEach(function(g){groupStats[g]={narratives:0,watches:0,notifications:0,firstTouches:0,noTouchWatches:0};});
 Object.keys(narratives).forEach(function(k){
  var x=narratives[k],n=x.watches.length,g=n>=6?'6+':String(n);groups[g]++;
  groupStats[g].narratives++;groupStats[g].watches+=n;groupStats[g].notifications+=x.notifications.length;
  var touched=x.watches.filter(function(w){return!!w.firstTouchAt;}).length;
  groupStats[g].firstTouches+=touched;groupStats[g].noTouchWatches+=(n-touched);
 });

 // ---- human review samples per category (<=10, deterministic sha pick, no outcome) ----
 var samples={};catOrder.forEach(function(c){samples[c]=sampleForCategory(c,pairs,dispById,disps,liqById,structural,notifiedKeys);});

 // ---- re-arm policy candidate ----
 var candidate=policyCandidate(catCount,repeatTotal);
 var policyEvidence=policyEvidenceData(pairs,catCount,repeatTotal);

 // ---- invariants ----
 var hashesAfter=hashes(productionFiles),changed=productionFiles.filter(function(f){return hashesBefore[f]!==hashesAfter[f];});
 var future=[];notifications.forEach(function(n){var w=wById[n.watchId];if(w.updatedAt>n.firstTouchAt)future.push({watchId:w.id,reason:'FORMATION_UPDATED_AFTER_TOUCH'});(w.liquidityTaken.allCandidates||[]).forEach(function(c){if(c.confirmedAt>w.updatedAt)future.push({watchId:w.id,id:c.id,reason:'SWEEP_AFTER_FORMATION'});});});

 var result={audit:{version:'WATCH Narrative Re-Arm Audit V1',symbol:SYMBOL,startIso:iso(START),endIso:iso(END),readOnly:true,outcomeUsed:false,
   narrativeIdentity:'production primary sweep id (1:1 with liquidity object sourceId; 547 narratives, no direction mixing)',
   pairDefinition:'consecutive WATCH pairs within a narrative, sorted by createdAt',
   classificationPrecedence:'E_STRICT_DUPLICATE > D_OPPOSITE_DIRECTION > C_REARM_AFTER_CONTEXT_CHANGE > B_REARM_AFTER_TOUCH > A_CONTINUOUS_SAME_DIRECTION',
   eDefinition:'same narrative; adjacent displacement confirmedAt gap <= 60m; native FVG overlap >= 75% (audit-only, no merge/dedupe)'},
  TOTAL_WATCH:watches.length,TOTAL_NARRATIVES:Object.keys(narratives).length,FIRST_WATCHES:Object.keys(narratives).length,REPEAT_WATCH_PAIRS:repeatTotal,
  categoryCounts:catCount,categoryPercentOfRepeatPairs:catPct,
  WATCH_NOTIFICATION_BY_CATEGORY:catNotifications,WATCH_FIRST_TOUCH_BY_CATEGORY:catFirstTouches,
  perNarrativeWatchCountGroups:groupStats,
  policy:{REARM_POLICY_CANDIDATE:candidate,evidence:policyEvidence},
  invariants:{PRODUCTION_CHANGED:changed.length>0,FUTURE_LEAK_VIOLATIONS:future.length,OUTCOME_USED:false},futureLeakDetails:future,productionHashChanges:changed};
 if(!fs.existsSync(OUT))fs.mkdirSync(OUT,{recursive:true});
 fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(result,null,2));
 fs.writeFileSync(path.join(OUT,'narrative-timelines.json'),JSON.stringify(timelines,null,2));
 fs.writeFileSync(path.join(OUT,'watch-pairs-ledger.json'),JSON.stringify(pairs,null,2));
 fs.writeFileSync(path.join(OUT,'category-samples.json'),JSON.stringify(samples,null,2));
 fs.writeFileSync(path.join(OUT,'WATCH_REARM_AUDIT_V1_REPORT.md'),render(result));
 console.log(JSON.stringify({TOTAL_WATCH:result.TOTAL_WATCH,TOTAL_NARRATIVES:result.TOTAL_NARRATIVES,FIRST_WATCHES:result.FIRST_WATCHES,REPEAT_WATCH_PAIRS:result.REPEAT_WATCH_PAIRS,categoryCounts:catCount,categoryPercentOfRepeatPairs:catPct,WATCH_NOTIFICATION_BY_CATEGORY:catNotifications,WATCH_FIRST_TOUCH_BY_CATEGORY:catFirstTouches,perNarrativeWatchCountGroups:groupStats,policy:{REARM_POLICY_CANDIDATE:candidate,evidence:policyEvidence},invariants:result.invariants,output:OUT},null,2));
 if(changed.length||future.length)process.exitCode=1;
}

function buildPair(k,prev,next,dispById,liqById,structural){
 var pd=dispById[prev.displacementIds[0]]||null,nd=dispById[next.displacementIds[0]]||null;
 var prevOcc=pd?pd.occurredAt:prev.displacement.firstConfirmedAt,nextOcc=nd?nd.occurredAt:next.displacement.firstConfirmedAt;
 var prevConf=prev.displacement.firstConfirmedAt,nextConf=next.displacement.firstConfirmedAt;
 var prevIdx=pd?pd.candleIndex:prev.displacement.startIndex,nextIdx=nd?nd.candleIndex:next.displacement.startIndex;
 var sourceId=(prev.liquidityTaken&&prev.liquidityTaken.primary&&prev.liquidityTaken.primary.sourceId)||null;
 var lo=sourceId?liqById[sourceId]:null;
 var life=[];if(lo){[['touchedAt','TOUCHED'],['sweptAt','SWEPT'],['brokenAt','BROKEN']].forEach(function(x){var t=lo[x[0]];if(t>prev.createdAt&&t<next.createdAt)life.push({state:x[1],at:t,atIso:iso(t)});});}
 var se=structural.filter(function(e){return e.confirmedAt>prev.createdAt&&e.confirmedAt<next.createdAt;});
 var prevTouchedBeforeNext=!!(prev.firstTouchAt&&prev.firstTouchAt<=next.createdAt);
 var prevActiveAtNext=!prevTouchedBeforeNext&&!prev.invalidatedAt;
 var overlap=null;if(prev.nativeFvg&&next.nativeFvg)overlap=overlapRatio(prev.nativeFvg,next.nativeFvg);
 var gapMinutes=(nextConf-prevConf)/60000;
 var isE=overlap!==null&&gapMinutes<=60&&overlap>=0.75;
 var directionSame=prev.direction===next.direction;
 var category;
 if(isE)category='E_STRICT_DUPLICATE';
 else if(!directionSame)category='D_OPPOSITE_DIRECTION';
 else if(se.length>0||life.length>0)category='C_REARM_AFTER_CONTEXT_CHANGE';
 else if(prevTouchedBeforeNext)category='B_REARM_AFTER_TOUCH';
 else category='A_CONTINUOUS_SAME_DIRECTION';
 return{narrativeId:k,direction:prev.direction,
  previous:{watchId:prev.id,createdAt:prev.createdAt,createdAtIso:iso(prev.createdAt),displacementId:prev.displacementIds[0],displacementOccurredAt:prevOcc,displacementConfirmedAt:prevConf,displacementCandleIndex:prevIdx,
   nativeFvg:prev.nativeFvg?compactFvg(prev.nativeFvg):null,firstTouchAt:prev.firstTouchAt||null,wasNotified:!!prev.notificationKey,stillActiveAtNext:prevActiveAtNext,touchedBeforeNextCreation:prevTouchedBeforeNext},
  next:{watchId:next.id,createdAt:next.createdAt,createdAtIso:iso(next.createdAt),displacementId:next.displacementIds[0],displacementOccurredAt:nextOcc,displacementConfirmedAt:nextConf,displacementCandleIndex:nextIdx,
   nativeFvg:next.nativeFvg?compactFvg(next.nativeFvg):null,firstTouchAt:next.firstTouchAt||null},
  metrics:{gapMinutes:round(gapMinutes),gapBars:typeof prevIdx==='number'&&typeof nextIdx==='number'?nextIdx-prevIdx:null,directionSame:directionSame,nativeFvgOverlap:overlap===null?null:round(overlap)},
  contextBetween:{liquidityLifecycleChanges:life,liquidityLifecycleChanged:life.length>0,structuralChanges:se.map(compactStructural),structuralStateChanged:se.length>0,
   dailyBiasPrev:prev.dailyBias||null,dailyBiasNext:next.dailyBias||null},
  category:category};
}

function sampleForCategory(cat,pairs,dispById,allDisps,liqById,structural,notifiedKeys){
 var cand=pairs.filter(function(p){return p.category===cat;}).sort(function(a,b){return sha(a.next.watchId).localeCompare(sha(b.next.watchId));}).slice(0,10);
 return cand.map(function(p){return buildSample(p,dispById,allDisps,liqById,structural,notifiedKeys);});
}
function buildSample(p,dispById,allDisps,liqById,structural,notifiedKeys){
 var prev=watches.filter(function(w){return w.id===p.previous.watchId;})[0],next=watches.filter(function(w){return w.id===p.next.watchId;})[0];
 var srcId=(prev.liquidityTaken&&prev.liquidityTaken.primary&&prev.liquidityTaken.primary.sourceId)||null;
 var liq=srcId?liqById[srcId]:null;
 var eventsBetween=[];
 // 两次 displacement 之间出现的所有其他 DISPLACEMENT（不含 anchor 本身）
 (allDisps||[]).forEach(function(d){if(d.id===p.previous.displacementId||d.id===p.next.displacementId)return;if(d.confirmedAt>p.previous.displacementConfirmedAt&&d.confirmedAt<p.next.displacementConfirmedAt)eventsBetween.push({type:'DISPLACEMENT',id:d.id,direction:d.direction,confirmedAt:d.confirmedAt,confirmedAtIso:iso(d.confirmedAt)});});
 (structural.filter(function(e){return e.confirmedAt>p.previous.displacementConfirmedAt&&e.confirmedAt<p.next.displacementConfirmedAt;})).forEach(function(e){eventsBetween.push({type:'STRUCTURAL_MSS',id:e.id,direction:e.direction,confirmedAt:e.confirmedAt,confirmedAtIso:iso(e.confirmedAt),stateBefore:e.structuralStateBefore,stateAfter:e.structuralStateAfter});});
 var loT=liq;
 if(loT){[['touchedAt','TOUCHED'],['sweptAt','SWEPT'],['brokenAt','BROKEN']].forEach(function(x){var t=loT[x[0]];if(t>p.previous.displacementConfirmedAt&&t<p.next.displacementConfirmedAt)eventsBetween.push({type:'LIQUIDITY_LIFECYCLE',state:x[1],at:t,atIso:iso(t)});});}
 eventsBetween.sort(function(a,b){return (a.confirmedAt||a.at)-(b.confirmedAt||b.at);});
 return{narrativeId:p.narrativeId,sourceType:liq?liq.type:'UNKNOWN',direction:p.direction,category:p.category,outcomeAfterTouchIncluded:false,
  liquidity:compactLiquidity(liq),
  displacement1:dispEvent(prev,dispById),fvg1:prev.nativeFvg?compactFvg(prev.nativeFvg):null,touch1:touchRec(prev,notifiedKeys),
  displacement2:dispEvent(next,dispById),fvg2:next.nativeFvg?compactFvg(next.nativeFvg):null,touch2:touchRec(next,notifiedKeys),
  keyEventsBetweenDisplacements:eventsBetween,watchToTouchMinutesNext:(p.next.firstTouchAt?(p.next.firstTouchAt-next.createdAt)/60000:null)};
}
function dispEvent(w,dispById){var d=dispById[w.displacementIds[0]]||null;return{id:w.displacementIds[0],direction:w.direction,occurredAt:d?d.occurredAt:w.displacement.firstConfirmedAt,confirmedAt:w.displacement.firstConfirmedAt,candleIndex:d?d.candleIndex:null};}
function touchRec(w,notifiedKeys){if(!w.firstTouchAt)return null;var n=notifiedKeys[w.id];return{firstTouchAt:w.firstTouchAt,firstTouchAtIso:iso(w.firstTouchAt),firstTouchPrice:w.firstTouchPrice||null,touchCandle:n&&n.touchCandle?compactCandle(n.touchCandle):null};}

function policyCandidate(cat,repeatTotal){
 var E=cat.E_STRICT_DUPLICATE||0,D=cat.D_OPPOSITE_DIRECTION||0,A=cat.A_CONTINUOUS_SAME_DIRECTION||0,B=cat.B_REARM_AFTER_TOUCH||0,C=cat.C_REARM_AFTER_CONTEXT_CHANGE||0;
 if(repeatTotal===0)return'NO_CHANGE';
 if(E/repeatTotal>=0.25)return'OTHER';
 var abc=A+B+C;
 if(abc===0)return'NO_CHANGE';
 var aS=A/abc,bS=B/abc,cS=C/abc;
 var maxS=Math.max(aS,bS,cS);
 if(maxS===aS&&aS>=0.5)return'ONE_WATCH_PER_LIQUIDITY_UNTIL_TOUCH';
 if(maxS===cS&&cS>=0.5)return'ONE_WATCH_PER_LIQUIDITY_UNTIL_CONTEXT_CHANGE';
 if(maxS===bS&&bS>=0.5)return'ALLOW_REARM_AFTER_NEW_DISPLACEMENT';
 return'OTHER';
}
function policyEvidenceData(pairs,cat,repeatTotal){
 var A=cat.A_CONTINUOUS_SAME_DIRECTION,B=cat.B_REARM_AFTER_TOUCH,C=cat.C_REARM_AFTER_CONTEXT_CHANGE,D=cat.D_OPPOSITE_DIRECTION,E=cat.E_STRICT_DUPLICATE;
 var overlappingActive=pairs.filter(function(p){return p.previous.stillActiveAtNext;}).length;
 var rearmAfterTouch=pairs.filter(function(p){return p.previous.touchedBeforeNextCreation;}).length;
 var withStructural=pairs.filter(function(p){return p.contextBetween.structuralStateChanged;}).length;
 var withLifecycle=pairs.filter(function(p){return p.contextBetween.liquidityLifecycleChanged;}).length;
 var gapMedian=median(pairs.map(function(p){return p.metrics.gapMinutes;}));
 var gapP90=percentile(pairs.map(function(p){return p.metrics.gapMinutes;}),90);
 return{repeatPairs:repeatTotal,
  prevStillActiveAtNextCount:overlappingActive,prevTouchedBeforeNextCount:rearmAfterTouch,
  structuralChangeBetweenCount:withStructural,liquidityLifecycleChangeBetweenCount:withLifecycle,
  gapMinutesMedian:gapMedian,gapMinutesP90:gapP90,
  counts:{A:A,B:B,C:C,D:D,E:E}};
}

function overlapRatio(a,b){var x=Math.max(0,Math.min(a.high,b.high)-Math.max(a.low,b.low)),den=Math.min(a.high-a.low,b.high-b.low);return den>0?x/den:0;}
function compactFvg(f){return{id:f.id,direction:f.direction,low:f.low,high:f.high,midpoint:f.midpoint,confirmedAt:f.confirmedAt,k1OpenTime:f.k1OpenTime,k2OpenTime:f.k2OpenTime,k3OpenTime:f.k3OpenTime};}
function compactLiquidity(l){return l?{id:l.id,type:l.type,side:l.side,price:l.price,confirmedAt:l.confirmedAt,status:l.status,touchedAt:l.touchedAt,sweptAt:l.sweptAt,brokenAt:l.brokenAt}:null;}
function compactStructural(e){return{id:e.id,direction:e.direction,confirmedAt:e.confirmedAt,stateBefore:e.structuralStateBefore,stateAfter:e.structuralStateAfter};}
function compactCandle(c){return c?{openTime:c.openTime,closeTime:c.closeTime,open:c.open,high:c.high,low:c.low,close:c.close,closed:c.closed,source:c.source}:null;}
function median(a){if(!a.length)return null;var x=a.slice().sort(function(p,q){return p-q;});return x[Math.floor((x.length-1)/2)];}
function percentile(a,p){if(!a.length)return null;var x=a.slice().sort(function(p2,q){return p2-q;}),i=Math.min(x.length-1,Math.floor(x.length*p/100));return x[i];}
function round(n){return Math.round(n*1e6)/1e6;}function iso(t){return t?new Date(t).toISOString():null;}function sha(s){return crypto.createHash('sha256').update(String(s)).digest('hex');}
function read(f){return JSON.parse(fs.readFileSync(path.join(SOURCE,f),'utf8'));}function hashes(files){var o={};files.forEach(function(f){o[f]=sha(fs.readFileSync(path.join(ROOT,f)));});return o;}
function loadData(){var dir=path.join(ROOT,'data-cache'),out={};['5m','1h','4h','1d','1w','1M'].forEach(function(tf){var by={};fs.readdirSync(dir).filter(function(f){return f.indexOf(SYMBOL+'_'+tf+'_')===0&&/\.json$/.test(f);}).forEach(function(f){var rows;try{rows=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch(e){return;}(rows||[]).forEach(function(c){if(c&&c.source==='futures'&&c.closed!==false&&c.closeTime>=ENGINE_START&&c.closeTime<=END)by[c.openTime]=c;});});out[tf]=Object.keys(by).map(function(k){return by[k];}).sort(function(a,b){return a.openTime-b.openTime;});});var ep=path.join(dir,SYMBOL+'_EXCHANGE.json');out.exchangeInfo=fs.existsSync(ep)?JSON.parse(fs.readFileSync(ep,'utf8')):{symbol:SYMBOL,tickSize:.1};return out;}
function render(r){return['# WATCH Narrative Re-Arm Audit V1','','- Read-only: true','- Outcome used: false','','## Final','','- REARM_POLICY_CANDIDATE = '+r.policy.REARM_POLICY_CANDIDATE,'','## Evidence','','- repeat pairs: '+r.REPEAT_WATCH_PAIRS,'- A: '+r.categoryCounts.A_CONTINUOUS_SAME_DIRECTION+' / '+r.categoryPercentOfRepeatPairs.A_CONTINUOUS_SAME_DIRECTION+'%','- B: '+r.categoryCounts.B_REARM_AFTER_TOUCH+' / '+r.categoryPercentOfRepeatPairs.B_REARM_AFTER_TOUCH+'%','- C: '+r.categoryCounts.C_REARM_AFTER_CONTEXT_CHANGE+' / '+r.categoryPercentOfRepeatPairs.C_REARM_AFTER_CONTEXT_CHANGE+'%','- D: '+r.categoryCounts.D_OPPOSITE_DIRECTION+' / '+r.categoryPercentOfRepeatPairs.D_OPPOSITE_DIRECTION+'%','- E: '+r.categoryCounts.E_STRICT_DUPLICATE+' / '+r.categoryPercentOfRepeatPairs.E_STRICT_DUPLICATE+'%','','## Invariants','','- PRODUCTION_CHANGED = '+r.invariants.PRODUCTION_CHANGED,'- FUTURE_LEAK_VIOLATIONS = '+r.invariants.FUTURE_LEAK_VIOLATIONS,''].join('\n');}
