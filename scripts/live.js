/**
 * Phase 11L — Live Opportunity Radar（实时机会提醒入口）
 *
 * Production notification flow:
 *   closed 5m -> valid Displacement -> backward matching-liquidity association -> WATCH
 *   -> owning Displacement K1/K2/K3 native FVG -> Futures aggTrade FIRST_TOUCH -> DingTalk.
 * Legacy HIGH/WATCH/LOW remains statistical/shadow output only.
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
var dailyBiasServiceModule = require('../live/dailyBiasService');
var dingTalk = require('../notify/dingTalk');
var continuityChecker = require('../replay/continuityChecker');
var liquidityProvenance = require('../stats/liquidityProvenance');
var alertPrioritization = require('../stats/alertPrioritization');
var thresholds = require('../config/thresholds');
var displacementWatch = require('../stats/displacementWatch');
var watchNarrativeLifecycleV1 = require('../stats/watchNarrativeLifecycleV1');
var futuresPriceStream = require('../live/futuresPriceStream');
var watchNotificationPresentationV1 = require('../notify/watchNotificationPresentationV1');
var watchNotificationZhV1Flag = require('../config/watchNotificationZhV1');
var sweepContextV1Flag = require('../config/sweepContextV1');
var eqProductionVersionConfig = require('../config/eqProductionVersion');

var CONFIG = require('../config/live.json');
var EQ_PRODUCTION_VERSION = eqProductionVersionConfig.get();

// Phase 11L.15：B 口径 Live Shadow Prioritization 开关（thresholds.notify.prioritization.enabled）。
//   true  → 钉钉只推 PRIORITY_HIGH（HIGH + 48 窗口内 Significant Liquidity），STANDARD_HIGH 只落日志
//   false → 全部 HIGH 照常推钉钉（仅记录 notifyPriority 字段）——回滚开关，无需改代码
var PRIORITIZATION_ENABLED = !!(thresholds.notify && thresholds.notify.prioritization &&
    thresholds.notify.prioritization.enabled);

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
// Compact only after one extra loader-warmup block has accumulated. Bootstrap
// still consumes exactly the retained window; the slack avoids rewriting the
// complete JSONL file on every newly closed candle.
var PERSISTENCE_COMPACTION_SLACK_BARS = 300;

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

function yieldToEventLoop() {
    return new Promise(function (resolve) {
        setImmediate(resolve);
    });
}

function retainLatestCandles(candles, maxBars) {
    var rows = candles || [];
    var limit = Math.max(0, Math.floor(Number(maxBars) || 0));
    if (limit === 0) return [];
    return rows.length > limit ? rows.slice(rows.length - limit) : rows.slice();
}

function prepareBootstrapCandles(existing, fetched, maxBars) {
    var persisted = existing || [];
    var incoming = fetched || [];
    var known = {};
    persisted.forEach(function (c) { known[c.openTime] = true; });
    var fresh = incoming.filter(function (c) { return !known[c.openTime]; });
    // A day-bucket cache can return an older fetch end than the locally persisted
    // tail. Fresh rows may therefore precede, not follow, persisted rows. Always
    // restore chronological order before retention/continuity validation.
    var combined = persisted.concat(fresh);
    var merged = combined.slice().sort(function (a, b) {
        return a.openTime - b.openTime;
    });
    var reordered = combined.some(function (c, index) { return c !== merged[index]; });
    var candles = retainLatestCandles(merged, maxBars);
    return {
        candles: candles,
        fresh: fresh,
        mergedBars: merged.length,
        reordered: reordered,
        prunedBars: merged.length - candles.length
    };
}

/**
 * Sequential historical bootstrap with one cooperative macrotask yield after each
 * fully completed bar. This preserves ordering and side effects while allowing
 * existing realtime symbol callbacks/timers to run during a new-symbol bootstrap.
 */
function replayBootstrapBars(candles, onBar, afterBar, onProgress) {
    var rows = candles || [];
    var startedAt = Date.now();
    var blockStartedAt = startedAt;
    var blockStartIndex = 0;
    var chain = Promise.resolve();
    rows.forEach(function (candle, index) {
        chain = chain.then(function () {
            return onBar(candle, index);
        }).then(function (value) {
            return Promise.resolve(afterBar ? afterBar(candle, index, value) : null).then(function () {
                return value;
            });
        }).then(function (value) {
            return yieldToEventLoop().then(function () {
                var completed = index + 1;
                if (onProgress && (completed % 500 === 0 || completed === rows.length)) {
                    var now = Date.now();
                    var blockBars = completed - blockStartIndex;
                    var blockMs = now - blockStartedAt;
                    onProgress({
                        completed: completed,
                        total: rows.length,
                        progressPct: rows.length ? completed / rows.length * 100 : 100,
                        blockMs: blockMs,
                        elapsedMs: now - startedAt,
                        barsPerSecond: blockMs > 0 ? blockBars / (blockMs / 1000) : null
                    });
                    blockStartedAt = now;
                    blockStartIndex = completed;
                }
                return value;
            });
        });
    });
    return chain;
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
    // 11L.15：通知层优先级标识 —— PRIORITY_HIGH（🔴 钉钉立即推）/ STANDARD_HIGH（🟡 只落日志；
    // enabled=false 全推时用于区分两组，配合"人工值得看比例"评估）。不影响 HIGH 判定。
    var headTag = opp.notifyPriority === 'STANDARD_HIGH' ? '🟡 ' : '🔴 ';
    var lines = [
        headTag + keyword + ' · HIGH QUALITY WATCH · ' + symbol,
        dir
    ];
    var dailyBias = opp.dailyBias || {
        bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'UNKNOWN',
        evaluationTime: null, ageMs: null
    };
    lines.push('Daily Bias:');
    lines.push(dailyBias.bias + ' / ' + (dailyBias.confidence || '-') +
        ' · ' + dailyBias.alignment + ' · ' + dailyBias.status);
    lines.push('Bias Eval: ' + (dailyBias.evaluationTime !== null
        ? fmt(dailyBias.evaluationTime) + ' · age ' + Math.round(dailyBias.ageMs / 60000) + 'm'
        : '-'));
    // Phase 11L.8 + 11L.15b：流动性通知行 —— 展示与判定依据对齐。
    //
    //   判定（B 口径，windowHasSignificant）看的是 48 根窗口内 allCandidates 是否存在
    //   Significant Liquidity（EQL/EQH/PDL/PDH/Session）；而 immediateSweep 只是"离 leg 最近
    //   （或同距最新）的 sweep"，经常被更频繁的普通 swing 抢走 —— 这就是 XRP/ETH 案例里
    //   "消息显示 5M SWING_HIGH 但实际是 PRIORITY_HIGH"的来源，不是筛选 bug。
    //
    //   文案因此拆两块：
    //     Priority Liquidity → allCandidates 中全部 Significant（"为什么这条 HIGH 有资格打扰你"）
    //     Immediate Context  → 离 leg 最近的 sweep（仅供上下文，不构成判定依据）
    //   STANDARD（窗口内无 Significant；enabled=false 全推时可见）→ Liquidity Context（immediateSweep 或 NONE）。
    var liq = opp.liquidityContext;
    var sigs = alertPrioritization.significantCandidates(opp);
    if (sigs.length > 0) {
        lines.push('Priority Liquidity:');
        sigs.forEach(function (s, i) {
            var prefix = sigs.length > 1 ? '• ' : '';
            lines.push(prefix + (liquidityProvenance.formatSweepPriceLine(s) || (s.side + ' · ' + (s.sourceType || 'UNKNOWN'))) +
                ' · ' + (liquidityProvenance.formatSweepRelationLine(s) || 'BEFORE_LEG'));
        });
        if (liq && liq.immediateSweep) {
            lines.push('Immediate Context:');
            lines.push((liquidityProvenance.formatSweepPriceLine(liq.immediateSweep) || 'Immediate Context: -') +
                ' · ' + (liquidityProvenance.formatSweepRelationLine(liq.immediateSweep) || 'BEFORE_LEG'));
        }
    } else if (liq && liq.immediateSweep) {
        // STANDARD_HIGH：窗口内无 Significant（仅普通 swing 或无）
        lines.push('Liquidity Context:');
        lines.push(liquidityProvenance.formatSweepPriceLine(liq.immediateSweep) || 'Liquidity Context: -');
        lines.push(liquidityProvenance.formatSweepRelationLine(liq.immediateSweep) || 'BEFORE_LEG');
    } else {
        lines.push('Liquidity Context: NONE');
    }
    lines.push(
        (opp.legRangeAtr !== null && opp.legRangeAtr !== undefined ? 'Leg: ' + opp.legQuality + ' (' + opp.legRangeAtr.toFixed(1) + ' ATR)' : 'Leg: ' + opp.legQuality),
        notifTarget !== null ? 'Near Draw: ' + notifDist.toFixed(2) + '% 距离（target ' + fmtPrice(notifTarget) + '）' : 'Near Draw: -',
        '通知: ' + fmt(notified) + '（leg 锚 ' + fmt(opp.anchorTime) + '）'
    );
    return lines.join('\n');
}

function buildLegacyFvgRetracementMessage(watch, currentPrice) {
    var keyword = CONFIG.dingtalk.keyword || '检测';
    var dir = watch.direction === 'BULLISH' ? 'LONG' : 'SHORT';
    var liq = watch.liquidityTaken && watch.liquidityTaken.primary;
    var f = watch.nativeFvg;
    var bias = watch.dailyBias || { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'UNKNOWN' };
    return [
        keyword + ' · ' + watch.symbol + ' ' + dir + ' WATCH TRIGGERED',
        '',
        'Liquidity Taken:',
        liq ? ((liq.sourceType || 'UNKNOWN') + ' @ ' + fmtPrice(liq.sourcePrice) + ' · ' + (liq.relation || 'BEFORE_LEG')) : 'NONE',
        '',
        'Displacement:',
        watch.direction + ' · quality ' + (watch.displacement.quality || 'UNKNOWN'),
        'start/end: ' + watch.displacement.startIndex + '/' + watch.displacement.endIndex,
        '',
        'Native FVG:',
        'low: ' + fmtPrice(f.low),
        'high: ' + fmtPrice(f.high),
        'midpoint: ' + fmtPrice(f.midpoint),
        'current price: ' + fmtPrice(currentPrice),
        'touch: FIRST_TOUCH',
        '',
        '4H Daily Bias:',
        (bias.bias || 'UNKNOWN') + ' / ' + (bias.confidence || '-') +
            ' · ' + (bias.alignment || 'UNKNOWN') + ' · ' + (bias.status || 'UNKNOWN'),
        '',
        '仅为市场结构监测，不是自动交易指令。'
    ].join('\n');
}

function buildFvgRetracementMessage(watch, currentPrice, options) {
    var opts = options || {};
    var enabled = opts.zhEnabled !== undefined ? !!opts.zhEnabled : watchNotificationZhV1Flag.isEnabled(opts.env);
    if (!enabled) return buildLegacyFvgRetracementMessage(watch, currentPrice);
    var sweepContextEnabled = opts.sweepContextEnabled !== undefined
        ? !!opts.sweepContextEnabled : sweepContextV1Flag.isEnabled(opts.env);
    return watchNotificationPresentationV1.build(watch, currentPrice, {
        formatPrice: fmtPrice,
        keyword: opts.keyword !== undefined ? opts.keyword : (CONFIG.dingtalk.keyword || '检测'),
        sweepContextEnabled: sweepContextEnabled,
        // Actual formatter/send-attempt time. This is presentation-only and is
        // intentionally not derived from candle or WATCH evaluation timestamps.
        notificationGeneratedAt: opts.notificationGeneratedAt !== undefined
            ? opts.notificationGeneratedAt : Date.now()
    });
}

// ---------- 每个 symbol 的运行时 ----------
// Generic Structural Provenance V1 supports Swing context only.
// Persist the mode name so a pre-refactor cursor fails closed and is rebuilt.
function structuralSwingMode() {
    return 'STRUCTURAL_PROVENANCE_2L2R_V1';
}
function createRunner(symbol) {
    var dir = path.join(CONFIG.dataDir, symbol);
    persistence.ensureDir(dir);
    var candlesFile = path.join(dir, 'candles.jsonl');
    var pushedFile = path.join(dir, 'pushed.json');
    var stateFile = path.join(dir, 'cursor.json');
    var dailyBiasFile = path.join(dir, 'daily-bias.json');
    var shadowFile = path.join(dir, 'prioritization.jsonl'); // 11L.15：两组 HIGH 的 shadow 记录（3-7 天后 forward 对比）
    var watchFile = path.join(dir, 'displacement-watches.json');
    var watchDeliveredFile = path.join(dir, 'fvg-watch-delivered.json');
    var watchOutboxFile = path.join(dir, 'fvg-watch-outbox.json');
    var dailyBiasService = dailyBiasServiceModule.createDailyBiasService({
        symbol: symbol,
        file: dailyBiasFile
    });

    var engine = null;
    var lastCloseTime = 0;
    var lastOpenTime = null;
    var historyLoaded = false;
    var runnerData = null; // Fix 1：{ raw, structureCandles, calendarCandles }（HTF 增量共用同一对象）
    var delivered = {}; // Fix 3（11L.3）：oppId -> anchorIndex（钉钉确认投递成功才写入；持久化跨重启）
    var watchStore = displacementWatch.createWatchStore(
        persistence.loadJson(watchFile, []),
        persistence.loadJson(watchDeliveredFile, {})
    );
    // P4.1: Narrative ownership is derived from already-touched WATCHes. It is
    // not a checkpoint and does not participate in WATCH/touch eligibility.
    var narrativeReconstruction = watchNarrativeLifecycleV1.reconstructFromWatches(watchStore.getAll());
    var narrativeState = narrativeReconstruction.state;
    narrativeReconstruction.results.forEach(function (item) {
        var persistedWatch = watchStore.get(item.watchId);
        var canonicalMetadata = watchNarrativeLifecycleV1.metadataOf(item.result);
        var persistedMetadata = persistedWatch && persistedWatch.observationId ? {
            narrativeId:persistedWatch.narrativeId,
            observationId:persistedWatch.observationId,
            observationType:persistedWatch.observationType,
            narrativeStateSnapshot:persistedWatch.narrativeStateSnapshot
        } : null;
        if (persistedMetadata && JSON.stringify(persistedMetadata) !== JSON.stringify(canonicalMetadata)) {
            log(symbol + ' WATCH_NARRATIVE_V1_RECONSTRUCTION_MISMATCH watch=' + item.watchId +
                '（reported and canonically reconstructed；delivery dedup unchanged）');
        }
        watchNarrativeLifecycleV1.attachMetadata(persistedWatch, item.result);
    });
    var watchPending = persistence.loadJson(watchOutboxFile, []);
    var priceStream = null;
    var priceDeliveryChain = Promise.resolve();
    var bootstrapRetentionBars = dataSource.initial5mRetentionBars(CONFIG.warmupDays);
    var persistedCandles = [];

    function loadPushed() {
        return persistence.loadJson(pushedFile, {});
    }

    function saveWatchState() {
        persistence.saveJson(watchFile, watchStore.getAll());
        persistence.saveJson(watchDeliveredFile, watchStore.getDelivered());
        persistence.saveJson(watchOutboxFile, watchPending);
    }

    /**
     * P4.1 classification runs only after an existing WATCH store has emitted
     * FIRST_TOUCH. It is fail-open for delivery: unresolved legacy provenance
     * is logged but never suppresses or changes the touched WATCH population.
     */
    function classifyNarrativeTouches(touched) {
        var rows = (touched || []).slice().sort(watchNarrativeLifecycleV1.compareTouchOrder);
        rows.forEach(function (watch) {
            var result = watchNarrativeLifecycleV1.observeFirstTouch(narrativeState, watch);
            if (result.observation) {
                watchNarrativeLifecycleV1.attachMetadata(watch, result);
                return;
            }
            if (!result.duplicate) {
                log(symbol + ' WATCH_NARRATIVE_V1_UNRESOLVED watch=' + (watch && watch.id || 'UNKNOWN') +
                    ' reason=' + result.reason + '（classification only；FIRST_TOUCH delivery unchanged）');
            }
        });
        return touched;
    }

    /**
     * 11L.15：两组（PRIORITY/STANDARD）HIGH 都落 shadow 记录（schema 锁定，
     * 见 stats/livePrioritizationAudit.js）—— 3-7 天后用 scripts/livePrioritizationAudit.js
     * 对比 forward：n / NearHit30m / NearHit1h / MFE / MAE。
     * 11L.15a：写盘失败不静默（磁盘满/权限/损坏）——样本悄悄消失会让几天后的对比失真。
     */
    function logShadowOpp(opp) {
        try {
            var ctx = opp.liquidityContext || {};
            var rec = {
                id: opp.id,
                symbol: symbol,
                ts: Date.now(),
                priority: opp.notifyPriority || 'STANDARD_HIGH',
                direction: opp.direction,
                tier: opp.tier,
                availableAt: opp.availableAt !== undefined ? opp.availableAt : opp.anchorTime,
                anchorTime: opp.anchorTime,
                anchorIndex: opp.anchorIndex,
                notificationPrice: opp.notificationPrice !== undefined ? opp.notificationPrice : opp.anchorPrice,
                notificationNearTarget: opp.notificationNearTarget !== undefined ? opp.notificationNearTarget : opp.nearTarget,
                nearTarget: opp.nearTarget,
                // 11L.15a：通知时点距离（通知快照口径，非 anchor 口径）——未来 NearDistance/ATR 归一化研究需要
                notificationNearDistPct: opp.notificationNearDistPct !== undefined ? opp.notificationNearDistPct : opp.nearDistPct,
                nearDistPct: opp.nearDistPct,
                // 11L.15b：判定依据明细（48 窗口内全部候选）——可追溯"到底是哪个 significant 让它通过"，
                // 避免只看消息（immediateSweep）误判为筛选 bug
                immediateSweep: ctx.immediateSweep ? {
                    side: ctx.immediateSweep.side,
                    sourceType: ctx.immediateSweep.sourceType,
                    sourcePrice: ctx.immediateSweep.sourcePrice,
                    confirmedAt: ctx.immediateSweep.confirmedAt,
                    barsBeforeLegStart: ctx.immediateSweep.barsBeforeLegStart
                } : null,
                allCandidates: (ctx.allCandidates || []).map(function (c) {
                    return {
                        side: c.side,
                        sourceType: c.sourceType,
                        sourcePrice: c.sourcePrice,
                        confirmedAt: c.confirmedAt,
                        barsBeforeLegStart: c.barsBeforeLegStart,
                        significant: alertPrioritization.isSignificant(c.sourceType)
                    };
                }),
                structureMode: structuralSwingMode()
            };
            rec.dailyBias = opp.dailyBias || null;
            fs.appendFileSync(shadowFile, JSON.stringify(rec) + '\n');
        } catch (e) {
            log(symbol + ' PRIORITIZATION_SHADOW_WRITE_ERROR: ' + (e && e.message || e) + '（shadow 样本未落盘，钉钉/雷达不受影响）');
        }
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
        // A cursor from any prior structural implementation must not be resumed.
        var cursor = persistence.loadJson(stateFile, null);
        var mode = structuralSwingMode();
        if (cursor && cursor.structureMode && cursor.structureMode !== mode) {
            throw new Error('STRUCTURE_MODE_CHANGED: ' + symbol + ' cursor.structureMode=' +
                cursor.structureMode + ' 当前=' + mode + '——请清理 .live-state 后重启重新 bootstrap，' +
                '请重新 bootstrap（勿用旧结构状态继续运行）');
        }
        if (cursor && cursor.eqProductionVersion && cursor.eqProductionVersion !== EQ_PRODUCTION_VERSION) {
            log(symbol + ' EQ producer migration: ' + cursor.eqProductionVersion + ' -> ' +
                EQ_PRODUCTION_VERSION + '（Registry 由已持久化 closed candles 确定性重建）');
        }
        // Fix 1 (P0)：runnerData 保存组装后的 HTF 引用（fetchHtfIncrement 增量更新同一对象）
        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
        runnerData = { raw: data, structureCandles: structureCandles, calendarCandles: calendarCandles };
        var candles5m = (data['5m'] || []).slice();
        log(symbol + ' 初始历史 ' + candles5m.length + ' 根 5m（' + fmt(candles5m[0].closeTime) + ' → ' + fmt(candles5m[candles5m.length - 1].closeTime) + '）');
        // 持久化历史（幂等：跳过已存在的 openTime），然后限制为与
        // fetchInitial 完全相同的 30d + 5m loader warmup 窗口。旧安装积累的
        // 更早 candles 不再让 restart bootstrap 随运行时间无限增长。
        var prepared = prepareBootstrapCandles(existing, candles5m, bootstrapRetentionBars);
        var all = prepared.candles;
        var prunedBars = prepared.prunedBars;
        if (prepared.fresh.length > 0 || prunedBars > 0 || prepared.reordered) {
            persistence.replaceCandles(candlesFile, all);
        }
        persistedCandles = all.slice();
        if (prunedBars > 0) {
            log(symbol + ' bootstrap 历史压缩: ' + prepared.mergedBars + ' -> ' + all.length +
                ' 根（retention=' + bootstrapRetentionBars + '）');
        } else if (prepared.reordered) {
            log(symbol + ' bootstrap 历史顺序已自动修复（' + all.length + ' 根）');
        }

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
            contextCandles5m: all,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            fetcher: dataSource.makeFetcher(calendarCandles),
            thresholds: require('../config/thresholds')
        }, {
            snapshotInterval: CONFIG.snapshotInterval,
            baseIndex: 0,
            dailyBiasProvider: function (direction, atTime) {
                return dailyBiasService.getDailyBias(direction, atTime);
            },
            eqProductionVersion: EQ_PRODUCTION_VERSION
        });

        delivered = loadPushed();

        // 逐根推进历史（warmup 段机会不推送：已过去）。每根完整完成后显式
        // macrotask yield，避免新 symbol bootstrap 饿死已有 symbol 的 realtime callbacks。
        var chain = replayBootstrapBars(all, function (c, idx) {
            return engine.onBar(c, idx);
        }, function (c) {
            // Bootstrap reconstructs lifecycle but never sends historical touches.
            engine.drainDisplacementWatchUpdates().forEach(function (w) { watchStore.upsert(w); });
            classifyNarrativeTouches(watchStore.onCandle(c));
        }, function (progress) {
            log(symbol + ' [BOOTSTRAP] ' + progress.completed + ' / ' + progress.total +
                ' ' + progress.progressPct.toFixed(1) + '%' +
                ' block=' + (progress.blockMs / 1000).toFixed(3) + 's' +
                ' elapsed=' + (progress.elapsedMs / 1000).toFixed(3) + 's' +
                ' bars/s=' + (progress.barsPerSecond === null ? '-' : progress.barsPerSecond.toFixed(1)));
        });
        return chain.then(function () {
            return refreshDailyBias();
        }).then(function () {
            lastCloseTime = all[all.length - 1].closeTime;
            lastOpenTime = all[all.length - 1].openTime;
            historyLoaded = true;
            persistence.saveJson(pushedFile, delivered);
            saveWatchState();
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: all.length,
                structureMode: mode, eqProductionVersion: EQ_PRODUCTION_VERSION });
            log(symbol + ' 状态就绪，已推进 ' + all.length + ' 根，去重集合 ' + Object.keys(delivered).length + ' 个已投递机会');
        });
    }

    function isWatchPending(key) {
        return watchPending.some(function (x) { return x.notificationKey === key; });
    }

    function deliverWatchTouch(watch) {
        var key = watch.notificationKey;
        if (!key || watchStore.getDelivered()[key]) return Promise.resolve(true);
        var eqPrimary = watch.liquidityTaken && watch.liquidityTaken.primary;
        if (eqPrimary && (eqPrimary.sourceType === 'EQH' || eqPrimary.sourceType === 'EQL') &&
            !eqPrimary.eqMemberProvenance) {
            log(symbol + ' EQ_MEMBER_PROVENANCE_MISSING watch=' + watch.id +
                ' sourceId=' + (eqPrimary.sourceId || 'UNKNOWN') + '（通知安全降级，不阻止发送）');
        }
        var msg = buildFvgRetracementMessage(watch, watch.firstTouchPrice);
        log('FVG FIRST_TOUCH: ' + symbol + ' ' + watch.direction + ' watch=' + watch.id +
            ' fvg=' + watch.nativeFvg.id + ' price=' + fmtPrice(watch.firstTouchPrice));
        return dingTalk.sendText(CONFIG.dingtalk.webhook, CONFIG.dingtalk.secret, msg).then(function (res) {
            if (!res || res.errcode !== 0) throw new Error('errcode=' + (res ? res.errcode : 'none'));
            watchStore.markNotified(watch.id, Date.now());
            saveWatchState();
            log(symbol + ' FVG retracement 钉钉投递成功 key=' + key);
            return true;
        }).catch(function (e) {
            log(symbol + ' FVG retracement 钉钉投递失败 key=' + key + ': ' + e.message + '（保留 watch outbox）');
            return false;
        });
    }

    function handleWatchTouches(touched) {
        classifyNarrativeTouches(touched);
        (touched || []).forEach(function (watch) {
            if (!watch.notificationKey || watchStore.getDelivered()[watch.notificationKey] || isWatchPending(watch.notificationKey)) return;
            watchPending.push({ notificationKey: watch.notificationKey, watchId: watch.id, attempts: 0 });
        });
        saveWatchState();
        return retryWatchPending();
    }

    function retryWatchPending() {
        if (!watchPending.length) return Promise.resolve();
        var list = watchPending.slice();
        watchPending = [];
        return list.reduce(function (p, item) {
            return p.then(function () {
                var watch = watchStore.get(item.watchId);
                if (!watch || watchStore.getDelivered()[item.notificationKey]) { saveWatchState(); return; }
                return deliverWatchTouch(watch).then(function (ok) {
                    if (!ok) watchPending.push(item);
                    saveWatchState();
                });
            });
        }, Promise.resolve());
    }

    function applyWatchUpdates() {
        var updates = engine.drainDisplacementWatchUpdates();
        updates.forEach(function (watch) {
            var current = watchStore.upsert(watch);
            log(symbol + ' DISPLACEMENT_WATCH ' + current.state + ' id=' + current.id +
                ' liquidity=' + (current.liquidityTaken.primary && current.liquidityTaken.primary.sourceType || 'UNKNOWN') +
                ' nativeFvg=' + (current.nativeFvg ? current.nativeFvg.id : 'NONE'));
        });
        if (updates.length) saveWatchState();
    }

    function onRealtimePrice(price, at) {
        priceDeliveryChain = priceDeliveryChain.then(function () {
            var touched = watchStore.onPrice(price, at);
            if (touched.changed) saveWatchState();
            return touched.length ? handleWatchTouches(touched) : null;
        }).catch(function (e) { log(symbol + ' PRICE_STREAM_HANDLER_ERROR: ' + (e && e.message || e)); });
    }

    function startPriceStream() {
        if (priceStream) return;
        priceStream = futuresPriceStream.createFuturesPriceStream(symbol, {
            onOpen: function () { log(symbol + ' Futures WebSocket aggTrade connected'); },
            onPrice: onRealtimePrice,
            onClose: function () { log(symbol + ' Futures WebSocket closed; reconnect scheduled'); },
            onError: function (e) { log(symbol + ' Futures WebSocket error: ' + (e && e.message || e)); }
        });
        priceStream.start();
    }

    /** Legacy HIGH remains a statistical/shadow output and no longer drives DingTalk. */
    function handleHigh(opp) {
        logShadowOpp(opp);
        log(symbol + ' LEGACY_HIGH 仅统计/兼容输出，不触发 DingTalk id=' + opp.id);
        return Promise.resolve(null);
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
                    applyWatchUpdates();
                    // Closed-candle fallback covers WebSocket outages. It starts strictly
                    // after watch/native-FVG confirmation and cannot self-touch K3.
                    var fallbackTouches = watchStore.onCandle(c);
                    if (fallbackTouches.length) return handleWatchTouches(fallbackTouches).then(function () { return opp; });
                    saveWatchState();
                    return opp;
                }).then(function (opp) {
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
            persistedCandles = persistedCandles.concat(list);
            if (persistedCandles.length > bootstrapRetentionBars + PERSISTENCE_COMPACTION_SLACK_BARS) {
                persistedCandles = retainLatestCandles(persistedCandles, bootstrapRetentionBars);
                persistence.replaceCandles(candlesFile, persistedCandles);
                log(symbol + ' candles.jsonl 定期压缩至 ' + persistedCandles.length + ' 根');
            } else {
                persistence.appendCandles(candlesFile, list);
            }
            persistence.saveJson(pushedFile, delivered);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: engine.getWindowLength(),
                structureMode: structuralSwingMode(), eqProductionVersion: EQ_PRODUCTION_VERSION });
        });
    }

    /**
     * 11L.5（P0-1）：tick 并发锁 —— 互斥 + setTimeout 串行链双保险。
     * 上一轮 tick 未完成时的新一轮直接 skip（返回 resolved，不重入）；
     * 由 startLoop 的 setTimeout 链保证 tick 完成后才调度下一轮。
     */
    var tickRunning = false;
    var loopTimer = null;

    function refreshDailyBias() {
        return dailyBiasService.updateOnClosed4h(runnerData.structureCandles['4h']).then(function (result) {
            if (!result.attempted) return result;
            if (result.updated) {
                log(symbol + ' Daily Bias 更新: ' + result.snapshot.bias + '/' + result.snapshot.confidence +
                    ' evaluationTime=' + fmt(result.snapshot.evaluationTime));
            } else {
                log(symbol + ' Daily Bias API 失败: ' + result.error.code + ' ' + result.error.message +
                    '（保留上一 snapshot，按 8h 规则标记 STALE/UNKNOWN）');
            }
            return result;
        }).catch(function (e) {
            log(symbol + ' Daily Bias service 错误: ' + (e && e.message || e) +
                '（不影响 Opportunity detection/notification）');
            return null;
        });
    }

    function doTick() {
        return retryWatchPending().then(function () {
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
            return refreshDailyBias().then(function () {
                // 11L.5（P1-2）：HTF 更新异常 → 本轮暂停 5m 推进。
                // Near Draw/Liquidity/Snapshot 依赖 HTF context，stale HTF 下不应发 HIGH；
                // 下轮 HTF 恢复后 poll 自动检测 gap → backfill → 连续推进（Live/Replay 状态一致）
                if (!htf.ok) {
                    log(symbol + ' HTF 更新异常（' + htf.issues.length + ' 处）——本轮暂停 5m 推进，避免基于 stale HTF 发通知');
                    return;
                }
                return dataSource.pollNew5m(symbol, lastCloseTime);
            });
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
        startPriceStream();
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
        if (priceStream) { priceStream.stop(); priceStream = null; }
    }

    return {
        initFromHistory: initFromHistory,
        tick: tick,
        startLoop: startLoop,
        stopLoop: stopLoop,
        getNarrativeProjection: function () { return watchNarrativeLifecycleV1.projection(narrativeState); }
    };
}

// ---------- 主流程（Phase 11L.2：top10 动态监控 + 每日刷新） ----------
function main() {
    persistence.ensureDir(CONFIG.dataDir);
    log('=== Live Opportunity Radar 启动 ===');
    log('STRUCTURAL_SWING_MODE=' + structuralSwingMode() +
        '（Swing context source：confirmed 2L/2R pivots + Structural Provenance）');
    log('EQ_PRODUCTION_VERSION=' + EQ_PRODUCTION_VERSION +
        (EQ_PRODUCTION_VERSION === 'V3' ? '（Persistent Cluster V3）' : '（V2 emergency rollback）'));
    log('11L.15 Alert Prioritization: ' + (PRIORITIZATION_ENABLED
        ? 'ENABLED（钉钉只推 PRIORITY_HIGH = HIGH + 48 窗口内 Significant Liquidity；STANDARD_HIGH 只落日志）'
        : 'DISABLED（全部 HIGH 照常推钉钉，仅记录 notifyPriority 字段）'));
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

if (require.main === module) main();

module.exports = {
    buildMessage: buildMessage,
    buildLegacyFvgRetracementMessage: buildLegacyFvgRetracementMessage,
    buildFvgRetracementMessage: buildFvgRetracementMessage,
    yieldToEventLoop: yieldToEventLoop,
    replayBootstrapBars: replayBootstrapBars,
    retainLatestCandles: retainLatestCandles,
    prepareBootstrapCandles: prepareBootstrapCandles,
    createRunner: createRunner,
    main: main
};
