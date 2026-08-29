var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var dataSource = require('../live/dataSource');
var persistence = require('../live/persistence');
var live = require('../scripts/live');

function test(name, fn) {
    try {
        fn();
        console.log('PASS ' + name);
    } catch (e) {
        console.error('FAIL ' + name);
        throw e;
    }
}

test('30d bootstrap retention is 8640 replay bars plus 300 warmup bars', function () {
    assert.strictEqual(dataSource.initial5mRetentionBars(30), 8940);
});

test('retention keeps the newest ordered candles without mutating input', function () {
    var rows = [];
    for (var i = 0; i < 10; i++) rows.push({ openTime: i });
    var retained = live.retainLatestCandles(rows, 4);
    assert.deepStrictEqual(retained.map(function (c) { return c.openTime; }), [6, 7, 8, 9]);
    assert.strictEqual(rows.length, 10);
});

test('restart merge deduplicates fetched overlap and caps the newest bootstrap tail', function () {
    var existing = [];
    var fetched = [];
    for (var i = 0; i < 10000; i++) existing.push({ openTime: i, source: 'futures' });
    for (var j = 9900; j < 10100; j++) fetched.push({ openTime: j, source: 'futures' });
    var prepared = live.prepareBootstrapCandles(existing, fetched, 8940);
    assert.strictEqual(prepared.fresh.length, 100);
    assert.strictEqual(prepared.mergedBars, 10100);
    assert.strictEqual(prepared.prunedBars, 1160);
    assert.strictEqual(prepared.candles.length, 8940);
    assert.strictEqual(prepared.candles[0].openTime, 1160);
    assert.strictEqual(prepared.candles[8939].openTime, 10099);
    assert.strictEqual(new Set(prepared.candles.map(function (c) { return c.openTime; })).size, 8940);
});

test('replaceCandles atomically compacts an existing JSONL candle log', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-retention-'));
    var file = path.join(dir, 'candles.jsonl');
    try {
        persistence.appendCandles(file, [
            { openTime: 1, source: 'futures' },
            { openTime: 2, source: 'futures' },
            { openTime: 3, source: 'futures' }
        ]);
        persistence.replaceCandles(file, [
            { openTime: 2, source: 'futures' },
            { openTime: 3, source: 'futures' }
        ]);
        var loaded = persistence.loadCandles(file);
        assert.deepStrictEqual(loaded.candles.map(function (c) { return c.openTime; }), [2, 3]);
        assert.strictEqual(fs.existsSync(file + '.tmp'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
