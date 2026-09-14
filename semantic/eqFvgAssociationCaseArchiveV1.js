'use strict';

var fs = require('fs');
var path = require('path');

function createArchive(options) {
    var directory = options && options.directory;
    if (!directory) throw new Error('EQ_FVG_CASE_ARCHIVE_PATH_REQUIRED');
    function write(record) {
        fs.mkdirSync(directory, { recursive: true });
        var prefix = record.semanticGate === 'BLOCK' ? 'SEMANTIC_BLOCK_CASE_' : 'SEMANTIC_CANDIDATE_CASE_';
        var file = path.join(directory, prefix + record.decisionKey + '.json');
        try { fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return file;
    }
    return { write: write };
}

module.exports = { createArchive: createArchive };
