'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    integrityCheck,
    buildChartData,
    createStore
} = require('../scripts/swingSignificanceHumanReview');

const availabilityFields = [
    'formationFeaturesAvailableAt', 'prominenceAvailableAt', 'sameSideFeaturesAvailableAt',
    'higherOrderFeaturesAvailableAt', 'reactionATR_3AvailableAt', 'reactionATR_5AvailableAt',
    'reactionATR_10AvailableAt', 'reactionEfficiencyAvailableAt', 'directionalClosesAvailableAt'
];

function fixture() {
    const base = 1785000000000;
    const ids = [
        'BTCUSDT:5m:SWING_HIGH:' + base,
        'BTCUSDT:5m:SWING_HIGH:' + (base + 300000)
    ];
    const ledger = ids.map((id, index) => ({
        canonicalSwingId: id,
        symbol: 'BTCUSDT', timeframe: '5m', side: 'SWING_HIGH',
        occurredAt: base + index * 300000,
        occurredAtIso: new Date(base + index * 300000).toISOString(),
        humanSignificance: index ? 'HIGH' : null,
        labelStatus: index ? 'RESOLVED' : 'UNRESOLVED',
        humanReason: null, humanRole: null
    }));
    const features = ledger.map((row, index) => {
        const confirmedAt = row.occurredAt + 899999;
        const evaluationTime = row.occurredAt + 3899999;
        const feature = {
            ...row,
            price: 65030 + index,
            atrAtConfirmation: 20,
            confirmedAt,
            confirmedAtIso: new Date(confirmedAt).toISOString(),
            evaluationTime,
            evaluationTimeIso: new Date(evaluationTime).toISOString(),
            prominenceATR: 1.2,
            reactionATR_3: 1.4,
            reactionATR_5: 1.7,
            reactionATR_10: 2.1,
            reactionEfficiency: 0.5,
            directionalCloses: 6,
            sameSideCountWithin0_25ATR: 1,
            sameSideCountWithin0_5ATR: 2,
            sameSideCountWithin1_0ATR: 3,
            nearestSameSideDistanceATR: 0.25,
            nearestSameSideBarsApart: 1,
            nearestHigherOrderType: 'PDH',
            nearestHigherOrderPrice: 65020,
            nearestHigherOrderDistanceATR: 1,
            nearestHigherOrderProvenance: 'FORMATION_TIME_VISIBLE',
            structuralProvenanceAtFormation: 'LOCAL',
            futureLeakViolation: false
        };
        for (const field of availabilityFields) feature[field] = evaluationTime;
        return feature;
    });
    const candles = [];
    for (let i = -3; i <= 15; i += 1) {
        const openTime = base + i * 300000;
        candles.push({
            openTime, closeTime: openTime + 299999, closed: true,
            open: 64990 + i, high: 65030 + i, low: 64970 + i, close: 65000 + i
        });
    }
    return { base, ids, ledger, features, candles };
}

function makeDir(data) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swing-review-test-'));
    fs.writeFileSync(path.join(dir, 'human-ground-truth-v1.json'), JSON.stringify(data.ledger, null, 2));
    fs.writeFileSync(path.join(dir, 'human-ground-truth-v1.csv'), 'placeholder\n');
    fs.writeFileSync(path.join(dir, 'feature-alignment.json'), JSON.stringify(data.features, null, 2));
    return dir;
}

function run() {
    const data = fixture();
    const dir = makeDir(data);
    const store = createStore({ dataDir: dir, candles: data.candles, allSwings: data.features });

    // canonical ID exact update + unresolved -> resolved
    const resolved = store.label({
        canonicalSwingId: data.ids[0],
        humanSignificance: 'MEDIUM',
        humanRole: 'LIQUIDITY_REFERENCE',
        humanReason: 'exact-id test',
        humanNote: 'persist now'
    });
    assert.equal(resolved.row.humanSignificance, 'MEDIUM');
    let disk = JSON.parse(fs.readFileSync(path.join(dir, 'human-ground-truth-v1.json')));
    assert.equal(disk[0].labelStatus, 'RESOLVED');
    assert.equal(disk[0].humanSignificance, 'MEDIUM');
    assert.equal(disk[1].humanSignificance, 'HIGH', 'nearby canonical ID must not change');

    // JSON/CSV consistency and audit append.
    const csv = fs.readFileSync(path.join(dir, 'human-ground-truth-v1.csv'), 'utf8');
    assert(csv.includes(data.ids[0] + ',BTCUSDT,5m,SWING_HIGH'));
    assert(csv.includes(',MEDIUM,RESOLVED,'));
    let log = fs.readFileSync(path.join(dir, 'human-ground-truth-review-log-v1.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.equal(JSON.parse(log[0]).canonicalSwingId, data.ids[0]);

    // Existing resolved update requires explicit, exact confirmation.
    assert.throws(() => store.label({
        canonicalSwingId: data.ids[1], humanSignificance: 'LOW', humanRole: ''
    }), (error) => error.statusCode === 409);
    store.label({
        canonicalSwingId: data.ids[1], humanSignificance: 'LOW', humanRole: '',
        confirmChange: true, expectedCurrentSignificance: 'HIGH'
    });

    // Restart/resume reads the persisted ledger, not browser state.
    const resumed = createStore({ dataDir: dir, candles: data.candles, allSwings: data.features });
    assert.equal(resumed.state().counts.resolved, 2);
    assert.equal(resumed.sample(data.ids[0]).row.humanSignificance, 'MEDIUM');

    // Duplicate IDs are rejected by startup integrity.
    const duplicate = fixture();
    duplicate.ledger.push({ ...duplicate.ledger[0] });
    const duplicateCheck = integrityCheck(duplicate.ledger, duplicate.features);
    assert(duplicateCheck.violations.some((x) => x.includes('duplicate ledger IDs')));
    const duplicateDir = makeDir(duplicate);
    assert.throws(() => createStore({ dataDir: duplicateDir, candles: duplicate.candles, allSwings: duplicate.features }), /Integrity check failed/);

    // Future candles are filtered and can never be returned to the chart.
    const target = data.features[0];
    const withFuture = data.candles.concat([{
        openTime: target.evaluationTime + 1,
        closeTime: target.evaluationTime + 300000,
        closed: true, open: 1, high: 2, low: 0, close: 1
    }]);
    const chart = buildChartData(target, withFuture, data.features);
    assert(chart.candles.every((c) => c.closeTime <= target.evaluationTime));
    assert(!chart.candles.some((c) => c.openTime === target.evaluationTime + 1));

    // A feature not available by evaluationTime rejects startup.
    const leaking = fixture();
    leaking.features[0].reactionATR_10AvailableAt = leaking.features[0].evaluationTime + 1;
    const leakCheck = integrityCheck(leaking.ledger, leaking.features);
    assert.equal(leakCheck.futureLeakViolations > 0, true);
    assert(leakCheck.violations.some((x) => x.includes('reactionATR_10AvailableAt after evaluationTime')));
    const leakDir = makeDir(leaking);
    assert.throws(() => createStore({ dataDir: leakDir, candles: leaking.candles, allSwings: leaking.features }), /FUTURE_LEAK_VIOLATIONS/);

    console.log('Swing Significance Human Review tests passed');
}

run();
