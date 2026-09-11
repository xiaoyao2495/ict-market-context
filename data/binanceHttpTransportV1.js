'use strict';

var axios = require('axios');
var governorModule = require('./binanceRateLimitGovernorV1');

function request(config, options) {
    var opts = options || {};
    var transport = opts.transport || axios;
    var governor = opts.governor || governorModule.globalGovernor;
    var meta = opts.meta || {};
    return governor.execute(meta, function () { return transport.request(config); });
}

module.exports = {
    request: request,
    isRateLimitError: governorModule.isRateLimitError
};
