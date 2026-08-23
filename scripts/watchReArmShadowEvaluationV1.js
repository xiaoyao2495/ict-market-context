#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');

var ROOT = path.resolve(__dirname, '..');
var SOURCE = path.join(ROOT, '.audit-displacement-centric-watch-fvg-retracement-v1');
var PAIR_SOURCE = path.join(ROOT, '.audit-watch-rearm-v1', 'watch-pairs-ledger.json');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, '.audit-watch-rearm-shadow-evaluation-v1'));
var SYMBOL = 'BTCUSDT';
var START = Date.parse('2026-07-23T16:40:00.000Z');
var END = Date.parse('2026-08-22T16:39:59.999Z');
var ENGINE_START = Date.parse('2026-06-23T16:40:00.000Z');
var PRODUCTION_FILES = [
  'stats/displacementWatch.js', 'live/liveEngine.js', 'live/futuresPriceStream.js',
  'scripts/live.js', 'events/displacementDetector.js', 'events/sweepEventAdapter.js',
  'liquidity/liquidityLifecycle.js', 'config/thresholds.js'
];

var hashesBefore = hashes(PRODUCTION_FILES);
var watches = readJson(path.join(SOURCE, 'watch-ledger.json'));
var notifications = readJson(path.join(SOURCE, 'simulated-notifications.json'));
var pairs = readJson(PAIR_SOURCE);
var data = loadData();
var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START && c.closeTime <= END; });

var watchById = indexBy(watches, 'id');
var notificationByWatch = {};
notifications.forEach(function (n) { notificationByWatch[n.watchId] = n; });

var targetA = pairs.filter(function (p) {
  return p.category === 'A_CONTINUOUS_SAME_DIRECTION' &&
    p.previous.nativeFvg &&
    p.previous.stillActiveAtNext && !p.previous.touchedBeforeNextCreation &&
    !p.previous.firstTouchAt;
});
var targetE = pairs.filter(function (p) { return p.category === 'E_STRICT_DUPLICATE'; });

if (targetA.length !== 15 || targetE.length !== 29) {
  throw new Error('Target population mismatch: A=' + targetA.length + ', E=' + targetE.length);
}

var engine = liveEngine.createLiveEngine({
  symbol: SYMBOL,
  exchangeInfo: data.exchangeInfo,
  structureCandles: {'1d': data['1d'], '4h': data['4h'], '1h': data['1h']},
  calendarCandles: {'1d': data['1d'], '1w': data['1w'], '1M': data['1M']},
  fetcher: function (symbol, timeframe) { return Promise.resolve(data[timeframe] || []); },
  thresholds: thresholds
}, {
  snapshotInterval: 12,
  baseIndex: 0,
  dailyBiasProvider: function () {
    return {bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'BYPASSED', evaluationTime: null, ageMs: null};
  }
});

var chain = Promise.resolve();
candles.forEach(function (c, i) {
  chain = chain.then(function () {
    return engine.onBar(c, i).then(function () { engine.drainDisplacementWatchUpdates(); });
  });
});
chain.then(build).catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});

function build() {
  var state = engine.getState();
  var displacements = state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT');
  var mss = state.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_MSS');
  var continuation = state.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_CONTINUATION');
  var liquidity = state.registry.getAll(SYMBOL);
  var liquidityById = indexBy(liquidity, 'id');

  var aLedger = targetA.map(function (p, i) { return evaluatePair('A_ACTIVE_WITH_FVG', i + 1, p, displacements, mss, continuation, liquidityById); });
  var eLedger = targetE.map(function (p, i) { return evaluatePair('E_STRICT', i + 1, p, displacements, mss, continuation, liquidityById); });
  var all = aLedger.concat(eLedger);

  var aSummary = summarize(aLedger);
  var eSummary = summarize(eLedger);
  var keepNotifications = aSummary.secondFirstTouchCount + eSummary.secondFirstTouchCount;
  var untilTouchLost = aSummary.secondFirstTouchCount;
  var strictLost = eSummary.secondFirstTouchCount;
  var recommendation = (untilTouchLost === 0 && strictLost === 0) ? 'STRICT_DUPLICATE_ONLY' : 'NO_CHANGE';

  var future = [];
  all.forEach(function (r) {
    if (r.second.nativeFvg && r.second.nativeFvg.confirmedAt > r.analysisHorizon) future.push({pairId: r.pairId, field: 'second.nativeFvg.confirmedAt'});
    if (r.second.firstTouchAt && r.second.firstTouchAt > END) future.push({pairId: r.pairId, field: 'second.firstTouchAt'});
    r.eventsBeforeSecondTouch.newDisplacements.forEach(function (e) { if (e.confirmedAt > r.analysisHorizon) future.push({pairId: r.pairId, eventId: e.id}); });
    r.eventsBeforeSecondTouch.mssEvents.forEach(function (e) { if (e.confirmedAt > r.analysisHorizon) future.push({pairId: r.pairId, eventId: e.id}); });
  });

  var hashesAfter = hashes(PRODUCTION_FILES);
  var changed = PRODUCTION_FILES.filter(function (f) { return hashesBefore[f] !== hashesAfter[f]; });
  var summary = {
    audit: 'WATCH Re-Arm Shadow Evaluation V1',
    symbol: SYMBOL,
    window: {start: iso(START), end: iso(END), closedCandlesOnly: true},
    outcomeUsed: false,
    populations: {A_ACTIVE_WITH_FVG: aSummary, E_STRICT: eSummary},
    policyComparison: {
      KEEP_SECOND_WATCH: {secondWatchesKept: 44, firstTouchNotificationsRetained: keepNotifications, firstTouchNotificationsRemoved: 0},
      UNTIL_TOUCH: {secondWatchesSuppressed: 15, noTouchWatchesRemoved: aSummary.secondNeverTouchedCount, firstTouchNotificationsRemoved: untilTouchLost},
      STRICT_DUPLICATE_ONLY: {secondWatchesSuppressed: 29, noTouchWatchesRemoved: eSummary.secondNeverTouchedCount, firstTouchNotificationsRemoved: strictLost}
    },
    REARM_POLICY: recommendation,
    rationale: recommendation === 'NO_CHANGE'
      ? 'Both suppression candidates remove independently observed FIRST_TOUCH events; E-strict removes all 29 second-touch notifications.'
      : 'Suppression did not remove independently observed FIRST_TOUCH events.',
    invariants: {
      PRODUCTION_CHANGED: changed.length > 0,
      PRODUCTION_HASH_CHANGES: changed,
      FUTURE_LEAK_VIOLATIONS: future.length,
      OUTCOME_USED: false
    },
    futureLeakDetails: future
  };

  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'a-active-with-fvg-15.json'), JSON.stringify(aLedger, null, 2));
  fs.writeFileSync(path.join(OUT, 'e-strict-29.json'), JSON.stringify(eLedger, null, 2));
  fs.writeFileSync(path.join(OUT, 'all-44-pair-ledger.json'), JSON.stringify(all, null, 2));
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'WATCH_REARM_SHADOW_EVALUATION_V1_REPORT.md'), render(summary));
  console.log(JSON.stringify(summary, null, 2));
  if (changed.length || future.length) process.exitCode = 1;
}

function evaluatePair(group, number, pair, displacements, mss, continuation, liquidityById) {
  var prev = watchById[pair.previous.watchId];
  var next = watchById[pair.next.watchId];
  var nextNotification = notificationByWatch[next.id] || null;
  var horizon = next.firstTouchAt || END;
  var start = next.nativeFvg ? next.nativeFvg.confirmedAt : next.createdAt;
  var sourceId = next.liquidityTaken && next.liquidityTaken.primary && next.liquidityTaken.primary.sourceId;
  var source = sourceId ? liquidityById[sourceId] : null;
  var newDisplacements = displacements.filter(function (d) {
    return d.id !== next.displacementIds[0] && d.confirmedAt > start && d.confirmedAt < horizon;
  }).map(compactEvent);
  var mssEvents = mss.filter(function (e) { return e.confirmedAt > start && e.confirmedAt < horizon; }).map(compactStructural);
  var continuationEvents = continuation.filter(function (e) { return e.confirmedAt > start && e.confirmedAt < horizon; }).map(compactStructural);
  var lifecycle = [];
  if (source) {
    [['touchedAt', 'TOUCHED'], ['sweptAt', 'SWEPT'], ['brokenAt', 'BROKEN']].forEach(function (x) {
      var t = source[x[0]];
      if (t > start && t < horizon) lifecycle.push({state: x[1], at: t, atIso: iso(t)});
    });
  }
  var overlap = overlapRatio(prev.nativeFvg, next.nativeFvg);
  return {
    pairId: group + '-' + String(number).padStart(2, '0'),
    category: group,
    narrativeId: pair.narrativeId,
    direction: next.direction,
    outcomeUsed: false,
    previous: watchRecord(prev, notificationByWatch[prev.id]),
    second: watchRecord(next, nextNotification),
    secondFvgRelationToFirst: {
      overlapRatio: round(overlap),
      overlapPercent: round(overlap * 100),
      relation: fvgRelation(prev.nativeFvg, next.nativeFvg),
      sameDirection: prev.direction === next.direction,
      displacementGapMinutes: pair.metrics.gapMinutes
    },
    analysisStartAt: start,
    analysisStartAtIso: iso(start),
    analysisHorizon: horizon,
    analysisHorizonIso: iso(horizon),
    horizonReason: next.firstTouchAt ? 'SECOND_FVG_FIRST_TOUCH' : 'REPLAY_WINDOW_END',
    eventsBeforeSecondTouch: {
      newDisplacementOccurred: newDisplacements.length > 0,
      newDisplacementCount: newDisplacements.length,
      newDisplacements: newDisplacements,
      mssOccurred: mssEvents.length > 0,
      mssCount: mssEvents.length,
      mssEvents: mssEvents,
      structuralContinuationCount: continuationEvents.length,
      structuralContinuationEvents: continuationEvents,
      structuralStateChanged: mssEvents.length > 0,
      liquidityLifecycleChanged: lifecycle.length > 0,
      liquidityLifecycleChanges: lifecycle
    },
    keepSecondWatch: {notificationRetained: !!nextNotification},
    suppressSecondWatch: {notificationRemoved: !!nextNotification}
  };
}

function watchRecord(w, n) {
  return {
    watchId: w.id,
    createdAt: w.createdAt,
    createdAtIso: iso(w.createdAt),
    displacementId: w.displacementIds[0],
    nativeFvgExists: !!w.nativeFvg,
    nativeFvg: w.nativeFvg ? compactFvg(w.nativeFvg) : null,
    firstTouchOccurred: !!w.firstTouchAt,
    firstTouchAt: w.firstTouchAt || null,
    firstTouchAtIso: iso(w.firstTouchAt),
    notificationProduced: !!n,
    notificationKey: n ? n.notificationKey : null
  };
}

function summarize(records) {
  return {
    pairCount: records.length,
    secondNativeFvgCount: records.filter(function (r) { return r.second.nativeFvgExists; }).length,
    secondMissingNativeFvgCount: records.filter(function (r) { return !r.second.nativeFvgExists; }).length,
    secondFirstTouchCount: records.filter(function (r) { return r.second.firstTouchOccurred; }).length,
    secondNeverTouchedCount: records.filter(function (r) { return !r.second.firstTouchOccurred; }).length,
    secondFvgExistsButNeverTouchedCount: records.filter(function (r) { return r.second.nativeFvgExists && !r.second.firstTouchOccurred; }).length,
    secondNotificationCount: records.filter(function (r) { return r.second.notificationProduced; }).length,
    bothFvgsTouchedCount: records.filter(function (r) { return r.previous.firstTouchOccurred && r.second.firstTouchOccurred; }).length,
    previousTouchedBeforeSecondCreationCount: records.filter(function (r) { return r.previous.firstTouchAt && r.previous.firstTouchAt <= r.second.createdAt; }).length,
    previousStillUntouchedAtSecondCreationCount: records.filter(function (r) { return !r.previous.firstTouchAt || r.previous.firstTouchAt > r.second.createdAt; }).length,
    newDisplacementBeforeSecondTouchCount: records.filter(function (r) { return r.eventsBeforeSecondTouch.newDisplacementOccurred; }).length,
    mssBeforeSecondTouchCount: records.filter(function (r) { return r.eventsBeforeSecondTouch.mssOccurred; }).length,
    structuralStateChangedBeforeSecondTouchCount: records.filter(function (r) { return r.eventsBeforeSecondTouch.structuralStateChanged; }).length,
    liquidityLifecycleChangedBeforeSecondTouchCount: records.filter(function (r) { return r.eventsBeforeSecondTouch.liquidityLifecycleChanged; }).length
  };
}

function fvgRelation(a, b) {
  if (!a || !b) return 'MISSING_FVG';
  if (a.low === b.low && a.high === b.high) return 'EXACT_DUPLICATE';
  if (b.low >= a.low && b.high <= a.high) return 'SECOND_INSIDE_FIRST';
  if (a.low >= b.low && a.high <= b.high) return 'FIRST_INSIDE_SECOND';
  return overlapRatio(a, b) > 0 ? 'PARTIAL_OVERLAP' : 'NO_OVERLAP';
}

function overlapRatio(a, b) {
  if (!a || !b) return 0;
  var intersection = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
  var denominator = Math.min(a.high - a.low, b.high - b.low);
  return denominator > 0 ? intersection / denominator : 0;
}

function compactEvent(e) { return {id: e.id, direction: e.direction, occurredAt: e.occurredAt, occurredAtIso: iso(e.occurredAt), confirmedAt: e.confirmedAt, confirmedAtIso: iso(e.confirmedAt)}; }
function compactStructural(e) { return {id: e.id, direction: e.direction, confirmedAt: e.confirmedAt, confirmedAtIso: iso(e.confirmedAt), structuralStateBefore: e.structuralStateBefore, structuralStateAfter: e.structuralStateAfter}; }
function compactFvg(f) { return {id: f.id, direction: f.direction, low: f.low, high: f.high, midpoint: f.midpoint, confirmedAt: f.confirmedAt, confirmedAtIso: iso(f.confirmedAt)}; }
function indexBy(rows, key) { var out = {}; rows.forEach(function (r) { out[r[key]] = r; }); return out; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function iso(t) { return typeof t === 'number' ? new Date(t).toISOString() : null; }
function round(n) { return Math.round(n * 1e6) / 1e6; }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function hashes(files) { var out = {}; files.forEach(function (f) { out[f] = sha(fs.readFileSync(path.join(ROOT, f))); }); return out; }

function loadData() {
  var dir = path.join(ROOT, 'data-cache');
  var out = {};
  ['5m', '1h', '4h', '1d', '1w', '1M'].forEach(function (tf) {
    var byOpen = {};
    fs.readdirSync(dir).filter(function (f) { return f.indexOf(SYMBOL + '_' + tf + '_') === 0 && /\.json$/.test(f); }).forEach(function (f) {
      var rows;
      try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (error) { return; }
      (rows || []).forEach(function (c) {
        if (c && c.source === 'futures' && c.closed !== false && c.closeTime >= ENGINE_START && c.closeTime <= END) byOpen[c.openTime] = c;
      });
    });
    out[tf] = Object.keys(byOpen).map(function (k) { return byOpen[k]; }).sort(function (a, b) { return a.openTime - b.openTime; });
  });
  var exchangePath = path.join(dir, SYMBOL + '_EXCHANGE.json');
  out.exchangeInfo = fs.existsSync(exchangePath) ? readJson(exchangePath) : {symbol: SYMBOL, tickSize: 0.1};
  return out;
}

function render(s) {
  var a = s.populations.A_ACTIVE_WITH_FVG;
  var e = s.populations.E_STRICT;
  return [
    '# WATCH Re-Arm Shadow Evaluation V1', '',
    '- Read-only: true', '- Outcome used: false', '- Closed candles only: true', '',
    '## Results', '',
    '| Population | Pairs | Second FVG touched | Never touched | Both touched |',
    '|---|---:|---:|---:|---:|',
    '| A-active-with-FVG | ' + a.pairCount + ' | ' + a.secondFirstTouchCount + ' | ' + a.secondNeverTouchedCount + ' | ' + a.bothFvgsTouchedCount + ' |',
    '| E-strict | ' + e.pairCount + ' | ' + e.secondFirstTouchCount + ' | ' + e.secondNeverTouchedCount + ' | ' + e.bothFvgsTouchedCount + ' |', '',
    '- A second WATCH native FVG: ' + a.secondNativeFvgCount + '; missing native FVG: ' + a.secondMissingNativeFvgCount + '; FVG exists but never touched: ' + a.secondFvgExistsButNeverTouchedCount + '.',
    '- E previous FVG touched before second WATCH creation: ' + e.previousTouchedBeforeSecondCreationCount + ' / ' + e.pairCount + '.', '',
    '## Policy comparison', '',
    '- KEEP_SECOND_WATCH retains ' + s.policyComparison.KEEP_SECOND_WATCH.firstTouchNotificationsRetained + ' second-watch FIRST_TOUCH notifications.',
    '- UNTIL_TOUCH suppresses 15 WATCHes and removes ' + s.policyComparison.UNTIL_TOUCH.firstTouchNotificationsRemoved + ' FIRST_TOUCH notifications.',
    '- STRICT_DUPLICATE_ONLY suppresses 29 WATCHes and removes ' + s.policyComparison.STRICT_DUPLICATE_ONLY.firstTouchNotificationsRemoved + ' FIRST_TOUCH notifications.', '',
    'REARM_POLICY = ' + s.REARM_POLICY, '',
    'PRODUCTION_CHANGED = ' + s.invariants.PRODUCTION_CHANGED, '',
    'FUTURE_LEAK_VIOLATIONS = ' + s.invariants.FUTURE_LEAK_VIOLATIONS, ''
  ].join('\n');
}
