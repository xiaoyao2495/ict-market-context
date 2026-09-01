'use strict';

// Historical V2/V3 selector retained for archived audit tooling only.
// Production runtime does not import this module.
var DEPRECATED_FOR_PRODUCTION = true;

var ENV_NAME = 'EQ_PRODUCTION_VERSION';
var DEFAULT_VERSION = 'V3';

function normalize(value) {
    var version = String(value || DEFAULT_VERSION).trim().toUpperCase();
    if (version !== 'V2' && version !== 'V3') {
        throw new Error(ENV_NAME + ' must be V2 or V3 (received ' + version + ')');
    }
    return version;
}

function get(env) {
    var source = env || process.env;
    return normalize(source[ENV_NAME]);
}

module.exports = {
    DEPRECATED_FOR_PRODUCTION: DEPRECATED_FOR_PRODUCTION,
    ENV_NAME: ENV_NAME,
    DEFAULT_VERSION: DEFAULT_VERSION,
    normalize: normalize,
    get: get
};
