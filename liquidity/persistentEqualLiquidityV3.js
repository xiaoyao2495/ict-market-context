'use strict';

/**
 * Persistent EQH/EQL V3 production producer.
 *
 * It changes only EQ object identity/membership construction. Price equality,
 * formation independence, Swing confirmation and lifecycle evaluation remain
 * delegated to the frozen V2 pair classifier and normal lifecycle engine.
 */
var equalLiquidityV2 = require('./equalLiquidity');
var lifecycle = require('./liquidityLifecycle');

function chronological(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if (a.sourceOpenTime !== b.sourceOpenTime) return a.sourceOpenTime - b.sourceOpenTime;
    return String(a.id).localeCompare(String(b.id));
}

function clusterId(symbol, timeframe, side, first, second) {
    var members = [first, second].slice().sort(chronological);
    return ['EQV3', symbol, timeframe, side, '[' + members[0].id + ']', '[' + members[1].id + ']'].join(':');
}

function memberRecord(swing, memberAddedAt) {
    return {
        id: swing.id,
        canonicalSwingId: swing.id,
        price: swing.price,
        sourceOpenTime: swing.sourceOpenTime,
        sourceCloseTime: swing.sourceCloseTime,
        occurredAt: swing.sourceOpenTime,
        confirmedAt: swing.confirmedAt,
        memberAddedAt: memberAddedAt,
        type: swing.type,
        side: swing.side
    };
}

function meanMembers(members) {
    if (!members.length) return null;
    return members.reduce(function (sum, member) { return sum + member.price; }, 0) / members.length;
}

function effectiveStatus(liquidity, candle) {
    if (!liquidity || liquidity.status !== 'ACTIVE') return liquidity && liquidity.status;
    if (!candle || liquidity.confirmedAt >= candle.closeTime) return liquidity.status;
    var projected = {
        price: liquidity.price,
        side: liquidity.side,
        status: liquidity.status,
        touchedAt: liquidity.touchedAt || null,
        sweptAt: liquidity.sweptAt || null,
        brokenAt: liquidity.brokenAt || null
    };
    var event = lifecycle.evaluateLiquidity(projected, candle);
    return event ? event.status : projected.status;
}

function classify(anchor, candidate, side, options) {
    var result = equalLiquidityV2.evaluateEqualLiquidityPipeline([anchor, candidate], {
        symbol: options.symbol,
        evaluationTime: options.evaluationTime,
        tickSize: options.tickSize,
        secondSwingIds: [candidate.id],
        lifecycleFromCurrentState: true,
        canonicalClosedCandles: true,
        candles: options.candles
    });
    var pair = result.pairs.filter(function (row) {
        return row.side === side && row.firstSwingId === anchor.id && row.secondSwingId === candidate.id;
    })[0];
    return pair || null;
}

function activeOwnerMap(clusters, candle) {
    var owners = {};
    clusters.forEach(function (cluster) {
        if (effectiveStatus(cluster, candle) !== 'ACTIVE') return;
        (cluster.metadata.members || []).forEach(function (member) {
            owners[cluster.type + '|' + member.id] = cluster.id;
        });
    });
    return owners;
}

function buildCluster(symbol, timeframe, side, anchor, candidate, features) {
    var type = side;
    var members = [anchor, candidate].slice().sort(chronological).map(function (swing) {
        return memberRecord(swing, candidate.confirmedAt);
    });
    var price = meanMembers(members);
    return {
        id: clusterId(symbol, timeframe, side, anchor, candidate),
        symbol: symbol,
        timeframe: timeframe,
        type: type,
        liquidityType: type,
        side: type === 'EQH' ? 'BSL' : 'SSL',
        price: price,
        sourceOpenTime: members[0].sourceOpenTime,
        sourceCloseTime: members[members.length - 1].sourceCloseTime,
        occurredAt: members[0].sourceOpenTime,
        createdAt: candidate.confirmedAt,
        confirmedAt: candidate.confirmedAt,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {
            pipelineVersion: 3,
            eqModelVersion: 'V3',
            classification: 'VALID_EQ',
            formationAnchorId: anchor.id,
            formationAnchorPrice: anchor.price,
            formationMemberIds: members.map(function (member) { return member.id; }),
            members: members,
            memberCount: members.length,
            referencePrice: price,
            lastMemberConfirmedAt: candidate.confirmedAt,
            initialPairFeatures: features,
            source: anchor.metadata && anchor.metadata.source || null
        }
    };
}

function appendMember(cluster, candidate, features) {
    var members = cluster.metadata.members;
    if (members.some(function (member) { return member.id === candidate.id; })) return false;
    members.push(memberRecord(candidate, candidate.confirmedAt));
    members.sort(chronological);
    cluster.price = meanMembers(members);
    cluster.sourceCloseTime = Math.max(cluster.sourceCloseTime || 0, candidate.sourceCloseTime || 0);
    cluster.metadata.memberCount = members.length;
    cluster.metadata.referencePrice = cluster.price;
    cluster.metadata.lastMemberConfirmedAt = candidate.confirmedAt;
    if (!cluster.metadata.appendLedger) cluster.metadata.appendLedger = [];
    cluster.metadata.appendLedger.push({
        eventId: 'EQ_MEMBER_APPENDED:' + cluster.id + ':' + candidate.id + ':' + candidate.confirmedAt,
        canonicalSwingId: candidate.id,
        memberAddedAt: candidate.confirmedAt,
        memberConfirmedAt: candidate.confirmedAt,
        anchorPairFeatures: features
    });
    return true;
}

function projectMembersAsOf(cluster, evaluationTime) {
    var members = cluster && cluster.metadata && cluster.metadata.members || [];
    var visible = members.filter(function (member) {
        var addedAt = member.memberAddedAt === undefined ? member.confirmedAt : member.memberAddedAt;
        return member.confirmedAt <= evaluationTime && addedAt <= evaluationTime;
    }).slice().sort(chronological);
    return {
        eqObjectId: cluster && cluster.id || null,
        asOf: evaluationTime,
        referencePrice: meanMembers(visible),
        formationAnchorId: cluster && cluster.metadata && cluster.metadata.formationAnchorId || null,
        formationAnchorPrice: cluster && cluster.metadata && cluster.metadata.formationAnchorPrice,
        memberCount: visible.length,
        members: visible.map(function (member) {
            return {
                id: member.id,
                canonicalSwingId: member.canonicalSwingId || member.id,
                price: member.price,
                occurredAt: member.occurredAt || member.sourceOpenTime,
                confirmedAt: member.confirmedAt,
                memberAddedAt: member.memberAddedAt === undefined ? member.confirmedAt : member.memberAddedAt
            };
        })
    };
}

function processCandidates(state, addedSwings, options) {
    var registry = state.registry;
    // The input adapter may supply an EQ-only Qualified Swing pool. Falling
    // back to the main registry preserves the explicit RAW_LEGACY rollback and
    // existing direct unit fixtures. The two sources are never combined.
    var candidatePool = options.candidatePool || registry.getByType(state.symbol, 'SWING_HIGH')
        .concat(registry.getByType(state.symbol, 'SWING_LOW'));
    var getSwingById = options.getSwingById || function (id) { return registry.getById(id); };
    var clusters = registry.getByType(state.symbol, 'EQH').concat(registry.getByType(state.symbol, 'EQL'))
        .filter(function (cluster) { return cluster.metadata && cluster.metadata.eqModelVersion === 'V3'; });
    var candle = options.candles[options.index];
    var decisions = [];

    addedSwings.slice().sort(chronological).forEach(function (candidate) {
        var side = candidate.type === 'SWING_HIGH' ? 'EQH' : 'EQL';
        var owners = activeOwnerMap(clusters, candle);
        var compatible = [];
        clusters.forEach(function (cluster) {
            if (cluster.type !== side || effectiveStatus(cluster, candle) !== 'ACTIVE') return;
            var anchor = getSwingById(cluster.metadata.formationAnchorId);
            var features = anchor && classify(anchor, candidate, side, options);
            if (features && features.classification === 'VALID_EQ') compatible.push({ cluster: cluster, features: features });
        });
        if (compatible.length > 1) {
            decisions.push({ eventType:'AMBIGUOUS_UNASSIGNED', candidateSwingId:candidate.id,
                candidateConfirmedAt:candidate.confirmedAt, compatibleClusterIds:compatible.map(function (row) { return row.cluster.id; }).sort() });
            return;
        }
        if (compatible.length === 1) {
            if (owners[side + '|' + candidate.id]) return;
            if (appendMember(compatible[0].cluster, candidate, compatible[0].features)) {
                decisions.push(compatible[0].cluster.metadata.appendLedger.slice(-1)[0]);
            }
            return;
        }
        if (owners[side + '|' + candidate.id]) return;
        var prior = candidatePool.filter(function (swing) {
            return swing.type === candidate.type && swing.id !== candidate.id && chronological(swing, candidate) < 0 &&
                (swing.status === 'ACTIVE' || swing.status === 'TOUCHED') && !owners[side + '|' + swing.id];
        }).sort(chronological);
        for (var i = 0; i < prior.length; i++) {
            var features = classify(prior[i], candidate, side, options);
            if (!features || features.classification !== 'VALID_EQ') continue;
            var cluster = buildCluster(state.symbol, state.timeframe, side, prior[i], candidate, features);
            if (registry.add(cluster)) {
                clusters.push(cluster);
                decisions.push({ eventType:'EQ_CLUSTER_CREATED', clusterId:cluster.id,
                    effectiveAt:candidate.confirmedAt, initialMemberIds:cluster.metadata.formationMemberIds.slice() });
            }
            break;
        }
    });
    if (!state.eqV3DecisionLedger) state.eqV3DecisionLedger = [];
    Array.prototype.push.apply(state.eqV3DecisionLedger, decisions);
    return decisions;
}

module.exports = {
    chronological: chronological,
    clusterId: clusterId,
    memberRecord: memberRecord,
    meanMembers: meanMembers,
    projectMembersAsOf: projectMembersAsOf,
    processCandidates: processCandidates,
    effectiveStatus: effectiveStatus
};
