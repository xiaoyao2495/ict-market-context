'use strict';

var ENV_NAME = 'WATCH_LIQUIDITY_EVIDENCE_V1_ENABLED';

function isEnabled(env) {
    var source = env || process.env;
    return source[ENV_NAME] === '1' || source[ENV_NAME] === 'true';
}

module.exports = {
    ENV_NAME: ENV_NAME,
    DEFAULT_ENABLED: false,
    isEnabled: isEnabled
};
