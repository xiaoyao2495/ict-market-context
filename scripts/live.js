/**
 * Phase 11L — Live Opportunity Radar（实时机会提醒入口）
 *
 * 流程（每根 5m 收盘）：
 *   Binance 5m closed → HTF 维护 → 状态推进 → DisplacementLeg 完成 →
 *   Opportunity tier → HIGH_QUALITY 投递（钉钉确认 errcode=0 才记 delivered）→ 失败重试
 *
 * Phase 11L.3（Final Production Guardrails）：
 *   1. requireFutures → 初始化 + HTF 增量 futures-only fail-closed（spot 绝不进入）
 *   2. DATA_GAP backfill 后严格 continuity 验证（不通过不推进，下轮继续补）
 *   3. 钉钉投递确认后才去重（失败保留 pending 自动重试）
 *   4. 第一版默认 fixed 模式（只监控 symbols 列表，默认 BTCUSDT）
 *
 * 无下单/仓位/交易执行。Windows/Linux 通用（纯 Node 22，fs + fetch）。
 * 部署：node scripts/live.js（建议 pm2 或计划任务保活）
 *
 * 重启恢复：candles.jsonl（最近 N 根重放重建状态，幂等）+ pushed.json（已投递去重集合）
 */
var fs = require('fs');
var path = require('path');
var liveEngineMod = require('../live/liveEngine');
var dataSource = require('../live/dataSource');
var binanceRest = require('../data/binanceRest');
var persistence = require('../live/persistence');
var dingTalk = require('../notify/dingTalk');
var continuityChecker = require('../replay/continuityChecker');

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
/**
 * 价格自适应精度（Phase 11L.7b fix，2026-08-19）：
 * 低价币（如 TUTUSDT 0.039）用 toFixed(1) 会显示成 0.0，目标价不可读。
 * 按价格数量级选择小数位：>=1000 → 1 位；>=1 → 2 位；>=0.01 → 4 位；否则 6 位。
 */
function fmtPrice(p) {
    if (p === null || p === undefined) return '-';
    if (p >= 1000) return p.toFixed(1);
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toFixed(6);
}
function buildMessage(opp, symbol) {
    var dir = opp.direction === 'BULLISH' ? 'LONG (BULLISH)' : 'SHORT (BEARISH)';
    var mss = opp.mssQuality === 'NO_MSS' ? 'no MSS chain' : opp.mssQuality.replace('_SWING', '');
    var keyword = CONFIG.dingtalk.keyword || '检测';
    // 11L.4：时间 = 真正通知时点（availableAt = 系统首次能确认 leg 结束），
    // 不是 leg 最后位移 K 的 anchorTime（那是 leg 本身的研究锚点）
    var notified = opp.availableAt !== undefined && opp.availableAt !== null ? opp.availableAt : opp.anchorTime;
    // Phase 11L.7：通知内容用通知时点快照（availableAt 时重新冻结的价格/目标/距离），
    // 不再用 anchor 时点冻结值（anchor→available 的 15min 内 liquidity 可能已变化）
    var notifTarget = opp.notificationNearTarget !== undefined && opp.notificationNearTarget !== null
        ? opp.notificationNearTarget
        : opp.nearTarget;
    var notifDist = opp.notificationNearDistPct !== undefined && opp.notificationNearDistPct !== null
        ? opp.notificationNearDistPct
        : opp.nearDistPct;
    var lines = [
        '🔴 ' + keyword + ' · HIGH QUALITY WATCH · ' + symbol,
        dir,
        'MSS: ' + mss + (opp.legRangeAtr !== null && opp.legRangeAtr !== undefined ? ' · Leg: ' + opp.legQuality + ' (' + opp.legRangeAtr.toFixed(1) + ' ATR)' : ' · Leg: ' + opp.legQuality),
        notifTarget !== null ? 'Near Draw: ' + notifDist.toFixed(2) + '% 距离（target ' + fmtPrice(notifTarget) + '）' : 'Near Draw: -',
        // 11L.7（P1）：保守措辞 —— 只讲"历史同级机会的 Near Draw 触达率"，不承诺方向胜率/成功率
        '历史同级机会：1h Near Draw 触达率约 80%（仅参考，非胜率）',
        '通知: ' + fmt(notified) + '（leg 锚 ' + fmt(opp.anchorTime) + '）'
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
    var outboxFile = path.join(dir, 'outbox.json');

    var engine = null;
    var lastCloseTime = 0;
    var lastOpenTime = null;
    var historyLoaded = false;
    var runnerData = null; // Fix 1：{ raw, structureCandles, calendarCandles }（HTF 增量共用同一对象）
    var delivered = {}; // Fix 3（11L.3）：oppId -> anchorIndex（钉钉确认投递成功才写入；持久化跨重启）
    // Fix 4（11L.4）：pending 改 transactional outbox —— outbox.json 持久化，
    // 崩溃/重启后仍保留未投递机会（DETECTED → DELIVERY_PENDING → DELIVERED），不漏 HIGH
    var pending = persistence.loadJson(outboxFile, []); // [{ opp, attempts }]

    function loadPushed() {
        return persistence.loadJson(pushedFile, {});
    }

    function saveOutbox() {
        persistence.saveJson(outboxFile, pending);
    }

    function initFromHistory(data) {
        // Fix 1（11L.3 P0）：requireFutures → 初始化 futures-only fail-closed。
        // 任何 timeframe（5m/1h/4h/1d/1w/1M）或 exchangeInfo 出现非 futures 源
        // → 初始化失败（throw），不启动该 symbol（不 warmup、不建 engine、不留 interval）。
        if (CONFIG.requireFutures) {
            var purity = dataSource.checkFuturesPurity(data);
            if (!purity.ok) {
                throw new Error('DATA_SOURCE_DEGRADED: ' + symbol + ' 初始数据含非 futures（' +
                    purity.issues[0] + '，共 ' + purity.issues.length + ' 处）——requireFutures 下拒绝启动');
            }
        }
        // Fix 1（11L.3 P0）：candles.jsonl 既有持久化数据也必须是 futures（旧版本污染的存量同样拒绝）
        // 11L.4：严格 source presence —— source 必须 === 'futures'（undefined 视为来源不明，拒绝）
        // 11L.7（P1）：逐行容错读取（尾部残缺行自动丢弃，中间行损坏抛错 fail-closed）
        var loaded = persistence.loadCandles(candlesFile);
        var existing = loaded.candles;
        if (CONFIG.requireFutures) {
            var badExisting = existing.filter(function (c) { return c.source !== 'futures'; });
            if (badExisting.length > 0) {
                throw new Error('DATA_SOURCE_DEGRADED: ' + symbol + ' candles.jsonl 存在 ' + badExisting.length +
                    ' 根非 futures/无 source（source=' + (badExisting[0].source || 'undefined') + '）——请清理 .live-state 后重启');
            }
        }
        // Fix 1 (P0)：runnerData 保存组装后的 HTF 引用（fetchHtfIncrement 增量更新同一对象）
        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
        runnerData = { raw: data, structureCandles: structureCandles, calendarCandles: calendarCandles };
        var candles5m = (data['5m'] || []).slice();
        log(symbol + ' 初始历史 ' + candles5m.length + ' 根 5m（' + fmt(candles5m[0].closeTime) + ' → ' + fmt(candles5m[candles5m.length - 1].closeTime) + '）');
        // 持久化历史（追加，幂等：跳过已存在的 openTime）
        var known = {};
        existing.forEach(function (c) { known[c.openTime] = true; });
        var fresh = candles5m.filter(function (c) { return !known[c.openTime]; });
        if (fresh.length > 0) persistence.appendCandles(candlesFile, fresh);
        var all = existing.concat(fresh);

        // Fix 4（11L.4 P1）：初始化（restart 重放）前必须验证持久化 5m 历史本身连续——
        // candles.jsonl 磁盘/旧版本/人工拷贝导致缺根时，不得用不连续历史重建状态
        var continuity = continuityChecker.checkContinuity(all, '5m');
        if (!continuity.valid) {
            throw new Error('DATA_GAP: ' + symbol + ' 持久化 5m 历史不连续（gaps=' + continuity.gaps.length +
                ' dup=' + continuity.duplicates.length + ' ooo=' + continuity.outOfOrder.length +
                '）——请清理 .live-state 后重启重新 bootstrap');
        }

        engine = liveEngineMod.createLiveEngine({
            symbol: symbol,
            exchangeInfo: data.exchangeInfo,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            fetcher: dataSource.makeFetcher(calendarCandles),
            thresholds: require('../config/thresholds')
        }, { snapshotInterval: CONFIG.snapshotInterval, baseIndex: 0 });

        delivered = loadPushed();

        // 逐根推进历史（warmup 段机会不推送：已过去）
        var chain = Promise.resolve();
        all.forEach(function (c, idx) {
            chain = chain.then(function () { return engine.onBar(c, idx); });
        });
        return chain.then(function () {
            lastCloseTime = all[all.length - 1].closeTime;
            lastOpenTime = all[all.length - 1].openTime;
            historyLoaded = true;
            persistence.saveJson(pushedFile, delivered);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: all.length });
            log(symbol + ' 状态就绪，已推进 ' + all.length + ' 根，去重集合 ' + Object.keys(delivered).length + ' 个已投递机会');
        });
    }

    /**
     * Fix 3（11L.3 P1）：钉钉投递（确认 errcode===0 才记 delivered 并持久化；失败保留重试）。
     * 11L.4：outbox 语义 —— 调用方负责 pending 入队/出队 + saveOutbox()。
     * @returns {Promise<boolean>} 是否投递成功
     */
    function deliver(opp) {
        if (delivered[opp.id]) return Promise.resolve(true); // 已投递（跨重启去重）
        var msg = buildMessage(opp, symbol);
        log('🔥 HIGH 机会: ' + symbol + ' ' + opp.direction + ' ' + opp.mssQuality + '|' + opp.legQuality +
            ' near ' + (opp.nearDistPct !== null ? opp.nearDistPct.toFixed(2) + '%' : '-') + ' id=' + opp.id +
            ' 通知=' + fmt(opp.availableAt) + ' 锚=' + fmt(opp.anchorTime) +
            (opp.nearConsumed ? ' [near 通知前已触及·观察]' : ''));
        return dingTalk.sendText(CONFIG.dingtalk.webhook, CONFIG.dingtalk.secret, msg).then(function (res) {
            // 双保险：sendText 内部已把 errcode!==0 视为失败，此处再确认一次
            if (!res || res.errcode !== 0) {
                throw new Error('errcode=' + (res ? res.errcode : 'none') + ' errmsg=' + (res ? res.errmsg : 'no-response'));
            }
            delivered[opp.id] = opp.anchorIndex;
            persistence.saveJson(pushedFile, delivered);
            log(symbol + ' 钉钉投递成功 id=' + opp.id + '（errcode=0），已记 delivered');
            return true;
        }).catch(function (e) {
            log(symbol + ' 钉钉投递失败 id=' + opp.id + '：' + e.message + '（保留 outbox，自动重试）');
            return false;
        });
    }

    /** Fix 3+4（11L.3/11L.4）：重试 outbox 中未投递成功的机会（崩溃/重启后从 outbox.json 恢复） */
    function retryPending() {
        if (pending.length === 0) return Promise.resolve();
        var list = pending.slice();
        pending = [];
        return list.reduce(function (chain2, item) {
            return chain2.then(function () {
                return deliver(item.opp).then(function (ok) {
                    if (!ok) {
                        pending.push(item); // 仍失败 → 留在 outbox，下轮继续
                    }
                    saveOutbox(); // 每次出队/回队都落盘（崩溃恢复点）
                });
            });
        }, Promise.resolve());
    }

    /** 11L.5（P1-3）：outbox 按 oppId 去重（崩溃/重启重放边缘不产生同 id 重复条目） */
    function isPending(id) {
        return pending.some(function (x) { return x.opp && x.opp.id === id; });
    }

    /** 新 HIGH 机会入口：尝试投递，失败进入 outbox（持久化，重启不丢） */
    function handleHigh(opp) {
        if (delivered[opp.id] || isPending(opp.id)) return Promise.resolve(null);
        return deliver(opp).then(function (ok) {
            if (!ok) {
                pending.push({ opp: opp, attempts: 0 });
                saveOutbox();
            }
            return null;
        });
    }

    function processCandles(list) {
        // Fix 3 + 11L.5（P1-1）：requireFutures → futures-only fail-closed。
        // 统一严格语义：source 必须 === 'futures'（undefined 视为来源不明，拒绝）
        if (CONFIG.requireFutures) {
            var bad = list.filter(function (c) { return c.source !== 'futures'; });
            if (bad.length > 0) {
                log(symbol + ' DATA_SOURCE_DEGRADED: ' + bad.length + ' 根非 futures/无 source（' + (bad[0].source || 'undefined') + '）——不推进 engine，等待 Futures 恢复');
                return Promise.resolve();
            }
        }
        // Fix 2（11L.3 P0）：严格 5m continuity —— 首根必须紧接 lastOpenTime 且内部逐根连续；
        // 不通过 → DATA_GAP_UNRESOLVED 不推进 engine（下轮继续 backfill）
        var cont = dataSource.validate5mContinuity(lastOpenTime, list);
        if (!cont.ok) {
            log(symbol + ' DATA_GAP_UNRESOLVED: ' + cont.reason + '（backfill 未补全，不推进 engine，下轮继续 backfill）');
            return Promise.resolve();
        }
        log(symbol + ' 新收盘 ' + list.length + ' 根（' + fmt(list[0].openTime) + ' … ' + fmt(list[list.length - 1].closeTime) + '）');
        var chain = Promise.resolve();
        list.forEach(function (c) {
            chain = chain.then(function () {
                return engine.onBar(c, engine.getWindowLength()).then(function (opp) {
                    if (opp && opp.tier === 'HIGH_QUALITY') {
                        return handleHigh(opp);
                    }
                    return null;
                });
            });
        });
        return chain.then(function () {
            lastCloseTime = list[list.length - 1].closeTime;
            lastOpenTime = list[list.length - 1].openTime;
            persistence.appendCandles(candlesFile, list);
            persistence.saveJson(pushedFile, delivered);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: engine.getWindowLength() });
        });
    }

    /**
     * 11L.5（P0-1）：tick 并发锁 —— 互斥 + setTimeout 串行链双保险。
     * 上一轮 tick 未完成时的新一轮直接 skip（返回 resolved，不重入）；
     * 由 startLoop 的 setTimeout 链保证 tick 完成后才调度下一轮。
     */
    var tickRunning = false;
    var loopTimer = null;

    function doTick() {
        return retryPending().then(function () {
            // Fix 1（11L.3 P0）：HTF 增量 futures-only（spot 不 append）+ 错误不吞
            return dataSource.fetchHtfIncrement(symbol, runnerData.structureCandles, runnerData.calendarCandles, CONFIG.requireFutures);
        }).then(function (htf) {
            (htf.issues || []).forEach(function (iss) {
                if (iss.kind === 'DEGRADED') {
                    log(symbol + ' HTF DATA_SOURCE_DEGRADED: ' + iss.tf + ' 返回 ' + iss.source +
                        '（openTime=' + iss.openTime + '）——已拒绝 append，绝不污染 futures context');
                } else if (iss.kind === 'NETWORK_ERROR') {
                    log(symbol + ' HTF_NETWORK_ERROR: ' + iss.tf + ' ' + (iss.error || 'network') + '（保留旧 HTF snapshot，stale 状态）');
                }
            });
            // 11L.5（P1-2）：HTF 更新异常 → 本轮暂停 5m 推进。
            // Near Draw/Liquidity/Snapshot 依赖 HTF context，stale HTF 下不应发 HIGH；
            // 下轮 HTF 恢复后 poll 自动检测 gap → backfill → 连续推进（Live/Replay 状态一致）
            if (!htf.ok) {
                log(symbol + ' HTF 更新异常（' + htf.issues.length + ' 处）——本轮暂停 5m 推进，避免基于 stale HTF 发通知');
                return;
            }
            return dataSource.pollNew5m(symbol, lastCloseTime);
        }).then(function (res) {
            // Fix 4（P1）：区分 NO_NEW_BAR / NETWORK_ERROR（不吞错）
            if (!res) return; // HTF 异常分支已提前返回
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
                    log(symbol + ' 补历史 ' + merged.length + ' 根，等待 continuity 验证...');
                    return processCandles(full); // 内部严格验证：不通过 → DATA_GAP_UNRESOLVED 不推进
                });
            }
            return processCandles(newCandles);
        });
    }

    function tick() {
        if (!historyLoaded) return Promise.resolve();
        if (tickRunning) {
            log(symbol + ' tick skipped: previous tick still running');
            return Promise.resolve();
        }
        tickRunning = true;
        return doTick().then(function () {
            tickRunning = false;
        }, function (e) {
            tickRunning = false;
            log(symbol + ' tick 错误: ' + (e && e.message || e));
        });
    }

    /** 11L.5（P0-1）：setTimeout 串行链 —— tick 完成后再等 pollMs 调度下一轮（无重入） */
    function startLoop() {
        function schedule() {
            loopTimer = setTimeout(function () {
                tick().then(schedule);
            }, CONFIG.pollMs);
        }
        schedule();
    }

    function stopLoop() {
        if (loopTimer) {
            clearTimeout(loopTimer);
            loopTimer = null;
        }
    }

    return {
        initFromHistory: initFromHistory,
        tick: tick,
        startLoop: startLoop,
        stopLoop: stopLoop
    };
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
        log('钉钉安全模式：自定义关键词「' + (CONFIG.dingtalk.keyword || '检测') + '」（secret 未配置，消息必须包含该关键词）');
    }

    var runners = {}; // sym -> { runner, interval }
    var startSequence = Promise.resolve(); // 串行启动（避免并发拉历史压代理）
    var refreshDate = null; // 上次名单刷新日期（YYYY-MM-DD，UTC）

    function startSymbol(sym) {
        startSequence = startSequence.then(function () {
            log(sym + ' 加入监控：拉取初始历史（可能命中本地缓存）...');
            return dataSource.fetchInitial(sym, CONFIG.warmupDays).then(function (data) {
                var r = createRunner(sym);
                // Fix 1（11L.3 P0）：initFromHistory 内部 purity fail-closed（throw）——
                // 必须初始化成功后才启动轮询循环，失败不留半启动状态
                return r.initFromHistory(data).then(function () {
                    r.startLoop(); // 11L.5：setTimeout 串行链（tick 完成后再调度下一轮，无重入）
                    runners[sym] = { runner: r };
                    r.tick(); // 立即先跑一轮
                    log(sym + ' 监控就绪');
                });
            });
        }).catch(function (e) {
            log(sym + ' 启动失败: ' + (e && e.message || e) + '（跳过，下轮刷新重试）');
        });
        return startSequence;
    }

    function stopSymbol(sym) {
        if (!runners[sym]) return;
        runners[sym].runner.stopLoop(); // 11L.5：清掉 setTimeout 链
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
            // Fix 1 + 11L.5（P1-1）：Top 名单 futures-only 且 source 必须显式 === 'futures'
            // （undefined 视为来源不明，拒绝刷新，保留现有监控）
            if (CONFIG.requireFutures && list.some(function (x) { return x.source !== 'futures'; })) {
                log('DATA_SOURCE_DEGRADED: Top 名单来源非 futures/无 source（' + (list[0].source || 'undefined') + '）——拒绝刷新，保留现有监控');
                return;
            }
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
            // 11L.2 fix（2026-08-19）：top10 分支补"全部就绪"确认日志（与 fixed 分支一致）
            log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
            log('=== 每日 ' + CONFIG.topSymbols.refreshHourUTC + ':00 UTC 自动刷新 Top' + CONFIG.topSymbols.count + ' ===');
            setInterval(checkDailyRefresh, CONFIG.topSymbols.refreshIntervalMs);
        });
    } else if (CONFIG.symbolsMode === 'fixed') {
        // Fix 4（11L.3）：第一版 fixed 模式 —— 只监控 symbols 列表（默认 BTCUSDT），
        // 等验证通过后再切 top10
        ensureSymbols(CONFIG.symbols || []).then(function () {
            log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
        });
    } else {
        throw new Error('未知 symbolsMode=' + CONFIG.symbolsMode + '（可选 top10 / fixed）');
    }
}

main();
