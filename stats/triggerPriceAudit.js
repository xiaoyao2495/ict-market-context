/**
 * Phase 11L.7 — ICT Trigger Price Shadow Audit（纯诊断，不接 Live）
 *
 * 核心问题：5m HIGH_QUALITY 成立（availableAt）后，等价格回撤到哪个 ICT 价格位置再通知，
 * 后续 Near Draw 兑现质量最好？
 *
 * 单变量约束：母样本与 90d 报告完全一致（buildTierIndex 同构），只改变"何时通知"。
 * 零 Live 改动、零策略参数改动、零重新筛选。
 *
 * 五个通知模型（第一轮只测这 5 个，不加更多）：
 *   AVAILABLE  availableAt 立即通知（现行为 / BASELINE，即 11D.8 的 81%）
 *   FVG_TOUCH 首次进入 FVG（BULLISH low<=zoneHigh / BEARISH high>=zoneLow）
 *   FVG_CE    FVG 50% = (zoneLow+zoneHigh)/2
 *   OTE_62    displacement leg 回撤 62%（retrace 深度，自 leg 摆动高低算）
 *   OTE_70_5  displacement leg 回撤 70.5%
 *
 * 无 leakage 硬规则（Phase 11L.4 教训）：
 *   - 触发扫描一律从 availableIndex + 1 开始（系统在 availableAt 才知道 opp 成立）
 *   - 禁止从 anchorTime 往后找触发（会把"通知前已发生行情"算进来）
 *   - post-trigger 质量从 triggerIndex + 1（触发确认后的最早 N+1）起算
 *
 * OTE range 定义（锁死，不引入新 swing）：
 *   直接用 DisplacementLeg start→end：legHigh = max(high)，legLow = min(low)
 *   BULLISH 回撤从高往低：OTE(x) = legHigh - x*(legHigh-legLow)；触发 low <= OTE(x)
 *   BEARISH 回撤从低往高：OTE(x) = legLow  + x*(legHigh-legLow)；触发 high >= OTE(x)
 *
 * 关键指标（防止只看 NearHit 得出错误结论）：
 *   Trigger Rate        触发率（100% - 等没了多少机会）
 *   Median Wait         触发等待时长（通知延迟）
 *   NearHit 30m/1h      post-trigger 近端流动性命中（%）
 *   MFE/MAE             post-trigger 顺/逆最大幅度（以通知价 / 触发价为基准）
 *   NoTrigger->NearHit  坚持等该位置而错过的真正 delivery 数
 *   Effective Capture   Trigger Rate × NearHit1h（提醒系统实用价值）
 */
var opportunityQuality = require('./opportunityQuality');
var displacementLeg = require('./displacementLeg');

// 等待期限（根数）：4h = 48 根 5m。超过则 NO_TRIGGER。
var HORIZON_BARS = 48;

var MODELS = [
    { key: 'AVAILABLE' },
    { key: 'FVG_TOUCH' },
    { key: 'FVG_CE' },
    { key: 'OTE_62' },
    { key: 'OTE_70_5' }
];

/** OTE 深度档位（percent），与模型 key 对应 */
var OTE_DEPTH = {
    OTE_62: 0.62,
    OTE_70_5: 0.705
};

/**
 * 计算一个 opportunity 的 5 种触发价格。
 * @param {Object} item buildTierIndex 输出的 HIGH item（direction / fvgIds / dispId / availableIndex）
 * @param {Object} fvgById id → FVG（zoneLow/zoneHigh/direction/displacementEventId）
 * @param {Object} legByDispId dispId → leg（startIndex/endIndex/direction）
 * @param {Array} candles 5m candles
 * @returns {Object} { availPrice, fvg: {zoneLow, zoneHigh}, fvgCe, ote: {OTE_62, OTE_70_5} , legHigh, legLow }
 *  字段缺失时对应值为 null（该模型对这笔不可用，计入不可评估）
 */
function computeTriggerPrices(item, fvgById, legByDispId, candles) {
    var leg = item.dispId ? (legByDispId[item.dispId] || null) : null;
    var bullish = item.direction === 'BULLISH';
    // availPrice = availableAt 对应 K 收盘（BASELINE 通知价）
    var availPrice = null;
    if (item.availableIndex !== null && item.availableIndex !== undefined && candles[item.availableIndex]) {
        availPrice = candles[item.availableIndex].close;
    }
    // FVG：取 opportunity 内属于该 leg 的首个 FVG；否则取 fvgIds[0]
    var fvg = null;
    (item.fvgIds || []).forEach(function (fid) {
        if (fvg) return;
        var f = fvgById ? fvgById[fid] : null;
        if (!f) return;
        // 优先 leg 自己的 FVG（displacementEventId 匹配 leg 首位移）
        if (leg && f.displacementEventId === leg.ids[0]) { fvg = f; return; }
        if (!fvg) fvg = f;
    });
    if (!fvg) {
        // 无任何 FVG 结构证据 → FVG 模型不可用
    }
    var fvgZone = fvg ? { zoneLow: fvg.zoneLow, zoneHigh: fvg.zoneHigh } : null;
    var fvgCe = null;
    if (fvgZone) {
        fvgCe = (fvgZone.zoneLow + fvgZone.zoneHigh) / 2;
    }
    // OTE：leg start→end 摆动高低
    var legHigh = null;
    var legLow = null;
    if (leg && leg.startIndex !== null && leg.endIndex !== null &&
        leg.startIndex !== undefined && leg.endIndex !== undefined) {
        var h = -Infinity;
        var l = Infinity;
        for (var i = leg.startIndex; i <= leg.endIndex; i++) {
            var c = candles[i];
            if (!c) continue;
            if (c.high > h) h = c.high;
            if (c.low < l) l = c.low;
        }
        if (isFinite(h) && isFinite(l)) {
            legHigh = h;
            legLow = l;
        }
    }
    var ote = {};
    ote.OTE_62 = legHigh !== null && legLow !== null && legHigh > legLow
        ? (bullish ? legHigh - 0.62 * (legHigh - legLow) : legLow + 0.62 * (legHigh - legLow))
        : null;
    ote.OTE_70_5 = legHigh !== null && legLow !== null && legHigh > legLow
        ? (bullish ? legHigh - 0.705 * (legHigh - legLow) : legLow + 0.705 * (legHigh - legLow))
        : null;
    return { availPrice: availPrice, fvgZone: fvgZone, fvgCe: fvgCe, ote: ote, legHigh: legHigh, legLow: legLow };
}

/**
 * 判断某根 K 是否触发该模型（价格到达 trigger price）。
 * BULLISH：价格自上方回撤 → 触发条件是 low <= trigger（自 leg 高点向下回撤触达）。
 * BEARISH：价格自下方回撤 → 触发条件是 high >= trigger。
 * @returns {boolean}
 */
function candleTriggers(c, bullish, trigger) {
    if (!c || trigger === null || trigger === undefined) return false;
    return bullish ? (c.low <= trigger) : (c.high >= trigger);
}

/**
 * 单笔 opportunity 的 5 模型触发模拟。
 * 扫描窗口：[availableIndex+1, availableIndex+HORIZON_BARS]（<= candles 末端）。
 * @param {Object} item buildTierIndex 输出的 HIGH item
 * @param {Object} fvgById
 * @param {Object} legByDispId
 * @param {Array} candles
 * @returns {Object} { availableIndex, availableAt, direction, nearTarget, availPrice,
 *                     perModel: { KEY: { triggered, triggerIndex, triggerPrice, waitBars } } }
 *   不可评估（availableIndex 为 null 或越界）→ 返回 null
 */
function simulateOne(item, fvgById, legByDispId, candles) {
    if (item.availableIndex === null || item.availableIndex === undefined) return null;
    var availIdx = item.availableIndex;
    if (availIdx + 1 >= candles.length) return null; // 无 post-trigger 行情可验证
    var start = availIdx + 1;
    var lastJ = Math.min(start + HORIZON_BARS - 1, candles.length - 1);
    var bullish = item.direction === 'BULLISH';
    var prices = computeTriggerPrices(item, fvgById, legByDispId, candles);
    var levels = {
        AVAILABLE: prices.availPrice,
        FVG_TOUCH: prices.fvgZone ? (bullish ? prices.fvgZone.zoneHigh : prices.fvgZone.zoneLow) : null,
        FVG_CE: prices.fvgCe,
        OTE_62: prices.ote.OTE_62,
        OTE_70_5: prices.ote.OTE_70_5
    };
    var perModel = {};
    MODELS.forEach(function (m) {
        var level = levels[m.key];
        // 触发价不可用（缺 FVG / 缺 leg）→ 这笔对该模型不可评估
        if (m.key !== 'AVAILABLE' && (level === null || level === undefined)) {
            perModel[m.key] = { triggered: false, unavailable: true, triggerIndex: null, triggerPrice: null, waitBars: null };
            return;
        }
        if (m.key === 'AVAILABLE') {
            // BASELINE：availableAt 立即通知，triggerIndex = availableIndex，waitBars = 0
            perModel[m.key] = {
                triggered: true,
                triggerIndex: availIdx,
                triggerPrice: prices.availPrice,
                waitBars: 0,
                unavailable: false
            };
            return;
        }
        var ti = null;
        for (var j = start; j <= lastJ; j++) {
            var c = candles[j];
            if (!c) break;
            if (candleTriggers(c, bullish, level)) { ti = j; break; }
        }
        perModel[m.key] = {
            triggered: ti !== null,
            triggerIndex: ti,
            triggerPrice: ti !== null ? level : null,
            waitBars: ti !== null ? (ti - availIdx) : null,
            unavailable: false
        };
    });
    return {
        availableIndex: availIdx,
        availableAt: item.availableIndex !== undefined ? candles[availIdx].closeTime : null,
        direction: item.direction,
        nearTarget: item.nearTarget,
        availPrice: prices.availPrice,
        perModel: perModel
    };
}

/**
 * 对整个 HIGH 母样本批量模拟。
 * @param {Array} items buildTierIndex 输出（本函数内部已过滤 HIGH_QUALITY）
 * @param {Array} fvgs 全部 FVG
 * @param {Object} legByDispId buildWindowedLegIndex 输出
 * @param {Array} candles 5m candles
 * @returns {Array} 每笔 simulateOne 结果（跳过 null）
 */
function simulateAll(items, fvgs, legByDispId, candles) {
    var fvgById = {};
    (fvgs || []).forEach(function (f) { fvgById[f.id] = f; });
    var out = [];
    (items || []).forEach(function (it) {
        if (it.tier !== 'HIGH_QUALITY') return; // 母样本 = HIGH only
        if (!it.hasLeg) return;
        var r = simulateOne(it, fvgById, legByDispId, candles);
        if (r) out.push(r);
    });
    return out;
}

/**
 * 逐模型汇总指标。
 * @param {Array} results simulateAll 输出
 * @param {Array} candles 5m candles
 * @returns {Object} 每模型 { n, unavailable, triggerRate, medianWaitBars, medianWaitMin,
 *                   nearHit30m, nearHit1h, mfe30m, mae30m, mfe1h, mae1h,
 *                   noTriggerButNearHit, effectiveCapture }
 */
function assess(results, candles) {
    var out = {};
    MODELS.forEach(function (m) { out[m.key] = modelAcc(); });
function modelAcc() {
    return {
        n: 0, unavailable: 0, triggered: 0,
        waitBars: [], mfe30m: [], mae30m: [], mfe1h: [], mae1h: [],
        nearCnt30m: 0, nearHit30m: 0, nearCnt1h: 0, nearHit1h: 0,
        noTriggerButNearHit: 0,
        // 触发分布：waitBars <= 3/6/12/48（15m/30m/1h/4h）内的触发数
        trig15m: 0, trig30m: 0, trig1h: 0, trig4h: 0
    };
}
    (results || []).forEach(function (r) {
        MODELS.forEach(function (m) {
            var acc = out[m.key];
            var pm = r.perModel[m.key];
            if (!pm) return;
            if (pm.unavailable) { acc.unavailable++; return; }
            acc.n++;
            if (!pm.triggered) {
                // NO_TRIGGER：但 near 仍可能在 horizon 内被 hit → 错过 delivery
                var ntHit = nearHitInRange(r.nearTarget, r.direction, candles, r.availableIndex + 1, Math.min(r.availableIndex + HORIZON_BARS, candles.length - 1));
                if (ntHit) acc.noTriggerButNearHit++;
                return;
            }
            acc.triggered++;
            acc.waitBars.push(pm.waitBars);
            // 触发分布（15m=3根 / 30m=6根 / 1h=12根 / 4h=48根）
            if (pm.waitBars <= 3) acc.trig15m++;
            if (pm.waitBars <= 6) acc.trig30m++;
            if (pm.waitBars <= 12) acc.trig1h++;
            if (pm.waitBars <= 48) acc.trig4h++;
            var basePrice = pm.triggerPrice;
            // post-trigger 质量：从 triggerIndex + 1 起（触发确认后最早 N+1）
            var start = pm.triggerIndex + 1;
            if (start < candles.length) {
                [ { bars: 6, key: '30m' }, { bars: 12, key: '1h' } ].forEach(function (w) {
                    var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
                    var bullish = r.direction === 'BULLISH';
                    var mfe = 0, mae = 0, nearHit = false;
                    for (var j = start; j <= lastJ; j++) {
                        var c = candles[j];
                        if (!c) break;
                        if (bullish) {
                            if (c.high - basePrice > mfe) mfe = c.high - basePrice;
                            if (basePrice - c.low > mae) mae = basePrice - c.low;
                            if (r.nearTarget !== null && r.nearTarget !== undefined && c.high >= r.nearTarget) nearHit = true;
                        } else {
                            if (basePrice - c.low > mfe) mfe = basePrice - c.low;
                            if (c.high - basePrice > mae) mae = basePrice - c.high;
                            if (r.nearTarget !== null && r.nearTarget !== undefined && c.low <= r.nearTarget) nearHit = true;
                        }
                    }
                    if (w.key === '30m') {
                        acc.mfe30m.push(mfe / basePrice * 100);
                        acc.mae30m.push(mae / basePrice * 100);
                        if (r.nearTarget !== null && r.nearTarget !== undefined) { acc.nearCnt30m++; if (nearHit) acc.nearHit30m++; }
                    } else {
                        acc.mfe1h.push(mfe / basePrice * 100);
                        acc.mae1h.push(mae / basePrice * 100);
                        if (r.nearTarget !== null && r.nearTarget !== undefined) { acc.nearCnt1h++; if (nearHit) acc.nearHit1h++; }
                    }
                });
            }
        });
    });
    MODELS.forEach(function (m) {
        var a = out[m.key];
        a.triggerRate = a.n > 0 ? a.triggered / a.n : 0;
        a.medianWaitBars = median(a.waitBars);
        a.medianWaitMin = a.medianWaitBars !== null ? a.medianWaitBars * 5 : null;
        a.nearHit30m = a.nearCnt30m > 0 ? a.nearHit30m / a.nearCnt30m : null;
        a.nearHit1h = a.nearCnt1h > 0 ? a.nearHit1h / a.nearCnt1h : null;
        a.mfe30m = mean(a.mfe30m);
        a.mae30m = mean(a.mae30m);
        a.mfe1h = mean(a.mfe1h);
        a.mae1h = mean(a.mae1h);
        a.effectiveCapture = a.n > 0 ? (a.nearCnt1h > 0 ? (a.nearHit1h * a.triggerRate) : 0) : 0;
        a.trigRate15m = a.n > 0 ? a.trig15m / a.n : 0;
        a.trigRate30m = a.n > 0 ? a.trig30m / a.n : 0;
        a.trigRate1h = a.n > 0 ? a.trig1h / a.n : 0;
        a.trigRate4h = a.n > 0 ? a.trig4h / a.n : 0;
    });
    return out;
}

/** 在 [from,to] 区间内 near 是否被命中 */
function nearHitInRange(nearTarget, direction, candles, from, to) {
    if (nearTarget === null || nearTarget === undefined) return false;
    var bullish = direction === 'BULLISH';
    for (var j = from; j <= to; j++) {
        var c = candles[j];
        if (!c) break;
        if (bullish && c.high >= nearTarget) return true;
        if (!bullish && c.low <= nearTarget) return true;
    }
    return false;
}

function median(arr) {
    if (!arr || arr.length === 0) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(arr) {
    if (!arr || arr.length === 0) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

module.exports = {
    MODELS: MODELS,
    HORIZON_BARS: HORIZON_BARS,
    OTE_DEPTH: OTE_DEPTH,
    computeTriggerPrices: computeTriggerPrices,
    candleTriggers: candleTriggers,
    simulateOne: simulateOne,
    simulateAll: simulateAll,
    assess: assess
};
