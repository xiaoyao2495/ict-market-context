#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SOURCE = path.join(ROOT, '.audit-displacement-centric-watch-fvg-retracement-v1');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, '.audit-displacement-fvg-notification-human-formation-v1'));
var CHARTS = path.join(OUT, 'charts');
var SYMBOL = 'BTCUSDT';
var START = Date.parse('2026-07-23T16:40:00.000Z');
var END = Date.parse('2026-08-22T16:39:59.999Z');
var ENGINE_START = Date.parse('2026-06-23T16:40:00.000Z');
var SEED = 'DFNHFA-V1-BTCUSDT-30D-20260823';
var PRODUCTION_FILES = [
  'stats/displacementWatch.js', 'live/liveEngine.js', 'live/futuresPriceStream.js',
  'scripts/live.js', 'events/displacementDetector.js', 'events/sweepEventAdapter.js',
  'liquidity/liquidityLifecycle.js', 'config/thresholds.js'
];

var hashesBefore = hashes(PRODUCTION_FILES);
var watches = readJson(path.join(SOURCE, 'watch-ledger.json'));
var notifications = readJson(path.join(SOURCE, 'simulated-notifications.json'));
var watchById = indexBy(watches, 'id');
var candles = load5mCandles();
var candleIndexByClose = {};
candles.forEach(function (c, i) { candleIndexByClose[c.closeTime] = i; });

var population = notifications.map(function (n) {
  var w = watchById[n.watchId];
  if (!w) throw new Error('Missing WATCH for notification ' + n.notificationKey);
  return {
    notification: n,
    watch: w,
    direction: w.direction,
    freshnessBand: freshnessBand(n.minutesFromWatchToTouch),
    liquidityGroup: liquidityGroup(w.liquidityTaken.primary.sourceType),
    sourceType: w.liquidityTaken.primary.sourceType
  };
});

var selected = selectForty(population);
if (selected.length !== 40) throw new Error('Expected 40 samples, got ' + selected.length);

fs.mkdirSync(CHARTS, {recursive: true});
var records = selected.map(buildRecord);
var futureLeaks = validateFutureSafety(records);
var hashesAfter = hashes(PRODUCTION_FILES);
var productionChanges = PRODUCTION_FILES.filter(function (f) { return hashesBefore[f] !== hashesAfter[f]; });
var summary = {
  audit: 'Displacement FVG Notification Human Formation Audit V1',
  symbol: SYMBOL,
  replayWindow: {start: iso(START), end: iso(END), closedCandlesOnly: true},
  sourceNotificationPopulation: notifications.length,
  sampleCount: records.length,
  deterministicSamplingSeed: SEED,
  samplingMethod: 'Fixed stratified sample. Preserve all PDH and SESSION notifications, retain EQH/EQL across freshness bands, fill remaining cells with SWING. Exact 20/20 direction and 8-per-freshness balance.',
  formationPopulation: summarize(records),
  invariants: {
    PRODUCTION_CHANGED: productionChanges.length > 0,
    PRODUCTION_HASH_CHANGES: productionChanges,
    FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
    OUTCOME_USED: false
  },
  futureLeakDetails: futureLeaks
};

fs.writeFileSync(path.join(OUT, 'formation-population.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, 'human-review-records.json'), JSON.stringify(records, null, 2));
fs.writeFileSync(path.join(OUT, 'HUMAN_FORMATION_REVIEW_INDEX.html'), renderIndex(records, summary));
fs.writeFileSync(path.join(OUT, 'DISPLACEMENT_FVG_NOTIFICATION_HUMAN_FORMATION_AUDIT_V1_REPORT.md'), renderReport(summary));
console.log(JSON.stringify(summary, null, 2));
if (productionChanges.length || futureLeaks.length) process.exitCode = 1;

function selectForty(rows) {
  var selectedRows = [];
  var used = {};
  function take(filter, count, label) {
    var candidates = rows.filter(function (x) { return !used[x.notification.notificationKey] && filter(x); }).sort(byHash);
    if (candidates.length < count) throw new Error('Insufficient candidates for ' + label + ': ' + candidates.length + ' < ' + count);
    candidates.slice(0, count).forEach(function (x) { used[x.notification.notificationKey] = true; selectedRows.push(x); });
  }

  // Preserve every rare production notification in the fixed window.
  take(function (x) { return x.liquidityGroup === 'PDH/PDL'; }, 3, 'PDH/PDL');
  take(function (x) { return x.liquidityGroup === 'SESSION'; }, 6, 'SESSION');

  // Retain EQH/EQL across their available freshness distribution.
  take(function (x) { return x.liquidityGroup === 'EQH/EQL' && x.sourceType === 'EQH' && x.freshnessBand === '>24h'; }, 2, 'EQH >24h');
  take(function (x) { return x.liquidityGroup === 'EQH/EQL' && x.sourceType === 'EQH' && x.freshnessBand === '<=30m'; }, 1, 'EQH <=30m');
  take(function (x) { return x.liquidityGroup === 'EQH/EQL' && x.sourceType === 'EQH' && x.freshnessBand === '30m-2h'; }, 1, 'EQH 30m-2h');
  ['<=30m', '30m-2h', '2h-8h', '>24h'].forEach(function (band) {
    take(function (x) { return x.liquidityGroup === 'EQH/EQL' && x.sourceType === 'EQL' && x.freshnessBand === band; }, 1, 'EQL ' + band);
  });

  // SWING fill: exact direction and freshness quotas after preserving rare types.
  var swingPlan = {
    BEARISH: {'<=30m': 1, '30m-2h': 1, '2h-8h': 1, '8h-24h': 3, '>24h': 2},
    BULLISH: {'<=30m': 2, '30m-2h': 2, '2h-8h': 3, '8h-24h': 5, '>24h': 3}
  };
  Object.keys(swingPlan).forEach(function (direction) {
    Object.keys(swingPlan[direction]).forEach(function (band) {
      take(function (x) { return x.liquidityGroup === 'SWING' && x.direction === direction && x.freshnessBand === band; }, swingPlan[direction][band], 'SWING ' + direction + ' ' + band);
    });
  });
  return selectedRows.sort(function (a, b) { return a.notification.firstTouchAt - b.notification.firstTouchAt; });
}

function buildRecord(x, index) {
  var n = x.notification;
  var w = x.watch;
  var primary = w.liquidityTaken.primary;
  var touchIndex = candleIndexByClose[n.firstTouchAt];
  if (typeof touchIndex !== 'number') throw new Error('Missing FIRST_TOUCH candle ' + n.firstTouchAt);
  var sweepIndex = nearestIndex(primary.confirmedAt);
  var k1Index = nearestOpenIndex(w.nativeFvg.k1OpenTime);
  var startIndex = Math.max(0, Math.min(sweepIndex, k1Index) - 20);
  var formationCandles = candles.slice(startIndex, touchIndex + 1).filter(function (c) { return c.closeTime <= n.firstTouchAt; });
  var reviewId = 'DFNHFA-' + String(index + 1).padStart(2, '0');
  var chartName = reviewId.toLowerCase() + '.svg';
  var chartPath = path.join(CHARTS, chartName);
  var record = {
    reviewId: reviewId,
    notificationKey: n.notificationKey,
    direction: w.direction,
    watchDirection: w.watchDirection,
    sampling: {
      freshnessBand: x.freshnessBand,
      watchToFirstTouchMinutes: n.minutesFromWatchToTouch,
      liquidityGroup: x.liquidityGroup,
      primaryLiquidityType: primary.sourceType
    },
    firstTouchEvaluationTime: n.firstTouchAt,
    firstTouchEvaluationTimeIso: iso(n.firstTouchAt),
    primaryLiquidity: {
      sweepId: primary.id,
      sourceLiquidityId: primary.sourceId,
      sourceType: primary.sourceType,
      sourceTimeframe: primary.sourceTimeframe,
      side: primary.side,
      price: primary.sourcePrice,
      sweepConfirmedAt: primary.confirmedAt,
      sweepConfirmedAtIso: iso(primary.confirmedAt),
      relation: primary.relation,
      barsBeforeLegStart: primary.barsBeforeLegStart
    },
    owningDisplacement: {
      legId: w.displacementLegId,
      displacementIds: w.displacementIds,
      direction: w.displacement.direction,
      startIndex: w.displacement.startIndex,
      endIndex: w.displacement.endIndex,
      firstConfirmedAt: w.displacement.firstConfirmedAt,
      firstConfirmedAtIso: iso(w.displacement.firstConfirmedAt),
      lastConfirmedAt: w.displacement.lastConfirmedAt,
      lastConfirmedAtIso: iso(w.displacement.lastConfirmedAt),
      quality: w.displacement.quality,
      rangeAtr: w.displacement.rangeAtr
    },
    nativeFvg: compactFvg(w.nativeFvg),
    watch: {id: w.id, createdAt: w.createdAt, createdAtIso: iso(w.createdAt), stateAtTouch: w.state},
    firstTouch: {
      occurredAt: n.firstTouchAt,
      occurredAtIso: iso(n.firstTouchAt),
      price: w.firstTouchPrice,
      candle: compactCandle(candles[touchIndex])
    },
    mss: w.mss && w.mss.confirmedAt <= n.firstTouchAt ? w.mss : null,
    dailyBias: w.dailyBias || null,
    structuralContext: w.structuralProvenance || null,
    chart: {relativePath: 'charts/' + chartName, absolutePath: chartPath},
    formationCandles: formationCandles.map(compactCandle),
    formationCandleCount: formationCandles.length,
    formationEndsAtFirstTouch: true,
    outcomeIncluded: false,
    humanReview: {
      HUMAN_LIQUIDITY_VALID: null,
      HUMAN_DISPLACEMENT_VALID: null,
      HUMAN_NATIVE_FVG_VALID: null,
      HUMAN_NOTIFICATION_WORTHY: null,
      HUMAN_PRIMARY_REJECT_REASON: null,
      HUMAN_NOTES: '',
      allowedValues: {
        HUMAN_LIQUIDITY_VALID: ['YES', 'NO', 'UNCLEAR'],
        HUMAN_DISPLACEMENT_VALID: ['YES', 'NO', 'UNCLEAR'],
        HUMAN_NATIVE_FVG_VALID: ['YES', 'NO', 'UNCLEAR'],
        HUMAN_NOTIFICATION_WORTHY: ['YES', 'NO', 'UNCLEAR'],
        HUMAN_PRIMARY_REJECT_REASON: [null, 'LIQUIDITY', 'DISPLACEMENT', 'FVG', 'STALE', 'MARKET_CONTEXT', 'OTHER']
      }
    }
  };
  fs.writeFileSync(chartPath, renderChart(record));
  return record;
}

function validateFutureSafety(records) {
  var violations = [];
  records.forEach(function (r) {
    var t = r.firstTouchEvaluationTime;
    r.formationCandles.forEach(function (c) { if (c.closeTime > t) violations.push({reviewId: r.reviewId, field: 'formationCandle.closeTime', actual: c.closeTime, limit: t}); });
    if (r.primaryLiquidity.sweepConfirmedAt > t) violations.push({reviewId: r.reviewId, field: 'sweepConfirmedAt'});
    if (r.nativeFvg.confirmedAt > t) violations.push({reviewId: r.reviewId, field: 'nativeFvg.confirmedAt'});
    if (r.watch.createdAt > t) violations.push({reviewId: r.reviewId, field: 'watch.createdAt'});
    if (r.mss && r.mss.confirmedAt > t) violations.push({reviewId: r.reviewId, field: 'mss.confirmedAt'});
    ['latestProtectedHigh', 'latestProtectedLow'].forEach(function (key) {
      var level = r.structuralContext && r.structuralContext[key];
      if (level && level.confirmedAt > t) violations.push({reviewId: r.reviewId, field: 'structuralContext.' + key + '.confirmedAt'});
      if (level && level.protectedConfirmedAt > t) violations.push({reviewId: r.reviewId, field: 'structuralContext.' + key + '.protectedConfirmedAt'});
    });
  });
  return violations;
}

function summarize(records) {
  var direction = countBy(records, function (r) { return r.direction === 'BULLISH' ? 'LONG' : 'SHORT'; });
  var freshness = countBy(records, function (r) { return r.sampling.freshnessBand; });
  var group = countBy(records, function (r) { return r.sampling.liquidityGroup; });
  var sourceType = countBy(records, function (r) { return r.sampling.primaryLiquidityType; });
  return {direction: direction, primaryLiquidityGroup: group, primaryLiquidityType: sourceType, freshness: freshness};
}

function renderChart(r) {
  var cs = r.formationCandles;
  var width = 1600, height = 720, left = 92, right = 24, top = 84, bottom = 66;
  var plotW = width - left - right, plotH = height - top - bottom;
  var prices = [];
  cs.forEach(function (c) { prices.push(c.low, c.high); });
  prices.push(r.primaryLiquidity.price, r.nativeFvg.low, r.nativeFvg.high);
  var min = Math.min.apply(Math, prices), max = Math.max.apply(Math, prices), pad = Math.max((max - min) * 0.06, 1);
  min -= pad; max += pad;
  var x = function (i) { return left + (i + 0.5) * plotW / cs.length; };
  var y = function (p) { return top + (max - p) / (max - min) * plotH; };
  var barW = Math.max(0.7, Math.min(8, plotW / cs.length * 0.68));
  var parts = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
  parts.push('<rect width="100%" height="100%" fill="#0b1020"/>');
  parts.push('<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;fill:#dbe7ff}.grid{stroke:#26324b;stroke-width:1}.axis{font-size:12px}.label{font-size:13px;font-weight:600}.small{font-size:11px}</style>');
  parts.push('<text x="24" y="30" font-size="18" font-weight="700">' + esc(r.reviewId + ' · BTCUSDT 5m · ' + r.direction + ' · ' + r.sampling.primaryLiquidityType + ' · ' + r.sampling.freshnessBand) + '</text>');
  parts.push('<text x="24" y="55" class="small">Formation only · ends at FIRST_TOUCH ' + esc(formatCst(r.firstTouchEvaluationTime)) + ' · candles=' + cs.length + '</text>');
  for (var g = 0; g <= 5; g++) {
    var gp = min + (max - min) * g / 5, gy = y(gp);
    parts.push('<line class="grid" x1="' + left + '" y1="' + gy + '" x2="' + (width - right) + '" y2="' + gy + '"/>');
    parts.push('<text class="axis" x="' + (left - 8) + '" y="' + (gy + 4) + '" text-anchor="end">' + gp.toFixed(1) + '</text>');
  }
  var fvgStart = findCandleIndex(cs, r.nativeFvg.k3OpenTime, 'openTime');
  var touchIdx = cs.length - 1;
  if (fvgStart >= 0) parts.push('<rect x="' + (x(fvgStart) - barW) + '" y="' + y(r.nativeFvg.high) + '" width="' + (x(touchIdx) - x(fvgStart) + barW * 2) + '" height="' + Math.max(2, y(r.nativeFvg.low) - y(r.nativeFvg.high)) + '" fill="#f2c94c" fill-opacity="0.18" stroke="#f2c94c" stroke-width="1.5"/>');
  cs.forEach(function (c, i) {
    var bullish = c.close >= c.open, color = bullish ? '#35d07f' : '#ff647c';
    parts.push('<line x1="' + x(i) + '" y1="' + y(c.high) + '" x2="' + x(i) + '" y2="' + y(c.low) + '" stroke="' + color + '" stroke-width="1"/>');
    parts.push('<rect x="' + (x(i) - barW / 2) + '" y="' + Math.min(y(c.open), y(c.close)) + '" width="' + barW + '" height="' + Math.max(1, Math.abs(y(c.open) - y(c.close))) + '" fill="' + color + '"/>');
  });
  parts.push('<line x1="' + left + '" y1="' + y(r.primaryLiquidity.price) + '" x2="' + (width - right) + '" y2="' + y(r.primaryLiquidity.price) + '" stroke="#52a7ff" stroke-width="1.5" stroke-dasharray="7 5"/>');
  parts.push('<text class="label" x="' + (left + 8) + '" y="' + (y(r.primaryLiquidity.price) - 7) + '" fill="#52a7ff">' + esc(r.sampling.primaryLiquidityType + ' ' + r.primaryLiquidity.price) + '</text>');
  marker(parts, cs, r.primaryLiquidity.sweepConfirmedAt, 'closeTime', x, top, plotH, '#52a7ff', 'SWEEP', 0);
  marker(parts, cs, r.watch.createdAt, 'closeTime', x, top, plotH, '#ff9f43', 'WATCH', 1);
  marker(parts, cs, r.firstTouchEvaluationTime, 'closeTime', x, top, plotH, '#ff4d6d', 'FIRST_TOUCH', 2);
  if (r.mss) marker(parts, cs, r.mss.confirmedAt, 'closeTime', x, top, plotH, '#b984ff', 'MSS', 3);
  [['K1', r.nativeFvg.k1OpenTime], ['K2/DISP', r.nativeFvg.k2OpenTime], ['K3', r.nativeFvg.k3OpenTime]].forEach(function (kv, j) {
    var i = findCandleIndex(cs, kv[1], 'openTime');
    if (i >= 0) parts.push('<text class="small" x="' + x(i) + '" y="' + (top + 16 + j * 14) + '" text-anchor="middle" fill="#f2c94c">' + kv[0] + '</text>');
  });
  var ticks = Math.min(8, cs.length);
  for (var ti = 0; ti < ticks; ti++) {
    var ci = Math.round(ti * (cs.length - 1) / Math.max(1, ticks - 1));
    parts.push('<text class="axis" x="' + x(ci) + '" y="' + (height - 28) + '" text-anchor="middle">' + esc(formatShortCst(cs[ci].closeTime)) + '</text>');
  }
  parts.push('<text class="small" x="' + left + '" y="' + (height - 8) + '">Bias=' + esc(String((r.dailyBias || {}).bias || 'UNKNOWN')) + ' · Structure=' + esc(String((r.structuralContext || {}).structuralState || 'UNKNOWN')) + ' · MSS=' + esc(r.mss ? r.mss.direction + '/' + r.mss.referenceRole : 'none') + '</text>');
  parts.push('</svg>');
  return parts.join('\n');
}

function marker(parts, cs, time, field, x, top, plotH, color, label, row) {
  var i = findCandleIndex(cs, time, field);
  if (i < 0) return;
  var px = x(i), anchor = px > 1460 ? 'end' : (px < 180 ? 'start' : 'middle');
  var tx = anchor === 'end' ? px - 4 : (anchor === 'start' ? px + 4 : px);
  var ty = top + plotH - 8 - row * 16;
  parts.push('<line x1="' + px + '" y1="' + top + '" x2="' + px + '" y2="' + (top + plotH) + '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="4 4"/>');
  parts.push('<text class="label" x="' + tx + '" y="' + ty + '" text-anchor="' + anchor + '" fill="' + color + '">' + label + '</text>');
}

function renderIndex(records, summary) {
  var cards = records.map(function (r) {
    return '<section><h2>' + esc(r.reviewId + ' · ' + r.direction + ' · ' + r.sampling.primaryLiquidityType + ' · ' + r.sampling.freshnessBand) + '</h2>' +
      '<img loading="lazy" src="' + esc(r.chart.relativePath) + '" alt="' + esc(r.reviewId + ' formation chart') + '">' +
      '<pre>HUMAN_LIQUIDITY_VALID: [ ] YES  [ ] NO  [ ] UNCLEAR\nHUMAN_DISPLACEMENT_VALID: [ ] YES  [ ] NO  [ ] UNCLEAR\nHUMAN_NATIVE_FVG_VALID: [ ] YES  [ ] NO  [ ] UNCLEAR\nHUMAN_NOTIFICATION_WORTHY: [ ] YES  [ ] NO  [ ] UNCLEAR\nHUMAN_PRIMARY_REJECT_REASON: ____________________\nHUMAN_NOTES:\n</pre></section>';
  }).join('\n');
  return '<!doctype html><meta charset="utf-8"><title>DFNHFA V1</title><style>body{font-family:system-ui;background:#090e1a;color:#e8eefc;margin:24px}header{max-width:1200px;margin:auto}section{max-width:1600px;margin:36px auto 72px;border-top:1px solid #334;padding-top:20px}img{width:100%;height:auto;background:#0b1020}pre{font-size:14px;line-height:1.7;background:#11192b;padding:16px;white-space:pre-wrap}code{color:#9fd3ff}</style><header><h1>Displacement FVG Notification Human Formation Audit V1</h1><p>Formation only. Every chart ends at its FIRST_TOUCH evaluationTime. Outcome is excluded.</p><code>' + esc(JSON.stringify(summary.formationPopulation)) + '</code></header>' + cards;
}

function renderReport(s) {
  return ['# Displacement FVG Notification Human Formation Audit V1', '', '- Source notifications: ' + s.sourceNotificationPopulation, '- Human review records: ' + s.sampleCount, '- Sampling seed: `' + s.deterministicSamplingSeed + '`', '', '## Formation population', '', '```json', JSON.stringify(s.formationPopulation, null, 2), '```', '', 'PRODUCTION_CHANGED = ' + s.invariants.PRODUCTION_CHANGED, '', 'FUTURE_LEAK_VIOLATIONS = ' + s.invariants.FUTURE_LEAK_VIOLATIONS, '', 'OUTCOME_USED = false', ''].join('\n');
}

function liquidityGroup(t) {
  t = String(t || '').toUpperCase();
  if (/^SWING_(HIGH|LOW)$/.test(t)) return 'SWING';
  if (t === 'EQH' || t === 'EQL') return 'EQH/EQL';
  if (t === 'PDH' || t === 'PDL') return 'PDH/PDL';
  if (/^(ASIA|LONDON|NEW_YORK)_(HIGH|LOW)$/.test(t)) return 'SESSION';
  return 'OTHER';
}
function freshnessBand(m) { return m <= 30 ? '<=30m' : m <= 120 ? '30m-2h' : m <= 480 ? '2h-8h' : m <= 1440 ? '8h-24h' : '>24h'; }
function byHash(a, b) { return sha(SEED + '|' + a.notification.notificationKey).localeCompare(sha(SEED + '|' + b.notification.notificationKey)); }
function compactFvg(f) { return {id: f.id, displacementEventId: f.displacementEventId, direction: f.direction, low: f.low, high: f.high, midpoint: f.midpoint, k1OpenTime: f.k1OpenTime, k1OpenTimeIso: iso(f.k1OpenTime), k2OpenTime: f.k2OpenTime, k2OpenTimeIso: iso(f.k2OpenTime), k3OpenTime: f.k3OpenTime, k3OpenTimeIso: iso(f.k3OpenTime), confirmedAt: f.confirmedAt, confirmedAtIso: iso(f.confirmedAt)}; }
function compactCandle(c) { return {openTime: c.openTime, openTimeIso: iso(c.openTime), closeTime: c.closeTime, closeTimeIso: iso(c.closeTime), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closed: c.closed, source: c.source}; }
function countBy(rows, fn) { var out = {}; rows.forEach(function (r) { var k = fn(r); out[k] = (out[k] || 0) + 1; }); return out; }
function indexBy(rows, key) { var out = {}; rows.forEach(function (r) { out[r[key]] = r; }); return out; }
function findCandleIndex(cs, value, field) { for (var i = 0; i < cs.length; i++) if (cs[i][field] === value) return i; return -1; }
function nearestIndex(closeTime) { if (typeof candleIndexByClose[closeTime] === 'number') return candleIndexByClose[closeTime]; var best = 0, distance = Infinity; candles.forEach(function (c, i) { var d = Math.abs(c.closeTime - closeTime); if (d < distance) { distance = d; best = i; } }); return best; }
function nearestOpenIndex(openTime) { for (var i = 0; i < candles.length; i++) if (candles[i].openTime === openTime) return i; return nearestIndex(openTime + 299999); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hashes(files) { var out = {}; files.forEach(function (f) { out[f] = sha(fs.readFileSync(path.join(ROOT, f))); }); return out; }
function iso(t) { return typeof t === 'number' ? new Date(t).toISOString() : null; }
function formatCst(t) { return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(new Date(t)) + ' UTC+8'; }
function formatShortCst(t) { return new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(t)); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function load5mCandles() {
  var dir = path.join(ROOT, 'data-cache');
  var byOpen = {};
  fs.readdirSync(dir).filter(function (f) { return f.indexOf(SYMBOL + '_5m_') === 0 && /\.json$/.test(f); }).forEach(function (f) {
    var rows;
    try { rows = readJson(path.join(dir, f)); } catch (error) { return; }
    (rows || []).forEach(function (c) {
      if (c && c.source === 'futures' && c.closed !== false && c.closeTime >= ENGINE_START && c.closeTime <= END) byOpen[c.openTime] = c;
    });
  });
  return Object.keys(byOpen).map(function (k) { return byOpen[k]; }).sort(function (a, b) { return a.openTime - b.openTime; });
}
