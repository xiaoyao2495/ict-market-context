#!/usr/bin/env node
'use strict';
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');
var displacementWatch = require('../stats/displacementWatch');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, '.audit-displacement-centric-watch-fvg-retracement-v1'));
var SYMBOL = 'BTCUSDT';
var START = Date.parse('2026-07-23T16:40:00.000Z');
var END = Date.parse('2026-08-22T16:39:59.999Z');
var ENGINE_START = Date.parse('2026-06-23T16:40:00.000Z');
var BAR = 300000;
var ruleFiles = ['liquidity/equalLiquidity.js','liquidity/liquidityLifecycle.js','events/sweepEventAdapter.js',
    'events/displacementDetector.js','events/mssSignalDetector.js','structure/pivotDetector.js',
    'structure/structuralProvenance5m.js','config/thresholds.js'];
var beforeHashes = hashes(ruleFiles);
var data = loadData();
var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START && c.closeTime <= END; });
var engine = liveEngine.createLiveEngine({ symbol: SYMBOL, exchangeInfo: data.exchangeInfo,
    structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
    calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
    fetcher: function (symbol, interval) { return Promise.resolve(data[interval] || []); }, thresholds: thresholds
}, { snapshotInterval: 12, baseIndex: 0, dailyBiasProvider: function () {
    return { bias:'UNKNOWN', confidence:null, alignment:'UNKNOWN', status:'BYPASSED', evaluationTime:null, ageMs:null };
} });
var store = displacementWatch.createWatchStore([], {});
var initial = {}, notifications = [], notificationIds = {};
var chain = Promise.resolve();
candles.forEach(function (c, i) {
    chain = chain.then(function () {
        return engine.onBar(c, i).then(function () {
            engine.drainDisplacementWatchUpdates().forEach(function (w) {
                if (!initial[w.id]) initial[w.id] = clone(w);
                store.upsert(w);
            });
            store.onCandle(c).forEach(function (w) {
                if (notificationIds[w.notificationKey]) return;
                notificationIds[w.notificationKey] = true;
                notifications.push(notificationRecord(w, c));
                store.markNotified(w.id, c.closeTime);
            });
        });
    });
});
chain.then(report).catch(function (e) { console.error(e && e.stack || e); process.exitCode = 1; });

function report() {
    var state = engine.getState();
    var displacements = state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT').filter(inWindow);
    var watches = store.getAll().filter(function (w) { return w.createdAt >= START && w.createdAt <= END; });
    var watchIds = {}; watches.forEach(function (w) { watchIds[w.id] = true; });
    notifications = notifications.filter(function (n) { return watchIds[n.watchId]; });
    var matchedDisp = {};
    watches.forEach(function (w) { w.displacementIds.forEach(function (id) { matchedDisp[id] = true; }); });
    var withFvg = watches.filter(function (w) { return !!w.nativeFvg; });
    var withoutFvg = watches.filter(function (w) { return !w.nativeFvg; });
    var invalidated = withFvg.filter(function (w) { return w.state === 'INVALIDATED'; });
    var touchedIds = {}; notifications.forEach(function (n) { touchedIds[n.watchId] = true; });
    var neverTouched = withFvg.filter(function (w) { return !touchedIds[w.id] && w.state !== 'INVALIDATED'; });
    var future = [];
    watches.forEach(function (w) {
        (w.liquidityTaken.allCandidates || []).forEach(function (s) {
            if (s.confirmedAt > w.updatedAt) future.push({ watchId:w.id, id:s.id, reason:'SWEEP_AFTER_WATCH_EVALUATION' });
        });
        (w.nativeFvgs || []).forEach(function (f) {
            if (f.confirmedAt > w.updatedAt) future.push({ watchId:w.id, id:f.id, reason:'NATIVE_FVG_AFTER_WATCH_EVALUATION' });
        });
        if (w.mss.exists && w.mss.confirmedAt > w.updatedAt) future.push({ watchId:w.id, id:w.mss.id, reason:'MSS_AFTER_WATCH_EVALUATION' });
    });
    notifications.forEach(function (n) {
        if (n.firstTouchAt <= n.watchCreatedAt || n.firstTouchAt <= n.nativeFvgConfirmedAt) future.push({ watchId:n.watchId, reason:'TOUCH_NOT_AFTER_WATCH_AND_FVG' });
    });
    var afterHashes = hashes(ruleFiles);
    var ruleChanged = ruleFiles.filter(function (f) { return beforeHashes[f] !== afterHashes[f]; });
    var oldSummary = JSON.parse(fs.readFileSync(path.join(ROOT, '.audit-opportunity-quality-narrative-refactor-v1/summary.json'), 'utf8'));
    var summary = {
        DISPLACEMENT_COUNT: displacements.length,
        DISPLACEMENT_WITH_MATCHING_LIQUIDITY: Object.keys(matchedDisp).filter(function (id) { return displacements.some(function (d) { return d.id === id; }); }).length,
        WATCH_CREATED: watches.length,
        WATCH_WITH_MSS: watches.filter(function (w) { return w.mss && w.mss.exists; }).length,
        WATCH_WITHOUT_MSS: watches.filter(function (w) { return !w.mss || !w.mss.exists; }).length,
        WATCH_WITH_NATIVE_FVG: withFvg.length,
        WATCH_WITHOUT_NATIVE_FVG: withoutFvg.length,
        WATCH_FVG_FIRST_TOUCH: notifications.length,
        WATCH_INVALIDATED_BEFORE_TOUCH: invalidated.length,
        WATCH_NEVER_TOUCHED: neverTouched.length,
        SIMULATED_NOTIFICATIONS: notifications.length,
        OLD_NOTIFICATION_COUNT: oldSummary.Notifications.after,
        NEW_FVG_RETRACE_NOTIFICATION_COUNT: notifications.length
    };
    var touchMinutes = notifications.map(function (n) { return n.minutesFromWatchToTouch; });
    var liquidityBars = notifications.map(function (n) { return n.liquidityToDisplacementBars; });
    var timeToAlert = {
        watchToTouchMinutes: distribution(touchMinutes),
        watchToTouchBars: distribution(notifications.map(function (n) { return n.watchToTouchBars; })),
        liquidityToDisplacementBars: distribution(liquidityBars)
    };
    var direction = { LONG: metrics(watches.filter(function (w) { return w.direction === 'BULLISH'; }), notifications),
        SHORT: metrics(watches.filter(function (w) { return w.direction === 'BEARISH'; }), notifications) };
    var liqTypes = {};
    watches.forEach(function (w) { var k = liquidityBucket(w.liquidityTaken.primary && w.liquidityTaken.primary.sourceType); liqTypes[k] = (liqTypes[k] || 0) + 1; });
    var samples = notifications.slice().sort(function (a,b) { return hash(a.watchId).localeCompare(hash(b.watchId)); }).slice(0,20).map(function (n,i) {
        var w = store.get(n.watchId); return { reviewId:'DCW-FVG-HR-'+String(i+1).padStart(2,'0'), selection:'SHA256 deterministic; no post-touch Outcome',
            watchId:w.id, liquidityTaken:w.liquidityTaken, displacement:w.displacement, nativeFvg:w.nativeFvg,
            mss:w.mss, structuralProvenance:w.structuralProvenance, dailyBias:w.dailyBias, touch:n.touchCandle,
            firstTouchAt:n.firstTouchAt, outcomeIncluded:false };
    });
    var result = { audit:{ version:'Displacement-Centric Watch & FVG Retracement Notification V1', symbol:SYMBOL,
        start:START,startIso:iso(START),end:END,endIso:iso(END),engineStart:ENGINE_START,engineStartIso:iso(ENGINE_START),
        productionReplayPath:'live/liveEngine.createLiveEngine().onBar',closedCandlesOnly:true,outcomeUsed:false,
        watchSemantics:'Displacement first; only then backward association of matching production sweeps.',
        nativeFvgSemantics:'Owning displacement K1/K2/K3 only; global FVG registry is not an input.' },
        summary:summary, timeToAlert:timeToAlert, byDirection:direction, byPrimaryLiquidityType:liqTypes,
        acceptance:{ DISPLACEMENT_IS_PRIMARY_TRIGGER:true,
            WATCH_REQUIRES:{DISPLACEMENT:true,MATCHING_LIQUIDITY_TAKEN:true,MSS:false,NATIVE_FVG:false},
            FVG_RETRACE_NOTIFICATION_REQUIRES:{WATCH:true,NATIVE_FVG:true,FIRST_TOUCH:true},
            NO_NATIVE_FVG_BEHAVIOR:'WATCH_ONLY_NO_NOTIFICATION', MSS_IS_ENRICHMENT:true, DAILY_BIAS_IS_ENRICHMENT:true },
        invariants:{ FUTURE_LEAK_VIOLATIONS:future.length, OUTCOME_USED:false,
            DUPLICATE_NOTIFICATION_KEYS: notifications.length - Object.keys(notificationIds).filter(function (k) { return notifications.some(function (n) { return n.notificationKey === k; }); }).length,
            NO_FVG_NOTIFICATION_VIOLATIONS: notifications.filter(function (n) { var w=store.get(n.watchId); return !w || !w.nativeFvg; }).length,
            PRODUCTION_RULES_UNCHANGED:{LIQUIDITY:ruleChanged.indexOf('liquidity/equalLiquidity.js')<0&&ruleChanged.indexOf('liquidity/liquidityLifecycle.js')<0,
                SWEEP:ruleChanged.indexOf('events/sweepEventAdapter.js')<0,DISPLACEMENT:ruleChanged.indexOf('events/displacementDetector.js')<0,
                MSS:ruleChanged.indexOf('events/mssSignalDetector.js')<0}, RULE_HASH_CHANGES_DURING_REPLAY:ruleChanged },
        futureLeakDetails:future, productionRuleHashesBefore:beforeHashes, productionRuleHashesAfter:afterHashes };
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT,{recursive:true});
    fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(OUT,'watch-ledger.json'),JSON.stringify(watches,null,2));
    fs.writeFileSync(path.join(OUT,'simulated-notifications.json'),JSON.stringify(notifications,null,2));
    fs.writeFileSync(path.join(OUT,'human-review-samples.json'),JSON.stringify(samples,null,2));
    fs.writeFileSync(path.join(OUT,'DISPLACEMENT_CENTRIC_WATCH_FVG_RETRACE_V1_REPORT.md'),render(result));
    console.log(JSON.stringify({summary:summary,timeToAlert:timeToAlert,byDirection:direction,byPrimaryLiquidityType:liqTypes,acceptance:result.acceptance,invariants:result.invariants,output:OUT},null,2));
    if (future.length || ruleChanged.length) process.exitCode=1;
}
function notificationRecord(w,c) {
    var liqAt=w.liquidityTaken.primary.confirmedAt, dispAt=w.displacement.firstConfirmedAt;
    return { watchId:w.id,notificationKey:w.notificationKey,direction:w.direction,
        liquidityTakenAt:liqAt,liquidityTakenAtIso:iso(liqAt),displacementConfirmedAt:dispAt,displacementConfirmedAtIso:iso(dispAt),
        watchCreatedAt:w.createdAt,watchCreatedAtIso:iso(w.createdAt),nativeFvgConfirmedAt:w.nativeFvg.confirmedAt,nativeFvgConfirmedAtIso:iso(w.nativeFvg.confirmedAt),
        firstTouchAt:c.closeTime,firstTouchAtIso:iso(c.closeTime),liquidityToDisplacementBars:round((dispAt-liqAt)/BAR),
        watchToTouchBars:round((c.closeTime-w.createdAt)/BAR),minutesFromWatchToTouch:round((c.closeTime-w.createdAt)/60000),
        primaryLiquidityType:w.liquidityTaken.primary.sourceType,touchCandle:compactCandle(c),invalidatedBeforeTouch:false,outcomeIncluded:false };
}
function metrics(ws,ns){var ids={};ws.forEach(function(w){ids[w.id]=true;});return{WATCH_CREATED:ws.length,WATCH_WITH_NATIVE_FVG:ws.filter(function(w){return!!w.nativeFvg;}).length,WATCH_WITHOUT_NATIVE_FVG:ws.filter(function(w){return!w.nativeFvg;}).length,SIMULATED_NOTIFICATIONS:ns.filter(function(n){return ids[n.watchId];}).length};}
function distribution(a){if(!a.length)return{count:0,min:null,median:null,p90:null,max:null};var x=a.slice().sort(function(p,q){return p-q;});return{count:x.length,min:x[0],median:x[Math.floor((x.length-1)*0.5)],p90:x[Math.floor((x.length-1)*0.9)],max:x[x.length-1]};}
function liquidityBucket(t){t=String(t||'OTHER').toUpperCase();if(['EQL','PDL','PWL','SWING_LOW','EQH','PDH','PWH','SWING_HIGH'].indexOf(t)>=0)return t;if(/^(ASIA|LONDON|NEW_YORK)_LOW$/.test(t))return'SESSION_LOW';if(/^(ASIA|LONDON|NEW_YORK)_HIGH$/.test(t))return'SESSION_HIGH';return'OTHER';}
function compactCandle(c){return{openTime:c.openTime,closeTime:c.closeTime,open:c.open,high:c.high,low:c.low,close:c.close,closed:c.closed,source:c.source};}
function inWindow(x){return x.confirmedAt>=START&&x.confirmedAt<=END;}
function hashes(files){var o={};files.forEach(function(f){o[f]=crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,f))).digest('hex');});return o;}
function hash(s){return crypto.createHash('sha256').update(s).digest('hex');}
function clone(x){return JSON.parse(JSON.stringify(x));} function iso(t){return new Date(t).toISOString();} function round(n){return Math.round(n*1e8)/1e8;}
function loadData(){var dir=path.join(ROOT,'data-cache'),out={};['5m','1h','4h','1d','1w','1M'].forEach(function(tf){var by={};fs.readdirSync(dir).filter(function(f){return f.indexOf(SYMBOL+'_'+tf+'_')===0&&/\.json$/.test(f);}).forEach(function(f){var rows;try{rows=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch(e){return;}(rows||[]).forEach(function(c){if(c&&c.source==='futures'&&c.closed!==false&&c.closeTime>=ENGINE_START&&c.closeTime<=END)by[c.openTime]=c;});});out[tf]=Object.keys(by).map(function(k){return by[k];}).sort(function(a,b){return a.openTime-b.openTime;});});var ep=path.join(dir,SYMBOL+'_EXCHANGE.json');out.exchangeInfo=fs.existsSync(ep)?JSON.parse(fs.readFileSync(ep,'utf8')):{symbol:SYMBOL,tickSize:0.1};return out;}
function render(r){var s=r.summary;return['# Displacement-Centric Watch & FVG Retracement Notification V1','',
    '- Fixed window: '+r.audit.startIso+' → '+r.audit.endIso,'- Outcome used: false','',
    '| Metric | Count |','| --- | ---: |'].concat(Object.keys(s).map(function(k){return'| '+k+' | '+s[k]+' |';}),['','## Acceptance','',
    '- DISPLACEMENT_IS_PRIMARY_TRIGGER = true','- WATCH_REQUIRES: DISPLACEMENT=true, MATCHING_LIQUIDITY_TAKEN=true, MSS=false, NATIVE_FVG=false',
    '- FVG_RETRACE_NOTIFICATION_REQUIRES: WATCH=true, NATIVE_FVG=true, FIRST_TOUCH=true','- NO_NATIVE_FVG_BEHAVIOR = WATCH_ONLY_NO_NOTIFICATION',
    '- MSS_IS_ENRICHMENT = true','- DAILY_BIAS_IS_ENRICHMENT = true','','## Invariants','',
    '- FUTURE_LEAK_VIOLATIONS = '+r.invariants.FUTURE_LEAK_VIOLATIONS,'- OUTCOME_USED = false','']).join('\n');}
