'use strict';

// Historical V3 Swing-source selector retained for archived audit tooling only.
// Production runtime does not import this module.
var DEPRECATED_FOR_PRODUCTION = true;

var ENV_NAME = 'EQ_SWING_SOURCE';
var STANDARD = 'STANDARD_CAUSAL_V1';
var LEGACY = 'RAW_LEGACY';
var DEFAULT_SOURCE = STANDARD;

function normalize(value) {
    var source = String(value || DEFAULT_SOURCE).trim().toUpperCase();
    if (source !== STANDARD && source !== LEGACY) {
        throw new Error(ENV_NAME + ' must be ' + STANDARD + ' or ' + LEGACY + ' (received ' + source + ')');
    }
    return source;
}

function get(env) {
    var source = env || process.env;
    return normalize(source[ENV_NAME]);
}

module.exports = {
    DEPRECATED_FOR_PRODUCTION: DEPRECATED_FOR_PRODUCTION,
    ENV_NAME: ENV_NAME,
    STANDARD: STANDARD,
    LEGACY: LEGACY,
    DEFAULT_SOURCE: DEFAULT_SOURCE,
    normalize: normalize,
    get: get
};
