'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var PRODUCTION_FILES = [
    'stats/watchNarrativeLifecycleV1.js',
    'scripts/live.js',
    'notify/watchNotificationPresentationV1.js'
];

function productionHashes() {
    return PRODUCTION_FILES.map(function (file) {
        return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
    });
}

function candle(openTime, open, high, low, close) {
    return {
        openTime:openTime, closeTime:openTime + 300000 - 1,
        open:open, high:high, low:low, close:close,
        volume:100, closed:true, source:'futures'
    };
}

function missingSweepWatch(symbol, firstCandle) {
    var primary = {
        // Deliberately no id: this is the sole missing P4.1 requirement.
        sourceId:'EQV3:' + symbol + ':5m:EQL:VALID_CLUSTER',
        sourceType:'EQL', sourceTimeframe:'5m', sourcePrice:99,
        side:'SSL', occurredAt:firstCandle.openTime,
        confirmedAt:firstCandle.closeTime - 1, relation:'BEFORE_LEG'
    };
    return {
        id:'WATCH:' + symbol + ':BULLISH:LEG:VALID_DISPLACEMENT',
        symbol:symbol, direction:'BULLISH', watchDirection:'WATCH_LONG',
        state:'WATCH_WAIT_FVG', createdAt:firstCandle.closeTime,
        updatedAt:firstCandle.closeTime,
        notificationKey:'WATCH:' + symbol + ':BULLISH:LEG:VALID_DISPLACEMENT:NATIVE_FVG:VALID',
        liquidityTaken:{ matched:true, primary:primary, allCandidates:[primary] },
        displacementLegId:'LEG:VALID_DISPLACEMENT',
        displacementIds:['VALID_DISPLACEMENT'],
        displacement:{ direction:'BULLISH', quality:'STRONG', startIndex:0, endIndex:0,
            firstConfirmedAt:firstCandle.closeTime, lastConfirmedAt:firstCandle.closeTime },
        nativeFvg:{ id:'NATIVE_FVG:VALID', confirmedAt:firstCandle.closeTime,
            low:100, high:101, midpoint:100.5 },
        nativeFvgs:[], touchStatus:'UNTOUCHED',
        mss:{ exists:true, direction:'BULLISH', referencePrice:99,
            referenceRole:'LOCAL', protectedBreak:false, mssGrade:'LOCAL' },
        structuralProvenance:{ structuralState:'BULLISH' },
        dailyBias:{ bias:'BULLISH', confidence:'MEDIUM', alignment:'MATCH', status:'VALID' },
        formationOnly:true
    };
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, JSON.stringify(value));
}

async function primaryIntegrationTest() {
    var beforeHashes = productionHashes();
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-1-missing-sweep-'));
    var symbol = 'FAILOPENUSDT';
    var symbolDir = path.join(tempDir, symbol);
    var first = candle(0, 110, 111, 109, 110);
    var touch = candle(300000, 100.5, 101.5, 99.5, 100.7);
    var watch = missingSweepWatch(symbol, first);
    var notificationKey = watch.notificationKey;
    var config = require('../config/live.json');
    var dataSource = require('../live/dataSource');
    var binanceRest = require('../data/binanceRest');
    var dingTalk = require('../notify/dingTalk');
    var original = {
        dataDir:config.dataDir,
        pollNew5m:dataSource.pollNew5m,
        fetchHtfIncrement:dataSource.fetchHtfIncrement,
        loadHistory:binanceRest.loadHistory,
        sendText:dingTalk.sendText,
        zh:process.env.WATCH_NOTIFICATION_ZH_V1_ENABLED
    };
    var logs = [];
    var messages = [];
    var realConsoleLog = console.log;
    var pollCalls = 0;

    writeJson(path.join(symbolDir, 'displacement-watches.json'), [watch]);
    writeJson(path.join(symbolDir, 'fvg-watch-delivered.json'), {});
    writeJson(path.join(symbolDir, 'fvg-watch-outbox.json'), []);

    try {
        config.dataDir = tempDir;
        process.env.WATCH_NOTIFICATION_ZH_V1_ENABLED = 'true';
        dataSource.fetchHtfIncrement = function () { return Promise.resolve({ ok:true, issues:[] }); };
        dataSource.pollNew5m = function () {
            pollCalls++;
            return Promise.resolve({ ok:true, candles:pollCalls === 1 ? [touch] : [] });
        };
        binanceRest.loadHistory = function () { return Promise.resolve([]); };
        dingTalk.sendText = function (webhook, secret, message) {
            messages.push(message);
            return Promise.resolve({ errcode:0, errmsg:'ok' });
        };
        console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };

        var live = require('../scripts/live');
        var data = {
            '5m':[first], '1h':[], '4h':[], '1d':[], '1w':[], '1M':[],
            exchangeInfo:{ symbol:symbol, tickSize:0.01, stepSize:null, source:'futures' }
        };
        var runner = live.createRunner(symbol);
        await runner.initFromHistory(data);
        await runner.tick();

        assert.strictEqual(messages.length, 1, 'FIRST_TOUCH must invoke DingTalk exactly once');
        assert.ok(logs.some(function (line) { return line.indexOf('EXACT_SWEEP_ID_MISSING') >= 0; }),
            'stable missing-sweep diagnostic must be logged');

        var projection = runner.getNarrativeProjection();
        assert.strictEqual(projection.narratives.length, 0, 'no fallback/partial Narrative');
        assert.strictEqual(projection.observations.length, 0, 'no partial Observation');
        assert.deepStrictEqual(projection.activeByScope, {}, 'active owner must remain unchanged');

        var persisted = JSON.parse(fs.readFileSync(path.join(symbolDir, 'displacement-watches.json'), 'utf8'))[0];
        assert.strictEqual(persisted.state, 'NOTIFIED', 'existing delivery path must mark WATCH notified');
        assert.strictEqual(persisted.firstTouchAt, touch.closeTime, 'real onCandle FIRST_TOUCH timing must be retained');
        assert.strictEqual(persisted.notificationKey, notificationKey, 'dedup identity must remain the original key');
        assert.strictEqual(persisted.narrativeId, undefined, 'no synthetic narrativeId');
        assert.strictEqual(persisted.observationId, undefined, 'no synthetic observationId');
        assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(symbolDir,
            'fvg-watch-delivered.json'), 'utf8')))[0], notificationKey, 'delivery dedup must use notificationKey');

        var message = messages[0];
        assert.ok(message.indexOf('检测') >= 0, 'DingTalk keyword');
        assert.ok(message.indexOf('WAIT FOR MANUAL CONFIRMATION') >= 0, 'manual confirmation');
        assert.ok(message.indexOf('这是 WATCH 观察事件，不是入场确认。') >= 0, 'WATCH-not-entry disclaimer');
        ['💧 流动性扫取','⚡ 多头位移','🟦 原生 FVG','🧭 4H Daily Bias'].forEach(function (section) {
            assert.ok(message.indexOf(section) >= 0, 'missing notification section ' + section);
        });
        assert.strictEqual(/Narrative：|CONTINUATION|REACTIVATION/.test(message), false,
            'missing metadata must retain non-Narrative presentation');

        // Simulate a stale duplicate outbox entry after successful delivery. A
        // restarted production runner must consume it through the unchanged
        // delivered-key guard without another DingTalk call.
        writeJson(path.join(symbolDir, 'fvg-watch-outbox.json'), [
            { notificationKey:notificationKey, watchId:watch.id, attempts:0 }
        ]);
        var restarted = live.createRunner(symbol);
        await restarted.initFromHistory(data);
        await restarted.tick();
        assert.strictEqual(messages.length, 1, 'duplicate FIRST_TOUCH/outbox must add zero deliveries');
        assert.deepStrictEqual(restarted.getNarrativeProjection().activeByScope, {},
            'duplicate fail-open processing must not create an active owner');
        assert.deepStrictEqual(productionHashes(), beforeHashes, 'test runtime must not mutate production files');
    } finally {
        console.log = realConsoleLog;
        config.dataDir = original.dataDir;
        dataSource.pollNew5m = original.pollNew5m;
        dataSource.fetchHtfIncrement = original.fetchHtfIncrement;
        binanceRest.loadHistory = original.loadHistory;
        dingTalk.sendText = original.sendText;
        if (original.zh === undefined) delete process.env.WATCH_NOTIFICATION_ZH_V1_ENABLED;
        else process.env.WATCH_NOTIFICATION_ZH_V1_ENABLED = original.zh;
        fs.rmSync(tempDir, { recursive:true, force:true });
    }
}

function coreNoMutationTest() {
    var lifecycle = require('../stats/watchNarrativeLifecycleV1');
    var first = candle(0, 110, 111, 109, 110);
    var item = missingSweepWatch('COREUSDT', first);
    item.state = 'FVG_TOUCHED';
    item.firstTouchAt = first.closeTime + 1;
    var state = lifecycle.createState();
    var before = JSON.stringify(lifecycle.projection(state));
    var result = lifecycle.observeFirstTouch(state, item);
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.reason, 'EXACT_SWEEP_ID_MISSING');
    assert.strictEqual(JSON.stringify(lifecycle.projection(state)), before);
}

async function main() {
    var passed = 0;
    try {
        await primaryIntegrationTest();
        passed++;
        console.log('PASS MISSING_EXACT_SWEEP_PROVENANCE_FAIL_OPEN_DELIVERY');
        coreNoMutationTest();
        passed++;
        console.log('PASS MISSING_EXACT_SWEEP_PROVENANCE_DOES_NOT_MUTATE_LIFECYCLE');
    } catch (error) {
        console.error(error && error.stack || error);
        process.exitCode = 1;
        return;
    }
    console.log('WATCH Narrative Missing Sweep Fail-Open V1 ' + passed + '/' + passed);
}

main();
