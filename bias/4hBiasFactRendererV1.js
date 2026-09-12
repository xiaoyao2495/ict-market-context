'use strict';

var VERSION = '4H_BIAS_FACT_RENDERER_V1';

function numberText(value, signed) {
    if (value === null) return 'null';
    if (typeof value !== 'number' || !isFinite(value)) throw new Error('4H_BIAS_FACT_RENDER_NON_FINITE');
    if (Object.is(value, -0) || value === 0) return '0';
    var rendered = String(value);
    return signed && value > 0 ? '+' + rendered : rendered;
}

function lines(facts) {
    if (!facts || typeof facts !== 'object') throw new Error('4H_BIAS_FACTS_REQUIRED');
    return [
        'normalizedDirectionalSpread: ' + numberText(facts.normalizedDirectionalSpread, true),
        'ADX14: ' + numberText(facts.adx14, false),
        'signedMoveAtr24: ' + numberText(facts.signedMoveAtr24, true),
        'signedEfficiency24: ' + numberText(facts.signedEfficiency24, true),
        'theilSenSlope48: ' + numberText(facts.theilSenSlope48, true),
        'structureDirection: ' + String(facts.structureDirection)
    ];
}

module.exports = { VERSION: VERSION, numberText: numberText, lines: lines };
