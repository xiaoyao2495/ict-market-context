#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var inputDir = path.resolve(process.argv[2] || '.audit-opportunity-high-gate-v2/replay');
var outputDir = path.resolve(process.argv[3] || '.audit-opportunity-high-gate-v2');
var funnel = JSON.parse(fs.readFileSync(path.join(inputDir, 'funnel-audit.json'), 'utf8'));
var evaluations = JSON.parse(fs.readFileSync(path.join(inputDir, 'evaluation-ledger.json'), 'utf8'));
var opportunities = evaluations.filter(function (e) { return e.fvgCount > 0; });

function inc(obj, key) { obj[key] = (obj[key] || 0) + 1; }
function isLocalInternal(e) { return e.mssReferenceRole === 'LOCAL' || e.mssReferenceRole === 'INTERNAL'; }
function roleBucket(role, protectedBreak) {
    if (protectedBreak || role === 'ACTIVE_PROTECTED') return 'PROTECTED';
    if (role === 'LOCAL') return 'LOCAL';
    if (role === 'INTERNAL') return 'INTERNAL';
    if (role === 'CONTROLLING') return 'CONTROLLING';
    return 'OTHER';
}
function compact(e) {
    return {
        id: e.id,
        legId: e.legId,
        evaluationTime: e.evaluationTime,
        evaluationTimeIso: new Date(e.evaluationTime).toISOString(),
        tier: e.tier,
        direction: e.direction,
        mssReferenceRole: e.mssReferenceRole,
        mssGrade: e.mssGrade,
        protectedBreak: e.protectedBreak,
        liquidityTaken: e.liquidityTaken,
        liquidityType: e.liquidityType,
        liquidityTypes: e.liquidityTypes,
        raidId: e.raidId,
        raidDirectionMatch: e.raidDirectionMatch,
        raidToMssBars: e.raidToMssBars,
        mssToDisplacementBars: e.mssToDisplacementBars,
        displacementQuality: e.displacementQuality,
        legQuality: e.legQuality,
        fvg: { present: e.fvgCount > 0, count: e.fvgCount, ids: e.fvgIds },
        nearDraw: { present: e.nearTarget !== null && e.nearTarget !== undefined, target: e.nearTarget },
        highGates: e.highGates,
        highFailedConditions: e.highFailedConditions,
        finalRejectReason: e.finalRejectReason
    };
}

var tierCounts = {};
var primaryRejectCounts = {};
var allFailedGateCounts = {};
var watchRoles = { LOCAL: 0, INTERNAL: 0, CONTROLLING: 0, PROTECTED: 0, OTHER: 0 };
opportunities.forEach(function (e) {
    inc(tierCounts, e.tier);
    if (e.finalRejectReason) inc(primaryRejectCounts, e.finalRejectReason);
    (e.highFailedConditions || []).forEach(function (reason) { inc(allFailedGateCounts, reason); });
    if (e.tier === 'WATCH') inc(watchRoles, roleBucket(e.mssReferenceRole, e.protectedBreak));
});

var onlyMss = opportunities.filter(function (e) {
    return e.tier === 'WATCH' && isLocalInternal(e) && e.onlyMssQualityHighFailure === true;
});
var subsetFacts = {
    RAID_PRESENT: onlyMss.filter(function (e) { return !!e.raidId; }).length,
    RAID_DIRECTION_MATCH: onlyMss.filter(function (e) { return e.raidDirectionMatch === true; }).length,
    DISPLACEMENT_PRESENT: onlyMss.filter(function (e) { return e.displacementQuality && e.displacementQuality.productionValid; }).length,
    DISPLACEMENT_STRONG: onlyMss.filter(function (e) { return e.highGates.legQuality.pass; }).length,
    FVG_PRESENT: onlyMss.filter(function (e) { return e.highGates.fvg.pass; }).length,
    NEAR_DRAW_PRESENT: onlyMss.filter(function (e) { return e.highGates.nearDraw.pass; }).length
};

var leaks = [];
opportunities.forEach(function (e) {
    (e.displacementQuality && e.displacementQuality.events || []).forEach(function (d) {
        if (d.confirmedAt > e.evaluationTime) leaks.push({ id: e.id, fact: d.id, confirmedAt: d.confirmedAt, evaluationTime: e.evaluationTime });
    });
});

var sortedPrimary = Object.keys(primaryRejectCounts).sort(function (a, b) { return primaryRejectCounts[b] - primaryRejectCounts[a]; });
var summary = {
    audit: {
        version: 'BTCUSDT Opportunity HIGH Gate Audit V2',
        sourceReplay: inputDir,
        startIso: funnel.audit.startIso,
        endIso: funnel.audit.endIso,
        closedCandlesOnly: funnel.audit.closedCandlesOnly,
        outcomeUsed: false,
        productionHighDefinition: 'mssQuality in {PROTECTED_SWING, HTF_RELEVANT} AND legQuality in {STRONG, EXPLOSIVE} AND nearDraw available AND directionConflict=false',
        opportunityPrerequisite: 'fvgCount > 0; this is not a second HIGH-only gate',
        raidDefinition: 'latest direction-matching production LIQUIDITY_SWEEP within production sweepProvenance lookback, confirmed at/before MSS'
    },
    OPPORTUNITY_TOTAL: opportunities.length,
    HIGH_TOTAL: tierCounts.HIGH_QUALITY || 0,
    WATCH_TOTAL: tierCounts.WATCH || 0,
    LOW_TOTAL: tierCounts.LOW_QUALITY || 0,
    HIGH_REJECT_REASON_COUNTS: primaryRejectCounts,
    ALL_HIGH_GATE_FAILURE_COUNTS: allFailedGateCounts,
    WATCH_LOCAL_MSS: watchRoles.LOCAL,
    WATCH_INTERNAL_MSS: watchRoles.INTERNAL,
    WATCH_CONTROLLING_MSS: watchRoles.CONTROLLING,
    WATCH_PROTECTED_MSS: watchRoles.PROTECTED,
    WATCH_OTHER_MSS: watchRoles.OTHER,
    LOCAL_INTERNAL_WATCH_REJECTED_ONLY_BY_MSS_QUALITY: onlyMss.length,
    LOCAL_INTERNAL_ONLY_MSS_FACT_COUNTS: subsetFacts,
    IS_IMPORTANT_SWING_STILL_EFFECTIVELY_A_HIGH_GATE: true,
    PRIMARY_HIGH_BOTTLENECK: sortedPrimary[0] || null,
    FUTURE_LEAK_VIOLATIONS: (funnel.invariants.FUTURE_LEAK_VIOLATIONS || 0) + leaks.length,
    PRODUCTION_CHANGED: funnel.invariants.PRODUCTION_RULE_CHANGED,
    THRESHOLD_CHANGED: funnel.invariants.THRESHOLD_CHANGED,
    productionHashesMatch: JSON.stringify(funnel.productionHashesBefore) === JSON.stringify(funnel.productionHashesAfter)
};

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'opportunity-high-gate-ledger.json'), JSON.stringify(opportunities.map(compact), null, 2));
fs.writeFileSync(path.join(outputDir, 'local-internal-watch-only-mss-quality.json'), JSON.stringify(onlyMss.map(compact), null, 2));
fs.writeFileSync(path.join(outputDir, 'opportunity-high-gate-summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outputDir, 'future-leak-details.json'), JSON.stringify(leaks, null, 2));

var lines = [
    '# BTCUSDT Opportunity HIGH Gate Audit V2', '',
    '- Window: ' + summary.audit.startIso + ' → ' + summary.audit.endIso,
    '- Opportunity: ' + summary.OPPORTUNITY_TOTAL,
    '- HIGH / WATCH / LOW: ' + summary.HIGH_TOTAL + ' / ' + summary.WATCH_TOTAL + ' / ' + summary.LOW_TOTAL,
    '- Outcome used: false', '',
    '## HIGH reject reasons (unique primary reason)', ''
];
sortedPrimary.forEach(function (k) { lines.push('- ' + k + ': ' + primaryRejectCounts[k]); });
lines.push('', '## All failed HIGH gate components (non-exclusive)', '');
Object.keys(allFailedGateCounts).sort(function (a,b) { return allFailedGateCounts[b]-allFailedGateCounts[a]; }).forEach(function (k) {
    lines.push('- ' + k + ': ' + allFailedGateCounts[k]);
});
lines.push('', '## WATCH by MSS reference role', '',
    '- WATCH_TOTAL: ' + summary.WATCH_TOTAL,
    '- WATCH_LOCAL_MSS: ' + summary.WATCH_LOCAL_MSS,
    '- WATCH_INTERNAL_MSS: ' + summary.WATCH_INTERNAL_MSS,
    '- WATCH_CONTROLLING_MSS: ' + summary.WATCH_CONTROLLING_MSS,
    '- WATCH_PROTECTED_MSS: ' + summary.WATCH_PROTECTED_MSS,
    '- WATCH_OTHER_MSS: ' + summary.WATCH_OTHER_MSS, '',
    '## Local/Internal WATCH failing only MSS structural significance', '',
    '- Count: ' + onlyMss.length,
    '- RAID_PRESENT: ' + subsetFacts.RAID_PRESENT,
    '- RAID_DIRECTION_MATCH: ' + subsetFacts.RAID_DIRECTION_MATCH,
    '- DISPLACEMENT_PRESENT: ' + subsetFacts.DISPLACEMENT_PRESENT,
    '- DISPLACEMENT_STRONG: ' + subsetFacts.DISPLACEMENT_STRONG,
    '- FVG_PRESENT: ' + subsetFacts.FVG_PRESENT,
    '- NEAR_DRAW_PRESENT: ' + subsetFacts.NEAR_DRAW_PRESENT, '',
    '## Diagnosis', '',
    '- IS_IMPORTANT_SWING_STILL_EFFECTIVELY_A_HIGH_GATE = true',
    '- PRIMARY_HIGH_BOTTLENECK = ' + summary.PRIMARY_HIGH_BOTTLENECK,
    '- FUTURE_LEAK_VIOLATIONS = ' + summary.FUTURE_LEAK_VIOLATIONS,
    '- PRODUCTION_CHANGED = ' + summary.PRODUCTION_CHANGED,
    '- THRESHOLD_CHANGED = ' + summary.THRESHOLD_CHANGED
);
fs.writeFileSync(path.join(outputDir, 'OPPORTUNITY_HIGH_GATE_AUDIT_V2_REPORT.md'), lines.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
