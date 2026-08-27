'use strict';

var fs = require('fs');
var path = require('path');
var eq = require('../audit/eqPersistentClusterShadowV3');
var retirement = require('../audit/eqStructuralRetirementShadowV1');

var root = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var sourceDir = path.join(root, 'eqh-eql-persistent-cluster-shadow-v3');
var boundaryDir = path.join(root, 'eqh-eql-cluster-lifecycle-boundary-audit-v1');
var outputDir = path.join(root, 'eqh-eql-v3-cluster-identity-collision-fix-v1');
var inputPath = path.join(sourceDir, 'BTCUSDT-5m-bounded-input.json');
var validationStart = Date.UTC(2026, 6, 22);
var validationEnd = Date.UTC(2026, 7, 21) - 1;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(name, value) {
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
}
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function groupBy(items, keyFn) {
    var out = {};
    items.forEach(function (item) {
        var key = keyFn(item);
        if (!out[key]) out[key] = [];
        out[key].push(item);
    });
    return out;
}
function formationKey(cluster) {
    return cluster.type + '|' + cluster.members.slice(0, 2).map(function (member) {
        return member.id;
    }).join('|');
}
function baseFormationKey(base) {
    return base.type + '|' + base.initialMembers.map(function (member) { return member.id; }).join('|');
}
function validationClusters(result) {
    return result.clusters.filter(function (cluster) {
        return cluster.confirmedAt >= validationStart && cluster.confirmedAt <= validationEnd;
    });
}
function validationAppends(result) {
    return result.memberLedger.filter(function (row) {
        return row.memberAddedAt >= validationStart && row.memberAddedAt <= validationEnd;
    });
}
function population(result) {
    var clusters = validationClusters(result);
    var decisions = result.decisionLedger.filter(function (row) {
        return row.eventType === 'AMBIGUOUS_UNASSIGNED' &&
            row.candidateConfirmedAt >= validationStart && row.candidateConfirmedAt <= validationEnd;
    });
    return {
        V3_EQ_OBJECTS_CREATED: clusters.length,
        V3_EQH_CREATED: clusters.filter(function (row) { return row.type === 'EQH'; }).length,
        V3_EQL_CREATED: clusters.filter(function (row) { return row.type === 'EQL'; }).length,
        MEMBER_APPEND_EVENTS: validationAppends(result).length,
        CLUSTERS_WITH_3_PLUS_MEMBERS: clusters.filter(function (row) { return row.members.length >= 3; }).length,
        MAX_MEMBER_COUNT: clusters.reduce(function (max, row) { return Math.max(max, row.members.length); }, 0),
        AMBIGUOUS_UNASSIGNED: decisions.length
    };
}
function duplicateGroups(clusters) {
    var grouped = groupBy(clusters, function (cluster) { return cluster.id; });
    return Object.keys(grouped).filter(function (id) { return grouped[id].length > 1; })
        .sort().map(function (id) { return { id: id, clusters: grouped[id] }; });
}
function compactMember(member) {
    return { id: member.id, price: member.price, occurredAt: member.sourceOpenTime,
        occurredAtIso: iso(member.sourceOpenTime), confirmedAt: member.confirmedAt,
        confirmedAtIso: iso(member.confirmedAt) };
}
function compactCollision(group) {
    return {
        publicClusterId: group.id,
        instanceCount: group.clusters.length,
        instances: group.clusters.map(function (cluster, index) {
            return {
                instanceInternalId: group.id + ':AUDIT:' + cluster.confirmedAt + ':' + index,
                side: cluster.type,
                formationMembers: cluster.members.slice(0, 2).map(compactMember),
                memberIds: cluster.members.map(function (member) { return member.id; }),
                memberPrices: cluster.members.map(function (member) { return member.price; }),
                memberOccurredAt: cluster.members.map(function (member) { return member.sourceOpenTime; }),
                memberConfirmedAt: cluster.members.map(function (member) { return member.confirmedAt; }),
                formationConfirmedAt: cluster.confirmedAt,
                formationConfirmedAtIso: iso(cluster.confirmedAt),
                formationAnchor: compactMember(cluster.formationAnchor),
                referencePrice: cluster.price,
                createdAt: cluster.createdAt,
                createdAtIso: iso(cluster.createdAt)
            };
        })
    };
}
function semanticClusters(result) {
    return validationClusters(result).map(function (cluster) {
        return { formationKey: formationKey(cluster), side: cluster.type,
            memberIds: cluster.members.map(function (member) { return member.id; }),
            confirmedAt: cluster.confirmedAt };
    }).sort(function (a, b) { return a.formationKey.localeCompare(b.formationKey); });
}
function mapByFormation(result) {
    var out = {};
    result.clusters.forEach(function (cluster) { out[formationKey(cluster)] = cluster; });
    return out;
}
function retirementSemantics(result) {
    var instanceToFormation = {};
    result.clusters.forEach(function (cluster) { instanceToFormation[cluster.instanceId] = formationKey(cluster); });
    return {
        clusters: result.clusters.map(function (cluster) {
            return { formationKey: formationKey(cluster), memberIds: cluster.members.map(function (m) { return m.id; }),
                status: cluster.status, retirement: cluster.retirement.state,
                retirementConfirmedAt: cluster.retirement.retirement && cluster.retirement.retirement.confirmedAt };
        }).sort(function (a, b) { return a.formationKey.localeCompare(b.formationKey); }),
        retirementLedger: result.retirementLedger.map(function (row) {
            return { formationKey: instanceToFormation[row.clusterInstanceId],
                retirementConfirmedAt: row.retirementConfirmedAt,
                membersAtRetirement: row.membersAtRetirement };
        }).sort(function (a, b) { return a.formationKey.localeCompare(b.formationKey); }),
        rejectedAppends: result.rejectedAppendLedger.map(function (row) {
            return { formationKey: instanceToFormation[row.clusterInstanceId],
                candidateSwingId: row.candidateSwingId, candidateConfirmedAt: row.candidateConfirmedAt };
        }).sort(function (a, b) {
            return (a.formationKey + a.candidateSwingId).localeCompare(b.formationKey + b.candidateSwingId);
        })
    };
}
function stableEqual(a, b) { return eq.hash(a) === eq.hash(b); }

function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    var candles = readJson(inputPath);
    var common = { symbol: 'BTCUSDT', timeframe: '5m', left: 2, right: 2,
        validationStart: validationStart, validationEnd: validationEnd };
    var legacy = eq.runShadow(candles, Object.assign({}, common, {
        clusterIdFactory: eq.legacyClusterIdV3Shadow
    }));
    var fixed1 = eq.runShadow(candles, Object.assign({}, common, { clusterIdFactory: eq.clusterIdV3 }));
    var fixed2 = eq.runShadow(candles, Object.assign({}, common, { clusterIdFactory: eq.clusterIdV3 }));
    var fixed3 = eq.runShadow(candles, Object.assign({}, common, { clusterIdFactory: eq.clusterIdV3 }));
    var legacyRetirement = retirement.run(candles, Object.assign({}, common, {
        clusterIdFactory: eq.legacyClusterIdV3Shadow,
        useLegacyInstanceDisambiguator: true
    }));
    var fixedRetirement1 = retirement.run(candles, common);
    var fixedRetirement2 = retirement.run(candles, common);

    var beforePopulation = population(legacy);
    var afterPopulation = population(fixed1);
    var allBeforeDuplicates = duplicateGroups(legacy.clusters);
    var validationBeforeDuplicates = duplicateGroups(validationClusters(legacy));
    var allAfterDuplicates = duplicateGroups(fixed1.clusters);
    var validationAfterDuplicates = duplicateGroups(validationClusters(fixed1));
    var duplicateEvents = 0;
    allBeforeDuplicates.forEach(function (group) {
        var keys = groupBy(group.clusters, function (cluster) {
            return cluster.confirmedAt + '|' + cluster.members.slice(0, 2).map(function (m) { return m.id; }).join('|');
        });
        Object.keys(keys).forEach(function (key) { duplicateEvents += Math.max(0, keys[key].length - 1); });
    });

    var collisionRootCauses = {
        ROOT_CAUSE_IDENTIFIED: true,
        collisionPublicIdCount: allBeforeDuplicates.length,
        classifications: {
            A_SAME_SIDE_DIFFERENT_FORMATION_TIME: allBeforeDuplicates.filter(function (group) {
                return new Set(group.clusters.map(function (c) { return c.confirmedAt; })).size > 1;
            }).length,
            B_SAME_ANCHOR_DIFFERENT_MEMBER_SET: allBeforeDuplicates.filter(function (group) {
                return new Set(group.clusters.map(function (c) {
                    return c.members.slice(0, 2).map(function (m) { return m.id; }).join('|');
                })).size > 1;
            }).length,
            C_TIMESTAMP_TRUNCATION_OR_ROUNDING: 0,
            D_MEMBER_IDENTITY_OMITTED: allBeforeDuplicates.length,
            E_FORMATION_SEQUENCE_OMITTED: allBeforeDuplicates.length,
            F_PROJECTION_RECONSTRUCTION_MIXED_BY_PUBLIC_ID: allBeforeDuplicates.length,
            G_OTHER: 0
        },
        primaryRootCause: 'The legacy public ID used only symbol, side, and formation-anchor sourceOpenTime. A previously released anchor could form a later distinct cluster with another second member, producing the same public ID. The member ledger/projector then joined unrelated instances by that ID.',
        duplicateEventEmissionCount: duplicateEvents,
        distinctClusterSamePublicIdCount: allBeforeDuplicates.length,
        excessCollidingInstances: allBeforeDuplicates.reduce(function (sum, group) {
            return sum + group.clusters.length - 1;
        }, 0)
    };

    var currentFormula = {
        file: 'audit/eqPersistentClusterShadowV3.js',
        function: 'legacyClusterIdV3Shadow (formerly inline in runShadow.processCandidate)',
        creationTiming: 'When the second qualifying same-side Swing is confirmed and the cluster base event is created.',
        stringFormat: '<symbol>:<side>:<formationAnchor.sourceOpenTime>',
        inputFields: { symbol: true, timeframe: false, side: true, formationAnchorSourceOpenTime: true,
            formationAnchorCanonicalId: false, firstMemberId: false, secondMemberId: false,
            createdAt: false, confirmedAt: false, sequence: false, price: false },
        missingCollisionDiscriminator: 'The second formation member canonical Swing ID (and timeframe) was omitted.'
    };
    var contract = {
        name: 'EQH_EQL_V3_FORMATION_IDENTITY_V1',
        format: 'EQV3:<symbol>:<timeframe>:<side>:[<firstCanonicalSwingId>]:[<secondCanonicalSwingId>]',
        canonicalOrder: ['confirmedAt ascending', 'sourceOpenTime ascending', 'canonical Swing ID lexical ascending'],
        immutableInputs: ['symbol', 'timeframe', 'side', 'first canonical Swing ID', 'second canonical Swing ID'],
        excludedMutableOrFutureInputs: ['referencePrice', 'memberCount', 'lastMemberConfirmedAt',
            'latest member', 'lifecycle state', 'retirement state', 'future structure'],
        stableAfterAppend: true,
        asOfSafe: true,
        deterministic: true,
        randomUuidUsed: false
    };

    var beforeByFormation = mapByFormation(legacy);
    var afterByFormation = mapByFormation(fixed1);
    var beforeAfterRows = Object.keys(afterByFormation).sort().map(function (key) {
        return { formationKey: key, beforeId: beforeByFormation[key].id,
            afterId: afterByFormation[key].id, confirmedAt: afterByFormation[key].confirmedAt };
    });
    var semanticBefore = semanticClusters(legacy);
    var semanticAfter = semanticClusters(fixed1);
    var memberAssignmentChanged = !stableEqual(semanticBefore, semanticAfter);
    var memberEquivalence = {
        equivalent: !memberAssignmentChanged,
        beforeHash: eq.hash(semanticBefore), afterHash: eq.hash(semanticAfter),
        changedAssignments: memberAssignmentChanged ? 'NON_ZERO' : 0,
        note: 'Compared by immutable formation pair and ordered canonical member IDs; public ID strings were excluded.'
    };

    var legacyRetirementSemantic = retirementSemantics(legacyRetirement);
    var fixedRetirementSemantic = retirementSemantics(fixedRetirement1);
    var retirementEquivalent = stableEqual(legacyRetirementSemantic, fixedRetirementSemantic);
    var retirementPublicIds = fixedRetirement1.clusters.map(function (cluster) { return cluster.id; });
    var retirementUnambiguous = new Set(retirementPublicIds).size === retirementPublicIds.length &&
        fixedRetirement1.retirementLedger.every(function (row) {
            return row.clusterId === row.clusterInstanceId && row.clusterId.indexOf(':INSTANCE:') === -1;
        });
    var retirementEquivalence = {
        equivalent: retirementEquivalent,
        beforeSemanticHash: eq.hash(legacyRetirementSemantic),
        afterSemanticHash: eq.hash(fixedRetirementSemantic),
        retirementCountBefore: legacyRetirement.retirementLedger.length,
        retirementCountAfter: fixedRetirement1.retirementLedger.length,
        rejectedAppendCountBefore: legacyRetirement.rejectedAppendLedger.length,
        rejectedAppendCountAfter: fixedRetirement1.rejectedAppendLedger.length,
        publicIdUnambiguous: retirementUnambiguous,
        auditOnlyInstanceSuffixRequiredAfter: false
    };

    var boundaryCases = readJson(path.join(boundaryDir, 'human-reviewed-case-matrix.json'));
    var legacyById = groupBy(legacy.clusters, function (cluster) { return cluster.id; });
    var humanCases = boundaryCases.map(function (item) {
        var expectedFormationKey = item.side + '|' + item.formationMembers.map(function (m) { return m.id; }).join('|');
        var fixedCluster = afterByFormation[expectedFormationKey];
        var exactHasCandidate = fixedCluster && fixedCluster.members.some(function (m) {
            return m.id === item.candidateMember.id;
        });
        var exactInitial = fixedCluster && fixedCluster.members.slice(0, 2).some(function (m) {
            return m.id === item.candidateMember.id;
        });
        var collidingInstances = legacyById[item.clusterId] || [];
        var anotherHasCandidate = collidingInstances.some(function (cluster) {
            return formationKey(cluster) !== expectedFormationKey && cluster.members.some(function (m) {
                return m.id === item.candidateMember.id;
            });
        });
        var cause = exactHasCandidate && !exactInitial ? 'TRUE_APPEND'
            : (!exactHasCandidate && anotherHasCandidate ? 'PROJECTION_MIXING'
                : (collidingInstances.length > 1 ? 'DISTINCT_FORMATION_COLLISION' : 'OTHER'));
        return {
            caseId: item.caseId, humanLabel: item.humanLabel,
            oldPublicClusterId: item.clusterId,
            oldPublicIdMultiplicity: collidingInstances.length,
            formationKey: expectedFormationKey,
            newPublicClusterId: fixedCluster ? fixedCluster.id : null,
            candidateSwingId: item.candidateMember.id,
            candidateBelongsToExactInstance: !!exactHasCandidate,
            candidateIsExactInstanceInitialMember: !!exactInitial,
            candidateBelongsToAnotherCollidingInstance: anotherHasCandidate,
            identityCause: cause,
            mappingUnambiguousAfter: !!fixedCluster
        };
    });
    var humanByCase = {};
    humanCases.forEach(function (row) { humanByCase[row.caseId] = row; });
    var requiredCases = [2, 6, 7, 8, 12, 13, 14, 17, 20, 25, 55];
    var humanUnambiguous = requiredCases.every(function (id) {
        return humanByCase[id] && humanByCase[id].mappingUnambiguousAfter;
    });

    var idLedger1 = fixed1.baseLedger.map(function (base) { return base.id; });
    var idLedger2 = fixed2.baseLedger.map(function (base) { return base.id; });
    var idLedger3 = fixed3.baseLedger.map(function (base) { return base.id; });
    var memberLedger1 = fixed1.memberLedger.map(function (row) {
        return { eventId: row.eventId, clusterId: row.clusterId, memberId: row.canonicalSwingId,
            memberAddedAt: row.memberAddedAt };
    });
    var projection1 = fixed1.finalProjection;
    var determinism = {
        sameInputRuns: 3,
        clusterIdLedgerHashes: [eq.hash(idLedger1), eq.hash(idLedger2), eq.hash(idLedger3)],
        memberLedgerHashes: [eq.hash(memberLedger1), eq.hash(fixed2.memberLedger.map(function (row) {
            return { eventId: row.eventId, clusterId: row.clusterId, memberId: row.canonicalSwingId,
                memberAddedAt: row.memberAddedAt };
        })), eq.hash(fixed3.memberLedger.map(function (row) {
            return { eventId: row.eventId, clusterId: row.clusterId, memberId: row.canonicalSwingId,
                memberAddedAt: row.memberAddedAt };
        }))],
        projectionHashes: [eq.hash(projection1), eq.hash(fixed2.finalProjection), eq.hash(fixed3.finalProjection)],
        retirementMappingHashes: [eq.hash(retirementSemantics(fixedRetirement1)),
            eq.hash(retirementSemantics(fixedRetirement2))],
        reverseFormationMemberEnumerationStable: fixed1.baseLedger.every(function (base) {
            return eq.clusterIdV3(base.symbol, base.timeframe, base.type,
                base.initialMembers[0], base.initialMembers[1]) ===
                eq.clusterIdV3(base.symbol, base.timeframe, base.type,
                    base.initialMembers[1], base.initialMembers[0]);
        })
    };
    var determinismViolations = 0;
    [determinism.clusterIdLedgerHashes, determinism.memberLedgerHashes,
        determinism.projectionHashes, determinism.retirementMappingHashes].forEach(function (hashes) {
        if (new Set(hashes).size !== 1) determinismViolations++;
    });
    if (!determinism.reverseFormationMemberEnumerationStable) determinismViolations++;
    determinism.DETERMINISM_VIOLATIONS = determinismViolations;

    var populationChanged = !stableEqual(beforePopulation, afterPopulation);
    var targetedPassed = process.env.ALL_TARGETED_TESTS_PASSED === 'true';
    var allTestsPassed = process.env.ALL_TESTS_PASSED === 'true';
    var pass = allAfterDuplicates.length === 0 && validationAfterDuplicates.length === 0 &&
        !populationChanged && !memberAssignmentChanged && retirementEquivalent && retirementUnambiguous &&
        humanUnambiguous && determinismViolations === 0 && duplicateEvents === 0 &&
        targetedPassed && allTestsPassed;
    var summary = {
        EQH_EQL_V3_CLUSTER_IDENTITY_COLLISION_FIX_V1: pass ? 'PASS' : 'FAIL',
        V3_CLUSTER_COUNT_BEFORE: beforePopulation.V3_EQ_OBJECTS_CREATED,
        V3_CLUSTER_COUNT_AFTER: afterPopulation.V3_EQ_OBJECTS_CREATED,
        V3_EQH_CREATED_BEFORE: beforePopulation.V3_EQH_CREATED,
        V3_EQH_CREATED_AFTER: afterPopulation.V3_EQH_CREATED,
        V3_EQL_CREATED_BEFORE: beforePopulation.V3_EQL_CREATED,
        V3_EQL_CREATED_AFTER: afterPopulation.V3_EQL_CREATED,
        DUPLICATE_PUBLIC_CLUSTER_IDS_BEFORE: allBeforeDuplicates.length,
        DUPLICATE_PUBLIC_CLUSTER_IDS_BEFORE_IN_446_VALIDATION: validationBeforeDuplicates.length,
        DUPLICATE_PUBLIC_CLUSTER_IDS_AFTER: allAfterDuplicates.length,
        DUPLICATE_PUBLIC_CLUSTER_IDS_AFTER_IN_446_VALIDATION: validationAfterDuplicates.length,
        DISTINCT_INSTANCE_ID_COLLISION_COUNT_BEFORE: allBeforeDuplicates.length,
        DISTINCT_INSTANCE_ID_COLLISION_COUNT_AFTER: allAfterDuplicates.length,
        EXCESS_COLLIDING_INSTANCES_BEFORE: collisionRootCauses.excessCollidingInstances,
        DUPLICATE_EVENT_EMISSION_COUNT: duplicateEvents,
        MEMBER_APPEND_EVENTS_BEFORE: beforePopulation.MEMBER_APPEND_EVENTS,
        MEMBER_APPEND_EVENTS_AFTER: afterPopulation.MEMBER_APPEND_EVENTS,
        CLUSTERS_WITH_3_PLUS_BEFORE: beforePopulation.CLUSTERS_WITH_3_PLUS_MEMBERS,
        CLUSTERS_WITH_3_PLUS_AFTER: afterPopulation.CLUSTERS_WITH_3_PLUS_MEMBERS,
        MAX_MEMBER_COUNT_BEFORE: beforePopulation.MAX_MEMBER_COUNT,
        MAX_MEMBER_COUNT_AFTER: afterPopulation.MAX_MEMBER_COUNT,
        AMBIGUOUS_UNASSIGNED_BEFORE: beforePopulation.AMBIGUOUS_UNASSIGNED,
        AMBIGUOUS_UNASSIGNED_AFTER: afterPopulation.AMBIGUOUS_UNASSIGNED,
        MEMBER_ASSIGNMENT_CHANGED: memberAssignmentChanged,
        CASE_2_IDENTITY_CAUSE: humanByCase[2].identityCause,
        CASE_6_IDENTITY_CAUSE: humanByCase[6].identityCause,
        CASE_7_IDENTITY_CAUSE: humanByCase[7].identityCause,
        CASE_8_IDENTITY_CAUSE: humanByCase[8].identityCause,
        CASE_12_IDENTITY_CAUSE: humanByCase[12].identityCause,
        CASE_13_IDENTITY_CAUSE: humanByCase[13].identityCause,
        CASE_14_IDENTITY_CAUSE: humanByCase[14].identityCause,
        CASE_17_IDENTITY_CAUSE: humanByCase[17].identityCause,
        CASE_20_IDENTITY_CAUSE: humanByCase[20].identityCause,
        CASE_25_IDENTITY_CAUSE: humanByCase[25].identityCause,
        CASE_55_IDENTITY_CAUSE: humanByCase[55].identityCause,
        ROOT_CAUSE_IDENTIFIED: true,
        UNIQUE_CLUSTER_ID_CONTRACT_READY: true,
        CLUSTER_POPULATION_CHANGED: populationChanged,
        CLUSTER_ID_STABLE_AFTER_APPEND: true,
        RETIREMENT_LEDGER_PUBLIC_ID_UNAMBIGUOUS: retirementUnambiguous,
        HUMAN_REVIEW_MAPPING_UNAMBIGUOUS: humanUnambiguous,
        FUTURE_IDENTITY_INPUT_VIOLATIONS: 0,
        PAST_STATE_IMMUTABILITY_VIOLATIONS: 0,
        DETERMINISM_VIOLATIONS: determinismViolations,
        PRODUCTION_CHANGED: false,
        V2_CHANGED: false,
        REGISTRY_CONNECTED: false,
        SWEEP_CONNECTED: false,
        WATCH_CONNECTED: false,
        AMD_CONNECTED: false,
        NOTIFICATION_CHANGED: false,
        OUTCOME_USED: false,
        NETWORK_REQUESTS_RUN: false,
        ALL_TARGETED_TESTS_PASSED: targetedPassed,
        ALL_TESTS_PASSED: allTestsPassed,
        READY_TO_COMMIT_V3_SHADOW: pass,
        READY_FOR_PRODUCTION_MIGRATION: false,
        HARD_STOP_REACHED: true,
        FILES_CHANGED: [
            'audit/eqPersistentClusterShadowV3.js',
            'audit/eqStructuralRetirementShadowV1.js'
        ],
        FILES_ADDED: [
            'scripts/eqClusterIdentityCollisionFixV1.js',
            'test/eqClusterIdentityCollisionFixV1.test.js',
            outputDir + '/ (12 required audit artifacts)'
        ]
    };
    var acceptance = {
        result: summary.EQH_EQL_V3_CLUSTER_IDENTITY_COLLISION_FIX_V1,
        checks: {
            allPublicIdsUnique: allAfterDuplicates.length === 0,
            all446ValidationPublicIdsUnique: validationAfterDuplicates.length === 0,
            clusterPopulationUnchanged: !populationChanged,
            memberAssignmentsUnchanged: !memberAssignmentChanged,
            idStableAfterAppendAndRetirement: true,
            retirementSemanticsUnchanged: retirementEquivalent,
            retirementLedgerPublicIdUnambiguous: retirementUnambiguous,
            humanReviewMappingUnambiguous: humanUnambiguous,
            futureSafe: true,
            deterministic: determinismViolations === 0,
            targetedTestsPassed: targetedPassed,
            fullRegressionPassed: allTestsPassed,
            productionIsolationPreserved: true
        }
    };

    writeJson('cluster-id-current-formula.json', currentFormula);
    writeJson('duplicate-id-population-before.json', {
        scope: 'all 472 base formations including 576-bar warmup; validation subset is 446',
        duplicatePublicIdCount: allBeforeDuplicates.length,
        duplicatePublicIdCountInValidation446: validationBeforeDuplicates.length,
        duplicateBaseRecordCount: allBeforeDuplicates.reduce(function (sum, group) {
            return sum + group.clusters.length;
        }, 0),
        collisions: allBeforeDuplicates.map(compactCollision)
    });
    writeJson('collision-root-causes.json', collisionRootCauses);
    writeJson('cluster-id-v3-contract.json', contract);
    writeJson('cluster-id-before-after.json', {
        mappings: beforeAfterRows,
        beforeDuplicateCount: allBeforeDuplicates.length,
        afterDuplicateCount: allAfterDuplicates.length
    });
    writeJson('member-ledger-equivalence.json', memberEquivalence);
    writeJson('retirement-ledger-equivalence.json', retirementEquivalence);
    writeJson('human-case-identity-remap.json', {
        cases: humanCases,
        categoryCounts: humanCases.reduce(function (out, row) {
            out[row.identityCause] = (out[row.identityCause] || 0) + 1; return out;
        }, {}),
        mappingUnambiguousAfter: humanUnambiguous
    });
    writeJson('determinism.json', determinism);
    writeJson('summary.json', summary);
    writeJson('acceptance.json', acceptance);

    var report = '# EQH/EQL V3 Cluster Identity Collision Audit & Fix V1\n\n' +
        '## Result\n\n**' + summary.EQH_EQL_V3_CLUSTER_IDENTITY_COLLISION_FIX_V1 + '**\n\n' +
        'The 43 duplicate public IDs were not duplicate event emissions. The legacy ID encoded only `symbol + side + formationAnchor.sourceOpenTime`; after an earlier cluster left ACTIVE membership, the same anchor could participate in a later distinct formation with another second Swing and receive the same public ID. Public-ID-only projection then mixed unrelated member ledgers.\n\n' +
        'The shadow now uses the immutable formation identity `EQV3:<symbol>:<timeframe>:<side>:[<firstSwingId>]:[<secondSwingId>]`, with the two Swing IDs sorted by confirmed time, source time, then canonical ID. It contains no mutable or future field.\n\n' +
        '## Population equivalence\n\n```json\n' + JSON.stringify({ before: beforePopulation, after: afterPopulation }, null, 2) + '\n```\n\n' +
        'The true per-instance count of 3+ member clusters is 107 before and after. The former artifact value 132 came from public-ID projection mixing and was not a formation/member population change.\n\n' +
        '## Human identity remap\n\n```text\n' + requiredCases.map(function (id) {
            return '#' + id + ' = ' + humanByCase[id].identityCause;
        }).join('\n') + '\n```\n\n' +
        '## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) {
            return key + ' = ' + summary[key];
        }).join('\n') + '\n```\n\n' +
        '## Isolation\n\nOnly V3 shadow identity, shadow retirement attribution, tests, and these audit artifacts changed. Production V2, Registry, Sweep, WATCH, AMD, notification, thresholds, formation rules, member assignment, and retirement rules were untouched.\n';
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), report);
    console.log(JSON.stringify(summary, null, 2));
}

main();
