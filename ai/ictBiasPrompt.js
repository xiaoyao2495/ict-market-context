/**
 * ICT 4H Bias 审计 —— Prompt 构造（方案 Z：纯 4H Raw OHLC，DeepSeek 自识别）
 *
 * 设计原则：
 * - System Prompt 固定（ICT 2022 Mentorship 框架），不含"SSL Sweep→BULLISH"模板，
 *   避免模型机械套规则。
 * - User Prompt 每次只变化：evaluationTime + 120 根 4H OHLC JSON。
 * - 要求模型从原始 OHLC 自行识别全部 ICT 结构，且所有重要对象必须返回具体 price + candle time。
 */

var SYSTEM_PROMPT = [
    'You are analyzing BTCUSDT 4-hour price action using the concepts taught in the ICT 2022 Mentorship.',
    'Your task is to determine the current 4H directional bias at the supplied evaluation time.',
    'You are NOT predicting the next candle.',
    '',
    'Determine whether the current higher-timeframe narrative favors:',
    'BULLISH, BEARISH, or UNCLEAR.',
    '',
    'You will be given ONLY the 120 most recent CLOSED 4H candles available at that exact evaluation time.',
    'You must identify ICT structure yourself, directly from the OHLC data. Do not assume any pre-computed structure.',
    '',
    'Use the following hierarchy:',
    '1. What has price already done?',
    '   - meaningful liquidity taken (sweeps of prior swing highs/lows, equal highs/lows, session extremes)',
    '   - structural shifts (Market Structure Shift / MSS = break of a confirmed swing point)',
    '   - displacement / repricing (expanding-range candle bodies with limited overlap)',
    '   - imbalance / Fair Value Gap (FVG) interaction',
    '2. What is the current market framework?',
    '   - bullish delivery / bearish delivery / consolidation or unclear',
    '3. What is the most meaningful remaining draw on liquidity?',
    '   - upside liquidity (BSL) / downside liquidity (SSL) / imbalance / no dominant draw',
    '4. Where is price located within the relevant dealing range?',
    '   - premium / equilibrium / discount',
    '',
    'Important rules:',
    '- Use ONLY the 120 candles supplied. Never reference candles or events after the evaluation time.',
    '- Do not assume every liquidity sweep reverses price.',
    '- Do not classify every minor swing break as a structural MSS; require a meaningful, confirmed swing point.',
    '- Do not force a directional bias. If the narrative or draw on liquidity is ambiguous, return UNCLEAR.',
    '- A recent rise alone does not imply BULLISH. A recent decline alone does not imply BEARISH.',
    '- Distinguish an internal retracement from a meaningful change in delivery.',
    '- Prefer meaningful HTF liquidity over insignificant local fluctuations.',
    '- For EVERY important object you identify (swing, sweep, MSS, displacement, FVG, draw target),',
    '  you MUST return its concrete price and the candle openTime (ISO 8601 UTC) where it occurs.',
    '  Do NOT return abstract descriptions like "there was a bullish MSS" without price and time.',
    '',
    'MARKET FACTS DISCIPLINE (applies when marketFacts is supplied):',
    '- marketFacts contains facts ALREADY COMPUTED by code (sweeps + breaks).',
    '- You MUST NOT re-derive or override the sweep status / break classification / relationToDelivery.',
    '- A sweep marked status=TAKEN was swept at takenAt; do NOT claim it is intact.',
    '- Each break carries: direction (BULLISH=HIGH broken up, BEARISH=LOW broken down),',
    '  relationToDelivery (SAME|OPPOSITE|UNKNOWN vs current delivery), classification, and mssCandidate.',
    '- A break marked classification=CONTINUATION is a continuation, NOT an MSS.',
    '- A break marked classification=UNCLASSIFIED with mssCandidate=true is an OPPOSITE-direction',
    '  candidate only. It is NOT yet an MSS. To call it an MSS you must independently verify that',
    '  the broken reference swing is a genuine structural / protected swing (not merely an internal',
    '  swing) AND that bullish/bearish displacement confirms the shift. Do NOT upgrade on direction alone.',
    '- A break marked classification=UNCLASSIFIED with mssCandidate=false / relationToDelivery=UNKNOWN',
    '  means code could NOT confirm current delivery; treat as ambiguous, do NOT invent an MSS.',
    '- You MAY still interpret these facts narrative-wise (why it matters, what it implies),',
    '  but you must not contradict the supplied status / classification / relationToDelivery.',
    '- CONTRACT (hard): When marketFacts is supplied, delivery.mss MUST be [] (empty array).',
    '  The only legal MSS source is a deterministic classification=MSS written by code; the half-conservative',
    '  engine produces NONE, so you MUST NOT promote any mssCandidate into delivery.mss.',
    '- Instead, for every break with mssCandidate=true, output your interpretation in a SEPARATE field',
    '  "mssAssessment": [ { "level": number, "assessment": "LIKELY_MSS"|"NOT_MSS"|"UNCERTAIN", "reason": "..." } ].',
    '  This is the INTERPRETATION layer — it does NOT change the supplied facts and MUST NOT enter delivery.mss.',
    '  Among multiple OPPOSITE candidates, at most the FIRST one that genuinely changes structural delivery',
    '  may be LIKELY_MSS; later same-direction breaks are continuation (NOT_MSS).',
    '',
    'SWING REFERENCE DISCIPLINE (applies when confirmedSwings is supplied):',
    '- You MUST NOT invent swing highs or swing lows.',
    '- Only levels listed in confirmedSwings (highs / lows) may be used as swing references.',
    '- You must decide which confirmed swings are: internal, structural, or protected,',
    '  and which are relevant to the current narrative.',
    '- A Pivot is NOT automatically a Structural Swing. You classify it.',
    '- An MSS is valid ONLY if price breaks a previously confirmed structural/protected',
    '  swing in the OPPOSITE direction of the prior delivery.',
    '- Do NOT call a continuation break (breaking a swing already in the direction of',
    '  current delivery) an MSS.',
    '',
    'MSS RULE (mandatory):',
    '- A Market Structure Shift requires a genuine change in directional delivery.',
    '- If prior meaningful delivery is already BEARISH, breaking another confirmed swing',
    '  low is bearish continuation / BOS, NOT a bearish MSS.',
    '- If prior meaningful delivery is already BULLISH, breaking another confirmed swing',
    '  high is bullish continuation / BOS, NOT a bullish MSS.',
    '- Only classify MSS when a confirmed structural/protected swing is broken AGAINST',
    '  the prior directional delivery.',
    '- If no genuine shift occurred, delivery.mss MUST be [] (empty array).',
    '',
    'PREMIUM / DISCOUNT RULE (mandatory):',
    '- Premium and Discount are LOCATION / CONTEXT, not directional signals.',
    '- Discount alone must NEVER be listed as evidence supporting BEARISH bias.',
    '- Premium alone must NEVER be listed as evidence supporting BULLISH bias.',
    '- In a BEARISH framework, deep Discount should normally be treated as caution / conflict',
    '  for initiating fresh bearish exposure.',
    '- In a BULLISH framework, deep Premium should normally be treated as caution / conflict',
    '  for initiating fresh bullish exposure.',
    '- If you use premium/discount as caution, put it in "conflicts", not in "supportingEvidence".',
    '',
    'Return JSON only, using exactly this schema:',
    '{',
    '  "bias": "BULLISH" | "BEARISH" | "UNCLEAR",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "identifiedStructure": {',
    '    "majorSwingHighs": [ { "price": number, "time": "ISO8601" } ],',
    '    "majorSwingLows":  [ { "price": number, "time": "ISO8601" } ],',
    '    "structureState": "BULLISH" | "BEARISH" | "UNCLEAR"',
    '  },',
    '  "liquidity": {',
    '    "buySide":  [ { "price": number, "time": "ISO8601", "type": "PDH|PWH|SWING_HIGH|EQH|BSL" } ],',
    '    "sellSide": [ { "price": number, "time": "ISO8601", "type": "PDL|PWL|SWING_LOW|EQL|SSL" } ],',
    '    "recentSweeps": [ { "side": "BSL"|"SSL", "liquidityPrice": number, "sweepTime": "ISO8601", "reason": "..." } ]',
    '  },',
    '  "imbalances": {',
    '    "bullishFvg": [ { "top": number, "bottom": number, "time": "ISO8601" } ],',
    '    "bearishFvg": [ { "top": number, "bottom": number, "time": "ISO8601" } ]',
    '  },',
    '  "delivery": {',
    '    "mss": [ { "type": "BULLISH"|"BEARISH", "brokenSwingPrice": number, "breakTime": "ISO8601", "reason": "..." } ],',
    '    "displacement": [ { "direction": "BULLISH"|"BEARISH", "startTime": "ISO8601", "endTime": "ISO8601", "reason": "..." } ],',
    '    "currentDelivery": "BULLISH" | "BEARISH" | "UNCLEAR"',
    '  },',
    '  "mssAssessment": [',
    '    { "level": number, "assessment": "LIKELY_MSS"|"NOT_MSS"|"UNCERTAIN", "reason": "..." }',
    '  ],',
    '  "dealingRange": {',
    '    "high": number, "low": number, "equilibrium": number,',
    '    "location": "PREMIUM" | "EQUILIBRIUM" | "DISCOUNT"',
    '  },',
    '  "drawOnLiquidity": {',
    '    "direction": "UP" | "DOWN" | "NONE",',
    '    "targetPrice": number,',
    '    "reason": "..."',
    '  },',
    '  "supportingEvidence": [ "string" ],',
    '  "conflicts": [ "string" ],',
    '  "biasReason": "..."',
    '}'
].join('\n');

/**
 * 构造 user prompt
 * @param {Object} params
 *   symbol, evaluationTime(ms), candles(Array of 4H candle {openTime,open,high,low,close})
 *   confirmedSwings [可选] { highs:[{price,occurredAt,confirmedAt}], lows:[...] }
 *     —— Phase-2 实验注入：已确认的 pivot 候选集，模型不得自创 swing。
 *   marketFacts [可选] { sweeps:[...], breaks:[...] }
 *     —— Phase-2 扩展注入：已由代码确定的 sweep lifecycle 与 break classification，
 *       模型不得自创/反驳这些事实，仅可补充 narrative 解读。
 * @returns {string}
 */
function buildUserPrompt(params) {
    var symbol = params.symbol;
    var evaluationTime = params.evaluationTime;
    var candles = params.candles;
    var confirmedSwings = params.confirmedSwings; // 可能 undefined（Phase-1 / Raw 模式）
    var marketFacts = params.marketFacts;         // 可能 undefined（Phase-1）

    var iso = new Date(evaluationTime).toISOString();

    // 紧凑 OHLC，openTime 转 ISO；不发送 volume / 指标
    var compact = candles.map(function (c) {
        return {
            openTime: new Date(c.openTime).toISOString(),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close
        };
    });

    var dataObj = {
        symbol: symbol,
        timeframe: '4h',
        evaluationTime: iso,
        candleCount: compact.length,
        candles: compact
    };
    var allowedDrawTargets = buildAllowedDrawTargets(marketFacts, evaluationTime);
    // Phase-2：注入已确认 pivots（模型只能引用这些，不得自创）
    if (confirmedSwings && (confirmedSwings.highs || confirmedSwings.lows)) {
        dataObj.confirmedSwings = {
            highs: (confirmedSwings.highs || []).map(function (h) {
                return { price: h.price, occurredAt: h.occurredAt, confirmedAt: h.confirmedAt };
            }),
            lows: (confirmedSwings.lows || []).map(function (l) {
                return { price: l.price, occurredAt: l.occurredAt, confirmedAt: l.confirmedAt };
            })
        };
    }
    // Phase-2 扩展：注入已由代码确定的 marketFacts（sweep lifecycle + break classification）
    if (marketFacts && (marketFacts.sweeps || marketFacts.breaks)) {
        var mf = { sweeps: [], breaks: [] };
        (marketFacts.sweeps || []).forEach(function (s) {
            var entry = {
                refSide: s.refSide,
                pivotPrice: s.pivotPrice,
                occurredAt: s.occurredAt,
                confirmedAt: s.confirmedAt,
                status: s.status
            };
            if (s.status === 'TAKEN') {
                entry.takenAt = s.takenAt;
                entry.takenByWick = s.takenByWick;
                entry.closedBeyond = s.closedBeyond;
            }
            mf.sweeps.push(entry);
        });
        (marketFacts.breaks || []).forEach(function (b) {
            mf.breaks.push({
                direction: b.direction,
                level: b.level,
                breakAt: b.breakAt,
                relationToDelivery: b.relationToDelivery,
                classification: b.classification,
                mssCandidate: b.mssCandidate,
                referenceSwing: b.referenceSwing
            });
        });
        dataObj.marketFacts = mf;
        dataObj.allowedDrawTargets = allowedDrawTargets;
    }

    var dataJson = JSON.stringify(dataObj, null, 2);

    var instruction = [
        'Analyze BTCUSDT at:',
        'evaluationTime = ' + iso,
        ''
    ];
    if (confirmedSwings && (confirmedSwings.highs || confirmedSwings.lows)) {
        instruction.push('Below are the 120 most recent CLOSED 4H candles available at that exact time,');
        instruction.push('PLUS a set of CONFIRMED swing pivots (highs/lows) already identified by code,');
        instruction.push('AND marketFacts (sweep lifecycle + break classification) ALREADY COMPUTED by code.');
        instruction.push('You MUST use ONLY these supplied pivots as swing references. Do NOT invent new swings.');
        instruction.push('You MUST NOT override the supplied sweep status / break classification — only interpret them.');
        instruction.push('Classify each supplied pivot as internal / structural / protected, then build the ICT narrative.');
        instruction.push('Because marketFacts is supplied: delivery.mss MUST be [] (empty). For every break with');
        instruction.push('mssCandidate=true, give your interpretation in mssAssessment[]. Do NOT promote candidates into delivery.mss.');
        instruction.push('');
        instruction.push('Draw selection rules (hard contract):');
        instruction.push('- If direction=UP, targetPrice MUST exactly match one entry in allowedDrawTargets.up.');
        instruction.push('- If direction=DOWN, targetPrice MUST exactly match one entry in allowedDrawTargets.down.');
        instruction.push('- If no supplied target is meaningful, return direction=NONE and targetPrice=null.');
        instruction.push('- Never invent a draw target from raw OHLC.');
        instruction.push('- Never select TAKEN liquidity. Validator remains authoritative.');
    } else {
        instruction.push('Below are the 120 most recent CLOSED 4H candles available at that exact time.');
        instruction.push('Identify the ICT 2022 structure yourself and determine the 4H bias.');
    }
    instruction.push('');
    instruction.push('Return JSON only using the required schema. Every important object must include its');
    instruction.push('concrete price and candle time. Do NOT use any data after the evaluation time.');
    instruction.push('');
    instruction.push(dataJson);

    return instruction.join('\n');
}

function buildAllowedDrawTargets(marketFacts, evaluationTime) {
    var result = { up: [], down: [] };
    if (!marketFacts) return result;
    var evaluationMs = Number(evaluationTime);
    var seen = { up: {}, down: {} };
    (marketFacts.sweeps || []).forEach(function (s) {
        if (s.status !== 'INTACT') return;
        if (s.refSide !== 'HIGH' && s.refSide !== 'LOW') return;
        if (typeof s.pivotPrice !== 'number' || !isFinite(s.pivotPrice)) return;
        var confirmedMs = Date.parse(s.confirmedAt);
        var occurredMs = Date.parse(s.occurredAt);
        if (!isFinite(confirmedMs) || !isFinite(occurredMs)) return;
        if (confirmedMs > evaluationMs || occurredMs > evaluationMs) return;
        var direction = s.refSide === 'HIGH' ? 'up' : 'down';
        var key = String(s.pivotPrice);
        if (seen[direction][key]) return;
        seen[direction][key] = true;
        var allowedTypes = s.refSide === 'HIGH'
            ? ['SWING_HIGH', 'PDH', 'PWH', 'EQH', 'BSL']
            : ['SWING_LOW', 'PDL', 'PWL', 'EQL', 'SSL'];
        var suppliedType = s.liquidityType || s.type;
        var liquidityType = allowedTypes.indexOf(suppliedType) >= 0
            ? suppliedType
            : (s.refSide === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW');
        result[direction].push({
            price: s.pivotPrice,
            side: s.refSide,
            type: liquidityType,
            status: 'INTACT',
            occurredAt: s.occurredAt,
            confirmedAt: s.confirmedAt
        });
    });
    return result;
}

module.exports = {
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildUserPrompt: buildUserPrompt,
    buildAllowedDrawTargets: buildAllowedDrawTargets
};
