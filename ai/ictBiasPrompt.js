/**
 * ICT 4H Bias 审计 —— Prompt 构造（方案 Z：纯 4H Raw OHLC，DeepSeek 自识别）
 *
 * 设计原则：
 * - System Prompt 固定（ICT 2022 Mentorship 框架），不含"SSL Sweep→BULLISH"模板，
 *   避免模型机械套规则。
 * - User Prompt 每次只变化：evaluationTime + 120 根 4H OHLC + deterministic market facts。
 * - Structural Provenance V1.1 是 authoritative fact；模型只负责 narrative interpretation。
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
    'When deterministic marketFacts are supplied, accept their structural provenance as authoritative.',
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
    '- Do not promote a minor break to structural MSS unless marketFacts explicitly labels it STRUCTURAL_MSS.',
    '- Do not force a directional bias. If the narrative or draw on liquidity is ambiguous, return UNCLEAR.',
    '- A recent rise alone does not imply BULLISH. A recent decline alone does not imply BEARISH.',
    '- Distinguish an internal retracement from a meaningful change in delivery.',
    '- Prefer meaningful HTF liquidity over insignificant local fluctuations.',
    '- For EVERY important object you identify (swing, sweep, MSS, displacement, FVG, draw target),',
    '  you MUST return its concrete price and the candle openTime (ISO 8601 UTC) where it occurs.',
    '  Do NOT return abstract descriptions like "there was a bullish MSS" without price and time.',
    '',
    'AUTHORITATIVE MARKET FACTS (applies when marketFacts is supplied):',
    '- marketFacts contains code-owned sweeps, breaks, protectedSwings, structuralEvents, and structuralState.',
    '- You MUST NOT re-derive or override the sweep status / break classification / relationToDelivery.',
    '- A sweep marked status=TAKEN was swept at takenAt; do NOT claim it is intact.',
    '- A break marked classification=CONTINUATION is a continuation, NOT an MSS.',
    '- protectedSwings roles/statuses are authoritative. Never redefine ACTIVE_PROTECTED or SUPERSEDED_PROTECTED.',
    '- structuralEvents types are authoritative. Never relabel BOS, STRUCTURAL_MSS, or STRUCTURAL_CONTINUATION.',
    '- structuralState is authoritative structure, but it does NOT force final bias. For example,',
    '  structuralState=BEARISH with fulfilled downside draw may legitimately produce bias=UNCLEAR.',
    '- delivery.mss may contain ONLY supplied STRUCTURAL_MSS events. It MUST include the latest supplied',
    '  STRUCTURAL_MSS using its exact direction, referenceLevel, and eventTime. Never invent an MSS.',
    '- Include every ACTIVE_PROTECTED_HIGH/LOW in identifiedStructure.majorSwingHighs/majorSwingLows',
    '  using its exact price and occurredAt.',
    '- You MAY interpret what these facts mean for narrative, delivery, draw, bias, conflicts, and confidence.',
    '',
    'SWING REFERENCE DISCIPLINE (applies when confirmedSwings is supplied):',
    '- You MUST NOT invent swing highs or swing lows.',
    '- Only levels listed in confirmedSwings or authoritative protectedSwings may be used as swing references.',
    '- Use protectedSwings, not your own pivot classification, for protected/structural roles.',
    '- Pivots not assigned a protected role by marketFacts may still be discussed as internal context.',
    '',
    'MSS RULE (mandatory):',
    '- A Market Structure Shift requires a genuine change in directional delivery.',
    '- If prior meaningful delivery is already BEARISH, breaking another confirmed swing',
    '  low is bearish continuation / BOS, NOT a bearish MSS.',
    '- If prior meaningful delivery is already BULLISH, breaking another confirmed swing',
    '  high is bullish continuation / BOS, NOT a bullish MSS.',
    '- Only structuralEvents.type=STRUCTURAL_MSS is an MSS.',
    '- STRUCTURAL_CONTINUATION is continuation and must never be described as another MSS.',
    '- If no supplied STRUCTURAL_MSS exists, delivery.mss MUST be [] (empty array).',
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
    '  "dealingRange": {',
    '    "high": number, "low": number, "equilibrium": number,',
    '    "location": "PREMIUM" | "EQUILIBRIUM" | "DISCOUNT"',
    '  },',
    '  "drawOnLiquidity": {',
    '    "direction": "UP" | "DOWN" | "NONE",',
    '    "targetPrice": number | null,',
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
 *   confirmedSwings { highs:[{price,occurredAt,confirmedAt}], lows:[...] }
 *     —— 已确认的 pivot 候选集，模型不得自创 swing。
 *   marketFacts { sweeps, breaks, protectedSwings, structuralEvents, structuralState }
 *     —— code-owned deterministic facts，模型不得自创/反驳，仅可补充 narrative 解读。
 * @returns {string}
 */
function buildUserPrompt(params) {
    var symbol = params.symbol;
    var evaluationTime = params.evaluationTime;
    var candles = params.candles;
    var confirmedSwings = params.confirmedSwings;
    var marketFacts = params.marketFacts;
    if (!confirmedSwings || !marketFacts) {
        throw new Error('DAILY_BIAS_DETERMINISTIC_CONTEXT_V1 requires confirmedSwings and marketFacts');
    }

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
    dataObj.confirmedSwings = {
        highs: (confirmedSwings.highs || []).map(function (h) {
            return { price: h.price, occurredAt: h.occurredAt, confirmedAt: h.confirmedAt };
        }),
        lows: (confirmedSwings.lows || []).map(function (l) {
            return { price: l.price, occurredAt: l.occurredAt, confirmedAt: l.confirmedAt };
        })
    };
    // 注入 code-owned deterministic marketFacts，全部按 evaluationTime 再做一次 visibility guard。
    {
        var mf = {
            sweeps: [],
            breaks: [],
            protectedSwings: [],
            structuralEvents: [],
            structuralState: marketFacts.structuralState || 'UNKNOWN'
        };
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
        (marketFacts.protectedSwings || []).forEach(function (s) {
            if (!isVisibleAt(s.protectedConfirmedAt || s.confirmedAt, evaluationTime)) return;
            mf.protectedSwings.push(copyFields(s, [
                'price', 'occurredAt', 'confirmedAt', 'side',
                'parentStructuralLevel', 'parentStructuralConfirmedAt',
                'bosLevel', 'bosCandleTime', 'bosClose', 'bosConfirmedAt',
                'protectedConfirmedAt', 'role', 'status', 'supersededBy',
                'brokenAt', 'brokenConfirmedAt', 'brokenByClose',
                'structuralMssReference'
            ]));
        });
        (marketFacts.structuralEvents || []).forEach(function (e) {
            if (!isVisibleAt(e.confirmedAt, evaluationTime)) return;
            var event = copyFields(e, [
                'type', 'direction', 'referenceLevel', 'referenceRole',
                'eventTime', 'confirmedAt', 'structuralStateBefore',
                'structuralStateAfter', 'stateChanged'
            ]);
            if (e.sourceProtectedSwing) {
                event.sourceProtectedSwing = copyFields(e.sourceProtectedSwing, [
                    'price', 'occurredAt', 'confirmedAt', 'side', 'role', 'protectedConfirmedAt'
                ]);
            }
            mf.structuralEvents.push(event);
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
    instruction.push('Below are the 120 most recent CLOSED 4H candles available at that exact time,');
    instruction.push('PLUS a set of CONFIRMED swing pivots (highs/lows) already identified by code,');
    instruction.push('AND authoritative marketFacts (sweeps, breaks, protected swings, structural events/state).');
    instruction.push('Use only confirmedSwings or authoritative protectedSwings as swing references. Do NOT invent new swings.');
    instruction.push('You MUST NOT override supplied liquidity lifecycle or Structural Provenance V1.1 facts.');
    instruction.push('Do not choose protected swings or MSS references yourself. Interpret the supplied facts.');
    instruction.push('delivery.mss must echo only deterministic STRUCTURAL_MSS events and include the latest one.');
    instruction.push('');
    instruction.push('Draw selection rules (hard contract):');
    instruction.push('- If direction=UP, targetPrice MUST exactly match one entry in allowedDrawTargets.up.');
    instruction.push('- If direction=DOWN, targetPrice MUST exactly match one entry in allowedDrawTargets.down.');
    instruction.push('- If no supplied target is meaningful, return direction=NONE and targetPrice=null.');
    instruction.push('- Never invent a draw target from raw OHLC.');
    instruction.push('- Never select TAKEN liquidity. Validator remains authoritative.');
    instruction.push('');
    instruction.push('Return JSON only using the required schema. Every important object must include its');
    instruction.push('concrete price and candle time. Do NOT use any data after the evaluation time.');
    instruction.push('');
    instruction.push(dataJson);

    return instruction.join('\n');
}

function isVisibleAt(time, evaluationTime) {
    var t = Date.parse(time);
    return isFinite(t) && t <= Number(evaluationTime);
}

function copyFields(source, fields) {
    var out = {};
    fields.forEach(function (field) {
        if (source[field] !== undefined) out[field] = source[field];
    });
    return out;
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
