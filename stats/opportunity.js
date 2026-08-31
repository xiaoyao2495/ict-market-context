/**
 * Phase 11D.3 — Opportunity / DisplacementLeg（ICT 父级）
 *
 * ICT 自然父级链：
 *   Sweep → Displacement Leg → FVG1 / FVG2 / FVG3
 *
 * 同一 Displacement Leg（连续同向 displacement，时间窗口内合并）产生的多个 FVG
 * 只算一个 Opportunity —— 连续 5 根上涨留下 3 个 FVG，不应是 3 个互相独立的
 * 入场机会。Opportunity 是后续钉钉推送（WATCH / HIGH_QUALITY_WATCH）的去重单位。
 *
 * 本模块只做诊断统计 + 提供分组，不改变正式 Entry/交易逻辑。
 */
var LEG_MERGE_MS = 3 * 300000; // 相邻同向 displacement 合并窗口（3 根 5m = 15 分钟）

/**
 * @param {string} symbol
 * @param {Array} fvgs      FVG 数组（getAll(symbol)）
 * @param {Object} events   { DISPLACEMENT: [...] }（getByType）
 * @returns {Array} opportunities [{ id, direction, legIds, fvgIds, createdAt, lastAt, nLegs }]
 */
function buildOpportunities(symbol, fvgs, events) {
    var displacements = (events && events.DISPLACEMENT || []).slice()
        .sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });

    // 1. displacement → leg 合并（同向 + 连续窗口）
    var legs = [];
    displacements.forEach(function (d) {
        var last = legs.length > 0 ? legs[legs.length - 1] : null;
        if (last && last.direction === d.direction &&
            (d.confirmedAt - last.lastConfirmedAt) <= LEG_MERGE_MS) {
            last.ids.push(d.id);
            last.lastConfirmedAt = d.confirmedAt;
        } else {
            legs.push({
                ids: [d.id],
                direction: d.direction,
                firstConfirmedAt: d.confirmedAt,
                lastConfirmedAt: d.confirmedAt
            });
        }
    });
    var legByDispId = {};
    legs.forEach(function (l) {
        l.ids.forEach(function (id) { legByDispId[id] = l; });
    });

    // 2. FVG 归属 opportunity
    var oppByKey = {};
    var opps = [];
    function oppFor(key) {
        if (!oppByKey[key]) {
            var o = {
                id: key,
                direction: null,
                legIds: [],
                fvgIds: [],
                createdAt: Infinity,
                lastAt: 0,
                nLegs: 0
            };
            oppByKey[key] = o;
            opps.push(o);
        }
        return oppByKey[key];
    }
    (fvgs || []).forEach(function (f) {
        var leg = f.displacementEventId ? legByDispId[f.displacementEventId] : null;
        var o;
        if (leg) {
            var key = 'LEG:' + leg.ids[0];
            o = oppFor(key);
            o.direction = leg.direction;
            if (o.legIds.indexOf(leg.ids[0]) === -1) {
                o.legIds = o.legIds.concat(leg.ids);
                o.nLegs++;
            }
        } else {
            var key2 = 'FVG:' + f.id;
            o = oppFor(key2);
            o.direction = f.direction;
        }
        o.fvgIds.push(f.id);
        o.createdAt = Math.min(o.createdAt, f.confirmedAt);
        o.lastAt = Math.max(o.lastAt, f.confirmedAt);
    });

    // 3. 排序 + 清洗
    opps.sort(function (a, b) { return a.createdAt - b.createdAt; });
    return opps;
}

/**
 * 机会统计（报告用）
 * @returns {Object} { opportunities, totalFvgs, multiFvgOpps, avgFvgPerOpp }
 */
function summarizeOpportunities(opps) {
    var totalFvgs = 0;
    var multiFvgOpps = 0;
    opps.forEach(function (o) {
        totalFvgs += o.fvgIds.length;
        if (o.fvgIds.length > 1) multiFvgOpps++;
    });
    return {
        opportunities: opps.length,
        totalFvgs: totalFvgs,
        multiFvgOpps: multiFvgOpps,
        avgFvgPerOpp: opps.length > 0 ? totalFvgs / opps.length : 0
    };
}

module.exports = {
    buildOpportunities: buildOpportunities,
    summarizeOpportunities: summarizeOpportunities,
    LEG_MERGE_MS: LEG_MERGE_MS
};
