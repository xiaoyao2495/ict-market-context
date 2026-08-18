/**
 * Phase 11L — Live Opportunity Radar（实时机会提醒入口）
 *
 * 流程（每根 5m 收盘）：
 *   Binance 5m closed → HTF 维护 → 状态推进 → DisplacementLeg 完成 →
 *   Opportunity tier → HIGH_QUALITY 去重 → 钉钉推送
 *
 * 无下单/仓位/交易执行。Windows/Linux 通用（纯 Node 22，fs + fetch）。
 * 部署：node scripts/live.js（建议 pm2 或计划任务保活）
 *
 * 重启恢复：candles.jsonl（最近 N 根重放重建状态，幂等）+ pushed.json（去重集合）
 */
var fs = require('fs');
var path = require('path');
var liveEngineMod = require('../live/liveEngine');
var dataSource = require('../live/dataSource');
var persistence = require('../live/persistence');
var dingTalk = require('../notify/dingTalk');

var CONFIG = require('../config/live.json');

// 环境变量覆盖（Windows: set DINGTALK_WEBHOOK=... / set DINGTALK_SECRET=...）
if (process.env.DINGTALK_WEBHOOK) CONFIG.dingtalk.webhook = process.env.DINGTALK_WEBHOOK;
if (process.env.DINGTALK_SECRET) CONFIG.dingtalk.secret = process.env.DINGTALK_SECRET;

// ---------- 工具 ----------
function fmt(ms) {
    var d = new Date(ms + 8 * 3600000);
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' (UTC+8)';
}
function log(msg) {
    var line = '[' + new Date().toISOString().slice(0, 19) + '] ' + msg;
    console.log(line);
    try {
        fs.appendFileSync(path.join(CONFIG.dataDir, 'live.log'), line + '\n');
    } catch (e) {}
}
function buildMessage(opp, symbol) {
    var dir = opp.direction === 'BULLISH' ? 'LONG (BULLISH)' : 'SHORT (BEARISH)';
    var mss = opp.mssQuality === 'NO_MSS' ? 'no MSS chain' : opp.mssQuality.replace('_SWING', '');
    var lines = [
        '🔴 HIGH QUALITY WATCH · ' + symbol,
        dir,
        'MSS: ' + mss + (opp.legRangeAtr !== null && opp.legRangeAtr !== undefined ? ' · Leg: ' + opp.legQuality + ' (' + opp.legRangeAtr.toFixed(1) + ' ATR)' : ' · Leg: ' + opp.legQuality),
        opp.nearTarget !== null ? 'Near Draw: ' + opp.nearDistPct.toFixed(2) + '% 距离（target ' + opp.nearTarget.toFixed(1) + '）' : 'Near Draw: -',
        '历史同级机会：1h Near Draw Hit 88%',
        '时间: ' + fmt(opp.anchorTime)
    ];
    return lines.join('\n');
}

// ---------- 每个 symbol 的运行时 ----------
function createRunner(symbol) {
    var dir = path.join(CONFIG.dataDir, symbol);
    persistence.ensureDir(dir);
    var candlesFile = path.join(dir, 'candles.jsonl');
    var pushedFile = path.join(dir, 'pushed.json');
    var stateFile = path.join(dir, 'cursor.json');

    var engine = null;
    var lastCloseTime = 0;
    var historyLoaded = false;
    var runnerData = null; // 初始数据（structureCandles/calendarCandles 引用，HTF 增量共用）

    function loadPushed() {
        return persistence.loadJson(pushedFile, {});
    }

    function initFromHistory(data) {
        runnerData = data;
        var candles5m = (data['5m'] || []).slice();
        log(symbol + ' 初始历史 ' + candles5m.length + ' 根 5m（' + fmt(candles5m[0].closeTime) + ' → ' + fmt(candles5m[candles5m.length - 1].closeTime) + '）');
        // 持久化历史（追加，幂等：跳过已存在的 openTime）
        var existing = persistence.loadCandles(candlesFile);
        var known = {};
        existing.forEach(function (c) { known[c.openTime] = true; });
        var fresh = candles5m.filter(function (c) { return !known[c.openTime]; });
        if (fresh.length > 0) persistence.appendCandles(candlesFile, fresh);
        var all = existing.concat(fresh);

        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
        engine = liveEngineMod.createLiveEngine({
            symbol: symbol,
            exchangeInfo: data.exchangeInfo,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            fetcher: dataSource.makeFetcher(calendarCandles),
            thresholds: require('../config/thresholds')
        }, { snapshotInterval: CONFIG.snapshotInterval, baseIndex: 0 });

        engine.setPushed(loadPushed());

        // 逐根推进历史（warmup 段机会不推送：已过去）
        var chain = Promise.resolve();
        all.forEach(function (c, idx) {
            chain = chain.then(function () { return engine.onBar(c, idx); });
        });
        return chain.then(function () {
            lastCloseTime = all[all.length - 1].closeTime;
            historyLoaded = true;
            var p = engine.getPushed();
            persistence.saveJson(pushedFile, p);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: all.length });
            log(symbol + ' 状态就绪，已推进 ' + all.length + ' 根，去重集合 ' + Object.keys(p).length + ' 个已推机会');
        });
    }

    function tick() {
        if (!historyLoaded) return Promise.resolve();
        return dataSource.fetchHtfIncrement(symbol, runnerData.structureCandles, runnerData.calendarCandles).then(function () {
            return dataSource.pollNew5m(symbol, lastCloseTime);
        }).then(function (newCandles) {
            if (newCandles.length === 0) return;
            log(symbol + ' 新收盘 ' + newCandles.length + ' 根（' + fmt(newCandles[0].openTime) + ' … ' + fmt(newCandles[newCandles.length - 1].closeTime) + '）');
            var chain = Promise.resolve();
            newCandles.forEach(function (c) {
                chain = chain.then(function () {
                    return engine.onBar(c, engine.getWindowLength()).then(function (opp) {
                        if (opp && opp.tier === 'HIGH_QUALITY') {
                            var msg = buildMessage(opp, symbol);
                            log('🔥 HIGH 机会: ' + symbol + ' ' + opp.direction + ' ' + opp.mssQuality + '|' + opp.legQuality +
                                ' near ' + (opp.nearDistPct !== null ? opp.nearDistPct.toFixed(2) + '%' : '-') + ' id=' + opp.id);
                            return dingTalk.sendText(CONFIG.dingtalk.webhook, CONFIG.dingtalk.secret, msg).then(function (res) {
                                log('   钉钉推送响应: errcode=' + (res ? res.errcode : '?') + ' errmsg=' + (res ? res.errmsg : '?'));
                            }).catch(function (e) {
                                log('   钉钉推送失败: ' + e.message);
                            });
                        }
                        return null;
                    });
                });
            });
            return chain.then(function () {
                lastCloseTime = newCandles[newCandles.length - 1].closeTime;
                persistence.appendCandles(candlesFile, newCandles);
                persistence.saveJson(pushedFile, engine.getPushed());
                persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: engine.getWindowLength() });
            });
        }).catch(function (e) {
            log(symbol + ' tick 错误: ' + e.message);
        });
    }

    return { initFromHistory: initFromHistory, tick: tick };
}

// ---------- 主流程 ----------
function main() {
    persistence.ensureDir(CONFIG.dataDir);
    log('=== Live Opportunity Radar 启动 ===');
    log('symbols=' + CONFIG.symbols.join(',') + ' pollMs=' + CONFIG.pollMs + ' warmupDays=' + CONFIG.warmupDays);
    if (!CONFIG.dingtalk.webhook || CONFIG.dingtalk.webhook.indexOf('YOUR_') !== -1) {
        log('⚠️ 未配置钉钉 webhook（config/live.json）——机会将只记录日志不推送');
    }

    var runners = {};
    var ready = Promise.resolve();
    CONFIG.symbols.forEach(function (sym) {
        ready = ready.then(function () {
            log(sym + ' 拉取初始历史（可能从本地缓存命中）...');
            return dataSource.fetchInitial(sym, CONFIG.warmupDays).then(function (data) {
                var r = createRunner(sym);
                runners[sym] = r;
                return r.initFromHistory(data);
            });
        });
    });

    ready.then(function () {
        log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
        CONFIG.symbols.forEach(function (sym) {
            setInterval(function () { runners[sym].tick(); }, CONFIG.pollMs);
        });
        // 立即先 tick 一轮
        CONFIG.symbols.forEach(function (sym) { runners[sym].tick(); });
    }).catch(function (e) {
        log('启动失败: ' + (e && e.stack || e));
        process.exit(1);
    });
}

main();
