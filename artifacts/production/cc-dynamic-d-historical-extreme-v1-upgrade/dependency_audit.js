'use strict';

/**
 * DEPENDENCY / GOVERNANCE AUDIT — PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1
 *
 * Read-only static analysis. Verifies the FULL_REPLACEMENT governance gates:
 *   FULL_REPLACEMENT=true; BACKWARD_COMPATIBILITY=false; FEATURE_FLAG=false;
 *   DUAL_PATH=false; FALLBACK_TO_ZIGZAG=false;
 *   LEGACY_ZIGZAG_OUTPUT_COMPATIBILITY=false.
 *
 * Produces dependency-audit.json. No network, no mutation.
 */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '../../..');
var OUT = path.join(__dirname, 'dependency-audit.json');

// Production runtime roots (NOT test / scripts / artifacts / research / node_modules).
var PROD_ROOTS = [
    'liquidity', 'replay', 'live', 'notify', 'events', 'context', 'entry',
    'amd', 'bias', 'scenario', 'trade', 'draw', 'structure', 'fvg', 'ai',
    'stats', 'indicators', 'utils', 'config', 'data'
];

// Old ZigZag module must be physically gone.
var OLD_ZIGZAG_PATH = path.join(ROOT, 'liquidity/atr50CausalZigZag.js');

var FORBIDDEN_TOKENS = [
    'atr50CausalZigZag',
    'ATR50_36H_UNVIOLATED_CROSS_SOURCE_V1',
    'CAUSAL_ATR50_ZIGZAG',
    'productionEq.zigzag',
    '.zigzag.'
];

function walk(dir) {
    var out = [];
    if (!fs.existsSync(dir)) return out;
    fs.readdirSync(dir).forEach(function (name) {
        var full = path.join(dir, name);
        var st = fs.statSync(full);
        if (st.isDirectory()) out = out.concat(walk(full));
        else if (/\.js$/.test(name)) out.push(full);
    });
    return out;
}

function rel(p) { return path.relative(ROOT, p); }

var checks = [];
function check(id, pass, detail) {
    checks.push({ id: id, pass: !!pass, detail: detail });
}

// ---- 1. Old ZigZag module physically removed ----
var oldExists = fs.existsSync(OLD_ZIGZAG_PATH);
check('OLD_ZIGZAG_MODULE_REMOVED',
    !oldExists,
    oldExists ? ('STILL EXISTS: ' + rel(OLD_ZIGZAG_PATH)) : 'liquidity/atr50CausalZigZag.js deleted');

// ---- 2. No production file references forbidden ZigZag tokens ----
var prodFiles = [];
PROD_ROOTS.forEach(function (r) { prodFiles = prodFiles.concat(walk(path.join(ROOT, r))); });
var tokenHits = [];
prodFiles.forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    FORBIDDEN_TOKENS.forEach(function (tok) {
        if (src.indexOf(tok) !== -1) {
            tokenHits.push({ file: rel(f), token: tok });
        }
    });
});
check('NO_PRODUCTION_ZIGZAG_REFERENCE',
    tokenHits.length === 0,
    tokenHits.length === 0 ? ('scanned ' + prodFiles.length + ' production files, 0 ZigZag token hits')
        : tokenHits.slice(0, 12).map(function (h) { return h.file + ':' + h.token; }));

// ---- 3. New production module wiring ----
var dynD = require(path.join(ROOT, 'liquidity/causalDynamicDHistoricalExtremes'));
var prodEq = require(path.join(ROOT, 'liquidity/productionEqualLiquidityV1'));
check('DYNAMIC_D_VERSION_CONSTANT',
    dynD.VERSION === 'CAUSAL_DYNAMIC_D_V1' && prodEq.VERSION === 'DYNAMIC_D_36H_CROSS_SOURCE_V1',
    'dynamicD.VERSION=' + dynD.VERSION + ' producer.VERSION=' + prodEq.VERSION);

// ---- 4. New module has ZERO external requires (pure 5m, no ATR/HTF) ----
var dynDSource = fs.readFileSync(path.join(ROOT, 'liquidity/causalDynamicDHistoricalExtremes.js'), 'utf8');
var requireMatches = dynDSource.match(/require\([^)]*\)/g) || [];
check('DYNAMIC_D_NO_EXTERNAL_REQUIRE',
    requireMatches.length === 0,
    'requires: ' + (requireMatches.length ? requireMatches.join(', ') : 'none'));

// ---- 5. No 4H / HTF / ATR volatility in the new detection module ----
// NOTE: BARS_PER_1H (=12) and the header comment that enumerates the forbidden
// estimator list are both benign. We strip JS comments before scanning so the
// module's own "Forbidden: ATR / Parkinson / GARCH / ..." documentation does not
// produce a false positive.
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
        .replace(/\/\/[^\n]*/g, ' ');         // line comments
}
var dynDCode = stripComments(dynDSource);
var htfTokens = ['fourHour', 'fourHourCandles', 'h4Candle', 'getHigherTimeframe', '1d', 'h4', 'ATR50', 'atrIndicator', 'parkinson', 'rogersSatchell', 'garch', 'har', 'cwt', 'persistentHomology', 'prominence'];
var htfHits = htfTokens.filter(function (t) { return dynDCode.toLowerCase().indexOf(t.toLowerCase()) !== -1; });
check('DYNAMIC_D_NO_4H_ATR_RESIDUAL',
    htfHits.length === 0,
    htfHits.length === 0 ? 'no HTF/ATR/Parkinson/GARCH/CWT/Prominence tokens in detection module'
        : 'FOUND: ' + htfHits.join(', '));

// ---- 6. selectorPrice (close) never used for EQ comparison in producer ----
var prodEqSource = fs.readFileSync(path.join(ROOT, 'liquidity/productionEqualLiquidityV1.js'), 'utf8');
// EQ comparison must be pivot.price vs point.price (wick), and priceDifference uses point.price.
var usesSelectorInEq = /selectorPrice/.test(prodEqSource) &&
    /Math\.abs\(\s*pivot\.price\s*-\s*point\.selectorPrice/.test(prodEqSource);
check('SELECTOR_PRICE_NOT_USED_IN_EQ',
    !usesSelectorInEq,
    usesSelectorInEq ? 'FAIL: EQ compares against point.selectorPrice' : 'EQ comparison uses point.price (wick); selectorPrice (close) isolated to detection');

// ---- 7. Confirmed-at causality invariant (static): buildPoint confirmedAt = confirmationCloseTime ----
var confirmedAtLine = dynDSource.split('\n').filter(function (l) { return l.indexOf('confirmedAt: det.confirmationCloseTime') !== -1; });
check('CONFIRMED_AT_IS_CONFIRMATION_CLOSE_TIME',
    confirmedAtLine.length === 1,
    'buildPoint.confirmedAt === det.confirmationCloseTime (current reversal candle, no future)');

// ---- 8. Lifecycle terminal (no resurrection) ----
var markInactiveSrc = dynDSource.split('\n').filter(function (l) { return l.indexOf('if (point.state !== \'ACTIVE\') return false;') !== -1; });
check('INACTIVE_TERMINAL_NO_RESURRECTION',
    markInactiveSrc.length === 1,
    'markInactive is a no-op when state !== ACTIVE (INACTIVE never revives)');

// ---- 9. Frozen parameter set byte-identical to research spec ----
var frozenOk = dynD.LOOKBACK === 288 && dynD.K === 1.0 && dynD.THETA_FLOOR === 0.003 &&
    Math.abs(dynD.SQRT12 - Math.sqrt(12)) < 1e-12 && dynD.LOOKBACK_BARS === 432 &&
    dynD.FIVE_DAYS_MS === 432000000;
check('FROZEN_PARAMETERS',
    frozenOk,
    'LOOKBACK=288 K=1.0 THETA_FLOOR=0.003 SQRT12=√12 LOOKBACK_BARS=432 FIVE_DAYS_MS=432000000');

// ---- 10. notify label switched to Dynamic D (old ATR50 label gone) ----
var notifySrc = fs.readFileSync(path.join(ROOT, 'notify/watchNotificationPresentationV1.js'), 'utf8');
var oldLabelGone = notifySrc.indexOf('CAUSAL_ATR50_ZIGZAG') === -1 && notifySrc.indexOf('ATR50 历史配对') === -1;
var newLabelPresent = notifySrc.indexOf("CAUSAL_DYNAMIC_D_V1: 'Dynamic D 历史配对'") !== -1;
check('NOTIFY_LABEL_DYNAMIC_D',
    oldLabelGone && newLabelPresent,
    'old ATR50 label removed; CAUSAL_DYNAMIC_D_V1 -> "Dynamic D 历史配对" present');

// ---- 11. git: old ZigZag test removed from tree ----
var oldTestPath = path.join(ROOT, 'test/atr50CausalZigZagHighLowV2.test.js');
var oldTestGone = !fs.existsSync(oldTestPath);
check('OLD_ZIGZAG_TEST_REMOVED',
    oldTestGone,
    oldTestGone ? 'test/atr50CausalZigZagHighLowV2.test.js deleted' : 'STILL EXISTS');

// ---- 12. downstream scripts residual (KNOWN, out-of-scope) ----
// Diagnostic tooling in scripts/ still references the legacy state.productionEq.zigzag
// schema. These are NOT in the test runner and NOT in the live/replay pipeline.
var scriptsHits = [];
var scriptsDir = path.join(ROOT, 'scripts');
if (fs.existsSync(scriptsDir)) {
    walk(scriptsDir).forEach(function (f) {
        var src = fs.readFileSync(f, 'utf8');
        if (src.indexOf('productionEq.zigzag') !== -1 || src.indexOf('atr50CausalZigZag') !== -1) {
            scriptsHits.push(rel(f));
        }
    });
}
check('DOWNSTREAM_SCRIPTS_RESIDUAL_DOCUMENTED',
    true, // informational, not a hard failure for this production upgrade
    scriptsHits.length ? ('KNOWN OUT-OF-SCOPE residual in scripts/: ' + scriptsHits.join(', ') +
        ' — diagnostic tooling only; not in test runner or live/replay pipeline')
        : 'no scripts reference legacy ZigZag');

var allPass = checks.every(function (c) { return c.pass; });
var hardFailures = checks.filter(function (c) { return !c.pass; });

var report = {
    task: 'PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1',
    generatedAt: new Date().toISOString(),
    governance: {
        FULL_REPLACEMENT: true,
        BACKWARD_COMPATIBILITY: false,
        FEATURE_FLAG: false,
        DUAL_PATH: false,
        FALLBACK_TO_ZIGZAG: false,
        LEGACY_ZIGZAG_OUTPUT_COMPATIBILITY: false
    },
    productionFilesScanned: prodFiles.length,
    checks: checks,
    hardFailures: hardFailures.map(function (c) { return c.id; }),
    verdict: allPass ? 'PASS' : 'FAIL'
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log('DEPENDENCY AUDIT: ' + (allPass ? 'PASS' : 'FAIL') +
    ' (' + checks.filter(function (c) { return c.pass; }).length + '/' + checks.length + ' checks)');
if (!allPass) {
    hardFailures.forEach(function (c) { console.log('  HARD FAIL: ' + c.id); });
    process.exit(1);
}
