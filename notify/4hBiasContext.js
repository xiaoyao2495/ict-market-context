'use strict';

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
    output.push('方向: ' + icon + bias.semantic.direction);
    output.push('力度: ' + bias.semantic.strength);
    output.push('置信: ' + bias.semantic.confidence);
    output.push('解读: ' + bias.semantic.summary);
    if (bias.semantic.conflicts && bias.semantic.conflicts.trim() && bias.semantic.conflicts.trim().toUpperCase() !== 'NONE') {
        output.push('冲突: ' + bias.semantic.conflicts);
    }
    return output;
}

module.exports = { attach: attach, lines: lines };
