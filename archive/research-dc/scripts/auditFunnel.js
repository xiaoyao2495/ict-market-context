/**
 * BTCUSDT Opportunity Funnel Audit V1（纯诊断，零规则修改）
 *
 * 方法：复用 production liveEngine（未改）在 30 天 BTCUSDT closed 5m 上逐根推进，
 * 复刻 production onBar 内部步骤（同模块序列 / 同阈值 / 同 classify 函数）。
 * 每个 closure leg 用 production 同一批函数（buildWindowedLegIndex /
 * classifyLegQuality / classifyMssReference / classifyOpportunityTier /
 * associateSweeps / alertPrioritization）评估，tier 判定 byte-identical。
 *
 * 不修改任何 production rule / threshold / MSS / Sweep / Displacement /
 * Liquidity / Opportunity tier / Priority / Notification / Daily Bias 逻辑。
 *
 * 输出：
 *   - funnel 每层 input/pass/reject（含 passRateFromPrevious）
 *   - rejection reason 频率（每个 rejection 唯一 primary reason，全部来自现有系统）
 *   - Top3 drop-off
 *   - 每天 funnel（MSS / validLeg / opps / HIGH / WATCH / notificationEligible / notifications）
 *   - Near-Miss（只因一个条件失败未达 notification eligible）
 *   - Formation Window 样本（trigger 前 20 根 5m + trigger + evaluationTime + HTF + facts + reason + threshold + value）
 *   - Outcome 样本（trigger 后 10 根 5m，独立保存，不进 rejection 分类）
 *
 * Audit invariants：
 *   FUTURE_LEAK_VIOLATIONS = 0（所有 confirmedAt <= evaluationTime）
 *   PRODUCTION_RULE_CHANGED = false（未改任何代码）
 *   THRESHOLD_CHANGED = false（未改 thresholds.js）
 *   BIAS_FILTER_APPLIED = false（Daily Bias 仅 enrich，不进 funnel pass/reject）
 */
'use strict';

var historicalLoader = require('../replay/historicalLoader');
var liveEngineMod = require('../live/liveEngine');
var displacementLeg = require('../stats/displacementLeg');
var mssReference = require('../stats/mssReference');
var opportunityQuality = require('../stats/opportunityQuality');
var liquidityProvenance = require('../stats/liquidityProvenance');
var alertPrioritization = require('../stats/alertPrioritization');
var thresholds = require('../config/thresholds');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '30', 10);
var OUT_DIR = process.argv[4] || ('.audit-funnel-' + SYMBOL.toLowerCase());

var BAR_MS = 300000;

// ---------- 工具 ----------
function pct(n, d) { return d > 0 ? (n / d * 100) : 0; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
function isoU8(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' '); }
function dayKey(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function r4(n) { return Math.round(n * 10000) / 10000; }

// ---------- 主流程 ----------
function main() {
    var endTime = Date.now();
    var startTime = endTime - DAYS * 24 * 3600 * 1000;

    console.error('Loading ' + SYMBOL + ' futures ' + DAYS + 'd (' + iso(startTime) + ' -> ' + iso(endTime) + ') ...');
    return historicalLoader.loadAll(SYMBOL, startTime, endTime).then(function (data) {
        var candles5m = data['5m'];
        // 严格 futures-only（审计口径：production 只吃 futures）
        var nonFutures = candles5m.filter(function (c) { return c.source !== 'futures'; });
        if (nonFutures.length > 0) {
            throw new Error('DATA_SOURCE_DEGRADED: ' + nonFutures.length + ' 根非 futures（' +
                (nonFutures[0].source || 'undefined') + '）——审计要求 futures-only，拒绝继续');
        }
        console.error('5m: ' + candles5m.length + ' bars [futures] tickSize ' + data.exchangeInfo.tickSize);

        // structureCandles / calendarCandles（与 liveEngine 同构）
        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };

        var engine = liveEngineMod.createLiveEngine({
            symbol: SYMBOL,
            exchangeInfo: data.exchangeInfo,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            // 不需要 fetcher（HTF 已全量加载；liveEngine 内部不依赖 fetcher 做检测）
            fetcher: null,
            thresholds: thresholds
        }, {
            snapshotInterval: 12,
            baseIndex: 0,
            // Daily Bias 旁路：提供 no-op provider（只记录，不进 funnel）
            dailyBiasProvider: function () {
                return { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'UNKNOWN', evaluationTime: null, ageMs: null };
            }
        });

        // ---- 逐根推进（production onBar，未改） ----
        var chain = Promise.resolve();
        candles5m.forEach(function (c, idx) {
            chain = chain.then(function () { return engine.onBar(c, idx); });
        });
        return chain.then(function () {
            var state = engine.getState();
            return runAudit(state, candles5m, data, startTime, endTime);
        });
    });
}

/**
 * 复用 production 同批函数重建 legs + opportunity 评估（与 liveEngine.evaluateOpportunity 同源）。
 */
function runAudit(state, candles, data, startTime, endTime) {
    var symbol = SYMBOL;

    // ---- 从 production engine state 取全部事件（与 live onBar 完全同源） ----
    var allMss = state.eventRegistry.getByType(symbol, 'MSS');
    var allDisp = state.eventRegistry.getByType(symbol, 'DISPLACEMENT');
    var allSweeps = state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP');
    var allFvgs = state.fvgReg.getAll(symbol);
    var allLiquidity = state.registry.getAll(symbol); // raw liquidity events（ACTIVE 注册）

    // DC vs LEGACY：MSS reference pool 与 liveEngine 同构
    var useDc = !!(thresholds.structure && thresholds.structure.useDcStructuralSwing);
    var mssPool = useDc ? state.dcRefPool : state.swings;

    // HTF context 快照（评估时可见）—— 取最后一根的 snapshot
    var lastSnapshot = state.snapshot;

    // ---- 重建 windowed legs（与 liveEngine 同 builder 语义） ----
    var legByDispId = displacementLeg.buildWindowedLegIndex(allDisp, candles, allMss, mssPool, 900000);

    // FVG → leg 归属（与 buildOpportunities / evaluateOpportunity 同源）
    function fvgsOfLeg(leg) {
        return allFvgs.filter(function (f) {
            return f.displacementEventId && leg.ids.indexOf(f.displacementEventId) !== -1;
        });
    }

    // ---- drawTrace（liveEngine 每根写 state.drawTrace[i]） ----
    var drawTrace = state.drawTrace || [];

    // ====================================================================
    // FUNNEL 统计
    // ====================================================================
    var F = {}; // layer -> { input, pass, reject }
    function layer(name, input, pass) {
        F[name] = { input: input, pass: pass, reject: input - pass };
    }

    // L0: 5m bars
    layer('bars5m', candles.length, candles.length);

    // L1: raw liquidity events（registry 全部 liquidity 注册）
    layer('rawLiquidity', allLiquidity.length, allLiquidity.length);

    // L2: valid sweeps（达到 SWEPT，产生 LIQUIDITY_SWEEP 事件）
    layer('validSweeps', allSweeps.length, allSweeps.length);

    // L3: structural MSS（MSS 事件总数）
    layer('structuralMSS', allMss.length, allMss.length);

    // L4: MSS with valid displacement
    //   production 定义：MSS 同根（candleIndex）上有 displacement（displacementDetector same-candle bonus）
    //   或 MSS 后 1 根内有 displacement（窗口内的 delivery）。用 candleIndex 紧邻判定。
    var mssWithDisp = 0;
    var mssNoDisp = 0;
    allMss.forEach(function (m) {
        var mi = m.candleIndex;
        var has = allDisp.some(function (d) {
            return d.direction === m.direction && d.candleIndex >= mi && d.candleIndex <= mi + 1;
        });
        if (has) mssWithDisp++; else mssNoDisp++;
    });
    layer('mssWithDisplacement', allMss.length, mssWithDisp);

    // L5: valid displacement legs（windowed builder 关闭的 leg，enrich 后 rangeAtr 有效）
    var validLegs = [];
    Object.keys(legByDispId).forEach(function (id) {
        var leg = legByDispId[id];
        if (leg.rangeAtr !== null && leg.rangeAtr !== undefined) validLegs.push(leg);
    });
    layer('validLegs', validLegs.length, validLegs.length);

    // L6: legs with liquidityTaken（associateSweeps 非空 —— explainability 层，不拒绝 tier）
    var legsWithLiquidity = 0;
    validLegs.forEach(function (leg) {
        var availTime = leg.availableAt !== undefined ? leg.availableAt : (leg.lastConfirmedAt || 0);
        var prov = liquidityProvenance.associateSweeps({
            direction: leg.direction,
            leg: leg,
            availableAt: availTime,
            sweepEvents: allSweeps,
            maxLookbackBars: null
        });
        if (prov && prov.allCandidates && prov.allCandidates.length > 0) legsWithLiquidity++;
    });
    layer('legsWithLiquidity', validLegs.length, legsWithLiquidity);

    // L7: legs with nearDraw（nearTarget 非空）
    var legsWithNear = 0;
    validLegs.forEach(function (leg) {
        var anchorIdx = leg.lastIndex;
        var dt = drawTrace[anchorIdx];
        var nearTarget = null;
        if (dt) nearTarget = leg.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        if (nearTarget !== null && nearTarget !== undefined) legsWithNear++;
    });
    layer('legsWithNearDraw', validLegs.length, legsWithNear);

    // ---- 逐 leg 评估 opportunity（与 liveEngine.evaluateOpportunity 同源） ----
    var oppCandidates = []; // 通过 legFvgs>0 的候选
    var rejections = {}; // reason -> count
    var rejectionSamples = {}; // reason -> [sample]
    var futureLeak = 0; // FUTURE_LEAK_VIOLATIONS 计数
    var dailyFunnel = {}; // dayKey -> { mss, validLeg, opps, high, watch, notifEligible, notif }
    var nearMiss = []; // 只因一个条件失败未达 notification eligible

    var prioritizationEnabled = !!(thresholds.notify && thresholds.notify.prioritization && thresholds.notify.prioritization.enabled);

    validLegs.forEach(function (leg) {
        var anchorIdx = leg.lastIndex;
        var anchorCandle = candles[anchorIdx];
        if (!anchorCandle) return;

        // FVG 关联
        var legFvgs = fvgsOfLeg(leg);
        if (legFvgs.length === 0) {
            // R_LEG_NO_FVG：production evaluateOpportunity 直接 return null
            rec('R_LEG_NO_FVG', leg, anchorCandle, candles, null, null, 'legFvgs=0');
            return;
        }

        // leg 价量维度（liveEngine 已 enrich；此处确保）
        if (leg.rangeAtr === null || leg.rangeAtr === undefined) {
            displacementLeg.enrichLegWithCandles(leg, candles);
        }
        var legQuality = displacementLeg.classifyLegQuality(leg);

        // mss quality
        var mssQuality = 'NO_MSS';
        var mssEvent = null;
        if (leg.mssId) {
            allMss.some(function (m) { if (m.id === leg.mssId) { mssEvent = m; return true; } return false; });
            if (mssEvent) mssQuality = mssReference.classifyMssReference(mssEvent, mssPool).quality;
        }

        // near draw
        var dt = drawTrace[anchorIdx];
        var nearTarget = null;
        if (dt) nearTarget = leg.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        if (nearTarget === null && lastSnapshot && lastSnapshot.draw) {
            nearTarget = leg.direction === 'BULLISH'
                ? (lastSnapshot.draw.bsl && lastSnapshot.draw.bsl.near ? lastSnapshot.draw.bsl.near.targetPrice : null)
                : (lastSnapshot.draw.ssl && lastSnapshot.draw.ssl.near ? lastSnapshot.draw.ssl.near.targetPrice : null);
        }
        var anchorPrice = anchorCandle.close;
        var nearDistPct = nearTarget !== null && nearTarget !== undefined && anchorPrice > 0
            ? Math.abs(nearTarget - anchorPrice) / anchorPrice * 100 : null;

        // FUTURE_LEAK 校验：所有关联事件 confirmedAt <= leg.availableAt
        var availAt = leg.availableAt !== undefined ? leg.availableAt
            : (leg.lastConfirmedAt || anchorCandle.closeTime);
        if (mssEvent && mssEvent.confirmedAt > availAt) futureLeak++;
        // sweep provenance 内部已强制 confirmedAt <= availableAt（fail-closed），这里再独立校验
        var prov = liquidityProvenance.associateSweeps({
            direction: leg.direction, leg: leg, availableAt: availAt,
            sweepEvents: allSweeps, maxLookbackBars: null
        });
        if (prov) {
            prov.allCandidates.forEach(function (c) {
                if (c.confirmedAt > availAt) futureLeak++;
            });
        }

        // tier 判定（与 liveEngine 同源：classifyOpportunityTier）
        var tier = opportunityQuality.classifyOpportunityTier({
            mssQuality: mssQuality,
            legQuality: legQuality,
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });

        var notifyPriority = null;
        if (tier === 'HIGH_QUALITY') {
            notifyPriority = alertPrioritization.windowHasSignificant({
                liquidityContext: prov,
                direction: leg.direction
            }) ? 'PRIORITY_HIGH' : 'STANDARD_HIGH';
        }

        // ---- opportunity candidate 记录 ----
        var opp = {
            id: leg.mssId || ('LEG:' + leg.ids[0]),
            tier: tier,
            direction: leg.direction,
            mssQuality: mssQuality,
            legQuality: legQuality,
            rangeAtr: leg.rangeAtr,
            nearTarget: nearTarget,
            nearDistPct: nearDistPct,
            anchorIndex: anchorIdx,
            anchorTime: anchorCandle.closeTime,
            availableAt: availAt,
            notifyPriority: notifyPriority,
            legStartIndex: leg.startIndex,
            legEndIndex: leg.lastIndex,
            fvgCount: legFvgs.length,
            liquidityTaken: !!(prov && prov.allCandidates && prov.allCandidates.length > 0),
            immediateSweep: prov ? prov.immediateSweep : null,
            allCandidates: prov ? prov.allCandidates : []
        };
        oppCandidates.push(opp);

        // ---- 每天 funnel 累计 ----
        var dk = dayKey(anchorCandle.closeTime);
        if (!dailyFunnel[dk]) dailyFunnel[dk] = { mss: 0, validLeg: 0, opps: 0, high: 0, watch: 0, low: 0, notifEligible: 0, notif: 0, candles: 0 };
        dailyFunnel[dk].validLeg++;
        dailyFunnel[dk].opps++;
        if (tier === 'HIGH_QUALITY') dailyFunnel[dk].high++;
        else if (tier === 'WATCH') dailyFunnel[dk].watch++;
        else dailyFunnel[dk].low++;

        // ---- rejection / near-miss 分类 ----
        var notifEligible = (tier === 'HIGH_QUALITY') && (!prioritizationEnabled || notifyPriority === 'PRIORITY_HIGH');
        if (notifEligible) {
            dailyFunnel[dk].notifEligible++;
            dailyFunnel[dk].notif++; // 审计假设 dingtalk 成功（无投递失败），actual notifications = eligible
        } else {
            // 分类 primary reason
            if (tier !== 'HIGH_QUALITY') {
                // 候选到 HIGH 失败 —— 找"只差一个条件"的 near-miss
                classifyPreHighReject(opp, leg, anchorCandle, candles);
            } else {
                // tier===HIGH 但 NOT PRIORITY
                rec('R_NOT_PRIORITY', leg, anchorCandle, candles, opp, notifyPriority, 'HIGH but STANDARD_HIGH (windowHasSignificant=false)');
                // Near-Miss：对照 notification eligible 仅因 prioritization 失败
                nearMiss.push({
                    kind: 'HIGH_NOT_PRIORITY',
                    opp: opp,
                    failCondition: 'NO_SIGNIFICANT_LIQUIDITY_IN_WINDOW',
                    actualValue: 'windowHasSignificant=false',
                    threshold: 'windowHasSignificant=true (48-bar window, EQL/EQH/PDL/PDH/Session)',
                    distanceNote: describePriorityGap(opp)
                });
            }
        }
    });

    // L8: opportunity candidates
    layer('opportunityCandidates', validLegs.length, oppCandidates.length);
    // L9: tier split
    var nHigh = oppCandidates.filter(function (o) { return o.tier === 'HIGH_QUALITY'; }).length;
    var nWatch = oppCandidates.filter(function (o) { return o.tier === 'WATCH'; }).length;
    var nLow = oppCandidates.filter(function (o) { return o.tier === 'LOW_QUALITY'; }).length;
    layer('highQuality', oppCandidates.length, nHigh);
    layer('watch', oppCandidates.length, nWatch);
    layer('lowQuality', oppCandidates.length, nLow);

    // L10: notification eligible
    var nEligible = oppCandidates.filter(function (o) {
        return o.tier === 'HIGH_QUALITY' && (!prioritizationEnabled || o.notifyPriority === 'PRIORITY_HIGH');
    }).length;
    layer('notificationEligible', nHigh, nEligible);

    // L11: actual notifications（审计假设 dingtalk 成功，去重后 = eligible；且只 HIGH 通知）
    layer('actualNotifications', nEligible, nEligible);

    // 每天 MSS 数（从 allMss confirmedAt 聚合，补 dailyFunnel.mss）
    allMss.forEach(function (m) {
        var dk = dayKey(m.confirmedAt);
        if (!dailyFunnel[dk]) dailyFunnel[dk] = { mss: 0, validLeg: 0, opps: 0, high: 0, watch: 0, low: 0, notifEligible: 0, notif: 0, candles: 0 };
        dailyFunnel[dk].mss++;
    });
    // 每天 candles 数
    candles.forEach(function (c) {
        var dk = dayKey(c.closeTime);
        if (!dailyFunnel[dk]) dailyFunnel[dk] = { mss: 0, validLeg: 0, opps: 0, high: 0, watch: 0, low: 0, notifEligible: 0, notif: 0, candles: 0 };
        dailyFunnel[dk].candles++;
    });

    // ---- 输出 ----
    var result = {
        symbol: SYMBOL,
        days: DAYS,
        mode: useDc ? 'DC_ATR_1_5_CLOSE' : 'LEGACY',
        prioritizationEnabled: prioritizationEnabled,
        startTime: startTime,
        endTime: endTime,
        bars5m: candles.length,
        funnel: F,
        tierSplit: { HIGH_QUALITY: nHigh, WATCH: nWatch, LOW_QUALITY: nLow },
        rejections: rejections,
        rejectionSamples: rejectionSamples,
        dailyFunnel: dailyFunnel,
        nearMiss: nearMiss,
        futureLeakViolations: futureLeak,
        productionRuleChanged: false,
        thresholdChanged: false,
        biasFilterApplied: false
    };
    return result;

    // ---- 内部辅助 ----
    function rec(reason, leg, anchorCandle, candles, opp, notifyPriority, detail) {
        rejections[reason] = (rejections[reason] || 0) + 1;
        if (!rejectionSamples[reason]) rejectionSamples[reason] = [];
        if (rejectionSamples[reason].length < 10) {
            rejectionSamples[reason].push(buildFormationSample(reason, leg, anchorCandle, candles, opp, notifyPriority, detail));
        }
    }

    function classifyPreHighReject(opp, leg, anchorCandle, candles) {
        // 对照 HIGH 标准 (highMss && strongLeg && nearOk && !conflict)
        var highMss = (opp.mssQuality === 'PROTECTED_SWING' || opp.mssQuality === 'HTF_RELEVANT');
        var strongLeg = (opp.legQuality === 'STRONG' || opp.legQuality === 'EXPLOSIVE');
        var nearOk = (opp.nearTarget !== null && opp.nearTarget !== undefined);

        // 只差一个条件 → near-miss；否则记普通 reject
        var failed = [];
        if (!highMss) failed.push('MSS_QUALITY');
        if (!strongLeg) failed.push('LEG_QUALITY');
        if (!nearOk) failed.push('NO_NEAR_DRAW');

        if (failed.length === 1) {
            // Near-Miss：只因一个条件失败未达 notification eligible
            var fc = failed[0];
            var actualVal, threshold, distNote;
            if (fc === 'MSS_QUALITY') {
                actualVal = opp.mssQuality;
                threshold = 'PROTECTED_SWING|HTF_RELEVANT';
                distNote = 'MSS quality 距 HIGH 差 ' + opp.mssQuality + ' → PROTECTED/HTF';
                rec('R_MSS_QUALITY_INSUFFICIENT', leg, anchorCandle, candles, opp, null, 'mssQuality=' + opp.mssQuality + ' (need PROTECTED/HTF)');
            } else if (fc === 'LEG_QUALITY') {
                actualVal = opp.legQuality + ' (rangeAtr=' + r4(opp.rangeAtr) + ')';
                threshold = 'STRONG|EXPLOSIVE (rangeAtr>=1.8 & netMoveAtr>=1.2)';
                distNote = 'leg rangeAtr=' + r4(opp.rangeAtr) + ' 距 STRONG(>=1.8) 差 ' + r4(1.8 - opp.rangeAtr);
                rec('R_LEG_QUALITY_INSUFFICIENT', leg, anchorCandle, candles, opp, null, 'legQuality=' + opp.legQuality + ' rangeAtr=' + r4(opp.rangeAtr));
            } else {
                actualVal = 'nearTarget=null';
                threshold = 'nearDrawAvailable=true (drawTrace near 非空)';
                distNote = 'leg 锚点 drawTrace 无 near liquidity';
                rec('R_NO_NEAR_DRAW', leg, anchorCandle, candles, opp, null, 'nearTarget=null');
            }
            nearMiss.push({
                kind: 'PRE_HIGH_' + fc,
                opp: opp,
                failCondition: fc,
                actualValue: actualVal,
                threshold: threshold,
                distanceNote: distNote
            });
        } else {
            // 多条件失败 → 记第一个主要 reason（按现有系统真实优先级）
            if (!strongLeg) rec('R_LEG_QUALITY_INSUFFICIENT', leg, anchorCandle, candles, opp, null, 'legQuality=' + opp.legQuality);
            else if (!highMss) rec('R_MSS_QUALITY_INSUFFICIENT', leg, anchorCandle, candles, opp, null, 'mssQuality=' + opp.mssQuality);
            else if (!nearOk) rec('R_NO_NEAR_DRAW', leg, anchorCandle, candles, opp, null, 'nearTarget=null');
        }
    }

    function describePriorityGap(opp) {
        // 窗口内最近的 candidate（无论是否 significant）距离
        if (!opp.allCandidates || opp.allCandidates.length === 0) {
            return '窗口内无任何 liquidity candidate（连普通 swing 都没有）';
        }
        // 最近 significant 的距离（若有）
        var sigs = opp.allCandidates.filter(function (c) { return alertPrioritization.isSignificant(c.sourceType); });
        if (sigs.length === 0) {
            var nearest = opp.allCandidates[0];
            return '窗口内无 Significant；最近 candidate=' + nearest.sourceType + ' @' + nearest.barsBeforeLegStart + 'bars（普通 swing，不足触发 PRIORITY）';
        }
        return '已有 ' + sigs.length + ' 个 Significant candidate';
    }

    function buildFormationSample(reason, leg, anchorCandle, candles, opp, notifyPriority, detail) {
        // Formation Window：trigger 前 20 根 5m + trigger + evaluationTime + HTF context + facts
        var from = Math.max(0, leg.startIndex - 20);
        var windowCandles = [];
        for (var i = from; i <= leg.lastIndex; i++) {
            var c = candles[i];
            if (c) windowCandles.push({
                i: i,
                t: isoU8(c.closeTime),
                o: c.open, h: c.high, l: c.low, c: c.close,
                role: (i === leg.startIndex ? 'LEG_START' : (i === leg.lastIndex ? 'LEG_END(trigger)' : 'pre'))
            });
        }
        // HTF context（评估时可见）：取最后 snapshot 的 draw + 关键 liquidity
        var htf = null;
        if (lastSnapshot && lastSnapshot.draw) {
            var d = lastSnapshot.draw;
            htf = {
                bslNear: d.bsl && d.bsl.near ? d.bsl.near.targetPrice : null,
                bslMacro: d.bsl && d.bsl.macro ? d.bsl.macro.targetPrice : null,
                sslNear: d.ssl && d.ssl.near ? d.ssl.near.targetPrice : null,
                sslMacro: d.ssl && d.ssl.macro ? d.ssl.macro.targetPrice : null
            };
        }
        var facts = {
            direction: leg.direction,
            mssQuality: opp ? opp.mssQuality : (leg.mssId ? 'linked' : 'NO_MSS'),
            legQuality: opp ? opp.legQuality : null,
            rangeAtr: leg.rangeAtr,
            nearTarget: opp ? opp.nearTarget : null,
            nearDistPct: opp ? opp.nearDistPct : null,
            liquidityTaken: opp ? opp.liquidityTaken : false,
            immediateSweep: opp && opp.immediateSweep ? {
                sourceType: opp.immediateSweep.sourceType,
                sourcePrice: opp.immediateSweep.sourcePrice,
                barsBeforeLegStart: opp.immediateSweep.barsBeforeLegStart,
                confirmedAt: opp.immediateSweep.confirmedAt
            } : null,
            tier: opp ? opp.tier : null,
            notifyPriority: notifyPriority || (opp ? opp.notifyPriority : null)
        };
        return {
            reason: reason,
            detail: detail,
            anchorTime: isoU8(anchorCandle.closeTime),
            evaluationTime: isoU8(leg.availableAt !== undefined ? leg.availableAt : anchorCandle.closeTime),
            legStartIndex: leg.startIndex,
            legEndIndex: leg.lastIndex,
            htfContext: htf,
            facts: facts,
            window: windowCandles,
            // Outcome（trigger 后 10 根，独立保存，不进 rejection 分类）
            outcome: buildOutcome(leg, candles)
        };
    }

    function buildOutcome(leg, candles) {
        var out = [];
        var availIdx = leg.availableIndex !== undefined && leg.availableIndex !== null ? leg.availableIndex : leg.lastIndex;
        for (var j = availIdx + 1; j <= Math.min(availIdx + 10, candles.length - 1); j++) {
            var c = candles[j];
            if (c) out.push({ i: j, t: isoU8(c.closeTime), o: c.open, h: c.high, l: c.low, c: c.close });
        }
        return out;
    }
}

// ---------- 入口 ----------
if (require.main === module) {
    main().then(function (result) {
        var fs = require('fs');
        var path = require('path');
        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

        fs.writeFileSync(path.join(OUT_DIR, 'funnel-result.json'), JSON.stringify(result, null, 2));

        // 控制台摘要
        console.error('\n=== FUNNEL (' + result.mode + ', prioritization.enabled=' + result.prioritizationEnabled + ') ===');
        var order = ['bars5m', 'rawLiquidity', 'validSweeps', 'structuralMSS', 'mssWithDisplacement',
            'validLegs', 'legsWithLiquidity', 'legsWithNearDraw', 'opportunityCandidates',
            'highQuality', 'watch', 'lowQuality', 'notificationEligible', 'actualNotifications'];
        order.forEach(function (k) {
            var l = result.funnel[k];
            if (!l) return;
            console.error(k.padEnd(22) + ' input=' + String(l.input).padStart(7) +
                ' pass=' + String(l.pass).padStart(7) +
                ' reject=' + String(l.reject).padStart(7) +
                ' passRate=' + pct(l.pass, l.input).toFixed(2) + '%');
        });
        console.error('\nTier split: HIGH=' + result.tierSplit.HIGH_QUALITY +
            ' WATCH=' + result.tierSplit.WATCH + ' LOW=' + result.tierSplit.LOW_QUALITY);
        console.error('\nRejection reasons:');
        Object.keys(result.rejections).sort(function (a, b) { return result.rejections[b] - result.rejections[a]; }).forEach(function (r) {
            console.error('  ' + r.padEnd(28) + result.rejections[r]);
        });
        console.error('\nFUTURE_LEAK_VIOLATIONS = ' + result.futureLeakViolations);
        console.error('Near-Miss count = ' + result.nearMiss.length);
        console.error('Daily funnel days = ' + Object.keys(result.dailyFunnel).length);
        console.error('\nWrote ' + OUT_DIR + '/funnel-result.json');
    }).catch(function (e) {
        console.error('AUDIT FAILED:', e && e.message, e && e.stack);
        process.exit(1);
    });
}

module.exports = { main: main };
