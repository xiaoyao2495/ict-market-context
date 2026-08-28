'use strict';

var gtAudit = require('./accumulationGroundTruthV1');

var LABELS = ['CLEAR_A', 'BORDERLINE_A', 'NO_A'];

function assertGroundTruth(rows) {
    if (!Array.isArray(rows) || rows.length !== 60) throw new Error('Expected 60 frozen cases');
    var counts = { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0 };
    var ids = {};
    rows.forEach(function (row) {
        if (ids[row.caseId]) throw new Error('Duplicate ground-truth case ' + row.caseId);
        ids[row.caseId] = true;
        if (!row.groundTruthFrozen || row.groundTruthStatus !== 'APPROVED_V1') {
            throw new Error('Ground Truth is not frozen for ' + row.caseId);
        }
        if (!Object.prototype.hasOwnProperty.call(counts, row.humanLabel)) {
            throw new Error('Unexpected human label ' + row.humanLabel);
        }
        counts[row.humanLabel]++;
    });
    if (counts.CLEAR_A !== 32 || counts.BORDERLINE_A !== 12 || counts.NO_A !== 16) {
        throw new Error('Ground Truth count mismatch ' + JSON.stringify(counts));
    }
    return counts;
}

function quantiles(values) {
    return gtAudit.distribution(values.filter(Number.isFinite));
}

function visibleMembers(eq, evaluationTime) {
    return (((eq || {}).metadata || {}).members || []).filter(function (member) {
        var visibleAt = Number.isFinite(member.memberAddedAt) ? member.memberAddedAt : member.confirmedAt;
        return member.confirmedAt <= evaluationTime && visibleAt <= evaluationTime;
    });
}

function timingBucket(eqConfirmedAt, formationStartAt, accumulationConfirmedAt) {
    if (!Number.isFinite(eqConfirmedAt)) return 'UNKNOWN';
    if (eqConfirmedAt > accumulationConfirmedAt) return 'FUTURE_AFTER_A_CONFIRMATION';
    if (eqConfirmedAt < formationStartAt) return 'PRE_FORMATION';
    var span = accumulationConfirmedAt - formationStartAt;
    if (span <= 0) return 'LATE';
    var fraction = (eqConfirmedAt - formationStartAt) / span;
    if (fraction <= 1 / 3) return 'EARLY';
    if (fraction <= 2 / 3) return 'MIDDLE';
    return 'LATE';
}

function buildCase(gt, sample, eqObjects, confirmThreshold) {
    var f = gt.featureSnapshot;
    var eqs = (eqObjects || []).filter(Boolean).map(function (eq) {
        var members = visibleMembers(eq, sample.row.confirmedAt);
        return {
            id: eq.id,
            type: eq.type,
            price: eq.price,
            confirmedAt: eq.confirmedAt,
            timing: timingBucket(eq.confirmedAt, sample.row.formationStartAt, sample.row.confirmedAt),
            members: members.map(function (member) {
                return { id: member.id, type: member.type, price: member.price,
                    occurredAt: member.occurredAt, confirmedAt: member.confirmedAt,
                    memberAddedAt: member.memberAddedAt };
            })
        };
    });
    var scoreWithEQ = f.scoreWithEQ;
    var scoreWithoutEQ = f.scoreWithoutEQ;
    var eqContribution = f.eqContribution;
    return {
        caseId: gt.caseId,
        humanLabel: gt.humanLabel,
        formationStartAt: sample.row.formationStartAt,
        accumulationConfirmedAt: sample.row.confirmedAt,
        startIndex: sample.row.startIndex,
        endIndex: sample.row.endIndex,
        rangeHigh: sample.row.rangeHighAtConfirmation,
        rangeLow: sample.row.rangeLowAtConfirmation,
        rangeMid: sample.row.rangeMidAtConfirmation,
        anyEQPresent: eqs.length > 0,
        EQHPresent: eqs.some(function (eq) { return eq.type === 'EQH'; }),
        EQLPresent: eqs.some(function (eq) { return eq.type === 'EQL'; }),
        bothEQHAndEQL: eqs.some(function (eq) { return eq.type === 'EQH'; }) &&
            eqs.some(function (eq) { return eq.type === 'EQL'; }),
        eqCount: eqs.length,
        eqhCount: eqs.filter(function (eq) { return eq.type === 'EQH'; }).length,
        eqlCount: eqs.filter(function (eq) { return eq.type === 'EQL'; }).length,
        uniqueEQClusterCount: new Set(eqs.map(function (eq) { return eq.id; })).size,
        eqMemberCount: eqs.reduce(function (sum, eq) { return sum + eq.members.length; }, 0),
        scoreWithEQ: scoreWithEQ,
        scoreWithoutEQ: scoreWithoutEQ,
        baseScore: scoreWithoutEQ,
        eqContribution: eqContribution,
        confirmThreshold: confirmThreshold,
        eqDependentConfirmation: scoreWithEQ >= confirmThreshold && scoreWithoutEQ < confirmThreshold,
        scoreMarginWithEQ: scoreWithEQ - confirmThreshold,
        scoreMarginWithoutEQ: scoreWithoutEQ - confirmThreshold,
        eqContributionRatio: scoreWithEQ ? eqContribution / scoreWithEQ : null,
        eqObjects: eqs,
        chartReference: sample.row.chartReference || ('../accumulation-detection-research-v1/charts/' + gt.caseId + '.svg')
    };
}

function presenceSummary(rows) {
    var out = {};
    LABELS.forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        function count(field) { return cohort.filter(function (row) { return row[field]; }).length; }
        out[label] = { n: cohort.length, anyEQPresent: count('anyEQPresent'), EQHPresent: count('EQHPresent'),
            EQLPresent: count('EQLPresent'), bothEQHAndEQL: count('bothEQHAndEQL'),
            noEQ: cohort.length - count('anyEQPresent') };
        Object.keys(out[label]).forEach(function (key) {
            if (key !== 'n') out[label][key + 'Percentage'] = cohort.length ? out[label][key] / cohort.length : 0;
        });
    });
    return out;
}

function countSummary(rows) {
    var out = {};
    LABELS.forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        out[label] = { n: cohort.length };
        ['eqCount', 'eqhCount', 'eqlCount', 'eqMemberCount', 'uniqueEQClusterCount'].forEach(function (field) {
            out[label][field] = quantiles(cohort.map(function (row) { return row[field]; }));
        });
    });
    return out;
}

function dependencySummary(rows) {
    var out = {};
    LABELS.forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        var dependent = cohort.filter(function (row) { return row.eqDependentConfirmation; });
        out[label] = { n: cohort.length, count: dependent.length,
            percentage: cohort.length ? dependent.length / cohort.length : 0 };
    });
    return out;
}

function counterfactualSummary(rows) {
    var dep = dependencySummary(rows);
    return {
        counterfactual: 'CURRENT_EQ_CONTRIBUTION_VS_ZERO_ONLY',
        CLEAR_A_LOST_WITHOUT_EQ: dep.CLEAR_A,
        BORDERLINE_A_LOST_WITHOUT_EQ: dep.BORDERLINE_A,
        NO_A_REMOVED_WITHOUT_EQ: dep.NO_A,
        criticalTradeoff: {
            noARemoved: dep.NO_A.count,
            clearALost: dep.CLEAR_A.count,
            noARemovedPerClearALost: dep.CLEAR_A.count ? dep.NO_A.count / dep.CLEAR_A.count : null,
            productionDecisionAcceptableByItself: false,
            statement: 'THIS IS NOT AN ACCEPTABLE PRODUCTION DECISION BY ITSELF.'
        }
    };
}

function marginSummary(rows) {
    var out = {};
    LABELS.forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        out[label] = {
            scoreWithEQ: quantiles(cohort.map(function (row) { return row.scoreWithEQ; })),
            scoreWithoutEQ: quantiles(cohort.map(function (row) { return row.scoreWithoutEQ; })),
            scoreMarginWithEQ: quantiles(cohort.map(function (row) { return row.scoreMarginWithEQ; })),
            scoreMarginWithoutEQ: quantiles(cohort.map(function (row) { return row.scoreMarginWithoutEQ; })),
            eqContributionRatio: quantiles(cohort.map(function (row) { return row.eqContributionRatio; }))
        };
    });
    return out;
}

function timingSummary(rows) {
    var buckets = ['PRE_FORMATION', 'EARLY', 'MIDDLE', 'LATE', 'FUTURE_AFTER_A_CONFIRMATION', 'UNKNOWN'];
    var out = {}, future = 0;
    LABELS.forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        var timings = [];
        cohort.forEach(function (row) { row.eqObjects.forEach(function (eq) { timings.push(eq.timing); }); });
        var counts = {}; buckets.forEach(function (bucket) { counts[bucket] = 0; });
        timings.forEach(function (bucket) { counts[bucket]++; });
        future += counts.FUTURE_AFTER_A_CONFIRMATION;
        out[label] = { cases: cohort.length, totalVisibleEQClusters: timings.length, counts: counts };
        out[label].percentages = {};
        buckets.forEach(function (bucket) {
            out[label].percentages[bucket] = timings.length ? counts[bucket] / timings.length : 0;
        });
    });
    return { cohorts: out, EQ_CONFIRMED_BEFORE_A_CONFIRMATION: rows.reduce(function (sum, row) {
        return sum + row.eqObjects.filter(function (eq) { return eq.confirmedAt <= row.accumulationConfirmedAt; }).length;
    }, 0), FUTURE_EQ_USED_FOR_A_CONFIRMATION: future };
}

function dependentCases(rows) {
    var out = { CLEAR_A_EQ_DEPENDENT: [], BORDERLINE_A_EQ_DEPENDENT: [], NO_A_EQ_DEPENDENT: [] };
    rows.filter(function (row) { return row.eqDependentConfirmation; }).forEach(function (row) {
        var target = row.humanLabel === 'CLEAR_A' ? out.CLEAR_A_EQ_DEPENDENT :
            row.humanLabel === 'BORDERLINE_A' ? out.BORDERLINE_A_EQ_DEPENDENT : out.NO_A_EQ_DEPENDENT;
        target.push({ caseId: row.caseId, humanLabel: row.humanLabel, scoreWithEQ: row.scoreWithEQ,
            scoreWithoutEQ: row.scoreWithoutEQ, eqContribution: row.eqContribution,
            confirmThreshold: row.confirmThreshold, EQHPresent: row.EQHPresent,
            EQLPresent: row.EQLPresent, eqObjects: row.eqObjects });
    });
    return out;
}

function roleEvaluation(presence, dependency, timing, margins) {
    return {
        ROLE_DEFINITIONAL: {
            status: 'NOT_SUPPORTED',
            evidence: 'Only 13/32 CLEAR_A cases contain EQ, so EQ cannot be a necessary formation identity in the frozen human Ground Truth.'
        },
        ROLE_SUPPORTING_EVIDENCE: {
            status: 'MIXED',
            evidence: 'EQ increases current score and is threshold-critical for 6 CLEAR_A, but it is also threshold-critical for 6 NO_A; score support does not selectively represent human-valid formation.'
        },
        ROLE_LIQUIDITY_ENRICHMENT: {
            status: 'SUPPORTED',
            evidence: 'Most CLEAR_A cases exist without EQ, and 9/15 CLEAR_A visible EQ clusters confirm in the final formation third. EQ is better described as liquidity structure that often emerges inside an already-developing balance.'
        },
        FINAL_EQ_ROLE: 'LIQUIDITY_ENRICHMENT',
        ARCHITECTURE_DECISION: 'OPTION_B_BALANCE_AUCTION_FORMATION_THEN_EQ_LIQUIDITY_ENRICHMENT',
        qualification: 'Descriptive research conclusion only. Current baseScore distributions overlap substantially, so this does not authorize detector or score changes.',
        inputs: { presence: presence, dependency: dependency, timing: timing, margins: margins }
    };
}

module.exports = {
    LABELS: LABELS,
    assertGroundTruth: assertGroundTruth,
    visibleMembers: visibleMembers,
    timingBucket: timingBucket,
    buildCase: buildCase,
    presenceSummary: presenceSummary,
    countSummary: countSummary,
    dependencySummary: dependencySummary,
    counterfactualSummary: counterfactualSummary,
    marginSummary: marginSummary,
    timingSummary: timingSummary,
    dependentCases: dependentCases,
    roleEvaluation: roleEvaluation
};
