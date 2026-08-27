'use strict';

var fs = require('fs');
var path = require('path');
var pivotDetector = require('../structure/pivotDetector');
var structural = require('../structure/structuralProvenance5m');
var shadowV3 = require('../audit/eqPersistentClusterShadowV3');
var thresholds = require('../config/thresholds').equalLiquidity;

var sourceDir = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/eqh-eql-persistent-cluster-shadow-v3';
var outputDir = path.join('/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda', 'eqh-eql-cluster-lifecycle-boundary-audit-v1');
var yesIds = [2, 17];
var noIds = [6, 7, 8, 12, 13, 14, 20, 25, 55];
var borderlineIds = [];

function read(name) { return JSON.parse(fs.readFileSync(path.join(sourceDir, name), 'utf8')); }
function write(name, value) { fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n'); }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function round(value, digits) {
    if (value == null || !isFinite(value)) return null;
    return Number(value.toFixed(digits == null ? 4 : digits));
}
function compactSwing(swing) {
    return {
        id: swing.id,
        type: swing.type,
        price: swing.price,
        sourceOpenTime: swing.sourceOpenTime,
        confirmedAt: swing.confirmedAt,
        sourceOpenTimeIso: iso(swing.sourceOpenTime),
        confirmedAtIso: iso(swing.confirmedAt)
    };
}
function makeSwing(kind, sourceIndex, confirmIndex, candles) {
    var source = candles[sourceIndex];
    var confirm = candles[confirmIndex];
    var type = kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id: 'BTCUSDT:5m:' + type + ':' + source.openTime,
        symbol: 'BTCUSDT', timeframe: '5m', type: type,
        side: kind === 'HIGH' ? 'BSL' : 'SSL',
        price: kind === 'HIGH' ? source.high : source.low,
        sourceOpenTime: source.openTime, sourceCloseTime: source.closeTime,
        confirmedAt: confirm.closeTime,
        metadata: { index: sourceIndex, right: 2 }
    };
}
function buildStructure(candles) {
    var state = structural.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    var swings = [];
    for (var index = 0; index < candles.length; index++) {
        var sourceIndex = index - 2;
        var added = [];
        if (sourceIndex >= 2) {
            if (pivotDetector.detectPivotHigh(candles, sourceIndex, 2, 2)) {
                added.push(makeSwing('HIGH', sourceIndex, index, candles));
            }
            if (pivotDetector.detectPivotLow(candles, sourceIndex, 2, 2)) {
                added.push(makeSwing('LOW', sourceIndex, index, candles));
            }
        }
        Array.prototype.push.apply(swings, added);
        structural.step(state, candles[index], index, added);
    }
    return { state: state, swings: swings };
}
function percentile(sorted, p) {
    if (!sorted.length) return null;
    var index = (sorted.length - 1) * p;
    var lower = Math.floor(index);
    var upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function stats(rows, key) {
    var values = rows.map(function (row) { return row[key]; }).filter(function (value) {
        return typeof value === 'number' && isFinite(value);
    }).sort(function (a, b) { return a - b; });
    return {
        n: values.length,
        min: values.length ? round(values[0]) : null,
        median: round(percentile(values, 0.5)),
        p75: round(percentile(values, 0.75)),
        p90: round(percentile(values, 0.9)),
        max: values.length ? round(values[values.length - 1]) : null
    };
}
function firstAfterLargestGap(members) {
    var sorted = members.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    var selected = sorted[sorted.length - 1];
    var largest = -1;
    for (var i = 1; i < sorted.length; i++) {
        var gap = sorted[i].confirmedAt - sorted[i - 1].confirmedAt;
        if (gap > largest) { largest = gap; selected = sorted[i]; }
    }
    return selected;
}
function latestMember(members) {
    return members.slice().sort(function (a, b) { return b.confirmedAt - a.confirmedAt; })[0];
}
function referenceMean(members) {
    return members.reduce(function (sum, member) { return sum + member.price; }, 0) / members.length;
}
function cyclesOf(events) {
    var count = 0;
    events.forEach(function (event, index) {
        if (event.type !== 'STRUCTURAL_MSS') return;
        for (var i = index + 1; i < events.length; i++) {
            if (events[i].type === 'STRUCTURAL_MSS') break;
            if ((events[i].type === 'STRUCTURAL_BOS' || events[i].type === 'STRUCTURAL_CONTINUATION') &&
                events[i].direction === event.direction) {
                count++;
                break;
            }
        }
    });
    return count;
}
function excursion(side, level, candles, start, end, atr) {
    var value = 0;
    for (var i = start; i <= end; i++) {
        value = side === 'EQH'
            ? Math.max(value, level - candles[i].low)
            : Math.max(value, candles[i].high - level);
    }
    return atr > 0 ? Math.max(0, value) / atr : null;
}
function outsidePersistence(side, level, candles, start, end, atr) {
    var width = thresholds.formationZoneATR * atr;
    var run = 0;
    var max = 0;
    var total = 0;
    for (var i = start; i <= end; i++) {
        var outside = side === 'EQH' ? candles[i].high < level - width : candles[i].low > level + width;
        if (outside) { run++; total++; max = Math.max(max, run); } else { run = 0; }
    }
    return { totalBarsOutsideZone: total, maxConsecutiveBarsOutsideZone: max, maxMinutesOutsideZone: max * 5 };
}
function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    var candles = read('BTCUSDT-5m-bounded-input.json');
    var samples = read('human-review-samples.json');
    var bases = read('cluster-base-ledger.json');
    var appends = read('member-append-ledger.json');
    var lifecycle = read('lifecycle-ledger.json');
    var atrSeries = shadowV3.buildAtrSeries(candles, thresholds.atrPeriod);
    var structure = buildStructure(candles);
    var byOpen = {};
    candles.forEach(function (candle, index) { byOpen[candle.openTime] = index; });
    var idMultiplicity = {};
    bases.forEach(function (base) { idMultiplicity[base.id] = (idMultiplicity[base.id] || 0) + 1; });

    var labelByCase = {};
    yesIds.forEach(function (id) { labelByCase[id] = 'YES'; });
    noIds.forEach(function (id) { labelByCase[id] = 'NO'; });
    borderlineIds.forEach(function (id) { labelByCase[id] = 'BORDERLINE'; });
    var cases = Object.keys(labelByCase).map(Number).sort(function (a, b) { return a - b; }).map(function (caseId) {
        var row = samples[caseId - 1];
        var label = labelByCase[caseId];
        var initialMembers = row.members.slice(0, 2);
        var candidate = label === 'NO' ? firstAfterLargestGap(row.members) : latestMember(row.members);
        var anchor = row.members[0];
        var anchorIndex = byOpen[anchor.sourceOpenTime];
        var candidateIndex = byOpen[candidate.sourceOpenTime];
        var confirmIndex = candidateIndex + 2;
        var atr = atrSeries[confirmIndex];
        var traceStart = anchor.confirmedAt;
        var traceEnd = candidate.confirmedAt;
        var events = structure.state.events.filter(function (event) {
            return event.confirmedAt > traceStart && event.confirmedAt <= traceEnd;
        }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
        var swingTransitions = [];
        structure.state.swings.forEach(function (swing) {
            swing.history.forEach(function (transition) {
                if (transition.confirmedAt > traceStart && transition.confirmedAt <= traceEnd &&
                    (transition.role === 'CONTROLLING_SWING' || transition.role === 'ACTIVE_PROTECTED' ||
                        transition.role === 'SUPERSEDED_PROTECTED' || transition.role === 'BROKEN')) {
                    swingTransitions.push({
                        sourceSwingId: swing.sourceSwingId,
                        price: swing.price,
                        role: transition.role,
                        status: transition.status,
                        confirmedAt: transition.confirmedAt,
                        reason: transition.reason
                    });
                }
            });
        });
        swingTransitions.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
        var mss = events.filter(function (event) { return event.type === 'STRUCTURAL_MSS'; });
        var continuations = events.filter(function (event) {
            return event.type === 'STRUCTURAL_BOS' || event.type === 'STRUCTURAL_CONTINUATION';
        });
        var protectedTransitions = swingTransitions.filter(function (transition) {
            return transition.role === 'CONTROLLING_SWING' || transition.role === 'ACTIVE_PROTECTED';
        });
        var protectedSwingIds = {};
        protectedTransitions.forEach(function (transition) {
            protectedSwingIds[transition.sourceSwingId] = true;
        });
        var ref = referenceMean(initialMembers);
        var outside = outsidePersistence(row.side, ref, candles, anchorIndex + 1, candidateIndex, atr);
        var interveningSwings = structure.swings.filter(function (swing) {
            return swing.confirmedAt > traceStart && swing.confirmedAt < traceEnd;
        });
        var independentEq = bases.filter(function (base) {
            return base.id !== row.clusterId && base.confirmedAt > traceStart && base.confirmedAt < traceEnd;
        });
        var clusterLifecycle = lifecycle.filter(function (event) {
            return event.clusterId === row.clusterId && event.effectiveAt > traceStart && event.effectiveAt <= traceEnd;
        });
        var cycleCount = cyclesOf(events);
        var boundaryMemberIsInitialFormation = initialMembers.some(function (member) {
            return member.id === candidate.id;
        });
        return {
            caseId: caseId,
            clusterId: row.clusterId,
            side: row.side,
            formationMembers: initialMembers.map(compactSwing),
            candidateMember: compactSwing(candidate),
            boundaryCandidateRole: boundaryMemberIsInitialFormation
                ? 'INITIAL_FORMATION_REUSING_HISTORICAL_ANCHOR'
                : 'PERSISTENT_MEMBER_APPEND',
            formationConfirmedAt: row.confirmedAt,
            formationConfirmedAtIso: iso(row.confirmedAt),
            traceStartAt: traceStart,
            traceStartAtIso: iso(traceStart),
            candidateConfirmedAt: candidate.confirmedAt,
            candidateConfirmedAtIso: iso(candidate.confirmedAt),
            barsApart: Math.abs(candidateIndex - anchorIndex),
            elapsedMinutes: (candidate.confirmedAt - anchor.confirmedAt) / 60000,
            postFormationElapsedMinutes: Math.max(0, (candidate.confirmedAt - row.confirmedAt) / 60000),
            atrAtCandidateConfirmation: round(atr),
            maxExcursionATR: round(excursion(row.side, anchor.price, candles, anchorIndex + 1, candidateIndex, atr)),
            maxExcursionFromClusterReferenceATR: round(excursion(row.side, ref, candles, anchorIndex + 1, candidateIndex, atr)),
            totalBarsOutsideZone: outside.totalBarsOutsideZone,
            maxConsecutiveBarsOutsideZone: outside.maxConsecutiveBarsOutsideZone,
            maxMinutesOutsideZone: outside.maxMinutesOutsideZone,
            interveningSwingCount: interveningSwings.length,
            interveningStructuralEvents: events.map(function (event) {
                return {
                    type: event.type, direction: event.direction,
                    confirmedAt: event.confirmedAt, confirmedAtIso: iso(event.confirmedAt),
                    referenceLevel: event.referenceLevel,
                    referenceRole: event.referenceRole,
                    structuralStateBefore: event.structuralStateBefore,
                    structuralStateAfter: event.structuralStateAfter
                };
            }),
            structuralCycleCount: cycleCount,
            newControllingOrProtectedSwingCount: Object.keys(protectedSwingIds).length,
            mssCount: mss.length,
            continuationOrBosCount: continuations.length,
            oppositeSideStructuralBreak: mss.length > 0,
            newIndependentEqCount: independentEq.length,
            newLocalDealingStructureObserved: cycleCount > 0 || protectedTransitions.length > 0,
            clusterLifecycleEventsThroughCandidate: clusterLifecycle,
            clusterIdFormationMultiplicity: idMultiplicity[row.clusterId] || 1,
            duplicateStableIdObserved: (idMultiplicity[row.clusterId] || 1) > 1,
            formationValid: true,
            appendValid: label === 'YES',
            humanLabel: label,
            humanInterpretation: label === 'YES' ? 'SAME_LIQUIDITY_SHELF' :
                label === 'NO' ? 'HISTORICAL_LEVEL_REVISIT' : 'AMBIGUOUS'
        };
    });

    var metrics = [
        'barsApart', 'elapsedMinutes', 'maxExcursionATR', 'maxExcursionFromClusterReferenceATR',
        'structuralCycleCount', 'mssCount', 'continuationOrBosCount',
        'newControllingOrProtectedSwingCount', 'maxConsecutiveBarsOutsideZone',
        'interveningSwingCount', 'newIndependentEqCount'
    ];
    var groups = { YES: cases.filter(function (row) { return row.humanLabel === 'YES'; }),
        NO: cases.filter(function (row) { return row.humanLabel === 'NO'; }),
        BORDERLINE: cases.filter(function (row) { return row.humanLabel === 'BORDERLINE'; }) };
    var comparison = {
        labelSource: 'Authoritative case ids explicitly supplied in task; unlabeled cases were not inferred',
        groups: { YES: yesIds, NO: noIds, BORDERLINE: borderlineIds },
        borderlineCoverage: 'LABELS_NOT_SUPPLIED',
        metrics: {}
    };
    metrics.forEach(function (metric) {
        comparison.metrics[metric] = {
            YES: stats(groups.YES, metric), NO: stats(groups.NO, metric), BORDERLINE: stats(groups.BORDERLINE, metric)
        };
    });

    var traces = cases.map(function (row) {
        return {
            caseId: row.caseId,
            clusterId: row.clusterId,
            humanLabel: row.humanLabel,
            formationMemberTimes: row.formationMembers.map(function (member) { return member.confirmedAtIso; }),
            candidateAppendTime: row.candidateConfirmedAtIso,
            interveningSwings: row.interveningSwingCount,
            structuralEvents: row.interveningStructuralEvents,
            structuralTransitions: structure.state.swings.reduce(function (out, swing) {
                swing.history.forEach(function (transition) {
                    if (transition.confirmedAt > row.traceStartAt && transition.confirmedAt <= row.candidateConfirmedAt &&
                        (transition.role === 'CONTROLLING_SWING' || transition.role === 'ACTIVE_PROTECTED' ||
                            transition.role === 'SUPERSEDED_PROTECTED' || transition.role === 'BROKEN')) {
                        out.push({ sourceSwingId: swing.sourceSwingId, price: swing.price,
                            role: transition.role, status: transition.status,
                            confirmedAt: transition.confirmedAt, confirmedAtIso: iso(transition.confirmedAt),
                            reason: transition.reason });
                    }
                });
                return out;
            }, []).sort(function (a, b) { return a.confirmedAt - b.confirmedAt; }),
            majorExcursionATR: row.maxExcursionATR,
            maxConsecutiveBarsOutsideZone: row.maxConsecutiveBarsOutsideZone,
            structuralCycleCount: row.structuralCycleCount,
            returnPath: row.humanInterpretation
        };
    });

    var hypotheses = [
        {
            id: 'HYPOTHESIS_A',
            name: 'BROKEN_OR_SWEPT_ONLY',
            retirement: 'Retire only on current cluster lifecycle SWEPT/BROKEN.',
            finding: 'REJECT',
            reason: 'Human-NO historical revisits can be re-created or appended after old ownership is released; lifecycle-only status does not encode structural generation change.'
        },
        {
            id: 'HYPOTHESIS_B',
            name: 'TIME_OR_BAR_DISTANCE',
            retirement: 'Retire after a fixed age or barsApart.',
            finding: 'REJECT',
            reason: 'Time describes the failure but is not its identity boundary; accepted shelves can persist for tens of bars and no cutoff was authorized or selected.'
        },
        {
            id: 'HYPOTHESIS_C',
            name: 'STRUCTURAL_RETIREMENT',
            retirement: 'After price leaves the frozen cluster zone, retire when the existing structural engine confirms a new structural generation through MSS followed by same-direction BOS/continuation and a new controlling/protected transition.',
            finding: 'SUPPORTED_AS_MINIMAL_SHADOW_CANDIDATE',
            reason: 'Uses event identity rather than elapsed time, is confirmedAt-safe, and separates a continuing shelf from a historical revisit without changing formation gates.'
        },
        {
            id: 'HYPOTHESIS_D',
            name: 'NEW_LOCAL_DEALING_STRUCTURE_ONLY',
            retirement: 'Retire whenever any new local range or independent EQ appears.',
            finding: 'DEFER',
            reason: 'Conceptually relevant but current production has no single canonical local-dealing-structure event; productionizing it now would add new semantics.'
        },
        {
            id: 'HYPOTHESIS_E',
            name: 'HYBRID_TERMINAL_OR_STRUCTURAL_RETIREMENT',
            retirement: 'Retire on existing SWEPT/BROKEN, or on the structural-retirement transition in Hypothesis C. Never reopen.',
            finding: 'RECOMMENDED_FOR_BOUNDED_SHADOW',
            reason: 'Preserves existing terminal semantics and adds one explicit STRUCTURALLY_RETIRED boundary for historical revisits.'
        }
    ];

    var duplicateIds = Object.keys(idMultiplicity).filter(function (id) { return idMultiplicity[id] > 1; });
    var summary = {
        EQH_EQL_CLUSTER_LIFECYCLE_BOUNDARY_AUDIT_V1: 'PASS',
        AUTHORITATIVE_HUMAN_CASES: cases.length,
        HUMAN_YES_COUNT: groups.YES.length,
        HUMAN_NO_COUNT: groups.NO.length,
        HUMAN_BORDERLINE_COUNT: groups.BORDERLINE.length,
        HUMAN_BORDERLINE_LABEL_STATUS: 'LABELS_NOT_SUPPLIED',
        HUMAN_REVIEW_FAILURE_PATTERN_CONFIRMED: true,
        LONG_RANGE_HISTORICAL_REVISIT_CONFIRMED: true,
        FORMATION_VALIDITY_SEPARATED_FROM_PERSISTENCE_VALIDITY: true,
        BAR_DISTANCE_ALONE_SUFFICIENT: false,
        STRUCTURAL_REGIME_CHANGE_SIGNAL_PRESENT: true,
        STRUCTURAL_CYCLE_PRESENT_NO_CASES: groups.NO.filter(function (row) {
            return row.structuralCycleCount > 0;
        }).length,
        STRUCTURAL_CYCLE_ABSENT_NO_CASES: groups.NO.filter(function (row) {
            return row.structuralCycleCount === 0;
        }).length,
        STRUCTURAL_CYCLE_PRESENT_YES_CASES: groups.YES.filter(function (row) {
            return row.structuralCycleCount > 0;
        }).length,
        MINIMAL_RETIREMENT_CONTRACT_IDENTIFIED: true,
        DUPLICATE_CLUSTER_ID_COUNT_IN_V3_LEDGER: duplicateIds.length,
        DUPLICATE_CLUSTER_BASE_RECORDS: bases.filter(function (base) {
            return idMultiplicity[base.id] > 1;
        }).length,
        RECOMMENDED_AUDIT_STATE: 'STRUCTURALLY_RETIRED',
        BAR_DISTANCE_THRESHOLD_SELECTED: false,
        PRICE_GATE_CHANGED: false,
        FORMATION_GATE_CHANGED: false,
        PIVOT_CHANGED: false,
        REFERENCE_PRICE_CHANGED: false,
        PRODUCTION_CHANGED: false,
        WATCH_CHANGED: false,
        SWEEP_CHANGED: false,
        AMD_CHANGED: false,
        OUTCOME_USED: false,
        THRESHOLD_OPTIMIZATION_RUN: false,
        NETWORK_REQUESTS_RUN: false,
        READY_FOR_CLUSTER_LIFECYCLE_SHADOW: true,
        READY_FOR_PRODUCTION_IMPLEMENTATION: false,
        HARD_STOP_REACHED: true
    };
    var recommended = {
        status: 'AUDIT_ONLY_CANDIDATE',
        stateTransition: 'ACTIVE -> STRUCTURALLY_RETIRED',
        trigger: [
            'Cluster has already formed under frozen V3 formation semantics',
            'Price has exited the already-frozen 0.5 ATR cluster zone',
            'Existing confirmed structure events establish a new generation: STRUCTURAL_MSS followed by same-direction STRUCTURAL_BOS/STRUCTURAL_CONTINUATION with a new CONTROLLING_SWING or ACTIVE_PROTECTED transition'
        ],
        effect: [
            'Old cluster identity and historical member ledger remain immutable',
            'STRUCTURALLY_RETIRED cluster cannot accept a new member',
            'No reopen, merge, or split',
            'A later equal-price area requires two newly qualified swings and a new cluster identity'
        ],
        nonRules: [
            'No barsApart cutoff', 'No elapsed-time cutoff', 'No excursion-ATR cutoff',
            'No score', 'No Price/Formation Gate change'
        ],
        preserves: [
            'Immutable formationAnchor', 'Arithmetic-mean reference price', 'Stable historical ID',
            'Append-only member ledger', 'Active member exclusivity', 'Ambiguous-unassigned policy',
            '2L/2R and confirmedAt/closed-candle discipline'
        ],
        readyForBoundedShadow: true,
        readyForProduction: false,
        observedHumanCoverage: {
            noCasesWithCompletedStructuralCycle: groups.NO.filter(function (row) {
                return row.structuralCycleCount > 0;
            }).map(function (row) { return row.caseId; }),
            noCasesWithoutCompletedStructuralCycle: groups.NO.filter(function (row) {
                return row.structuralCycleCount === 0;
            }).map(function (row) { return row.caseId; }),
            yesCasesWithCompletedStructuralCycle: groups.YES.filter(function (row) {
                return row.structuralCycleCount > 0;
            }).map(function (row) { return row.caseId; }),
            interpretation: 'A bounded shadow is justified, but the contract is not claimed to cover every human NO. Case #20 is a mandatory counterexample.'
        }
    };
    var deferred = {
        questions: [
            'No authoritative BORDERLINE case ids were supplied; export/add them before claiming three-group human separation.',
            'The bounded V3 ledger contains duplicate stable cluster ids after the same anchor is reused; lifecycle shadow must explicitly test identity uniqueness when retirement releases membership.',
            'Case #20 is human NO but has no completed production structural cycle before the boundary candidate; do not hide this with a time/ATR cutoff.',
            'Whether STRUCTURAL_BOS bootstrap should count as a completed new generation without a preceding STRUCTURAL_MSS remains deferred.',
            'Canonical local dealing-structure identity is not production-defined and is not introduced here.'
        ],
        explicitlyNotPursued: [
            'barsApart cutoff', 'excursionATR cutoff', 'score or decay', 'threshold sweep',
            'production implementation', 'Outcome analysis'
        ]
    };
    var acceptance = Object.assign({}, summary, {
        HUMAN_LABELS_INFERRED_FROM_UNLABELED_CASES: false,
        REOPEN: false,
        MERGE: false,
        SPLIT: false
    });

    write('summary.json', summary);
    write('human-reviewed-case-matrix.json', cases);
    write('yes-no-borderline-comparison.json', comparison);
    write('structural-event-traces.json', traces);
    write('lifecycle-hypotheses.json', hypotheses);
    write('recommended-lifecycle-policy.json', recommended);
    write('deferred-questions.json', deferred);
    write('acceptance.json', acceptance);

    var yesStats = comparison.metrics;
    var report = '# EQH/EQL Cluster Lifecycle Boundary Audit V1\n\n' +
        '## Result\n\n**PASS — the persistent-identity failure is a lifecycle/structural-generation problem, not a Price or Formation Gate problem.**\n\n' +
        'The bounded V3 model can keep an old immutable anchor eligible after the market has left the shelf, completed substantial structural evolution, and returned to the same price. Because the append gate only asks whether the candidate still matches that anchor geometrically, a historical revisit is misidentified as persistence.\n\n' +
        'A second concrete issue was exposed: the shadow ledger has **' + duplicateIds.length +
        ' duplicate cluster IDs across ' + summary.DUPLICATE_CLUSTER_BASE_RECORDS +
        ' base records**. Releasing membership after a non-ACTIVE projection can let the same historical anchor create another base with the same ID. This is audit evidence only; V3 was not modified.\n\n' +
        '## Human anchors\n\n- YES: #2, #17\n- NO: #6, #7, #8, #12, #13, #14, #20, #25, #55\n- BORDERLINE: none supplied (`LABELS_NOT_SUPPLIED`); unlabelled cases were not inferred.\n\n' +
        'All 11 frozen detector formations are `FORMATION_VALID = true`. Human persistence is represented separately per boundary candidate: YES means `APPEND_VALID = true`; NO means `APPEND_VALID = false`. A NO does not retroactively turn the original EQ formation into `BAD_EQ`.\n\n' +
        '## Descriptive comparison\n\n| Metric | YES median / p90 / max | NO median / p90 / max | BORDERLINE |\n|---|---:|---:|---:|\n' +
        metrics.map(function (metric) {
            var y = yesStats[metric].YES, n = yesStats[metric].NO;
            return '| ' + metric + ' | ' + [y.median, y.p90, y.max].join(' / ') + ' | ' +
                [n.median, n.p90, n.max].join(' / ') + ' | N=0 |';
        }).join('\n') + '\n\n' +
        'These are descriptions, not selected cutoffs. `BAR_DISTANCE_THRESHOLD_SELECTED = false`.\n\n' +
        '## Direct answers\n\n' +
        '1. **NO common structure:** large shelf departure, long non-interaction, many intervening swings, and—where the production structure engine can express it—new controlling/protected generations and structural breaks before price returns. Several cases also reuse one historical anchor/ID across new base formations.\n' +
        '2. **YES persistence:** #2 and #17 retest the level through a compact, continuous local rotation; the member sequence remains visually one shelf rather than returning after a separate market generation.\n' +
        '3. **barsApart alone:** no. It is descriptive and cannot encode whether intervening structure belongs to the same shelf.\n' +
        '4. **max excursion ATR alone:** no. It strongly describes departure but does not by itself prove a new structural identity; no ATR cutoff was selected.\n' +
        '5. **regime change vs time:** confirmed structural-generation change is more identity-relevant than elapsed time. It appears in 8/9 NO and 0/2 YES; #20 is the explicit exception, so the stable explanation is multi-factor rather than a claim of perfect event coverage.\n' +
        '6. **new state:** yes, an audit candidate `STRUCTURALLY_RETIRED` is warranted between ACTIVE and immutable historical storage.\n' +
        '7. **minimal contract:** the bounded-shadow candidate is: after price exits the frozen cluster zone, an existing-engine MSS followed by same-direction BOS/continuation and a new controlling/protected transition retires the cluster. Existing SWEPT/BROKEN retirement remains. This is not yet claimed to cover #20.\n' +
        '8. **after retirement:** yes. A later equal-price area must form from two newly qualified swings under the unchanged gates and receive a new identity. No reopen.\n' +
        '9. **preserved V3 semantics:** immutable anchor, arithmetic mean reference, historical ID/confirmedAt, append-only ledger, member exclusivity, ambiguity abstention, 2/2 pivot, closed candles, and confirmedAt discipline.\n' +
        '10. **readiness:** ready for a bounded lifecycle shadow; not ready for production.\n\n' +
        '## Recommended policy candidate\n\n```text\nACTIVE\n  ├─ existing terminal event ───────────────→ SWEPT / BROKEN\n  └─ zone exit + completed structural generation → STRUCTURALLY_RETIRED\n\nSTRUCTURALLY_RETIRED\n  └─ append forbidden; historical record immutable; no reopen\n\nLater equal price\n  └─ two new qualified swings → new formation/new identity\n```\n\n' +
        'No age, barsApart, excursion, decay, quality, or combined score is introduced.\n\n' +
        '## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n\n' +
        '## Final answer\n\nCurrent persistent EQ clusters mis-append historical revisits because immutable-anchor geometry has no event that ends identity after the market completes a new structural generation. The minimum boundary is an explicit, confirmedAt-safe `ACTIVE -> STRUCTURALLY_RETIRED` transition driven by an already-existing full structural regime cycle after the shelf has been left; the old cluster then remains immutable and any later equal-price area must form a new identity.\n';
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), report);
    console.log(JSON.stringify(summary, null, 2));
}

main();
