/**
 * Opportunity grouped directly by Canonical Displacement.
 *
 * ICT 自然父级链：
 *   Sweep → Canonical Displacement → FVG1 / FVG2 / FVG3
 *
 * 同一 Canonical Displacement 产生的多个 FVG
 * 只算一个 Opportunity —— 连续 5 根上涨留下 3 个 FVG，不应是 3 个互相独立的
 * 入场机会。Canonical identity 是后续去重单位。
 *
 * 本模块只做诊断统计 + 提供分组，不改变正式 Entry/交易逻辑。
 */
/**
 * @param {string} symbol
 * @param {Array} fvgs      FVG 数组（getAll(symbol)）
 * @param {Object} events   { DISPLACEMENT: [...] }（getByType）
 * @returns {Array} opportunities [{ id, canonicalDisplacementId, direction, fvgIds, createdAt, lastAt }]
 */
function buildOpportunities(symbol, fvgs, events) {
    var displacements = (events && events.DISPLACEMENT || []).slice().sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id);
    });
    var byId = {};
    displacements.forEach(function (d) { byId[d.id] = d; });
    var oppById = {};
    (fvgs || []).forEach(function (f) {
        var displacement = f.displacementEventId && byId[f.displacementEventId];
        if (!displacement) return;
        var o = oppById[displacement.id];
        if (!o) o = oppById[displacement.id] = {
            id: 'DISPLACEMENT:' + displacement.id,
            canonicalDisplacementId: displacement.id,
            direction: displacement.direction,
            displacement: displacement,
            fvgIds: [], createdAt: Infinity, lastAt: 0
        };
        o.fvgIds.push(f.id);
        o.createdAt = Math.min(o.createdAt, f.confirmedAt);
        o.lastAt = Math.max(o.lastAt, f.confirmedAt);
    });
    var opps = Object.keys(oppById).map(function (id) { return oppById[id]; });
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
    summarizeOpportunities: summarizeOpportunities
};
