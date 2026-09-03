'use strict';

/**
 * Parses a `node test/run.js` log into test-summary.json.
 * Handles both custom-wrapper files ("NAME: N passed, M failed") and
 * node:test files ("# tests N / # pass P / # fail F").
 *
 * Usage: node generate_test_summary.js <path-to-log> <out-path>
 */

var fs = require('fs');
var path = require('path');

var logPath = process.argv[2] || '/tmp/fulltestrun2.log';
var outPath = process.argv[3] || path.join(__dirname, 'test-summary.json');
var log = fs.readFileSync(logPath, 'utf8');
var lines = log.split('\n');

var headers = []; // {file, startLine}
var reHeader = /^={6,} (.+\.test\.js) ={6,}$/;
lines.forEach(function (l, i) {
    var m = l.match(reHeader);
    if (m) headers.push({ file: m[1], startLine: i });
});

var files = [];
var totalPassed = 0, totalFailed = 0;

headers.forEach(function (h, idx) {
    var start = h.startLine + 1;
    var end = (idx + 1 < headers.length) ? headers[idx + 1].startLine : lines.length;
    var block = lines.slice(start, end).join('\n');

    var passed = 0, failed = 0, format = 'unknown';

    // node:test style
    var mTests = block.match(/# tests\s+(\d+)/);
    var mPass = block.match(/# pass\s+(\d+)/);
    var mFail = block.match(/# fail\s+(\d+)/);
    if (mPass && mFail) {
        passed = parseInt(mPass[1], 10);
        failed = parseInt(mFail[1], 10);
        format = 'node:test';
    } else {
        // custom wrapper: "NAME: N passed, M failed" (possibly multiple)
        var reCustom = /(\d+)\s+passed,\s*(\d+)\s+failed/g;
        var mm, any = false;
        while ((mm = reCustom.exec(block)) !== null) {
            passed += parseInt(mm[1], 10);
            failed += parseInt(mm[2], 10);
            any = true;
        }
        if (any) format = 'custom-wrapper';
    }

    totalPassed += passed;
    totalFailed += failed;
    files.push({
        file: h.file,
        passed: passed,
        failed: failed,
        status: failed > 0 ? 'FAIL' : (passed > 0 || format !== 'unknown' ? 'PASS' : 'NO_RESULT'),
        format: format
    });
});

var overall = totalFailed === 0;
var summary = {
    task: 'PRODUCTION_HISTORICAL_EXTREME_CC_DYNAMIC_D_V1',
    generatedAt: new Date().toISOString(),
    sourceLog: logPath,
    totalFiles: files.length,
    totalPassed: totalPassed,
    totalFailed: totalFailed,
    overall: overall ? 'PASS' : 'FAIL',
    files: files
};

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
console.log('TEST SUMMARY: ' + (overall ? 'PASS' : 'FAIL') +
    ' — files=' + files.length + ' passed=' + totalPassed + ' failed=' + totalFailed);
if (!overall) {
    console.log('Failing files:');
    files.filter(function (f) { return f.status === 'FAIL'; }).forEach(function (f) {
        console.log('  ' + f.file + ' (' + f.passed + ' passed, ' + f.failed + ' failed)');
    });
}
