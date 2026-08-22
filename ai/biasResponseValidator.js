/**
 * DeepSeek Bias 响应校验（方案 Z）
 *
 * 目标：在把 rawResponse 当 parsedResponse 使用前，验证其结构满足最低契约。
 * 不静默接受 malformed JSON（§18）。
 *
 * 校验范围：
 * - bias ∈ {BULLISH, BEARISH, UNCLEAR}
 * - confidence ∈ {HIGH, MEDIUM, LOW}
 * - 各结构数组字段存在（可为空）
 * - 引用类对象（swing / sweep / mss / displacement / fvg / draw）必须带具体 price + time
 * - dealingRange 必须带 high/low/equilibrium/location
 */

var BIAS_VALUES = ['BULLISH', 'BEARISH', 'UNCLEAR'];
var CONF_VALUES = ['HIGH', 'MEDIUM', 'LOW'];
var LOC_VALUES = ['PREMIUM', 'EQUILIBRIUM', 'DISCOUNT'];
var SIDE_VALUES = ['BSL', 'SSL'];
// mssAssessment：AI 对 code-supplied mssCandidate 的解释层评估（非确定性事实）
var MSS_ASSESS_VALUES = ['LIKELY_MSS', 'NOT_MSS', 'UNCERTAIN'];

function isNum(x) { return typeof x === 'number' && isFinite(x); }
function isStr(x) { return typeof x === 'string' && x.length > 0; }

function fail(msg) {
    var e = new Error('schema validation failed: ' + msg);
    e.code = 'SCHEMA_INVALID';
    return e;
}

function samePrice(a, b) {
    var scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) <= scale * 1e-10;
}

function validateDrawTarget(draw, marketFacts) {
    if (!marketFacts) return;
    if (draw.direction === 'NONE') return;
    if (draw.direction !== 'UP' && draw.direction !== 'DOWN') return;

    var expectedSide = draw.direction === 'UP' ? 'HIGH' : 'LOW';
    var matches = (marketFacts.sweeps || []).filter(function (s) {
        return s.refSide === expectedSide && isNum(s.pivotPrice) &&
            samePrice(s.pivotPrice, draw.targetPrice);
    });
    var intact = matches.some(function (s) { return s.status === 'INTACT'; });
    if (!intact) {
        var taken = matches.some(function (s) { return s.status === 'TAKEN'; });
        throw fail(taken
            ? 'drawOnLiquidity.targetPrice 指向 TAKEN liquidity；target 必须是 INTACT 或 NONE'
            : 'drawOnLiquidity.targetPrice 未对应任何 INTACT liquidity；target 必须是 INTACT 或 NONE');
    }
}

// 校验单个带 price+time 的引用对象
function checkPricedTime(obj, label, requireTime) {
    if (obj === null || typeof obj !== 'object') {
        throw fail(label + ' 必须是对象');
    }
    if (!isNum(obj.price)) {
        throw fail(label + '.price 必须是数字（' + JSON.stringify(obj) + '）');
    }
    if (requireTime && !isStr(obj.time)) {
        throw fail(label + '.time 必须是 ISO 字符串（' + JSON.stringify(obj) + '）');
    }
}

function validate(parsed, opts) {
    var o = opts || {};
    if (parsed === null || typeof parsed !== 'object') {
        throw fail('根节点必须是对象');
    }
    if (BIAS_VALUES.indexOf(parsed.bias) < 0) {
        throw fail('bias 必须是 BULLISH|BEARISH|UNCLEAR，实际=' + JSON.stringify(parsed.bias));
    }
    if (CONF_VALUES.indexOf(parsed.confidence) < 0) {
        throw fail('confidence 必须是 HIGH|MEDIUM|LOW，实际=' + JSON.stringify(parsed.confidence));
    }

    // 契约约束：当 marketFacts 由代码提供（strictMssEmpty=true）时，
    // delivery.mss 必须为空数组 —— 唯一合法的 MSS 来源是 deterministic
    // classification=MSS，而半保守版不产出 MSS，故 AI 不得把任何
    // mssCandidate 升级为 confirmed MSS 写进 delivery.mss。
    if (o.strictMssEmpty && Array.isArray((parsed.delivery || {}).mss) &&
        (parsed.delivery.mss).length > 0) {
        throw fail('marketFacts 已提供时 delivery.mss 必须为空（AI 不得把 mssCandidate 升级为 confirmed MSS）；' +
            'candidate 评估请写在 mssAssessment 字段');
    }

    var is = parsed.identifiedStructure || {};
    var liq = parsed.liquidity || {};
    var imb = parsed.imbalances || {};
    var del = parsed.delivery || {};
    var dr = parsed.dealingRange || {};
    var draw = parsed.drawOnLiquidity || {};

    // identifiedStructure
    (is.majorSwingHighs || []).forEach(function (o, i) {
        checkPricedTime(o, 'identifiedStructure.majorSwingHighs[' + i + ']', true);
    });
    (is.majorSwingLows || []).forEach(function (o, i) {
        checkPricedTime(o, 'identifiedStructure.majorSwingLows[' + i + ']', true);
    });
    if (is.structureState !== undefined &&
        BIAS_VALUES.indexOf(is.structureState) < 0) {
        throw fail('identifiedStructure.structureState 非法');
    }

    // liquidity：buySide / sellSide 带 price+time；recentSweeps 带 side/price/time
    (liq.buySide || []).forEach(function (o, i) {
        checkPricedTime(o, 'liquidity.buySide[' + i + ']', true);
    });
    (liq.sellSide || []).forEach(function (o, i) {
        checkPricedTime(o, 'liquidity.sellSide[' + i + ']', true);
    });
    (liq.recentSweeps || []).forEach(function (o, i) {
        if (SIDE_VALUES.indexOf(o.side) < 0) {
            throw fail('liquidity.recentSweeps[' + i + '].side 必须是 BSL|SSL');
        }
        checkPricedTime({ price: o.liquidityPrice }, 'liquidity.recentSweeps[' + i + '].liquidityPrice', false);
        if (!isStr(o.sweepTime)) {
            throw fail('liquidity.recentSweeps[' + i + '].sweepTime 必须是 ISO 字符串');
        }
    });

    // imbalances：FVG 带 top/bottom/time
    (imb.bullishFvg || []).concat(imb.bearishFvg || []).forEach(function (o, i) {
        if (!isNum(o.top) || !isNum(o.bottom)) {
            throw fail('imbalances FVG[' + i + '] 必须带 top/bottom 数字');
        }
        if (!isStr(o.time)) {
            throw fail('imbalances FVG[' + i + '].time 必须是 ISO 字符串');
        }
    });

    // delivery：mss / displacement
    (del.mss || []).forEach(function (o, i) {
        if (BIAS_VALUES.indexOf(o.type) < 0) {
            throw fail('delivery.mss[' + i + '].type 必须是 BULLISH|BEARISH|UNCLEAR');
        }
        if (!isNum(o.brokenSwingPrice)) {
            throw fail('delivery.mss[' + i + '].brokenSwingPrice 必须是数字');
        }
        if (!isStr(o.breakTime)) {
            throw fail('delivery.mss[' + i + '].breakTime 必须是 ISO 字符串');
        }
    });
    (del.displacement || []).forEach(function (o, i) {
        if (BIAS_VALUES.indexOf(o.direction) < 0) {
            throw fail('delivery.displacement[' + i + '].direction 必须是 BULLISH|BEARISH|UNCLEAR');
        }
        if (!isStr(o.startTime) || !isStr(o.endTime)) {
            throw fail('delivery.displacement[' + i + '] 必须带 startTime/endTime ISO 字符串');
        }
    });
    if (del.currentDelivery !== undefined &&
        BIAS_VALUES.indexOf(del.currentDelivery) < 0) {
        throw fail('delivery.currentDelivery 非法');
    }

    // mssAssessment：AI 对 code-supplied mssCandidate 的解释层评估。
    // 每项必须含 level（数字）、assessment ∈ {LIKELY_MSS,NOT_MSS,UNCERTAIN}、reason（字符串）。
    // 此字段为"解释层"，不进入 delivery.mss（事实层）。
    (parsed.mssAssessment || []).forEach(function (a, i) {
        if (!isNum(a.level)) {
            throw fail('mssAssessment[' + i + '].level 必须是数字');
        }
        if (MSS_ASSESS_VALUES.indexOf(a.assessment) < 0) {
            throw fail('mssAssessment[' + i + '].assessment 必须是 LIKELY_MSS|NOT_MSS|UNCERTAIN，实际=' +
                JSON.stringify(a.assessment));
        }
        if (!isStr(a.reason)) {
            throw fail('mssAssessment[' + i + '].reason 必须是字符串');
        }
    });

    // dealingRange
    if (!isNum(dr.high) || !isNum(dr.low) || !isNum(dr.equilibrium)) {
        throw fail('dealingRange 必须带 high/low/equilibrium 数字');
    }
    if (LOC_VALUES.indexOf(dr.location) < 0) {
        throw fail('dealingRange.location 必须是 PREMIUM|EQUILIBRIUM|DISCOUNT');
    }

    // drawOnLiquidity
    if (draw.direction !== undefined &&
        ['UP', 'DOWN', 'NONE'].indexOf(draw.direction) < 0) {
        throw fail('drawOnLiquidity.direction 非法');
    }
    if (draw.direction === 'UP' || draw.direction === 'DOWN') {
        if (!isNum(draw.targetPrice)) {
            throw fail('drawOnLiquidity.targetPrice 必须是数字（当 direction 非 NONE）');
        }
    }
    validateDrawTarget(draw, o.marketFacts);

    if (!isStr(parsed.biasReason)) {
        throw fail('biasReason 必须是字符串');
    }
    if (!Array.isArray(parsed.supportingEvidence)) {
        throw fail('supportingEvidence 必须是数组');
    }
    if (!Array.isArray(parsed.conflicts)) {
        throw fail('conflicts 必须是数组');
    }

    return true; // 校验通过
}

/**
 * 解析 + 校验。text 为模型原始文本（应已是 JSON 字符串）。
 * 解析失败或 schema 不合法 → 抛错（不静默接受）。
 */
function parseAndValidate(text, opts) {
    var parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        var err = new Error('JSON 解析失败：' + e.message);
        err.code = 'MALFORMED_JSON';
        throw err;
    }
    validate(parsed, opts);
    return parsed;
}

module.exports = {
    validate: validate,
    parseAndValidate: parseAndValidate,
    BIAS_VALUES: BIAS_VALUES,
    CONF_VALUES: CONF_VALUES
};
