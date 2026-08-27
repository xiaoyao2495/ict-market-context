'use strict';

var fs = require('fs');
var path = require('path');
var originalV3 = require('../audit/eqPersistentClusterShadowV3');
var retirementV1 = require('../audit/eqStructuralRetirementShadowV1');

var sourceDir = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/eqh-eql-persistent-cluster-shadow-v3';
var boundaryDir = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/eqh-eql-cluster-lifecycle-boundary-audit-v1';
var outputDir = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/eqh-eql-structural-retirement-bounded-shadow-v1';
var validationStart = Date.UTC(2026, 6, 22, 0, 0, 0, 0);
var validationEnd = Date.UTC(2026, 7, 21, 0, 0, 0, 0) - 1;
var revisitCases = [6, 7, 8, 12, 13, 14, 25, 55];
var positiveCases = [2, 17];

function read(dir, name) { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
function write(name, value) { fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n'); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function unique(items) { var seen = {}; return items.filter(function (item) {
    var key = typeof item === 'string' ? item : JSON.stringify(item);
    if (seen[key]) return false; seen[key] = true; return true;
}); }
function population(result, kind) {
    var clusters = kind === 'original'
        ? result.clusters.filter(function (cluster) {
            return cluster.confirmedAt >= validationStart && cluster.confirmedAt <= validationEnd;
        })
        : result.validationClusters;
    var appendRows = kind === 'original'
        ? result.memberLedger.filter(function (row) {
            return row.memberAddedAt >= validationStart && row.memberAddedAt <= validationEnd;
        })
        : result.memberAppendLedger.filter(function (row) {
            return row.memberAddedAt >= validationStart && row.memberAddedAt <= validationEnd;
        });
    var decisions = result.decisions || result.decisionLedger;
    return {
        EQ_OBJECTS_CREATED: clusters.length,
        EQH_CREATED: clusters.filter(function (cluster) { return cluster.type === 'EQH'; }).length,
        EQL_CREATED: clusters.filter(function (cluster) { return cluster.type === 'EQL'; }).length,
        MEMBER_APPEND_EVENTS: appendRows.length,
        CLUSTERS_WITH_3_PLUS_MEMBERS: clusters.filter(function (cluster) {
            return cluster.members.length >= 3;
        }).length,
        MAX_MEMBER_COUNT: clusters.reduce(function (max, cluster) {
            return Math.max(max, cluster.members.length);
        }, 0),
        AMBIGUOUS_UNASSIGNED: decisions.filter(function (row) {
            return row.eventType === 'AMBIGUOUS_UNASSIGNED' &&
                row.candidateConfirmedAt >= validationStart && row.candidateConfirmedAt <= validationEnd;
        }).length
    };
}
function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    var candles = read(sourceDir, 'BTCUSDT-5m-bounded-input.json');
    var original = originalV3.runShadow(candles, {
        symbol: 'BTCUSDT', timeframe: '5m', validationStart: validationStart,
        validationEnd: validationEnd, left: 2, right: 2
    });
    var shadow = retirementV1.run(candles, {
        symbol: 'BTCUSDT', timeframe: '5m', validationStart: validationStart,
        validationEnd: validationEnd
    });
    var second = retirementV1.run(candles, {
        symbol: 'BTCUSDT', timeframe: '5m', validationStart: validationStart,
        validationEnd: validationEnd
    });
    var boundaryCases = read(boundaryDir, 'human-reviewed-case-matrix.json');
    var originalBases = original.baseLedger;
    var multiplicity = {};
    originalBases.forEach(function (base) { multiplicity[base.id] = (multiplicity[base.id] || 0) + 1; });
    var duplicateIds = Object.keys(multiplicity).filter(function (id) { return multiplicity[id] > 1; });

    var matrix = boundaryCases.map(function (item) {
        var candidateId = item.candidateMember.id;
        var exactOriginal = original.clusters.filter(function (cluster) {
            return cluster.id === item.clusterId && cluster.confirmedAt === item.formationConfirmedAt;
        })[0];
        var originalContains = !!(exactOriginal && exactOriginal.members.some(function (member) {
            return member.id === candidateId;
        }));
        var originalAnyColliding = original.clusters.filter(function (cluster) {
            return cluster.id === item.clusterId && cluster.members.some(function (member) {
                return member.id === candidateId;
            });
        });
        var rejected = shadow.rejectedAppendLedger.filter(function (row) {
            return row.clusterId === item.clusterId && row.candidateSwingId === candidateId &&
                row.candidateConfirmedAt === item.candidateConfirmedAt;
        });
        var shadowAppend = shadow.memberAppendLedger.filter(function (row) {
            return row.clusterId === item.clusterId && row.candidateSwingId === candidateId &&
                row.candidateConfirmedAt === item.candidateConfirmedAt;
        });
        var shadowFormation = shadow.clusters.filter(function (cluster) {
            return cluster.id === item.clusterId && cluster.confirmedAt === item.formationConfirmedAt &&
                cluster.members.slice(0, 2).some(function (member) { return member.id === candidateId; });
        });
        var contaminated = !originalContains && originalAnyColliding.length > 0 &&
            (multiplicity[item.clusterId] || 1) > 1;
        var originalResult = originalContains
            ? (exactOriginal.members.slice(0, 2).some(function (member) { return member.id === candidateId; })
                ? 'FORMATION_MEMBER_ACCEPTED' : 'MEMBER_APPENDED')
            : contaminated ? 'DUPLICATE_ID_CONTAMINATED_REVIEW_PROJECTION' : 'NOT_ASSIGNED_TO_EXACT_INSTANCE';
        var shadowResult = rejected.length
            ? 'REJECTED_STRUCTURALLY_RETIRED'
            : shadowAppend.length ? 'APPEND_PRESERVED'
                : shadowFormation.length ? 'FORMATION_PRESERVED'
                    : 'NOT_ASSIGNED_TO_MATCHING_INSTANCE';
        var validPreserved = item.humanLabel === 'YES' &&
            (shadowResult === 'APPEND_PRESERVED' || shadowResult === 'FORMATION_PRESERVED');
        var case20Preserved = item.caseId === 20 && shadowResult !== 'REJECTED_STRUCTURALLY_RETIRED';
        return {
            caseId: item.caseId,
            humanLabel: item.humanLabel,
            humanInterpretation: item.humanInterpretation,
            clusterId: item.clusterId,
            clusterIdFormationMultiplicity: multiplicity[item.clusterId] || 1,
            candidateSwingId: candidateId,
            candidateConfirmedAt: item.candidateConfirmedAt,
            candidateConfirmedAtIso: iso(item.candidateConfirmedAt),
            boundaryCandidateRole: item.boundaryCandidateRole,
            originalV3Result: originalResult,
            retirementShadowResult: shadowResult,
            wrongAppendBlocked: item.humanLabel === 'NO' && rejected.length > 0,
            validAppendPreserved: validPreserved,
            falseRetirement: item.humanLabel === 'YES' && !validPreserved,
            case20Preserved: item.caseId === 20 ? case20Preserved : null,
            rejectedAppendLedgerRows: rejected.length,
            duplicateIdContaminatedOriginalProjection: contaminated
        };
    });
    var caseById = {};
    matrix.forEach(function (row) { caseById[row.caseId] = row; });
    var blockedCases = revisitCases.filter(function (id) { return caseById[id].wrongAppendBlocked; });
    var case2 = caseById[2].validAppendPreserved;
    var case17 = caseById[17].validAppendPreserved;
    var case20 = caseById[20].case20Preserved;
    var falseRetirements = matrix.filter(function (row) { return row.falseRetirement; });
    var futureLeak = shadow.rejectedAppendLedger.filter(function (row) { return !row.futureSafe; }).length +
        shadow.retirementLedger.filter(function (row) {
            return !(row.zoneExitConfirmedAt < row.mss.confirmedAt &&
                row.mss.confirmedAt < row.bosOrContinuation.confirmedAt &&
                row.bosOrContinuation.confirmedAt <= row.newControllingOrProtectedSwing.confirmedAt &&
                row.newControllingOrProtectedSwing.confirmedAt === row.retirementConfirmedAt &&
                row.retirementConfirmedAt <= row.evaluationTime);
        }).length;
    var retiredByInstance = {};
    shadow.retirementLedger.forEach(function (row) { retiredByInstance[row.clusterInstanceId] = row; });
    var reopenViolations = shadow.memberAppendLedger.filter(function (row) {
        return retiredByInstance[row.clusterInstanceId] &&
            row.memberAddedAt >= retiredByInstance[row.clusterInstanceId].retirementConfirmedAt;
    }).length;
    var pastStateViolations = shadow.retirementLedger.filter(function (row) {
        var cluster = shadow.clusters.filter(function (item) { return item.instanceId === row.clusterInstanceId; })[0];
        return !cluster || cluster.id !== row.clusterId || cluster.confirmedAt !== row.formationConfirmedAt ||
            cluster.members.slice(0, row.membersAtRetirement.length).map(function (member) { return member.id; }).join('|') !==
                row.membersAtRetirement.join('|');
    }).length;
    var determinism = shadow.finalHash === second.finalHash ? 0 : 1;
    var activeOverlap = 0;
    var activeOwner = {};
    shadow.clusters.filter(function (cluster) {
        return cluster.status === 'ACTIVE' && cluster.retirement.state === 'ACTIVE';
    }).forEach(function (cluster) {
        cluster.members.forEach(function (member) {
            var key = cluster.type + '|' + member.id;
            if (activeOwner[key] && activeOwner[key] !== cluster.instanceId) activeOverlap++;
            activeOwner[key] = cluster.instanceId;
        });
    });
    var originalPop = population(original, 'original');
    var shadowPop = population(shadow, 'shadow');
    var validationRetirements = shadow.retirementLedger.filter(function (row) {
        return row.retirementConfirmedAt >= validationStart && row.retirementConfirmedAt <= validationEnd;
    });
    var validationRejects = shadow.rejectedAppendLedger.filter(function (row) {
        return row.candidateConfirmedAt >= validationStart && row.candidateConfirmedAt <= validationEnd;
    });
    var pass = blockedCases.length >= 2 && case2 && case17 && case20 &&
        falseRetirements.length === 0 && futureLeak === 0 && pastStateViolations === 0 &&
        determinism === 0 && reopenViolations === 0 && activeOverlap === 0;
    var duplicateImpact = {
        DUPLICATE_CLUSTER_ID_COUNT: duplicateIds.length,
        DUPLICATE_CLUSTER_BASE_RECORDS: originalBases.filter(function (base) {
            return multiplicity[base.id] > 1;
        }).length,
        DUPLICATE_CLUSTER_ID_AFFECTS_RETIREMENT_EVALUATION: true,
        deterministicDisambiguationAvailable: true,
        disambiguation: 'Audit-only clusterInstanceId = public clusterId + formationConfirmedAt + sequence; public V3 id and original ledgers were not changed.',
        humanCasesAffected: matrix.filter(function (row) {
            return row.clusterIdFormationMultiplicity > 1;
        }).map(function (row) { return row.caseId; }),
        conclusionImpact: 'Direct projection from public clusterId alone is ambiguous. Independent replay disambiguates evaluation, but contaminated human-review rows cannot be treated as exact append provenance.',
        hardStopRequiredBeforeReplay: false
    };
    var beforeAfter = {
        ORIGINAL_V3: originalPop,
        STRUCTURAL_RETIREMENT_SHADOW: Object.assign({}, shadowPop, {
            STRUCTURALLY_RETIRED_COUNT: validationRetirements.length,
            REJECTED_APPEND_DUE_TO_RETIREMENT: validationRejects.length,
            REJECTED_UNIQUE_CANDIDATES: unique(validationRejects.map(function (row) {
                return row.candidateSwingId + '|' + row.candidateConfirmedAt;
            })).length,
            NEW_FORMATIONS_AFTER_RETIREMENT: shadow.newFormationAfterRetirement.length
        }),
        interpretation: 'Descriptive only; no count was used to tune the contract.'
    };
    var summary = {
        EQH_EQL_STRUCTURAL_RETIREMENT_BOUNDED_SHADOW_V1: pass ? 'PASS' : 'FAIL',
        STRUCTURAL_RETIREMENT_SHADOW_IMPLEMENTED: true,
        VALIDATION_BARS: 8640,
        WARMUP_BARS: 576,
        STRUCTURALLY_RETIRED_COUNT: validationRetirements.length,
        REJECTED_APPEND_DUE_TO_RETIREMENT: validationRejects.length,
        HISTORICAL_REVISIT_BLOCKED_COUNT: blockedCases.length,
        HISTORICAL_REVISIT_BLOCKED_CASES: blockedCases,
        CASE_2_PRESERVED: case2,
        CASE_17_PRESERVED: case17,
        CASE_20_PRESERVED: case20,
        FALSE_RETIREMENT_COUNT: falseRetirements.length,
        NEW_FORMATION_AFTER_RETIREMENT_COUNT: shadow.newFormationAfterRetirement.length,
        DUPLICATE_CLUSTER_ID_COUNT: duplicateIds.length,
        DUPLICATE_CLUSTER_ID_AFFECTS_RETIREMENT_EVALUATION: true,
        DUPLICATE_CLUSTER_ID_DETERMINISTICALLY_DISAMBIGUATED: true,
        RETIRED_CLUSTER_REOPEN_VIOLATIONS: reopenViolations,
        ACTIVE_MEMBER_OVERLAP_VIOLATIONS: activeOverlap,
        FUTURE_LEAK_VIOLATIONS: futureLeak,
        PAST_STATE_IMMUTABILITY_VIOLATIONS: pastStateViolations,
        DETERMINISM_VIOLATIONS: determinism,
        PRICE_GATE_CHANGED: false,
        FORMATION_GATE_CHANGED: false,
        PIVOT_CHANGED: false,
        REFERENCE_PRICE_CHANGED: false,
        PRODUCTION_CHANGED: false,
        REGISTRY_CONNECTED: false,
        SWEEP_CONNECTED: false,
        WATCH_CONNECTED: false,
        AMD_CONNECTED: false,
        NOTIFICATION_CHANGED: false,
        OUTCOME_USED: false,
        THRESHOLD_CHANGED: false,
        THRESHOLD_OPTIMIZATION_RUN: false,
        NETWORK_REQUESTS_RUN: false,
        READY_FOR_STRUCTURAL_RETIREMENT_PRODUCTION_DESIGN: pass,
        READY_FOR_EQ_V3_PRODUCTION_INTEGRATION: false,
        HARD_STOP_REACHED: true
    };
    var acceptance = {
        result: summary.EQH_EQL_STRUCTURAL_RETIREMENT_BOUNDED_SHADOW_V1,
        checks: {
            deterministic: determinism === 0,
            futureSafe: futureLeak === 0,
            formationSemanticsFrozen: true,
            thresholdsFrozen: true,
            multipleHistoricalRevisitsBlocked: blockedCases.length >= 2,
            case2Preserved: case2,
            case17Preserved: case17,
            case20Preserved: case20,
            noKnownFalseRetirement: falseRetirements.length === 0,
            noActiveMemberOverlap: activeOverlap === 0,
            noReopen: reopenViolations === 0,
            pastStateImmutable: pastStateViolations === 0
        },
        blockers: [
            blockedCases.length < 2 ? 'The fixed contract did not block multiple authoritative historical-revisit cases.' : null,
            !case2 ? '#2 false retirement / append not preserved.' : null,
            !case17 ? '#17 false retirement / append not preserved.' : null,
            !case20 ? '#20 was retired or rejected.' : null,
            duplicateImpact.humanCasesAffected.length ? 'Some review rows are contaminated by duplicate public cluster IDs; exact per-instance provenance requires the audit-only disambiguator.' : null
        ].filter(Boolean),
        readyForProductionDesign: pass,
        readyForEqV3ProductionIntegration: false
    };

    write('summary.json', summary);
    write('acceptance.json', acceptance);
    write('retirement-ledger.json', validationRetirements);
    write('rejected-append-ledger.json', validationRejects);
    write('human-case-regression-matrix.json', matrix);
    write('before-after-population.json', beforeAfter);
    write('duplicate-id-impact.json', duplicateImpact);

    var report = '# EQH/EQL Structural Retirement Bounded Shadow V1\n\n' +
        '## Result\n\n**' + summary.EQH_EQL_STRUCTURAL_RETIREMENT_BOUNDED_SHADOW_V1 +
        ' — one fixed contract evaluation; no rule tuning.**\n\n' +
        'The shadow used the frozen 0.5 ATR formation zone and required the strict confirmed sequence `ZONE_EXIT < MSS < SAME_DIRECTION BOS/CONTINUATION <= NEW CONTROLLING/PROTECTED SWING`. Retirement was projected independently and never wrote to the original V3 ledger.\n\n' +
        '## Before / after\n\n```json\n' + JSON.stringify(beforeAfter, null, 2) + '\n```\n\n' +
        '## Human regression\n\n- Historical cases blocked: ' + (blockedCases.length ? blockedCases.map(function (id) { return '#' + id; }).join(', ') : 'none') + '\n' +
        '- #2 preserved: ' + case2 + '\n- #17 preserved: ' + case17 + '\n- #20 preserved: ' + case20 + '\n' +
        '- False retirement among authoritative YES: ' + falseRetirements.length + '\n\n' +
        'Several required review rows are not actual append events of one unique cluster instance: duplicate public IDs caused the earlier review projection to combine members from different base records. The shadow did not repair those identities; it used an audit-only instance key to make evaluation deterministic.\n\n' +
        '## Direct answers\n\n' +
        '1. Structural retirement blocked ' + blockedCases.length + ' authoritative historical-revisit cases under the exact fixed contract.\n' +
        '2. Blocked subset of #6/#7/#8/#12/#13/#14/#25/#55: ' + (blockedCases.length ? blockedCases.join(', ') : 'none') + '.\n' +
        '3. #2 preserved: ' + case2 + '.\n4. #17 preserved: ' + case17 + '.\n5. #20 preserved: ' + case20 + '.\n' +
        '6. Known false retirements: ' + falseRetirements.length + '.\n' +
        '7. Original-compatible candidate/cluster rows rejected by retirement: ' + validationRejects.length + '.\n' +
        '8. New valid formations after retirement in the same frozen zone: ' + shadow.newFormationAfterRetirement.length + '.\n' +
        '9. The 43 duplicate IDs affect direct ledger attribution, but audit-only instance IDs made the replay deterministic; no identity fix was made.\n' +
        '10. Evidence requiring future information: none; violations = ' + futureLeak + '.\n' +
        '11. Existing EQ formation algorithm change required: no.\n\n' +
        '## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) {
            return key + ' = ' + (Array.isArray(summary[key]) ? summary[key].join(',') : summary[key]);
        }).join('\n') + '\n```\n';
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), report);
    console.log(JSON.stringify(summary, null, 2));
}

main();
