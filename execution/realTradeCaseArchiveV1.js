'use strict';

var fs = require('fs');
var path = require('path');

function createArchive(options) {
    var directory = options && options.directory;
    if (!directory) throw new Error('REAL_TRADE_CASE_ARCHIVE_PATH_REQUIRED');
    return { append: function (trade) {
        if (!trade || !trade.tradeCaseId || !/^REAL_TRADE_CASE_[A-Za-z0-9_-]+$/.test(trade.tradeCaseId)) {
            throw new Error('REAL_TRADE_CASE_ID_INVALID');
        }
        fs.mkdirSync(directory, { recursive: true });
        var file = path.join(directory, trade.tradeCaseId + '.jsonl');
        fs.appendFileSync(file, JSON.stringify({ appendedAt: Date.now(), trade: trade }) + '\n', { mode: 0o600 });
        return file;
    } };
}

module.exports = { createArchive: createArchive };
