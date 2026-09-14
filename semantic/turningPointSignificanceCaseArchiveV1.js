'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — semantic case archive.
 *
 * Every raw Dynamic-D candidate is preserved. A candidate excluded by the
 * significance filter is archived as TURNING_SIGNIFICANCE_BLOCK_CASE_*, and one
 * that hydrates through the semantic layer as
 * TURNING_SIGNIFICANCE_CANDIDATE_CASE_*. Files are create-only (wx), so an
 * archive record can never be overwritten by a later run.
 */

var fs = require('fs');
var path = require('path');

var VERSION = 'TURNING_SIGNIFICANCE_CASE_ARCHIVE_V1';

function createArchive(options) {
    var directory = options && options.directory;
    if (!directory) throw new Error('TURNING_SIGNIFICANCE_CASE_ARCHIVE_PATH_REQUIRED');
    function write(record) {
        fs.mkdirSync(directory, { recursive: true });
        var prefix = record.eligible === true
            ? 'TURNING_SIGNIFICANCE_CANDIDATE_CASE_'
            : 'TURNING_SIGNIFICANCE_BLOCK_CASE_';
        var file = path.join(directory, prefix + record.decisionKey + '.json');
        try { fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return file;
    }
    return { write: write, directory: directory };
}

module.exports = { VERSION: VERSION, createArchive: createArchive };
