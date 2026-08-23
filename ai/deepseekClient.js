/**
 * DeepSeek API 客户端（Daily Bias audit + live snapshot）
 *
 * 安全纪律（严格遵守）：
 * - API Key 仅从 process.env.DEEPSEEK_API_KEY 读取，绝不硬编码 / 打印 / 落盘。
 * - base url / model 可经环境变量配置，不写死在调用处。
 * - raw response 会保存（供复核），但 response 内不含 key。
 *
 * 设计：OpenAI 兼容 /chat/completions 格式。
 */

var axios = require('axios');
var AUDIT_COMPLETION_TOKEN_LIMIT = 4096;

function getApiKey() {
    var k = process.env.DEEPSEEK_API_KEY;
    if (!k || !k.trim()) {
        var err = new Error('DEEPSEEK_API_KEY 未设置（仅从环境变量读取，不得硬编码）');
        err.code = 'MISSING_API_KEY';
        throw err;
    }
    return k;
}

function getBaseUrl() {
    return process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
}

function getModel() {
    // 默认 deepseek-v4-flash；如需切换其他模型请用 DEEPSEEK_MODEL 环境变量覆盖
    return process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
}

function getTemperature() {
    var t = process.env.DEEPSEEK_TEMPERATURE;
    if (t === undefined || t === null || t === '') return 0;
    var n = Number(t);
    return isFinite(n) ? n : 0;
}

/**
 * 调用 DeepSeek chat completion（JSON 模式）
 * @param {Object} opts { systemPrompt, userPrompt, temperature }
 * @param {Object} [retry] 内部重试控制
 * @returns {Promise<{raw:Object, text:string}>} raw = 完整 API 响应体（不含 key）
 */
function chat(opts, retry) {
    var attempts = (retry && retry.attempts) || 0;
    var maxAttempts = (retry && retry.maxAttempts != null) ? retry.maxAttempts : 2;
    var base = getBaseUrl();
    var url = base.replace(/\/$/, '') + '/chat/completions';

    var payload = {
        model: getModel(),
        messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user', content: opts.userPrompt }
        ],
        temperature: opts.temperature != null ? opts.temperature : getTemperature(),
        // DeepSeek 支持 JSON Output：引导模型只返回 JSON
        response_format: { type: 'json_object' },
        // 关键：deepseek-v4-flash 默认开启 thinking 模式，会生成大量 reasoning_tokens
        // （实测单次 completion ~22K tokens，响应极慢 → 触发网关空 200 超时）。
        // 审计只需最终 JSON，关闭 thinking，响应降至数百 token、秒回。
        thinking: { type: 'disabled' },
        // 兜底上限，防止任何意外长输出拖超时
        max_tokens: opts.maxTokens != null ? opts.maxTokens : AUDIT_COMPLETION_TOKEN_LIMIT
    };

    var cfg = {
        headers: {
            'Authorization': 'Bearer ' + getApiKey(),
            'Content-Type': 'application/json'
        },
        timeout: 60000,
        // 改用 text：避免 axios 自动 JSON 解析在异常响应下把 data 变 undefined，
        // 导致错误黑洞。我们自己拿原始文本再 parse。
        responseType: 'text',
        // 不挑 content-type，任何返回都当文本读
        transformResponse: function (d) { return d; },
        // 关键：DeepSeek 本机可直连，但环境可能常驻 HTTPS_PROXY/HTTP_PROXY（如 7890）。
        // 代理对 api.deepseek.com 返回空 200 会导致全部失败。强制忽略环境变量代理，直连。
        proxy: false
    };

    function describeError(error) {
        // 把真实情况打全，区分三类：
        //  A) 有 HTTP 响应（error.response 存在）→ 业务/网关错误，带真实 status + body 文本
        //  B) 无 HTTP 响应（网络/超时/TLS/解析）→ error.message
        //  C) 200 但响应体为空/非 JSON → 单独提示
        if (error.response) {
            var st = error.response.status;
            var rawText = error.response.data;
            if (typeof rawText !== 'string') {
                try { rawText = JSON.stringify(rawText); } catch (e) { rawText = String(rawText); }
            }
            if (st === 200 && (!rawText || rawText.trim() === '')) {
                return {
                    code: 'EMPTY_200',
                    message: 'DeepSeek 返回 HTTP 200 但响应体为空（可能是模型/参数不被支持导致空响应）',
                    status: 200,
                    rawText: rawText || ''
                };
            }
            return {
                code: 'HTTP_' + st,
                message: 'HTTP ' + st + ' ' + (rawText || '(无响应体)'),
                status: st,
                rawText: rawText || ''
            };
        }
        return {
            code: 'NETWORK_ERROR',
            message: '网络/超时/连接错误：' + error.message,
            status: undefined,
            rawText: ''
        };
    }

    return axios.post(url, payload, cfg).then(function (response) {
        var rawText = response.data;
        if (typeof rawText !== 'string') {
            try { rawText = JSON.stringify(rawText); } catch (e) { rawText = String(rawText); }
        }
        if (response.status === 200 && (!rawText || rawText.trim() === '')) {
            var e200 = new Error('DeepSeek 返回 HTTP 200 但响应体为空');
            e200.code = 'EMPTY_200';
            e200.status = 200;
            e200.rawText = '';
            throw e200;
        }
        var body;
        try {
            body = JSON.parse(rawText);
        } catch (e) {
            var eParse = new Error('API 响应不是合法 JSON：' + rawText.slice(0, 300));
            eParse.code = 'BAD_JSON';
            eParse.status = response.status;
            eParse.rawText = rawText;
            throw eParse;
        }
        var text = null;
        try {
            text = body.choices[0].message.content;
        } catch (e) {
            var err = new Error('API 响应结构异常：缺少 choices[0].message.content；原始=' + rawText.slice(0, 300));
            err.code = 'BAD_RESPONSE';
            err.status = response.status;
            err.rawText = rawText;
            throw err;
        }
        return {
            raw: body,
            text: text,
            rawText: rawText,
            completionTokenLimit: payload.max_tokens
        };
    }).catch(function (error) {
        var d = describeError(error);
        var isRetryable = (d.code === 'NETWORK_ERROR' || d.code === 'EMPTY_200') ||
            (d.status === 429 || d.status === 500 || d.status === 502 || d.status === 503);
        if (attempts < maxAttempts && isRetryable) {
            return chat(opts, { attempts: attempts + 1, maxAttempts: maxAttempts });
        }
        var err = new Error('DeepSeek 调用失败（attempts=' + (attempts + 1) + '）：' + d.message);
        err.code = d.code;
        err.status = d.status;
        err.rawText = d.rawText;
        throw err;
    });
}

module.exports = {
    chat: chat,
    getBaseUrl: getBaseUrl,
    getModel: getModel,
    getTemperature: getTemperature,
    getAuditCompletionTokenLimit: function () { return AUDIT_COMPLETION_TOKEN_LIMIT; }
};
