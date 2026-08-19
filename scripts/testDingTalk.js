/**
 * 钉钉 webhook 通路自检（GO-LIVE 验证用，一次性）
 *
 * 用法（Windows CMD，与 pm2 启动同一个 webhook）：
 *   set DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN
 *   node scripts/testDingTalk.js
 *
 * 或改用 config/live.local.json（gitignored）：
 *   { "dingtalk": { "webhook": "...", "secret": "..." } }
 *
 * 发送一条带关键词（config/live.json 的 dingtalk.keyword，默认「检测」）的测试消息
 * （非真实机会，不进 outbox/pushed）。
 * 输出：
 *   OK    → errcode=0（钉钉确认收到，通路正常）
 *   FAIL  → 错误码 + 原因（关键词不匹配 310000 / 加签失败 310000 / 网络错误）
 *
 * 消息故意标注"上线自检·非真实机会"，避免与真实 HIGH 混淆。
 */
var fs = require('fs');
var path = require('path');
var dingTalk = require('../notify/dingTalk');
var liveConfig = require('../config/live.json');

var webhook = process.env.DINGTALK_WEBHOOK || '';
var secret = process.env.DINGTALK_SECRET || '';

// 环境变量缺失 → 尝试 config/live.local.json（gitignored，token 不进仓库）
if (!webhook || webhook.indexOf('YOUR_ACCESS_TOKEN') !== -1) {
    var localFile = path.join(__dirname, '..', 'config', 'live.local.json');
    if (fs.existsSync(localFile)) {
        try {
            var lc = JSON.parse(fs.readFileSync(localFile, 'utf8'));
            if (lc.dingtalk) {
                if (!webhook && lc.dingtalk.webhook) webhook = lc.dingtalk.webhook;
                if (!secret && lc.dingtalk.secret) secret = lc.dingtalk.secret;
            }
        } catch (e) {
            console.error('config/live.local.json 解析失败:', e.message);
        }
    }
}

if (!webhook || webhook.indexOf('YOUR_ACCESS_TOKEN') !== -1) {
    console.error('未找到 DINGTALK_WEBHOOK（环境变量或 config/live.local.json 均无有效值）');
    process.exit(1);
}

var keyword = (liveConfig.dingtalk && liveConfig.dingtalk.keyword) || '检测';
var now = new Date(Date.now() + 8 * 3600000); // UTC+8
function p2(n) { return n < 10 ? '0' + n : String(n); }
var ts = now.getUTCFullYear() + '-' + p2(now.getUTCMonth() + 1) + '-' + p2(now.getUTCDate()) +
    ' ' + p2(now.getUTCHours()) + ':' + p2(now.getUTCMinutes()) + ' (UTC+8)';

var content = [
    '🔴 ' + keyword + ' · 上线自检（非真实机会）',
    'ICT 机会雷达 webhook 通路测试',
    '时间: ' + ts,
    '若你能看到本条，说明钉钉推送链路正常。'
].join('\n');

console.log('发送测试消息到钉钉（关键词「' + keyword + '」）...');
dingTalk.sendText(webhook, secret, content).then(function (res) {
    console.log('OK errcode=' + res.errcode + ' errmsg=' + res.errmsg + ' —— 钉钉已确认收到，通路正常');
}).catch(function (e) {
    console.error('FAIL ' + e.message);
    console.error('检查：① webhook token 是否正确 ② 机器人安全设置是"关键词"还是"加签"（加签需配置 secret）');
    process.exit(1);
});
