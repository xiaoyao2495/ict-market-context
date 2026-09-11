#!/usr/bin/env node
'use strict';

require('../config/loadEnv')();
var universe = require('../live/dynamicContractUniverseV1');

var evaluationTime = Date.now();
universe.buildSnapshot({ evaluationTime: evaluationTime }).then(function (snapshot) {
    console.log('VERSION=' + snapshot.version);
    console.log('EVALUATION_TIME=' + new Date(snapshot.evaluationTime).toISOString());
    console.log('WINDOW=6x4H_CLOSED');
    console.log('UNFINISHED_4H_INCLUDED=false');
    console.log('RANK  SYMBOL  QUOTE_VOLUME_24H');
    snapshot.symbols.forEach(function (row) {
        console.log(row.rank + '  ' + row.symbol + '  ' + row.quoteVolume24h);
    });
}).catch(function (error) {
    console.error('UNIVERSE_PREVIEW=FAIL ' + (error && error.message || error));
    process.exitCode = 1;
});
