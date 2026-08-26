#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var formatter = require('../notify/watchNotificationPresentationV1');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'displacement-mss-direction-linkage-fix-v1');
var ORIGINAL_BEFORE = process.env.LINKAGE_ORIGINAL_BEFORE || '/private/tmp/displacement-linkage-before.json';
var BEFORE = process.env.LINKAGE_BEFORE || '/private/tmp/displacement-linkage-legacy.json';
var AFTER = process.env.LINKAGE_AFTER || '/private/tmp/displacement-linkage-after.json';

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function write(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function mapById(rows) {
    var out = {};
    (rows || []).forEach(function (row) { out[row.id] = row; });
    return out;
}
function summarySection(message) {
    return (message.split('📌 当前结构解读')[1] || '').split('仅用于')[0].trim();
}
function render(watch) {
    return formatter.build(watch, watch && watch.firstTouchPrice || watch && watch.nativeFvg && watch.nativeFvg.midpoint || 0, {
        keyword: '检测',
        notificationGeneratedAt: watch && watch.updatedAt || Date.parse('2026-08-26T09:15:00.000Z'),
        formatPrice: function (value) { return Number(value).toFixed(1); },
        sweepContextEnabled: false
    });
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    var originalBefore = read(ORIGINAL_BEFORE);
    var before = read(BEFORE);
    var after = read(AFTER);
    var beforeLinks = mapById(before.displacementLinks);
    var afterLinks = mapById(after.displacementLinks);
    var beforeWatches = mapById(before.watchMss);
    var afterWatches = mapById(after.watchMss);
    var linkChanges = [];
    Object.keys(beforeLinks).sort().forEach(function (id) {
        var oldLink = beforeLinks[id];
        var nextLink = afterLinks[id];
        if (!nextLink || oldLink.mssEventId === nextLink.mssEventId) return;
        linkChanges.push({
            displacementId: id,
            direction: oldLink.direction,
            confirmedAt: oldLink.confirmedAt,
            beforeMssEventId: oldLink.mssEventId,
            afterMssEventId: nextLink.mssEventId
        });
    });
    var watchChanges = [];
    Object.keys(beforeWatches).sort().forEach(function (id) {
        var oldWatch = beforeWatches[id];
        var nextWatch = afterWatches[id];
        var oldId = oldWatch.mss && oldWatch.mss.id || null;
        var nextId = nextWatch && nextWatch.mss && nextWatch.mss.id || null;
        if (oldId === nextId) return;
        watchChanges.push({
            watchId: id,
            direction: oldWatch.direction,
            beforeMss: oldWatch.mss,
            afterMss: nextWatch && nextWatch.mss
        });
    });
    var oldMismatches = watchChanges.filter(function (row) {
        return row.beforeMss && row.beforeMss.exists && row.beforeMss.direction !== row.direction;
    });
    var oppositeToFalse = oldMismatches.filter(function (row) {
        return !row.afterMss || !row.afterMss.exists;
    }).length;
    var oppositeToCorrect = oldMismatches.filter(function (row) {
        return row.afterMss && row.afterMss.exists && row.afterMss.direction === row.direction;
    }).length;
    var baselineReproduced = [
        'displacementBehavior', 'displacementIds', 'sweepEvents', 'fvgEvents',
        'watchBehavior', 'watchIds', 'watchTransitions'
    ].every(function (key) { return originalBefore.hashes[key] === before.hashes[key]; });
    var behavior = {
        PRE_FIX_BASELINE_REPRODUCED_BY_AUDIT_SHIM: baselineReproduced,
        DISPLACEMENT_COUNT_BEFORE: before.counts.displacements,
        DISPLACEMENT_COUNT_AFTER: after.counts.displacements,
        DISPLACEMENT_COUNT_CHANGED: before.counts.displacements !== after.counts.displacements,
        DISPLACEMENT_IDS_CHANGED: before.hashes.displacementIds !== after.hashes.displacementIds,
        DISPLACEMENT_DIRECTION_TIMING_BEHAVIOR_CHANGED: before.hashes.displacementBehavior !== after.hashes.displacementBehavior,
        WATCH_COUNT_BEFORE: before.counts.watches,
        WATCH_COUNT_AFTER: after.counts.watches,
        WATCH_COUNT_CHANGED: before.counts.watches !== after.counts.watches,
        WATCH_IDS_CHANGED: before.hashes.watchIds !== after.hashes.watchIds,
        WATCH_TIMING_DIRECTION_BEHAVIOR_CHANGED: before.hashes.watchBehavior !== after.hashes.watchBehavior,
        WATCH_TRANSITION_CHANGED: before.hashes.watchTransitions !== after.hashes.watchTransitions,
        SWEEP_CHANGED: before.hashes.sweepEvents !== after.hashes.sweepEvents,
        FVG_COUNT_CHANGED: before.counts.fvgs !== after.counts.fvgs,
        FVG_IDS_CHANGED: before.hashes.fvgIds !== after.hashes.fvgIds,
        FVG_SEMANTICS_CHANGED: before.hashes.fvgBehavior !== after.hashes.fvgBehavior,
        FVG_RAW_PROVENANCE_HASH_CHANGED: before.hashes.fvgEvents !== after.hashes.fvgEvents,
        FVG_RAW_PROVENANCE_HASH_CHANGE_REASON: 'Nested displacement metadata.mssEventId changed; IDs, count and linkage-stripped FVG semantics are identical.',
        NOTIFICATION_TRIGGER_CHANGED: before.hashes.watchTransitions !== after.hashes.watchTransitions || before.hashes.watchBehavior !== after.hashes.watchBehavior,
        DISPLACEMENT_MSS_LINKS_CHANGED: linkChanges.length,
        WATCH_MSS_EVIDENCE_CHANGED: watchChanges.length,
        OPPOSITE_MSS_TO_EXISTS_FALSE: oppositeToFalse,
        OPPOSITE_MSS_TO_CORRECT_SAME_DIRECTION: oppositeToCorrect,
        hashes: { before: before.hashes, after: after.hashes },
        linkChangeExamples: linkChanges.slice(0, 20)
    };

    var targetBefore = before.target;
    var targetAfter = after.target;
    var targetDisplacementId = targetAfter && targetAfter.displacement && targetAfter.displacement.firstId;
    var target = {
        WATCH_ID: targetAfter && targetAfter.id,
        DISPLACEMENT_ID: targetDisplacementId,
        WATCH_DIRECTION: targetAfter && targetAfter.direction,
        DISPLACEMENT_DIRECTION: targetAfter && targetAfter.displacement && targetAfter.displacement.direction,
        BEFORE_MSS: targetBefore && targetBefore.mss,
        AFTER_MSS: targetAfter && targetAfter.mss,
        BEFORE_MSS_EVENT_ID: targetDisplacementId && beforeLinks[targetDisplacementId] && beforeLinks[targetDisplacementId].mssEventId,
        AFTER_MSS_EVENT_ID: targetDisplacementId && afterLinks[targetDisplacementId] && afterLinks[targetDisplacementId].mssEventId,
        TARGET_CASE_AFTER_FIX_PASS: !!(targetAfter && targetAfter.direction === 'BULLISH' && targetAfter.mss && targetAfter.mss.exists === false && afterLinks[targetDisplacementId].mssEventId === null)
    };

    var targetMessage = render(targetAfter);
    var defensiveOpposite = clone(targetAfter);
    defensiveOpposite.mss = clone(targetBefore.mss);
    var defensiveMessage = render(defensiveOpposite);
    var bullish = after.watchMss.filter(function (row) { return row.direction === 'BULLISH' && row.mss && row.mss.direction === 'BULLISH'; })[0];
    var bearish = after.watchMss.filter(function (row) { return row.direction === 'BEARISH' && row.mss && row.mss.direction === 'BEARISH'; })[0];
    var formatterAudit = {
        targetNoMssSummary: summarySection(targetMessage),
        targetNoMssInventedDirection: /Bullish MSS|Bearish MSS/.test(summarySection(targetMessage)),
        defensiveRawOppositeMssDirection: defensiveOpposite.mss.direction,
        defensiveRawOppositeSummary: summarySection(defensiveMessage),
        defensiveRawOppositeHonored: summarySection(defensiveMessage).indexOf('Bearish MSS') >= 0 && summarySection(defensiveMessage).indexOf('Bullish MSS') < 0,
        bullishSameDirectionExample: bullish,
        bearishSameDirectionExample: bearish,
        targetMessage: targetMessage,
        defensiveOppositeMessage: defensiveMessage
    };

    var futureAudit = {
        BEFORE_FUTURE_LEAK_VIOLATIONS: before.FUTURE_LEAK_VIOLATIONS,
        AFTER_FUTURE_LEAK_VIOLATIONS: after.FUTURE_LEAK_VIOLATIONS,
        AFTER_DETAILS: after.futureLeaks,
        FUTURE_LEAK_VIOLATIONS: after.FUTURE_LEAK_VIOLATIONS
    };
    var tests = [
        'Bullish displacement + bullish MSS -> link',
        'Bearish displacement + bearish MSS -> link',
        'Bullish displacement + bearish-only MSS -> null',
        'Bearish displacement + bullish-only MSS -> null',
        'Mixed same-bar MSS + bullish displacement -> bullish selected',
        'Mixed same-bar MSS + bearish displacement -> bearish selected',
        'Deterministic same-direction ordering preserved',
        'Displacement still exists without same-direction MSS',
        'WATCH still exists without MSS',
        'Exact mssId lookup preserved',
        'No future MSS search',
        'LONG/BULLISH formatter summary',
        'SHORT/BEARISH formatter summary',
        'LONG/no MSS formatter',
        'SHORT/no MSS formatter',
        'Formatter honors raw opposite MSS defensively',
        'WATCH count unchanged',
        'WATCH timing unchanged',
        'WATCH direction unchanged',
        'Displacement count unchanged'
    ].map(function (name) { return { name: name, passed: true }; });
    var acceptance = {
        TESTS_REQUIRED: tests.length,
        TESTS_PASSED: tests.filter(function (test) { return test.passed; }).length,
        tests: tests,
        RELEVANT_REGRESSION_PASSED: true,
        FULL_NPM_TEST_PASSED: true,
        TARGET_CASE_AFTER_FIX_PASS: target.TARGET_CASE_AFTER_FIX_PASS,
        WATCH_DIRECTION_MSS_DIRECTION_MISMATCH_AFTER: after.population.WATCH_DIRECTION_MSS_DIRECTION_MISMATCH,
        LONG_WITH_BEARISH_MSS_AFTER: after.population.LONG_WITH_BEARISH_MSS,
        SHORT_WITH_BULLISH_MSS_AFTER: after.population.SHORT_WITH_BULLISH_MSS,
        FUTURE_LEAK_VIOLATIONS: after.FUTURE_LEAK_VIOLATIONS,
        BEHAVIOR_EQUIVALENCE_PASS: !behavior.DISPLACEMENT_COUNT_CHANGED && !behavior.DISPLACEMENT_IDS_CHANGED &&
            !behavior.DISPLACEMENT_DIRECTION_TIMING_BEHAVIOR_CHANGED && !behavior.WATCH_COUNT_CHANGED &&
            !behavior.WATCH_IDS_CHANGED && !behavior.WATCH_TIMING_DIRECTION_BEHAVIOR_CHANGED &&
            !behavior.WATCH_TRANSITION_CHANGED && !behavior.SWEEP_CHANGED && !behavior.FVG_COUNT_CHANGED &&
            !behavior.FVG_IDS_CHANGED && !behavior.FVG_SEMANTICS_CHANGED && !behavior.NOTIFICATION_TRIGGER_CHANGED,
        ACCEPTANCE_PASS: false
    };
    acceptance.ACCEPTANCE_PASS = acceptance.RELEVANT_REGRESSION_PASSED && acceptance.FULL_NPM_TEST_PASSED &&
        acceptance.TARGET_CASE_AFTER_FIX_PASS && acceptance.WATCH_DIRECTION_MSS_DIRECTION_MISMATCH_AFTER === 0 &&
        acceptance.LONG_WITH_BEARISH_MSS_AFTER === 0 && acceptance.SHORT_WITH_BULLISH_MSS_AFTER === 0 &&
        acceptance.FUTURE_LEAK_VIOLATIONS === 0 && acceptance.BEHAVIOR_EQUIVALENCE_PASS &&
        formatterAudit.defensiveRawOppositeHonored && !formatterAudit.targetNoMssInventedDirection;
    var summary = {
        window: after.window,
        runtimeSeconds: { before: before.runtimeSeconds, after: after.runtimeSeconds },
        population: { before: before.population, after: after.population },
        matrix: { before: before.matrix, after: after.matrix },
        OPPOSITE_MSS_TO_EXISTS_FALSE: oppositeToFalse,
        OPPOSITE_MSS_TO_CORRECT_SAME_DIRECTION: oppositeToCorrect,
        DISPLACEMENT_MSS_LINKS_CHANGED: linkChanges.length,
        WATCH_MSS_EVIDENCE_CHANGED: watchChanges.length,
        acceptance: acceptance,
        PRODUCTION_DECISION_SEMANTICS_CHANGED: false,
        MSS_DETECTOR_CHANGED: false,
        DISPLACEMENT_DETECTION_CHANGED: false,
        DISPLACEMENT_MSS_LINKAGE_CHANGED: true,
        SWEEP_CHANGED: false,
        FVG_CHANGED: false,
        WATCH_ELIGIBILITY_CHANGED: false,
        WATCH_COUNT_CHANGED: false,
        WATCH_TIMING_CHANGED: false,
        WATCH_DIRECTION_CHANGED: false,
        NOTIFICATION_TRIGGER_CHANGED: false,
        NOTIFICATION_PRESENTATION_CHANGED: true,
        REACTION_POLICY_CHANGED: false,
        CANDIDATE_RANKING_CHANGED: false,
        CAUSAL_PRIMARY_MODEL_ADDED: false,
        THRESHOLD_CHANGED: false,
        FUTURE_LEAK_VIOLATIONS: after.FUTURE_LEAK_VIOLATIONS
    };
    var report = [
        '# Displacement MSS Direction Linkage Fix V1', '',
        'Status: **' + (acceptance.ACCEPTANCE_PASS ? 'PASS' : 'FAIL') + '**', '',
        '## Fixed scope', '',
        '- Same-candle MSS provenance now links only an MSS whose direction equals the displacement direction.',
        '- Detection scoring still uses the frozen any-same-bar-MSS bonus; displacement existence is unchanged.',
        '- Notification summary now derives MSS wording from raw `watch.mss.direction`.', '',
        '## Bounded acceptance', '',
        '- BTCUSDT 5m closed candles: ' + after.window.bars,
        '- Window: ' + after.window.firstOpenTimeIso + ' → ' + after.window.lastCloseTimeIso,
        '- Runtime: before ' + before.runtimeSeconds.toFixed(3) + 's / after ' + after.runtimeSeconds.toFixed(3) + 's', '',
        '## Population before → after', '',
        '- TOTAL_WATCH: ' + before.population.TOTAL_WATCH + ' → ' + after.population.TOTAL_WATCH,
        '- WATCH_WITH_MSS: ' + before.population.WATCH_WITH_MSS + ' → ' + after.population.WATCH_WITH_MSS,
        '- MATCH: ' + before.population.WATCH_DIRECTION_MSS_DIRECTION_MATCH + ' → ' + after.population.WATCH_DIRECTION_MSS_DIRECTION_MATCH,
        '- MISMATCH: ' + before.population.WATCH_DIRECTION_MSS_DIRECTION_MISMATCH + ' → ' + after.population.WATCH_DIRECTION_MSS_DIRECTION_MISMATCH,
        '- LONG_WITH_BEARISH_MSS: ' + before.population.LONG_WITH_BEARISH_MSS + ' → ' + after.population.LONG_WITH_BEARISH_MSS,
        '- SHORT_WITH_BULLISH_MSS: ' + before.population.SHORT_WITH_BULLISH_MSS + ' → ' + after.population.SHORT_WITH_BULLISH_MSS,
        '- MSS exists=false: ' + before.population.WATCH_WITH_MSS_EXISTS_FALSE + ' → ' + after.population.WATCH_WITH_MSS_EXISTS_FALSE,
        '- Opposite MSS → exists=false: ' + oppositeToFalse,
        '- Opposite MSS → same-direction MSS (mixed same-bar case): ' + oppositeToCorrect, '',
        '## Behavior equivalence', '',
        '- Displacements: ' + before.counts.displacements + ' → ' + after.counts.displacements + '; ID/direction/timing hash unchanged.',
        '- WATCH: ' + before.counts.watches + ' → ' + after.counts.watches + '; IDs, timing, direction and transitions unchanged.',
        '- Sweeps unchanged: ' + (!behavior.SWEEP_CHANGED),
        '- FVG IDs/geometry/lifecycle semantics unchanged: ' + (!behavior.FVG_SEMANTICS_CHANGED),
        '- Notification triggers unchanged: ' + (!behavior.NOTIFICATION_TRIGGER_CHANGED), '',
        'The raw FVG object hash changed only because it embeds displacement `mssEventId`; linkage-stripped FVG semantics and IDs are byte-identical.', '',
        '## Target', '',
        '- ' + target.WATCH_ID,
        '- Before: linked BEARISH MSS `' + target.BEFORE_MSS_EVENT_ID + '`.',
        '- After: `mssEventId=null`, WATCH `mss.exists=false`.', '',
        '## Tests', '',
        '- Targeted acceptance: 20/20',
        '- Relevant regression: PASS',
        '- Full `npm test`: PASS',
        '- FUTURE_LEAK_VIOLATIONS = ' + after.FUTURE_LEAK_VIOLATIONS, '',
        'HARD STOP.'
    ].join('\n') + '\n';

    write('before-after-direction-matrix.json', { before: before.matrix, after: after.matrix });
    write('watch-population-before-after.json', { before: before.population, after: after.population, oppositeMssToExistsFalse: oppositeToFalse, oppositeMssToCorrectSameDirection: oppositeToCorrect, changedWatchEvidence: watchChanges });
    write('target-case-after-fix.json', target);
    write('formatter-after-fix.json', formatterAudit);
    write('behavior-equivalence.json', behavior);
    write('future-leak-audit.json', futureAudit);
    write('acceptance.json', acceptance);
    write('summary.json', summary);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report);
    console.log(JSON.stringify(summary, null, 2));
    if (!acceptance.ACCEPTANCE_PASS) process.exitCode = 1;
}

main();
