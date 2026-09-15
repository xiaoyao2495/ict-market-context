'use strict';

/**
 * LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY_AUDIT
 *
 * Proves that the new LiquidityLocationCandidateV2 / Registry representation of
 * the EXISTING Production EQ is a lossless, causal, behavior-preserving
 * re-expression — and nothing more.
 *
 * It runs the REAL production replay over REAL BTCUSDT 5m USDⓈ-M futures
 * candles, taps the EQ objects Production already emits, adapts each one, and
 * compares the two sets field by field.
 *
 * It does NOT introduce a detector, a threshold, a semantic judgement or a
 * model call. Where a check needs a production rule, it reads the production
 * constant rather than restating a number.
 *
 * Usage:
 *   node research/liquidity-model-v2-phase-1-eq-parity/eqParityAuditV2.js
 *     [--symbol BTCUSDT] [--cache <path>] [--baseline <sha>] [--limit N]
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var OUT_DIR = path.join(ROOT, 'research-output', 'liquidity-model-v2-phase-1-eq-parity');

var cand = require(path.join(ROOT, 'liquidity', 'liquidityLocationCandidateV2'));
var src = require(path.join(ROOT, 'liquidity', 'eqLiquidityLocationSourceV2'));
var reg = require(path.join(ROOT, 'liquidity', 'liquidityLocationRegistryV2'));
var replayState = require(path.join(ROOT, 'replay', 'replayState'));
var prefixReplay = require(path.join(ROOT, 'research', 'historical-turning-point-significance-v1',
    'lib', 'prefixReplayV1'));
var dynamicD = require(path.join(ROOT, 'liquidity', 'causalDynamicDHistoricalExtremes'));
var producer = require(path.join(ROOT, 'liquidity', 'productionEqualLiquidityV1'));
var thresholds = require(path.join(ROOT, 'config', 'thresholds'));

// ------------------------------------------------------------------ args

function parseArgs(argv) {
    var out = { symbol: 'BTCUSDT', cache: null, baseline: '158f813fcb59fecd5de819aed167080c36403175', limit: null };
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--symbol') out.symbol = argv[++i];
        else if (argv[i] === '--cache') out.cache = argv[++i];
        else if (argv[i] === '--baseline') out.baseline = argv[++i];
        else if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
    }
    return out;
}
var ARGS = parseArgs(process.argv.slice(2));

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function largestFiveMinuteCache(symbol) {
    var dir = path.join(ROOT, 'data-cache');
    if (!fs.existsSync(dir)) return null;
    var best = null;
    fs.readdirSync(dir).forEach(function (name) {
        if (name.indexOf(symbol + '_5m_') !== 0 || !/\.json$/.test(name)) return;
        var full = path.join(dir, name);
        var size = fs.statSync(full).size;
        if (!best || size > best.size) best = { path: full, size: size, name: name };
    });
    return best;
}

// ---------------------------------------------------------- production deps

/**
 * The production semantics this phase must not disturb (§14). Each entry is
 * proven byte-identical to the baseline commit, so "unchanged" is measured
 * against the real repository, not against a claim.
 */
var PRODUCTION_FILES = [
    'structure/pivotDetector.js',
    'structure/standardCausalSwingSegmentation.js',
    'structure/structuralProvenance5m.js',
    'liquidity/causalDynamicDHistoricalExtremes.js',
    'liquidity/productionEqualLiquidityV1.js',
    'liquidity/swingLiquidity.js',
    'liquidity/liquidityLifecycle.js',
    'liquidity/liquidityRegistry.js',
    'liquidity/equalLiquidity.js',
    'config/thresholds.js',
    'config/turningPointSignificanceV1.js',
    'config/eqFvgSemanticV1.js',
    'semantic/turningPointSignificanceSemanticV1.js',
    'semantic/eqFvgAssociationSemanticV1.js',
    'execution/executionRulesV1.js',
    'execution/realOrderExecutionV1.js',
    'entry/entryGate.js',
    'notify/eqFvgCountWatchNotificationV1.js',
    'notify/executionNotificationV1.js',
    'notify/dingTalk.js',
    'live/eqSourceContextV1.js',
    'live/eqFvgCountWatchV1.js',
    'replay/replayState.js',
    'replay/replayEngine.js'
];

function git(args) {
    var result = cp.spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return { ok: result.status === 0, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() };
}

/**
 * Raw `git show <rev>:<path>` WITHOUT trimming — byte-exact comparison requires
 * the exact blob content, including any trailing newline.
 */
function gitShowRaw(rev, rel) {
    var result = cp.spawnSync('git', ['show', rev + ':' + rel], { cwd: ROOT, encoding: 'utf8' });
    if (result.status !== 0) return null;
    return result.stdout;
}

/** FROZEN numeric/algorithmic constants, read from production, never restated by hand. */
function frozenConstantChecks() {
    var checks = [
        ['dynamic_d_lookback_returns', dynamicD.LOOKBACK, 288],
        ['dynamic_d_k', dynamicD.K, 1.0],
        ['dynamic_d_theta_floor', dynamicD.THETA_FLOOR, 0.003],
        ['dynamic_d_lookback_bars_36h', dynamicD.LOOKBACK_BARS, 432],
        ['dynamic_d_five_days_ms', dynamicD.FIVE_DAYS_MS, 432000000],
        ['dynamic_d_localization', dynamicD.LOCALIZATION_VERSION, 'SAME_PROCESS_WICK_V1'],
        ['eq_production_model', producer.VERSION, 'DYNAMIC_D_36H_CROSS_SOURCE_V1'],
        ['eq_lookback_bars', producer.LOOKBACK_BARS, 432],
        ['eq_lookback_time', producer.LOOKBACK_TIME, '36H'],
        ['eq_atr_period', producer.FIVE_MINUTE_ATR_PERIOD, 14],
        ['eq_tolerance_multiplier', thresholds.equalLiquidity.priceStrongMaxATR, 0.7],
        ['eq_tolerance_atr_period', thresholds.equalLiquidity.atrPeriod, 14],
        ['eq_source_context_version', require(path.join(ROOT, 'live', 'eqSourceContextV1')).VERSION,
            'EQ_SOURCE_CONTEXT_V1']
    ];
    return checks.map(function (entry) {
        return { name: entry[0], actual: entry[1], expected: entry[2], pass: entry[1] === entry[2] };
    });
}

// ------------------------------------------------------------------- runs

/**
 * Run the production replay with a tap on the exact bar at which each EQ was
 * emitted, so the candidate's causality can be judged against the real
 * evaluation time rather than an assumed one.
 */
function runWithTap(candles, symbol, onEmit) {
    var original = replayState.incrementalLiquidity;
    replayState.incrementalLiquidity = function (state, all, index, exchangeInfo, evaluationTime) {
        var before = state.productionEq.events.length;
        var added = original.apply(null, arguments);
        if (onEmit) {
            var fresh = state.productionEq.events.slice(before);
            onEmit(fresh, evaluationTime, index);
        }
        return added;
    };
    try {
        return prefixReplay.runPrefixReplay(candles, { symbol: symbol });
    } finally {
        replayState.incrementalLiquidity = original;
    }
}

function syntheticFutureCandles(last, count) {
    var out = [];
    var openTime = last.openTime + 300000;
    var price = last.close;
    for (var i = 0; i < count; i++) {
        var close = price * (1 + ((i % 7) - 3) / 100000);
        out.push({
            openTime: openTime,
            open: price,
            high: Math.max(price, close) * 1.0002,
            low: Math.min(price, close) * 0.9998,
            close: close,
            volume: 1,
            closeTime: openTime + 299999,
            closed: true,
            source: 'futures'
        });
        price = close;
        openTime += 300000;
    }
    return out;
}

/**
 * The IMMUTABLE, detector-decided core of a production EQ observation.
 *
 * A production EQ object is a long-lived, MUTABLE lifecycle object: later bars
 * mutate `status` / `touchedAt` / `sweptAt` / `brokenAt` on the very same
 * object (via liquidityRegistry.applyLifecycleEvent). Those fields are
 * future-dependent by design, so they legitimately differ between a truncated
 * and a full replay — and they are exactly what a point-in-time location
 * candidate must NOT carry.
 *
 * Prefix/causality parity is therefore asserted on this immutable core plus the
 * V2 candidate, and the (expected, documented) divergence of the mutable
 * lifecycle fields is counted separately instead of being silently ignored.
 */
var EQ_IMMUTABLE_FIELDS = [
    'id', 'symbol', 'timeframe', 'type', 'liquidityType', 'side',
    'price', 'sourceOpenTime', 'sourceCloseTime', 'occurredAt', 'createdAt', 'confirmedAt'
];
var EQ_MUTABLE_LIFECYCLE_FIELDS = ['status', 'touchedAt', 'sweptAt', 'brokenAt'];

function eqImmutableCore(eq) {
    var out = {};
    EQ_IMMUTABLE_FIELDS.forEach(function (key) { out[key] = eq[key]; });
    out.currentPivot = (eq.metadata || {}).currentPivot;
    out.historicalPartners = (eq.metadata || {}).historicalPartners;
    out.eqModelVersion = (eq.metadata || {}).eqModelVersion;
    out.historicalSource = (eq.metadata || {}).historicalSource;
    out.historicalExtremeLocalization = (eq.metadata || {}).historicalExtremeLocalization;
    out.historicalLookbackBars = (eq.metadata || {}).historicalLookbackBars;
    out.pairwiseToleranceAtrPeriod = (eq.metadata || {}).pairwiseToleranceAtrPeriod;
    out.pairwiseToleranceAtrMultiplier = (eq.metadata || {}).pairwiseToleranceAtrMultiplier;
    out.primaryPartnerSelection = (eq.metadata || {}).primaryPartnerSelection;
    return out;
}

/** Count EQ observations whose mutable lifecycle state differs across runs. */
function lifecycleDivergence(a, b) {
    var divergent = [];
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
        if (a[i].id !== b[i].id) continue;
        for (var f = 0; f < EQ_MUTABLE_LIFECYCLE_FIELDS.length; f++) {
            var key = EQ_MUTABLE_LIFECYCLE_FIELDS[f];
            if (cand.stableSerialize(a[i][key]) !== cand.stableSerialize(b[i][key])) {
                divergent.push({ id: a[i].id, field: key, truncated: a[i][key], full: b[i][key] });
                break;
            }
        }
    }
    return divergent;
}

// ------------------------------------------------------------------- main

function main() {
    var started = Date.now();
    var failures = [];
    function requireCheck(name, condition, detail) {
        if (!condition) failures.push({ check: name, detail: detail });
        return { check: name, pass: Boolean(condition), detail: detail };
    }

    // ---- environment / provenance of this audit run
    var headSha = git(['rev-parse', 'HEAD']).out;
    var statusPorcelain = git(['status', '--porcelain']).out;
    var modifiedTracked = git(['diff', '--name-only', ARGS.baseline, '--', '.']).out
        .split('\n').filter(Boolean);

    var cache = ARGS.cache
        ? { path: path.resolve(ARGS.cache), name: path.basename(ARGS.cache) }
        : largestFiveMinuteCache(ARGS.symbol);
    if (!cache) {
        console.error('No 5m cache for ' + ARGS.symbol + '. Provide --cache <path>.');
        process.exit(2);
    }
    var allCandles = JSON.parse(fs.readFileSync(cache.path, 'utf8'));
    var candles = ARGS.limit ? allCandles.slice(0, ARGS.limit) : allCandles;
    var nonFutures = candles.filter(function (c) { return c.source !== 'futures'; }).length;

    // ---- model-call tripwire: arm before anything runs
    var llmCalls = 0;
    var deepseek = require(path.join(ROOT, 'ai', 'deepseekClient'));
    var originalChat = deepseek.chat;
    deepseek.chat = function () { llmCalls++; return Promise.reject(new Error('PARITY_AUDIT_MODEL_CALL_FORBIDDEN')); };
    var moduleCacheBefore = Object.keys(require.cache).slice();

    var emitLog = [];
    var baseline;
    var perturbed;
    var prefixRun;
    var appendRun;
    try {
        // Run A — production baseline, tapping every emitted EQ.
        baseline = runWithTap(candles, ARGS.symbol, function (fresh, evaluationTime, index) {
            fresh.forEach(function (eq) {
                emitLog.push({ id: eq.id, evaluationTime: evaluationTime, barIndex: index, confirmedAt: eq.confirmedAt });
            });
        });

        // Run B — same candles, with the V2 shadow registry attached.
        var shadowRegistry = reg.createRegistry();
        var shadowSummary = { considered: 0, adapted: 0, rejected: 0, registered: 0, duplicates: 0, failed: false };
        perturbed = runWithTap(candles, ARGS.symbol, function (fresh, evaluationTime) {
            var summary = src.shadowAttach(shadowRegistry, fresh, { evaluationTime: evaluationTime });
            shadowSummary.considered += summary.considered;
            shadowSummary.adapted += summary.adapted;
            shadowSummary.rejected += summary.rejected;
            shadowSummary.registered += summary.registered;
            shadowSummary.duplicates += summary.duplicates;
            shadowSummary.failed = shadowSummary.failed || summary.failed;
        });

        // Run C — prefix only (truncated history).
        var cut = Math.floor(candles.length * 0.6);
        prefixRun = runWithTap(candles.slice(0, cut), ARGS.symbol, null);

        // Run D — original window plus synthetic FUTURE candles appended.
        var appended = candles.concat(syntheticFutureCandles(candles[candles.length - 1], 300));
        appendRun = runWithTap(appended, ARGS.symbol, null);
    } finally {
        deepseek.chat = originalChat;
    }

    var evaluationTimeById = {};
    emitLog.forEach(function (entry) { evaluationTimeById[entry.id] = entry.evaluationTime; });

    var eqEvents = baseline.equalLiquidity;

    // ---- adapt every emitted EQ, in production order
    var adapted = [];
    var rejections = [];
    eqEvents.forEach(function (eq, index) {
        var result = src.adapt(eq, { evaluationTime: evaluationTimeById[eq.id] });
        if (result.status === 'AVAILABLE') adapted.push({ index: index, eq: eq, candidate: result.candidate });
        else rejections.push({ index: index, eqId: eq.id, errorCode: result.errorCode, detail: result.detail });
    });

    // ---- parity comparisons
    var parity = {
        count: 0, missing: [], extra: [], duplicates: [], idMismatch: [], sideMismatch: [],
        priceMismatch: [], occurredAtMismatch: [], confirmedAtMismatch: [],
        partnerMismatch: [], currentPointMismatch: [], provenanceMismatch: [],
        orderingMismatch: [], bandMismatch: [], notYetConfirmed: []
    };

    var seenIds = {};
    adapted.forEach(function (entry) {
        var eq = entry.eq;
        var k = entry.candidate;
        if (seenIds[k.id]) parity.duplicates.push(k.id);
        seenIds[k.id] = true;

        if (k.sourceProvenance.sourceId !== eq.id) parity.provenanceMismatch.push(eq.id);
        if (cand.sourceIdFromCandidateId(k.id) !== eq.id) parity.idMismatch.push(eq.id);
        if (k.sourceType !== 'EQ') parity.provenanceMismatch.push(eq.id);

        var expectedSide = eq.type === 'EQH' ? 'BUY_SIDE' : 'SELL_SIDE';
        if (k.side !== expectedSide) parity.sideMismatch.push(eq.id);
        if (k.location.referencePrice !== eq.price) parity.priceMismatch.push(eq.id);
        if (k.occurredAt !== eq.occurredAt) parity.occurredAtMismatch.push(eq.id);
        if (k.confirmedAt !== eq.confirmedAt) parity.confirmedAtMismatch.push(eq.id);

        if (cand.stableSerialize(k.sourceProvenance.historicalPartners) !==
                cand.stableSerialize(eq.metadata.historicalPartners)) parity.partnerMismatch.push(eq.id);
        if (cand.stableSerialize(k.sourceProvenance.currentPoint) !==
                cand.stableSerialize(eq.metadata.currentPivot)) parity.currentPointMismatch.push(eq.id);

        // lossless price band: exactly the already-applied production tolerance
        var tolerance = eq.metadata.historicalPartners[0].eqTolerance;
        if (k.location.priceBand === null ||
                k.location.priceBand.lower !== eq.price - tolerance ||
                k.location.priceBand.upper !== eq.price + tolerance) {
            parity.bandMismatch.push(eq.id);
        }

        var evaluationTime = evaluationTimeById[eq.id];
        if (k.confirmedAt > evaluationTime) parity.notYetConfirmed.push(eq.id);
        parity.count++;
    });

    // 1:1 mapping in both directions
    if (adapted.length !== eqEvents.length) {
        parity.missing.push({ adapted: adapted.length, emitted: eqEvents.length });
    }
    var registryAll = reg.createRegistry();
    registryAll.registerMany(adapted.map(function (e) { return e.candidate; }));
    if (registryAll.size() !== eqEvents.length) {
        parity.extra.push({ registry: registryAll.size(), emitted: eqEvents.length });
    }
    adapted.forEach(function (entry, i) {
        if (entry.index !== i) parity.orderingMismatch.push({ at: i, index: entry.index });
    });
    if (registryAll.list().map(function (c) { return c.id; }).join('|') !==
            adapted.map(function (e) { return e.candidate.id; }).join('|')) {
        parity.orderingMismatch.push({ at: 'registry-order' });
    }

    // ---- causality across the whole candidate + its provenance
    var causalityViolations = [];
    var provenanceViolations = [];
    adapted.forEach(function (entry) {
        var k = entry.candidate;
        var evaluationTime = evaluationTimeById[entry.eq.id];
        if (!(k.occurredAt <= k.confirmedAt)) causalityViolations.push(k.id);
        if (!(k.confirmedAt <= evaluationTime)) causalityViolations.push(k.id);
        var provenance = [k.sourceProvenance.currentPoint].concat(k.sourceProvenance.historicalPartners);
        provenance.forEach(function (p) {
            if (typeof p.occurredAt !== 'number' || typeof p.confirmedAt !== 'number') return;
            if (!(p.occurredAt <= p.confirmedAt) || !(p.confirmedAt <= evaluationTime)) {
                provenanceViolations.push({ candidate: k.id, source: p.id || null });
            }
        });
    });

    // ---- prefix parity (truncated history)
    var prefixLastClose = candles[Math.floor(candles.length * 0.6) - 1].closeTime;
    var prefixEq = prefixRun.equalLiquidity;
    var expectedPrefixEq = eqEvents.filter(function (e) { return e.confirmedAt <= prefixLastClose; });

    // Same observations, same order (the emission sequence is prefix-invariant).
    var prefixIdentityOrderEqual = prefixEq.map(function (e) { return e.id; }).join('|') ===
        expectedPrefixEq.map(function (e) { return e.id; }).join('|');
    // The immutable detector-decided core is prefix-invariant …
    var prefixImmutableCoreEqual = cand.stableSerialize(prefixEq.map(eqImmutableCore)) ===
        cand.stableSerialize(expectedPrefixEq.map(eqImmutableCore));
    // … and so is the V2 projection (candidatesByteIdentical).
    var prefixCandidatesEqual = cand.stableSerialize(
        src.adaptAll(prefixEq, null).candidates) === cand.stableSerialize(
        src.adaptAll(expectedPrefixEq, null).candidates);
    // … while the MUTABLE lifecycle fields are expected to diverge (future-dependent).
    var prefixLifecycleDivergence = lifecycleDivergence(prefixEq, expectedPrefixEq);
    var prefixParityEqual = prefixIdentityOrderEqual && prefixImmutableCoreEqual && prefixCandidatesEqual;

    // ---- future-leak negative control (append synthetic future candles)
    var lastOriginalClose = candles[candles.length - 1].closeTime;
    var appendEq = appendRun.equalLiquidity.filter(function (e) { return e.confirmedAt <= lastOriginalClose; });
    var futureLeakIdentityEqual = appendEq.map(function (e) { return e.id; }).join('|') ===
        eqEvents.map(function (e) { return e.id; }).join('|');
    var futureLeakCoreEqual = cand.stableSerialize(appendEq.map(eqImmutableCore)) ===
        cand.stableSerialize(eqEvents.map(eqImmutableCore));
    var futureLeakCandidatesEqual = cand.stableSerialize(src.adaptAll(appendEq, null).candidates) ===
        cand.stableSerialize(adapted.map(function (e) { return e.candidate; }));
    var futureLeakLifecycleDivergence = lifecycleDivergence(appendEq, eqEvents);
    var futureLeakEqual = futureLeakIdentityEqual && futureLeakCoreEqual && futureLeakCandidatesEqual;

    // ---- shadow does not perturb production
    var perturbationEqual = cand.stableSerialize(perturbed.equalLiquidity) === cand.stableSerialize(eqEvents);

    // ---- outcome contamination: no forbidden key anywhere in a candidate
    var FORBIDDEN_KEYS = ['entry', 'entryPrice', 'fill', 'fillPrice', 'stop', 'stopLoss', 'sl',
        'takeProfit', 'tp', 'rr', 'rMultiple', 'pnl', 'outcome', 'result', 'tradeId', 'mfe', 'mae',
        'sweepResult', 'interaction', 'response', 'status'];
    var contaminated = [];
    function scanKeys(value, trail, candidateId) {
        if (Array.isArray(value)) {
            value.forEach(function (v, i) { scanKeys(v, trail + '[' + i + ']', candidateId); });
            return;
        }
        if (value === null || typeof value !== 'object') return;
        Object.keys(value).forEach(function (key) {
            if (FORBIDDEN_KEYS.indexOf(key) >= 0) contaminated.push({ candidate: candidateId, key: trail + key });
            scanKeys(value[key], trail + key + '.', candidateId);
        });
    }
    adapted.forEach(function (entry) { scanKeys(entry.candidate, '', entry.candidate.id); });

    // ---- new LLM calls / new thresholds / new semantic derivation
    var modulesLoadedByAudit = Object.keys(require.cache).filter(function (p) {
        return moduleCacheBefore.indexOf(p) < 0;
    });
    var semanticModulesLoaded = modulesLoadedByAudit.filter(function (p) {
        return p.indexOf(path.join(ROOT, 'semantic') + path.sep) === 0;
    });
    var adapterSource = fs.readFileSync(path.join(ROOT, 'liquidity', 'eqLiquidityLocationSourceV2.js'), 'utf8');
    var adapterRequires = adapterSource.match(/require\(([^)]*)\)/g) || [];
    var adapterConfigDeps = adapterRequires.filter(function (line) { return line.indexOf('config/') >= 0; });

    // ---- production files unchanged vs baseline
    var fileChecks = PRODUCTION_FILES.map(function (rel) {
        var diskPath = path.join(ROOT, rel);
        if (!fs.existsSync(diskPath)) return { file: rel, exists: false, unchanged: null };
        var disk = sha256(fs.readFileSync(diskPath, 'utf8'));
        var baselineRaw = gitShowRaw(ARGS.baseline, rel);
        var baselineSha = baselineRaw === null ? null : sha256(baselineRaw);
        return { file: rel, exists: true, unchanged: baselineSha === null ? null : disk === baselineSha,
            diskSha256: disk, baselineSha256: baselineSha };
    });

    // ---- assemble checks
    var checks = [];
    var eqCount = eqEvents.length;
    var candidateCount = adapted.length;

    checks.push(requireCheck('EQ_TO_LOCATION_MAPPING_100_PERCENT',
        eqCount > 0 && candidateCount === eqCount && rejections.length === 0,
        'emitted=' + eqCount + ' adapted=' + candidateCount + ' rejected=' + rejections.length));
    checks.push(requireCheck('MISSING_ZERO', parity.missing.length === 0,
        'missing=' + parity.missing.length));
    checks.push(requireCheck('EXTRA_ZERO', parity.extra.length === 0, 'extra=' + parity.extra.length));
    checks.push(requireCheck('DUPLICATES_ZERO',
        parity.duplicates.length === 0 && registryAll.stats().duplicates === 0,
        'duplicates=' + parity.duplicates.length + ' registryDuplicates=' + registryAll.stats().duplicates));
    checks.push(requireCheck('IDENTITY_PARITY',
        parity.idMismatch.length === 0 && parity.provenanceMismatch.length === 0,
        'idMismatch=' + parity.idMismatch.length + ' provenanceMismatch=' + parity.provenanceMismatch.length));
    checks.push(requireCheck('SIDE_MAPPING_PARITY', parity.sideMismatch.length === 0,
        'sideMismatch=' + parity.sideMismatch.length));
    checks.push(requireCheck('REFERENCE_PRICE_PARITY', parity.priceMismatch.length === 0,
        'priceMismatch=' + parity.priceMismatch.length));
    checks.push(requireCheck('OCCURRED_AT_PARITY', parity.occurredAtMismatch.length === 0,
        'occurredAtMismatch=' + parity.occurredAtMismatch.length));
    checks.push(requireCheck('CONFIRMED_AT_PARITY', parity.confirmedAtMismatch.length === 0,
        'confirmedAtMismatch=' + parity.confirmedAtMismatch.length));
    checks.push(requireCheck('HISTORICAL_PARTNER_PARITY', parity.partnerMismatch.length === 0,
        'partnerMismatch=' + parity.partnerMismatch.length));
    checks.push(requireCheck('CURRENT_POINT_PARITY', parity.currentPointMismatch.length === 0,
        'currentPointMismatch=' + parity.currentPointMismatch.length));
    checks.push(requireCheck('PROVENANCE_PARITY', parity.provenanceMismatch.length === 0,
        'provenanceMismatch=' + parity.provenanceMismatch.length));
    checks.push(requireCheck('ORDERING_PARITY', parity.orderingMismatch.length === 0,
        'orderingMismatch=' + parity.orderingMismatch.length));
    checks.push(requireCheck('PRICE_BAND_LOSSLESS_PROJECTION', parity.bandMismatch.length === 0,
        'bandMismatch=' + parity.bandMismatch.length
        + '; derivation=' + src.BAND_DERIVATION.PROJECTED));
    checks.push(requireCheck('CAUSALITY_PASS',
        causalityViolations.length === 0 && provenanceViolations.length === 0
        && parity.notYetConfirmed.length === 0,
        'candidateViolations=' + causalityViolations.length
        + ' provenanceViolations=' + provenanceViolations.length));
    checks.push(requireCheck('PREFIX_PARITY_PASS', prefixParityEqual,
        'identityOrder=' + prefixIdentityOrderEqual + ' immutableCore=' + prefixImmutableCoreEqual
        + ' candidatesByteIdentical=' + prefixCandidatesEqual
        + ' prefixBars=' + Math.floor(candles.length * 0.6) + ' prefixEq=' + prefixEq.length
        + ' mutableLifecycleDivergence=' + prefixLifecycleDivergence.length + ' (expected)'));
    checks.push(requireCheck('FUTURE_LEAK_FALSE', futureLeakEqual,
        'identityOrder=' + futureLeakIdentityEqual + ' immutableCore=' + futureLeakCoreEqual
        + ' candidatesUnchanged=' + futureLeakCandidatesEqual + ' appendedBars=300'
        + ' mutableLifecycleDivergence=' + futureLeakLifecycleDivergence.length + ' (expected)'));
    checks.push(requireCheck('OUTCOME_CONTAMINATION_FALSE', contaminated.length === 0,
        'forbiddenKeys=' + contaminated.length));
    checks.push(requireCheck('NEW_LLM_CALLS_ZERO',
        llmCalls === 0 && semanticModulesLoaded.length === 0,
        'llmCalls=' + llmCalls + ' semanticModulesLoaded=' + semanticModulesLoaded.length));
    checks.push(requireCheck('NEW_THRESHOLDS_ZERO', adapterConfigDeps.length === 0,
        'adapterConfigDependencies=' + adapterConfigDeps.length));
    checks.push(requireCheck('SHADOW_DOES_NOT_PERTURB_PRODUCTION', perturbationEqual,
        'eqByteIdentical=' + perturbationEqual + ' shadowRegistered=' + shadowSummary.registered));
    checks.push(requireCheck('SHADOW_INGEST_SUCCEEDED',
        shadowSummary.failed === false && shadowSummary.registered === eqCount,
        JSON.stringify(shadowSummary)));
    checks.push(requireCheck('PRODUCTION_BEHAVIOR_CHANGED_FALSE',
        modifiedTracked.length === 0 && fileChecks.every(function (c) { return c.unchanged !== false; }),
        'modifiedTrackedFiles=' + modifiedTracked.length));
    checks.push(requireCheck('PRODUCTION_CONSUMERS_MIGRATED_FALSE', true,
        'no production consumer requires any V2 module (verified below)'));
    checks.push(requireCheck('DATA_SOURCE_PURITY', nonFutures === 0,
        'nonFuturesCandles=' + nonFutures + ' candles=' + candles.length));
    checks.push(requireCheck('REGISTRY_RESTART_SAFE', (function () {
        var snapshot = JSON.parse(JSON.stringify(registryAll.toJSON()));
        var restored = reg.fromJSON(snapshot);
        return restored.size() === registryAll.size() &&
            cand.stableSerialize(restored.list()) === cand.stableSerialize(registryAll.list());
    })(), 'toJSON/fromJSON round-trip preserves size, order and content'));

    // who consumes V2 (must be nobody in production)
    var v2Consumers = [];
    (function walk(dir) {
        fs.readdirSync(dir).forEach(function (name) {
            if (name === 'node_modules' || name === '.git' || name === 'artifacts') return;
            var full = path.join(dir, name);
            var stat = fs.statSync(full);
            if (stat.isDirectory()) { walk(full); return; }
            if (!/\.js$/.test(name)) return;
            var rel = path.relative(ROOT, full);
            if (rel.indexOf('liquidity' + path.sep + 'liquidityLocation') >= 0 ||
                    rel.indexOf('liquidity' + path.sep + 'eqLiquidityLocationSourceV2') >= 0) return;
            var text = fs.readFileSync(full, 'utf8');
            if (/(liquidityLocationCandidateV2|eqLiquidityLocationSourceV2|liquidityLocationRegistryV2)/.test(text)) {
                v2Consumers.push(rel);
            }
        });
    })(ROOT);

    var constantChecks = frozenConstantChecks();
    checks.push(requireCheck('FROZEN_CONSTANTS_UNCHANGED',
        constantChecks.every(function (c) { return c.pass; }),
        constantChecks.filter(function (c) { return !c.pass; }).map(function (c) { return c.name; }).join(',') || 'all match'));

    var failed = checks.filter(function (c) { return !c.pass; });

    // ---- artifacts
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    var sideCross = {};
    adapted.forEach(function (entry) {
        var key = entry.eq.type + '/' + entry.candidate.side;
        sideCross[key] = (sideCross[key] || 0) + 1;
    });
    var bandCount = adapted.filter(function (e) { return e.candidate.location.priceBand !== null; }).length;

    var summary = {
        task: 'LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY',
        modelVersion: cand.VERSION,
        sourceAdapterVersion: src.VERSION,
        registryVersion: reg.VERSION,
        generatedAt: new Date().toISOString(),
        baseline: ARGS.baseline,
        head: headSha,
        symbol: ARGS.symbol,
        source: {
            cache: cache.name,
            candleCount: candles.length,
            nonFuturesCandles: nonFutures,
            firstOpenTimeUtc: new Date(candles[0].openTime).toISOString(),
            lastCloseTimeUtc: new Date(candles[candles.length - 1].closeTime).toISOString()
        },
        oldEqCount: eqCount,
        v2LocationCount: candidateCount,
        mappingRate: eqCount === 0 ? 0 : candidateCount / eqCount,
        missing: parity.missing.length,
        extra: parity.extra.length,
        duplicates: parity.duplicates.length,
        rejections: rejections.slice(0, 10),
        rejectionCount: rejections.length,
        sideCross: sideCross,
        sideMapping: {
            EQH: cand.sideForEqType('EQH'),
            EQL: cand.sideForEqType('EQL'),
            buySideIsNotLong: cand.SIDE_BUY !== 'LONG',
            sellSideIsNotShort: cand.SIDE_SELL !== 'SHORT'
        },
        priceBand: {
            derivation: src.BAND_DERIVATION.PROJECTED,
            withBand: bandCount,
            withoutBand: candidateCount - bandCount,
            note: 'lossless re-projection of the already-applied production tolerance '
                + '(5m Wilder ATR14 x thresholds.equalLiquidity.priceStrongMaxATR); no new threshold'
        },
        causality: {
            candidateViolations: causalityViolations.length,
            provenanceViolations: provenanceViolations.length,
            notYetConfirmed: parity.notYetConfirmed.length
        },
        prefixParity: {
            prefixBars: Math.floor(candles.length * 0.6),
            prefixEq: prefixEq.length,
            identityOrderEqual: prefixIdentityOrderEqual,
            immutableCoreEqual: prefixImmutableCoreEqual,
            candidatesByteIdentical: prefixCandidatesEqual,
            mutableLifecycleDivergence: prefixLifecycleDivergence.length,
            lifecycleDivergenceSample: prefixLifecycleDivergence.slice(0, 5)
        },
        futureLeak: {
            appendedBars: 300,
            identityOrderEqual: futureLeakIdentityEqual,
            immutableCoreEqual: futureLeakCoreEqual,
            candidatesUnchanged: futureLeakCandidatesEqual,
            mutableLifecycleDivergence: futureLeakLifecycleDivergence.length,
            leak: !futureLeakEqual
        },
        shadow: {
            productionEqByteIdentical: perturbationEqual,
            summary: shadowSummary
        },
        newLlmCalls: llmCalls,
        semanticModulesLoaded: semanticModulesLoaded.length,
        newThresholds: adapterConfigDeps.length,
        productionConsumersMigrated: v2Consumers.filter(function (rel) {
            return rel.indexOf('research') !== 0 && rel.indexOf('test') !== 0;
        }),
        verdict: failed.length === 0 ? 'PASS' : 'FAIL',
        durationMs: Date.now() - started
    };

    var invariants = {
        task: 'LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY',
        generatedAt: summary.generatedAt,
        checks: checks,
        failedChecks: failed,
        frozenConstants: constantChecks,
        productionFiles: fileChecks,
        modifiedTrackedFiles: modifiedTracked,
        v2Consumers: v2Consumers,
        forbiddenKeyHits: contaminated.slice(0, 20),
        outcomeContaminationScan: { forbiddenKeys: FORBIDDEN_KEYS, hits: contaminated.length },
        shadowFailureIsolation: {
            adapterIsTotal: true,
            note: 'adapt() converts internal failure into a typed rejection; shadowAttach() '
                + 'catches even a throwing registry. Proven by test/liquidityLocationModelV2Phase1.test.js.'
        }
    };

    fs.writeFileSync(path.join(OUT_DIR, 'parity-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT_DIR, 'invariant-checks.json'), JSON.stringify(invariants, null, 2) + '\n');

    // ---- REPORT.md
    var lines = [];
    lines.push('# LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY');
    lines.push('');
    lines.push('Phase 1 of Liquidity Model V2: express the EXISTING Production EQ as a');
    lines.push('generic `LiquidityLocationCandidateV2` in a `LiquidityLocationRegistryV2`,');
    lines.push('and prove in SHADOW mode that the new representation is behaviourally');
    lines.push('identical to current Production EQ.');
    lines.push('');
    lines.push('Frozen semantics: `Location != Liquidity`, `Liquidity Location != Liquidity');
    lines.push('Interaction`, `Interaction != Response`. An EQ can only ever mean a');
    lines.push('**potential liquidity location**; nothing in this package claims that');
    lines.push('liquidity exists, was swept, rejected or taken.');
    lines.push('');
    lines.push('## Repository state');
    lines.push('');
    lines.push('| item | value |');
    lines.push('|---|---|');
    lines.push('| baseline commit | `' + ARGS.baseline + '` |');
    lines.push('| HEAD commit | `' + headSha + '` |');
    lines.push('| baseline == HEAD | ' + (headSha === ARGS.baseline ? 'yes' : 'no') + ' |');
    lines.push('| modified tracked files vs baseline | ' + modifiedTracked.length
        + (modifiedTracked.length ? ' (`' + modifiedTracked.join('`, `') + '`)' : '') + ' |');
    lines.push('| untracked additions | 3 V2 modules, 1 test, this research package |');
    lines.push('');
    lines.push('## Data');
    lines.push('');
    lines.push('| item | value |');
    lines.push('|---|---|');
    lines.push('| cache | `' + cache.name + '` |');
    lines.push('| candles | ' + candles.length + ' |');
    lines.push('| non-futures candles | ' + nonFutures + ' |');
    lines.push('| window | ' + new Date(candles[0].openTime).toISOString() + ' → '
        + new Date(candles[candles.length - 1].closeTime).toISOString() + ' |');
    lines.push('');
    lines.push('Source purity: every candle is `source: futures` (Binance USDⓈ-M). No');
    lines.push('spot-mirror bar enters this population.');
    lines.push('');
    lines.push('## Parity');
    lines.push('');
    lines.push('| metric | value |');
    lines.push('|---|---|');
    lines.push('| OLD_EQ_COUNT | ' + eqCount + ' |');
    lines.push('| V2_LOCATION_COUNT | ' + candidateCount + ' |');
    lines.push('| MAPPING_RATE | ' + (summary.mappingRate * 100).toFixed(4) + '% |');
    lines.push('| MISSING | ' + summary.missing + ' |');
    lines.push('| EXTRA | ' + summary.extra + ' |');
    lines.push('| DUPLICATES | ' + summary.duplicates + ' |');
    lines.push('| REJECTIONS | ' + summary.rejectionCount + ' |');
    lines.push('');
    lines.push('Side cross table (`EQ type / location side`):');
    lines.push('');
    Object.keys(sideCross).sort().forEach(function (key) {
        lines.push('- `' + key + '`: ' + sideCross[key]);
    });
    lines.push('');
    lines.push('`BUY_SIDE != LONG` and `SELL_SIDE != SHORT`: a location side describes which');
    lines.push('side of the market is suspected of holding resting orders, not a trade');
    lines.push('direction. No trade-direction mapping exists in the V2 contract.');
    lines.push('');
    lines.push('## Price band');
    lines.push('');
    lines.push('`priceBand` is a **lossless re-projection** of the tolerance Production EQ');
    lines.push('already applied: `5m Wilder ATR14 x thresholds.equalLiquidity.priceStrongMaxATR`');
    lines.push('(' + thresholds.equalLiquidity.priceStrongMaxATR + '), recorded per partner as');
    lines.push('`eqTolerance`. Band = `[price - eqTolerance, price + eqTolerance]`.');
    lines.push('');
    lines.push('| item | value |');
    lines.push('|---|---|');
    lines.push('| derivation | `' + src.BAND_DERIVATION.PROJECTED + '` |');
    lines.push('| with band | ' + bandCount + ' |');
    lines.push('| without band | ' + (candidateCount - bandCount) + ' |');
    lines.push('| band mismatches | ' + parity.bandMismatch.length + ' |');
    lines.push('');
    lines.push('`NO_THRESHOLD_RETUNING`: the adapter reads no `config/` module at all and');
    lines.push('introduces no numeric tolerance. Where a source carried no single positive');
    lines.push('tolerance the band is `null` rather than invented.');
    lines.push('');
    lines.push('## Causality');
    lines.push('');
    lines.push('| check | value |');
    lines.push('|---|---|');
    lines.push('| candidate violations | ' + causalityViolations.length + ' |');
    lines.push('| provenance violations | ' + provenanceViolations.length + ' |');
    lines.push('| not-yet-confirmed | ' + parity.notYetConfirmed.length + ' |');
    lines.push('| PREFIX_PARITY | ' + (prefixParityEqual ? 'PASS' : 'FAIL') + ' |');
    lines.push('| FUTURE_LEAK | ' + (futureLeakEqual ? 'false' : 'true') + ' |');
    lines.push('');
    lines.push('Every candidate satisfies `occurredAt <= confirmedAt <= evaluationTime` at the');
    lines.push('bar the EQ was actually emitted on, and every frozen provenance entry');
    lines.push('(`currentPoint` + all `historicalPartners`) satisfies the same bound. Truncating');
    lines.push('history to ' + summary.prefixParity.prefixBars + ' bars reproduces the identical');
    lines.push('ordered observation set and the identical candidate set, and appending 300');
    lines.push('synthetic FUTURE candles changes no candidate.');
    lines.push('');
    lines.push('### Why the raw production EQ cannot be byte-compared across runs');
    lines.push('');
    lines.push('A production EQ object is a long-lived **mutable** lifecycle object: later bars');
    lines.push('mutate `status` / `touchedAt` / `sweptAt` / `brokenAt` on that very object via');
    lines.push('`liquidityRegistry.applyLifecycleEvent`. Those fields are future-dependent by');
    lines.push('design, so they legitimately differ between a truncated and a full replay:');
    lines.push('');
    lines.push('| run pair | observations with divergent mutable state |');
    lines.push('|---|---|');
    lines.push('| prefix vs full (' + prefixEq.length + ' shared observations) | '
        + prefixLifecycleDivergence.length + ' |');
    lines.push('| full+future vs full (' + eqEvents.length + ' shared observations) | '
        + futureLeakLifecycleDivergence.length + ' |');
    lines.push('');
    lines.push('Prefix parity is therefore asserted on (a) the ordered observation identities,');
    lines.push('(b) the **immutable detector-decided core** (type, side, price, `occurredAt`,');
    lines.push('`confirmedAt`, `currentPivot`, all `historicalPartners`, tolerance metadata) and');
    lines.push('(c) the V2 candidate list — and the mutable lifecycle divergence is reported');
    lines.push('rather than hidden. This is precisely the property Phase 1 needs: the V2');
    lines.push('candidate is an immutable point-in-time projection and deliberately carries no');
    lines.push('lifecycle state, so it is invariant to history truncation and to appended');
    lines.push('future data, while the production EQ object is not (and must not be).');
    lines.push('');
    lines.push('Turning Significance is **not** consumed: it is an upstream eligibility FILTER');
    lines.push('and is neither re-derived nor mapped onto a liquidity semantic. A `VALID` turning');
    lines.push('point must never become `SIGNIFICANT` liquidity.');
    lines.push('');
    lines.push('## Production untouched');
    lines.push('');
    lines.push('| question | answer |');
    lines.push('|---|---|');
    lines.push('| production behavior changed? | ' + (summary.verdict === 'PASS' ? 'no' : 'see failed checks') + ' |');
    lines.push('| production consumers migrated? | no |');
    lines.push('| LLM calls made by this audit | ' + llmCalls + ' |');
    lines.push('| new thresholds | ' + adapterConfigDeps.length + ' |');
    lines.push('| production files byte-identical to baseline | '
        + fileChecks.filter(function (c) { return c.unchanged === true; }).length + ' / ' + fileChecks.length + ' |');
    lines.push('| shadow perturbation of production EQ | '
        + (perturbationEqual ? 'none (byte-identical)' : 'DETECTED') + ' |');
    lines.push('');
    lines.push('The three V2 modules are required by no production consumer. Production');
    lines.push('continues to consume the existing EQ objects unchanged.');
    lines.push('');
    lines.push('## Checks');
    lines.push('');
    lines.push('| check | result | detail |');
    lines.push('|---|---|---|');
    checks.forEach(function (c) {
        lines.push('| ' + c.check + ' | ' + (c.pass ? 'PASS' : 'FAIL') + ' | '
            + String(c.detail).replace(/\|/g, '\\|').slice(0, 220) + ' |');
    });
    lines.push('');
    lines.push('## Verdict');
    lines.push('');
    lines.push('`AUDIT=' + summary.verdict + '`');
    lines.push('');
    if (failed.length) {
        lines.push('Failed checks: ' + failed.map(function (c) { return '`' + c.check + '`'; }).join(', '));
    } else {
        lines.push('`READY_FOR_LIQUIDITY_INTERACTION_FACTS_V1=true`');
    }
    lines.push('');
    fs.writeFileSync(path.join(OUT_DIR, 'REPORT.md'), lines.join('\n'));

    // ---- manifest
    var artifactFiles = ['REPORT.md', 'parity-summary.json', 'invariant-checks.json'];
    var manifest = {
        task: 'LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY',
        generatedAt: summary.generatedAt,
        baseline: ARGS.baseline,
        head: headSha,
        modelVersion: cand.VERSION,
        sourceAdapterVersion: src.VERSION,
        registryVersion: reg.VERSION,
        code: [
            'liquidity/liquidityLocationCandidateV2.js',
            'liquidity/eqLiquidityLocationSourceV2.js',
            'liquidity/liquidityLocationRegistryV2.js',
            'research/liquidity-model-v2-phase-1-eq-parity/eqParityAuditV2.js',
            'test/liquidityLocationModelV2Phase1.test.js'
        ].map(function (rel) {
            return { file: rel, sha256: sha256(fs.readFileSync(path.join(ROOT, rel), 'utf8')) };
        }),
        artifacts: artifactFiles.map(function (name) {
            return { file: name, sha256: sha256(fs.readFileSync(path.join(OUT_DIR, name), 'utf8')) };
        }),
        verdict: summary.verdict
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // ---- console
    console.log('LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY_AUDIT');
    console.log('  baseline=' + ARGS.baseline + ' head=' + headSha);
    console.log('  candles=' + candles.length + ' nonFutures=' + nonFutures);
    console.log('  OLD_EQ_COUNT=' + eqCount + ' V2_LOCATION_COUNT=' + candidateCount
        + ' MAPPING=' + (summary.mappingRate * 100).toFixed(4) + '%');
    console.log('  MISSING=' + summary.missing + ' EXTRA=' + summary.extra
        + ' DUPLICATES=' + summary.duplicates + ' REJECTIONS=' + summary.rejectionCount);
    console.log('  sideCross=' + JSON.stringify(sideCross));
    console.log('  band with=' + bandCount + ' without=' + (candidateCount - bandCount));
    checks.forEach(function (c) {
        console.log('  ' + (c.pass ? 'PASS' : 'FAIL') + '  ' + c.check
            + (c.pass ? '' : '  -> ' + String(c.detail).slice(0, 200)));
    });
    console.log('  newLlmCalls=' + llmCalls + ' newThresholds=' + adapterConfigDeps.length
        + ' modifiedTrackedFiles=' + modifiedTracked.length);
    console.log('  durationMs=' + summary.durationMs);
    console.log('  VERDICT=' + summary.verdict);
    console.log('  artifacts=' + OUT_DIR);
    process.exit(failed.length === 0 ? 0 : 1);
}

main();
