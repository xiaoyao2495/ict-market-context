/**
 * Daily Bias deterministic context V1 DeepSeek 4H Bias 审计
 *
 * 目的：
 *   在 evaluationTime 之前逐 bar 构建冻结的 deterministic context，
 *   交由 DeepSeek 解释 ICT Narrative 并给出 4H Bias。
 *   不调用 5m replayEngine，不混入任何 5m 信息，不新增生产级 4H 检测器。
 *
 * 不修改任何生产逻辑（Opportunity / Alert / DingTalk / Scenario / engine）。
 *
 * 输出：outputs/deepseek-4h-bias/<run-id>/ { manifest.json, case_01..10.json, review.md }
 */

var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var deepseekClient = require('../ai/deepseekClient');
var ictBiasPrompt = require('../ai/ictBiasPrompt');
var biasValidator = require('../ai/biasResponseValidator');
var auditPivots = require('../ai/auditPivots');
var auditMarketFacts = require('../ai/auditMarketFacts');
var auditStructuralProvenance = require('../ai/auditStructuralProvenance');

var SYMBOL = 'BTCUSDT';
var INTERVAL = '4h';
var INTERVAL_MS = 14400000; // 4h
var WINDOW = 120;            // 前置 120 根
var LOOKBACK_DAYS = 180;
var SAMPLE_COUNT = parseInt(process.env.DEEPSEEK_SAMPLE_COUNT, 10) || 2; // 默认一次抽 2 个时间，串行
var MIN_GAP_BARS = 24;       // 两点间隔 >= 24 根 4H = 4 天
var SEED = 20260822;
var DATA_YEAR = process.env.DEEPSEEK_DATA_YEAR
    ? parseInt(process.env.DEEPSEEK_DATA_YEAR, 10) : null;
var DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION = {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
    source: 'https://api-docs.deepseek.com/quick_start/pricing/'
};

// 设 DEEPSEEK_CASE_IDXS="381,663" → 直接重跑这些固定索引（与已审 case 对齐）
// 不设 → 走原采样逻辑（固定 seed 或随机模式）。
var PIVOT_LEFT = 2;
var PIVOT_RIGHT = 2;
function parseCaseIdxs() {
    var raw = process.env.DEEPSEEK_CASE_IDXS;
    if (!raw) return null;
    var arr = raw.split(',').map(function (s) { return parseInt(s.trim(), 10); })
        .filter(function (n) { return isFinite(n) && n >= 0; });
    return arr.length ? arr : null;
}

var DAY_MS = 86400000;

// 随机模式：DEEPSEEK_RANDOM=1 时每次运行用当前时间戳作种子 → 抽到不同时间点。
// 不设该变量 → 使用固定 SEED（确定性、可复现）。
function getSeed() {
    if (process.env.DEEPSEEK_RANDOM === '1') {
        return Date.now() >>> 0;
    }
    return SEED;
}

// ---------- 确定性随机数（mulberry32，固定 seed 可复现） ----------
function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 从已收盘 4H 蜡烛中确定性抽取 evaluationTime 索引。
 * 约束：
 *  - idx 必须在 [WINDOW, len-1]（前面至少 120 根）
 *  - 任意两点间隔 >= MIN_GAP_BARS
 *  - 尽量分布（按 seed 随机但不挤同一周）
 * @returns {Array<number>} 升序 candle 索引
 */
function selectEvaluationTimes(candles, opts) {
    var o = opts || {};
    var seed = o.seed != null ? o.seed : SEED;
    var count = o.count != null ? o.count : SAMPLE_COUNT;
    var minGap = o.minGap != null ? o.minGap : MIN_GAP_BARS;
    var window = o.window != null ? o.window : WINDOW;

    var n = candles.length;
    var minIdx = Math.max(window, o.minIndex != null ? o.minIndex : window);
    var maxIdx = Math.min(n - 1, o.maxIndex != null ? o.maxIndex : n - 1);
    if (maxIdx < minIdx) {
        throw new Error('蜡烛数量不足：需要至少 ' + (window + 1) + ' 根，实际 ' + n);
    }

    var rng = mulberry32(seed);
    var chosen = [];
    var guard = 0;
    var maxGuard = count * 5000;
    while (chosen.length < count && guard < maxGuard) {
        guard++;
        var cand = minIdx + Math.floor(rng() * (maxIdx - minIdx + 1));
        var ok = true;
        for (var i = 0; i < chosen.length; i++) {
            if (Math.abs(cand - chosen[i]) < minGap) { ok = false; break; }
        }
        if (ok) chosen.push(cand);
    }
    if (chosen.length < count) {
        throw new Error('无法在约束下抽到 ' + count + ' 个点（guard 耗尽），请放宽 minGap 或增加数据');
    }
    chosen.sort(function (a, b) { return a - b; });
    return chosen;
}

function findAuditStartIndex(candles, lookbackDays) {
    if (!candles.length) return 0;
    var cutoff = candles[candles.length - 1].closeTime - lookbackDays * DAY_MS;
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].closeTime >= cutoff) return i;
    }
    return 0;
}

function findTimeRangeIndices(candles, startTime, endTimeExclusive) {
    var startIdx = -1;
    var endIdx = -1;
    for (var i = 0; i < candles.length; i++) {
        if (startIdx < 0 && candles[i].closeTime >= startTime) startIdx = i;
        if (candles[i].closeTime < endTimeExclusive) endIdx = i;
    }
    if (startIdx < 0 || endIdx < startIdx) {
        throw new Error('数据集中没有请求时间范围内的 closed candles');
    }
    return { startIndex: startIdx, endIndex: endIdx };
}

// 不依赖环境的日期格式（UTC），用于 run-id
function utcStamp(d) {
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '_' +
        p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

function buildCandleSlice(candles, evalIdx) {
    // [evalIdx-119, evalIdx] 共 120 根
    var start = evalIdx - (WINDOW - 1);
    if (start < 0) start = 0;
    return candles.slice(start, evalIdx + 1);
}

function buildStructuralSnapshotIndex(candles, evalIdxs) {
    var wanted = {};
    (evalIdxs || []).forEach(function (idx) { wanted[idx] = true; });
    var maxIdx = Math.max.apply(null, evalIdxs || []);
    var out = {};
    var previousSnapshot = null;
    for (var idx = 0; idx <= maxIdx; idx++) {
        var pivots = auditPivots.detectPivots(candles, idx, {
            left: PIVOT_LEFT, right: PIVOT_RIGHT, window: WINDOW
        });
        var facts = auditMarketFacts.computeMarketFacts(candles, idx, pivots, {
            deliveryHintEnabled: true
        });
        var structural = auditStructuralProvenance.computeStructuralProvenance(
            candles, idx, pivots, { breaks: facts.breaks, previousSnapshot: previousSnapshot }
        );
        previousSnapshot = structural;
        if (wanted[idx]) out[idx] = { pivots: pivots, facts: facts, structural: structural };
    }
    return out;
}

// 方案 2：优先读本地落盘 4H（离线复跑），缺失时经 loader（可走代理）抓取并落盘。
// 不同年份使用独立落盘，避免覆盖当前 180d 数据集。
var KLINES_FILE = process.env.DEEPSEEK_KLINES_FILE || path.join(
    'outputs', 'deepseek-4h-bias', DATA_YEAR
        ? 'klines_4h_' + DATA_YEAR + '_futures.json'
        : 'klines_4h.json');

function load4hCandles() {
    // 1) 优先本地落盘
    if (fs.existsSync(KLINES_FILE)) {
        try {
            var cached = JSON.parse(fs.readFileSync(KLINES_FILE, 'utf8'));
            if (cached && Array.isArray(cached.candles) && cached.candles.length) {
                console.log('[klines] 读本地落盘 ' + KLINES_FILE + ' (' + cached.candles.length +
                    ' 根, source=' + (cached.source || '?') + ')');
                return Promise.resolve({ candles: cached.candles, source: cached.source || 'local' });
            }
        } catch (e) {
            console.log('[klines] 本地文件损坏，重新抓取：' + e.message);
        }
    }
    // 2) 缺失 → 经 historicalLoader 抓取（需 ICT_PROXY_ENABLED=1 本机走 7890 代理）
    var startTime = DATA_YEAR ? Date.UTC(DATA_YEAR, 0, 1) : Date.now() - LOOKBACK_DAYS * DAY_MS;
    var endTime = DATA_YEAR ? Date.UTC(DATA_YEAR + 1, 0, 1) - 1 : Date.now();
    console.log('[klines] 本地无落盘，抓取 BTCUSDT 4H（' +
        (DATA_YEAR ? DATA_YEAR + ' 全年 + ' + WINDOW + ' bars warmup' : LOOKBACK_DAYS + 'd') + '）...');
    return historicalLoader.loadInterval(SYMBOL, INTERVAL, startTime, endTime, {
        warmupBars: WINDOW
    }).then(function (candles) {
        var closed = candles.filter(function (c) { return c.closed; })
            .sort(function (a, b) { return a.openTime - b.openTime; });
        // 落盘（带 source 标记，满足数据源纯洁可追溯）
        var payload = {
            symbol: SYMBOL,
            interval: INTERVAL,
            source: (closed[0] && closed[0].source) || 'futures',
            fetchedAt: new Date().toISOString(),
            dataYear: DATA_YEAR,
            requestedStartTime: startTime,
            requestedEndTime: endTime,
            candles: closed
        };
        try {
            if (!fs.existsSync(path.dirname(KLINES_FILE))) {
                fs.mkdirSync(path.dirname(KLINES_FILE), { recursive: true });
            }
            fs.writeFileSync(KLINES_FILE, JSON.stringify(payload));
            console.log('[klines] 已落盘 ' + closed.length + ' 根 → ' + KLINES_FILE);
        } catch (e) {
            console.log('[klines] 落盘失败（不影响本次运行）：' + e.message);
        }
        return { candles: closed, source: payload.source };
    });
}

function run() {
    console.log('加载 BTCUSDT 4H 历史（' + (DATA_YEAR ? DATA_YEAR + ' 全年' : LOOKBACK_DAYS + 'd') + '）...');
    return load4hCandles().then(function (loaded) {
        var closed = loaded.candles;
        var klinesSource = loaded.source;
        console.log('已收盘 4H 蜡烛数=' + closed.length + ' (source=' + klinesSource + ')');

        var seed = getSeed();
        var auditRange = DATA_YEAR
            ? findTimeRangeIndices(closed, Date.UTC(DATA_YEAR, 0, 1), Date.UTC(DATA_YEAR + 1, 0, 1))
            : { startIndex: findAuditStartIndex(closed, LOOKBACK_DAYS), endIndex: closed.length - 1 };
        var auditStartIdx = auditRange.startIndex;
        var auditEndIdx = auditRange.endIndex;
        var fixedIdxs = parseCaseIdxs();
        var evalIdxs;
        if (fixedIdxs) {
            evalIdxs = fixedIdxs;
            evalIdxs.forEach(function (idx) {
                if (idx < auditStartIdx || idx > auditEndIdx) {
                    throw new Error('固定 case 索引 ' + idx + ' 不在当前 audit 时间范围内');
                }
            });
            console.log('固定 case 索引（DEEPSEEK_CASE_IDXS）=' + JSON.stringify(evalIdxs));
        } else {
            evalIdxs = selectEvaluationTimes(closed, {
                seed: seed,
                count: SAMPLE_COUNT,
                minIndex: auditStartIdx,
                maxIndex: auditEndIdx
            });
            console.log('抽取 evaluationTime 索引=' + JSON.stringify(evalIdxs) +
                (process.env.DEEPSEEK_RANDOM === '1' ? ' (随机模式)' : ' (固定 seed=' + seed + ')'));
        }

        console.log('DETERMINISTIC_CONTEXT=DAILY_BIAS_DETERMINISTIC_CONTEXT_V1' +
            ' (confirmedSwings + marketFacts + Structural Provenance V1.1)');
        if (!fixedIdxs) {
            console.log('采样数=' + evalIdxs.length + (process.env.DEEPSEEK_RANDOM === '1'
                ? ' （随机模式：每个 case 串行独立跑完）' : ' （固定 seed=' + seed + '）'));
        }

        var runId = 'daily_bias_v1' + (DATA_YEAR ? '_y' + DATA_YEAR : '') + '_' +
            utcStamp(new Date()) + '_seed' + seed;
        var outDir = path.join('outputs', 'deepseek-4h-bias', runId);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        // manifest 先落盘（防 cherry-pick）
        var manifest = {
            symbol: SYMBOL,
            interval: INTERVAL,
            dataYear: DATA_YEAR,
            klinesFile: KLINES_FILE,
            seed: seed,
            randomMode: process.env.DEEPSEEK_RANDOM === '1',
            fixedCaseIdxs: fixedIdxs || null,
            pivotParams: { left: PIVOT_LEFT, right: PIVOT_RIGHT, window: WINDOW },
            marketFacts: {
                enabled: true,
                deliveryHintMode: 'time-local-inferred',
                note: 'Frozen deterministic context; Structural Provenance V1.1 is authoritative'
            },
            sampleCount: SAMPLE_COUNT,
            minGapBars: MIN_GAP_BARS,
            window: WINDOW,
            lookbackDays: LOOKBACK_DAYS,
            auditStartIndex: auditStartIdx,
            auditStartTime: closed[auditStartIdx].closeTime,
            auditStartTimeIso: new Date(closed[auditStartIdx].closeTime).toISOString(),
            auditEndIndex: auditEndIdx,
            auditEndTime: closed[auditEndIdx].closeTime,
            auditEndTimeIso: new Date(closed[auditEndIdx].closeTime).toISOString(),
            klinesSource: klinesSource,
            generatedAt: new Date().toISOString(),
            deterministicContext: {
                version: 'DAILY_BIAS_DETERMINISTIC_CONTEXT_V1',
                featureFreeze: true,
                structuralProvenance: 'V1.1',
                statePersistence: 'PREVIOUS_SNAPSHOT_CARRY_FORWARD',
                drawTargetPolicy: 'INTACT_OR_NONE'
            },
            apiRequestPolicy: 'EXACTLY_ONE_PER_CASE_NO_RETRY',
            model: {
                provider: 'deepseek',
                baseUrl: deepseekClient.getBaseUrl(),
                model: deepseekClient.getModel(),
                temperature: deepseekClient.getTemperature(),
                completionTokenLimit: deepseekClient.getAuditCompletionTokenLimit(),
                pricingUsdPerMillionTokens: DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION
            },
            evaluationTimes: evalIdxs.map(function (idx) {
                var c = closed[idx];
                return {
                    index: idx,
                    evaluationTime: c.closeTime,
                    iso: new Date(c.closeTime).toISOString(),
                    candleOpenTime: c.openTime,
                    candleCloseTime: c.closeTime
                };
            })
        };
        fs.writeFileSync(path.join(outDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2));

        // Deterministic facts 必须逐 bar replay，保证 protected/state/ancestry
        // 不因 120-bar pivot 输入窗口滚动而丢失。
        var structuralSnapshots = buildStructuralSnapshotIndex(closed, evalIdxs);

        // 逐 case 串行调用（避免并发触发 DeepSeek 空 200 / 限流；
        // 单 case 失败不中止，且 deepseekClient 内部对空 200 已重试）
        var results = [];
        var chain = Promise.resolve();
        evalIdxs.forEach(function (idx, i) {
            chain = chain.then(function () {
                return processCase(closed, idx, i + 1, outDir,
                    structuralSnapshots[idx]).then(function (rec) {
                    results.push(rec);
                });
            });
        });

        return chain.then(function () {
            var compactRecords = results.map(buildCompactRecord);
            var summary = buildSummary(results, manifest);
            var reviewMd = buildReview(results, manifest, klinesSource);
            fs.writeFileSync(path.join(outDir, 'review.md'), reviewMd);
            fs.writeFileSync(path.join(outDir, 'compact_records.json'),
                JSON.stringify(compactRecords, null, 2));
            fs.writeFileSync(path.join(outDir, 'summary.json'),
                JSON.stringify(summary, null, 2));
            console.log('完成。输出目录：' + outDir);
            console.log('review.md / compact_records.json / summary.json 已生成。');
            return { outDir: outDir, results: results, summary: summary };
        });
    });
}

function processCase(candles, evalIdx, caseNo, outDir, precomputedStructural) {
    var evalCandle = candles[evalIdx];
    var evaluationTime = evalCandle.closeTime;
    var slice = buildCandleSlice(candles, evalIdx);

    var pv = precomputedStructural ? precomputedStructural.pivots :
        auditPivots.detectPivots(candles, evalIdx, {
            left: PIVOT_LEFT, right: PIVOT_RIGHT, window: WINDOW
        });
    var confirmedSwings = { highs: pv.highs, lows: pv.lows };

    // 每个 break 使用其所属 candle 收盘时可见的 time-local delivery hint。
    var mf = precomputedStructural ? precomputedStructural.facts :
        auditMarketFacts.computeMarketFacts(candles, evalIdx, pv, {
            deliveryHintEnabled: true
        });
    var structural = precomputedStructural ? precomputedStructural.structural :
        auditStructuralProvenance.computeStructuralProvenance(
            candles, evalIdx, pv, { breaks: mf.breaks }
        );
    var marketFacts = {
        sweeps: mf.sweeps,
        breaks: mf.breaks,
        protectedSwings: structural.protectedSwings,
        pendingProvenances: structural.pendingProvenances,
        penetrations: structural.penetrations,
        structuralEvents: structural.structuralEvents,
        structuralState: structural.structuralState,
        futureLeakViolations: structural.futureLeakViolations
    };

    var userPrompt = ictBiasPrompt.buildUserPrompt({
        symbol: SYMBOL,
        evaluationTime: evaluationTime,
        candles: slice,
        confirmedSwings: confirmedSwings,
        marketFacts: marketFacts
    });
    var allowedDrawTargets = ictBiasPrompt.buildAllowedDrawTargets(
        marketFacts, evaluationTime);

    var caseId = (caseNo < 10 ? '0' : '') + caseNo;
    var caseFile = path.join(outDir, 'case_' + caseId + '.json');

    return deepseekClient.chat({
        systemPrompt: ictBiasPrompt.SYSTEM_PROMPT,
        userPrompt: userPrompt,
        temperature: 0
    }, { maxAttempts: 0 }).then(function (resp) {
        // 请求完成：打印模型与 token 用量
        console.log(JSON.stringify({
            model: resp.raw.model,
            usage: resp.raw.usage
        }, null, 2));

        var evaluated = evaluateAuditResponse(resp, marketFacts);
        var parsed = evaluated.parsedResponse;
        var validationError = evaluated.validationError;
        var finishReason = evaluated.finishReason;
        var caseStatus = evaluated.caseStatus;
        var contradictions = biasValidator.structuralFactContradictions(parsed, marketFacts);
        var rec = {
            caseId: caseNo,
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            evaluationTimeIso: new Date(evaluationTime).toISOString(),
            seed: SEED,
            input: {
                timeframe: INTERVAL,
                candleCount: slice.length,
                candles: slice,
                confirmedSwings: confirmedSwings,
                marketFacts: marketFacts,
                allowedDrawTargets: allowedDrawTargets,
                systemPrompt: ictBiasPrompt.SYSTEM_PROMPT,
                userPrompt: userPrompt
            },
            model: {
                provider: 'deepseek',
                model: deepseekClient.getModel(),
                temperature: 0,
                baseUrl: deepseekClient.getBaseUrl()
            },
            rawResponse: resp.raw,
            rawText: resp.text,
            rawResponseText: resp.rawText,
            parsedResponse: parsed,
            apiUsage: resp.raw.usage || null,
            apiRequestCount: 1,
            finishReason: finishReason,
            completionTokenLimit: resp.completionTokenLimit,
            completionTokens: (resp.raw.usage || {}).completion_tokens || null,
            validation: {
                valid: !validationError,
                status: caseStatus,
                error: validationError
            },
            structuralFactContradictions: contradictions,
            caseStatus: caseStatus,
            parseError: validationError
        };
        fs.writeFileSync(caseFile, JSON.stringify(rec, null, 2));
        console.log('case_' + caseId + ' 完成 bias=' +
            (parsed ? parsed.bias : ('PARSE_ERR:' + (validationError && validationError.code))) +
            ' status=' + rec.caseStatus);
        return rec;
    }).catch(function (err) {
        var rec = {
            caseId: caseNo,
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            evaluationTimeIso: new Date(evaluationTime).toISOString(),
            seed: SEED,
            input: {
                timeframe: INTERVAL,
                candleCount: slice.length,
                candles: slice,
                confirmedSwings: confirmedSwings,
                marketFacts: marketFacts,
                allowedDrawTargets: allowedDrawTargets,
                systemPrompt: ictBiasPrompt.SYSTEM_PROMPT,
                userPrompt: userPrompt
            },
            model: {
                provider: 'deepseek',
                model: deepseekClient.getModel(),
                temperature: 0,
                baseUrl: deepseekClient.getBaseUrl()
            },
            rawResponse: null,
            rawText: null,
            rawResponseText: err.rawText || null,
            parsedResponse: null,
            apiUsage: null,
            apiRequestCount: 1,
            finishReason: null,
            completionTokenLimit: deepseekClient.getAuditCompletionTokenLimit(),
            completionTokens: null,
            validation: { valid: false, status: 'NOT_RUN', error: null },
            structuralFactContradictions: [],
            caseStatus: 'API_ERROR',
            apiError: { code: err.code, message: err.message, status: err.status }
        };
        fs.writeFileSync(caseFile, JSON.stringify(rec, null, 2));
        console.log('case_' + caseId + ' 失败：' + err.message);
        return rec;
    });
}

function evaluateAuditResponse(resp, marketFacts) {
    var parsed = null;
    var parseError = null;
    var finishReason = resp && resp.raw && resp.raw.choices && resp.raw.choices[0] &&
        resp.raw.choices[0].finish_reason || null;
    try {
        parsed = JSON.parse(resp.text);
    } catch (e) {
        parseError = e;
    }
    if (finishReason === 'length') {
        return {
            parsedResponse: parsed,
            finishReason: finishReason,
            caseStatus: 'OUTPUT_TRUNCATED',
            validationError: {
                code: 'OUTPUT_TRUNCATED',
                message: 'DeepSeek output reached the completion token limit before completion'
            }
        };
    }
    if (parseError) {
        return {
            parsedResponse: null,
            finishReason: finishReason,
            caseStatus: 'CASE_SCHEMA_INVALID',
            validationError: {
                code: 'MALFORMED_JSON',
                message: 'JSON 解析失败：' + parseError.message
            }
        };
    }
    var validationError = null;
    try {
        // 使用冻结 validator；失败保留 parsed/raw，不重新请求。
        biasValidator.validate(parsed, {
            marketFacts: marketFacts
        });
    } catch (e) {
        validationError = { code: e.code, message: e.message };
    }
    return {
        parsedResponse: parsed,
        finishReason: finishReason,
        caseStatus: validationError ? 'CASE_SCHEMA_INVALID' : 'SCHEMA_VALID',
        validationError: validationError
    };
}

function latestByConfirmedAt(events, types) {
    return (events || []).filter(function (e) {
        return types.indexOf(e.type) >= 0;
    }).sort(function (a, b) {
        return Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt);
    })[0] || null;
}

function compactProtected(swing) {
    if (!swing) return null;
    return {
        price: swing.price,
        occurredAt: swing.occurredAt,
        protectedConfirmedAt: swing.protectedConfirmedAt,
        status: swing.status,
        role: swing.role
    };
}

function compactEvent(event) {
    if (!event) return null;
    return {
        type: event.type,
        direction: event.direction,
        referenceLevel: event.referenceLevel,
        referenceRole: event.referenceRole,
        eventTime: event.eventTime,
        confirmedAt: event.confirmedAt,
        structuralStateBefore: event.structuralStateBefore,
        structuralStateAfter: event.structuralStateAfter,
        stateChanged: event.stateChanged
    };
}

function buildCompactRecord(rec) {
    var p = rec.parsedResponse || {};
    var facts = (rec.input && rec.input.marketFacts) || {};
    var events = facts.structuralEvents || [];
    var protectedSwings = facts.protectedSwings || [];
    var activeHigh = protectedSwings.filter(function (s) {
        return s.side === 'HIGH' && s.status === 'ACTIVE_PROTECTED';
    }).slice(-1)[0];
    var activeLow = protectedSwings.filter(function (s) {
        return s.side === 'LOW' && s.status === 'ACTIVE_PROTECTED';
    }).slice(-1)[0];
    function raids(side) {
        return (facts.sweeps || []).filter(function (s) {
            return s.refSide === side && s.status === 'TAKEN';
        }).sort(function (a, b) {
            return Date.parse(b.takenAt) - Date.parse(a.takenAt);
        }).slice(0, 3).map(function (s) {
            return { price: s.pivotPrice, takenAt: s.takenAt, closedBeyond: s.closedBeyond };
        });
    }
    return {
        caseId: rec.caseId,
        evaluationTime: rec.evaluationTimeIso,
        caseStatus: rec.caseStatus,
        finalBias: p.bias || null,
        confidence: p.confidence || null,
        currentStructuralState: facts.structuralState || 'UNKNOWN',
        latestStructuralMss: compactEvent(latestByConfirmedAt(events, ['STRUCTURAL_MSS'])),
        latestStructuralContinuation: compactEvent(latestByConfirmedAt(events,
            ['STRUCTURAL_CONTINUATION', 'CONTINUATION'])),
        activeProtectedHigh: compactProtected(activeHigh),
        activeProtectedLow: compactProtected(activeLow),
        recentBslRaids: raids('HIGH'),
        recentSslRaids: raids('LOW'),
        currentDelivery: p.delivery && p.delivery.currentDelivery || null,
        draw: p.drawOnLiquidity ? {
            direction: p.drawOnLiquidity.direction,
            targetPrice: p.drawOnLiquidity.targetPrice == null ? null : p.drawOnLiquidity.targetPrice
        } : null,
        biasReason: p.biasReason || null,
        conflicts: p.conflicts || [],
        structuralFactContradictions: rec.structuralFactContradictions || [],
        validationError: rec.validation && rec.validation.error
    };
}

function buildSummary(results, manifest) {
    var bias = { BULLISH: 0, BEARISH: 0, UNCLEAR: 0 };
    var confidence = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    var usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0,
        promptCacheHitTokens: 0, promptCacheMissTokens: 0 };
    var valid = 0;
    var invalid = 0;
    var outputTruncated = 0;
    var apiErrors = 0;
    var drawFailures = 0;
    var contradictionCases = 0;
    var contradictionCount = 0;
    results.forEach(function (r) {
        var p = r.parsedResponse;
        if (p && bias[p.bias] != null) bias[p.bias]++;
        if (p && confidence[p.confidence] != null) confidence[p.confidence]++;
        if (r.caseStatus === 'SCHEMA_VALID') valid++;
        else if (r.caseStatus === 'CASE_SCHEMA_INVALID') invalid++;
        else if (r.caseStatus === 'OUTPUT_TRUNCATED') { invalid++; outputTruncated++; }
        else apiErrors++;
        var msg = r.validation && r.validation.error && r.validation.error.message || '';
        if (msg.indexOf('drawOnLiquidity.targetPrice') >= 0) drawFailures++;
        var contradictions = r.structuralFactContradictions || [];
        if (contradictions.length) contradictionCases++;
        contradictionCount += contradictions.length;
        var u = r.apiUsage || {};
        usage.promptTokens += u.prompt_tokens || 0;
        usage.completionTokens += u.completion_tokens || 0;
        usage.totalTokens += u.total_tokens || 0;
        usage.promptCacheHitTokens += u.prompt_cache_hit_tokens || 0;
        usage.promptCacheMissTokens += u.prompt_cache_miss_tokens || 0;
    });
    var pricedHit = usage.promptCacheHitTokens;
    var pricedMiss = usage.promptCacheMissTokens;
    if (!pricedHit && !pricedMiss) pricedMiss = usage.promptTokens;
    var estimatedCost = pricedHit / 1000000 * DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION.inputCacheHit +
        pricedMiss / 1000000 * DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION.inputCacheMiss +
        usage.completionTokens / 1000000 * DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION.output;
    return {
        audit: 'FINAL_' + results.length + '_CASE_DEEPSEEK_AI_AUDIT',
        deterministicContext: manifest.deterministicContext,
        seed: manifest.seed,
        sampleCount: results.length,
        biasCounts: bias,
        confidenceCounts: confidence,
        schemaValid: valid,
        schemaInvalid: invalid,
        outputTruncated: outputTruncated,
        apiErrors: apiErrors,
        drawValidationFailures: drawFailures,
        structuralFactContradictions: {
            cases: contradictionCases,
            total: contradictionCount
        },
        apiRequests: results.reduce(function (n, r) { return n + (r.apiRequestCount || 0); }, 0),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        promptCacheHitTokens: usage.promptCacheHitTokens,
        promptCacheMissTokens: usage.promptCacheMissTokens,
        totalEstimatedCostUsd: Number(estimatedCost.toFixed(8)),
        pricingUsdPerMillionTokens: DEEPSEEK_V4_FLASH_PRICING_USD_PER_MILLION
    };
}

// review.md：每个 case 给 8 项分项复核表
function buildReview(results, manifest, klinesSource) {
    var L = [];
    L.push('# DeepSeek 4H Bias 审计 — 人工复核');
    L.push('');
    L.push('Symbol: ' + manifest.symbol + '  Interval: ' + manifest.interval);
    L.push('Seed: ' + manifest.seed + '  Sample: ' + manifest.sampleCount +
        '  MinGap: ' + manifest.minGapBars + ' bars  Window: ' + manifest.window);
    L.push('Model: ' + manifest.model.provider + ' / ' + manifest.model.model +
        '  temperature=' + manifest.model.temperature);
    L.push('Klines Source: ' + (klinesSource || manifest.klinesSource || 'unknown'));
    L.push('Generated: ' + manifest.generatedAt);
    L.push('');
    L.push('## 复核原则');
    L.push('- 第一阶段：只判断 DeepSeek 的 ICT Narrative 是否合理，**不看未来 Outcome**。');
    L.push('- 每项分别勾选，避免"方向碰巧猜中但理由全错"被误判通过。');
    L.push('');
    L.push('| Case | Eval Time (UTC) | Bias | Conf | Swing | Liq | Sweep | MSS | Disp | D-Range | Draw | Final |');
    L.push('|------|-----------------|------|------|-------|-----|-------|-----|------|---------|------|-------|');

    results.forEach(function (r) {
        var p = r.parsedResponse;
        var bias = p ? p.bias : ('ERR:' + ((r.parseError && r.parseError.code) || (r.apiError && r.apiError.code)));
        var conf = p ? p.confidence : '-';
        var row = [
            'Case ' + r.caseId,
            new Date(r.evaluationTime).toISOString().replace('.000Z', 'Z'),
            bias, conf,
            '[ ]', '[ ]', '[ ]', '[ ]', '[ ]', '[ ]', '[ ]', '[ ]'
        ];
        L.push('| ' + row.join(' | ') + ' |');
    });

    L.push('');
    L.push('## 逐 Case 明细');
    L.push('');

    results.forEach(function (r) {
        var p = r.parsedResponse;
        L.push('### Case ' + r.caseId + ' — ' + new Date(r.evaluationTime).toISOString());
        L.push('');
        if (!p) {
            L.push('**ERROR**: ' + JSON.stringify(r.parseError || r.apiError));
            L.push('');
            L.push('Human Review:');
            L.push('[ ] PASS   [ ] UNCERTAIN   [ ] FAIL');
            L.push('Notes: ________________________________');
            L.push('');
            return;
        }
        L.push('DeepSeek: **' + p.bias + '** / ' + p.confidence);
        L.push('');
        L.push('**Swing** (state=' + (p.identifiedStructure && p.identifiedStructure.structureState) + ')');
        (p.identifiedStructure ? p.identifiedStructure.majorSwingHighs : []).forEach(function (s) {
            L.push('- SH ' + s.price + ' @ ' + s.time);
        });
        (p.identifiedStructure ? p.identifiedStructure.majorSwingLows : []).forEach(function (s) {
            L.push('- SL ' + s.price + ' @ ' + s.time);
        });
        L.push('');
        L.push('**Liquidity**');
        (p.liquidity ? p.liquidity.recentSweeps : []).forEach(function (s) {
            L.push('- Sweep ' + s.side + ' @ ' + s.liquidityPrice + ' (' + s.sweepTime + ') — ' + (s.reason || ''));
        });
        L.push('');
        L.push('**Delivery** (current=' + (p.delivery && p.delivery.currentDelivery) + ')');
        (p.delivery ? p.delivery.mss : []).forEach(function (m) {
            L.push('- MSS ' + m.type + ' break ' + m.brokenSwingPrice + ' @ ' + m.breakTime);
        });
        (p.delivery ? p.delivery.displacement : []).forEach(function (d) {
            L.push('- Disp ' + d.direction + ' ' + d.startTime + '→' + d.endTime);
        });
        L.push('');
        L.push('**Dealing Range** high=' + (p.dealingRange && p.dealingRange.high) +
            ' low=' + (p.dealingRange && p.dealingRange.low) +
            ' loc=' + (p.dealingRange && p.dealingRange.location));
        L.push('**Draw** ' + (p.drawOnLiquidity && p.drawOnLiquidity.direction) +
            ' → ' + (p.drawOnLiquidity && p.drawOnLiquidity.targetPrice));
        L.push('');
        L.push('Evidence: ' + (p.supportingEvidence || []).join('; '));
        L.push('Conflicts: ' + (p.conflicts || []).join('; '));
        L.push('Reason: ' + (p.biasReason || ''));
        L.push('');
        L.push('Human Review:');
        L.push('Swing         [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Liquidity     [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Sweep         [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('MSS           [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Displacement  [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Dealing Range [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Draw          [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Final Bias    [ ] PASS  [ ] UNCERTAIN  [ ] FAIL');
        L.push('Notes: ________________________________');
        L.push('');
    });

    return L.join('\n');
}

if (require.main === module) {
    run().then(function () {
        process.exit(0);
    }).catch(function (e) {
        console.error('审计失败：', e.message);
        process.exit(1);
    });
}

module.exports = {
    selectEvaluationTimes: selectEvaluationTimes,
    buildCandleSlice: buildCandleSlice,
    buildStructuralSnapshotIndex: buildStructuralSnapshotIndex,
    findAuditStartIndex: findAuditStartIndex,
    findTimeRangeIndices: findTimeRangeIndices,
    load4hCandles: load4hCandles,
    buildCompactRecord: buildCompactRecord,
    buildSummary: buildSummary,
    buildReview: buildReview,
    evaluateAuditResponse: evaluateAuditResponse,
    mulberry32: mulberry32,
    parseCaseIdxs: parseCaseIdxs,
    processCase: processCase,
    run: run
};
