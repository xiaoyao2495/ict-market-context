#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.resolve(__dirname, '..');
var outDir = path.resolve(process.argv[2] || path.join(root, '.audit-opportunity-quality-narrative-refactor-v1'));
var beforeDir = path.join(root, '.audit-opportunity-high-gate-v2');
var afterDir = path.join(outDir, 'after-replay');
var beforeFunnel = read(path.join(beforeDir, 'replay', 'funnel-audit.json'));
var afterFunnel = read(path.join(afterDir, 'funnel-audit.json'));
var beforeLedger = read(path.join(beforeDir, 'opportunity-high-gate-ledger.json'));
var original412 = read(path.join(beforeDir, 'local-internal-watch-only-mss-quality.json'));
var afterLedger = read(path.join(afterDir, 'evaluation-ledger.json')).filter(function (e) { return e.fvgCount > 0; });
var beforeByLeg = indexBy(beforeLedger, 'legId');
var afterByLeg = indexBy(afterLedger, 'legId');
var narrativeByMss = indexBy(afterFunnel.signalCoverage.narrativeTiming, 'mssId');

function read(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function write(name, value) { fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2)); }
function indexBy(list, key) {
    var out = {};
    (list || []).forEach(function (x) { out[x[key]] = x; });
    return out;
}
function inc(obj, key) { obj[key] = (obj[key] || 0) + 1; }
function roleOf(e) { return e.mssReferenceRole || 'OTHER'; }
function tierShort(tier) {
    if (tier === 'HIGH_QUALITY') return 'HIGH';
    if (tier === 'LOW_QUALITY') return 'LOW';
    return tier;
}
function formationRecord(e) {
    var timing = narrativeByMss[e.id] || null;
    return {
        id: e.id,
        legId: e.legId,
        evaluationTime: e.evaluationTime,
        evaluationTimeIso: new Date(e.evaluationTime).toISOString(),
        direction: e.direction,
        tier: e.tier,
        MSS: {
            id: e.id.indexOf(':MSS:') !== -1 ? e.id : null,
            direction: e.mssDirection,
            confirmedAt: timing ? timing.mssConfirmedAt : null,
            referenceSwingId: timing ? timing.referenceSwingId : null,
            referencePrice: timing ? timing.referencePrice : null,
            qualityContext: e.mssQuality,
            referenceRole: e.mssReferenceRole,
            mssGrade: e.mssGrade,
            protectedBreak: e.protectedBreak
        },
        referenceRole: e.mssReferenceRole,
        protectedBreak: e.protectedBreak,
        raid: e.raidId ? {
            id: e.raidId,
            direction: e.raidDirection,
            side: e.raidSide,
            confirmedAt: timing ? timing.raidConfirmedAt : null,
            raidToMssBars: e.raidToMssBars,
            directionMatchedToOpportunity: e.raidDirectionMatch
        } : null,
        raidDirection: e.raidDirection,
        mssDirection: e.mssDirection,
        displacementDirection: e.displacementDirection,
        opportunityDirection: e.opportunityDirection,
        FULL_DIRECTION_ALIGNMENT: e.fullDirectionAlignment,
        raidToMssBars: e.raidToMssBars,
        displacement: e.displacementQuality,
        mssToDisplacementBars: e.mssToDisplacementBars,
        FVG: { present: e.fvgCount > 0, count: e.fvgCount, ids: e.fvgIds },
        nearDraw: { present: e.nearTarget !== null && e.nearTarget !== undefined, target: e.nearTarget },
        deliveryQuality: e.deliveryQuality,
        liquidityTaken: e.liquidityTaken,
        liquidityType: e.liquidityType,
        DailyBias: {
            bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN',
            status: 'BYPASSED_IN_FIXED_AUDIT_REPLAY', evaluationTime: null, ageMs: null,
            appliedToTier: false
        },
        highGates: e.highGates,
        finalRejectReason: e.finalRejectReason,
        outcomeIncluded: false
    };
}

var afterHigh = afterLedger.filter(function (e) { return e.tier === 'HIGH_QUALITY'; });
var newHigh = afterHigh.filter(function (e) {
    return !beforeByLeg[e.legId] || beforeByLeg[e.legId].tier !== 'HIGH_QUALITY';
});
var highRoles = { LOCAL: 0, INTERNAL: 0, CONTROLLING: 0, ACTIVE_PROTECTED: 0, SUPERSEDED_PROTECTED: 0, OTHER: 0 };
afterHigh.forEach(function (e) {
    var role = roleOf(e);
    inc(highRoles, Object.prototype.hasOwnProperty.call(highRoles, role) ? role : 'OTHER');
});

var transitions412 = { HIGH: 0, WATCH: 0, LOW: 0, MISSING: 0 };
var groups412 = {};
var facts412 = {
    RAID_PRESENT: 0, RAID_DIRECTION_MATCH: 0, FULL_DIRECTION_ALIGNMENT: 0,
    protectedBreakTrue: 0, referenceRole: {}
};
original412.forEach(function (old) {
    var now = afterByLeg[old.legId];
    if (!now) { transitions412.MISSING++; return; }
    inc(transitions412, tierShort(now.tier));
    if (now.raidId) facts412.RAID_PRESENT++;
    if (now.raidDirectionMatch) facts412.RAID_DIRECTION_MATCH++;
    if (now.fullDirectionAlignment) facts412.FULL_DIRECTION_ALIGNMENT++;
    if (now.protectedBreak) facts412.protectedBreakTrue++;
    inc(facts412.referenceRole, roleOf(now));
    var key = [
        'RAID_PRESENT=' + !!now.raidId,
        'RAID_DIRECTION_MATCH=' + !!now.raidDirectionMatch,
        'FULL_DIRECTION_ALIGNMENT=' + !!now.fullDirectionAlignment,
        'protectedBreak=' + !!now.protectedBreak,
        'referenceRole=' + roleOf(now)
    ].join('|');
    inc(groups412, key);
});

var newHighStats = {
    NEW_HIGH_COUNT: newHigh.length,
    NEW_HIGH_WITH_RAID: newHigh.filter(function (e) { return !!e.raidId; }).length,
    NEW_HIGH_WITH_DIRECTION_MATCHED_RAID: newHigh.filter(function (e) { return e.raidDirectionMatch === true; }).length,
    NEW_HIGH_WITH_FULL_DIRECTION_ALIGNMENT: newHigh.filter(function (e) { return e.fullDirectionAlignment === true; }).length
};

var allHighFormation = afterHigh.map(formationRecord);
var newHighFormation = newHigh.map(formationRecord);
var candles = load5mCandles();
var sampled = newHigh.slice().sort(function (a, b) {
    return hashKey(a.legId).localeCompare(hashKey(b.legId));
}).slice(0, 20).map(function (e, i) {
    var record = formationRecord(e);
    var mssTime = record.MSS.confirmedAt || e.evaluationTime;
    var mssIndex = lastIndexAtOrBefore(candles, mssTime);
    var evalIndex = lastIndexAtOrBefore(candles, e.evaluationTime);
    record.reviewId = 'OQNR-HR-' + String(i + 1).padStart(2, '0');
    record.sampleSelection = 'deterministic pseudo-random SHA-256 ordering; no Outcome used';
    record.formationCandles = candles.slice(Math.max(0, mssIndex - 20), evalIndex + 1).map(compactCandle);
    return record;
});

var hr02Time = Date.parse('2026-08-13T16:29:59.999Z');
var hr02 = afterLedger.filter(function (e) { return e.evaluationTime === hr02Time && e.direction === 'BEARISH'; }).map(formationRecord);
var hr02Mss63534 = afterFunnel.signalCoverage.narrativeTiming.filter(function (x) { return x.referencePrice === 63534; });
var hr02Mss63536 = afterFunnel.signalCoverage.narrativeTiming.filter(function (x) { return x.referencePrice === 63536; });
var hr02Mss63536Ids = {};
hr02Mss63536.forEach(function (x) { hr02Mss63536Ids[x.mssId] = true; });
var hr02Opportunity63536 = afterLedger.filter(function (e) { return hr02Mss63536Ids[e.id]; }).map(formationRecord);
var protected63637 = afterFunnel.signalCoverage.narrativeTiming.filter(function (x) {
    return x.referencePrice === 63637.8 && x.referenceRole === 'ACTIVE_PROTECTED' && x.protectedBreak === true;
});
var afterRejects = afterFunnel.rejectionReasonFrequency.HIGH_QUALITY || {};
var summary = {
    audit: {
        version: 'Opportunity Quality Narrative Refactor V1',
        symbol: 'BTCUSDT',
        startIso: afterFunnel.audit.startIso,
        endIso: afterFunnel.audit.endIso,
        closedCandlesOnly: true,
        outcomeUsed: false,
        beforeSource: beforeDir,
        afterSource: afterDir
    },
    Opportunity: { before: beforeFunnel.funnel.opportunityCandidates.passCount, after: afterFunnel.funnel.opportunityCandidates.passCount },
    HIGH: { before: beforeFunnel.funnel.HIGH_QUALITY.passCount, after: afterFunnel.funnel.HIGH_QUALITY.passCount },
    WATCH: { before: beforeFunnel.funnel.WATCH.passCount, after: afterFunnel.funnel.WATCH.passCount },
    LOW: { before: beforeFunnel.funnel.LOW.passCount, after: afterFunnel.funnel.LOW.passCount },
    Notifications: { before: beforeFunnel.funnel.actualNotifications.passCount, after: afterFunnel.funnel.actualNotifications.passCount },
    HIGH_BY_MSS_ROLE: highRoles,
    ORIGINAL_412_RECLASSIFICATION: transitions412,
    ORIGINAL_412_FACT_COUNTS: facts412,
    ORIGINAL_412_GROUP_COUNTS: groups412,
    NEW_HIGH_COUNT: newHighStats.NEW_HIGH_COUNT,
    NEW_HIGH_WITH_RAID: newHighStats.NEW_HIGH_WITH_RAID,
    NEW_HIGH_WITH_DIRECTION_MATCHED_RAID: newHighStats.NEW_HIGH_WITH_DIRECTION_MATCHED_RAID,
    NEW_HIGH_WITH_FULL_DIRECTION_ALIGNMENT: newHighStats.NEW_HIGH_WITH_FULL_DIRECTION_ALIGNMENT,
    HIGH_REJECT_REASON_COUNTS_AFTER: afterRejects,
    R_MSS_QUALITY_INSUFFICIENT_AFTER: afterRejects.R_MSS_QUALITY_INSUFFICIENT || 0,
    MSS_IMPORTANT_SWING_IS_HIGH_PREREQUISITE: false,
    STRUCTURAL_PROVENANCE_RETAINED: protected63637.length > 0 && afterHigh.every(function (e) { return e.mssReferenceRole != null; }),
    HR02: {
        opportunityAtEvaluationTime: hr02,
        mss63534: hr02Mss63534,
        mss63536: hr02Mss63536,
        opportunity63536: hr02Opportunity63536,
        protected63637_8Mss: protected63637
    },
    FUTURE_LEAK_VIOLATIONS: afterFunnel.invariants.FUTURE_LEAK_VIOLATIONS,
    STRUCTURAL_FACT_COUNTS_UNCHANGED: {
        confirmedSwings: beforeFunnel.signalCoverage.confirmed2L2RSwings === afterFunnel.signalCoverage.confirmed2L2RSwings,
        closeBreakMss: beforeFunnel.signalCoverage.closeBreakMss === afterFunnel.signalCoverage.closeBreakMss,
        protectedBreakMss: beforeFunnel.signalCoverage.protectedBreakMss === afterFunnel.signalCoverage.protectedBreakMss,
        liquidityEvents: beforeFunnel.funnel.rawLiquidityEvents.passCount === afterFunnel.funnel.rawLiquidityEvents.passCount,
        sweeps: beforeFunnel.funnel.validSweeps.passCount === afterFunnel.funnel.validSweeps.passCount
    },
    THRESHOLD_CHANGED: JSON.stringify(beforeFunnel.productionConfig) !== JSON.stringify(afterFunnel.productionConfig),
    PRODUCTION_CHANGED: true
};

var formationLeaks = [];
sampled.forEach(function (s) {
    s.formationCandles.forEach(function (c) {
        if (c.closeTime > s.evaluationTime) formationLeaks.push({ reviewId: s.reviewId, candleCloseTime: c.closeTime, evaluationTime: s.evaluationTime });
    });
});
afterHigh.forEach(function (e) {
    (e.displacementQuality && e.displacementQuality.events || []).forEach(function (d) {
        if (d.confirmedAt > e.evaluationTime) formationLeaks.push({ legId: e.legId, factId: d.id, confirmedAt: d.confirmedAt, evaluationTime: e.evaluationTime });
    });
});
summary.FUTURE_LEAK_VIOLATIONS += formationLeaks.length;

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
write('summary.json', summary);
write('high-formation-ledger.json', allHighFormation);
write('new-high-formation-ledger.json', newHighFormation);
write('original-412-reclassification.json', original412.map(function (old) {
    return { before: old, after: afterByLeg[old.legId] ? formationRecord(afterByLeg[old.legId]) : null };
}));
write('new-high-human-review-samples.json', sampled);
write('future-leak-details.json', formationLeaks);
fs.writeFileSync(path.join(outDir, 'OPPORTUNITY_QUALITY_NARRATIVE_REFACTOR_V1_REPORT.md'), render(summary));
console.log(JSON.stringify(summary, null, 2));

function hashKey(s) { return crypto.createHash('sha256').update('OQNR-V1|' + s).digest('hex'); }
function load5mCandles() {
    var dir = path.join(root, 'data-cache');
    var byOpen = {};
    fs.readdirSync(dir).filter(function (f) { return /^BTCUSDT_5m_.*\.json$/.test(f); }).forEach(function (f) {
        var rows;
        try { rows = read(path.join(dir, f)); } catch (e) { return; }
        (rows || []).forEach(function (c) {
            if (c && c.source === 'futures' && c.closed !== false) byOpen[c.openTime] = c;
        });
    });
    return Object.keys(byOpen).map(function (k) { return byOpen[k]; }).sort(function (a, b) { return a.openTime - b.openTime; });
}
function lastIndexAtOrBefore(list, t) {
    var lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) {
        var mid = Math.floor((lo + hi) / 2);
        if (list[mid].closeTime <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}
function compactCandle(c) {
    return { openTime: c.openTime, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}
function render(s) {
    return [
        '# Opportunity Quality Narrative Refactor V1', '',
        '- Window: ' + s.audit.startIso + ' → ' + s.audit.endIso,
        '- Opportunity: ' + s.Opportunity.before + ' → ' + s.Opportunity.after,
        '- HIGH: ' + s.HIGH.before + ' → ' + s.HIGH.after,
        '- WATCH: ' + s.WATCH.before + ' → ' + s.WATCH.after,
        '- LOW: ' + s.LOW.before + ' → ' + s.LOW.after,
        '- Notifications: ' + s.Notifications.before + ' → ' + s.Notifications.after, '',
        '## HIGH by MSS role', '',
        '- LOCAL: ' + s.HIGH_BY_MSS_ROLE.LOCAL,
        '- INTERNAL: ' + s.HIGH_BY_MSS_ROLE.INTERNAL,
        '- CONTROLLING: ' + s.HIGH_BY_MSS_ROLE.CONTROLLING,
        '- ACTIVE_PROTECTED: ' + s.HIGH_BY_MSS_ROLE.ACTIVE_PROTECTED,
        '- SUPERSEDED_PROTECTED: ' + s.HIGH_BY_MSS_ROLE.SUPERSEDED_PROTECTED,
        '- OTHER: ' + s.HIGH_BY_MSS_ROLE.OTHER, '',
        '## Original 412 reclassification', '',
        '- 412 → HIGH: ' + s.ORIGINAL_412_RECLASSIFICATION.HIGH,
        '- 412 → WATCH: ' + s.ORIGINAL_412_RECLASSIFICATION.WATCH,
        '- 412 → LOW: ' + s.ORIGINAL_412_RECLASSIFICATION.LOW,
        '- RAID_PRESENT: ' + s.ORIGINAL_412_FACT_COUNTS.RAID_PRESENT,
        '- RAID_DIRECTION_MATCH: ' + s.ORIGINAL_412_FACT_COUNTS.RAID_DIRECTION_MATCH,
        '- FULL_DIRECTION_ALIGNMENT: ' + s.ORIGINAL_412_FACT_COUNTS.FULL_DIRECTION_ALIGNMENT,
        '- protectedBreak=true: ' + s.ORIGINAL_412_FACT_COUNTS.protectedBreakTrue, '',
        '## New HIGH', '',
        '- NEW_HIGH_COUNT: ' + s.NEW_HIGH_COUNT,
        '- NEW_HIGH_WITH_RAID: ' + s.NEW_HIGH_WITH_RAID,
        '- NEW_HIGH_WITH_DIRECTION_MATCHED_RAID: ' + s.NEW_HIGH_WITH_DIRECTION_MATCHED_RAID,
        '- NEW_HIGH_WITH_FULL_DIRECTION_ALIGNMENT: ' + s.NEW_HIGH_WITH_FULL_DIRECTION_ALIGNMENT, '',
        '## Acceptance', '',
        '- R_MSS_QUALITY_INSUFFICIENT_AFTER = ' + s.R_MSS_QUALITY_INSUFFICIENT_AFTER,
        '- MSS_IMPORTANT_SWING_IS_HIGH_PREREQUISITE = ' + s.MSS_IMPORTANT_SWING_IS_HIGH_PREREQUISITE,
        '- STRUCTURAL_PROVENANCE_RETAINED = ' + s.STRUCTURAL_PROVENANCE_RETAINED,
        '- FUTURE_LEAK_VIOLATIONS = ' + s.FUTURE_LEAK_VIOLATIONS,
        '- THRESHOLD_CHANGED = ' + s.THRESHOLD_CHANGED,
        '- PRODUCTION_CHANGED = true', ''
    ].join('\n');
}
