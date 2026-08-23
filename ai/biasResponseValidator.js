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
 * - AI 不得生成 MSS；structural event references 必须属于 authoritative STRUCTURAL_MSS
 * - 其他引用类对象（swing / sweep / displacement / fvg / draw）必须带具体 price + time
 * - dealingRange 必须带 high/low/equilibrium/location
 */

var structuralEventReference = require('./structuralEventReference');

var BIAS_VALUES = ['BULLISH', 'BEARISH', 'UNCLEAR'];
var CONF_VALUES = ['HIGH', 'MEDIUM', 'LOW'];
var LOC_VALUES = ['PREMIUM', 'EQUILIBRIUM', 'DISCOUNT'];
var SIDE_VALUES = ['BSL', 'SSL'];

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

function sameTime(a, b) {
    var ta = Date.parse(a);
    var tb = Date.parse(b);
    return isFinite(ta) && isFinite(tb) && ta === tb;
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

function structuralFactContradictions(parsed, marketFacts) {
    var out = [];
    if (!parsed || !marketFacts) return out;

    var identified = parsed.identifiedStructure || {};
    var delivery = parsed.delivery || {};
    var references = delivery.referencedStructuralEventIds || [];
    var events = Array.isArray(marketFacts.structuralEvents)
        ? marketFacts.structuralEvents : [];
    var allowedMssIds = structuralEventReference.mssEventIds(events);
    var expectedState = marketFacts.structuralState === 'UNKNOWN'
        ? 'UNCLEAR' : marketFacts.structuralState;

    if (BIAS_VALUES.indexOf(expectedState) >= 0 && identified.structureState !== expectedState) {
        out.push({
            code: 'STRUCTURAL_STATE_MISMATCH',
            message: 'identifiedStructure.structureState 与 authoritative structuralState 不一致；expected=' +
                expectedState + ' actual=' + identified.structureState,
            deterministic: expectedState,
            ai: identified.structureState
        });
    }

    references.forEach(function (eventId, i) {
        if (allowedMssIds.indexOf(eventId) < 0) {
            out.push({
                code: 'UNKNOWN_STRUCTURAL_EVENT_REFERENCE',
                message: 'delivery.referencedStructuralEventIds[' + i +
                    '] 未对应 authoritative STRUCTURAL_MSS eventId',
                ai: eventId
            });
        }
    });

    (Array.isArray(marketFacts.protectedSwings) ? marketFacts.protectedSwings : []).filter(function (s) {
        return s.status === 'ACTIVE_PROTECTED';
    }).forEach(function (s) {
        var list = s.side === 'HIGH'
            ? (identified.majorSwingHighs || [])
            : (identified.majorSwingLows || []);
        var exists = list.some(function (x) {
            return samePrice(x.price, s.price) && sameTime(x.time, s.occurredAt);
        });
        if (!exists) {
            out.push({
                code: 'ACTIVE_PROTECTED_SWING_OMITTED',
                message: 'identifiedStructure 缺少 authoritative ' + s.role +
                    ' @ ' + s.price + ' occurredAt=' + s.occurredAt,
                deterministic: s
            });
        }
    });
    return out;
}

function validateStructuralFacts(parsed, marketFacts) {
    var contradictions = structuralFactContradictions(parsed, marketFacts);
    if (contradictions.length) throw fail(contradictions[0].message);
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

    // delivery：AI 不再生成 MSS，只能引用 authoritative STRUCTURAL_MSS eventId。
    if (Object.prototype.hasOwnProperty.call(del, 'mss')) {
        throw fail('delivery.mss 已删除；AI 不得创建或重建 MSS fact');
    }
    if (!Array.isArray(del.referencedStructuralEventIds)) {
        throw fail('delivery.referencedStructuralEventIds 必须是数组');
    }
    del.referencedStructuralEventIds.forEach(function (eventId, i) {
        if (!isStr(eventId)) {
            throw fail('delivery.referencedStructuralEventIds[' + i + '] 必须是字符串');
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
    if (draw.direction === 'NONE' && draw.targetPrice !== null) {
        throw fail('drawOnLiquidity.direction=NONE 时 targetPrice 必须为 null');
    }
    validateDrawTarget(draw, o.marketFacts);
    validateStructuralFacts(parsed, o.marketFacts);

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
    structuralFactContradictions: structuralFactContradictions,
    BIAS_VALUES: BIAS_VALUES,
    CONF_VALUES: CONF_VALUES
};
