'use strict';

var assert = require('assert');
var performance = require('perf_hooks').performance;
var equalLiquidity = require('../liquidity/equalLiquidity');
var live = require('../scripts/live');

function chronological(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if (a.sourceOpenTime !== b.sourceOpenTime) return a.sourceOpenTime - b.sourceOpenTime;
    return String(a.id).localeCompare(String(b.id));
}

/** Frozen pre-optimization implementation: test oracle only. */
function oldGroupValidPairs(items, validPairs, side) {
    var sorted = items.slice().sort(chronological);
    var validByKey = {};
    validPairs.forEach(function (p) {
        validByKey[p.firstSwingId + '|' + p.secondSwingId] = p;
    });
    var used = {};
    var groups = [];
    sorted.forEach(function (anchor) {
        if (used[anchor.id]) return;
        var members = [anchor];
        var pairRows = [];
        sorted.forEach(function (candidate) {
            if (candidate.id === anchor.id || used[candidate.id]) return;
            var p = validByKey[anchor.id + '|' + candidate.id];
            if (!p) return;
            members.push(candidate);
            pairRows.push(p);
        });
        if (members.length >= 2) {
            members.forEach(function (m) { used[m.id] = true; });
            groups.push({ side: side, members: members, pairs: pairRows });
        }
    });
    return groups;
}

function item(id, time) {
    return { id: id, confirmedAt: time + 2, sourceOpenTime: time, price: 100 + time / 1000 };
}

function pair(a, b, tag) {
    return {
        pairId: tag || a.id + ':' + b.id,
        firstSwingId: a.id,
        secondSwingId: b.id,
        distanceATR: 0.1,
        departureATR: 2,
        maxConsecutiveBarsOutsideZone_0_5ATR: 3,
        barsApart: 10,
        firstSwingState: 'ACTIVE'
    };
}

function assertGroupingEquivalent(items, pairs, side) {
    var oldGroups = oldGroupValidPairs(items, pairs, side);
    var optimized = equalLiquidity.groupValidPairs(items, pairs, side);
    assert.deepStrictEqual(optimized, oldGroups);
    oldGroups.forEach(function (group, index) {
        assert.strictEqual(optimized[index].side, group.side);
        assert.strictEqual(optimized[index].members[0].id, group.members[0].id);
        assert.deepStrictEqual(
            optimized[index].members.map(function (x) { return x.id; }),
            group.members.map(function (x) { return x.id; })
        );
        assert.deepStrictEqual(
            optimized[index].pairs.map(function (x) { return x.pairId; }),
            group.pairs.map(function (x) { return x.pairId; })
        );
    });
}

function groupingTests() {
    var a = item('A', 1000);
    var b = item('B', 2000);
    var c = item('C', 3000);
    var d = item('D', 4000);

    // Bounded anchor: A-B and B-C must not transitively add C to anchor A.
    assertGroupingEquivalent([d, c, a, b], [pair(a, b), pair(b, c)], 'EQH');

    // used semantics: anchor A consumes B/C; B-D may no longer create a group.
    assertGroupingEquivalent([d, b, c, a], [pair(b, d), pair(a, c), pair(a, b)], 'EQH');

    // Last duplicate pair wins exactly as the old validByKey map did.
    assertGroupingEquivalent([a, b, c], [pair(a, b, 'old'), pair(a, b, 'last'), pair(a, c)], 'EQL');

    // Deterministic sparse populations with deliberately shuffled input/pair order.
    var many = [];
    for (var i = 0; i < 30; i++) many.push(item('S' + i, 10000 + i * 1000));
    var sparse = [];
    many.forEach(function (first, x) {
        many.forEach(function (second, y) {
            if (y > x && ((x * 17 + y * 13) % 19 === 0)) sparse.push(pair(first, second));
        });
    });
    assertGroupingEquivalent(many.slice().reverse(), sparse.slice().reverse(), 'EQH');
}

async function bootstrapTests() {
    var rows = [];
    for (var i = 0; i < 600; i++) rows.push({ id: i });
    var onBarOrder = [];
    var afterBarOrder = [];
    var progress = [];
    var heartbeatTimes = [];
    var timer = setInterval(function () { heartbeatTimes.push(performance.now()); }, 5);

    await live.replayBootstrapBars(rows, function (row, index) {
        var until = performance.now() + 0.5;
        while (performance.now() < until) {}
        onBarOrder.push(index);
        return Promise.resolve(index);
    }, function (row, index, value) {
        assert.strictEqual(value, index);
        afterBarOrder.push(index);
    }, function (p) {
        progress.push(p.completed);
    });
    clearInterval(timer);

    assert.strictEqual(onBarOrder.length, rows.length);
    assert.strictEqual(new Set(onBarOrder).size, rows.length);
    assert.deepStrictEqual(onBarOrder, rows.map(function (row) { return row.id; }));
    assert.deepStrictEqual(afterBarOrder, onBarOrder);
    assert.deepStrictEqual(progress, [500, 600]);
    assert(heartbeatTimes.length > 0, 'heartbeat must execute during bootstrap');

    var delays = [];
    for (var i = 1; i < heartbeatTimes.length; i++) delays.push(heartbeatTimes[i] - heartbeatTimes[i - 1]);
    var maxDelay = delays.length ? Math.max.apply(Math, delays) : 0;
    assert(maxDelay < 250, 'heartbeat delay must remain below 250ms, got ' + maxDelay);
}

async function main() {
    groupingTests();
    await bootstrapTests();
    console.log('liveBootstrapPerformanceV1: PASS');
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exit(1);
});
