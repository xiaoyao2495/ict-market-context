'use strict';

/**
 * CROSS_SOURCE_PATH_INTEGRITY_V1 - SHADOW REPLAY (research only).
 *
 *   node scripts/research/crossSourcePathIntegrityShadowReplayV1.js --days=2
 *     [--symbols=BTCUSDT,ETHUSDT,SOLUSDT] [--endTime=<ms>] [--maxAttempts=4]
 *     [--sweepMode=detached|swept] [--artifactDir=<dir>] [--networkOnly] [--replayOnly]
 *
 * §1 the run is split into two strictly separated phases:
 *      PHASE 1  NETWORK  download + verify + cache each symbol's 2D public data.
 *                        Bounded retries; the window never changes on retry; an incomplete
 *                        symbol is REPLAY_INVALID and its statistics are never used.
 *      PHASE 2  OFFLINE  before/after replay from the on-disk cache only.
 *   `--networkOnly` stops after phase 1; `--replayOnly` starts at phase 2. Running the two as
 *   separate PROCESSES gives the strongest separation (phase 2 then has no network module in its
 *   module graph at all). The in-process path additionally asserts the replay's require closure
 *   is network-free and arms a tripwire that makes any accidental request throw.
 *
 * NOTHING here modifies production semantics. The frozen rules are READ only:
 *   strategy/crossSourcePathIntegrityV1.js, strategy/twoBarReversalV1.js,
 *   strategy/twoBarSetupV1.js, liquidity/causalDynamicDHistoricalExtremes.js,
 *   execution/breakoutEntryRulesV1.js.
 * No order endpoint is named or reachable; no api key is read; no LLM call is made.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'config', 'loadEnv'))();

var series = require(path.join(ROOT,
    'research/cross-source-path-integrity-shadow-replay-v1/lib/seriesIntegrityV1'));
var offlineReplay = require(path.join(ROOT,
    'research/cross-source-path-integrity-shadow-replay-v1/lib/offlineReplayV1'));
var pathIntegrity = require(path.join(ROOT, 'strategy/crossSourcePathIntegrityV1'));

var BAR_MS = series.BAR_MS;
var OUT_ROOT = path.join(ROOT, 'artifacts', 'cross-source-path-integrity-shadow-replay-v1');
var DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

/** §6 the three frozen REAL regression anchors. */
var REAL_ANCHORS = {
    REAL_001_ETH: {
        label: 'REAL_001_ETH', symbol: 'ETHUSDT', direction: 'BEARISH',
        twoBarId: 'TWO_BAR_REVERSAL_V1:BEARISH:ETHUSDT:1789728300000:1789728899999',
        expect: { setupBefore: true, setupAfter: true, partnerReplaced: false,
            partnerUnchanged: true, planPreserved: true }
    },
    REAL_002_BTC: {
        label: 'REAL_002_BTC', symbol: 'BTCUSDT', direction: 'BULLISH',
        twoBarId: 'TWO_BAR_REVERSAL_V1:BULLISH:BTCUSDT:1789752600000:1789753199999',
        expect: { setupBefore: true, setupAfter: true, partnerReplaced: true,
            newPartnerPrice: 80467.5, newRR: 2.106212, planPreserved: true }
    },
    REAL_003_SOL: {
        label: 'REAL_003_SOL', symbol: 'SOLUSDT', direction: 'BULLISH',
        twoBarId: 'TWO_BAR_REVERSAL_V1:BULLISH:SOLUSDT:1789794600000:1789795199999',
        expect: { setupBefore: true, setupAfter: false, oldPartnerPrice: 112.39 }
    }
};

// ------------------------------------------------------------------- args

function readArg(name, fallback) {
    var prefix = '--' + name + '=';
    var found = process.argv.filter(function (a) { return a.indexOf(prefix) === 0; })[0];
    return found === undefined ? fallback : found.slice(prefix.length);
}
function hasFlag(name) { return process.argv.indexOf('--' + name) >= 0; }

// --------------------------------------------------------------- helpers

function bjt(ms) {
    if (ms === null || ms === undefined) return null;
    var d = new Date(ms + 8 * 3600 * 1000);
    function p(v, w) { return String(v).padStart(w, '0'); }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1, 2) + '-' + p(d.getUTCDate(), 2) + ' ' +
        p(d.getUTCHours(), 2) + ':' + p(d.getUTCMinutes(), 2) + ':' + p(d.getUTCSeconds(), 2);
}
function csvCell(value) {
    if (value === null || value === undefined) return '';
    var s = String(value);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ------------------------------------------------------------ phase guard

/**
 * §1 the modules that actually PERFORM market-data I/O. Their presence in the replay's require
 * closure would mean the offline phase could fetch data, so it is a hard failure.
 */
var MARKET_DATA_MODULE_TOKENS = ['data/binanceRest', 'binanceHttpTransportV1',
    'binanceRateLimitGovernorV1', 'flowDataClientV1', 'networkPrepV1'];

/**
 * §1 modules that are merely net-adjacent. `strategy/twoBarSetupV1.js` requires
 * `ai/deepseekClient.js`, which pulls `axios` -> `https-proxy-agent` -> `agent-base`, so these
 * ARE in the closure even though the replay never calls the LLM (LLM_CALLS=0). They are
 * reported explicitly rather than hidden, and the CALL-level guard below is what actually
 * proves the replay is offline.
 */
var INERT_NETWORK_TOKENS = ['ai/deepseekClient', 'node_modules/axios', 'https-proxy-agent',
    'http-proxy-agent', 'agent-base', 'follow-redirects'];

/** Everything that must NOT appear in the replay's module graph, for reporting. */
var NETWORK_MODULE_TOKENS = MARKET_DATA_MODULE_TOKENS.concat(INERT_NETWORK_TOKENS);

/** Transitive require closure of a module id, as absolute paths. */
function requireClosure(moduleId) {
    var seen = {};
    var root = require.cache[moduleId];
    (function walk(mod) {
        if (!mod || seen[mod.id]) return;
        seen[mod.id] = true;
        (mod.children || []).forEach(walk);
    })(root);
    return Object.keys(seen);
}

function offlineModuleId() {
    return require.resolve(path.join(ROOT,
        'research/cross-source-path-integrity-shadow-replay-v1/lib/offlineReplayV1'));
}

/**
 * §1 prove the replay phase is offline - two independent assertions:
 *   1. STRUCTURAL  the replay's transitive require closure contains no market-data module.
 *      (`ai/deepseekClient` + `axios` are reported as INERT: loaded, never invoked.)
 *   2. BEHAVIOURAL every HTTP entry point is replaced by a tripwire that counts and throws.
 *      `attempts` must still be empty after the whole replay; that is the real gate.
 */
function armOfflineGuard() {
    var closure = requireClosure(offlineModuleId());
    var rel = function (id) { return path.relative(ROOT, id); };
    var match = function (tokens) {
        return closure.filter(function (id) {
            return tokens.some(function (token) { return id.indexOf(token) >= 0; });
        }).map(rel);
    };
    var leaked = match(MARKET_DATA_MODULE_TOKENS);
    var inert = match(INERT_NETWORK_TOKENS);

    var attempts = [];
    var restores = [];
    function tripwire(label) {
        return function () {
            attempts.push({ target: label, at: Date.now() });
            throw new Error('NETWORK_ACCESS_ATTEMPTED_DURING_OFFLINE_REPLAY (' + label + ')');
        };
    }
    function patch(target, key, label) {
        if (!target || typeof target[key] !== 'function') return false;
        var original = target[key];
        target[key] = tripwire(label);
        restores.push(function () { target[key] = original; });
        return true;
    }
    var http = require('http');
    var https = require('https');
    ['request', 'get'].forEach(function (method) {
        patch(http, method, 'http.' + method);
        patch(https, method, 'https.' + method);
    });
    var patchedTransport = false;
    try {
        var transport = require(path.join(ROOT, 'data', 'binanceHttpTransportV1'));
        patchedTransport = patch(transport, 'request', 'binanceHttpTransportV1.request');
    } catch (error) { patchedTransport = false; }

    return {
        ok: leaked.length === 0,
        leaked: leaked,
        inert: inert,
        closureSize: closure.length,
        tripwireArmed: patchedTransport && restores.length >= 4,
        attempts: attempts,
        release: function () { restores.forEach(function (fn) { fn(); }); return attempts; }
    };
}

/** Back-compat thin wrapper: this is what the pre-flight assertion in the tests calls. */
function assertOffline() {
    var guard = armOfflineGuard();
    guard.release();
    return guard;
}

// ------------------------------------------------------------------ main

function main() {
    var days = Number(readArg('days', '2'));
    var symbolsArg = readArg('symbols', '');
    var symbols = symbolsArg.trim()
        ? symbolsArg.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
        : DEFAULT_SYMBOLS.slice();
    var maxAttempts = Number(readArg('maxAttempts', String(series.DEFAULT_MAX_ATTEMPTS)));
    var sweepMode = readArg('sweepMode', 'detached');
    if (offlineReplay.SWEEP_MODES.indexOf(sweepMode) < 0) {
        throw new Error('--sweepMode must be one of ' + offlineReplay.SWEEP_MODES.join('|'));
    }
    var networkOnly = hasFlag('networkOnly');
    var replayOnly = hasFlag('replayOnly');
    if (!(days > 0)) throw new Error('--days must be > 0');

    var endTimeArg = readArg('endTime', '');
    var endTime = endTimeArg ? Number(endTimeArg) : series.lastClosedBarCloseTime(Date.now());
    if (endTime % BAR_MS !== BAR_MS - 1) {
        throw new Error('--endTime must be a closed 5m bar closeTime (t % 300000 === 299999)');
    }
    var win = series.windowFor(endTime, days);
    var window = { startTime: win.startTime, endTime: win.endTime };

    var runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var reuseDir = readArg('artifactDir', '');
    var outDir;
    if (reuseDir) {
        outDir = path.isAbsolute(reuseDir) ? reuseDir : path.join(ROOT, reuseDir);
    } else if (replayOnly) {
        // §1 --replayOnly must read an EXISTING run's cache; never invent a new directory.
        var suffix = '-' + symbols.join('_') + '-' + days + 'D';
        var candidates = [];
        try {
            candidates = fs.readdirSync(OUT_ROOT).filter(function (name) {
                return name.slice(-suffix.length) === suffix &&
                    fs.existsSync(path.join(OUT_ROOT, name, '_cache')); });
        } catch (error) { candidates = []; }
        candidates.sort();
        if (candidates.length === 0) {
            throw new Error('REPLAY_CACHE_NOT_FOUND: no existing artifact dir in ' +
                path.relative(ROOT, OUT_ROOT) + ' matching *' + suffix + '. Run phase 1 first ' +
                '(without --replayOnly) or pass --artifactDir=<dir>.');
        }
        outDir = path.join(OUT_ROOT, candidates[candidates.length - 1]);
        console.log('REPLAY_REUSING_ARTIFACT_DIR=' + path.relative(ROOT, outDir));
    } else {
        outDir = path.join(OUT_ROOT, runStamp + '-' + symbols.join('_') + '-' + days + 'D');
    }
    var cache = series.createCache(path.join(outDir, '_cache'));

    console.log('=== CROSS_SOURCE_PATH_INTEGRITY_V1 SHADOW REPLAY ===');
    console.log('MODE=RESEARCH_SHADOW_REPLAY  PRODUCTION_CHANGED=false  PRODUCTION_DEPLOYED=false');
    console.log('REAL_ORDER_MUTATION_COUNT=0 (no execution client and no order route is constructed)');
    console.log('DEEPSEEK_API_KEY_PRESENT=' + (!!process.env.DEEPSEEK_API_KEY) +
        '  LLM_CALLS=0 (Pattern/Context layer is upstream and frozen)');
    console.log('PROXY=' + (require(path.join(ROOT, 'config', 'network')).proxy.enabled
        ? 'http://127.0.0.1:7890' : 'DISABLED'));
    console.log('PATH_INTEGRITY_RULE=' + pathIntegrity.VERSION);
    console.log('AUDIT_START=' + bjt(win.startTime) + ' UTC+8   AUDIT_END=' + bjt(win.endTime) +
        ' UTC+8   DURATION_HOURS=' + days * 24 + '   BARS=' + win.bars);
    console.log('SYMBOLS=' + symbols.join(','));
    console.log('SWEEP_MODE=' + sweepMode + (sweepMode === 'detached'
        ? ' (no cross-candidate invalidation; production-faithful for the population under study)'
        : ' (ABLATION: every candidate sweeps for every other candidate)'));
    console.log('ARTIFACT_DIR=' + path.relative(ROOT, outDir));
    console.log('');

    var prepared = {};
    var networkIncidents = [];

    function runReplayPhase() {
        console.log('--- PHASE 2  OFFLINE REPLAY ---');
        var guard = armOfflineGuard();
        console.log('OFFLINE_REPLAY_REQUIRE_TREE_CLEAN=' + (guard.ok ? 'true' : 'false') +
            '  (market-data modules absent; closure modules: ' + guard.closureSize + ')');
        console.log('INERT_NET_MODULES_LOADED=' + guard.inert.length +
            ' (LLM client + its http stack: present but never invoked)' +
            (guard.inert.length ? ' -> ' + guard.inert.join(',') : ''));
        console.log('NETWORK_TRIPWIRE_ARMED=' + (guard.tripwireArmed ? 'true' : 'false'));
        if (!guard.ok) {
            console.log('OFFLINE_LEAKED_MODULES=' + guard.leaked.join(','));
            throw new Error('REPLAY_PHASE_NOT_OFFLINE');
        }
        var perSymbol = [];
        var invalid = [];
        symbols.forEach(function (symbol) {
            var prep = prepared[symbol];
            if (!prep || !prep.REPLAY_VALID) {
                invalid.push({ symbol: symbol, reason: prep ? prep.reason : 'NOT_PREPARED' });
                console.log('[' + symbol + '] REPLAY_INVALID ' + (prep ? prep.reason : 'NOT_PREPARED') +
                    ' - statistics excluded');
                return;
            }
            var startedAt = Date.now();
            var result = offlineReplay.replaySymbol({ symbol: symbol, candles: prep.candles,
                window: window, symbolRules: prep.symbolRules, sweepMode: sweepMode });
            result.quality = prep.quality;
            result.elapsedMs = Date.now() - startedAt;
            perSymbol.push(result);
            var k = result.counts;
            console.log('[' + symbol + '] aligned=' + k.candidatesInWindow +
                ' toleranceMatches=' + k.eqToleranceMatches + ' pathPass=' + k.pathPass +
                ' pathReject=' + k.pathReject + ' pathUnknown=' + k.pathUnknown +
                ' setupBefore=' + k.setupsBefore + ' setupAfter=' + k.setupsAfter +
                ' replaced=' + k.partnerReplaced + ' removed=' + k.setupRemoved +
                ' created=' + k.setupCreatedByPathFilter + ' (' + result.elapsedMs + 'ms)');
        });

        // §1 the behavioural half of the offline proof: nothing may have reached an HTTP entry
        // point during the replay, even though `axios` is present in the module graph.
        var networkAttempts = guard.release();
        console.log('NETWORK_CALL_ATTEMPTS=' + networkAttempts.length);
        if (networkAttempts.length > 0) {
            throw new Error('REPLAY_PHASE_NOT_OFFLINE: ' + networkAttempts.length +
                ' HTTP entry point(s) were reached during the offline replay');
        }
        var offlineEvidence = { marketDataModulesAbsent: guard.ok, leaked: guard.leaked,
            inertNetModules: guard.inert, closureSize: guard.closureSize,
            tripwireArmed: guard.tripwireArmed, networkCallAttempts: networkAttempts.length };

        var total = emptyTotals();
        perSymbol.forEach(function (r) { addTotals(total, r.counts); });
        if (total.setupCreatedByPathFilter > 0) {
            throw new Error('IMPLEMENTATION_ANOMALY: SETUP_CREATED_BY_PATH_FILTER=' +
                total.setupCreatedByPathFilter + ' - the filter can only remove candidates');
        }

        var unknownDetail = [];
        perSymbol.forEach(function (r) {
            r.samples.forEach(function (s) {
                s.evaluations.forEach(function (e) {
                    if (e.status !== 'UNKNOWN') return;
                    unknownDetail.push({ symbol: s.symbol, twoBarId: s.twoBarId,
                        direction: s.direction, partnerId: e.partnerId, partnerPrice: e.partnerPrice,
                        reason: e.reason, classified: e.unknownReason,
                        anchorOccurredAtBJT: bjt(e.anchorOccurredAt),
                        k1OpenTimeBJT: bjt(e.k1OpenTime),
                        intermediateBarCount: e.intermediateBarCount });
                });
            });
        });

        var realAnchors = resolveRealAnchors(perSymbol);
        var replacements = collectReplacements(perSymbol);
        var removalCases = collectRemovals(perSymbol);

        var summary = {
            version: 'CROSS_SOURCE_PATH_INTEGRITY_V1_SHADOW_REPLAY',
            artifactDir: path.relative(ROOT, outDir),
            window: { startTime: win.startTime, endTime: win.endTime, days: days, bars: win.bars,
                startBJT: bjt(win.startTime), endBJT: bjt(win.endTime) },
            symbols: symbols, invalidSymbols: invalid, counts: total, sweepMode: sweepMode,
            perSymbol: perSymbol.map(function (r) {
                return { symbol: r.symbol, counts: r.counts, unknownReasons: r.unknownReasons,
                    quality: r.quality, elapsedMs: r.elapsedMs };
            }),
            unknownReasons: mergeUnknownReasons(perSymbol),
            unknownDetail: unknownDetail,
            realAnchors: realAnchors, replacements: replacements, removals: removalCases,
            networkIncidents: networkIncidents,
            offlineGuard: offlineEvidence,
            llm: { called: false,
                note: 'The Pattern/Context LLM is upstream of the EQ stage and is intentionally ' +
                    'not re-called, so before/after cannot drift. The measured population is the ' +
                    'deterministic candidate population that reaches the EQ stage; every ' +
                    'LLM-aligned Two-Bar is a subset of it.' },
            htfGate: { mode: 'NEUTRALISED_TO_ALIGNED_DIRECTION',
                note: 'buildBreakoutPlan\'s first gate checks DIRECTION only; the replay feeds an ' +
                    'aligned bias so initialSL/initialTP/initialRR reflect EQ + target geometry.' },
            contractPrice: { mode: 'K2_CLOSE', note: 'causal proxy for the live contract price' },
            frozenRules: { pathIntegrity: pathIntegrity.VERSION,
                eqToleranceMultiplier: offlineReplay.MULT },
            sweepMode: { mode: sweepMode, options: offlineReplay.SWEEP_MODES,
                note: sweepMode === 'detached'
                    ? 'The matcher runs against a detached copy of the survival list, so no ' +
                      'candidate can retire a reference on behalf of another. In production the ' +
                      'matcher is reached only after both LLM gates; this replay does not re-run ' +
                      'them, so an ungated sweep would substitute extra invalidation for the ' +
                      'LLM gate and hide the PATH filter effect being measured.'
                    : 'ABLATION only: the matcher mutates the shared state, so every candidate ' +
                      'sweeps for every other candidate. Not production-faithful.' }
        };
        summary.verdict = classifyVerdict(summary);
        // §6 the frozen REAL regression gate is evaluated on top of the mechanical verdict.
        summary.anchorGate = evaluateAnchorGate(summary.realAnchors);
        if (!summary.anchorGate.PASS) summary.verdict = 'REPLAY_ANCHOR_GATE_FAILED';
        summary.semanticDigest = semanticDigest(summary, perSymbol);

        writeArtifacts(outDir, summary, perSymbol, prepared, window, runStamp);
        printSummary(summary, replacements, removalCases, unknownDetail);
        return summary;
    }

    if (replayOnly) {
        console.log('--- PHASE 1  NETWORK: SKIPPED (--replayOnly) - reading the on-disk cache ---');
        // Uses the PURE loader, so no network module enters this process at all.
        symbols.forEach(function (symbol) {
            prepared[symbol] = series.loadPreparedFromCache({ symbol: symbol,
                startTime: win.startTime, endTime: win.endTime, cache: cache });
        });
        return Promise.resolve(runReplayPhase());
    }

    console.log('--- PHASE 1  NETWORK (public market data only) ---');
    var networkPrepMod = require(path.join(ROOT,
        'research/cross-source-path-integrity-shadow-replay-v1/lib/networkPrepV1'));
    var guard = networkPrepMod.installNetworkGuard();
    var chain = Promise.resolve();
    symbols.forEach(function (symbol) {
        chain = chain.then(function () {
            return networkPrepMod.prepareSymbol({ symbol: symbol, startTime: win.startTime,
                endTime: win.endTime, cache: cache, maxAttempts: maxAttempts })
                .then(function (result) {
                    prepared[symbol] = result;
                    var q = result.quality || {};
                    console.log('[' + symbol + '] bars=' + q.barCount + ' window=' + q.windowBars +
                        '/' + q.windowBarsExpected + ' warmup=' + q.warmupBars + ' gaps=' +
                        (q.gaps ? q.gaps.length : 'n/a') + ' futuresOnly=' + q.futuresOnly + ' -> ' +
                        (result.REPLAY_VALID ? 'REPLAY_VALID' : 'REPLAY_INVALID ' + result.reason));
                });
        });
    });
    return chain.then(function () {
        networkIncidents = guard.release();
        if (networkIncidents.length) {
            console.log('NETWORK_INCIDENTS=' + networkIncidents.length +
                ' (transient proxy/agent faults swallowed; data completeness is the real gate)');
        }
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
            version: networkPrepMod.VERSION, runStamp: runStamp, window: window, days: days,
            symbols: symbols, maxAttempts: maxAttempts,
            cacheDir: path.relative(ROOT, cache.dir()),
            networkIncidents: networkIncidents,
            perSymbol: symbols.map(function (symbol) {
                var p = prepared[symbol];
                return { symbol: symbol, REPLAY_VALID: p.REPLAY_VALID, reason: p.reason,
                    quality: p.quality, attempts: p.attempts,
                    symbolRulesSource: p.symbolRules ? p.symbolRules.source : null,
                    cacheKeys: { klines: networkPrepMod.klinesCacheKey(symbol, p.fetchStart,
                        p.fetchEnd), rules: networkPrepMod.rulesCacheKey(symbol) } };
            })
        }, null, 1));
        if (networkOnly) {
            console.log('');
            console.log('NETWORK_ONLY=true  NETWORK_PHASE_COMPLETE=true  REPLAY_SKIPPED=true');
            console.log('run phase 2 offline with: --replayOnly --days=' + days + ' --endTime=' +
                window.endTime + (symbolsArg.trim() ? ' --symbols=' + symbols.join(',') : '') +
                ' (same artifact dir is reused only when it is the newest; pass --replayOnly with ' +
                'no network available to prove the separation)');
            console.log('ARTIFACT_DIR=' + path.relative(ROOT, outDir));
            return null;
        }
        console.log('');
        return runReplayPhase();
    });
}

// --------------------------------------------------------------- totals

function emptyTotals() {
    return { candidates: 0, candidatesInWindow: 0, eqToleranceMatches: 0, pathPass: 0,
        pathReject: 0, pathUnknown: 0, setupsBefore: 0, setupsAfter: 0, partnerUnchanged: 0,
        partnerReplaced: 0, setupRemoved: 0, setupCreatedByPathFilter: 0,
        planPreserved: 0, planLost: 0 };
}
function addTotals(total, counts) {
    Object.keys(total).forEach(function (key) {
        if (typeof counts[key] === 'number') total[key] += counts[key];
    });
}
function mergeUnknownReasons(perSymbol) {
    var out = { MISSING_INTERMEDIATE_BARS: 0, MISSING_PROVENANCE: 0, FUTURE_DATA: 0, OTHER: 0 };
    perSymbol.forEach(function (r) {
        Object.keys(r.unknownReasons).forEach(function (k) {
            out[k] = (out[k] || 0) + r.unknownReasons[k]; });
    });
    return out;
}

// -------------------------------------------------------------- §6 anchors

function resolveRealAnchors(perSymbol) {
    var out = {};
    Object.keys(REAL_ANCHORS).forEach(function (key) {
        var spec = REAL_ANCHORS[key];
        var hit = null, scannedSymbols = [];
        perSymbol.forEach(function (r) {
            scannedSymbols.push(r.symbol);
            if (r.symbol !== spec.symbol) return;
            r.samples.forEach(function (s) { if (s.twoBarId === spec.twoBarId) hit = s; });
        });
        if (!hit) {
            out[key] = { label: spec.label, twoBarId: spec.twoBarId, symbol: spec.symbol,
                found: false, scannedSymbols: scannedSymbols,
                reason: 'TWO_BAR_NOT_IN_REPLAY_WINDOW_OR_EQ_STAGE' };
            return;
        }
        var oldEval = hit.evaluations.filter(function (e) {
            return e.partnerId === hit.flags.oldPartnerId; })[0] || null;
        out[key] = {
            label: spec.label, symbol: spec.symbol, direction: hit.direction,
            twoBarId: hit.twoBarId, found: true,
            k1BJT: bjt(hit.k1OpenTime), k2BJT: bjt(hit.k2OpenTime),
            confirmedAtBJT: bjt(hit.confirmedAt),
            twoBarLow: hit.twoBarLow, twoBarHigh: hit.twoBarHigh, twoBarExtreme: hit.twoBarExtreme,
            atr: hit.atrAtConfirmation, eqTolerance: hit.eqTolerance,
            setupBefore: hit.flags.setupBefore, setupAfter: hit.flags.setupAfter,
            partnerUnchanged: hit.flags.partnerUnchanged,
            partnerReplaced: hit.flags.partnerReplaced, setupRemoved: hit.flags.setupRemoved,
            oldPartner: oldEval ? { id: oldEval.partnerId, price: oldEval.partnerPrice,
                pathStatus: oldEval.status, pathReason: oldEval.reason,
                boundary: oldEval.boundary, violatingBarOpenTimeBJT: bjt(oldEval.violatingBarOpenTime),
                violatingLow: oldEval.violatingLow, violatingHigh: oldEval.violatingHigh,
                intermediateBarCount: oldEval.intermediateBarCount } : null,
            newPartner: hit.after.ok ? { id: hit.after.partnerId, price: hit.after.partnerPrice } : null,
            before: hit.before, after: hit.after,
            planPreserved: Boolean(hit.before.ok && hit.after.ok),
            evaluations: hit.evaluations,
            expect: spec.expect
        };
    });
    return out;
}

// ------------------------------------------------- §4/§5 detail collectors

function collectReplacements(perSymbol) {
    var out = [];
    perSymbol.forEach(function (r) {
        r.samples.forEach(function (s) {
            if (!s.flags.partnerReplaced) return;
            var oldEval = s.evaluations.filter(function (e) {
                return e.partnerId === s.flags.oldPartnerId; })[0] || null;
            var newEval = s.evaluations.filter(function (e) {
                return e.partnerId === s.flags.newPartnerId; })[0] || null;
            out.push({
                symbol: s.symbol, twoBarId: s.twoBarId, direction: s.direction,
                k1BJT: bjt(s.k1OpenTime), k2BJT: bjt(s.k2OpenTime),
                confirmedAtBJT: bjt(s.confirmedAt), confirmedAt: s.confirmedAt,
                oldPartnerId: s.flags.oldPartnerId,
                oldPartnerPrice: oldEval ? oldEval.partnerPrice : null,
                oldBoundary: oldEval ? oldEval.boundary : null,
                violatingBarTime: oldEval ? bjt(oldEval.violatingBarOpenTime) : null,
                violatingBarOpenTime: oldEval ? oldEval.violatingBarOpenTime : null,
                violatingExtreme: oldEval
                    ? (s.direction === 'BULLISH' ? oldEval.violatingLow : oldEval.violatingHigh) : null,
                oldPathStatus: oldEval ? oldEval.status : null,
                oldPathReason: oldEval ? oldEval.reason : null,
                newPartnerId: s.flags.newPartnerId,
                newPartnerPrice: newEval ? newEval.partnerPrice : null,
                newBoundary: newEval ? newEval.boundary : null,
                newPathStatus: newEval ? newEval.status : null,
                newPathReason: newEval ? newEval.reason : null,
                oldSL: s.before.initialSL, newSL: s.after.initialSL,
                oldTP: s.before.initialTP, newTP: s.after.initialTP,
                oldRR: s.before.initialRR, newRR: s.after.initialRR,
                entryTrigger: s.before.entryTrigger
            });
        });
    });
    out.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    return out;
}

function collectRemovals(perSymbol) {
    var out = [];
    perSymbol.forEach(function (r) {
        r.samples.forEach(function (s) {
            if (!s.flags.setupRemoved) return;
            var oldEval = s.evaluations.filter(function (e) {
                return e.partnerId === s.flags.oldPartnerId; })[0] || null;
            out.push({
                symbol: s.symbol, twoBarId: s.twoBarId, direction: s.direction,
                k1BJT: bjt(s.k1OpenTime), k2BJT: bjt(s.k2OpenTime),
                confirmedAtBJT: bjt(s.confirmedAt), confirmedAt: s.confirmedAt,
                oldPartnerId: s.flags.oldPartnerId,
                oldPartnerPrice: oldEval ? oldEval.partnerPrice : null,
                boundary: oldEval ? oldEval.boundary : null,
                violatingBarTime: oldEval ? bjt(oldEval.violatingBarOpenTime) : null,
                violatingExtreme: oldEval
                    ? (s.direction === 'BULLISH' ? oldEval.violatingLow : oldEval.violatingHigh) : null,
                reason: oldEval ? oldEval.reason : null,
                pathStatus: oldEval ? oldEval.status : null,
                candidateCount: s.partnerCountBefore,
                allCandidates: s.evaluations.map(function (e) {
                    return { partnerId: e.partnerId, partnerPrice: e.partnerPrice,
                        status: e.status, reason: e.reason, boundary: e.boundary }; }),
                oldEntry: s.before.entryTrigger,
                oldSL: s.before.initialSL, oldTP: s.before.initialTP, oldRR: s.before.initialRR,
                oldPlanOk: s.before.ok, oldPlanReasonCode: s.before.reasonCode
            });
        });
    });
    out.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    return out;
}

/**
 * §6 machine-checkable REAL regression gate. Each anchor carries the frozen expectation on the
 * fields that define it; this compares the replay's outcome against it field by field, so the
 * gate cannot be passed by eyeballing a console line.
 */
function evaluateAnchorGate(realAnchors) {
    var anchors = Object.keys(realAnchors).map(function (key) {
        var a = realAnchors[key];
        var spec = a.expect || {};
        var checks = [];
        function eq(field, actual, expected) {
            if (expected === undefined) return;
            checks.push({ field: field, actual: actual, expected: expected, ok: actual === expected });
        }
        eq('setupBefore', a.setupBefore, spec.setupBefore);
        eq('setupAfter', a.setupAfter, spec.setupAfter);
        eq('partnerUnchanged', a.partnerUnchanged, spec.partnerUnchanged);
        eq('partnerReplaced', a.partnerReplaced, spec.partnerReplaced);
        eq('planPreserved', a.planPreserved, spec.planPreserved);
        eq('oldPartnerPrice', a.oldPartner ? a.oldPartner.price : null, spec.oldPartnerPrice);
        eq('newPartnerPrice', a.newPartner ? a.newPartner.price : null, spec.newPartnerPrice);
        eq('newRR', a.after && a.after.ok ? a.after.initialRR : null, spec.newRR);
        return { label: a.label, found: a.found, checks: checks,
            PASS: a.found === true && checks.every(function (c) { return c.ok; }) };
    });
    return { anchors: anchors, PASS: anchors.every(function (x) { return x.PASS; }) };
}

/**
 * A canonical, timing-free projection of everything the replay concluded. `elapsedMs` is the only
 * field that varies between two runs on identical data, so hashing the projection gives a
 * re-runnable determinism check that does not require stripping diagnostics by hand.
 */
function semanticProjection(summary, perSymbol) {
    return {
        window: summary.window, symbols: summary.symbols, sweepMode: summary.sweepMode.mode,
        counts: summary.counts, invalidSymbols: summary.invalidSymbols,
        perSymbol: perSymbol.map(function (r) {
            return { symbol: r.symbol, counts: r.counts, unknownReasons: r.unknownReasons,
                quality: r.quality };
        }),
        unknownReasons: summary.unknownReasons, unknownDetail: summary.unknownDetail,
        replacements: summary.replacements, removals: summary.removals,
        realAnchors: summary.realAnchors, anchorGate: summary.anchorGate,
        offlineGuard: summary.offlineGuard, frozenRules: summary.frozenRules,
        verdict: summary.verdict
    };
}

function semanticDigest(summary, perSymbol) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(semanticProjection(summary, perSymbol)))
        .digest('hex');
}

// ---------------------------------------------------------------- verdict

function classifyVerdict(summary) {
    if (summary.symbols.length > 0 && summary.invalidSymbols.length === summary.symbols.length) {
        return 'REPLAY_INVALID';
    }
    if (summary.counts.candidatesInWindow === 0) return 'REPLAY_INVALID';
    if (summary.counts.setupCreatedByPathFilter > 0) return 'REPLAY_INVALID';
    if (summary.counts.pathUnknown > 0 &&
            summary.counts.pathUnknown > (summary.counts.pathPass + summary.counts.pathReject)) {
        return 'REPLAY_INVALID';
    }
    return 'REPLAY_OK';
}

// -------------------------------------------------------------- artifacts

function writeArtifacts(outDir, summary, perSymbol, prepared, window, runStamp) {
    fs.mkdirSync(outDir, { recursive: true });
    var allSamples = [];
    perSymbol.forEach(function (r) {
        r.samples.forEach(function (s) {
            allSamples.push({ symbol: s.symbol, direction: s.direction, twoBarId: s.twoBarId,
                k1OpenTime: s.k1OpenTime, k2OpenTime: s.k2OpenTime, confirmedAt: s.confirmedAt,
                twoBarLow: s.twoBarLow, twoBarHigh: s.twoBarHigh, twoBarExtreme: s.twoBarExtreme,
                extremeBar: s.extremeBar, atrAtConfirmation: s.atrAtConfirmation,
                eqTolerance: s.eqTolerance, partnerCountBefore: s.partnerCountBefore,
                partnerCountAfter: s.partnerCountAfter,
                evaluations: s.evaluations, before: s.before, after: s.after, flags: s.flags });
        });
    });
    fs.writeFileSync(path.join(outDir, 'samples.json'),
        JSON.stringify({ version: offlineReplay.VERSION, runStamp: runStamp, window: window,
            sampleCount: allSamples.length, samples: allSamples }, null, 1));
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
    fs.writeFileSync(path.join(outDir, 'data-quality.json'), JSON.stringify({
        version: runStamp, window: window,
        symbols: summary.symbols.map(function (symbol) {
            var p = prepared[symbol];
            return { symbol: symbol, REPLAY_VALID: p.REPLAY_VALID, reason: p.reason,
                quality: p.quality,
                symbolRules: p.symbolRules ? { source: p.symbolRules.source,
                    tickSize: p.symbolRules.tickSize, stepSize: p.symbolRules.stepSize,
                    minQty: p.symbolRules.minQty,
                    minNotional: p.symbolRules.minNotional } : null };
        }),
        counts: summary.counts, unknownReasons: summary.unknownReasons,
        networkIncidents: summary.networkIncidents
    }, null, 1));

    var header = ['symbol', 'direction', 'twoBarId', 'k1BJT', 'k2BJT', 'confirmedAtBJT',
        'atr', 'eqTolerance', 'partnerCountBefore', 'partnerCountAfter',
        'oldPartnerId', 'oldPartnerPrice', 'newPartnerId', 'newPartnerPrice',
        'setupBefore', 'setupAfter', 'partnerReplaced', 'setupRemoved',
        'oldPathStatus', 'newPathStatus', 'entryTrigger', 'beforeSL', 'afterSL',
        'beforeTP', 'afterTP', 'beforeRR', 'afterRR'];
    var lines = [header.join(',')];
    allSamples.forEach(function (s) {
        var oldEval = s.evaluations.filter(function (e) {
            return e.partnerId === s.flags.oldPartnerId; })[0] || null;
        var newEval = s.evaluations.filter(function (e) {
            return e.partnerId === s.flags.newPartnerId; })[0] || null;
        lines.push([s.symbol, s.direction, s.twoBarId, bjt(s.k1OpenTime), bjt(s.k2OpenTime),
            bjt(s.confirmedAt), s.atrAtConfirmation, s.eqTolerance, s.partnerCountBefore,
            s.partnerCountAfter, s.flags.oldPartnerId, oldEval ? oldEval.partnerPrice : null,
            s.flags.newPartnerId, newEval ? newEval.partnerPrice : null,
            s.flags.setupBefore, s.flags.setupAfter, s.flags.partnerReplaced, s.flags.setupRemoved,
            oldEval ? oldEval.status : null, newEval ? newEval.status : null,
            s.before.entryTrigger, s.before.initialSL, s.after.initialSL,
            s.before.initialTP, s.after.initialTP, s.before.initialRR, s.after.initialRR
        ].map(csvCell).join(','));
    });
    fs.writeFileSync(path.join(outDir, 'samples.csv'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'report.md'),
        renderReport(summary, prepared, allSamples, window));
}

// ---------------------------------------------------------------- report

function planLine(p) {
    if (!p || !p.ok) return 'NO PLAN (' + ((p && p.reasonCode) || 'n/a') + ')';
    return 'partner=' + p.partnerId + ' price=' + p.partnerPrice + ' entry=' + p.entryTrigger +
        ' SL=' + p.initialSL + ' TP=' + p.initialTP + ' RR=' + p.initialRR;
}

function renderReport(summary, prepared, allSamples, window) {
    var L = [];
    var c = summary.counts;
    L.push('# CROSS_SOURCE_PATH_INTEGRITY_V1 — SHADOW REPLAY');
    L.push('');
    L.push('Read-only. No production file was modified, no LLM was called, no order route exists.');
    L.push('');
    L.push('| | |');
    L.push('|---|---|');
    L.push('| window | ' + summary.window.startBJT + ' → ' + summary.window.endBJT + ' UTC+8 (' +
        summary.window.days + 'D, ' + summary.window.bars + ' bars) |');
    L.push('| symbols | ' + summary.symbols.join(', ') + ' |');
    L.push('| rule | ' + summary.frozenRules.pathIntegrity + ' (frozen) |');
    L.push('| sweep mode (precondition) | **' + summary.sweepMode.mode + '** |');
    L.push('| verdict | **' + summary.verdict + '** |');
    L.push('| offline replay | market-data modules absent=' + summary.offlineGuard.marketDataModulesAbsent +
        ', tripwire armed=' + summary.offlineGuard.tripwireArmed +
        ', HTTP call attempts during replay=' + summary.offlineGuard.networkCallAttempts +
        ' (inert LLM/http modules loaded: ' + summary.offlineGuard.inertNetModules.length + ') |');
    L.push('| samples (CSV rows) | ' + allSamples.length + ' |');
    L.push('| semantic digest (timing-free) | `' + summary.semanticDigest + '` |');
    L.push('');
    L.push('## §1 Data quality');
    L.push('');
    L.push('| symbol | bars | window | warmup | gaps | futuresOnly | verdict |');
    L.push('|---|---|---|---|---|---|---|');
    summary.symbols.forEach(function (symbol) {
        var p = prepared[symbol];
        var q = p.quality || {};
        L.push('| ' + symbol + ' | ' + q.barCount + ' | ' + q.windowBars + '/' + q.windowBarsExpected +
            ' | ' + q.warmupBars + ' | ' + (q.gaps ? q.gaps.length : 'n/a') + ' | ' + q.futuresOnly +
            ' | ' + (p.REPLAY_VALID ? 'REPLAY_VALID' : '**REPLAY_INVALID** ' + (p.reason || '')) + ' |');
    });
    L.push('');
    if (summary.networkIncidents.length) {
        L.push('Network incidents swallowed by the phase-1 guard: ' + summary.networkIncidents.length +
            ' (completeness, not exception-freedom, is the gate).');
        L.push('');
    }
    L.push('## §2 Population — identical for both arms');
    L.push('');
    L.push('| symbol | EQ-stage candidates | EQ tolerance matches | PATH PASS | PATH FAIL | PATH UNKNOWN |');
    L.push('|---|---|---|---|---|---|');
    summary.perSymbol.forEach(function (r) {
        L.push('| ' + r.symbol + ' | ' + r.counts.candidatesInWindow + ' | ' +
            r.counts.eqToleranceMatches + ' | ' + r.counts.pathPass + ' | ' + r.counts.pathReject +
            ' | ' + r.counts.pathUnknown + ' |');
    });
    L.push('| **TOTAL** | ' + c.candidatesInWindow + ' | ' + c.eqToleranceMatches + ' | ' +
        c.pathPass + ' | ' + c.pathReject + ' | ' + c.pathUnknown + ' |');
    L.push('');
    L.push('Every candidate is evaluated under BOTH arms on two independently advanced Causal ' +
        'Dynamic-D states; the replay aborts on any arm divergence (partner list or ATR).');
    L.push('');
    L.push('## §3 Setups before vs after');
    L.push('');
    L.push('| symbol | SETUP_BEFORE | SETUP_AFTER | PARTNER_UNCHANGED | PARTNER_REPLACED | SETUP_REMOVED | CREATED_BY_PATH_FILTER |');
    L.push('|---|---|---|---|---|---|---|');
    summary.perSymbol.forEach(function (r) {
        var k = r.counts;
        L.push('| ' + r.symbol + ' | ' + k.setupsBefore + ' | ' + k.setupsAfter + ' | ' +
            k.partnerUnchanged + ' | ' + k.partnerReplaced + ' | ' + k.setupRemoved + ' | ' +
            k.setupCreatedByPathFilter + ' |');
    });
    L.push('| **TOTAL** | ' + c.setupsBefore + ' | ' + c.setupsAfter + ' | ' + c.partnerUnchanged +
        ' | ' + c.partnerReplaced + ' | ' + c.setupRemoved + ' | ' + c.setupCreatedByPathFilter + ' |');
    L.push('');
    L.push('`SETUP_CREATED_BY_PATH_FILTER=' + c.setupCreatedByPathFilter +
        '` (must be 0 — the filter can only remove candidates)');
    L.push('');
    L.push('Plans preserved (both arms produced a full plan): ' + c.planPreserved +
        '; plans lost (before ok, after not ok): ' + c.planLost);
    L.push('');
    L.push('## §4 Replacement detail (' + summary.replacements.length + ')');
    L.push('');
    if (summary.replacements.length === 0) L.push('_none_');
    summary.replacements.forEach(function (r, i) {
        L.push('### [' + (i + 1) + '] ' + r.symbol + ' ' + r.direction + ' ' + r.confirmedAtBJT + ' UTC+8');
        L.push('');
        L.push('| field | old partner (FAIL) | new partner (PASS) |');
        L.push('|---|---|---|');
        L.push('| id | `' + r.oldPartnerId + '` | `' + r.newPartnerId + '` |');
        L.push('| price | ' + r.oldPartnerPrice + ' | ' + r.newPartnerPrice + ' |');
        L.push('| boundary | ' + r.oldBoundary + ' | ' + r.newBoundary + ' |');
        L.push('| path | ' + r.oldPathStatus + '/' + r.oldPathReason + ' | ' + r.newPathStatus + '/' +
            r.newPathReason + ' |');
        L.push('| initial SL | ' + r.oldSL + ' | ' + r.newSL + ' |');
        L.push('| initial TP | ' + r.oldTP + ' | ' + r.newTP + ' |');
        L.push('| initial RR | ' + r.oldRR + ' | ' + r.newRR + ' |');
        L.push('');
        L.push('twoBarId=`' + r.twoBarId + '` entryTrigger=' + r.entryTrigger +
            ' violatingBar=' + r.violatingBarTime + ' violatingExtreme=' + r.violatingExtreme);
        L.push('');
    });
    L.push('## §5 Removed setups (' + summary.removals.length + ')');
    L.push('');
    if (summary.removals.length === 0) L.push('_none_');
    summary.removals.forEach(function (r, i) {
        L.push('### [' + (i + 1) + '] ' + r.symbol + ' ' + r.direction + ' ' + r.confirmedAtBJT + ' UTC+8');
        L.push('');
        L.push('- twoBarId: `' + r.twoBarId + '`');
        L.push('- old partner: `' + r.oldPartnerId + '` price=' + r.oldPartnerPrice +
            ' boundary=' + r.boundary);
        L.push('- violation: ' + r.reason + ' at ' + r.violatingBarTime + ' (extreme ' +
            r.violatingExtreme + ')');
        L.push('- candidates evaluated: ' + r.candidateCount + ' — all rejected:');
        r.allCandidates.forEach(function (a) {
            L.push('  - `' + a.partnerId + '` price=' + a.partnerPrice + ' → ' + a.status + '/' +
                a.reason + ' (boundary ' + a.boundary + ')');
        });
        L.push('- would-have-been plan: entry=' + r.oldEntry + ' SL=' + r.oldSL + ' TP=' + r.oldTP +
            ' RR=' + r.oldRR + ' (planOk=' + r.oldPlanOk +
            (r.oldPlanReasonCode ? ', reasonCode=' + r.oldPlanReasonCode : '') + ')');
        L.push('');
    });
    L.push('## §6 REAL regression anchors');
    L.push('');
    L.push('`REAL_REGRESSION_GATE=' + (summary.anchorGate.PASS ? 'PASS' : 'FAIL') + '`');
    L.push('');
    Object.keys(summary.realAnchors).forEach(function (key) {
        var a = summary.realAnchors[key];
        L.push('### ' + a.label);
        L.push('');
        if (!a.found) {
            L.push('NOT FOUND — `' + a.twoBarId + '` (' + a.reason + ')');
            L.push('');
            return;
        }
        L.push('- twoBarId: `' + a.twoBarId + '` (' + a.direction + ')');
        L.push('- K1 ' + a.k1BJT + ' / K2 ' + a.k2BJT + ' / confirmedAt ' + a.confirmedAtBJT + ' UTC+8');
        L.push('- SETUP_BEFORE=' + a.setupBefore + ' SETUP_AFTER=' + a.setupAfter +
            ' PARTNER_UNCHANGED=' + a.partnerUnchanged + ' PARTNER_REPLACED=' + a.partnerReplaced +
            ' SETUP_REMOVED=' + a.setupRemoved);
        if (a.oldPartner) {
            L.push('- old partner `' + a.oldPartner.id + '` price=' + a.oldPartner.price + ' → ' +
                a.oldPartner.pathStatus + '/' + a.oldPartner.pathReason + ' (boundary ' +
                a.oldPartner.boundary + ', violating bar ' + a.oldPartner.violatingBarOpenTimeBJT + ')');
        }
        if (a.newPartner) {
            L.push('- new partner `' + a.newPartner.id + '` price=' + a.newPartner.price);
        }
        L.push('- before: ' + planLine(a.before));
        L.push('- after:  ' + planLine(a.after));
        L.push('- EXECUTION_PLAN_PRESERVED=' + a.planPreserved);
        L.push('');
    });
    L.push('| anchor | field | expected | actual | ok |');
    L.push('|---|---|---|---|---|');
    summary.anchorGate.anchors.forEach(function (g) {
        if (!g.found) { L.push('| ' + g.label + ' | (two-bar not found) | - | - | **false** |'); return; }
        g.checks.forEach(function (c) {
            L.push('| ' + g.label + ' | ' + c.field + ' | ' + c.expected + ' | ' + c.actual +
                ' | ' + c.ok + ' |');
        });
    });
    L.push('');
    L.push('## §7 PATH_UNKNOWN');
    L.push('');
    L.push('| reason | count |');
    L.push('|---|---|');
    Object.keys(summary.unknownReasons).forEach(function (k) {
        L.push('| ' + k + ' | ' + summary.unknownReasons[k] + ' |');
    });
    L.push('');
    if (summary.unknownDetail.length === 0) {
        L.push('`PATH_UNKNOWN=0` — every evaluated pair was decided; fail-closed never triggered.');
    } else {
        L.push('Each UNKNOWN is listed (fail-closed: treated as NOT pass):');
        L.push('');
        L.push('| symbol | twoBarId | partner | classified | rule reason | anchor | K1 | bars |');
        L.push('|---|---|---|---|---|---|---|---|');
        summary.unknownDetail.forEach(function (u) {
            L.push('| ' + u.symbol + ' | `' + u.twoBarId + '` | ' + u.partnerId + '/' +
                u.partnerPrice + ' | ' + u.classified + ' | ' + u.reason + ' | ' +
                u.anchorOccurredAtBJT + ' | ' + u.k1OpenTimeBJT + ' | ' + u.intermediateBarCount + ' |');
        });
    }
    L.push('');
    L.push('## §8 Method notes');
    L.push('');
    L.push('- ' + summary.llm.note);
    L.push('- HTF gate: ' + summary.htfGate.note);
    L.push('- Contract price: ' + summary.contractPrice.note);
    L.push('- `matchDynamicDPartners` MUTATES its state (`AGE_EXPIRY` / `STRICT_CROSS`). The sweep ' +
        'semantics is therefore an explicit precondition of this run, not a side effect: **' +
        summary.sweepMode.mode + '**. ' + summary.sweepMode.note);
    L.push('- The detector is a pure function of the whole series, exactly as the production ' +
        'pipeline calls it on each closed bar, so one pass grouped by `endIndex` is equivalent.');
    L.push('');
    L.push('```');
    L.push('CROSS_SOURCE_PATH_INTEGRITY_V1_REPLAY_COMPLETE=true');
    L.push('VERDICT=' + summary.verdict);
    L.push('REAL_REGRESSION_GATE=' + (summary.anchorGate.PASS ? 'PASS' : 'FAIL'));
    L.push('TOTAL_ALIGNED=' + c.candidatesInWindow);
    L.push('TOTAL_SETUP_BEFORE=' + c.setupsBefore);
    L.push('TOTAL_SETUP_AFTER=' + c.setupsAfter);
    L.push('SETUP_CREATED_BY_PATH_FILTER=' + c.setupCreatedByPathFilter);
    L.push('PRODUCTION_CHANGED=false');
    L.push('PRODUCTION_DEPLOYED=false');
    L.push('REAL_ORDER_MUTATION_COUNT=0');
    L.push('```');
    return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- console

function printSummary(summary, replacements, removals, unknownDetail) {
    var c = summary.counts;
    console.log('');
    console.log('--- §3 STATS ---');
    summary.perSymbol.forEach(function (r) {
        var k = r.counts;
        console.log(r.symbol + '_2D: aligned=' + k.candidatesInWindow + ' setupBefore=' + k.setupsBefore +
            ' setupAfter=' + k.setupsAfter + ' pathPass=' + k.pathPass + ' pathReject=' + k.pathReject +
            ' pathUnknown=' + k.pathUnknown + ' partnerReplaced=' + k.partnerReplaced +
            ' setupRemoved=' + k.setupRemoved);
    });
    console.log('TOTAL: aligned=' + c.candidatesInWindow + ' setupBefore=' + c.setupsBefore +
        ' setupAfter=' + c.setupsAfter + ' pathPass=' + c.pathPass + ' pathReject=' + c.pathReject +
        ' pathUnknown=' + c.pathUnknown + ' partnerReplaced=' + c.partnerReplaced +
        ' setupRemoved=' + c.setupRemoved + ' setupCreatedByPathFilter=' + c.setupCreatedByPathFilter);
    console.log('');
    console.log('--- §6 REAL anchors ---');
    Object.keys(summary.realAnchors).forEach(function (key) {
        var a = summary.realAnchors[key];
        if (!a.found) { console.log(a.label + ': NOT FOUND'); return; }
        console.log(a.label + ': setupBefore=' + a.setupBefore + ' setupAfter=' + a.setupAfter +
            ' partnerReplaced=' + a.partnerReplaced + ' planPreserved=' + a.planPreserved +
            (a.newPartner ? ' newPartnerPrice=' + a.newPartner.price : '') +
            (a.after.ok ? ' newRR=' + a.after.initialRR : ''));
    });
    console.log('REAL_REGRESSION_GATE=' + (summary.anchorGate.PASS ? 'PASS' : 'FAIL'));
    if (!summary.anchorGate.PASS) {
        summary.anchorGate.anchors.forEach(function (g) {
            g.checks.filter(function (c) { return !c.ok; }).forEach(function (c) {
                console.log('   ANCHOR_MISMATCH ' + g.label + ' ' + c.field +
                    ': expected ' + c.expected + ', got ' + c.actual);
            });
        });
    }
    if (replacements.length) {
        console.log('');
        console.log('--- §4 replacements (' + replacements.length + ') ---');
        replacements.forEach(function (r) {
            console.log(r.symbol + ' ' + r.confirmedAtBJT + ' ' + r.oldPartnerPrice + '->' +
                r.newPartnerPrice + ' SL ' + r.oldSL + '->' + r.newSL + ' RR ' + r.oldRR + '->' + r.newRR);
        });
    }
    if (removals.length) {
        console.log('');
        console.log('--- §5 removed setups (' + removals.length + ') ---');
        removals.forEach(function (r) {
            console.log(r.symbol + ' ' + r.confirmedAtBJT + ' partner=' + r.oldPartnerPrice + ' ' +
                r.reason + ' @' + r.violatingBarTime + ' (would-be RR ' + r.oldRR + ')');
        });
    }
    if (unknownDetail.length) {
        console.log('');
        console.log('--- §7 PATH_UNKNOWN detail (' + unknownDetail.length + ') ---');
        unknownDetail.forEach(function (u) {
            console.log(u.symbol + ' ' + u.twoBarId + ' partner=' + u.partnerId + '/' +
                u.partnerPrice + ' classified=' + u.classified + ' ruleReason=' + u.reason);
        });
    }
    console.log('');
    console.log('VERDICT=' + summary.verdict);
    console.log('SEMANTIC_DIGEST=' + summary.semanticDigest +
        '  (stable across re-runs on identical data; only elapsedMs is excluded)');
    console.log('ARTIFACT_DIR=' + summary.artifactDir);
}

module.exports = {
    main: main,
    REAL_ANCHORS: REAL_ANCHORS,
    NETWORK_MODULE_TOKENS: NETWORK_MODULE_TOKENS,
    MARKET_DATA_MODULE_TOKENS: MARKET_DATA_MODULE_TOKENS,
    INERT_NETWORK_TOKENS: INERT_NETWORK_TOKENS,
    armOfflineGuard: armOfflineGuard,
    assertOffline: assertOffline,
    requireClosure: requireClosure,
    classifyVerdict: classifyVerdict,
    renderReport: renderReport,
    resolveRealAnchors: resolveRealAnchors,
    evaluateAnchorGate: evaluateAnchorGate,
    collectReplacements: collectReplacements,
    collectRemovals: collectRemovals,
    emptyTotals: emptyTotals,
    addTotals: addTotals,
    semanticProjection: semanticProjection,
    semanticDigest: semanticDigest
};

if (require.main === module) {
    Promise.resolve().then(main).then(function () {
        console.log('');
        console.log('CROSS_SOURCE_PATH_INTEGRITY_V1_REPLAY_COMPLETE=true');
        console.log('PRODUCTION_CHANGED=false');
        console.log('PRODUCTION_DEPLOYED=false');
        console.log('REAL_ORDER_MUTATION_COUNT=0');
    }).catch(function (error) {
        console.error('REPLAY_ERROR ' + (error && error.stack || error));
        process.exitCode = 1;
    });
}
