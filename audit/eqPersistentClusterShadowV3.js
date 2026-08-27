'use strict';

/**
 * Bounded EQH/EQL persistent-cluster shadow V3.
 *
 * Audit-only implementation. It does not import or mutate the production
 * liquidity Registry, Sweep, WATCH, or notification paths.
 */
var crypto = require('crypto');
var pivotDetector = require('../structure/pivotDetector');
var lifecycle = require('../liquidity/liquidityLifecycle');
var defaultThresholds = require('../config/thresholds').equalLiquidity;

var PAIR_STATE = {
    VALID: 'VALID_EQ',
    BORDERLINE: 'BORDERLINE_EQ',
    REJECT: 'REJECT_EQ'
};

function chronological(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if (a.sourceOpenTime !== b.sourceOpenTime) return a.sourceOpenTime - b.sourceOpenTime;
    return String(a.id).localeCompare(String(b.id));
}

/**
 * Legacy V3 shadow identity retained only so the collision audit can prove
 * before/after semantic equivalence. It is not the default identity.
 */
function legacyClusterIdV3Shadow(symbol, timeframe, side, firstSwing) {
    return symbol + ':' + side + ':' + firstSwing.sourceOpenTime;
}

/**
 * Immutable, formation-time-safe public identity for a V3 EQ cluster.
 * The two formation members are canonicalized before serialization, so input
 * enumeration order cannot change the result. No later member, lifecycle, or
 * reference-price field participates in identity.
 */
function clusterIdV3(symbol, timeframe, side, firstSwing, secondSwing) {
    var formationMembers = [firstSwing, secondSwing].slice().sort(chronological);
    return [
        'EQV3', symbol, timeframe, side,
        '[' + formationMembers[0].id + ']',
        '[' + formationMembers[1].id + ']'
    ].join(':');
}

function mean(items) {
    if (!items.length) return null;
    return items.reduce(function (sum, item) { return sum + item.price; }, 0) / items.length;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function buildAtrSeries(candles, period) {
    var out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    var tr = new Array(candles.length).fill(null);
    var sum = 0;
    var i;
    for (i = 1; i < candles.length; i++) {
        tr[i] = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low - candles[i - 1].close)
        );
    }
    for (i = 1; i <= period; i++) sum += tr[i];
    out[period] = sum / period;
    for (i = period + 1; i < candles.length; i++) {
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
}

function makeSwing(symbol, timeframe, kind, sourceIndex, confirmIndex, candles) {
    var source = candles[sourceIndex];
    var confirmed = candles[confirmIndex];
    var type = kind === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
    return {
        id: symbol + ':' + timeframe + ':' + type + ':' + source.openTime,
        symbol: symbol,
        timeframe: timeframe,
        type: type,
        side: kind === 'HIGH' ? 'BSL' : 'SSL',
        price: kind === 'HIGH' ? source.high : source.low,
        sourceOpenTime: source.openTime,
        sourceCloseTime: source.closeTime,
        createdAt: confirmed.closeTime,
        confirmedAt: confirmed.closeTime,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: { source: source.source || null, index: sourceIndex, right: 2 }
    };
}

function pairFeatures(anchor, candidate, side, candles, atrByIndex, cfg) {
    var confirmIndex = candidate.metadata.index + candidate.metadata.right;
    var atr = atrByIndex[confirmIndex];
    var absoluteDistance = Math.abs(anchor.price - candidate.price);
    var base = {
        pairId: side + ':' + anchor.id + ':' + candidate.id,
        side: side,
        anchorSwingId: anchor.id,
        candidateSwingId: candidate.id,
        anchorPrice: anchor.price,
        candidatePrice: candidate.price,
        absoluteDistance: absoluteDistance,
        atrAtCandidateConfirmation: atr,
        distanceATR: null,
        departureATR: null,
        maxConsecutiveBarsOutsideZone_0_5ATR: null,
        barsApart: Math.abs(candidate.metadata.index - anchor.metadata.index),
        classification: PAIR_STATE.REJECT,
        rejectionReason: null
    };
    if (!(typeof atr === 'number' && isFinite(atr) && atr > 0)) {
        base.rejectionReason = 'ATR_UNAVAILABLE';
        return base;
    }
    base.distanceATR = absoluteDistance / atr;
    if (base.distanceATR > cfg.priceFailAboveATR) {
        base.rejectionReason = 'PRICE_FAIL';
        return base;
    }
    var start = anchor.metadata.index + 1;
    var end = candidate.metadata.index;
    if (start >= end) {
        base.rejectionReason = 'FORMATION_PATH_UNAVAILABLE';
        return base;
    }
    var zone = cfg.formationZoneATR * atr;
    var eqZonePrice = side === 'EQH'
        ? Math.min(anchor.price, candidate.price)
        : Math.max(anchor.price, candidate.price);
    var departure = 0;
    var run = 0;
    var maxRun = 0;
    for (var i = start; i < end; i++) {
        var candle = candles[i];
        if (side === 'EQH') {
            departure = Math.max(departure, eqZonePrice - candle.low);
            run = candle.high < eqZonePrice - zone ? run + 1 : 0;
        } else {
            departure = Math.max(departure, candle.high - eqZonePrice);
            run = candle.low > eqZonePrice + zone ? run + 1 : 0;
        }
        if (run > maxRun) maxRun = run;
    }
    base.departureATR = Math.max(0, departure) / atr;
    base.maxConsecutiveBarsOutsideZone_0_5ATR = maxRun;
    if (base.distanceATR <= cfg.priceStrongMaxATR &&
        base.departureATR >= cfg.formationDepartureMinATR &&
        maxRun >= cfg.formationMinConsecutiveOutsideBars) {
        base.classification = PAIR_STATE.VALID;
        return base;
    }
    base.classification = PAIR_STATE.BORDERLINE;
    base.rejectionReason = base.distanceATR > cfg.priceStrongMaxATR
        ? 'PRICE_BORDERLINE'
        : 'FORMATION_INDEPENDENCE_FAIL';
    return base;
}

function applyLifecycle(target, candle) {
    var event = lifecycle.evaluateLiquidity(target, candle);
    if (!event) return null;
    target.status = event.status;
    target.touchedAt = event.touchedAt;
    target.sweptAt = event.sweptAt;
    target.brokenAt = event.brokenAt;
    return event;
}

function visibleMembers(base, memberLedger, evaluationTime) {
    return base.initialMembers.concat(memberLedger.filter(function (row) {
        return row.clusterId === base.id &&
            row.memberAddedAt <= evaluationTime && row.memberConfirmedAt <= evaluationTime;
    }).map(function (row) { return row.member; })).sort(chronological);
}

function projectClusterAsOf(base, memberLedger, lifecycleLedger, evaluationTime) {
    if (base.confirmedAt > evaluationTime) return null;
    var members = visibleMembers(base, memberLedger, evaluationTime);
    var events = lifecycleLedger.filter(function (row) {
        return row.clusterId === base.id && row.effectiveAt <= evaluationTime;
    }).sort(function (a, b) {
        if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt;
        return a.sequence - b.sequence;
    });
    var last = events.length ? events[events.length - 1] : null;
    return {
        id: base.id,
        type: base.type,
        side: base.side,
        createdAt: base.createdAt,
        confirmedAt: base.confirmedAt,
        formationAnchorId: base.formationAnchor.id,
        memberIds: members.map(function (member) { return member.id; }),
        memberCount: members.length,
        referencePrice: mean(members),
        lastMemberConfirmedAt: Math.max.apply(null, members.map(function (member) {
            return member.confirmedAt;
        })),
        status: last ? last.status : 'ACTIVE',
        touchedAt: last ? last.touchedAt : null,
        sweptAt: last ? last.sweptAt : null,
        brokenAt: last ? last.brokenAt : null
    };
}

function runShadow(candles, options) {
    var opts = options || {};
    var symbol = opts.symbol || 'BTCUSDT';
    var timeframe = opts.timeframe || '5m';
    var left = opts.left || 2;
    var right = opts.right || 2;
    var validationStart = opts.validationStart === undefined ? candles[0].openTime : opts.validationStart;
    var validationEnd = opts.validationEnd === undefined
        ? candles[candles.length - 1].closeTime
        : opts.validationEnd;
    var cfg = opts.thresholds || defaultThresholds;
    var clusterIdFactory = opts.clusterIdFactory || clusterIdV3;
    var atrByIndex = buildAtrSeries(candles, cfg.atrPeriod);
    var swings = [];
    var clusters = [];
    var baseLedger = [];
    var memberLedger = [];
    var lifecycleLedger = [];
    var decisionLedger = [];
    var activeMembership = {};
    var checkpoints = [];
    var lifecycleSequence = 0;

    function membershipKey(side, swingId) { return side + '|' + swingId; }
    function releaseCluster(cluster) {
        cluster.members.forEach(function (member) {
            var key = membershipKey(cluster.type, member.id);
            if (activeMembership[key] === cluster.id) delete activeMembership[key];
        });
    }
    function reserveCluster(cluster) {
        cluster.members.forEach(function (member) {
            activeMembership[membershipKey(cluster.type, member.id)] = cluster.id;
        });
    }
    function recordLifecycle(cluster, event, candle) {
        lifecycleLedger.push({
            eventId: 'EQ_LIFECYCLE:' + cluster.id + ':' + event.status + ':' + candle.closeTime,
            clusterId: cluster.id,
            status: event.status,
            touchedAt: event.touchedAt,
            sweptAt: event.sweptAt,
            brokenAt: event.brokenAt,
            effectiveAt: candle.closeTime,
            sequence: lifecycleSequence++
        });
    }
    function processCandidate(candidate) {
        var clusterType = candidate.type === 'SWING_HIGH' ? 'EQH' : 'EQL';
        var compatible = [];
        clusters.forEach(function (cluster) {
            if (cluster.type !== clusterType || cluster.status !== 'ACTIVE') return;
            var features = pairFeatures(
                cluster.formationAnchor, candidate, clusterType, candles, atrByIndex, cfg
            );
            if (features.classification === PAIR_STATE.VALID) {
                compatible.push({ cluster: cluster, features: features });
            }
        });
        if (compatible.length > 1) {
            decisionLedger.push({
                eventType: 'AMBIGUOUS_UNASSIGNED',
                candidateSwingId: candidate.id,
                candidateConfirmedAt: candidate.confirmedAt,
                side: clusterType,
                compatibleClusterIds: compatible.map(function (row) { return row.cluster.id; }).sort()
            });
            return;
        }
        if (compatible.length === 1) {
            var match = compatible[0];
            var candidateKey = membershipKey(clusterType, candidate.id);
            if (activeMembership[candidateKey]) return;
            var record = {
                eventType: 'EQ_MEMBER_APPENDED',
                eventId: 'EQ_MEMBER_APPENDED:' + match.cluster.id + ':' +
                    candidate.id + ':' + candidate.confirmedAt,
                clusterId: match.cluster.id,
                canonicalSwingId: candidate.id,
                memberConfirmedAt: candidate.confirmedAt,
                memberAddedAt: candidate.confirmedAt,
                price: candidate.price,
                clusterStatusBeforeAppend: match.cluster.status,
                anchorPairFeatures: match.features,
                member: candidate
            };
            memberLedger.push(record);
            match.cluster.members.push(candidate);
            match.cluster.price = mean(match.cluster.members);
            match.cluster.lastMemberConfirmedAt = candidate.confirmedAt;
            activeMembership[candidateKey] = match.cluster.id;
            decisionLedger.push(record);
            return;
        }

        var candidateKeyForCreation = membershipKey(clusterType, candidate.id);
        if (activeMembership[candidateKeyForCreation]) return;
        var eligible = swings.filter(function (prior) {
            return prior.id !== candidate.id && prior.type === candidate.type &&
                chronological(prior, candidate) < 0 &&
                (prior.status === 'ACTIVE' || prior.status === 'TOUCHED') &&
                !activeMembership[membershipKey(clusterType, prior.id)];
        }).sort(chronological);
        var selected = null;
        for (var i = 0; i < eligible.length; i++) {
            var creationFeatures = pairFeatures(
                eligible[i], candidate, clusterType, candles, atrByIndex, cfg
            );
            if (creationFeatures.classification === PAIR_STATE.VALID) {
                selected = { anchor: eligible[i], features: creationFeatures };
                break;
            }
        }
        if (!selected) return;
        var id = clusterIdFactory(
            symbol, timeframe, clusterType, selected.anchor, candidate
        );
        var cluster = {
            id: id,
            symbol: symbol,
            timeframe: timeframe,
            type: clusterType,
            side: clusterType === 'EQH' ? 'BSL' : 'SSL',
            formationAnchor: selected.anchor,
            members: [selected.anchor, candidate],
            price: mean([selected.anchor, candidate]),
            createdAt: candidate.confirmedAt,
            confirmedAt: candidate.confirmedAt,
            lastMemberConfirmedAt: candidate.confirmedAt,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            initialPairFeatures: selected.features
        };
        clusters.push(cluster);
        var base = {
            id: cluster.id,
            symbol: symbol,
            timeframe: timeframe,
            type: cluster.type,
            side: cluster.side,
            formationAnchor: selected.anchor,
            initialMembers: [selected.anchor, candidate],
            initialPairFeatures: selected.features,
            createdAt: candidate.confirmedAt,
            confirmedAt: candidate.confirmedAt
        };
        baseLedger.push(base);
        reserveCluster(cluster);
        decisionLedger.push({
            eventType: 'EQ_CLUSTER_CREATED',
            eventId: 'EQ_CLUSTER_CREATED:' + id + ':' + candidate.confirmedAt,
            clusterId: id,
            effectiveAt: candidate.confirmedAt,
            initialMemberIds: cluster.members.map(function (member) { return member.id; }),
            pairFeatures: selected.features
        });
    }

    candles.forEach(function (candle, candleIndex) {
        if (!candle || candle.closed === false) return;
        swings.forEach(function (swing) {
            if (swing.confirmedAt < candle.closeTime) applyLifecycle(swing, candle);
        });
        clusters.forEach(function (cluster) {
            if (cluster.confirmedAt >= candle.closeTime || cluster.status === 'BROKEN') return;
            var event = applyLifecycle(cluster, candle);
            if (!event) return;
            recordLifecycle(cluster, event, candle);
            if (cluster.status !== 'ACTIVE') releaseCluster(cluster);
        });

        var sourceIndex = candleIndex - right;
        if (sourceIndex >= left) {
            var newSwings = [];
            if (pivotDetector.detectPivotHigh(candles, sourceIndex, left, right)) {
                newSwings.push(makeSwing(symbol, timeframe, 'HIGH', sourceIndex, candleIndex, candles));
            }
            if (pivotDetector.detectPivotLow(candles, sourceIndex, left, right)) {
                newSwings.push(makeSwing(symbol, timeframe, 'LOW', sourceIndex, candleIndex, candles));
            }
            newSwings.sort(chronological).forEach(function (swing) {
                swings.push(swing);
                processCandidate(swing);
            });
        }

        if (candle.closeTime >= validationStart && candle.closeTime <= validationEnd &&
            ((candleIndex + 1) % (opts.checkpointEvery || 500) === 0 ||
                candle.closeTime === validationEnd)) {
            checkpoints.push({
                evaluationTime: candle.closeTime,
                clusterCount: baseLedger.filter(function (base) {
                    return base.confirmedAt <= candle.closeTime;
                }).length,
                projectionHash: hash(baseLedger.map(function (base) {
                    return projectClusterAsOf(base, memberLedger, lifecycleLedger, candle.closeTime);
                }).filter(Boolean))
            });
        }
    });

    var finalTime = Math.min(validationEnd, candles[candles.length - 1].closeTime);
    var finalProjection = baseLedger.map(function (base) {
        return projectClusterAsOf(base, memberLedger, lifecycleLedger, finalTime);
    }).filter(Boolean);
    return {
        config: {
            symbol: symbol,
            timeframe: timeframe,
            left: left,
            right: right,
            validationStart: validationStart,
            validationEnd: finalTime,
            thresholds: cfg
        },
        swings: swings,
        clusters: clusters,
        baseLedger: baseLedger,
        memberLedger: memberLedger,
        lifecycleLedger: lifecycleLedger,
        decisionLedger: decisionLedger,
        checkpoints: checkpoints,
        finalProjection: finalProjection
    };
}

module.exports = {
    PAIR_STATE: PAIR_STATE,
    buildAtrSeries: buildAtrSeries,
    pairFeatures: pairFeatures,
    projectClusterAsOf: projectClusterAsOf,
    runShadow: runShadow,
    stable: stable,
    hash: hash,
    clusterIdV3: clusterIdV3,
    legacyClusterIdV3Shadow: legacyClusterIdV3Shadow,
    chronological: chronological
};
