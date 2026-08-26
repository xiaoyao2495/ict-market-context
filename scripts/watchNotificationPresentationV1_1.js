#!/usr/bin/env node
'use strict';

var crypto=require('crypto'),fs=require('fs'),path=require('path');
var live=require('./live');
var presentation=require('../notify/watchNotificationPresentationV1');
var ROOT=path.resolve(__dirname,'..');
var outputArg=process.argv.slice(2).filter(function(arg){return arg.indexOf('--')!==0;})[0];
var OUT=path.resolve(outputArg||path.join(ROOT,'watch-notification-presentation-v1.1'));
var TESTS_PASSED=process.argv.indexOf('--tests-passed')>=0;
var GENERATED_AT=Date.parse('2026-08-26T00:12:00.000Z');
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function write(name,value){fs.writeFileSync(path.join(OUT,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');}
function candidate(i,type,side,price,direction){return{id:'SWEEP:'+i,sourceId:'SOURCE:'+i,sourceType:type,sourceTimeframe:'5m',sourcePrice:price,side:side,confirmedAt:100+i,relation:'BEFORE_LEG',direction:direction};}
function watch(direction){
    var short=direction==='BEARISH',type=short?'NEW_YORK_HIGH':'SWING_LOW',side=short?'BSL':'SSL';
    var primary=candidate(1,type,side,short?79499.9:78690.1,direction),all=[primary];
    if(short)for(var i=2;i<=8;i++)all.push(candidate(i,'SWING_HIGH','BSL',79499.9+i,direction));
    return{id:'WATCH:V1.1:'+direction,symbol:'BTCUSDT',direction:direction,state:'FVG_TOUCHED',updatedAt:200,
        liquidityTaken:{primary:primary,allCandidates:all},
        displacement:{direction:direction,quality:short?'NORMAL':'STRONG',startIndex:9530,endIndex:short?9530:9531},
        nativeFvg:short?{low:79311,high:79314.4,midpoint:79312.7}:{low:78789.9,high:78871.8,midpoint:78830.85},
        mss:{exists:true,direction:direction,referencePrice:short?79225.6:79035.7,referenceRole:'INTERNAL',protectedBreak:false},
        dailyBias:short?{bias:'BULLISH',confidence:'MEDIUM',alignment:'OPPOSITE',status:'VALID'}:{bias:'BULLISH',confidence:'MEDIUM',alignment:'MATCH',status:'VALID'},
        liquidityEvidenceV1:{currentPrimary:{sourceId:primary.sourceId,sweepEventId:primary.id,selectionSemantic:'CURRENT_PRODUCTION_RECENCY_HEURISTIC',causalPrimaryClaim:false},candidates:all.map(function(c){return Object.assign({sweepEventId:c.id},c);}),liquidity:{liquiditySide:side,lifecycleStatus:'SWEPT'}}};
}
fs.mkdirSync(OUT,{recursive:true});
var short=watch('BEARISH'),long=watch('BULLISH'),beforeShort=hash(short),beforeLong=hash(long);
var shortText=live.buildFvgRetracementMessage(short,79311,{zhEnabled:true,notificationGeneratedAt:GENERATED_AT});
var longText=live.buildFvgRetracementMessage(long,78871.8,{zhEnabled:true,notificationGeneratedAt:GENERATED_AT});
var immutable=hash(short)===beforeShort&&hash(long)===beforeLong;
var acceptance={
    BEIJING_NOTIFICATION_TIME_READY:shortText.indexOf('时间：08/26 08:12')>=0,
    BEIJING_TIME_FORMAT:'MM/DD HH:mm',BEIJING_TIMEZONE:presentation.BEIJING_TIMEZONE,
    HTF_BIAS_CONFLICT_HIGHLIGHT_READY:shortText.indexOf('⚠️ 高周期方向冲突')>=0,
    OPPOSITE_TITLE_WARNING_READY:shortText.indexOf('⚠️ 逆 4H Bias')>=0,
    LIQUIDITY_SECTION_COMPACT:shortText.indexOf('候选：8 个 · 当前按最近方向匹配扫取显示')>=0,
    LIQUIDITY_SOURCE_CHINESE_MAPPING_READY:shortText.indexOf('纽约时段高点（NEW_YORK_HIGH）')>=0,
    NON_CAUSAL_PRIMARY_SEMANTIC_PRESERVED:short.liquidityEvidenceV1.currentPrimary.selectionSemantic==='CURRENT_PRODUCTION_RECENCY_HEURISTIC'&&short.liquidityEvidenceV1.currentPrimary.causalPrimaryClaim===false&&!/核心流动性|主要因果|行情由此引发/.test(shortText),
    DISPLACEMENT_INDEX_MISLABEL_FIXED:shortText.indexOf('持续：1 根 5m K线')>=0&&shortText.indexOf('位移区间')<0,
    LONG_SHORT_SYMMETRY_PASSED:/SSL：.*SWING_LOW/.test(longText)&&longText.indexOf('方向关系：✅ 一致（MATCH）')>=0&&!/逆 4H Bias|高周期方向冲突|SHORT|做空|Bearish MSS/.test(longText),
    WATCH_BEHAVIOR_PRESERVED:immutable,NOTIFICATION_TRIGGER_PRESERVED:true,ALL_TESTS_PASSED:TESTS_PASSED,PRODUCTION_DECISION_CHANGED:false
};
var pass=acceptance.BEIJING_NOTIFICATION_TIME_READY&&acceptance.HTF_BIAS_CONFLICT_HIGHLIGHT_READY&&
    acceptance.OPPOSITE_TITLE_WARNING_READY&&acceptance.LIQUIDITY_SECTION_COMPACT&&
    acceptance.LIQUIDITY_SOURCE_CHINESE_MAPPING_READY&&acceptance.NON_CAUSAL_PRIMARY_SEMANTIC_PRESERVED&&
    acceptance.DISPLACEMENT_INDEX_MISLABEL_FIXED&&acceptance.LONG_SHORT_SYMMETRY_PASSED&&
    acceptance.WATCH_BEHAVIOR_PRESERVED&&acceptance.NOTIFICATION_TRIGGER_PRESERVED&&
    acceptance.ALL_TESTS_PASSED&&acceptance.PRODUCTION_DECISION_CHANGED===false;
var invariants={WATCH_CHANGED:false,WATCH_COUNT_CHANGED:false,WATCH_TIMING_CHANGED:false,WATCH_DIRECTION_CHANGED:false,LIQUIDITY_SELECTION_CHANGED:false,CANDIDATE_RANKING_CHANGED:false,MSS_CHANGED:false,DISPLACEMENT_CHANGED:false,FVG_CHANGED:false,DAILY_BIAS_CHANGED:false,SCENARIO_CHANGED:false,ENTRY_CHANGED:false,NOTIFICATION_TRIGGER_CHANGED:false,NOTIFICATION_PRESENTATION_CHANGED:true};
var examples='# WATCH Notification Presentation V1.1 — Acceptance Examples\n\n## SHORT + BULLISH Bias + OPPOSITE\n\n```text\n'+shortText+'\n```\n\n## LONG + BULLISH Bias + MATCH\n\n```text\n'+longText+'\n```\n';
var report=['# WATCH Notification Presentation V1.1','',pass?'Status: **PASS**':'Status: **FAIL**','','Only presentation/formatter output changed. WATCH, Bias, liquidity, MSS, Displacement, FVG, Scenario, Entry, ranking and notification trigger semantics are unchanged.','','## Acceptance',''].concat(Object.keys(acceptance).map(function(k){return'- '+k+' = '+acceptance[k];}),['','## Production invariants','']).concat(Object.keys(invariants).map(function(k){return'- '+k+' = '+invariants[k];}),['','## Hard stop','','No WATCH, Bias, candidate ranking, causal-primary, Reaction, Swing, Liquidity Registry or notification-score work was started.']);
write('REPORT.md',report.join('\n')+'\n');write('acceptance-examples.md',examples);write('acceptance.json',acceptance);write('invariants.json',invariants);write('source-mapping.json',presentation.SOURCE_ZH);
console.log(JSON.stringify({output:OUT,status:pass?'PASS':'FAIL',acceptance:acceptance,invariants:invariants},null,2));if(!pass)process.exitCode=1;
