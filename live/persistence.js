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

/** Replace the candle log atomically after bounded-retention compaction. */
function replaceCandles(file, candles) {
    ensureDir(path.dirname(file));
    var rows = candles || [];
    var body = rows.map(function (c) { return JSON.stringify(c); }).join('\n');
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, body.length > 0 ? body + '\n' : '');
    fs.renameSync(tmp, file);
}

/**
 * 读取 candles.jsonl（逐行容错，Phase 11L.7 P1）。
 *
 * 崩溃恢复语义：
 *   - 尾部残缺（最后一行非空但 JSON 解析失败，通常是掉电时写一半）→ 丢弃该行并记录
 *     truncatedLines（appendCandles 下次会重写该根；不把整段持久历史当空数据）
 *   - 中间行损坏（非末尾行 JSON 解析失败）→ 抛错 fail-closed（历史中间缺根不可静默丢弃，
 *     必须显式处理，防止带着 gap 继续算 Pivot/ATR/Displacement/FVG）
 *
 * @returns {Object} { candles: Array, truncatedLines: Number }
 * @throws {Error} 中间行损坏
 */
function loadCandles(file) {
    if (!fs.existsSync(file)) return { candles: [], truncatedLines: 0 };
    var raw = fs.readFileSync(file, 'utf8');
    var lines = raw.split('\n');
    // 去除末尾空行（正常文件以 \n 结尾）
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    var candles = [];
    var truncated = 0;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') continue;
        var parsed = null;
        try {
            parsed = JSON.parse(line);
        } catch (e) {
            if (i === lines.length - 1) {
                // 尾部残缺（掉电写一半）：丢弃 + 警告（不 fail-closed，重启后 append 会补）
                truncated++;
                continue;
            }
            throw new Error('candles.jsonl 中间行损坏（line ' + (i + 1) + '）——fail-closed，请人工检查文件');
        }
        candles.push(parsed);
    }
    if (truncated > 0) {
        // 物理截断：把残缺行从磁盘移除，否则后续 append 会与残行粘连成一行坏 JSON
        var clean = candles.map(function (c) { return JSON.stringify(c); }).join('\n');
        fs.writeFileSync(file, clean.length > 0 ? clean + '\n' : '');
        console.warn('[persistence] candles.jsonl 尾部 ' + truncated + ' 行残缺已丢弃并截断，重启后自动补齐');
    }
    return { candles: candles, truncatedLines: truncated };
}

module.exports = {
    ensureDir: ensureDir,
    loadJson: loadJson,
    saveJson: saveJson,
    appendCandles: appendCandles,
    replaceCandles: replaceCandles,
    loadCandles: loadCandles
};
