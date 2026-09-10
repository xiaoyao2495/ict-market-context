'use strict';

var path = require('path');

module.exports = function loadEnv() {
    if (typeof process.loadEnvFile !== 'function') {
        throw new Error('DOTENV_LOADER_REQUIRES_NODE_20_12_OR_NEWER');
    }
    try {
        process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
    } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
};
