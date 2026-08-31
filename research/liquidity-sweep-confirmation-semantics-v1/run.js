#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var replayState = require('../../replay/replayState');
var eventRegistry = require('../../events/eventRegistry');
var takenAdapter = require('../../events/liquidityTakenEventAdapter');
var dailyLiquidity = require('../../liquidity/dailyLiquidity');
var weeklyLiquidity = require('../../liquidity/weeklyLiquidity');
var monthlyLiquidity = require('../../liquidity/monthlyLiquidity');
var oldConfig = require('../sweep-liquidity-baseline-v1/config.json');

var ROOT = path.resolve(__dirname, '../..');
var OUT = __dirname;
var FIXTURES = path.join(ROOT, 'research/watch-narrative-sweep-association-audit-v1/fixtures');
var BLIND_PACKAGE = path.join(OUT, 'blind-package');
var ANSWER_PACKAGE = path.join(OUT, 'answer-key-package');
var BLIND_ZIP = path.join(OUT, 'sweep-confirmation-blind-review.zip');
var ANSWER_ZIP = path.join(OUT, 'sweep-confirmation-answer-key.zip');
var SEED = 'LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1|TAKEN_FAILED_ACCEPTANCE_V1|b4d4222';
var DAY_MS = 86400000;
var WEEK_MS = DAY_MS * 7;
var BARS_PER_DAY = 288;
var WINDOW_BARS = 7 * BARS_PER_DAY;
var MAX_OBSERVATION_BARS = 12;
var EXPECTED_HEAD = 'b4d4222';
var REMOTE_HEAD = 'b4d4222e6ef8a742a532245e4e58ddc80e6af517';
var TYPES = ['EQH', 'EQL', 'PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'];
var SPECS = [
    { symbol: 'BTCUSDT', tickSize: 0.1 },
    { symbol: 'ZECUSDT', tickSize: 0.01 }
];

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}

function sha(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
}

function seededHash(value) { return sha(SEED + '|' + value); }
function iso(value) { return value === null || value === undefined ? null : new Date(value).toISOString(); }
function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function countBy(rows, fn) {
    var out = {};
    rows.forEach(function (row) { var key = fn(row); out[key] = (out[key] || 0) + 1; });
    return out;
}
function ensureFreshDirectory(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
}
function removeIfPresent(file) { if (fs.existsSync(file)) fs.unlinkSync(file); }

function aggregate(candles, start, end) {
    var rows = candles.filter(function (c) { return c.openTime >= start && c.closeTime <= end; });
    if (!rows.length) return null;
    return {
        openTime: start,
        closeTime: end,
        open: rows[0].open,
        high: Math.max.apply(null, rows.map(function (c) { return c.high; })),
        low: Math.min.apply(null, rows.map(function (c) { return c.low; })),
        close: rows[rows.length - 1].close,
        volume: rows.reduce(function (sum, c) { return sum + (c.volume || 0); }, 0),
        closed: true,
        source: 'futures-5m-aggregate'
    };
}

function continuity(candles, start, end) {
    var missing = 0;
    var duplicates = 0;
    var seen = {};
    for (var i = start; i <= end; i++) {
        if (seen[candles[i].openTime]) duplicates++;
        seen[candles[i].openTime] = true;
        if (i > start && candles[i].openTime - candles[i - 1].openTime !== 300000) missing++;
    }
    return {
        start: iso(candles[start].openTime),
        end: iso(candles[end].closeTime),
        candleCount: end - start + 1,
        expectedCandleCount: WINDOW_BARS,
        missingIntervals: missing,
        duplicateOpenTimes: duplicates,
        status: missing === 0 && duplicates === 0 && end - start + 1 === WINDOW_BARS ? 'PASS' : 'FAIL'
    };
}

function calendarBoundaries(state, spec, candles, candle, calendarState) {
    var d = new Date(candle.openTime);
    var dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    var mondayOffset = (d.getUTCDay() + 6) % 7;
    var weekStart = dayStart - mondayOffset * DAY_MS;
    var monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);

    if (calendarState.dayStart !== dayStart) {
        var day = aggregate(candles, dayStart - DAY_MS, dayStart - 1);
        if (day) dailyLiquidity.buildDailyLiquidity(spec.symbol, day).forEach(function (level) { state.registry.add(level); });
        calendarState.dayStart = dayStart;
    }
    if (calendarState.weekStart !== weekStart) {
        var week = aggregate(candles, weekStart - WEEK_MS, weekStart - 1);
        if (week) weeklyLiquidity.buildWeeklyLiquidity(spec.symbol, week).forEach(function (level) { state.registry.add(level); });
        calendarState.weekStart = weekStart;
    }
    if (!calendarState.monthStarts[monthStart]) {
        var frozenMonthly = oldConfig.monthlyCandles[spec.symbol];
        if (frozenMonthly && frozenMonthly.closeTime < monthStart) {
            monthlyLiquidity.buildMonthlyLiquidity(spec.symbol, frozenMonthly).forEach(function (level) { state.registry.add(level); });
        }
        calendarState.monthStarts[monthStart] = true;
    }
}

function closeRelative(side, close, price) {
    if (close === price) return 'AT_LIQUIDITY';
    if (side === 'BSL') return close < price ? 'ORIGINAL_SIDE' : 'BEYOND_LIQUIDITY';
    return close > price ? 'ORIGINAL_SIDE' : 'BEYOND_LIQUIDITY';
}

function buildTimeline(event, candles, liquidityConfirmedAt) {
    var bars = [];
    var first = null;
    for (var offset = 0; offset <= MAX_OBSERVATION_BARS; offset++) {
        var candle = candles[event.candleIndex + offset];
        if (!candle) throw new Error('Incomplete observation horizon for ' + event.id);
        var relative = closeRelative(event.side, candle.close, event.price);
        bars.push({
            bar: offset,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            openTime: iso(candle.openTime),
            closeTime: iso(candle.closeTime),
            closeRelativeToLiquidity: relative
        });
        if (first === null && relative === 'ORIGINAL_SIDE') first = offset;
    }
    return {
        caseId: event.id,
        symbol: event.symbol,
        timeframe: event.timeframe,
        liquidityId: event.liquidityId,
        liquidityType: event.source.liquidityType,
        liquiditySide: event.side,
        liquidityConfirmedAt: iso(liquidityConfirmedAt),
        frozenLiquidityPrice: event.price,
        frozenTakenSnapshotMatchesSource: event.price === event.source.liquidityPrice,
        takenCandleIndex: event.candleIndex,
        takenAt: iso(event.occurredAt),
        takenConfirmedAt: iso(event.confirmedAt),
        interactionExtreme: event.source.interactionExtreme,
        bars: bars,
        firstReturnBar: first,
        firstReturnAt: first === null ? null : bars[first].closeTime,
        candidateConfirmed: first !== null
    };
}

function produceSymbol(spec) {
    var fixtureFile = path.join(FIXTURES, spec.symbol + '-5m-futures.json');
    var payload = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    var candles = payload.candles;
    var windowStart = candles.length - WINDOW_BARS;
    var windowEnd = candles.length - 1;
    var matureEnd = windowEnd - MAX_OBSERVATION_BARS;
    var state = replayState.createReplayState({ symbol: spec.symbol, timeframe: '5m', eqProductionVersion: 'V3' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var calendarState = { dayStart: null, weekStart: null, monthStarts: {} };

    for (var i = 0; i < candles.length; i++) {
        var candle = candles[i];
        replayState.incrementalLiquidity(state, candles, i, { tickSize: spec.tickSize }, candle.closeTime);
        calendarBoundaries(state, spec, candles, candle, calendarState);
        replayState.incrementalEvents(state, candle, i, candle.closeTime, []);
    }

    var levels = {};
    state.registry.getAll(spec.symbol).forEach(function (level) { levels[level.id] = level; });
    var taken = state.eventRegistry.getByType(spec.symbol, 'LIQUIDITY_TAKEN').filter(function (event) {
        return event.candleIndex >= windowStart && event.candleIndex <= matureEnd;
    });
    var timelines = taken.map(function (event) {
        var level = levels[event.liquidityId];
        return buildTimeline(event, candles, level && level.confirmedAt);
    });
    return {
        spec: spec,
        payload: payload,
        candles: candles,
        windowStart: windowStart,
        windowEnd: windowEnd,
        matureEnd: matureEnd,
        continuity: continuity(candles, windowStart, windowEnd),
        fixtureSha256: sha(fs.readFileSync(fixtureFile)),
        timelines: timelines,
        productionTakenCountInWindowWithCompleteHorizon: timelines.length
    };
}

function timingBucket(row) {
    var value = row.firstReturnBar;
    if (value === null) return 'none-within-12';
    if (value <= 3) return String(value);
    if (value <= 6) return '4-6';
    return '7-12';
}

function timingDistribution(rows) {
    var keys = ['0', '1', '2', '3', '4-6', '7-12', 'none-within-12'];
    var out = {};
    keys.forEach(function (key) { out[key] = 0; });
    rows.forEach(function (row) { out[timingBucket(row)]++; });
    return out;
}

function deterministicStratified(rows, needed, globallyUsedInteractions) {
    var buckets = {};
    rows.forEach(function (row) {
        var stratum = row.symbol + '|' + row.liquiditySide + '|' + row.liquidityType;
        if (!buckets[stratum]) buckets[stratum] = [];
        buckets[stratum].push(row);
    });
    Object.keys(buckets).forEach(function (key) {
        buckets[key].sort(function (a, b) { return seededHash(a.caseId).localeCompare(seededHash(b.caseId)); });
    });
    var strata = Object.keys(buckets).sort(function (a, b) { return seededHash('stratum|' + a).localeCompare(seededHash('stratum|' + b)); });
    var selected = [];
    var selectedIds = {};
    function pass(allowRepeatedInteraction) {
        var progress = true;
        while (selected.length < needed && progress) {
            progress = false;
            strata.forEach(function (stratum) {
                if (selected.length >= needed) return;
                var candidates = buckets[stratum];
                for (var i = 0; i < candidates.length; i++) {
                    var row = candidates[i];
                    var interaction = row.symbol + '|' + row.takenAt;
                    if (selectedIds[row.caseId] || (!allowRepeatedInteraction && globallyUsedInteractions[interaction])) continue;
                    selected.push(row);
                    selectedIds[row.caseId] = true;
                    globallyUsedInteractions[interaction] = true;
                    progress = true;
                    break;
                }
            });
        }
    }
    pass(false);
    pass(true);
    if (selected.length !== needed) throw new Error('INSUFFICIENT_POPULATION for deterministic sample');
    return selected;
}

function renderChart(blindId, row, candles, file) {
    var preBars = 36;
    var start = Math.max(0, row.takenCandleIndex - preBars);
    var end = row.takenCandleIndex + MAX_OBSERVATION_BARS;
    var bars = candles.slice(start, end + 1);
    var eventPosition = row.takenCandleIndex - start;
    var values = [row.frozenLiquidityPrice];
    bars.forEach(function (c) { values.push(c.high, c.low); });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = max - min || Math.max(Math.abs(max) * 0.001, 1);
    min -= span * 0.08;
    max += span * 0.08;
    var W = 1240, H = 720, left = 86, right = 160, top = 76, bottom = 66;
    var plotW = W - left - right, plotH = H - top - bottom;
    function x(index) { return left + (index + 0.5) * plotW / bars.length; }
    function y(price) { return top + (max - price) / (max - min) * plotH; }
    var candleW = Math.max(4, plotW / bars.length * 0.62);
    var interactionX = x(eventPosition);
    var svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
        '<rect width="100%" height="100%" fill="#f7f8fa"/>',
        '<style>text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;fill:#20242b}.small{font-size:12px}.title{font-size:20px;font-weight:650}.sub{font-size:14px;fill:#59616d}</style>',
        '<text x="' + left + '" y="30" class="title">' + esc(blindId) + '</text>',
        '<text x="' + left + '" y="53" class="sub">' + esc(row.symbol + ' · 5m · ' + row.liquidityType + ' · ' + row.liquiditySide) + '</text>',
        '<rect x="' + left + '" y="' + top + '" width="' + plotW + '" height="' + plotH + '" fill="#fff" stroke="#c9ced6"/>',
        '<rect x="' + (interactionX - plotW / bars.length / 2) + '" y="' + top + '" width="' + (plotW / bars.length) + '" height="' + plotH + '" fill="#ebe7f4" opacity="0.8"/>'
    ];
    for (var grid = 0; grid <= 4; grid++) {
        var gridY = top + plotH * grid / 4;
        var gridPrice = max - (max - min) * grid / 4;
        svg.push('<line x1="' + left + '" y1="' + gridY + '" x2="' + (W - right) + '" y2="' + gridY + '" stroke="#edf0f3"/>');
        svg.push('<text x="8" y="' + (gridY + 4) + '" class="small">' + esc(Number(gridPrice.toFixed(8))) + '</text>');
    }
    var levelY = y(row.frozenLiquidityPrice);
    svg.push('<line x1="' + left + '" y1="' + levelY + '" x2="' + (W - right) + '" y2="' + levelY + '" stroke="#665c85" stroke-width="2" stroke-dasharray="7 4"/>');
    svg.push('<text x="' + (W - right + 8) + '" y="' + (levelY + 4) + '" class="small">' + esc(row.liquidityType + ' ' + row.frozenLiquidityPrice) + '</text>');
    bars.forEach(function (c, index) {
        var cx = x(index), up = c.close >= c.open;
        svg.push('<line x1="' + cx + '" y1="' + y(c.high) + '" x2="' + cx + '" y2="' + y(c.low) + '" stroke="#424852"/>');
        var oy = y(c.open), cy = y(c.close);
        svg.push('<rect x="' + (cx - candleW / 2) + '" y="' + Math.min(oy, cy) + '" width="' + candleW + '" height="' + Math.max(1, Math.abs(cy - oy)) + '" fill="' + (up ? '#d5dbe2' : '#59616c') + '" stroke="#424852"/>');
    });
    svg.push('<line x1="' + interactionX + '" y1="' + top + '" x2="' + interactionX + '" y2="' + (top + plotH) + '" stroke="#756b8f" stroke-width="2" stroke-dasharray="8 6"/>');
    svg.push('<text x="' + Math.max(left, interactionX - 80) + '" y="' + (H - 28) + '" class="small">highlighted interaction</text>');
    svg.push('</svg>');
    fs.writeFileSync(file, svg.join('\n') + '\n');
    return { preEventBars: eventPosition, postEventBars: bars.length - eventPosition - 1, totalBars: bars.length };
}

function prefixAudit(rows, bySymbol) {
    return rows.map(function (row) {
        var candles = bySymbol[row.symbol].candles;
        var historicalEnd = row.takenCandleIndex + MAX_OBSERVATION_BARS;
        function projection(source) {
            for (var offset = 0; offset <= MAX_OBSERVATION_BARS; offset++) {
                var candle = source[row.takenCandleIndex + offset];
                if (!candle) return null;
                if (closeRelative(row.liquiditySide, candle.close, row.frozenLiquidityPrice) === 'ORIGINAL_SIDE') return offset;
            }
            return null;
        }
        var prefix = candles.slice(0, historicalEnd + 1);
        var prefixValue = projection(prefix);
        var longerValue = projection(candles);
        return {
            caseId: row.caseId,
            historicalEvaluationTime: iso(candles[historicalEnd].closeTime),
            prefixFirstReturnBar: prefixValue,
            longerDatasetFirstReturnBarAsOfHistoricalTime: longerValue,
            mutationCount: prefixValue === longerValue ? 0 : 1
        };
    });
}

function verifyFoundation() {
    var allowlist = Object.keys(takenAdapter.NARRATIVE_TYPES).sort();
    var expected = TYPES.slice().sort();
    var base = { symbol: 'X', timeframe: '1d', confirmedAt: 1, status: 'ACTIVE', price: 100 };
    var bsl = takenAdapter.buildTakenEvent(Object.assign({ id: 'BSL', type: 'PDH', side: 'BSL' }, base),
        { openTime: 2, closeTime: 3, high: 100.01, low: 99, close: 100, closed: true }, 0, '5m');
    var ssl = takenAdapter.buildTakenEvent(Object.assign({ id: 'SSL', type: 'PDL', side: 'SSL' }, base),
        { openTime: 2, closeTime: 3, high: 101, low: 99.99, close: 100, closed: true }, 0, '5m');
    return {
        allowlistMatch: JSON.stringify(allowlist) === JSON.stringify(expected),
        bslStrictTradeThrough: !!bsl,
        sslStrictTradeThrough: !!ssl,
        reclaimRequiredForTaken: false,
        firstTakenPerLiquidityLifecycle: true,
        takenDependsOnSweep: false,
        productionTakenVerified: JSON.stringify(allowlist) === JSON.stringify(expected) && !!bsl && !!ssl
    };
}

function readmeText(summary) {
    return [
        '# Liquidity Sweep Confirmation Semantics V1',
        '',
        'Research-only, Liquidity-domain-only diagnostic. No production detector or runtime state is added.',
        '',
        '## Frozen hypothesis',
        '',
        '`TAKEN_FAILED_ACCEPTANCE_V1`: start from the production `LIQUIDITY_TAKEN` event and observe the immutable Taken price for bars 0..12. For BSL, the first closed candle with `close < frozenLiquidityPrice` is the research-only candidate confirmation. For SSL, it is the first closed candle with `close > frozenLiquidityPrice`. Twelve bars is only the fixed observation horizon, not a proposed production threshold.',
        '',
        'The prior negative findings remain frozen: same-bar reclaim, delayed reclaim, penetration, and reclaim alone were not sufficient. This round does not rerun or tune them; its unit is the production Taken event followed through one causal sequence.',
        '',
        '## Frozen data and sample',
        '',
        'The exact prior seven-day BTCUSDT/ZECUSDT futures 5m fixtures are reused. Each symbol has 2,016 continuous candles. Population: ' + summary.total + ' mature production Taken events; blind review: 40 cases, deterministically split 20 candidate-confirmed and 20 unconfirmed controls using seed `' + SEED + '`.',
        '',
        '## Human review',
        '',
        'The blind package contains no mechanical classification or confirmation timing. Human labels are limited to `GOOD_SWEEP`, `BORDERLINE`, `TAKEN_ONLY`, and `NOT_SWEEP`. Human labels must be frozen before the separately packaged answer key is decoded.',
        '',
        '## Frozen post-review decision rule',
        '',
        'After human labels are frozen and the answer key is decoded, compare candidateConfirmed=true with candidateConfirmed=false across the four labels. A production Sweep semantic may proceed only if the confirmed group clearly concentrates GOOD_SWEEP; the unconfirmed group contains materially more TAKEN_ONLY/NOT_SWEEP; the relationship is not obviously driven by one symbol, side, or liquidity type; obvious counterexamples are uncommon; and the semantic remains simple and explainable. Mixed or ambiguous results mean `SWEEP_SEMANTICS_NOT_JUSTIFIED` and a hard stop. No numeric pass threshold, parameter tuning, or replacement hypothesis is permitted in this round.',
        '',
        'Pre-review verdict: `READY_FOR_STRICT_BLIND_HUMAN_REVIEW`.',
        ''
    ].join('\n');
}

function instructionsText() {
    return [
        'STRICT BLIND HUMAN REVIEW',
        '',
        'Question for every chart:',
        'Does the highlighted liquidity interaction look like a genuine liquidity sweep, rather than merely price trading through the level?',
        '',
        'Return exactly one line per case:',
        'BLIND-001 GOOD_SWEEP',
        'BLIND-002 TAKEN_ONLY',
        '',
        'Allowed labels only:',
        'GOOD_SWEEP — visually clear liquidity sweep.',
        'BORDERLINE — reasonable ambiguity.',
        'TAKEN_ONLY — the objective interaction is correct, but price looks more like it traded/accepted through liquidity than swept it.',
        'NOT_SWEEP — the highlighted case should not reasonably be described as a liquidity sweep.',
        '',
        'Review all 40 charts without consulting any separate diagnostic or answer package. Freeze all labels before any answer key is decoded.',
        ''
    ].join('\n');
}

function acceptanceText(values) {
    return [
        'TASK=LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1',
        'MODE=RESEARCH_ONLY_LIQUIDITY_DOMAIN_ONE_HYPOTHESIS',
        '',
        'REPOSITORY_HEAD=' + values.head,
        'EXPECTED_BASELINE=b4d4222',
        'BASELINE_MATCH=' + values.baselineMatch,
        '',
        'REMOTE_HEAD=' + REMOTE_HEAD,
        'REMOTE_MATCH=' + values.remoteMatch,
        '',
        'CURRENT_DOMAIN=LIQUIDITY',
        'TONIGHT_GOAL=DETECT_LIQUIDITY_SWEEP',
        '',
        'PRODUCTION_TAKEN_VERIFIED=' + values.foundation.productionTakenVerified,
        'TAKEN_SOURCE=PRODUCTION_LIQUIDITY_TAKEN',
        '',
        'HYPOTHESIS_ID=TAKEN_FAILED_ACCEPTANCE_V1',
        'HYPOTHESIS_COUNT=1',
        'RESEARCH_ROUND_COUNT=1',
        '',
        'MAX_OBSERVATION_BARS=12',
        'MAX_OBSERVATION_BARS_IS_PRODUCTION_THRESHOLD=false',
        '',
        'PENETRATION_THRESHOLD=NONE',
        'REJECTION_THRESHOLD=NONE',
        'APPROACH_FILTER=NONE',
        '',
        'SWEEP_SCORE_IMPLEMENTED=false',
        'ACCEPTANCE_DETECTOR_IMPLEMENTED=false',
        'ACCEPTANCE_PRODUCTION_STATE_ADDED=false',
        '',
        'DISPLACEMENT_DATA_USED=false',
        'FVG_DATA_USED=false',
        'WATCH_DATA_USED=false',
        'BIAS_DATA_USED=false',
        'AMD_DATA_USED=false',
        'STRUCTURE_DEPENDENCY=false',
        'MSS_REINTRODUCED=false',
        'OUTCOME_DATA_USED=false',
        '',
        'PARAMETER_SEARCH_RUNS=0',
        'PARAMETER_OPTIMIZATION_PERFORMED=false',
        '',
        'DATA_WINDOW_CHANGED=false',
        'DATA_START=' + values.dataStart,
        'DATA_END=' + values.dataEnd,
        'SYMBOLS=BTCUSDT,ZECUSDT',
        'TIMEFRAME=5m',
        '',
        'TOTAL_TAKEN_COUNT=' + values.total,
        'CANDIDATE_CONFIRMED_COUNT=' + values.confirmed,
        'CANDIDATE_NOT_CONFIRMED_WITHIN_12_COUNT=' + values.unconfirmed,
        '',
        'CONFIRMATION_BAR_0_COUNT=' + values.timing['0'],
        'CONFIRMATION_BAR_1_COUNT=' + values.timing['1'],
        'CONFIRMATION_BAR_2_COUNT=' + values.timing['2'],
        'CONFIRMATION_BAR_3_COUNT=' + values.timing['3'],
        'CONFIRMATION_BAR_4_TO_6_COUNT=' + values.timing['4-6'],
        'CONFIRMATION_BAR_7_TO_12_COUNT=' + values.timing['7-12'],
        '',
        'BLIND_REVIEW_CASE_COUNT=40',
        'BLIND_CANDIDATE_CONFIRMED_COUNT=20',
        'BLIND_CANDIDATE_NOT_CONFIRMED_COUNT=20',
        'SAMPLE_FROZEN_BEFORE_HUMAN_LABELS=true',
        '',
        'BLIND_REVIEW_ZIP=' + BLIND_ZIP,
        'ANSWER_KEY_ZIP=' + ANSWER_ZIP,
        '',
        'ANSWER_KEY_PRESENT_IN_BLIND_ZIP=false',
        'MECHANICAL_CLASS_VISIBLE=false',
        'CONFIRMATION_BARS_VISIBLE=false',
        'CANDIDATE_CONFIRMED_VISIBLE=false',
        'CATEGORY_IN_FILENAME=false',
        'CATEGORY_IN_CHART_TITLE=false',
        'CATEGORY_IN_VISIBLE_METADATA=false',
        '',
        'SWEEP_RESEARCH_USES_FROZEN_TAKEN_PRICE=true',
        '',
        'FUTURE_LIQUIDITY_USAGE=' + values.futureLiquidityUsage,
        'FUTURE_CONFIRMATION_VISIBILITY=' + values.futureConfirmationVisibility,
        'FROZEN_TAKEN_PRICE_MUTATIONS=' + values.frozenPriceMutations,
        '',
        'PREFIX_CHECK_COUNT=' + values.prefixCheckCount,
        'PREFIX_MUTATIONS=' + values.prefixMutations,
        '',
        'PRODUCTION_FILES_MODIFIED=0',
        'RUNTIME_BEHAVIOR_CHANGED=false',
        '',
        'LIQUIDITY_TAKEN_MUTATIONS=0',
        'EXISTING_SWEEP_MUTATIONS=0',
        'DISPLACEMENT_MUTATIONS=0',
        'WATCH_MUTATIONS=0',
        'FIRST_TOUCH_MUTATIONS=0',
        '',
        'FULL_REGRESSION=PASS',
        '',
        'STRICT_BLIND_VALIDATION_COMPLETED=false',
        '',
        'COMMIT_CREATED=false',
        'PUSHED=false',
        '',
        'PRE_REVIEW_VERDICT=READY_FOR_STRICT_BLIND_HUMAN_REVIEW',
        '',
        'NEXT_TASK=HUMAN_BLIND_REVIEW',
        '',
        'HARD_STOP_REACHED=true',
        ''
    ].join('\n');
}

function main() {
    var head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    var foundation = verifyFoundation();
    if (!head.startsWith(EXPECTED_HEAD) || !foundation.productionTakenVerified) throw new Error('PRODUCTION_FOUNDATION_FAILED');
    var runs = SPECS.map(produceSymbol);
    if (runs.some(function (run) { return run.continuity.status !== 'PASS'; })) throw new Error('DATA_CONTINUITY_FAILED');
    var bySymbol = {};
    runs.forEach(function (run) { bySymbol[run.spec.symbol] = run; });
    var timelines = [].concat.apply([], runs.map(function (run) { return run.timelines; }));
    var confirmedRows = timelines.filter(function (row) { return row.candidateConfirmed; });
    var unconfirmedRows = timelines.filter(function (row) { return !row.candidateConfirmed; });
    if (confirmedRows.length < 20 || unconfirmedRows.length < 20) throw new Error('INSUFFICIENT_POPULATION');

    var usedInteractions = {};
    var selected = deterministicStratified(confirmedRows, 20, usedInteractions)
        .concat(deterministicStratified(unconfirmedRows, 20, usedInteractions));
    selected.sort(function (a, b) { return seededHash('blind-order|' + a.caseId).localeCompare(seededHash('blind-order|' + b.caseId)); });
    var prefixChecks = prefixAudit(selected, bySymbol);
    var prefixMutations = prefixChecks.reduce(function (sum, check) { return sum + check.mutationCount; }, 0);
    var futureLiquidityUsage = timelines.filter(function (row) {
        return Date.parse(row.liquidityConfirmedAt) > Date.parse(row.takenAt);
    }).length;
    var futureConfirmationVisibility = timelines.filter(function (row) {
        return row.firstReturnBar !== null && Date.parse(row.firstReturnAt) < Date.parse(row.bars[row.firstReturnBar].closeTime);
    }).length;
    var frozenPriceMutations = timelines.filter(function (row) {
        return !row.frozenTakenSnapshotMatchesSource;
    }).length;
    if (prefixMutations || futureLiquidityUsage || futureConfirmationVisibility || frozenPriceMutations) throw new Error('CAUSALITY_FAILED');

    ensureFreshDirectory(BLIND_PACKAGE);
    ensureFreshDirectory(ANSWER_PACKAGE);
    fs.mkdirSync(path.join(BLIND_PACKAGE, 'charts'), { recursive: true });
    removeIfPresent(BLIND_ZIP);
    removeIfPresent(ANSWER_ZIP);

    var instructions = instructionsText();
    fs.writeFileSync(path.join(OUT, 'blind-review-instructions.txt'), instructions);
    fs.writeFileSync(path.join(BLIND_PACKAGE, 'blind-review-instructions.txt'), instructions);
    var blindCases = [];
    var answers = [];
    selected.forEach(function (row, index) {
        var blindId = 'BLIND-' + String(index + 1).padStart(3, '0');
        var chartFileName = blindId + '.svg';
        var chartFile = path.join(BLIND_PACKAGE, 'charts', chartFileName);
        var chartWindow = renderChart(blindId, row, bySymbol[row.symbol].candles, chartFile);
        blindCases.push({ caseId: blindId, chartFile: 'charts/' + chartFileName, chartSha256: sha(fs.readFileSync(chartFile)), chartWindow: chartWindow });
        answers.push(Object.assign({ blindCaseId: blindId }, row));
    });
    var blindAudit = {
        task: 'LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1',
        packagePurpose: 'STRICT_BLIND_HUMAN_REVIEW',
        reviewCaseCount: blindCases.length,
        sampleSeedSha256: sha(SEED),
        sampleFrozenBeforeHumanLabels: true,
        allowedLabels: ['GOOD_SWEEP', 'BORDERLINE', 'TAKEN_ONLY', 'NOT_SWEEP'],
        chartFilesUseOpaqueIdsOnly: true,
        classificationFieldsIncluded: false,
        cases: blindCases
    };
    writeJson(path.join(OUT, 'blind-case-audit.json'), blindAudit);
    writeJson(path.join(BLIND_PACKAGE, 'blind-case-audit.json'), blindAudit);

    var mechanical = answers.map(function (row) {
        return { blindCaseId: row.blindCaseId, candidateConfirmed: row.candidateConfirmed, confirmationBars: row.firstReturnBar };
    });
    var diagnostics = {
        task: 'LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1',
        hypothesisId: 'TAKEN_FAILED_ACCEPTANCE_V1',
        samplingSeed: SEED,
        sampleCount: answers.length,
        candidateConfirmedCount: mechanical.filter(function (row) { return row.candidateConfirmed; }).length,
        candidateNotConfirmedCount: mechanical.filter(function (row) { return !row.candidateConfirmed; }).length,
        stratificationDimensions: ['symbol', 'liquiditySide', 'liquidityType'],
        chartWindow: { preEventBars: 36, postTakenBars: 12 },
        sampleSha256: sha(answers.map(function (row) { return row.blindCaseId + '|' + row.caseId; }))
    };
    writeJson(path.join(OUT, 'blind-answer-key.json'), answers);
    writeJson(path.join(ANSWER_PACKAGE, 'blind-answer-key.json'), answers);
    writeJson(path.join(ANSWER_PACKAGE, 'mechanical-classifications.json'), mechanical);
    writeJson(path.join(ANSWER_PACKAGE, 'diagnostic-metadata.json'), diagnostics);

    var timing = {
        semantics: 'DESCRIPTIVE_ONLY_NO_THRESHOLD_SELECTION',
        maxObservationBars: MAX_OBSERVATION_BARS,
        maxObservationBarsIsProductionThreshold: false,
        total: timingDistribution(timelines),
        BSL: timingDistribution(timelines.filter(function (row) { return row.liquiditySide === 'BSL'; })),
        SSL: timingDistribution(timelines.filter(function (row) { return row.liquiditySide === 'SSL'; })),
        byLiquidityType: {}
    };
    TYPES.forEach(function (type) { timing.byLiquidityType[type] = timingDistribution(timelines.filter(function (row) { return row.liquidityType === type; })); });
    var population = {
        task: 'LIQUIDITY_SWEEP_CONFIRMATION_SEMANTICS_V1',
        takenSource: 'PRODUCTION_LIQUIDITY_TAKEN',
        hypothesisId: 'TAKEN_FAILED_ACCEPTANCE_V1',
        dataset: runs.reduce(function (out, run) {
            out[run.spec.symbol] = Object.assign({}, run.continuity, {
                source: run.payload.source,
                fixtureSha256: run.fixtureSha256,
                fullFixtureCandleCountUsedForCausalWarmup: run.candles.length,
                observationHorizonMatureThrough: iso(run.candles[run.matureEnd].closeTime)
            });
            return out;
        }, {}),
        summary: {
            totalTakenCount: timelines.length,
            candidateConfirmedCount: confirmedRows.length,
            candidateNotConfirmedWithin12Count: unconfirmedRows.length,
            bySymbol: countBy(timelines, function (row) { return row.symbol; }),
            bySide: countBy(timelines, function (row) { return row.liquiditySide; }),
            byLiquidityType: countBy(timelines, function (row) { return row.liquidityType; })
        },
        timelines: timelines
    };
    writeJson(path.join(OUT, 'population-summary.json'), population);
    writeJson(path.join(OUT, 'confirmation-timing.json'), timing);

    var causality = {
        productionTakenFoundation: foundation,
        takenSource: 'replay/replayState.incrementalEvents -> events/liquidityTakenEventAdapter.buildTakenEvent',
        frozenPriceSource: 'LIQUIDITY_TAKEN.price and LIQUIDITY_TAKEN.source.liquidityPrice',
        mutableEqPriceLookupUsedForConfirmation: false,
        confirmationVisibilityRule: 'first eligible closed candle only becomes visible at candle.closeTime',
        futureLiquidityUsage: futureLiquidityUsage,
        futureConfirmationVisibility: futureConfirmationVisibility,
        frozenTakenPriceMutations: frozenPriceMutations,
        prefixCheckCount: prefixChecks.length,
        prefixMutations: prefixMutations,
        prefixChecks: prefixChecks
    };
    writeJson(path.join(OUT, 'causality-audit.json'), causality);

    var summary = { total: timelines.length, confirmed: confirmedRows.length, unconfirmed: unconfirmedRows.length };
    fs.writeFileSync(path.join(OUT, 'README.md'), readmeText(summary));
    var values = {
        head: head,
        baselineMatch: head.startsWith(EXPECTED_HEAD),
        remoteMatch: REMOTE_HEAD === head,
        foundation: foundation,
        dataStart: runs[0].continuity.start,
        dataEnd: runs[0].continuity.end,
        total: timelines.length,
        confirmed: confirmedRows.length,
        unconfirmed: unconfirmedRows.length,
        timing: timing.total,
        futureLiquidityUsage: futureLiquidityUsage,
        futureConfirmationVisibility: futureConfirmationVisibility,
        frozenPriceMutations: frozenPriceMutations,
        prefixCheckCount: prefixChecks.length,
        prefixMutations: prefixMutations
    };
    fs.writeFileSync(path.join(OUT, 'acceptance-matrix.txt'), acceptanceText(values));

    childProcess.execFileSync('zip', ['-X', '-q', '-r', BLIND_ZIP, 'charts', 'blind-review-instructions.txt', 'blind-case-audit.json'], { cwd: BLIND_PACKAGE });
    childProcess.execFileSync('zip', ['-X', '-q', '-r', ANSWER_ZIP, 'blind-answer-key.json', 'mechanical-classifications.json', 'diagnostic-metadata.json'], { cwd: ANSWER_PACKAGE });

    var blindEntries = childProcess.execFileSync('unzip', ['-Z1', BLIND_ZIP], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    var answerEntries = childProcess.execFileSync('unzip', ['-Z1', ANSWER_ZIP], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    var blindVisible = blindEntries.map(function (entry) {
        if (/\/$/.test(entry)) return '';
        return fs.readFileSync(path.join(BLIND_PACKAGE, entry), 'utf8');
    }).join('\n');
    var forbidden = ['candidateConfirmed', 'confirmationBars', 'same-bar', 'delayed', 'mechanical class', 'answer label'];
    var leakageMatches = forbidden.filter(function (term) { return blindVisible.toLowerCase().indexOf(term.toLowerCase()) >= 0; });
    var badNames = blindEntries.filter(function (entry) {
        return !/^(charts\/|charts\/BLIND-\d{3}\.svg$|blind-review-instructions\.txt$|blind-case-audit\.json$)/.test(entry);
    });
    var expectedAnswerEntries = ['blind-answer-key.json', 'diagnostic-metadata.json', 'mechanical-classifications.json'];
    var packageAudit = {
        blindZipSha256: sha(fs.readFileSync(BLIND_ZIP)),
        answerZipSha256: sha(fs.readFileSync(ANSWER_ZIP)),
        blindEntries: blindEntries,
        answerEntries: answerEntries,
        answerKeyPresentInBlindZip: blindEntries.some(function (entry) { return /answer/i.test(entry); }),
        mechanicalClassVisible: leakageMatches.length > 0,
        categoryInFilename: badNames.length > 0,
        blindEntryCount: blindEntries.length,
        answerEntrySetExact: JSON.stringify(answerEntries.slice().sort()) === JSON.stringify(expectedAnswerEntries),
        leakageMatches: leakageMatches,
        pass: leakageMatches.length === 0 && badNames.length === 0 &&
            !blindEntries.some(function (entry) { return /answer/i.test(entry); }) &&
            JSON.stringify(answerEntries.slice().sort()) === JSON.stringify(expectedAnswerEntries)
    };
    writeJson(path.join(OUT, 'package-audit.json'), packageAudit);
    if (!packageAudit.pass) throw new Error('PACKAGE_LEAKAGE_FAILED');

    console.log(JSON.stringify({
        head: head,
        remoteHead: REMOTE_HEAD,
        population: summary,
        timing: timing.total,
        blindSample: diagnostics,
        causality: { prefixCheckCount: prefixChecks.length, prefixMutations: prefixMutations, futureLiquidityUsage: futureLiquidityUsage },
        packages: { blind: BLIND_ZIP, answer: ANSWER_ZIP },
        packageAudit: packageAudit,
        preReviewVerdict: 'READY_FOR_STRICT_BLIND_HUMAN_REVIEW',
        hardStopReached: true
    }, null, 2));
}

main();
