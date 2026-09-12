'use strict';

var factRenderer = require('../bias/4hBiasFactRendererV1');

function attach(event, bias) {
    return Object.assign({}, event, { current4hBias: bias || null });
}

function lines(bias) {
    var output = ['📊 4H Bias'];
    if (!bias || bias.status === 'UNAVAILABLE') {
        output.push('暂不可用');
        return output;
    }
    if (bias.status === 'PARTIAL' || !bias.semantic) {
        output.push('语义解析暂不可用');
        return output;
    }
    var icon = bias.semantic.direction === 'BULLISH' ? '🟢 ' :
        bias.semantic.direction === 'BEARISH' ? '🔴 ' : '⚪ ';
    output.push('Semantic Decision:');
    output.push('方向: ' + icon + bias.semantic.direction);
    output.push('力度: ' + bias.semantic.strength);
    output.push('置信: ' + bias.semantic.confidence);
    if (bias.facts) {
        output.push('Deterministic Facts:');
        Array.prototype.push.apply(output, factRenderer.lines(bias.facts));
    }
    return output;
}

module.exports = { attach: attach, lines: lines };
