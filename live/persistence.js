/**
 * Phase 11L — 状态持久化（Windows/Linux 通用，纯 fs）
 *   - candles.jsonl：已收盘 5m 追加式日志（重启恢复：读尾部 N 根重放重建状态，幂等）
 *   - pushed.json：已推送 opportunityId 集合（去重跨重启）
 *   - pushed-candles.json：最后落盘位置（lastCloseTime，避免重复拉取）
 */
var fs = require('fs');
var path = require('path');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback !== undefined ? fallback : null;
    }
}

function saveJson(file, obj) {
    ensureDir(path.dirname(file));
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
}

function appendCandles(file, candles) {
    if (!candles || candles.length === 0) return;
    ensureDir(path.dirname(file));
    var lines = candles.map(function (c) { return JSON.stringify(c); }).join('\n');
    fs.appendFileSync(file, lines + '\n');
}

function loadCandles(file) {
    if (!fs.existsSync(file)) return [];
    try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    } catch (e) {
        return [];
    }
}

module.exports = {
    ensureDir: ensureDir,
    loadJson: loadJson,
    saveJson: saveJson,
    appendCandles: appendCandles,
    loadCandles: loadCandles
};
