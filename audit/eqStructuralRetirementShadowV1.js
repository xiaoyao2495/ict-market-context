'use strict';

/**
 * Audit-only Structural Retirement shadow for persistent EQ clusters.
 * No production Registry, Sweep, WATCH, AMD, Scenario, or notification import.
 */
var pivotDetector = require('../structure/pivotDetector');
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var structuralProvenance = require('../structure/structuralProvenance5m');
var eqV3 = require('./eqPersistentClusterShadowV3');
var thresholds = require('../config/thresholds').equalLiquidity;

function chronological(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if (a.sourceOpenTime !== b.sourceOpenTime) return a.sourceOpenTime - b.sourceOpenTime;
    return String(a.id).localeCompare(String(b.id));
}
function mean(members) {
    return members.reduce(function (sum, member) { return sum + member.price; }, 0) / members.length;
}
function makeSwing(kind, sourceIndex, confirmIndex, candles, symbol, timeframe) {
    var source = candles[sourceIndex];
    var confirm = candles[confirmIndex];
    var type = kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id: symbol + ':' + timeframe + ':' + type + ':' + source.openTime,
        symbol: symbol, timeframe: timeframe, type: type,
        side: kind === 'HIGH' ? 'BSL' : 'SSL',
        price: kind === 'HIGH' ? source.high : source.low,
        sourceOpenTime: source.openTime, sourceCloseTime: source.closeTime,
        createdAt: confirm.closeTime, confirmedAt: confirm.closeTime,
        status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null,
        metadata: { source: source.source || null, index: sourceIndex, right: 2 }
    };
}
function applyLifecycle(target, candle) {
    var result = liquidityLifecycle.evaluateLiquidity(target, candle);
    if (!result) return null;
    target.status = result.status;
    target.touchedAt = result.touchedAt;
    target.sweptAt = result.sweptAt;
    target.brokenAt = result.brokenAt;
    return result;
}
function createRetirementState(cluster) {
    return {
        state: 'ACTIVE',
        clusterId: cluster.id,
        clusterInstanceId: cluster.instanceId,
        formationConfirmedAt: cluster.confirmedAt,
        zoneLow: cluster.formationZone.low,
        zoneHigh: cluster.formationZone.high,
        zoneExit: null,
        mss: null,
        bosOrContinuation: null,
        newControllingOrProtectedSwing: null,
        retirement: null
    };
}
function isZoneExit(cluster, candle) {
    return cluster.type === 'EQH'
        ? candle.high < cluster.formationZone.low
        : candle.low > cluster.formationZone.high;
}
function compactEvent(event) {
    return event ? {
        id: event.id,
        type: event.type,
        direction: event.direction,
        occurredAt: event.occurredAt,
        confirmedAt: event.confirmedAt
    } : null;
}
function advanceRetirement(cluster, input) {
    var state = cluster.retirement;
    if (state.state === 'STRUCTURALLY_RETIRED') return null;
    var evaluationTime = input.evaluationTime;
    var candle = input.candle;
    if (evaluationTime < cluster.confirmedAt) return null;
    if (!state.zoneExit && candle.closeTime > cluster.confirmedAt && isZoneExit(cluster, candle)) {
        state.zoneExit = {
            occurredAt: candle.openTime,
            confirmedAt: candle.closeTime
        };
    }
    (input.events || []).slice().sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
    }).forEach(function (event) {
        if (!state.zoneExit || event.confirmedAt > evaluationTime ||
            event.confirmedAt <= cluster.confirmedAt ||
            event.confirmedAt <= state.zoneExit.confirmedAt) return;
        if (event.type === 'STRUCTURAL_MSS') {
            state.mss = compactEvent(event);
            state.bosOrContinuation = null;
            state.newControllingOrProtectedSwing = null;
            return;
        }
        if ((event.type === 'STRUCTURAL_BOS' || event.type === 'STRUCTURAL_CONTINUATION') &&
            state.mss && event.confirmedAt > state.mss.confirmedAt &&
            event.direction === state.mss.direction) {
            state.bosOrContinuation = compactEvent(event);
        }
    });
    if (state.bosOrContinuation) {
        var compatible = (input.structuralSwings || []).filter(function (swing) {
            return swing.confirmedAt <= evaluationTime &&
                swing.confirmedAt >= state.bosOrContinuation.confirmedAt &&
                swing.direction === state.bosOrContinuation.direction &&
                (swing.type === 'CONTROLLING_SWING' || swing.type === 'ACTIVE_PROTECTED');
        }).sort(function (a, b) {
            return a.confirmedAt - b.confirmedAt || String(a.id).localeCompare(String(b.id));
        });
        if (compatible.length) state.newControllingOrProtectedSwing = compatible[0];
    }
    if (!state.zoneExit || !state.mss || !state.bosOrContinuation ||
        !state.newControllingOrProtectedSwing) return null;
    if (!(state.zoneExit.confirmedAt < state.mss.confirmedAt &&
        state.mss.confirmedAt < state.bosOrContinuation.confirmedAt &&
        state.bosOrContinuation.confirmedAt <= state.newControllingOrProtectedSwing.confirmedAt &&
        state.newControllingOrProtectedSwing.confirmedAt <= evaluationTime)) return null;
    if (state.mss.direction !== state.bosOrContinuation.direction ||
        state.mss.direction !== state.newControllingOrProtectedSwing.direction) return null;
    state.state = 'STRUCTURALLY_RETIRED';
    state.retirement = {
        occurredAt: state.newControllingOrProtectedSwing.occurredAt,
        confirmedAt: state.newControllingOrProtectedSwing.confirmedAt,
        evaluationTime: evaluationTime
    };
    return state.retirement;
}
function structuralSwingsAt(state, evaluationTime, events) {
    var directions = {};
    (events || []).forEach(function (event) {
        if ((event.type === 'STRUCTURAL_BOS' || event.type === 'STRUCTURAL_CONTINUATION') &&
            event.source && event.source.controllingSwingId) {
            directions[event.source.controllingSwingId] = event.direction;
        }
    });
    var out = [];
    Object.keys(directions).forEach(function (sourceId) {
        var swing = state.swingBySourceId[sourceId];
        if (!swing) return;
        var history = swing.history.filter(function (row) {
            return row.confirmedAt <= evaluationTime &&
                (row.role === 'CONTROLLING_SWING' || row.role === 'ACTIVE_PROTECTED');
        }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
        if (!history.length) return;
        var row = history[history.length - 1];
        out.push({
            id: swing.id,
            sourceSwingId: sourceId,
            type: row.role,
            price: swing.price,
            occurredAt: swing.occurredAt,
            confirmedAt: row.confirmedAt,
            direction: directions[sourceId]
        });
    });
    return out;
}
function run(candles, options) {
    var opts = options || {};
    var symbol = opts.symbol || 'BTCUSDT';
    var timeframe = opts.timeframe || '5m';
    var validationStart = opts.validationStart == null ? candles[0].openTime : opts.validationStart;
    var validationEnd = opts.validationEnd == null ? candles[candles.length - 1].closeTime : opts.validationEnd;
    var cfg = opts.thresholds || thresholds;
    var clusterIdFactory = opts.clusterIdFactory || eqV3.clusterIdV3;
    var useLegacyInstanceDisambiguator = opts.useLegacyInstanceDisambiguator === true;
    var atrSeries = eqV3.buildAtrSeries(candles, cfg.atrPeriod);
    var structureState = structuralProvenance.createState({ symbol: symbol, timeframe: timeframe });
    var swings = [];
    var clusters = [];
    var activeMembership = {};
    var retiredMemberIds = {};
    var retirementLedger = [];
    var rejectedAppendLedger = [];
    var memberAppendLedger = [];
    var decisions = [];
    var instanceSequence = 0;

    function key(type, swingId) { return type + '|' + swingId; }
    function release(cluster) {
        cluster.members.forEach(function (member) {
            var k = key(cluster.type, member.id);
            if (activeMembership[k] === cluster.instanceId) delete activeMembership[k];
        });
    }
    function reserve(cluster) {
        cluster.members.forEach(function (member) {
            activeMembership[key(cluster.type, member.id)] = cluster.instanceId;
        });
    }
    function recordRetirement(cluster) {
        cluster.members.forEach(function (member) { retiredMemberIds[key(cluster.type, member.id)] = true; });
        release(cluster);
        var r = cluster.retirement;
        retirementLedger.push({
            clusterId: cluster.id,
            clusterInstanceId: cluster.instanceId,
            side: cluster.type,
            formationConfirmedAt: cluster.confirmedAt,
            zoneExitOccurredAt: r.zoneExit.occurredAt,
            zoneExitConfirmedAt: r.zoneExit.confirmedAt,
            mss: r.mss,
            bosOrContinuation: r.bosOrContinuation,
            newControllingOrProtectedSwing: r.newControllingOrProtectedSwing,
            retirementOccurredAt: r.retirement.occurredAt,
            retirementConfirmedAt: r.retirement.confirmedAt,
            evaluationTime: r.retirement.evaluationTime,
            lastMemberBeforeRetirement: cluster.members[cluster.members.length - 1].id,
            membersAtRetirement: cluster.members.map(function (member) { return member.id; })
        });
    }
    function createCluster(anchor, candidate, feature, confirmIndex) {
        var type = candidate.type === 'SWING_HIGH' ? 'EQH' : 'EQL';
        var publicId = clusterIdFactory(symbol, timeframe, type, anchor, candidate);
        var instanceId = useLegacyInstanceDisambiguator
            ? publicId + ':INSTANCE:' + candidate.confirmedAt + ':' + instanceSequence++
            : publicId;
        var reference = mean([anchor, candidate]);
        var atr = atrSeries[confirmIndex];
        var cluster = {
            id: publicId,
            instanceId: instanceId,
            symbol: symbol, timeframe: timeframe, type: type,
            side: type === 'EQH' ? 'BSL' : 'SSL',
            formationAnchor: anchor,
            members: [anchor, candidate],
            price: reference,
            createdAt: candidate.confirmedAt,
            confirmedAt: candidate.confirmedAt,
            lastMemberConfirmedAt: candidate.confirmedAt,
            status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null,
            formationZone: { low: reference - cfg.formationZoneATR * atr,
                high: reference + cfg.formationZoneATR * atr, atr: atr },
            initialPairFeatures: feature
        };
        cluster.retirement = createRetirementState(cluster);
        clusters.push(cluster);
        reserve(cluster);
        decisions.push({ eventType: 'EQ_CLUSTER_CREATED', clusterId: publicId,
            clusterInstanceId: instanceId, effectiveAt: candidate.confirmedAt,
            initialMemberIds: [anchor.id, candidate.id] });
        return cluster;
    }
    function processCandidate(candidate, confirmIndex) {
        var type = candidate.type === 'SWING_HIGH' ? 'EQH' : 'EQL';
        var activeCompatible = [];
        var retiredCompatible = [];
        clusters.forEach(function (cluster) {
            if (cluster.type !== type) return;
            var feature = eqV3.pairFeatures(cluster.formationAnchor, candidate, type, candles, atrSeries, cfg);
            if (feature.classification !== 'VALID_EQ') return;
            if (cluster.retirement.state === 'STRUCTURALLY_RETIRED' && cluster.status === 'ACTIVE') {
                retiredCompatible.push({ cluster: cluster, feature: feature });
            } else if (cluster.status === 'ACTIVE') {
                activeCompatible.push({ cluster: cluster, feature: feature });
            }
        });
        if (activeCompatible.length > 1) {
            decisions.push({ eventType: 'AMBIGUOUS_UNASSIGNED', candidateSwingId: candidate.id,
                candidateConfirmedAt: candidate.confirmedAt,
                compatibleClusterInstanceIds: activeCompatible.map(function (row) { return row.cluster.instanceId; }) });
            return;
        }
        if (activeCompatible.length === 1) {
            var match = activeCompatible[0];
            if (activeMembership[key(type, candidate.id)]) return;
            match.cluster.members.push(candidate);
            match.cluster.price = mean(match.cluster.members);
            match.cluster.lastMemberConfirmedAt = candidate.confirmedAt;
            activeMembership[key(type, candidate.id)] = match.cluster.instanceId;
            var append = {
                eventType: 'EQ_MEMBER_APPENDED',
                eventId: 'EQ_MEMBER_APPENDED:' + match.cluster.instanceId + ':' + candidate.id + ':' + candidate.confirmedAt,
                clusterId: match.cluster.id,
                clusterInstanceId: match.cluster.instanceId,
                candidateSwingId: candidate.id,
                candidateOccurredAt: candidate.sourceOpenTime,
                candidateConfirmedAt: candidate.confirmedAt,
                memberAddedAt: candidate.confirmedAt,
                anchorPairFeatures: match.feature
            };
            memberAppendLedger.push(append);
            decisions.push(append);
            return;
        }

        retiredCompatible.forEach(function (match) {
            var retiredAt = match.cluster.retirement.retirement.confirmedAt;
            rejectedAppendLedger.push({
                clusterId: match.cluster.id,
                clusterInstanceId: match.cluster.instanceId,
                candidateSwingId: candidate.id,
                side: type,
                candidateOccurredAt: candidate.sourceOpenTime,
                candidateConfirmedAt: candidate.confirmedAt,
                retirementConfirmedAt: retiredAt,
                reason: 'STRUCTURALLY_RETIRED',
                wouldAppendUnderOriginalV3: true,
                futureSafe: retiredAt <= candidate.confirmedAt
            });
        });

        if (activeMembership[key(type, candidate.id)] || retiredMemberIds[key(type, candidate.id)]) return;
        var eligible = swings.filter(function (prior) {
            return prior.id !== candidate.id && prior.type === candidate.type &&
                chronological(prior, candidate) < 0 &&
                (prior.status === 'ACTIVE' || prior.status === 'TOUCHED') &&
                !activeMembership[key(type, prior.id)] && !retiredMemberIds[key(type, prior.id)];
        }).sort(chronological);
        for (var i = 0; i < eligible.length; i++) {
            var feature = eqV3.pairFeatures(eligible[i], candidate, type, candles, atrSeries, cfg);
            if (feature.classification === 'VALID_EQ') {
                createCluster(eligible[i], candidate, feature, confirmIndex);
                return;
            }
        }
    }

    candles.forEach(function (candle, index) {
        if (!candle || candle.closed === false) return;
        swings.forEach(function (swing) {
            if (swing.confirmedAt < candle.closeTime) applyLifecycle(swing, candle);
        });
        clusters.forEach(function (cluster) {
            if (cluster.confirmedAt >= candle.closeTime || cluster.status === 'BROKEN') return;
            var event = applyLifecycle(cluster, candle);
            if (event && cluster.status !== 'ACTIVE') release(cluster);
        });

        var sourceIndex = index - 2;
        var newSwings = [];
        if (sourceIndex >= 2) {
            if (pivotDetector.detectPivotHigh(candles, sourceIndex, 2, 2)) {
                newSwings.push(makeSwing('HIGH', sourceIndex, index, candles, symbol, timeframe));
            }
            if (pivotDetector.detectPivotLow(candles, sourceIndex, 2, 2)) {
                newSwings.push(makeSwing('LOW', sourceIndex, index, candles, symbol, timeframe));
            }
        }
        var structureOutput = structuralProvenance.step(structureState, candle, index, newSwings);
        var structureSwings = structuralSwingsAt(structureState, candle.closeTime, structureOutput.events);
        clusters.forEach(function (cluster) {
            if (cluster.confirmedAt >= candle.closeTime || cluster.retirement.state !== 'ACTIVE' ||
                cluster.status !== 'ACTIVE') return;
            var retired = advanceRetirement(cluster, {
                candle: candle,
                events: structureOutput.events,
                structuralSwings: structureSwings,
                evaluationTime: candle.closeTime
            });
            if (retired) recordRetirement(cluster);
        });
        newSwings.sort(chronological).forEach(function (swing) {
            swings.push(swing);
            processCandidate(swing, index);
        });
    });

    var validationClusters = clusters.filter(function (cluster) {
        return cluster.confirmedAt >= validationStart && cluster.confirmedAt <= validationEnd;
    });
    var newFormationAfterRetirement = [];
    var newFormationSeen = {};
    validationClusters.forEach(function (cluster) {
        retirementLedger.forEach(function (retired) {
            if (cluster.confirmedAt <= retired.retirementConfirmedAt || cluster.type !== retired.side) return;
            var old = clusters.filter(function (c) { return c.instanceId === retired.clusterInstanceId; })[0];
            if (!old) return;
            var sameZone = cluster.price >= old.formationZone.low && cluster.price <= old.formationZone.high;
            if (sameZone && cluster.members.every(function (member) {
                return retired.membersAtRetirement.indexOf(member.id) === -1;
            }) && !newFormationSeen[cluster.instanceId]) {
                newFormationSeen[cluster.instanceId] = true;
                newFormationAfterRetirement.push({
                    retiredClusterId: retired.clusterId,
                    retiredClusterInstanceId: retired.clusterInstanceId,
                    newClusterId: cluster.id,
                    newClusterInstanceId: cluster.instanceId,
                    formedAt: cluster.confirmedAt,
                    initialMemberIds: cluster.members.slice(0, 2).map(function (member) { return member.id; })
                });
            }
        });
    });
    return {
        clusters: clusters,
        validationClusters: validationClusters,
        swings: swings,
        retirementLedger: retirementLedger,
        rejectedAppendLedger: rejectedAppendLedger,
        memberAppendLedger: memberAppendLedger,
        decisions: decisions,
        newFormationAfterRetirement: newFormationAfterRetirement,
        finalHash: eqV3.hash({
            clusters: clusters.map(function (cluster) {
                return { instanceId: cluster.instanceId, id: cluster.id,
                    memberIds: cluster.members.map(function (member) { return member.id; }),
                    retirement: cluster.retirement, status: cluster.status };
            }),
            retirementLedger: retirementLedger,
            rejectedAppendLedger: rejectedAppendLedger,
            newFormationAfterRetirement: newFormationAfterRetirement
        })
    };
}

module.exports = {
    createRetirementState: createRetirementState,
    advanceRetirement: advanceRetirement,
    isZoneExit: isZoneExit,
    run: run
};
