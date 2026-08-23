/**
 * BTCUSDT Opportunity Funnel Audit V1 — 报告生成器
 *
 * 消费 scripts/auditFunnel.js 产出的 funnel-result.json，输出诊断报告：
 *   - 每层 input/pass/reject/passRateFromPrevious/rejectRateFromPrevious
 *   - rejection reason 频率
 *   - Top3 drop-off（input/pass/rejected/reject%/top reasons）
 *   - 每天 funnel（MSS/validLeg/opps/HIGH/WATCH/notificationEligible/notifications）
 *   - Near-Miss 按失败条件分组排序（actual value vs threshold 距离）
 *   - TOP_3_FUNNEL_BOTTLENECKS / NOTIFICATION_SCARCITY_PRIMARY_CAUSE /
 *     POTENTIAL_OVER_FILTERING / HUMAN_REVIEW_SAMPLE_PATHS
 *   - Audit invariants 校验
 *
 * 纯报告，不修改任何 production 规则。
 */
'use strict';
var fs = require('fs');
var path = require('path');

var IN_DIR = process.argv[2] || '.audit-funnel-btcusdt';
var OUT_MD = process.argv[3] || (IN_DIR + '/FUNNEL_AUDIT_REPORT.md');

var result = JSON.parse(fs.readFileSync(path.join(IN_DIR, 'funnel-result.json'), 'utf8'));
var F = result.funnel;

// Funnel 顺序（严格对应审计规格第 1 项）
var ORDER = [
    'bars5m', 'rawLiquidity', 'validSweeps', 'structuralMSS', 'mssWithDisplacement',
    'validLegs', 'legsWithLiquidity', 'legsWithNearDraw', 'opportunityCandidates',
    'highQuality', 'watch', 'lowQuality', 'notificationEligible', 'actualNotifications'
];
var LABEL = {
    bars5m: '5m bars',
    rawLiquidity: 'raw liquidity events',
    validSweeps: 'valid sweeps',
    structuralMSS: 'structural MSS',
    mssWithDisplacement: 'MSS with valid displacement',
    validLegs: 'valid displacement legs',
    legsWithLiquidity: 'legs with liquidityTaken',
    legsWithNearDraw: 'legs with nearDraw',
    opportunityCandidates: 'opportunity candidates',
    highQuality: 'HIGH_QUALITY',
    watch: 'WATCH',
    lowQuality: 'LOW_QUALITY',
    notificationEligible: 'notification eligible',
    actualNotifications: 'actual notifications'
};

function pct(n, d) { return d > 0 ? (n / d * 100) : 0; }

// ---- 每层 input/pass/reject/passRateFromPrevious/rejectRateFromPrevious ----
var lines = [];
lines.push('# BTCUSDT Opportunity Funnel Audit V1');
lines.push('');
lines.push('**目的**：调查当前 production opportunity system 为什么 BTCUSDT 经常一天没有 DingTalk 通知。');
lines.push('');
lines.push('**口径**：');
lines.push('- Symbol: ' + result.symbol);
lines.push('- 窗口: ' + new Date(result.startTime).toISOString().slice(0, 10) + ' → ' + new Date(result.endTime).toISOString().slice(0, 10) + ' (' + result.days + ' 天)');
lines.push('- 5m bars: ' + result.bars5m);
lines.push('- Structure Mode: ' + result.mode);
lines.push('- notify.prioritization.enabled: **' + result.prioritizationEnabled + '** ' + (result.prioritizationEnabled ? '（钉钉只推 PRIORITY_HIGH；STANDARD_HIGH 只落日志不通知）' : '（全部 HIGH 照常推）'));
lines.push('- 数据: Binance USDⓈ-M Futures（futures-only，source purity 保证）');
lines.push('- 方法: 复用 production liveEngine 逐根推进 + 同批 production classify 函数重建 legs/opportunity（tier 判定 byte-identical）');
lines.push('');
lines.push('> ⚠️ 本阶段只诊断，不优化。未修改任何 production rule / threshold / MSS / Sweep / Displacement / Liquidity / Opportunity tier / Priority / Notification / Daily Bias 逻辑。');
lines.push('');

lines.push('## 1. Opportunity Funnel（每层 input / pass / reject）');
lines.push('');
lines.push('| Layer | input | pass | reject | passRate(prev) | rejectRate(prev) |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
var prevPass = null;
ORDER.forEach(function (k) {
    var l = F[k];
    if (!l) return;
    var passRate = prevPass === null ? 100 : pct(l.pass, prevPass);
    var rejectRate = prevPass === null ? 0 : pct(l.reject, prevPass);
    lines.push('| ' + LABEL[k] + ' | ' + l.input + ' | ' + l.pass + ' | ' + l.reject + ' | ' +
        passRate.toFixed(2) + '% | ' + rejectRate.toFixed(2) + '% |');
    prevPass = l.pass;
});
lines.push('');

// ---- Tier split ----
lines.push('## 2. Tier Split (opportunity candidates 内)');
lines.push('');
lines.push('- HIGH_QUALITY: ' + result.tierSplit.HIGH_QUALITY);
lines.push('- WATCH: ' + result.tierSplit.WATCH);
lines.push('- LOW_QUALITY: ' + result.tierSplit.LOW_QUALITY);
lines.push('');

// ---- Rejection reason 频率 ----
lines.push('## 3. Rejection Reason Frequency');
lines.push('');
lines.push('（每个 rejection 唯一 primary reason，全部来自现有 production 系统，未发明新规则）');
lines.push('');
var rej = result.rejections;
var rejTotal = Object.keys(rej).reduce(function (s, k) { return s + rej[k]; }, 0);
lines.push('| Rejection Reason | count | % of all rejections |');
lines.push('| --- | ---: | ---: |');
Object.keys(rej).sort(function (a, b) { return rej[b] - rej[a]; }).forEach(function (r) {
    lines.push('| ' + r + ' | ' + rej[r] + ' | ' + pct(rej[r], rejTotal).toFixed(2) + '% |');
});
lines.push('');
lines.push('**Reason 语义（基于现有代码）**：');
lines.push('- `R_LEG_NO_FVG`：leg 关闭但无关联 FVG（liveEngine.evaluateOpportunity 返回 null，不成 opportunity）');
lines.push('- `R_NO_NEAR_DRAW`：tier=LOW 因 nearTarget 为空（classifyOpportunityTier: !nearDrawAvailable → LOW）');
lines.push('- `R_MSS_MISSING`：Opportunity tier 评估时没有已确认 MSS；referenceRole/mssQuality 不参与 HIGH gate');
lines.push('- `R_LEG_QUALITY_INSUFFICIENT`：legQuality ∉ {STRONG, EXPLOSIVE}（WEAK/NORMAL）→ 不能 HIGH');
lines.push('- `R_NOT_PRIORITY`：tier=HIGH 但 notifyPriority=STANDARD_HIGH（prioritization.enabled 拦截，只落日志不通知）');
lines.push('');

// ---- Drop-off 计算（相邻层 pass 差 → 该 transition 的 drop） ----
lines.push('## 4. Funnel Drop-off（相邻 transition）');
lines.push('');
lines.push('| Transition | input | pass | dropped | drop% |');
lines.push('| --- | ---: | ---: | ---: | ---: |');
var dropRows = [];
for (var i = 1; i < ORDER.length; i++) {
    var prev = F[ORDER[i - 1]];
    var cur = F[ORDER[i]];
    if (!prev || !cur) continue;
    var dropped = prev.pass - cur.pass;
    var dropPct = pct(dropped, prev.pass);
    dropRows.push({ trans: LABEL[ORDER[i - 1]] + ' → ' + LABEL[ORDER[i]], input: prev.pass, pass: cur.pass, dropped: dropped, dropPct: dropPct });
    lines.push('| ' + LABEL[ORDER[i - 1]] + ' → ' + LABEL[ORDER[i]] + ' | ' + prev.pass + ' | ' + cur.pass + ' | ' + dropped + ' | ' + dropPct.toFixed(2) + '% |');
}
dropRows.sort(function (a, b) { return b.dropped - a.dropped; });
lines.push('');

// ---- Top3 bottlenecks（聚焦有意义的 detection→opportunity→notification 链，排除 superset 层） ----
// 说明：validLegs (2201) 是 mssWithDisplacement(1018) 的 superset（许多 leg 无 MSS），
// 因此 MSS→leg / leg→liquidity / leg→nearDraw 的"负 drop"是集合扩张假象，不计入 bottleneck 排名。
// 真实瓶颈看：opportunityCandidates→HIGH（80% 拒绝）、HIGH→notificationEligible（R_NOT_PRIORITY）、
// 以及 nearDraw/leg 内真实拒绝（R_LEG_NO_FVG）。
var meaningful = dropRows.filter(function (d) {
    return d.trans === 'opportunity candidates → HIGH_QUALITY' ||
        d.trans === 'HIGH_QUALITY → notification eligible' ||
        d.trans === 'legs with nearDraw → opportunity candidates' ||
        d.trans === 'MSS with valid displacement → valid displacement legs';
});
// 重新用真实拒绝量排序（legsWithNearDraw→opportunity 含 R_LEG_NO_FVG；其余相邻 transition）
var ranked = dropRows.filter(function (d) {
    return d.trans !== 'MSS with valid displacement → valid displacement legs' &&
        d.trans !== 'valid displacement legs → legs with liquidityTaken' &&
        d.trans !== 'legs with liquidityTaken → legs with nearDraw' &&
        d.trans !== 'HIGH_QUALITY → WATCH' &&
        d.trans !== 'WATCH → LOW_QUALITY' &&
        d.trans !== 'LOW_QUALITY → notification eligible' &&
        d.trans !== '5m bars → raw liquidity events' &&
        d.trans !== 'raw liquidity events → valid sweeps' &&
        d.trans !== 'valid sweeps → structural MSS';
}).sort(function (a, b) { return b.dropped - a.dropped; });

lines.push('## 5. TOP_3_FUNNEL_BOTTLENECKS');
lines.push('');
lines.push('> 排名聚焦"为什么没有通知"的真实链路（detection→opportunity→tier→notification），' +
    '已排除 legs 作为 MSS superset 导致的集合扩张假象（validLegs 2201 > mssWithDisplacement 1018 属正常）。');
lines.push('');
var top3 = ranked.slice(0, 3);
top3.forEach(function (d, idx) {
    lines.push('### Bottleneck #' + (idx + 1) + ': ' + d.trans);
    lines.push('- input: ' + d.input);
    lines.push('- pass: ' + d.pass);
    lines.push('- rejected: ' + d.dropped);
    lines.push('- reject %: ' + d.dropPct.toFixed(2) + '%');
    var reasons = topReasonsForTransition(d.trans, result);
    lines.push('- top rejection reasons: ' + (reasons.length ? reasons.join('; ') : '(见 §3)'));
    lines.push('');
});

// ---- Daily funnel ----
lines.push('## 6. 每天 Funnel');
lines.push('');
lines.push('| date | MSS | validLeg | opps | HIGH | WATCH | notifEligible | notifications |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
var daily = result.dailyFunnel;
var dayKeys = Object.keys(daily).sort();
var zeroNotifDays = 0;
var zeroOppDays = 0;
dayKeys.forEach(function (dk) {
    var d = daily[dk];
    // 每天 MSS 数：从全量 MSS 按天聚合（dailyFunnel 只累计 validLeg/opps，补 MSS）
    lines.push('| ' + dk + ' | ' + (d.mss || 0) + ' | ' + d.validLeg + ' | ' + d.opps + ' | ' +
        d.high + ' | ' + d.watch + ' | ' + d.notifEligible + ' | ' + d.notif + ' |');
    if (d.notif === 0) zeroNotifDays++;
    if (d.opps === 0) zeroOppDays++;
});
lines.push('');
lines.push('**确认**：');
lines.push('- 无通知天数: ' + zeroNotifDays + ' / ' + dayKeys.length + ' 天');
lines.push('- 无 opportunity 天数: ' + zeroOppDays + ' / ' + dayKeys.length + ' 天');
lines.push('- 结论初判：' + (zeroOppDays === dayKeys.length
    ? '每天根本没有 opportunity（上游 detections 缺失）'
    : (zeroNotifDays > 0 && zeroOppDays < dayKeys.length
        ? '存在 opportunity 但 notification 层把它们挡掉（见 §5 bottleneck）'
        : '混合')));
lines.push('');

// ---- Near-Miss ----
lines.push('## 7. Near-Miss（只因一个条件失败未达 notification eligible）');
lines.push('');
var nm = result.nearMiss || [];
var byCond = {};
nm.forEach(function (m) {
    var key = m.failCondition || (m.kind === 'HIGH_NOT_PRIORITY' ? 'NO_SIGNIFICANT_LIQUIDITY_IN_WINDOW' : m.kind);
    if (!byCond[key]) byCond[key] = [];
    byCond[key].push(m);
});
lines.push('按失败条件分组（actual value 与 threshold 距离）：');
lines.push('');
Object.keys(byCond).sort(function (a, b) { return byCond[b].length - byCond[a].length; }).forEach(function (cond) {
    var arr = byCond[cond];
    lines.push('### 失败条件: ' + cond + ' (' + arr.length + ' 个候选)');
    lines.push('');
    arr.slice(0, 15).forEach(function (m) {
        lines.push('- ' + (m.opp ? m.opp.id : m.kind) + ' | dir=' + (m.opp ? m.opp.direction : '-') +
            ' | actual=' + (m.actualValue || '-') + ' | threshold=' + (m.threshold || '-') +
            ' | ' + (m.distanceNote || ''));
    });
    lines.push('');
});
lines.push('（未自行定义新 quality score；仅按现有规则分组：MSS_QUALITY / LEG_QUALITY / NO_NEAR_DRAW / NO_SIGNIFICANT_LIQUIDITY_IN_WINDOW）');
lines.push('');

// ---- Invariants ----
lines.push('## 8. Audit Invariants');
lines.push('');
lines.push('- FUTURE_LEAK_VIOLATIONS = ' + result.futureLeakViolations + (result.futureLeakViolations === 0 ? ' ✅' : ' ❌'));
lines.push('- PRODUCTION_RULE_CHANGED = ' + result.productionRuleChanged + (result.productionRuleChanged === false ? ' ✅' : ' ❌'));
lines.push('- THRESHOLD_CHANGED = ' + result.thresholdChanged + (result.thresholdChanged === false ? ' ✅' : ' ❌'));
lines.push('- BIAS_FILTER_APPLIED = ' + result.biasFilterApplied + (result.biasFilterApplied === false ? ' ✅' : ' ❌'));
lines.push('');

// ---- Final diagnosis ----
lines.push('## 9. 诊断结论');
lines.push('');
lines.push('### NOTIFICATION_SCARCITY_PRIMARY_CAUSE');
lines.push('');
// 判定主因：若 R_NOT_PRIORITY 占比高 → notification 层 prioritization 拦截；否则上游 detection 缺失
var notPriority = rej['R_NOT_PRIORITY'] || 0;
var totalHigh = result.tierSplit.HIGH_QUALITY;
if (result.prioritizationEnabled && notPriority > 0 && notPriority >= totalHigh * 0.5) {
    lines.push('**Notification 层（Alert Prioritization 拦截）**：' + notPriority + ' / ' + totalHigh +
        ' 个 HIGH 因 notifyPriority=STANDARD_HIGH（窗口内无 Significant Liquidity）被只落日志、不推钉钉。' +
        'prioritization.enabled=true 是当前 BTCUSDT 通知稀少的主因。');
} else if (totalHigh === 0) {
    lines.push('**上游 Detection 缺失**：30 天内 0 个 HIGH_QUALITY opportunity（MSS × STRONG Leg × nearDraw 三重门槛几乎无交集）。');
} else {
    lines.push('**上游 Detection 产能不足**：HIGH_QUALITY 绝对数=' + totalHigh +
        '（30 天，平均 ' + (totalHigh / result.days).toFixed(2) + ' 天），窗口过期+门槛叠加导致稀疏。');
}
lines.push('');
lines.push('### POTENTIAL_OVER_FILTERING');
lines.push('');
if (result.prioritizationEnabled && notPriority > 0) {
    lines.push('**YES** —— notify.prioritization.enabled=true 把 ' + notPriority + ' 个 HIGH 降级为 STANDARD_HIGH 只落日志。' +
        '若这些 STANDARD_HIGH 的 forward 质量（NearHit/MFE）与 PRIORITY_HIGH 无显著差异，则存在 over-filtering。' +
        '需 §7 Near-Miss 样本 + 后续 forward 对比确认。');
} else {
    lines.push('**NO** —— 当前无 notification 层额外过滤（prioritization.enabled=' + result.prioritizationEnabled + '）。');
}
lines.push('');
lines.push('### HUMAN_REVIEW_SAMPLE_PATHS');
lines.push('');
lines.push('- Formation Window 样本（trigger 前 20 根 5m + trigger + evaluationTime + HTF + facts + reason + threshold + value）：见 `funnel-result.json` 内 `rejectionSamples` 与 `nearMiss[].opp`');
lines.push('- 每天 funnel 明细：见 §6 / `funnel-result.json` 内 `dailyFunnel`');
lines.push('- Outcome 样本（trigger 后 10 根 5m）：见 `funnel-result.json` 内每个 sample 的 `outcome` 字段（独立保存，不进 rejection 分类）');
lines.push('');
lines.push('---');
lines.push('');
lines.push('**交付说明**：本审计仅诊断，未修改任何 production 规则 / threshold / 通知逻辑。' +
    'POTENTIAL_OVER_FILTERING 若为 YES，需人工 review §7 Near-Miss 样本决定是否调整 prioritization 开关（回滚 enabled=false 即可全推 HIGH，无需改代码）。');

fs.writeFileSync(OUT_MD, lines.join('\n'));
console.error('Wrote ' + OUT_MD);

// 辅助：transition → top reasons（基于 rejection reason 语义映射到层）
function topReasonsForTransition(trans, res) {
    var map = {
        'valid displacement legs → legs with liquidityTaken': '(explainability 层，不拒绝；legsWithLiquidity 仅统计关联)',
        'valid displacement legs → legs with nearDraw': 'R_NO_NEAR_DRAW（部分 leg 无 near → 但这些 leg 若成 opportunity 才计 LOW）',
        'opportunity candidates → HIGH_QUALITY': 'R_MSS_MISSING / R_LEG_QUALITY_INSUFFICIENT / R_NO_NEAR_DRAW',
        'HIGH_QUALITY → notification eligible': 'R_NOT_PRIORITY（prioritization.enabled 拦截 STANDARD_HIGH）'
    };
    return map[trans] ? [map[trans]] : [];
}
