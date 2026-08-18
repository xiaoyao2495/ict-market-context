/**
 * Bias Explanation —— 从组件结果直接生成可读 evidence
 *
 * Engine 负责判断，Reporter 只负责展示：
 * 输出 { bullish: [], bearish: [], neutral: [], conflicts: [] }
 * 不重复产生相同 reason。
 */
var COMPONENT_LABEL = {
    liquidity: 'Liquidity draw',
    structure: 'HTF structure',
    location: 'Price location',
    delivery: 'Recent delivery'
};

function pushUnique(list, text) {
    if (text && list.indexOf(text) === -1) {
        list.push(text);
    }
}

function reasonText(name, component) {
    var label = COMPONENT_LABEL[name] || name;
    var detail = '';
    if (component.reasons && component.reasons.length > 0) {
        detail = ': ' + component.reasons[0];
    }
    return label + detail;
}

/**
 * @param {Object} input { components, conflicts }
 * @returns {Object} { bullish, bearish, neutral, conflicts }
 */
function buildExplanation(input) {
    var components = input.components || {};
    var out = {
        bullish: [],
        bearish: [],
        neutral: [],
        conflicts: []
    };

    Object.keys(components).forEach(function (name) {
        var c = components[name];
        if (!c || !c.available) {
            return; // 无数据不产生 evidence
        }
        var text = reasonText(name, c);
        if (c.score > 0) {
            pushUnique(out.bullish, text);
        } else if (c.score < 0) {
            pushUnique(out.bearish, text);
        } else {
            pushUnique(out.neutral, text);
        }
    });

    (input.conflicts || []).forEach(function (cf) {
        out.conflicts.push({
            type: cf.type,
            severity: cf.severity,
            reason: cf.reason
        });
    });

    return out;
}

module.exports = {
    buildExplanation: buildExplanation
};
