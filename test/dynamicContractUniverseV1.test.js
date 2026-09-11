'use strict';

var assert = require('assert');
var universe = require('../live/dynamicContractUniverseV1');
var execution = require('../execution/realOrderExecutionV1');
var repository = require('../execution/executionRepositoryV1');

var H4 = 4 * 60 * 60 * 1000;
function contract(symbol, overrides) {
    return Object.assign({ symbol: symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
    ] }, overrides || {});
}
function candles(symbolIndex, evaluationTime, count, openQuoteVolume) {
    var rows = [], n = count === undefined ? 6 : count;
    for (var i = 0; i < n; i++) {
        var open = evaluationTime - (n - i) * H4;
        rows.push({ openTime: open, closeTime: open + H4 - 1, open: 100, high: 101, low: 99, close: 100,
            volume: openQuoteVolume === undefined ? 999999999 - symbolIndex : openQuoteVolume,
            quoteAssetVolume: (symbolIndex + 1) * 100 + i, closed: true, source: 'futures' });
    }
    return rows;
}
function snapshot(day, symbols) {
    var evaluationTime=Date.parse(day + 'T00:05:00Z');
    return { version: universe.VERSION, dateKey: day, generatedAt: evaluationTime,
        evaluationTime: evaluationTime, rankingWindow: { timeframe: '4h', closedBars: 6 }, topN: 10,
        symbols: (symbols || Array.from({length:10},function(_,i){return 'S'+i+'USDT';})).map(function (s,i) {
            return { rank:i+1,symbol:s,quoteVolume24h:1000-i,first4hOpenTime:evaluationTime-6*H4,
                last4hCloseTime:evaluationTime-1,executionRules:{tickSize:0.1,stepSize:0.001,minQty:0.001,minNotional:5} };
        }) };
}
function test(name, fn) { return Promise.resolve().then(fn).then(function () { console.log('PASS ' + name); }, function (e) { console.error('FAIL ' + name); throw e; }); }

async function main() {
    var evalTime = Date.parse('2026-09-11T11:37:00Z');
    var contracts = Array.from({ length: 12 }, function (_, i) { return contract('S' + String(i).padStart(2, '0') + 'USDT'); });
    var built;
    await test('12 eligible symbols rank by sum of exactly six quoteAssetVolume bars and select Top10', async function () {
        built = await universe.buildSnapshot({ evaluationTime: evalTime, generatedAt: evalTime, getExchangeInfo: function () { return { source: 'futures', symbols: contracts }; },
            getKlines: function (symbol) { var idx=Number(symbol.slice(1,3)); return candles(idx,evalTime); } });
        assert.strictEqual(built.symbols.length,10); assert.strictEqual(built.symbols[0].symbol,'S11USDT'); assert.strictEqual(built.symbols[9].symbol,'S02USDT');
        assert.strictEqual(built.symbols[0].quoteVolume24h,6*1200+15);
    });
    await test('base volume does not affect ranking', function () {
        var rows=[{symbol:'A',rankEligible:true,quoteVolume24h:10,baseVolume:999999},{symbol:'B',rankEligible:true,quoteVolume24h:20,baseVolume:1}];
        assert.strictEqual(universe.rankRows(rows,1)[0].symbol,'B');
    });
    await test('unfinished 4H candle is excluded', function () {
        var rows=candles(0,evalTime,6); rows.push({openTime:evalTime-H4/2,closeTime:evalTime+H4/2-1,quoteAssetVolume:999999,closed:false,source:'futures'});
        var w=universe.latestClosedWindow(rows,evalTime); assert.strictEqual(w.length,6); assert.ok(w.every(function(c){return c.closeTime<=evalTime;}));
    });
    await test('only latest six fully closed bars are used', function () {
        var rows=candles(0,evalTime,7); rows[0].quoteAssetVolume=999999; var w=universe.latestClosedWindow(rows,evalTime);
        assert.strictEqual(w.length,6); assert.ok(w.indexOf(rows[0])===-1);
    });
    await test('ranking candles never extend beyond evaluationTime', function () {
        var rows=candles(0,evalTime,6);rows.push({openTime:evalTime,closeTime:evalTime+H4-1,
            quoteAssetVolume:999999,closed:true,source:'futures'});
        assert.ok(universe.latestClosedWindow(rows,evalTime).every(function(c){return c.closeTime<=evalTime;}));
    });
    await test('ranking window must be continuous and quoteAssetVolume must be present', async function () {
        assert.strictEqual(universe.rankWindowContinuous(candles(0,evalTime,6)),true);
        var gapped=candles(0,evalTime,6);gapped[4].openTime+=H4;assert.strictEqual(universe.rankWindowContinuous(gapped),false);
        await assert.rejects(function(){return universe.buildSnapshot({evaluationTime:evalTime,getExchangeInfo:function(){return {source:'futures',symbols:contracts};},getKlines:function(symbol){var rows=candles(Number(symbol.slice(1,3)),evalTime);if(symbol==='S00USDT')rows[5].quoteAssetVolume=null;return rows;}});},/QUOTE_ASSET_VOLUME_MISSING/);
    });
    await test('five closed bars are excluded as INSUFFICIENT_RANK_HISTORY', async function () {
        var b=await universe.buildSnapshot({evaluationTime:evalTime,getExchangeInfo:function(){return {source:'futures',symbols:contracts};},getKlines:function(symbol){var idx=Number(symbol.slice(1,3));return candles(idx,evalTime,idx===0?5:6);}});
        assert.strictEqual(b.insufficientHistoryCount,1); assert.ok(!b.symbols.some(function(x){return x.symbol==='S00USDT';}));
    });
    await test('eligibility is strict TRADING PERPETUAL USDT', function () {
        var rows=[contract('OK'),contract('BREAK',{status:'BREAK'}),contract('QUARTER',{contractType:'CURRENT_QUARTER'}),contract('USDC',{quoteAsset:'USDC'}),contract('MISSING',{contractType:undefined})];
        assert.deepStrictEqual(universe.eligibleContracts(rows).map(function(x){return x.symbol;}),['OK']);
    });
    await test('controlled map concurrency never exceeds configured limit', async function () {
        var running=0,maxRunning=0;
        await universe.mapLimit([1,2,3,4,5,6],2,function (value) {
            running++;maxRunning=Math.max(maxRunning,running);
            return new Promise(function(resolve){setImmediate(function(){running--;resolve(value);});});
        });
        assert.strictEqual(maxRunning,2);
    });
    await test('production universe config matches the frozen contract', function () {
        var config=require('../config/live.json');
        assert.strictEqual(config.symbolsMode,'dynamic');
        assert.strictEqual(universe.configMatchesContract(config.dynamicUniverse),true);
    });
    await test('same-day restart restores frozen snapshot without reranking', async function () {
        var calls=0,s=snapshot('2026-09-11');var svc=universe.createService({load:function(){return s;},save:function(){},buildSnapshot:function(){calls++;}});
        var r=await svc.initialize(Date.parse('2026-09-11T18:00:00Z'));assert.strictEqual(r.status,'RESTORED');assert.strictEqual(calls,0);assert.strictEqual(r.snapshot,s);
    });
    await test('corrupt same-day snapshot is rejected and rebuilt', async function () {
        var bad=snapshot('2026-09-11');bad.symbols[0].last4hCloseTime=bad.evaluationTime+1;
        var calls=0,next=snapshot('2026-09-11');var svc=universe.createService({load:function(){return bad;},save:function(){},buildSnapshot:function(){calls++;return next;}});
        var r=await svc.initialize(Date.parse('2026-09-11T18:00:00Z'));assert.strictEqual(r.status,'REFRESHED');assert.strictEqual(calls,1);
    });
    await test('next-day refresh becomes due only at 00:05 UTC', function () {
        var s=snapshot('2026-09-10');assert.strictEqual(universe.isRefreshDue(s,Date.parse('2026-09-11T00:04:59Z')),false);assert.strictEqual(universe.isRefreshDue(s,Date.parse('2026-09-11T00:05:00Z')),true);
    });
    await test('startup without today snapshot refreshes immediately even before 00:05', async function () {
        var calls=0,next=snapshot('2026-09-11');var svc=universe.createService({load:function(){return snapshot('2026-09-10');},save:function(){},buildSnapshot:function(){calls++;return Promise.resolve(next);}});
        var r=await svc.initialize(Date.parse('2026-09-11T00:03:00Z'));assert.strictEqual(r.status,'REFRESHED');assert.strictEqual(calls,1);
    });
    await test('active lifecycle symbol remains in runtime after dropping from Top10', function () {
        assert.deepStrictEqual(universe.runtimeSymbols(['BTCUSDT'],['ZECUSDT']),['BTCUSDT','ZECUSDT']);
        assert.strictEqual(universe.snapshotHasActiveLifecycle({activeTradeId:'T1',trades:{T1:{status:'PROTECTED',positionQty:2}}}),true);
    });
    await test('terminal-clean lifecycle is evictable without forced cancel or close', function () {
        var state={activeTradeId:'T1',trades:{T1:{status:'CLOSED',positionQty:0,entryOrder:{status:'FILLED'},slOrder:{status:'FILLED_OR_CANCELED'},tpOrder:{status:'FILLED_OR_CANCELED'}}}};
        assert.strictEqual(universe.snapshotHasActiveLifecycle(state),false); assert.deepStrictEqual(universe.runtimeSymbols(['BTCUSDT'],[]),['BTCUSDT']);
    });
    await test('old WATCH-only symbol is denied new trade admission before consumption', async function () {
        var repo=repository.createRepository({initial:{}}),events=[];
        var svc=execution.createService({symbol:'ZECUSDT',liveTradingEnabled:false,client:{},repository:repo,getNewTradeAdmission:function(){return {admitted:false,reasonCode:'SYMBOL_NOT_IN_SCAN_UNIVERSE'};},observe:function(e){events.push(e);}});
        var r=await svc.onFirstMatchingFvg({ordinal:1,liquidityId:'L1'});assert.strictEqual(r.reasonCode,'SYMBOL_NOT_IN_SCAN_UNIVERSE');assert.strictEqual(repo.isConsumed('L1'),false);assert.strictEqual(events[0].type,'NO_TRADE');
    });
    await test('refresh failure retains previous valid universe', async function () {
        var prev=snapshot('2026-09-10');var svc=universe.createService({load:function(){return prev;},save:function(){throw new Error('must not save');},buildSnapshot:function(){return Promise.reject(new Error('partial failure'));}});
        var r=await svc.initialize(Date.parse('2026-09-11T01:00:00Z'));assert.strictEqual(r.status,'REFRESH_FAILED');assert.strictEqual(r.ready,true);assert.strictEqual(r.snapshot,prev);
    });
    await test('first-start refresh failure leaves universe not ready', async function () {
        var svc=universe.createService({load:function(){return null;},save:function(){},buildSnapshot:function(){return Promise.reject(new Error('failure'));}});
        var r=await svc.initialize(evalTime);assert.strictEqual(r.status,'REFRESH_FAILED');assert.strictEqual(r.ready,false);assert.strictEqual(r.snapshot,null);
    });
    await test('failed daily refresh is rate-limited instead of retried every minute', async function () {
        var calls=0,base=Date.parse('2026-09-11T00:05:00Z');var svc=universe.createService({load:function(){return snapshot('2026-09-10');},save:function(){},retryIntervalMs:3600000,buildSnapshot:function(){calls++;return Promise.reject(new Error('failure'));}});
        await svc.refreshIfDue(base);var second=await svc.refreshIfDue(base+60000);assert.strictEqual(calls,1);assert.strictEqual(second.status,'RETRY_NOT_DUE');
    });
    await test('analysis readiness requires existing 120 closed 4H bars', function () {
        var dataSource=require('../live/dataSource');var rows=Array.from({length:120},function(){return {closed:true};});
        var five=Array.from({length:dataSource.MIN_ANALYSIS_5M_BARS},function(){return {closed:true};});
        assert.strictEqual(dataSource.analysisHistoryReady({'4h':rows,'5m':five}),true);
        assert.strictEqual(dataSource.analysisHistoryReady({'4h':rows.slice(0,119),'5m':five}),false);
        assert.strictEqual(dataSource.analysisHistoryReady({'4h':rows,'5m':five.slice(0,-1)}),false);
    });
    await test('execution readiness requires complete futures symbol rules', function () {
        var dataSource=require('../live/dataSource');
        assert.strictEqual(dataSource.executionRulesReady({source:'futures',tickSize:0.1,stepSize:0.001,minQty:0.001,minNotional:5}),true);
        assert.strictEqual(dataSource.executionRulesReady({source:'spot-mirror',tickSize:0.1,stepSize:0.001,minQty:0.001,minNotional:5}),false);
        assert.strictEqual(dataSource.executionRulesReady({source:'futures',tickSize:0.1,stepSize:0.001,minQty:0.001,minNotional:null}),false);
    });
    console.log('ALL DYNAMIC CONTRACT UNIVERSE V1 TESTS PASSED');
}
main().catch(function(e){console.error(e&&e.stack||e);process.exitCode=1;});
