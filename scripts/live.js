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
var binanceRest = require('../data/binanceRest');
var persistence = require('../live/persistence');
var dingTalk = require('../notify/dingTalk');

var CONFIG = require('../config/live.json');

// 环境变量覆盖（Windows: set DINGTALK_WEBHOOK=... / set DINGTALK_SECRET=...）
if (process.env.DINGTALK_WEBHOOK) CONFIG.dingtalk.webhook = process.env.DINGTALK_WEBHOOK;
if (process.env.DINGTALK_SECRET) CONFIG.dingtalk.secret = process.env.DINGTALK_SECRET;

// Fix 6（11L.2 Security）：gitignored 的 config/live.local.json 覆盖（token 不进 tracked 文件）
try {
    var fsLocal = require('fs');
    var localCfgPath = require('path').join(__dirname, '..', 'config', 'live.local.json');
    if (fsLocal.existsSync(localCfgPath)) {
        var local = JSON.parse(fsLocal.readFileSync(localCfgPath, 'utf8'));
        if (local.dingtalk) {
            if (local.dingtalk.webhook) CONFIG.dingtalk.webhook = local.dingtalk.webhook;
            if (local.dingtalk.secret) CONFIG.dingtalk.secret = local.dingtalk.secret;
            if (local.dingtalk.keyword) CONFIG.dingtalk.keyword = local.dingtalk.keyword;
        }
    }
} catch (e) {}

var BAR_MS = 300000; // 5m

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
    var keyword = CONFIG.dingtalk.keyword || '监测';
    var lines = [
        '🔴 ' + keyword + ' · HIGH QUALITY WATCH · ' + symbol,
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
    var lastOpenTime = null;
    var historyLoaded = false;
    var runnerData = null; // Fix 1：{ raw, structureCandles, calendarCandles }（HTF 增量共用同一对象）

    function loadPushed() {
        return persistence.loadJson(pushedFile, {});
    }

    function initFromHistory(data) {
        // Fix 1 (P0)：runnerData 保存组装后的 HTF 引用（fetchHtfIncrement 增量更新同一对象）
        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
        runnerData = { raw: data, structureCandles: structureCandles, calendarCandles: calendarCandles };
        var candles5m = (data['5m'] || []).slice();
        log(symbol + ' 初始历史 ' + candles5m.length + ' 根 5m（' + fmt(candles5m[0].closeTime) + ' → ' + fmt(candles5m[candles5m.length - 1].closeTime) + '）');
        // 持久化历史（追加，幂等：跳过已存在的 openTime）
        var existing = persistence.loadCandles(candlesFile);
        var known = {};
        existing.forEach(function (c) { known[c.openTime] = true; });
        var fresh = candles5m.filter(function (c) { return !known[c.openTime]; });
        if (fresh.length > 0) persistence.appendCandles(candlesFile, fresh);
        var all = existing.concat(fresh);

        // Fix 3 (P0/P1)：requireFutures 时历史数据纯度检查（init 为回放，警告但不阻塞；tick 严格）
        if (CONFIG.requireFutures) {
            var nonFutures = all.filter(function (c) { return c.source && c.source !== 'futures'; }).length;
            if (nonFutures > 0) {
                log(symbol + ' ⚠️ DATA_SOURCE_DEGRADED: 历史 ' + nonFutures + '/' + all.length + ' 根非 futures（warmup 回放不产生推送，但 tick 将要求 futures-only）');
            }
        }

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
            lastOpenTime = all[all.length - 1].openTime;
            historyLoaded = true;
            var p = engine.getPushed();
            persistence.saveJson(pushedFile, p);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: all.length });
            log(symbol + ' 状态就绪，已推进 ' + all.length + ' 根，去重集合 ' + Object.keys(p).length + ' 个已推机会');
        });
    }

    function processCandles(list) {
        // Fix 3（P0/P1）：requireFutures → futures-only fail-closed（tick 严格）
        if (CONFIG.requireFutures) {
            var bad = list.filter(function (c) { return c.source && c.source !== 'futures'; });
            if (bad.length > 0) {
                log(symbol + ' DATA_SOURCE_DEGRADED: ' + bad.length + ' 根非 futures（' + bad[0].source + '）——不推进 engine，等待 Futures 恢复');
                return Promise.resolve();
            }
        }
        log(symbol + ' 新收盘 ' + list.length + ' 根（' + fmt(list[0].openTime) + ' … ' + fmt(list[list.length - 1].closeTime) + '）');
        var chain = Promise.resolve();
        list.forEach(function (c) {
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
            lastCloseTime = list[list.length - 1].closeTime;
            lastOpenTime = list[list.length - 1].openTime;
            persistence.appendCandles(candlesFile, list);
            persistence.saveJson(pushedFile, engine.getPushed());
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: engine.getWindowLength() });
        });
    }

    function tick() {
        if (!historyLoaded) return Promise.resolve();
        return dataSource.fetchHtfIncrement(symbol, runnerData.structureCandles, runnerData.calendarCandles).then(function () {
            return dataSource.pollNew5m(symbol, lastCloseTime);
        }).then(function (res) {
            // Fix 4（P1）：区分 NO_NEW_BAR / NETWORK_ERROR（不吞错）
            if (!res.ok) {
                log(symbol + ' NETWORK_ERROR: ' + res.error + '（跳过本轮，等待恢复）');
                return;
            }
            var newCandles = res.candles;
            if (newCandles.length === 0) return; // NO_NEW_BAR（正常）
            // Fix 4（P1）：5m 连续性检查（前一根 openTime + 5m === 当前 openTime）
            if (lastOpenTime !== null && newCandles[0].openTime !== lastOpenTime + BAR_MS) {
                log(symbol + ' DATA_GAP: 期望 openTime=' + (lastOpenTime + BAR_MS) + ' 实际=' + newCandles[0].openTime + '（暂停推进，补历史...）');
                return dataSource.backfill5m(symbol, lastCloseTime).then(function (backfill) {
                    var merged = (backfill || []).filter(function (c) {
                        return c.closed && c.closeTime > lastCloseTime && c.openTime < newCandles[0].openTime;
                    }).sort(function (a, b) { return a.openTime - b.openTime; });
                    var full = merged.concat(newCandles);
                    if (full.length === 0) return;
                    log(symbol + ' 补历史 ' + merged.length + ' 根后恢复推进');
                    return processCandles(full);
                });
            }
            return processCandles(newCandles);
        }).catch(function (e) {
            log(symbol + ' tick 错误: ' + e.message);
        });
    }

    return { initFromHistory: initFromHistory, tick: tick };
}

// ---------- 主流程（Phase 11L.2：top10 动态监控 + 每日刷新） ----------
function main() {
    persistence.ensureDir(CONFIG.dataDir);
    log('=== Live Opportunity Radar 启动 ===');
    log('symbolsMode=' + CONFIG.symbolsMode + ' pollMs=' + CONFIG.pollMs + ' warmupDays=' + CONFIG.warmupDays);
    if (!CONFIG.dingtalk.webhook || CONFIG.dingtalk.webhook.indexOf('YOUR_') !== -1) {
        log('⚠️ 未配置钉钉 webhook（config/live.json 或 DINGTALK_WEBHOOK）——机会将只记录日志不推送');
    }
    if (CONFIG.dingtalk.secret && CONFIG.dingtalk.secret.indexOf('YOUR_') !== -1) {
        CONFIG.dingtalk.secret = '';
    }
    if (CONFIG.dingtalk.secret) {
        log('钉钉安全模式：加签（secret 已配置）');
    } else {
        log('钉钉安全模式：自定义关键词「' + (CONFIG.dingtalk.keyword || '监测') + '」（secret 未配置，消息必须包含该关键词）');
    }

    var runners = {}; // sym -> { runner, interval }
    var startSequence = Promise.resolve(); // 串行启动（避免并发拉历史压代理）
    var refreshDate = null; // 上次名单刷新日期（YYYY-MM-DD，UTC）

    function startSymbol(sym) {
        startSequence = startSequence.then(function () {
            log(sym + ' 加入监控：拉取初始历史（可能命中本地缓存）...');
            return dataSource.fetchInitial(sym, CONFIG.warmupDays).then(function (data) {
                var r = createRunner(sym);
                var interval = setInterval(function () { r.tick(); }, CONFIG.pollMs);
                runners[sym] = { runner: r, interval: interval };
                return r.initFromHistory(data);
            }).then(function () {
                runners[sym].runner.tick(); // 立即先跑一轮
                log(sym + ' 监控就绪');
            }).catch(function (e) {
                log(sym + ' 启动失败: ' + (e && e.message || e) + '（跳过，下轮刷新重试）');
            });
        });
        return startSequence;
    }

    function stopSymbol(sym) {
        if (!runners[sym]) return;
        clearInterval(runners[sym].interval);
        delete runners[sym];
        log(sym + ' 移出监控（状态文件保留，重回 top' + (CONFIG.topSymbols.count || 10) + ' 可恢复）');
    }

    function ensureSymbols(list) {
        var want = {};
        list.forEach(function (s) { want[s] = true; });
        Object.keys(runners).forEach(function (sym) { if (!want[sym]) stopSymbol(sym); });
        list.forEach(function (sym) { if (!runners[sym]) startSymbol(sym); });
        return startSequence;
    }

    function refreshTop() {
        return binanceRest.fetchTopVolumeSymbols(CONFIG.topSymbols.count).then(function (list) {
            var syms = list.map(function (x) { return x.symbol; });
            refreshDate = new Date().toISOString().slice(0, 10);
            log('Top' + syms.length + ' 名单刷新（' + refreshDate + '）: ' + syms.join(', '));
            log('  成交量榜首: ' + (list[0] ? list[0].symbol + ' ' + Math.round(list[0].quoteVolume) : '-'));
            return ensureSymbols(syms);
        }).catch(function (e) {
            log('Top 名单刷新失败: ' + (e && e.message || e) + '（保留现有监控）');
        });
    }

    function checkDailyRefresh() {
        if (CONFIG.symbolsMode !== 'top10') return;
        var now = new Date();
        var today = now.toISOString().slice(0, 10);
        if (refreshDate === today) return; // 今天已刷新
        if (now.getUTCHours() < CONFIG.topSymbols.refreshHourUTC) return; // 未到刷新时刻
        refreshTop();
    }

    if (CONFIG.symbolsMode === 'top10') {
        refreshTop().then(function () {
            log('=== 每日 ' + CONFIG.topSymbols.refreshHourUTC + ':00 UTC 自动刷新 Top' + CONFIG.topSymbols.count + ' ===');
            setInterval(checkDailyRefresh, CONFIG.topSymbols.refreshIntervalMs);
        });
    } else {
        ensureSymbols(CONFIG.symbols || []).then(function () {
            log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
        });
    }
}

main();
