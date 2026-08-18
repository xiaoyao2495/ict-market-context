/**
 * 测试运行器：依次执行 test/ 下所有 *.test.js
 * 用法：node test/run.js
 */
var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var testDir = __dirname;
var files = fs
    .readdirSync(testDir)
    .filter(function (f) {
        return /\.test\.js$/.test(f);
    })
    .sort();

if (files.length === 0) {
    console.log('No test files found.');
    process.exit(1);
}

var allPassed = true;
files.forEach(function (file) {
    console.log('================== ' + file + ' ==================');
    var result = cp.spawnSync(process.execPath, [path.join(testDir, file)], {
        stdio: 'inherit'
    });
    if (result.status !== 0) {
        allPassed = false;
    }
    console.log('');
});

if (allPassed) {
    console.log('ALL TESTS PASSED');
} else {
    console.log('SOME TESTS FAILED');
    process.exit(1);
}
