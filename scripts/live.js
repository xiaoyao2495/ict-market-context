/**
 * Phase 11L — Live Opportunity Radar（实时机会提醒入口）
 *
 * Production EQ notification flow:
 *   closed 5m -> newly-confirmed EQH/EQL -> EQ_FVG_COUNT_WATCH_V1
 *   -> accumulated raw three-candle FVG counts -> matching #1/#2 -> DingTalk.
 * Legacy HIGH/WATCH/LOW remains an independent statistical output only.
 *
 * Phase 11L.3（Final Production Guardrails）：
 *   1. requireFutures → 初始化 + HTF 增量 futures-only fail-closed（spot 绝不进入）
 *   2. DATA_GAP backfill 后严格 continuity 验证（不通过不推进，下轮继续补）
 *   3. 钉钉投递确认后才去重（失败保留 pending 自动重试）
 *   4. DYNAMIC_CONTRACT_UNIVERSE_V1 每日冻结 Top10，并保留 active lifecycle symbols
 *
 * REAL_ORDER_EXECUTION_V1 is an isolated consumer of the existing WATCH output.
 * It cannot gate or interrupt WATCH/FVG/DingTalk processing and is hard-disabled
 * unless LIVE_TRADING_ENABLED is the literal string "true".
 * 部署：node scripts/live.js（建议 pm2 或计划任务保活）
 *
 * 重启恢复：candles.jsonl（最近 N 根重放重建状态，幂等）+ pushed.json（已投递去重集合）
 */
require('../config/loadEnv')();

var fs = require('fs');
var path = require('path');
var liveEngineMod = require('../live/liveEngine');
var dataSource = require('../live/dataSource');
var binanceRest = require('../data/binanceRest');
var persistence = require('../live/persistence');
var dingTalk = require('../notify/dingTalk');
var continuityChecker = require('../replay/continuityChecker');
var liquidityProvenance = require('../stats/liquidityProvenance');
var alertPrioritization = require('../stats/alertPrioritization');
var thresholds = require('../config/thresholds');
// TWO_BAR_PRODUCTION_REPLACEMENT_V1: the old EQ -> WATCH -> FVG -> EQ-FVG
// semantic -> FVG-midpoint LIMIT chain is no longer reachable from live.js.
// The modules still exist for research/tests; nothing below requires them.
var twoBarSetupV1 = require('../strategy/twoBarSetupV1');
var twoBarLivePipelineV1 = require('../strategy/twoBarLivePipelineV1');
var breakoutEntryRulesV1 = require('../execution/breakoutEntryRulesV1');
var breakoutExecutionV1 = require('../execution/breakoutExecutionV1');
var fourHourBiasV3 = require('../live/4hBiasV3');
var fourHourBiasDecisionStoreV1 = require('../bias/4hBiasDecisionStoreV1');
var notificationMarketContext = require('../notify/4hBiasContext');
var productionEqualLiquidityV1 = require('../liquidity/productionEqualLiquidityV1');
var rangeDetectorV1 = require('../range/rangeDetectorV1');
var rangeAlertService = require('../live/rangeAlertService');
var rangeNotificationV1 = require('../notify/rangeNotificationV1');
var executionRepositoryV1 = require('../execution/executionRepositoryV1');
var binanceExecutionClientV1 = require('../execution/binanceExecutionClientV1');
var realTradeCaseArchiveV1 = require('../execution/realTradeCaseArchiveV1');
var executionNotificationV1 = require('../notify/executionNotificationV1');
var dynamicContractUniverseV1 = require('../live/dynamicContractUniverseV1');

var CONFIG = require('../config/live.json');
var EQ_PRODUCTION_MODEL = productionEqualLiquidityV1.VERSION;
var DISPLACEMENT_PRODUCTION_MODE = 'CANONICAL_A_C2_V1';
var LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
// TWO_BAR_PRODUCTION_REPLACEMENT_V1: the production NEW ENTRY source.
var PRODUCTION_ENTRY_MODEL = twoBarSetupV1.VERSION;

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

function rangeEnabledFor(symbol) {
    var cfg = CONFIG.rangeDetector || {};
    var params = cfg.parameters || {};
    return cfg.enabled === true && cfg.version === rangeDetectorV1.VERSION &&
        (cfg.timeframes || []).indexOf('5m') !== -1 &&
        (cfg.symbols || []).indexOf(symbol) !== -1 &&
        params.length === rangeDetectorV1.PARAMETERS.length &&
        params.mult === rangeDetectorV1.PARAMETERS.mult &&
        params.atrLength === rangeDetectorV1.PARAMETERS.atrLength &&
        cfg.notifyOnConfirm === true && cfg.notifyOnBreakout === false;
}
function buildMessage(opp, symbol, current4hBias) {
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
    lines.push('');
    lines = lines.concat(notificationMarketContext.lines(current4hBias));
    // Phase 11L.8 + 11L.15b：流动性通知行 —— 展示与判定依据对齐。
    //
    //   判定（B 口径，windowHasSignificant）看的是 48 根窗口内 allCandidates 是否存在
    //   Significant Liquidity（EQL/EQH/Session）；而 immediateSweep 只是"离 leg 最近
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
        (opp.formationRangeAtr !== null && opp.formationRangeAtr !== undefined ? 'Delivery: ' + opp.deliveryQuality + ' (' + opp.formationRangeAtr.toFixed(1) + ' ATR)' : 'Delivery: ' + opp.deliveryQuality),
        notifTarget !== null ? 'Near Draw: ' + notifDist.toFixed(2) + '% 距离（target ' + fmtPrice(notifTarget) + '）' : 'Near Draw: -',
        '通知: ' + fmt(notified) + '（leg 锚 ' + fmt(opp.anchorTime) + '）'
    );
    return lines.join('\n');
}

// ---------- 每个 symbol 的运行时 ----------
// Generic Structural Provenance V1 supports Swing context only.
// Persist the mode name so a pre-refactor cursor fails closed and is rebuilt.
function structuralSwingMode() {
    return 'STRUCTURAL_PROVENANCE_2L2R_V1';
}
function createRunner(symbol, options) {
    var runnerOptions = options || {};
    var dir = path.join(CONFIG.dataDir, symbol);
    persistence.ensureDir(dir);
    var candlesFile = path.join(dir, 'candles.jsonl');
    var pushedFile = path.join(dir, 'pushed.json');
    var stateFile = path.join(dir, 'cursor.json');
    var shadowFile = path.join(dir, 'prioritization.jsonl'); // 11L.15：两组 HIGH 的 shadow 记录（3-7 天后 forward 对比）
    // One atomically-renamed snapshot keeps WATCH close and notification #2
    // outbox creation crash-consistent in the same completed-candle transition.
    var eqStateFile = path.join(dir, 'eq-fvg-count-watch-v1.json');
    var rangeEventsFile = path.join(dir, 'range-events.jsonl');
    var rangeDeliveredFile = path.join(dir, 'range-notified.json');
    var rangeOutboxFile = path.join(dir, 'range-outbox.json');
    var rangeStateFile = path.join(dir, 'range-detector-state.json');
    var executionStateFile = path.join(dir, 'real-order-execution-v1.json');
    var executionEventsFile = path.join(dir, 'real-order-execution-v1.jsonl');
    var realTradeCaseDirectory = path.join(dir, 'real-trade-cases-v1');
    var semanticStoreDirectory = path.join(CONFIG.dataDir, 'eq-fvg-association-semantic-v1');
    var semanticCaseDirectory = path.join(dir, 'eq-fvg-association-cases-v1');
    var turningStoreDirectory = path.join(CONFIG.dataDir, 'turning-point-significance-v1');
    var turningCaseDirectory = path.join(dir, 'turning-point-significance-cases-v1');
    var engine = null;
    var lastCloseTime = 0;
    var lastOpenTime = null;
    var historyLoaded = false;
    var runnerData = null; // { raw, structureCandles }；live HTF 增量共用同一对象
    var current4hBias = fourHourBiasV3.createService({
        symbol: symbol,
        decisionStore: fourHourBiasDecisionStoreV1.createStore({
            directory: path.join(CONFIG.dataDir, '4h-bias-decisions-v1')
        }),
        getFourHourCandles: function () {
            return runnerData && runnerData.structureCandles && runnerData.structureCandles['4h'] || [];
        },
        observe: function (record) {
            log(symbol + ' 4H_BIAS_CREATED ' + JSON.stringify(record));
        },
        observeDecision: function (record) {
            log(symbol + ' ' + record.event + ' ' + JSON.stringify(record));
        }
    });
    var delivered = {}; // Fix 3（11L.3）：oppId -> anchorIndex（钉钉确认投递成功才写入；持久化跨重启）
    var bootstrapRetentionBars = dataSource.production5mRetentionBars();
    var htfBoundaryScheduler = dataSource.createHtfBoundaryScheduler({ retryIntervalMs: 60000 });
    var persistedCandles = [];
    var rangeAlerts = null;
    var rangeStateRestored = false;
    var execution = null;          // breakoutExecutionV1 (new entry / protection lifecycle)
    var twoBarSetup = null;        // Two-Bar setup service (pattern LLM + context LLM)
    var twoBarPipeline = null;     // per-closed-bar Two-Bar -> EQ -> breakout plan pipeline
    var executionSymbolRules = null;
    var scanAdmitted = runnerOptions.scanAdmitted !== false;
    var analysisReady = false;

    function executionContext(decisionTime) {
        var fourHour = runnerData && runnerData.structureCandles && runnerData.structureCandles['4h'] || [];
        var latest = fourHour.filter(function (c) { return c.closed === true && c.closeTime <= decisionTime; })
            .sort(function (a, b) { return b.closeTime - a.closeTime; })[0];
        return {
            bias: current4hBias.getCurrent(),
            expected4hClosedAt: latest ? latest.closeTime : null,
            dynamicDPoints: twoBarPipeline ? twoBarPipeline.dynamicDState().recentSurvivalPoints : [],
            candles: engine ? engine.getWindowSnapshot() : [],
            symbolRules: executionSymbolRules || (runnerData && runnerData.raw && runnerData.raw.exchangeInfo)
        };
    }

    function sendExecutionAlert(event) {
        log(symbol + ' EXECUTION ' + event.type + ' reason=' + (event.reasonCode || '-') +
            ' tradeId=' + (event.tradeId || '-'));
        if (event.type === 'NO_TRADE') return Promise.resolve();
        if (event.type === 'SHADOW_ORDER' && process.env.EXECUTION_SHADOW_DINGTALK_ENABLED !== 'true') return Promise.resolve();
        if (!CONFIG.dingtalk.webhook || CONFIG.dingtalk.webhook.indexOf('YOUR_') !== -1) return Promise.resolve();
        var message = executionNotificationV1.build(event, CONFIG.dingtalk.keyword || '检测');
        return dingTalk.sendText(CONFIG.dingtalk.webhook, CONFIG.dingtalk.secret, message).then(function (response) {
            if (!response || response.errcode !== 0) throw new Error('errcode=' + (response ? response.errcode : 'none'));
        });
    }

    function recordExecutionEvent(event) {
        try { fs.appendFileSync(executionEventsFile, JSON.stringify(Object.assign({ at: Date.now() }, event)) + '\n'); }
        catch (error) { log(symbol + ' EXECUTION_EVENT_WRITE_ERROR: ' + error.message); }
    }

    /**
     * TWO_BAR_PRODUCTION_REPLACEMENT_V1: the only production order lifecycle.
     * Entry / SL / TP / reconciliation / restart recovery / halt all live inside
     * breakoutExecutionV1; live.js never touches order ids.
     */
    function createExecutionService() {
        var repository = executionRepositoryV1.createRepository({
            initial: persistence.loadJson(executionStateFile, {}),
            persist: function (snapshot) { persistence.saveJson(executionStateFile, snapshot); }
        });
        return breakoutExecutionV1.createService({
            symbol: symbol,
            liveTradingEnabled: LIVE_TRADING_ENABLED,
            repository: repository,
            client: binanceExecutionClientV1.createClient({ liveTradingEnabled: LIVE_TRADING_ENABLED }),
            getMarkPrice: function () {
                var snapshot = engine ? engine.getWindowSnapshot() : [];
                return snapshot.length ? snapshot[snapshot.length - 1].close : null;
            },
            getNewTradeAdmission: function () {
                if (!scanAdmitted) return { admitted: false, reasonCode: 'SYMBOL_NOT_IN_SCAN_UNIVERSE' };
                if (!analysisReady) return { admitted: false, reasonCode: 'INSUFFICIENT_ANALYSIS_HISTORY' };
                if (!dataSource.executionRulesReady(executionSymbolRules)) return { admitted: false, reasonCode: 'SYMBOL_RULES_NOT_READY' };
                return { admitted: true, reasonCode: null };
            },
            observe: recordExecutionEvent,
            alert: sendExecutionAlert
        });
    }

    /** Per-closed-bar Two-Bar -> EQ -> breakout plan pipeline. */
    function createTwoBarPipeline() {
        return twoBarLivePipelineV1.createPipeline({
            symbol: symbol,
            setupService: twoBarSetup,
            execution: execution,
            liveTradingEnabled: LIVE_TRADING_ENABLED,
            observe: function (record) { log(symbol + ' ' + record.event + ' ' + JSON.stringify(record)); },
            getBias: function () { return current4hBias.getCurrent(); },
            getExpected4hClosedAt: function () {
                var snapshot = engine ? engine.getWindowSnapshot() : [];
                var now = snapshot.length ? snapshot[snapshot.length - 1].closeTime : Date.now();
                return executionContext(now).expected4hClosedAt;
            },
            getSymbolRules: function () {
                return executionSymbolRules || (runnerData && runnerData.raw && runnerData.raw.exchangeInfo);
            },
            getCurrentContractPrice: function () {
                var snapshot = engine ? engine.getWindowSnapshot() : [];
                return snapshot.length ? snapshot[snapshot.length - 1].close : null;
            }
        });
    }

    /**
     * TWO_BAR_PRODUCTION_REPLACEMENT_V1: the production setup service. Its only
     * semantic stages are the Two-Bar pattern LLM and the preceding-leg LLM.
     */
    function createTwoBarSetupService() {
        return twoBarSetupV1.createService({
            symbol: symbol,
            decisionStoreDir: path.join(CONFIG.dataDir, 'two-bar-setup-decisions-v1'),
            observe: function (record) { log(symbol + ' ' + record.event + ' ' + JSON.stringify(record)); }
        });
    }

    function saveRangeAlertState(snapshot) {
        persistence.saveJson(rangeDeliveredFile, snapshot.delivered);
        persistence.saveJson(rangeOutboxFile, snapshot.pending);
    }

    function recordRangeEvent(event) {
        try {
            fs.appendFileSync(rangeEventsFile, JSON.stringify(event) + '\n');
        } catch (e) {
            // Observability must not strand the shared completed-candle runner
            // after the existing engines have already advanced this candle.
            log(symbol + ' RANGE_EVENT_WRITE_ERROR: ' + (e && e.message || e));
        }
        if (event.type === 'RANGE_CONFIRMED') {
            log(symbol + ' RANGE_CONFIRMED rangeId=' + event.rangeId +
                ' visualStartAt=' + event.visualStartAt + ' confirmedAt=' + event.confirmedAt +
                ' upper=' + event.upper + ' lower=' + event.lower +
                ' midpoint=' + event.midpoint + ' widthPct=' + event.widthPct);
        } else if (event.type === 'RANGE_BROKEN') {
            log(symbol + ' RANGE_BROKEN rangeId=' + event.rangeId +
                ' direction=' + event.direction + ' confirmedAt=' + event.confirmedAt +
                '（记录事件，不通知）');
        }
    }

    function sendRangeConfirmation(event, key) {
        var contextualEvent = notificationMarketContext.attach(event, current4hBias.getCurrent());
        var msg = rangeNotificationV1.buildRangeConfirmationMessage(contextualEvent, {
            exchangeInfo: runnerData && runnerData.raw && runnerData.raw.exchangeInfo,
            formatTime: fmt,
            keyword: CONFIG.dingtalk.keyword || '检测'
        });
        return dingTalk.sendText(CONFIG.dingtalk.webhook, CONFIG.dingtalk.secret, msg).then(function (res) {
            if (!res || res.errcode !== 0) throw new Error('errcode=' + (res ? res.errcode : 'none'));
            log(symbol + ' Range confirmation 钉钉投递成功 key=' + key);
            return res;
        }).catch(function (e) {
            log(symbol + ' Range confirmation 钉钉投递失败 key=' + key + ': ' + e.message + '（保留 range outbox）');
            return { errcode: -1, errmsg: e.message };
        });
    }

    function loadPushed() {
        return persistence.loadJson(pushedFile, {});
    }

    /**
     * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §55–§57.
     *
     * Read-only projection of an already-frozen decision onto the notification
     * event. It never re-decides, never re-queries the model, never re-orders and
     * never rewrites a price: a null entry simply means "no frozen decision for
     * that anchor yet", which the presentation layer renders as UNAVAILABLE.
     */
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
            fs.appendFileSync(shadowFile, JSON.stringify(rec) + '\n');
        } catch (e) {
            log(symbol + ' PRIORITIZATION_SHADOW_WRITE_ERROR: ' + (e && e.message || e) + '（shadow 样本未落盘，钉钉/雷达不受影响）');
        }
    }

    function initFromHistory(data) {
        // Fix 1（11L.3 P0）：requireFutures → 初始化 futures-only fail-closed。
        // 任一 live timeframe（5m/1h/4h/1d）或 exchangeInfo 出现非 futures 源
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
        if (cursor && cursor.displacementMode !== DISPLACEMENT_PRODUCTION_MODE) {
            throw new Error('DISPLACEMENT_MODE_CHANGED: ' + symbol + ' cursor.displacementMode=' +
                (cursor.displacementMode || 'LEGACY') + ' 当前=' + DISPLACEMENT_PRODUCTION_MODE +
                '——请清理该 symbol 的 .live-state 后重启重新 bootstrap');
        }
        if (cursor && cursor.structureMode && cursor.structureMode !== mode) {
            throw new Error('STRUCTURE_MODE_CHANGED: ' + symbol + ' cursor.structureMode=' +
                cursor.structureMode + ' 当前=' + mode + '——请清理 .live-state 后重启重新 bootstrap，' +
                '请重新 bootstrap（勿用旧结构状态继续运行）');
        }
        var persistedEqModel = cursor && (cursor.eqProductionModel || cursor.eqProductionVersion);
        if (persistedEqModel && persistedEqModel !== EQ_PRODUCTION_MODEL) {
            log(symbol + ' EQ producer migration: ' + persistedEqModel + ' -> ' +
                EQ_PRODUCTION_MODEL + '（旧 EQ state 忽略，Registry 由 closed candles 确定性重建）');
        }
        if (!cursor || cursor.productionEntryModel !== PRODUCTION_ENTRY_MODEL) {
            log(symbol + ' PRODUCTION_ENTRY cutover -> ' + PRODUCTION_ENTRY_MODEL +
                '（legacy EQ watch / FVG state files ignored; historical setups not backfilled）');
        }
        // Fix 1 (P0)：runnerData 保存组装后的 HTF 引用（fetchHtfIncrement 增量更新同一对象）
        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        runnerData = { raw: data, structureCandles: structureCandles };
        analysisReady = dataSource.analysisHistoryReady(data);
        if (!analysisReady) {
            var historyStatus = dataSource.analysisHistoryStatus(data);
            log(symbol + ' INSUFFICIENT_ANALYSIS_HISTORY: closed4h=' + historyStatus.available4hBars +
                '/' + historyStatus.required4hBars + ' closed5m=' + historyStatus.available5mBars +
                '/' + historyStatus.required5mBars + '（禁止新 live Entry）');
        }
        var candles5m = (data['5m'] || []).slice();
        log(symbol + ' 初始历史 ' + candles5m.length + ' 根 5m（' + fmt(candles5m[0].closeTime) + ' → ' + fmt(candles5m[candles5m.length - 1].closeTime) + '）');
        // 持久化历史（幂等：跳过已存在的 openTime），并压缩到 production
        // 明确要求的 723 根 closed 5m；旧安装的 30d 存量不会继续进入 bootstrap。
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
            thresholds: require('../config/thresholds')
        }, {
            snapshotInterval: CONFIG.snapshotInterval,
            baseIndex: 0,
            eqProductionModel: EQ_PRODUCTION_MODEL
        });

        if (rangeEnabledFor(symbol)) {
            var savedRangeState = persistence.loadJson(rangeStateFile, null);
            var restoreRangeState = savedRangeState && all.length > 0 &&
                savedRangeState.lastOpenTime === all[all.length - 1].openTime;
            rangeAlerts = rangeAlertService.createRangeAlertService({
                symbol: symbol,
                detector: rangeDetectorV1.createRangeDetectorV1({
                    symbol: symbol,
                    state: restoreRangeState ? savedRangeState : null
                }),
                delivered: persistence.loadJson(rangeDeliveredFile, {}),
                pending: persistence.loadJson(rangeOutboxFile, []),
                send: sendRangeConfirmation,
                record: recordRangeEvent,
                persist: saveRangeAlertState
            });
            rangeStateRestored = !!restoreRangeState;
        }

        delivered = loadPushed();

        // 逐根推进历史（warmup 段机会不推送：已过去）。每根完整完成后显式
        // macrotask yield，避免新 symbol bootstrap 饿死已有 symbol 的 realtime callbacks。
        var chain = replayBootstrapBars(all, function (c, idx) {
            return engine.onBar(c, idx);
        }, function (c) {
            if (rangeAlerts && !rangeStateRestored) {
                rangeAlerts.onCandle(c, { notificationsEnabled: false, recordEvents: false });
            }
        }, function (progress) {
            log(symbol + ' [BOOTSTRAP] ' + progress.completed + ' / ' + progress.total +
                ' ' + progress.progressPct.toFixed(1) + '%' +
                ' block=' + (progress.blockMs / 1000).toFixed(3) + 's' +
                ' elapsed=' + (progress.elapsedMs / 1000).toFixed(3) + 's' +
                ' bars/s=' + (progress.barsPerSecond === null ? '-' : progress.barsPerSecond.toFixed(1)));
        });
        return chain.then(function () {
            // TWO_BAR_PRODUCTION_REPLACEMENT_V1. Bootstrap is finished, so the
            // Two-Bar pipeline starts from the first live bar. The retired
            // EQ/WATCH/FVG step stream no longer exists in the live engine.
            twoBarSetup = createTwoBarSetupService();
            execution = createExecutionService();
            // Execution rules are fetched afresh from Futures exchangeInfo instead
            // of trusting the long-lived historical-loader cache.
            return binanceRest.getExchangeInfo(symbol).then(function (info) {
                executionSymbolRules = info;
                return refresh4hBias();
            });
        }).then(function () {
            // Warm the Two-Bar pipeline's Dynamic-D / ATR over the bootstrapped
            // window, then bring up the order lifecycle. execution.start() runs
            // restart recovery (exchange truth) BEFORE any new entry can be
            // detected, because ticks are still gated on historyLoaded below.
            var snapshot = engine.getWindowSnapshot();
            twoBarPipeline = createTwoBarPipeline();
            twoBarPipeline.warmupThrough(snapshot, snapshot.length - 1);
            return execution.start();
        }).then(function () {
            // Retry a pre-restart confirmation outbox only after deterministic
            // candle replay has restored the current Range lifecycle.
            if (rangeAlerts) persistence.saveJson(rangeStateFile, rangeAlerts.getDetector().getState());
            return Promise.all([
                execution.reconcile(),
                rangeAlerts ? rangeAlerts.flush() : Promise.resolve(null)
            ]);
        }).then(function () {
            lastCloseTime = all[all.length - 1].closeTime;
            lastOpenTime = all[all.length - 1].openTime;
            historyLoaded = true;
            persistence.saveJson(pushedFile, delivered);
            persistence.saveJson(stateFile, { lastCloseTime: lastCloseTime, bars: all.length,
                structureMode: mode, eqProductionModel: EQ_PRODUCTION_MODEL,
                displacementMode: DISPLACEMENT_PRODUCTION_MODE,
                productionEntryModel: PRODUCTION_ENTRY_MODEL });
            log(symbol + ' 状态就绪，已推进 ' + all.length + ' 根，去重集合 ' + Object.keys(delivered).length + ' 个已投递机会');
        });
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
                    // TWO_BAR_PRODUCTION_REPLACEMENT_V1: the only NEW ENTRY path.
                    // Lifecycle-only symbols (dropped out of Top5) never start a new
                    // setup, but their pending entries / positions keep being managed
                    // by breakoutExecutionV1's reconcile loop.
                    if (!scanAdmitted) return opp;
                    var snapshot = engine.getWindowSnapshot();
                    return twoBarPipeline.onClosedBar(snapshot, snapshot.length - 1)
                        .then(function () { return opp; });
                }).then(function (opp) {
                    if (!rangeAlerts || !scanAdmitted) return opp;
                    rangeAlerts.onCandle(c, {
                        notificationsEnabled: !!(CONFIG.rangeDetector && CONFIG.rangeDetector.notifyOnConfirm),
                        recordEvents: true
                    });
                    persistence.saveJson(rangeStateFile, rangeAlerts.getDetector().getState());
                    return rangeAlerts.flush().then(function () { return opp; });
                }).then(function (opp) {
                    if (scanAdmitted && opp && opp.tier === 'HIGH_QUALITY') {
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
                structureMode: structuralSwingMode(), eqProductionModel: EQ_PRODUCTION_MODEL,
                displacementMode: DISPLACEMENT_PRODUCTION_MODE,
            productionEntryModel: PRODUCTION_ENTRY_MODEL });
        });
    }

    /**
     * 11L.5（P0-1）：tick 并发锁 —— 互斥 + setTimeout 串行链双保险。
     * 上一轮 tick 未完成时的新一轮直接 skip（返回 resolved，不重入）；
     * 由 startLoop 的 setTimeout 链保证 tick 完成后才调度下一轮。
     */
    var tickRunning = false;
    var loopTimer = null;

    function refresh4hBias() {
        return current4hBias.refresh(Date.now()).catch(function (error) {
            log(symbol + ' 4H Bias refresh error: ' + (error && error.message || error) +
                '（不影响 EQ/FVG/WATCH/notification）');
            return null;
        });
    }

    function doTick() {
        // Update/refresh 4H before retrying pending notifications so delivery-time
        // context always reflects the latest fully closed native 4H known now.
        return dataSource.fetchHtfIncrement(symbol, runnerData.structureCandles, null, CONFIG.requireFutures, {
            evaluationTime: Date.now(), scheduler: htfBoundaryScheduler
        }).then(function (htf) {
            (htf.issues || []).forEach(function (iss) {
                if (iss.kind === 'DEGRADED') {
                    log(symbol + ' HTF DATA_SOURCE_DEGRADED: ' + iss.tf + ' 返回 ' + iss.source +
                        '（openTime=' + iss.openTime + '）——已拒绝 append，绝不污染 futures context');
                } else if (iss.kind === 'NETWORK_ERROR') {
                    log(symbol + ' HTF_NETWORK_ERROR: ' + iss.tf + ' ' + (iss.error || 'network') + '（保留旧 HTF snapshot，stale 状态）');
                }
            });
            if (!analysisReady && dataSource.analysisHistoryReady({
                '4h': runnerData.structureCandles['4h'],
                '5m': persistedCandles
            })) {
                analysisReady = true;
                log(symbol + ' ANALYSIS_HISTORY_READY: closed4h>=' + dataSource.MIN_ANALYSIS_4H_BARS);
            }
            return refresh4hBias().then(function () { return execution.reconcile(); }).then(function () {
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
            var gapDetected = lastOpenTime !== null && newCandles[0].openTime !== lastOpenTime + BAR_MS;
            if (gapDetected) {
                log(symbol + ' DATA_GAP: 期望 openTime=' + (lastOpenTime + BAR_MS) + ' 实际=' + newCandles[0].openTime + '（暂停推进，补历史...）');
                return dataSource.recover5mGap(symbol, lastOpenTime, lastCloseTime, newCandles).then(function (recovery) {
                    if (recovery.candles.length === 0) return;
                    log(symbol + ' 补历史 ' + recovery.backfilledBars + ' 根，等待 continuity 验证...');
                    return processCandles(recovery.candles); // 内部严格验证：不通过 → DATA_GAP_UNRESOLVED 不推进
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
        if (execution) execution.stop();
    }

    return {
        initFromHistory: initFromHistory,
        tick: tick,
        startLoop: startLoop,
        stopLoop: stopLoop,
        setScanAdmitted: function (value) { scanAdmitted = value === true; },
        isScanAdmitted: function () { return scanAdmitted; },
        hasActiveExecutionLifecycle: function () { return !!execution && execution.hasActiveLifecycle(); },
        isExecutionReady: function () { return !!execution && analysisReady &&
            dataSource.executionRulesReady(executionSymbolRules) && execution.isExecutionReady(); },
        // TWO_BAR_PRODUCTION_REPLACEMENT_V1 observability: the retired EQ/WATCH/FVG
        // snapshot is replaced by the breakout lifecycle snapshot and the Two-Bar
        // pipeline funnel.
        getBreakoutExecutionSnapshot: function () { return execution ? execution.getSnapshot() : null; },
        getTwoBarFunnel: function () { return twoBarPipeline ? twoBarPipeline.funnel() : null; },
        isExecutionHalted: function () { return execution ? execution.isHalted() : false; }
    };
}

// ---------- 主流程（DYNAMIC_CONTRACT_UNIVERSE_V1：每日冻结 Top10） ----------
function main() {
    if (CONFIG.symbolsMode === 'dynamic' &&
            !dynamicContractUniverseV1.configMatchesContract(CONFIG.dynamicUniverse)) {
        throw new Error('DYNAMIC_UNIVERSE_CONFIG_MISMATCH');
    }
    persistence.ensureDir(CONFIG.dataDir);
    log('=== Live Opportunity Radar 启动 ===');
    log('STRUCTURAL_SWING_MODE=' + structuralSwingMode() +
        '（Swing context source：confirmed 2L/2R pivots + Structural Provenance）');
    log('EQ_PRODUCTION_MODEL=' + EQ_PRODUCTION_MODEL +
        '（current ordinary 2/2 vs prior 36H active Causal Dynamic D anchors）');
    log('PRODUCTION_ENTRY_MODEL=' + PRODUCTION_ENTRY_MODEL +
        '（TOP5 5m Two-Bar -> pattern LLM + preceding-leg LLM -> Dynamic-D EQ -> breakout STOP_MARKET）');
    log('4H_BIAS_MODEL=' + fourHourBiasV3.VERSION +
        '（new fully closed native 4H -> deterministic Direction/Strength facts -> one semantic compression）');
    log('REAL_ORDER_EXECUTION_V1=' + (LIVE_TRADING_ENABLED ? 'LIVE' : 'SHADOW') +
        '（only literal LIVE_TRADING_ENABLED=true permits mutating Binance requests）');
    log('ACTIVE_UNIVERSE_TOP_N=' + CONFIG.dynamicUniverse.topN);
    log('ENTRY_TRIGGER_SOURCE=CONTRACT_PRICE（breakout STOP_MARKET）' +
        ' PROTECTION_TRIGGER_SOURCE=MARK_PRICE（SL/TP）');
    log('11L.15 Alert Prioritization: ' + (PRIORITIZATION_ENABLED
        ? 'ENABLED（钉钉只推 PRIORITY_HIGH = HIGH + 48 窗口内 Significant Liquidity；STANDARD_HIGH 只落日志）'
        : 'DISABLED（全部 HIGH 照常推钉钉，仅记录 notifyPriority 字段）'));
    log('symbolsMode=' + CONFIG.symbolsMode + ' pollMs=' + CONFIG.pollMs +
        ' production5mBars=' + dataSource.MIN_ANALYSIS_5M_BARS +
        ' production4hBars=' + dataSource.MIN_ANALYSIS_4H_BARS);
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

    var runners = {}; // sym -> { runner }
    var startingSymbols = {}; // guards queued bootstrap before runners[sym] exists
    var startSequence = Promise.resolve(); // 串行启动（避免并发拉历史压代理）
    var scanUniverse = {};
    var universeTimer = null;
    var universeSequence = Promise.resolve();
    var productionBootstrap = dataSource.createProductionBootstrapService();
    var universeFile = path.join(CONFIG.dataDir, 'dynamic-contract-universe-v1.json');
    var universe = dynamicContractUniverseV1.createService({
        snapshotFile: universeFile,
        concurrency: CONFIG.dynamicUniverse && CONFIG.dynamicUniverse.concurrency,
        requestIntervalMs: CONFIG.dynamicUniverse && CONFIG.dynamicUniverse.requestIntervalMs,
        retryIntervalMs: CONFIG.dynamicUniverse && CONFIG.dynamicUniverse.retryIntervalMs
    });

    function startSymbol(sym) {
        if (runners[sym] || startingSymbols[sym]) return startSequence;
        startingSymbols[sym] = true;
        startSequence = startSequence.then(function () {
            log(sym + ' 加入监控：拉取初始历史（可能命中本地缓存）...');
            return productionBootstrap.prepare(sym, Date.now()).then(function (data) {
                var r = createRunner(sym, { scanAdmitted: !!scanUniverse[sym] });
                // Fix 1（11L.3 P0）：initFromHistory 内部 purity fail-closed（throw）——
                // 必须初始化成功后才启动轮询循环，失败不留半启动状态
                return r.initFromHistory(data).then(function () {
                    r.startLoop(); // 11L.5：setTimeout 串行链（tick 完成后再调度下一轮，无重入）
                    runners[sym] = { runner: r };
                    r.setScanAdmitted(!!scanUniverse[sym]);
                    r.tick(); // 立即先跑一轮
                    log(sym + ' 监控就绪 SCAN_ADMITTED=' + r.isScanAdmitted() +
                        ' EXECUTION_READY=' + r.isExecutionReady());
                });
            });
        }).catch(function (e) {
            productionBootstrap.forget(sym);
            log(sym + ' 启动失败: ' + (e && e.message || e) + '（跳过，下轮刷新重试）');
        }).then(function () {
            delete startingSymbols[sym];
        });
        return startSequence;
    }

    function stopSymbol(sym) {
        if (!runners[sym]) return;
        runners[sym].runner.stopLoop(); // 11L.5：清掉 setTimeout 链
        delete runners[sym];
        productionBootstrap.forget(sym);
        log(sym + ' 移出 runtime（无 active execution lifecycle；状态文件保留）');
    }

    function activeLifecycleSymbols() {
        var active = dynamicContractUniverseV1.discoverActiveLifecycleSymbols(CONFIG.dataDir);
        Object.keys(runners).forEach(function (symbol) {
            if (runners[symbol].runner.hasActiveExecutionLifecycle() && active.indexOf(symbol) === -1) active.push(symbol);
        });
        return active.sort();
    }

    function ensureRuntimeSymbols(list) {
        var nextScan = {};
        (list || []).forEach(function (symbol) { nextScan[symbol] = true; });
        scanUniverse = nextScan;
        Object.keys(runners).forEach(function (symbol) {
            runners[symbol].runner.setScanAdmitted(!!scanUniverse[symbol]);
        });
        var runtime = dynamicContractUniverseV1.runtimeSymbols(Object.keys(scanUniverse), activeLifecycleSymbols());
        var want = {}; runtime.forEach(function (symbol) { want[symbol] = true; });
        Object.keys(runners).forEach(function (symbol) {
            if (!want[symbol]) stopSymbol(symbol);
        });
        runtime.forEach(function (symbol) { if (!runners[symbol]) startSymbol(symbol); });
        return startSequence;
    }

    function logUniverseSnapshot(snapshot, status) {
        log('UNIVERSE_REFRESH=PASS VERSION=' + snapshot.version + ' TOP_N=' + snapshot.topN +
            ' WINDOW=6x4H_CLOSED GENERATED_AT=' + new Date(snapshot.generatedAt).toISOString() +
            ' STATUS=' + status);
        snapshot.symbols.forEach(function (row) {
            log('UNIVERSE_RANK ' + row.rank + ' ' + row.symbol + ' quoteVolume24h=' + row.quoteVolume24h);
        });
    }

    function applyUniverseResult(result) {
        if (result.status === 'REFRESH_FAILED') {
            log('UNIVERSE_REFRESH=FAIL reason=' + (result.error && result.error.message || 'unknown') +
                (result.ready ? '（保留 previous valid universe）' : ' UNIVERSE_NOT_READY（禁止新 live trade）'));
        }
        if (result.snapshot) {
            if (result.status === 'REFRESHED' || result.status === 'RESTORED') logUniverseSnapshot(result.snapshot, result.status);
            return ensureRuntimeSymbols(dynamicContractUniverseV1.snapshotSymbols(result.snapshot));
        }
        return ensureRuntimeSymbols([]);
    }

    function maintainUniverse() {
        universeSequence = universeSequence.then(function () {
            return universe.refreshIfDue(Date.now()).then(function (result) {
                if (result.status === 'REFRESHED' || result.status === 'REFRESH_FAILED') return applyUniverseResult(result);
                // A symbol retained only for execution management is evicted as
                // soon as its persisted/runtime lifecycle becomes terminal-clean.
                return ensureRuntimeSymbols(dynamicContractUniverseV1.snapshotSymbols(result.snapshot));
            });
        }).catch(function (error) {
            log('UNIVERSE_MAINTENANCE_ERROR ' + (error && error.message || error));
        });
        return universeSequence;
    }

    if (CONFIG.symbolsMode === 'dynamic') {
        universe.initialize(Date.now()).then(applyUniverseResult).then(function () {
            log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
            log('=== 每日 00:05 UTC 自动刷新 Dynamic Top10（6x4H closed quoteAssetVolume） ===');
            universeTimer = setInterval(maintainUniverse,
                CONFIG.dynamicUniverse && CONFIG.dynamicUniverse.refreshCheckIntervalMs || 60000);
        });
    } else if (CONFIG.symbolsMode === 'fixed') {
        // Compatibility-only local mode. Production config uses dynamic V1.
        ensureRuntimeSymbols(CONFIG.symbols || []).then(function () {
            log('=== 全部 symbol 就绪，开始轮询（Ctrl+C 停止） ===');
        });
    } else {
        throw new Error('未知 symbolsMode=' + CONFIG.symbolsMode + '（可选 dynamic / fixed）');
    }
}

if (require.main === module) main();

module.exports = {
    buildMessage: buildMessage,
    rangeEnabledFor: rangeEnabledFor,
    yieldToEventLoop: yieldToEventLoop,
    replayBootstrapBars: replayBootstrapBars,
    retainLatestCandles: retainLatestCandles,
    prepareBootstrapCandles: prepareBootstrapCandles,
    createRunner: createRunner,
    main: main
};
