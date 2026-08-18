/**
 * Phase 11L — 钉钉自定义机器人通知（加签安全模式）
 * 安全设置选择"加签"：secret 用于 HMAC-SHA256 签名（timestamp\nsecret）。
 */
var crypto = require('crypto');

function sign(secret, timestamp) {
    var str = timestamp + '\n' + secret;
    var hmac = crypto.createHmac('sha256', secret).update(str, 'utf8').digest('base64');
    return encodeURIComponent(hmac);
}

function buildUrl(webhook, secret) {
    if (!secret) return webhook; // 未配置加签（关键词模式）：直接使用 webhook
    var ts = Date.now();
    return webhook + '&timestamp=' + ts + '&sign=' + sign(secret, ts);
}

/**
 * 发送文本消息。
 * @param {string} webhook 钉钉机器人 webhook（含 access_token）
 * @param {string} secret 加签密钥
 * @param {string} content 消息文本
 * @returns {Promise<Object>} 钉钉响应 { errcode, errmsg }
 */
function sendText(webhook, secret, content) {
    var url = buildUrl(webhook, secret);
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: content } })
    }).then(function (r) { return r.json(); });
}

module.exports = {
    sign: sign,
    buildUrl: buildUrl,
    sendText: sendText
};
