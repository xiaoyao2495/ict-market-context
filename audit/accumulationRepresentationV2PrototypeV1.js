'use strict';

var DECISIONS = ['KEEP', 'WEAKEN', 'REJECT_CANDIDATE'];

function centerPathType(centerPath) {
    if (!Array.isArray(centerPath) || centerPath.length !== 3 || !centerPath.every(Number.isFinite)) return 'STABLE_OR_MIXED';
    var early = centerPath[0], middle = centerPath[1], late = centerPath[2];
    if (early < middle && middle < late) return 'MONOTONIC_UP';
    if (early > middle && middle > late) return 'MONOTONIC_DOWN';
    if ((middle > early && middle > late) || (middle < early && middle < late)) return 'REVERSING';
    return 'STABLE_OR_MIXED';
}

function centerState(pathType) {
    if (pathType === 'MONOTONIC_UP' || pathType === 'MONOTONIC_DOWN') return 'MIGRATING';
    if (pathType === 'REVERSING') return 'STABLE';
    return 'AMBIGUOUS';
}

function reabsorptionState(profile) {
    if (profile.failedReabsorptions > 0) return 'FAILED';
    if (profile.excursionCount > 0 && profile.midReturns === profile.excursionCount) return 'HEALTHY';
    return 'AMBIGUOUS';
}

/**
 * Research-only structural profile decision.
 * It consumes F6/F7 profiles only: no human label, EQ, Displacement, F5,
 * baseline score, future event, optimized cutoff, or composite score.
 */
function decide(centerProfile, reabsorptionProfile) {
    var pathType = centerPathType(centerProfile.centerPath);
    var migrating = pathType === 'MONOTONIC_UP' || pathType === 'MONOTONIC_DOWN';
    var failed = reabsorptionProfile.failedReabsorptions > 0;
    var decision = migrating && failed ? 'REJECT_CANDIDATE' : (migrating || failed ? 'WEAKEN' : 'KEEP');
    var reasons = [];
    if (migrating) reasons.push(pathType);
    else if (pathType === 'REVERSING') reasons.push('CENTER_PATH_REVERSES');
    else reasons.push('NO_PERSISTENT_MONOTONIC_CENTER_MIGRATION');
    reasons.push(failed ? 'FAILED_REABSORPTION_PRESENT' : 'NO_FAILED_REABSORPTION');
    return { CENTER_STATE: centerState(pathType), REABSORPTION_STATE: reabsorptionState(reabsorptionProfile),
        centerPathType: pathType, prototypeDecision: decision, decisionReason: reasons.join(' + ') };
}

function profileFromAuctionRow(row) {
    var f = row.features;
    var centerProfile = { earlyCenter: f.earlyCenter, middleCenter: f.middleCenter, lateCenter: f.lateCenter,
        centerPath: f.centerPath.slice(), centerMigrationMagnitude: f.centerMigrationMagnitude };
    var excursionCount = f.upperExcursionTotal + f.lowerExcursionTotal;
    var reabsorptionProfile = { excursionCount: excursionCount, midReturns: f.excursionToMidReturnCount,
        oppositeSideReturns: f.excursionToOppositeSideCount, failedReabsorptions: f.failedReabsorptionCount };
    var secondaryReturnProfile = { medianOppositeSideReturnBars: f.medianOppositeSideReturnBars,
        maxOppositeSideReturnBars: f.maxOppositeSideReturnBars,
        uncompletedReturns: f.uncompletedOppositeSideReturns };
    var decision = decide(centerProfile, reabsorptionProfile);
    return { caseId: row.caseId, formationConfirmedAt: row.confirmedAt,
        featureSourceStartIndex: f.featureSourceStartIndex, featureSourceEndIndex: f.featureSourceEndIndex,
        featureSourceConfirmedAt: f.featureSourceConfirmedAt,
        centerProfile: centerProfile, reabsorptionProfile: reabsorptionProfile,
        secondaryReturnProfile: secondaryReturnProfile,
        CENTER_STATE: decision.CENTER_STATE, REABSORPTION_STATE: decision.REABSORPTION_STATE,
        centerPathType: decision.centerPathType, prototypeDecision: decision.prototypeDecision,
        decisionReason: decision.decisionReason };
}

function decisionCounts(rows) {
    var counts = { KEEP: 0, WEAKEN: 0, REJECT_CANDIDATE: 0 };
    rows.forEach(function (row) { counts[row.prototypeDecision]++; });
    return counts;
}

function protectionReason(row) {
    if (row.prototypeDecision === 'REJECT_CANDIDATE') return 'CLEAR_REJECT_CONFLICT: monotonic center path and failed reabsorption coexist.';
    if (row.centerPathType === 'REVERSING' && row.reabsorptionProfile.failedReabsorptions === 0) {
        return 'Large or temporary center shift reverses and all side excursions re-enter MID; path shape protects against magnitude-only rejection.';
    }
    if (row.centerPathType === 'REVERSING') return 'Center path reverses; failed reabsorption remains a concern but persistent one-direction migration is absent.';
    if (row.CENTER_STATE === 'MIGRATING' && row.REABSORPTION_STATE !== 'FAILED') {
        return 'Monotonic migration is present, but excursions remain reabsorbed; weakened rather than rejected.';
    }
    return 'No combined monotonic-migration plus failed-reabsorption rejection pattern.';
}

function conflictAudit(joinedRows, criticalIds) {
    var critical = new Set(criticalIds);
    var c1 = [], c2 = [], c3 = [], c4 = [], c5 = [];
    joinedRows.forEach(function (row) {
        if (row.humanLabel === 'CLEAR_A' && row.prototypeDecision === 'REJECT_CANDIDATE') c1.push(row.caseId);
        if (critical.has(row.caseId) && row.prototypeDecision === 'REJECT_CANDIDATE') c2.push(row.caseId);
        if (row.humanLabel === 'NO_A' && row.prototypeDecision === 'KEEP') c3.push(row.caseId);
        if (row.centerPathType === 'REVERSING' && row.centerProfile.centerMigrationMagnitude >= 1 / 3 &&
            row.reabsorptionProfile.failedReabsorptions === 0) c4.push(row.caseId);
        if (row.centerProfile.centerMigrationMagnitude < 1 / 3 && row.reabsorptionProfile.failedReabsorptions > 0) c5.push(row.caseId);
    });
    return {
        conflictBoundaryNote: 'C4/C5 use the already-frozen one-zone width (1/3 normalized range) for review taxonomy only; it is not a decision input or searched cutoff.',
        C1_CLEAR_TO_REJECT_CANDIDATE: c1,
        C2_CRITICAL_CLEAR_TO_REJECT_CANDIDATE: c2,
        C3_NO_A_TO_KEEP_F6_F7_UNEXPLAINED: c3,
        C4_ONE_ZONE_MIGRATION_BUT_PATH_REVERSES_AND_REABSORBS: c4,
        C5_SUB_ONE_ZONE_MIGRATION_BUT_FAILED_REABSORPTION: c5,
        CLEAR_REJECT_CONFLICTS: c1.length,
        CRITICAL_CLEAR_REJECT_CONFLICTS: c2.length,
        totalUniqueConflictCases: new Set(c1.concat(c2, c3, c4, c5)).size
    };
}

function groupSummary(joinedRows, criticalIds) {
    var out = {};
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (label) {
        var cohort = joinedRows.filter(function (row) { return row.humanLabel === label; });
        out[label] = { n: cohort.length, decisions: decisionCounts(cohort),
            pathTypes: cohort.reduce(function (o, row) { o[row.centerPathType] = (o[row.centerPathType] || 0) + 1; return o; }, {}),
            centerStates: cohort.reduce(function (o, row) { o[row.CENTER_STATE] = (o[row.CENTER_STATE] || 0) + 1; return o; }, {}),
            reabsorptionStates: cohort.reduce(function (o, row) { o[row.REABSORPTION_STATE] = (o[row.REABSORPTION_STATE] || 0) + 1; return o; }, {}) };
    });
    var criticalSet = new Set(criticalIds), critical = joinedRows.filter(function (row) { return criticalSet.has(row.caseId); });
    out.CRITICAL_CLEAR = { n: critical.length, decisions: decisionCounts(critical) };
    return out;
}

module.exports = { DECISIONS: DECISIONS, centerPathType: centerPathType, centerState: centerState,
    reabsorptionState: reabsorptionState, decide: decide, profileFromAuctionRow: profileFromAuctionRow,
    decisionCounts: decisionCounts, protectionReason: protectionReason, conflictAudit: conflictAudit,
    groupSummary: groupSummary };
