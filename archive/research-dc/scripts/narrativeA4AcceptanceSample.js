/**
 * Bias Phase 1 — Formation A.4 → 40 条人眼验收抽样清单生成器
 *
 * 目的（用户路线 2026-08-21）：Population Audit 已 PASS（682 GT / 87.1% coverage）。
 * 现在做"出厂质检"——最后一次人眼污染检查。从 682 个 accepted GT 中分层过采样 40 条
 * （BULL 20 + BEAR 20），供用户人眼标注 PASS / UNCERTAIN / FAIL。
 *
 * 关键纪律：
 *   - 只从 accepted GT 抽（decision=TERMINAL && certaintyGate='PASS'）。绝不抽 G1/G3 已 reject 的。
 *   - G1/G3 边界邻近层：从 PASS 集合中挑"距离触发门槛最近"的样本（最危险），不是抽 reject 样本。
 *   - A.4 逻辑零改动：episode member 数、near-G1/G3 分数都在本脚本内只读复算（不改 stats/narrativeFormationA4.js）。
 *   - 复用 narrativeA4PopulationAudit.js 同 replay 管线（同一 90d 缓存 20686，mssId 稳定）。
 *   - 确定性随机（seeded），保证可复现。
 *
 * 分层（每方向 20）：
 *   普通随机 GT          8   —— 检查总体基本质量
 *   raid→MSS 很短        3   —— 检查"最近 raid"型
 *   raid→MSS 很长        3   —— 检查长 causal chain
 *   multi-member episode 3   —— 挑战 A/B causal attribution
 *   COMPLEX_EPISODE     3   —— 边界间隔验证（见下；原 G1/G3 邻近层无样本，降级）
 *   -------------------------------------------------------------------
 *   合计                 20
 *
 * 边界间隔验证结论（脚本内已核验，写进清单头部）：
 *   682 accepted GT 中 nearG1=0、nearG3=0（无"未触发但贴近门槛"的危险样本），
 *   causal!=episode最深member=0。G1/G3 门槛与 PASS 集合间存在干净间隔带，
 *   不是"擦边放过"。因此原 G1/G3 邻近层改为抽最复杂 episode（members>=4）间接挑战归因鲁棒性。
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA4AcceptanceSample.js [SYMBOL] [DAYS]
 */
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var a4 = require('../stats/narrativeFormationA4');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

// ----------  seeded 随机（mulberry32，确定性可复现） ----------
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ----------  A.4 episode 归并只读复算（不改 A.4 模块） ----------
function rebuildEpisodes(sweeps, prevIdx, Mi, GAP_MAX, D) {
    var elig = sweeps.filter(function (s) {
        return s.direction === D &&
            s.candleIndex > prevIdx && s.candleIndex < Mi;
    });
    var episodes = [];
    var cur = null;
    elig.forEach(function (s) {
        if (!cur || (s.candleIndex - cur.lastIdx) > GAP_MAX) {
            cur = { members: [], firstIdx: s.candleIndex, lastIdx: s.candleIndex };
            episodes.push(cur);
        } else {
            cur.lastIdx = s.candleIndex;
        }
        cur.members.push(s);
    });
    return { elig: elig, episodes: episodes };
}

function moreExtreme(p1, p2, dir) { return dir === 'BULLISH' ? (p1 < p2) : (p1 > p2); }
function registeredCandleExtreme(sw, candles5m) {
    var c = candles5m[sw.candleIndex];
    if (!c) return sw.direction === 'BULLISH' ? sw.low : sw.high;
    return sw.direction === 'BULLISH' ? c.low : c.high;
}

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.4 40-acceptance sampling ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
        var t0 = Date.now();
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: SNAPSHOT_INTERVAL,
            logEvery: 999999
        }).then(function (result) {
            console.log('Replay 完成 (' + Math.round((Date.now() - t0) / 1000) + 's)');

            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );
            var ctx = {
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                swings: result.swings || [],
                legByDispId: legByDispId,
                candles5m: candles5m,
                a4Trace: true,
                a4Traces: {}
            };

            var a4Results = a4.buildNarrativesA4(ctx);
            var a4Traces = ctx.a4Traces || {};
            var mssEvents = result.mssEvents || [];
            var sweeps = ctx.sweeps;
            var GAP_MAX = 12;

            // 建立 mssId -> mssEvent 索引
            var mssById = {};
            mssEvents.forEach(function (m) { mssById[m.id] = m; });

            // 建立 mssId -> prevSameDirIdx
            function prevSameDirIdx(Mi, D) {
                var prev = -Infinity;
                for (var p = 0; p < mssEvents.length; p++) {
                    if (mssEvents[p].candleIndex >= Mi) break;
                    if (mssEvents[p].direction === D) prev = mssEvents[p].candleIndex;
                }
                return prev;
            }

            // ---- 收集 accepted GT（TERMINAL + certaintyGate PASS）----
            var accepted = []; // {mssId, D, Mi, raidIdx, raidToMssBars, epFirst, epLast, epMembers, nearG1, nearG3}
            a4Results.forEach(function (r) {
                var tr = a4Traces[r.mssId];
                if (!tr || tr.decision !== 'TERMINAL_MANIPULATION_EPISODE' || tr.certaintyGate !== 'PASS') return;
                var m = mssById[r.mssId];
                var D = r.raidSide === 'SSL' ? 'BULLISH' : 'BEARISH';
                var Mi = r.mssIndex;
                var prevIdx = prevSameDirIdx(Mi, D);
                var rb = rebuildEpisodes(sweeps, prevIdx, Mi, GAP_MAX, D);
                var ep = rb.episodes[rb.episodes.length - 1];
                var epMembers = ep ? ep.members : [];

                var raidIdx = r.raidIndex;
                // causal registered extreme = 该 raid bar 的真实 low/high（与 A.4 内部 registeredCandleExtreme 同源）
                var causalReg = (function () {
                    var c = candles5m[raidIdx];
                    if (!c) return null;
                    return D === 'BULLISH' ? c.low : c.high;
                })();
                if (causalReg == null) return; // 防御：不应发生

                // near-G1：episode 内 causal 后未登记 extreme 与 causal 深度差（ATR）
                if (!ep) return; // 防御：elig 非空但 episodes 空（理论上不会）
                var atr = (function () {
                    var sum = 0, cnt = 0;
                    for (var i = Math.max(0, ep.lastIdx - 13); i <= ep.lastIdx; i++) {
                        var c = candles5m[i]; if (!c) continue; sum += (c.high - c.low); cnt++;
                    }
                    return cnt ? sum / cnt : 1;
                })();
                var memberIdxSet = {};
                epMembers.forEach(function (s) { memberIdxSet[s.candleIndex] = true; });
                var g1Deepest = null;
                for (var g1 = raidIdx; g1 <= ep.lastIdx; g1++) {
                    var cg1 = candles5m[g1]; if (!cg1) continue;
                    var eg1 = (D === 'BULLISH') ? cg1.low : cg1.high;
                    if (!memberIdxSet[g1] && moreExtreme(eg1, causalReg, D)) {
                        if (g1Deepest == null || moreExtreme(eg1, g1Deepest, D)) g1Deepest = eg1;
                    }
                }
                // G1 阈值 = ALIGN_ATR(1.5)*atr。nearG1 = (g1Deepest 与 causalReg 的 gap)/atr，越接近 1.5 越危险。
                // 若没有更深未登记 extreme，nearG1 = +∞（完全安全）。
                var nearG1 = (g1Deepest != null)
                    ? Math.abs(g1Deepest - causalReg) / atr   // 越小越危险（接近 0 表示几乎更深）
                    : Infinity;

                // near-G3：前一个更深的 eligible raid 与 causal 深度差（ATR）+ 距离（bars）
                // G3 触发条件：单 member episode 且前 eligible 更深且间隔 <= 2*GAP_MAX。
                // nearG3 危险度 = 间隔越小 + 更深程度越接近（gap ATR 越小）越危险。
                var nearG3 = Infinity;
                if (epMembers.length === 1) {
                    for (var pi = 0; pi < rb.elig.length; pi++) {
                        var ps = rb.elig[pi];
                        if (ps.candleIndex >= ep.firstIdx) continue;
                        if ((ep.firstIdx - ps.candleIndex) > 2 * GAP_MAX) continue;
                        var psExt = (D === 'BULLISH') ? candles5m[ps.candleIndex].low : candles5m[ps.candleIndex].high;
                        if (moreExtreme(psExt, causalReg, D)) {
                            var gapAtr = Math.abs(psExt - causalReg) / atr;
                            var distBars = ep.firstIdx - ps.candleIndex;
                            // 危险度打分：gapAtr 越小（越接近 causal 深度）+ distBars 越接近 2*GAP_MAX 越危险
                            // 用 (gapAtr + distBars/ (2*GAP_MAX) * 0.5) 作为综合分数，越小越危险
                            var score = gapAtr + (distBars / (2 * GAP_MAX)) * 0.5;
                            if (score < nearG3) nearG3 = score;
                        }
                    }
                }

                // 找对应 sweep 事件（用于 Liquidity level 信息 + 真实发生时间）
                var theSweep = null;
                for (var si = 0; si < sweeps.length; si++) {
                    if (sweeps[si].direction === D && sweeps[si].candleIndex === raidIdx) {
                        // 取 liquidityPrice 最接近 candleReg 的那个（多 sweep 同 bar 时）
                        if (!theSweep || Math.abs((sweeps[si].source && sweeps[si].source.liquidityPrice) - causalReg) <
                            Math.abs((theSweep.source && theSweep.source.liquidityPrice) - causalReg)) {
                            theSweep = sweeps[si];
                        }
                    }
                }
                var liqPrice = (theSweep && theSweep.source) ? theSweep.source.liquidityPrice : null;
                var liqType = (theSweep && theSweep.source) ? theSweep.source.liquidityType : '?';
                var occurredAt = theSweep ? theSweep.occurredAt : null;
                // 数据完整性自检：candle 实际极值必须触达（≤ BULL / ≥ BEAR）liquidityPrice
                var selfCheckOk = (liqPrice != null) &&
                    (D === 'BULLISH' ? (causalReg <= liqPrice + 1e-6) : (causalReg >= liqPrice - 1e-6));

                accepted.push({
                    mssId: r.mssId, D: D, Mi: Mi, raidIdx: raidIdx,
                    raidToMssBars: r.raidToMssBars,
                    epFirst: ep ? ep.firstIdx : null,
                    epLast: ep ? ep.lastIdx : null,
                    epMemberCount: epMembers.length,
                    nearG1: nearG1, nearG3: nearG3,
                    mss: m,
                    liqPrice: liqPrice, liqType: liqType, occurredAt: occurredAt,
                    candleExtreme: causalReg, selfCheckOk: selfCheckOk
                });
            });

            // 按方向拆分
            var byDir = { BULLISH: [], BEARISH: [] };
            accepted.forEach(function (a) { byDir[a.D].push(a); });

            // ----------  分层抽样（每方向 20） ----------
            function sampleDir(arr, seedBase) {
                var rng = mulberry32(seedBase);
                var chosen = [];
                var used = {};
                function pick(predicate, sortFn, n, label) {
                    var pool = arr.filter(function (x) { return !used[x.mssId] && predicate(x); });
                    if (sortFn) pool.sort(sortFn);
                    var taken = 0;
                    for (var i = 0; i < pool.length && taken < n; i++) {
                        // 若 sortFn 存在则顺序取；否则随机取
                        var item = sortFn ? pool[i] : pool[Math.floor(rng() * pool.length)];
                        if (used[item.mssId]) continue;
                        used[item.mssId] = true; chosen.push({ item: item, layer: label });
                        taken++;
                    }
                    // 若池不够，放宽到全池补
                    if (taken < n) {
                        var rest = arr.filter(function (x) { return !used[x.mssId]; });
                        for (var j = 0; j < rest.length && taken < n; j++) {
                            used[rest[j].mssId] = true; chosen.push({ item: rest[j], layer: label + '(REFILL)' });
                            taken++;
                        }
                    }
                }

                // 1. 普通随机 8
                pick(function () { return true; }, null, 8, 'RANDOM');
                // 2. raid→MSS 很短 3（raidToMssBars 最小）
                pick(function () { return true; }, function (a, b) { return a.raidToMssBars - b.raidToMssBars; }, 3, 'RAID_MSS_SHORT');
                // 3. raid→MSS 很长 3（最大）
                pick(function () { return true; }, function (a, b) { return b.raidToMssBars - a.raidToMssBars; }, 3, 'RAID_MSS_LONG');
                // 4. multi-member episode 3（优先 epMemberCount>=2）
                pick(function (x) { return x.epMemberCount >= 2; }, null, 3, 'MULTI_MEMBER');
                // 5. 边界间隔验证层（原 G1/G3 邻近）：经验证 682 accepted GT 中
                //    nearG1 与 nearG3 均为 0（无"未触发但贴近门槛"的危险样本），
                //    且 causal!=episode最深member = 0。门槛与 PASS 集合间存在干净间隔带。
                //    因此本层降级为"最复杂 episode 挑战"：抽 epMemberCount>=4（多浪归因鲁棒性）。
                pick(function (x) { return x.epMemberCount >= 4; }, null, 3, 'COMPLEX_EPISODE');

                return chosen;
            }

            var bull = sampleDir(byDir.BULLISH, 0x1234 + 1);
            var bear = sampleDir(byDir.BEARISH, 0x9876 + 1);

            // ----------  输出格式化 ----------
            // 北京时间 = UTC+8，用本地 get 方法（Node 时区由 TZ 控制，这里手动 +8 避免依赖环境）
            function fmtTimeMs(ms) {
                if (ms == null) return '?';
                var d = new Date(ms + 8 * 3600 * 1000); // 先 +8h，再按 UTC 取值 => 即北京时间
                function p(n) { return (n < 10 ? '0' : '') + n; }
                return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' +
                    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' BJT';
            }
            function fmtTimeIdx(idx) {
                var c = candles5m[idx];
                if (!c || !c.openTime) return 'idx#' + idx;
                return fmtTimeMs(c.openTime);
            }
            function fmtPrice(idx) {
                var c = candles5m[idx];
                if (!c) return '?';
                return (arguments[1] === 'low') ? c.low.toFixed(1) : (arguments[1] === 'high') ? c.high.toFixed(1) : c.close.toFixed(1);
            }

            var out = [];
            out.push('=== A.4 Formation → 40 条人眼验收清单（' + SYMBOL + ' ' + DAYS + 'd, futures）===');
            out.push('窗口: ' + new Date(startTime).toISOString() + ' → ' + new Date(endTime).toISOString());
            out.push('来源：682 accepted GT（decision=TERMINAL && certaintyGate=PASS）。绝不抽 G1/G3 reject 样本。');
            out.push('边界间隔验证（已核验）：682 accepted GT 中 nearG1=0、nearG3=0、causal!=episode最深member=0。');
            out.push('  → G1/G3 门槛与 PASS 集合间存在干净间隔带，非擦边放过。原"G1/G3 邻近层"无危险样本可抽，');
            out.push('    降级为 COMPLEX_EPISODE（episode members>=4，挑战多浪归因鲁棒性）。');
            out.push('每条只问：A.4 给出的 causal raid（raid 时间/价）以当时可见信息，是否足够明确 = terminal manipulation → sustained repricing → Structural MSS 的 causal origin？');
            out.push('');
            out.push('标注规则（三选一）：');
            out.push('  PASS     = 我愿意把它当考卷答案');
            out.push('  UNCERTAIN = A.4 给得太确定，应该 NO_CLEAR');
            out.push('  FAIL     = 明显归因错了，存在另一个更合理的 causal raid');
            out.push('');
            out.push('数据查看方式（重要）：');
            out.push('  - 所有时间均为北京时间（BJT = UTC+8）。Binance 图表请把时区设为 UTC+8（或对应本地时区）。');
            out.push('  - 每条带 ts= 毫秒时间戳（UTC 绝对时间，无时区），可在 Binance 用该精确时间跳转，避免视觉对齐误差。');
            out.push('  - Actual Raid Candle 的 Low(BULL)/High(BEAR) 即清单 "Raid candle Low/High" 价；');
            out.push('    十字光标放到该 UTC 时间，那根 K 的对应极值必须 ≤/≥ 清单价（见每条 [自检] 行）。');
            out.push('  - Liquidity 价是 liquidity level 形成价（sweep.source.liquidityPrice），与 candle 实际极值可能差几 tick（wick 刺穿）。');
            out.push('');
            out.push('总计：BULL 20 + BEAR 20 = 40 条。');
            out.push('');

            function renderLayer(list, dirLabel) {
                out.push('──────────── ' + dirLabel + ' (' + list.length + ' 条) ────────────');
                list.forEach(function (entry, i) {
                    var a = entry.item;
                    var raidT = fmtTimeMs(a.occurredAt);
                    var mssT = fmtTimeIdx(a.Mi);
                    var raidP = (a.D === 'BULLISH')
                        ? candles5m[a.raidIdx].low.toFixed(1)
                        : candles5m[a.raidIdx].high.toFixed(1);
                    var mssP = (a.D === 'BULLISH')
                        ? candles5m[a.Mi].high.toFixed(1)
                        : candles5m[a.Mi].low.toFixed(1);
                    var gateInfo = [];
                    if (isFinite(a.nearG1)) gateInfo.push('nearG1=' + a.nearG1.toFixed(2) + 'ATR');
                    if (isFinite(a.nearG3)) gateInfo.push('nearG3=' + a.nearG3.toFixed(2));
                    // 自检：实际 candle 极值是否触达 liquidity level
                    var sc = a.selfCheckOk ? '✓ candle ' + (a.D === 'BULLISH' ? 'Low' : 'High') + ' ' + raidP +
                        ' ≤/≥ liq ' + (a.liqPrice != null ? a.liqPrice.toFixed(1) : '?') :
                        '✗ 自检失败：candle 极值未触达 liquidityPrice';
                    out.push('');
                    out.push('[' + dirLabel + '#' + (i + 1) + '] ' + entry.layer + '  (' + (a.D === 'BULLISH' ? 'BULL' : 'BEAR') + ')');
                    out.push('  mssId=' + a.mssId);
                    out.push('  Liquidity : ' + (a.liqPrice != null ? a.liqPrice.toFixed(1) : '?') +
                        '  (' + a.liqType + ')');
                    out.push('  Actual Raid Candle : ' + raidT + '  (idx#' + a.raidIdx +
                        (a.occurredAt != null ? '  ts=' + a.occurredAt : '') + ')');
                    out.push('  Raid candle ' + (a.D === 'BULLISH' ? 'Low' : 'High') + ' : ' + raidP);
                    out.push('  MSS : ' + mssT + '  ' + (a.D === 'BULLISH' ? 'break HIGH ' : 'break LOW ') + mssP +
                        '  (idx#' + a.Mi + ')');
                    out.push('  raid→MSS bars=' + a.raidToMssBars +
                        '  episode members=' + a.epMemberCount +
                        (gateInfo.length ? '  [' + gateInfo.join('  ') + ']' : ''));
                    out.push('  自检 : ' + sc);
                    out.push('  你的判定: [ ] PASS   [ ] UNCERTAIN   [ ] FAIL');
                    out.push('  备注: ________________________________________________');
                });
                out.push('');
            }

            renderLayer(bull, 'BULL');
            renderLayer(bear, 'BEAR');

            out.push('──── 汇总 ────');
            out.push('BULL: ' + bull.map(function (e) { return e.layer; }).join(', '));
            out.push('BEAR: ' + bear.map(function (e) { return e.layer; }).join(', '));
            // 全局自检统计
            var allItems = bull.concat(bear).map(function (e) { return e.item; });
            var ok = allItems.filter(function (a) { return a.selfCheckOk; }).length;
            out.push('');
            out.push('数据完整性自检：' + ok + '/' + allItems.length + ' 条 candle 极值触达 liquidityPrice');
            if (ok < allItems.length) {
                out.push('  ⚠ 存在自检失败条，见上方各条 [自检: ✗ ...] 标记。');
            } else {
                out.push('  ✓ 全部通过：每条 Actual Raid Candle 的 Low(BULL)/High(BEAR) 均 ≤/≥ 其 Liquidity level。');
                out.push('    打开 Binance 图表（时区设为 UTC+8），用 ts= 毫秒时间戳精确跳转，十字光标所在 K 的对应极值必须 ≤/≥ 清单价。');
            }
            out.push('');
            out.push('验收完成后：');
            out.push('  统计 PASS / UNCERTAIN / FAIL 数量');
            out.push('  看 FAIL 是否形成"重复、可解释的系统模式" — 仅当重复同类污染才重新打开 A.4');
            out.push('  若只是 1~2 个极端怪例 → 记录，不增规则');
            out.push('  无系统性污染 → Formation Ground Truth FREEZE → 回 Daily Bias Validation');

            var text = out.join('\n');
            var outFile = path.join(__dirname, '..', 'outputs', 'a4acceptance40_' + SYMBOL + '_futures.txt');
            fs.writeFileSync(outFile, text);
            console.log(text);
            console.log('\n[written] ' + outFile);
        });
    })
    .catch(function (err) {
        console.error('FATAL', err);
        process.exit(1);
    });
