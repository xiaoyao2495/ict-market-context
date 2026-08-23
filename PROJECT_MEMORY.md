# PROJECT_MEMORY — ict-market-context

> **用途**：跨对话项目记忆。下个会话先读本文件，再按需翻 `.workbuddy/memory/2026-08-1*.md` 日志。
> **更新约定**：每完成一个阶段/修复，更新"当前状态/挂账/进行中方向"，保持与 git 最新 commit 同步。
> 最后更新：2026-08-19（git HEAD：`5ea65b1`，Phase 11L.5）

---

## 1. 项目一句话

ICT（Inner Circle Trader）市场结构驱动的**加密货币机会雷达**：历史回测研究 + 实时 5m 收盘检测 HIGH_QUALITY 机会 → 钉钉推送提醒。**只提醒，不下单、无仓位、无交易执行**。部署于 Windows 服务器 + PM2 常驻。

## 2. 技术栈与硬约束（不可违反）

- Node.js + CommonJS + **ES5 语法**（var/function，不用 let/const/arrow/class）；依赖仅 axios + ws；Node 22+（全局 fetch）
- 数据源：**Binance USDⓈ-M Futures（fapi.binance.com）唯一生产源**；`data-api.binance.vision`（spot 镜像）仅开发验证，**禁止混入生产**
- `source === 'futures'` 严格判定（undefined = 来源不明，拒绝）——init/HTF 增量/实时 5m/Top10 名单全链路 fail-closed
- 所有阈值参数集中在 `config/thresholds.js`，**禁止代码内硬编码**（Bias/AMD/FVG/minRR/MSS 等）
- V1 监控范围：`config/live.json` 默认 `symbolsMode:"fixed"` + `symbols:["BTCUSDT"]`（第一版只跑 BTC，验证后切 top10）
- 输出中文 + 英文术语（ICT/Liquidity/MSS/AMD/Bias/FVG/HTF/Near Draw/RR 等）
- git 推送 GitHub 需代理：`git -c http.proxy=http://127.0.0.1:7890 push origin main`（本机直连不通）

## 3. 架构总览（分层）

```
数据层
  data/binanceRest.js     getKlines/loadHistory/exchangeInfo/top-volume；futures 失败自动 fallback
                          spot-mirror 并标记 source（生产由 requireFutures 拒绝）
  replay/historicalLoader.js  分时加载 + data-cache/ 本地缓存（key=symbol+interval+dayBucket）
  live/dataSource.js      fetchInitial / pollNew5m({ok,error,candles}) / backfill5m /
                          fetchHtfIncrement(requireFutures, 不吞错, 返回 {ok,issues}) /
                          checkFuturesPurity / validate5mContinuity / makeFetcher(查表优先)

检测层（回测与 Live 共用同一批检测器）
  liquidity：PDH/PDL、PWH/PWL、EQH/EQL、PMH/PML、session、cluster（incrementalLiquidity 增量 pivot）
  events：2L/2R confirmed pivots → structuralProvenance5m（STRUCTURAL_BOS / STRUCTURAL_MSS /
          STRUCTURAL_CONTINUATION）→ displacementDetector → eventRegistry
  amd/amdState.js        Accumulation/Manipulation/Distribution/Invalidation 状态机
  FVG（incrementalFvg，leg 归属）

机会质量层（11D 系列，纯诊断 + tier）
  stats/displacementLeg.js   DisplacementLeg（candle→leg）；createWindowedLegBuilder = 15min 时间窗
                             （同向 && confirmedAt 差 ≤15min 合并）；**Replay/Live 单一实现**
  structure/structuralProvenance5m.js  5m protected-swing provenance + authoritative Structural MSS
  stats/opportunityQuality.js classifyOpportunityTier：HIGH=MSS(PROTECTED/HTF)×Leg(STRONG/EXPLOSIVE)×NearDraw
  stats/alertReplay.js       历史通知回放：availableAt 之后 N+1 统计 30m/1h Near Draw Hit + 距离分层
  stats/nearStaleness.js     checkNearConsumed（touch / close-cross mode，观察用）

回放/状态
  replay/replayEngine.js     runReplay；慢变量快照 snapshotInterval=12（calendar/cluster/draw/bias/scenario）
  replay/replayState.js      单根状态推进（incrementalLiquidity/Events/Fvg/ATR）
  replay/continuityChecker.js checkContinuity（gap/duplicate/out-of-order）

Live 管线
  live/liveEngine.js         createLiveEngine：单根增量，复用检测器；window 全局 index 对齐；
                             leg 关闭返回 opportunity（含 availableAt/nearConsumed）
  scripts/live.js            主循环：setTimeout 串行链 + tick 互斥；HTF 失败暂停 5m；
                             DATA_GAP → backfill → continuity 验证；HIGH → 钉钉投递
  live/persistence.js        candles.jsonl（5m 追加）+ pushed.json（delivered 去重）+ outbox.json
                             （transactional outbox，DETECTED→PENDING→DELIVERED）+ cursor.json
  notify/dingTalk.js         sendText：resolve 唯一语义 = errcode===0（310000 等业务失败 reject）
```

## 4. 核心语义决策（防踩坑，改前必读）

1. **anchorTime ≠ availableAt（11L.4 P0）**：leg 用 15min 时间窗合并，`availableAt` = 系统**首次能确认 leg 结束**的时点（new-displacement 触发 = 触发 K 收盘；timeout = lastConfirmedAt+15min）。`anchorTime`（最后位移 K）只描述 leg 本身。**通知与历史统计一律用 availableAt 之后的 N+1 起算**——否则 information-availability leakage 虚高 hit 率。
2. **Notification Snapshot 收口（11L.7 P0）**：通知内容（价格/Near Draw/距离）必须在 availableAt 时重新冻结：`notificationPrice`=availableIndex 处 close、`notificationNearTarget`=drawTrace[availableIndex] 的 near（回退 anchor 值）、`notificationNearDistPct`=|target-price|/price。anchor 的 nearTarget/nearDistPct 保留仅描述 leg。**post-alert MFE/MAE 以 notificationPrice 为基准**（不再用 anchorPrice，避免通知前位移被算进 post-alert MFE）。字段缺失回退旧字段兼容。
3. **触及 ≠ 失效（11L.5，数据否决方案 B）**：90d 显示"通知前 near 被触及/穿越"的机会 1h hit 反而更高（全样本 81% vs 剔除后 33-41%，被触及占 85%）——近端流动性被测试恰是机会生效标志。**不 suppress**，`opp.nearConsumed` 仅日志观察。
4. **Futures-only 全链路 fail-closed**：init（全 timeframe+exchangeInfo）、HTF 增量（spot 不 append）、实时 5m、Top10 名单，一律 `source === 'futures'`。
5. **DATA_GAP 严格**：backfill 后 `validate5mContinuity`（首根紧接 lastOpenTime+5m + 逐根连续）不通过 → `DATA_GAP_UNRESOLVED` 不推进，下轮继续补；重启时同样验证 candles.jsonl 历史连续，缺根拒绝启动。
6. **HTF 失败暂停 5m**：任一 HTF 更新异常 → 本轮不推进 5m（避免 stale HTF context 发 HIGH）；恢复后 poll 自动 gap→backfill。
7. **tick 并发锁**：setTimeout 串行链 + tickRunning 互斥，杜绝 setInterval 重入。
8. **Replay/Live 单一实现**：leg builder、检测器、tier 判定共享；parity 是验收硬指标。
9. **投递确认**：钉钉 `errcode===0` 才写 delivered；失败进 outbox 自动重试（按 oppId 去重），崩溃/重启不丢。
10. **参数/输出冻结**：跨 run 参数集不变；多层级输出 schema 固定（DATA QUALITY/FUNNEL/TRADE/PERFORMANCE/STOP/CONTEXT/MEMORY）。

## 5. 阶段历史（压缩）

| 阶段 | 内容 | tests |
|---|---|---|
| Phase 1-7.2 | 数据层→Liquidity Map→Bias→AMD 状态机 | — |
| Phase 8-11 | Scenario/Action、FVG+Entry Gate、Trade Planning+Simulation、Historical Replay+Stats | 526 |
| 11R/11R.1/11R.2 | 回放正确性重构、Integrity Patch、State Convergence/Memory Horizon 审计 | 537→ |
| 11S/11S.1 | Stop Placement / Retrace Diagnostics | 571 |
| 11T 系列 | Stop 语义审计（冻结）→ Narrative Boundary 严格化（11T.5S，657）→ 三币 180d Authoritative Run #1 | 661 |
| 11E 系列 | 执行正确性：HTF Closure、Cancel/Confirmation Shadow、Directional Confirmation 正式化（11E.6，668） | 668 |
| 11N | Narrative Direction Validation（dirHit 结构性弱 ~40%） | 670 |
| 11D.2-10 | Near/Macro Draw、Opportunity/DisplacementLeg 父级、MSS Reference Quality、Tier（11D.7）、Alert Validation（11D.8，88% 起源）、Delivery Alignment（11D.9）、HTF Liquidity（11D.10，假设否证） | 683 |
| 11L | Live Opportunity Radar（实时提醒，Windows+钉钉） | 685 |
| 11L.1 | Live/Replay 语义 parity（共享 windowed leg builder，HIGH 526→153 vs 153@30d） | 689 |
| 11L.2 | Top10 成交量雷达 + Production Readiness Fix 8 项（HTF 引用/leg 过期/futures fail-closed/网络/代理/安全/warmup 30d） | 692 |
| 11L.3 | Final Production Guardrails 4 项（init+HTF futures-only、continuity、钉钉确认投递、fixed 模式） | 720 |
| 11L.4 | Alert Availability-Time Fix（availableAt 语义，88%→81%）+ outbox 持久化 + init continuity + strict source | 730 |
| 11L.5 | Final Live Semantics 5 项（tick 锁、stale-near 观察化、source 统一严格、HTF 暂停 5m、outbox 去重） | 739 |
| 11L.7 | Trigger Price Shadow Audit（5 模型对比，数据否决等待 retrace）+ Notification Snapshot 收口（P0）+ JSONL 崩溃容错（P1）+ 文案保守化 | 758 |

Git 历史（main）：`b1a33d9 → 45217d4(11L) → 6d30df2(11L.1) → fc759a7 → ed459c5(11L.2) → 4e60acb → b165176(默认直连) → b34bfc4(11L.3) → 879da10(docs) → 533ac46(11L.4) → 5ea65b1(11L.5)`。仓库 `github.com/xiaoyao2495/ict-market-context`。

## 6. 当前验证状态（11L.5 后）

- **全量测试 739 PASS**（`npm test` = `node test/run.js`，逐文件独立进程）
- **7d parity：275/275 MATCH、TIER/ANCHOR/LIVE_ONLY/REPLAY_ONLY 全 0、HIGH 40=40（100%）**——`node scripts/parityCheck.js BTCUSDT 7`
- **90d HIGH 1h Near Draw Hit = 81%**（n=539，从 availableAt+1 统计，incomplete=0）；30m 77%；距离分层 `>0.5%` 桶 91%（信号硬，非距离幻觉）
- dirHit ~40%（结构性弱于 nearHit —— 已知，通知文案不承诺方向胜率）
- 关键脚本：`scripts/backtest.js BTCUSDT 90`（全报告）、`scripts/verifyLiveEngine.js`、`scripts/parityCheck.js`、`scripts/warmupParity.js`（证明 warmup 必须 30d）

## 7. 部署状态（Windows 服务器）

- 代码：git pull 到 `5ea65b1`；`npm install`；Node 22+
- 启动（同一 CMD 窗口）：
  ```bat
  cd /d C:\...\ict-market-context
  set DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN   :: 勿加引号
  pm2 start scripts/live.js --name ict-radar
  pm2 save
  ```
- 机器人：关键词模式（secret 可省略，消息首行含「检测」——**机器人实际配置的关键词是「检测」不是「监测」**，2026-08-19 上线自检发现）；`config/live.local.json`（gitignored）可替代 env
- 网络：**默认直连**（ICT_PROXY_ENABLED 默认 0）；服务器需代理时 set ICT_PROXY_ENABLED=1 + HOST/PORT
- 状态目录 `.live-state/<SYMBOL>/`：candles.jsonl / pushed.json / outbox.json / cursor.json / live.log
- 首次启动约 1-3 分钟（30d warmup）；日志顺序：启动横幅 → fixed 模式确认 → BTCUSDT 状态就绪 → 全部就绪开始轮询
- 若旧 `.live-state` 触发 strict purity 拒绝（无 source）→ 清理该目录重启

## 8. 挂账项（未完成，勿遗忘）

1. **restart 性能**：`replayTailBars` 未启用；长期方案（定期 state snapshot + 有限 tail replay）待设计（半年后重启会全量重放变慢）
2. **consumedRefs >7d 92%**：Structure Memory Lifecycle Audit（180d/365d 前关注 memory growth / MSS reference availability / runtime）
3. **retained invalidationBoundary 严格化**：180d 前定死（当前 BULLISH short=sweep||rangeLow；更严格=min(sweep,rangeLow)）
4. **180d Authoritative Trade Expectancy**：正式 trades 样本不足（3 笔全 LOSS），不宣布 edge；样本<10 不解读
5. **top10 模式**：fixed 验证通过后再启用（含每日 UTC 8:00 名单刷新）
6. ~~**生产 leg.mssId 无方向匹配**~~ **已关闭（11L.9 审计，2026-08-19）**：575 HIGH 逐笔检查 leg.direction vs mss.direction → **MATCH 575 / OPPOSITE 0 / MISSING 0**。生产无方向挂载 bug；11L.8-S2 的 570 vs 575 差异来自 shadow 关联选择逻辑（associateRelatedMss 取"距 startIndex 最近"，生产取"首根 displacement 的同根第一个 MSS"，同根多 MSS 时可能不同）+ tail leg 处理，非生产 bug。审计模块 `stats/mssDirectionAudit.js` / `scripts/mssDirectionAudit.js`（6 tests）保留可复用
7. **DisplacementLeg 只用 ATR 太粗**（11L.8 晚课程）：未来单独审计 **time efficiency / overlap / persistence / acceptance**，不和当前 Live 版本混在一起

## 9. 进行中方向（下一个会话从这里继续）

**ICT 2022 execution-location 通知层级（Price Watch）** —— 用户 2026-08-19 提出的方向：

- 背景：ICT 2022 逻辑 = Sweep → MSS+Displacement（产生 trade idea）→ 确认 displacement range 中 FVG → **等待价格 retrace 回 FVG/PD Array 再执行**。不追价。
- 用户结论：**不做 1m 策略层**（不需要 1m MSS/displacement/FVG/structure）。5m HIGH 已足够。
- 目标流程（未实现，已由 11L.7 数据验证）：
  ```
  5m HIGH_QUALITY Opportunity（availableAt）
      ↓ 计算 ICT 有意义的 Price Level（FVG / CE / OTE）
      ↓ 注册 Price Watch（纯价格触达）
      ↓ 价格进入 retracement 区域 → 钉钉
  ```

### ✅ Phase 11L.7 结论（BTC 90d，2026-08-19 已跑）

**数据明确否决"等待 retrace 再通知"**（与 11L.5 否决方案 B 同款模式）：

| Trigger | TriggerRate | MedianWait | NearHit1h | EffCapture | NoTrg→Hit |
|---|---|---|---|---|---|
| AVAILABLE | 100% (573) | 0m | **80.6%** | **80.6%** | 0 |
| FVG_TOUCH | 76.4% (438) | 10m | 64.2% | 49.0% | 128 |
| FVG_CE | 70.9% (406) | 20m | 58.4% | 41.4% | 159 |
| OTE_62 | 77.7% (445) | 15m | 62.9% | 48.9% | 123 |
| OTE_70_5 | 72.4% (415) | 20m | 58.3% | 42.2% | 149 |

- 等待触发反而让 NearHit1h **全面劣化**（80.6% → 58-64%）、MFE1h 下降（0.34 → 0.28-0.30）
- **NoTrigger→NearHit 123-159 笔**：坚持等 entry location 会错过大量真正 delivery
- 越深越差（CE < TOUCH，OTE70.5 < OTE62）：回撤深度单调恶化提醒质量
- **决策：维持 AVAILABLE 立即通知（现行为），不引入 Price Watch 等待触发**。OTE 教学数字（62/70.5）在"提醒系统"语境下不适用（不同于交易 entry 语境）
- 新增：`stats/triggerPriceAudit.js`（11 tests）、`scripts/triggerPriceAudit.js`（`node scripts/triggerPriceAudit.js BTCUSDT 90`）
- 挂账：① 母样本 n=573（当前窗口）vs 历史 539（更早窗口），口径一致 81%≈80.6% ② 本结论仅限"提醒"语义，若将来做交易 entry 需另测 ③ 未测更高触发率模型（如 re-trigger 或价格不再继续才提醒）

### ✅ Phase 11L.8 结论（Liquidity Provenance / Notification Explainability，2026-08-19 已实现+已跑 90d）

**切口：先让系统解释自己为什么发这条 HIGH（Liquidity Taken 行），再研究是否需要改变 HIGH。** 不改 HIGH/WATCH/LOW、MSS、Displacement、通知时机。

- 实现：`stats/liquidityProvenance.js`（Live/Replay 唯一关联函数：associateSweeps / classifySweepLegRelation / classifyMssLegRelation / format 通知行）+ `scripts/provenanceAudit.js`（90d 诊断）+ `test/liquidityProvenance.test.js`（13 tests）；buildAlerts 与 liveEngine.evaluateOpportunity 挂 `liquidityContext` + `mssRelation`；buildMessage 插 Liquidity Taken 行（NONE 不猜测）；阈值 `events.sweepProvenance.maxLookbackBars=96`
- 关联规则：LONG→SSL / SHORT→BSL；`sweep.confirmedAt <= availableAt`（无 future leakage，缺 confirmedAt fail-closed）；窗口 `leg.startIndex-N → leg.endIndex`（sweep 允许在 leg 内=INSIDE_LEG）；sweeps[] 记录全候选，primary=最近
- **90d 数据（HIGH n=575）**：
  - mssRelation：**HIGH 100% = INSIDE_LEG**（BEFORE/AFTER/NONE 全 0）——当前 displacement 只消费已 MSS 打破的 reference，BEFORE_LEG 场景从未进 HIGH 母样本；NearHit1h 65.2% 与 11L.7b 一致
  - sweep 关联率 99.0%（569/575）；primary BEFORE_LEG 552 / INSIDE_LEG 17
  - sourceType：SWING_LOW 229 / SWING_HIGH 205 / EQH 49 / EQL 34 / PDH 12 / session 系若干（**EQL+EQH 仅 14.6%**，主力是 swing）
  - 窗口敏感性无拐点：N=6→23% / 24→69% / 48→90% / 96→99%；候选均匀铺 0-96 bars，primary median leg 前 15 bars
- **待用户决策**：① 正式 N（建议 48 平衡，无拐点）② primary 选择（"最近" vs 近端加权——候选均匀，解释力有限）③ 通知 sourceType 显示策略（EQL 非主流，实际多为 SWING_LOW）
- 第二刀后半（改 MSS/Displacement 判定以纳入 BEFORE_LEG 场景）**未做**，用户明确暂不碰生产判定

### ✅ Phase 11L.8 第二刀 — MSS↔Leg Shadow Association Audit（已跑 90d，不改生产）

**状态：Liquidity Provenance 冻结；MSS↔Leg 进入 Shadow Association Audit；Live HIGH 继续运行不动。**

- 关键事实：现有 HIGH 575/575 全是 INSIDE_LEG —— displacementDetector 的 same-candle bonus 只把【同根】MSS 挂到 displacement（`mssByIndex[index][0].id`，且不校验方向），生产链几乎只允许 inside-leg MSS 进 HIGH
- 实现：`stats/mssShadowAudit.js`（associateRelatedMss：方向匹配 + 窗口 [start-6, end] + confirmedAt<=availableAt + 距离最近/并列取新；三组；shadow tier 只换 MSS 关联其余冻结）+ `scripts/mssShadowAudit.js` + `test/mssShadowAudit.test.js`（12 tests）；`events.mssShadow.beforeLookbackBars=6`
- **90d 结果（beforeBars=6）**：INSIDE all 1760 / HIGH 570（NearHit1h 65.1%、MFE 0.34）；BEFORE all 200 / **HIGH 仅 20**（NearHit1h 70% 但 n=20 不足）；NO_RELATED all 1116 / HIGH 0（**ALL NearHit1h 46.4% << INSIDE 63.3%**）
- **结论方向**：① 解除 same-candle 限制最多新增 ~3.5% HIGH，量级极小；② BEFORE 样本不足不下结论；③ NO_RELATED 46.4% vs INSIDE 63.3% 证明 MSS 关联有真实区分力、当前严格语义过滤了噪声 → **无强证据支持放宽，倾向维持现状**（最终由用户定）
- 注：shadow INSIDE HIGH 570 vs buildAlerts 575（~1%）：shadow 强制方向匹配，生产 leg.mssId 可能挂方向不匹配的同根 MSS（生产不校验方向）

### ✅ Phase 11L.8 最终冻结（用户决策，2026-08-19 22:07）

```
Liquidity Provenance        ✅ 冻结（48 窗口 + allCandidates/immediateSweep/primarySweep + 措辞保守）
MSS same-candle association ✅ 暂时保留（shadow 证明严格关联过滤噪声：NO_RELATED 46.4% vs INSIDE 63.3%）
BEFORE_LEG promotion        ❌ 不上线（仅 ~3.5% 增量、n=20 不足，收益不明确）
Live HIGH rules             ✅ 不动
```

- **下一步**：Liquidity Taken 通知行推服务器上线（已 push cebf7e6..0a06e2f），真实 Live 样本继续积累
- 挂账：leg.mssId 方向匹配（§8.6）、DisplacementLeg ATR-only 审计 time efficiency/overlap/persistence/acceptance（§8.7）

### ✅ Phase 11L.10 结论（Liquidity Recency Audit，2026-08-19 已跑 90d）

**问题：Sweep 距 Delivery 越近，机会质量越高吗？（ZEC 22-bars sweep 是显示怪还是统计也没价值）**

- 方法：90d HIGH=575 按 immediateSweep.barsBeforeLegStart 分桶；新 `stats/liquidityRecencyAudit.js` + `scripts/liquidityRecencyAudit.js`（4 tests）
- **结果**：INSIDE_LEG n=17 (NearHit1h 70.6%) / 1-3 n=72 (66.7%) / 4-6 n=44 (61.4%) / 7-12 n=112 (57.1%) / 13-24 n=153 (68.0%) / 25-48 n=122 (68.9%) / NONE n=55 (65.5%)
- **结论方向（数据，非策略结论）**：① 无单调趋势（近端 1-6 未一致优于远端 13-48）；② NONE 65.5% 与各桶相当，无 sweep 关联的 HIGH 质量并不差；③ ZEC 22-bars（13-24 桶）68.0% 与整体相当 → **只是显示怪，无统计价值差异**
- **决策：Liquidity Taken 维持纯 Context（不参与 HIGH），不引入 notificationSweep；Recency 不进入 Opportunity Quality 维度**（用户 2026-08-19 认可继续 Live）

### ✅ Phase 12.1-12.4 — Pivot/Swing/Liquidity Decoupling 结论链（2026-08-20 已提交 1e99de6，checkpoint 冻结）

```
12.1 2-2 Pivot 正名 LOCAL_PIVOT（注释层，零逻辑）+ Population Audit（90d 7056 pivots）：
     nesting 75.1%（±12 bars 内同向更极端）、67.5% 在 2h 内被回测 → 2-2 大量层级冗余
12.2 ATR Directional Change Shadow：candidate extreme 更新时锁定 extremeATR，
     等待 extremePrice-close >= extremeATR×k；五档 0.5-2.0 ATR；replacement 量化
     nesting 消解（k=1 吞 ~12200 local extreme）；leg range/ATR 全档 >=2；alt 100%
12.3/12.3b DC MSS Shadow（k=1.5 close）：MSS 3425→2252（-34%）；churn rate 7.7%→3.3%；
     churn clusters 14→1；MFE +9.4%、MAE -17% → Structural Swing 改进成立
12.4 完整 HIGH Shadow 四象限（BTC/ETH/BNB 90d 三币一致）：
     DC HIGH 减 35-40%（569/646/566→367/393/341）；LEGACY_ONLY NearHit30m 三币全负
     （-7.6/-7.0/-3.1pp）→ DC 删除假结构；DC_ONLY 三币均不差
```

**冻结定义（写入 commit）**：`STRUCTURAL_SWING := ATR-normalized Directional Change, k=1.5, confirmWith=close, ATR frozen at extreme, 严格 confirmedAt/causal`。修复：DC swing 包装必须带 metadata.index（否则 classifyMssReference 无 PROTECTED_SWING → HIGH=0）；confirmedAt 必须转时间戳（future-safety）。

### 🗄️ Phase 12.5A — Historical directional-change experiment（已归档）

- Historical implementation and audits moved under `archive/research-dc/`; they are not in the production dependency graph.
- replay/live 接入 flag；cursor.json `structureMode` fail-closed（模式变化拒绝启动）；启动日志 `STRUCTURAL_SWING_MODE=LEGACY/DC_ATR_1_5_CLOSE`
- 5 硬验收全过：①flag=false 零变化 ②flag=true BTC 90d HIGH 368(vs 367) ③Replay/Live parity（Live==全量 771==771）④future-safety ⑤回滚
- The former runtime environment switch was removed by 5m Structural Swing Refactor V1; production has one path only.
- **服务器已切 DC 模式**（2026-08-20 19:29 +08 起，日志 STRUCTURAL_SWING_MODE=DC_ATR_1_5_CLOSE）

### 🔴 Phase 12.5A.1 — Live Structural Reference Consistency Fix（已提交 30320f1，P0）

- **用户审出 P0**：12.5A 只切 MSS 生成端，`evaluateOpportunity` 的 classifyMssReference 仍用 legacy `state.swings` 解析 DC MSS（:DC: id 在 legacy 池找不到）→ NO_REFERENCE → Live HIGH 大量漏报；verify125a 离线对、Live 错（验收盲区）
- Historical consistency fix unified the reference pool; current production instead consumes authoritative 5m Structural Provenance events.
- **服务器已部署修复版**（2026-08-20 19:50 起）；DC 模式 30d：opportunities 1075 / 非 NO_MSS 407 / HIGH 98（vs legacy 146，-33% 正常减量）
- 11L.17 的 replayEngine equalLiquidity 字段混入 12.5A commit（只读输出，无行为影响，用户允许不回滚）

### ✅ Phase 12.5B — Structural Liquidity Causal Chain Shadow（已提交 3871073 + cb1138c + ebcbbff）

- **用户语义批评**（21:07 ETH 通知）：Priority Liquidity 现状 = 48-bars 窗口相关性（windowHasSignificant），用户会理解成"这次 SHORT 因为这个 BSL 被扫"——但 `EQH @ 2267.09 · 45 bars` 在价格下方、早已被穿越，不是 delivery 源头
- **12.5B 冻结定义（因果链）**：DC STRUCTURAL_SWING → Structural BSL/SSL candidate（confirmedAt 严格）→ 实际 Raid → 同方向 DC MSS → **MSS 精确归属当前 Leg（leg.mssId === mss.id）** → CAUSAL LIQUIDITY。纪律：**锁因果顺序不锁时间距离**（raidToMssBars/objectAgeAtRaid 审计字段跑分布）；不预设答案
- **三币 90d**：因果链覆盖率 100%（BTC 367/367、ETH 393/393、BNB 341/341，严格 leg.mssId 归属后）；WINDOW_ONLY=0 三币（旧窗口无独立增量）；CAUSAL_ONLY：BTC/ETH forward 不差、**BNB 差（-8pp）**
- **ETH 20:09 案例复核 PASS**（12.5B.1）：causal BSL @ 2305.52 raid 19:34(+08)（leg 前 4 bars）——不是 2267.09；19:49 的 2320 高点因 19:54 才确认（与 leg 同 bar）被因果顺序正确淘汰；2305.52 恰=通知 Immediate Context legacy swing @ 2305.50（新旧共识）
- **12.5B.2 Corroboration Audit**：BOTH 拆子桶（PDH/PDL、EQL/EQH、Session、MULTI、only，允许 overlap）。BNB +8pp 归因：EQL/EQH（+8.9pp）+ Session（+12.7pp）贡献；**PDH/PDL 三币全负（-4.5/-18.6/-16pp）**；BTC 上 corroboration 基本不加分 → **corroboration 不是通用 Priority Gate**（ETH Session 甚至反向 -7.9pp）
- **架构结论冻结**：Causal Chain = Narrative 层（解释"为什么发生"）；Corroboration = Priority 层（"值不值得打扰"）；**永久解耦**，corroboration 绝不回头改 Causal Narrative
- 数据源注意：本机 90d 镜像"延迟 6h"实为 data-cache 同天 bucket 命中旧缓存（cacheKey 用 Math.floor(end/DAY)）→ `DISABLE_DATA_CACHE=1` 强制重拉

### ✅ Phase 13 — Draw on Liquidity Quantification（V1 已提交 61548dc、13.1 已提交 bd7966e）

- **用户定案**：不造 BiasScore，量化"价格下一阶段更可能向哪个 Liquidity Object 交付"。三层：①Liquidity Map（上 BSL/下 SSL 候选池，ACTIVE 未 take，生命周期 FORMING→CONFIRMED→ACTIVE→RAIDED→RETIRED）②每候选特征向量（type/distanceATR/age/touch/cross/zone/htfStructure/deliveryAlignment，原始字段无总分）③Future Label（t 起未来第一个被 raid 的候选，未来只进 label 不进 feature）
- **V1（BTC 90d）**：nextDraw 98.7% 是 legacy 2-2 SWING（label 被 LOCAL_PIVOT 污染）；最近距离 56.6% vs 随机 50.6%
- **13.1 净化**（排除 legacy SWING，保留 PDH/PDL/PWH/PWL/Session/EQH/EQL/DC_SWING）：label 变有意义（EQH 4908/EQL 4043/DC_SWING 5467...）；**分桶揭示核心：30m 桶 nearest 76.2%（+26.6pp over random）+ HTF dir 66.9%；1h 59.1%；4h/24h ≈ 随机**——静态 map 只管"即将发生的 draw"（30m 内），79% 的 draw 在 4h/24h 后发生需 Delivery Context
- replay result 只读暴露：liquidityObjects / atrSeries / biasTrace(扩展 components+conflicts)

### 🔒 13A.2 ↔ Bias Phase 1 隔离纪律（用户 2026-08-21 定案，下一模型必读）

- **13A.2 不是 Bias 验证，是 HTF Structure feature audit**。`ALIGN_BULLISH 63.8%` 应读作
  **"Liquidity-Draw Direction Hit"（HTF 结构方向 vs 实际哪侧流动性先被 raid 的命中率）**；
  **不是 Bias accuracy，也不作下一代 Bias 的 Ground Truth**。
- **Bias 定义（刚锁定，13A.2 不得回改）**：Bias = 决定我们**等待哪一侧 liquidity raid**，
  以及 raid 后**寻找哪一方向的 delivery**；**不是预测下一边 liquidity 谁先被碰**。
  → 13A.2 测的恰是"谁先被碰"，天然落在 Bias 范围之外，只能当 HTF Structure 的特征证据。
- **13A.2 的 63.8% / 70% 暂时全部视为旁证，严禁回改 Narrative 的 raid/MSS/Displacement 定义**
  （用户 2026-08-21 09:08 强化）。用漂亮数字反调 Ground Truth = target leakage，地基会歪。
- **Follow-through 永远只当 Outcome，禁止并入 NARRATIVE FORMED 定义**（用户 2026-08-21 09:08 强化）。
  代码层 `stats/narrativeLabelAudit.js` 的 buildNarratives 已锁定只消费 raid→MSS→Disp，outcome
  （MFE/MAE/continuation/invalidation）独立在 outcomeOf 计算。若写回 formation，等于用 Bias 预测
  Narrative 时把"后来走对了"塞进正确答案——典型 target leakage。
- **Population Audit 第一步不是看"胜率"，是人工抽查**（用户 2026-08-21 09:08 强化）：随机抽
  20 条 Bullish + 20 条 Bearish 完整链，在图上确认程序所谓的 `Raid→MSS→Displacement` 真的像
  学的 ICT delivery，而非仅代码形式满足条件。`scripts/narrativeLabelAudit.js` 已内置"人工抽查锚点"
  打印（时间/价格/间隔），180d 数据已缓存，重跑即用。
- **双过关闸门**：机器统计四项过关 **且** 人眼 Narrative 抽查过关 → 才真正测试 Daily Bias。两步缺一不可。
- **主线唯一主线 = 正在跑的 Narrative 180d Population Audit（Bias Phase 1）**。
  第一轮 Population Audit **不评估任何 Bias 模型准不准**，只审计"考卷答案"四项：
  ① Bullish/Bearish Narrative 数量与频率是否合理；② Raid→MSS→Disp 时间顺序/间隔是否自然；
  ③ Narrative 成立后是否确有方向性 follow-through；④ 有无大量"机械闭环但无价格意义"的
  Narrative（若有 → 先修 Ground Truth，绝不进入 Bias 模型比较）。
- **只有当四项过关**，才进入真正的 Bias 验证：固定 T 时刻 HTF DC=BULLISH，看未来是否更易形成
  `SSL Raid → Bull MSS → Bull Disp`（而非 `BSL Raid → Bear MSS → Bear Disp`）——这才在测
  "HTF DC Structure 有没有 Daily Bias 能力"。
- 因此：**不继续扩 13A.2、不因 70% 漂亮就优化它**；等 Narrative 180d 结果，先审考卷本身。

### ✅ Phase 13A — Daily Bias 重构路线（单变量考试制；13A.2 与 Bias 验证严格隔离）

**顺序固定**：13A.1 当前 Bias 审计 → 13A.2 HTF DC Structure feature audit（**仅特征证据，非 Bias 验证**）→ 13A.3 Liquidity/Nearest → 13A.4 HTF Location → 13A.5 Vol-normalized Momentum → 13A.6 Efficiency/Regime → Incremental Combination。**不做 bullScore/bearScore 总分**（模型结构问题不是参数问题，旧引擎不修、仅作 Legacy Baseline）。

- **13A.1 已提交 1984076**：当前 Bias Engine = 4 组件（liquidity/structure/location/delivery）打分加权总分。BTC 90d：**整体 51.7%（含 LEAN，n=10499）；30m 桶 51.8%——对比 13.1 静态 map 30m 76.2%，Bias 落后 24pp → 无独立 draw 预测力（Legacy Baseline 冻结）**；58% 时间 NEUTRAL（STRUCTURE_VS_DELIVERY|MAJOR 11618）；组件：liquidity 60.0% > structure 52.6% > location 47.8% / delivery 47.0%（低于随机）；confidence hi 57.8%
- **13A.2 完成（未提交，HTF Structure feature audit，非 Bias 验证）**：HTF DC Structure 对 **流动性首次触碰方向**（PDH/PDL First，即哪侧 significant liquidity 先被 raid）的独立统计（`stats/htfDcStructureAudit.js` + scripts + 4 tests，指标已重命名为 **DrawDirHit**，不再称 Bias acc）。BTC 90d：4H states {BULLISH 269/TRANSITION 177/BEARISH 213}、1D {88/96/105}。**核心：1D_BULLISH 54.0% / 1D_BEARISH 53.8%；4H_BULLISH 61.4%；ALIGN_BULLISH Liquidity-Draw Direction Hit = 63.8%（+12.1pp over Legacy 51.7% 的 first-touch 背景口径，但二者不同度量，不可直接比 Bias）；CONFLICT_BULL_BEAR（1D Bull+4H Bear）→ PDL_FIRST 59.0%（4H 主导）**。horizon 分桶：4H_BULLISH <=4h 62.8%、**ALIGN_BULLISH <=12h 70.0%**、1D_BULLISH <=24h 57.9% → **时间尺度分化证实"4H→短期 Draw、1D→24h Draw"**。**结论定位：HTF DC Structure 对"流动性首次触碰方向"有统计信息（有价值的 HTF feature），但不验证 Bias（见上方隔离纪律）**；方向不对称（BULLISH 强/BEARISH 弱）。Structure State 定义：DC 状态机 state.direction（UP→BULLISH/DOWN→BEARISH；首根即 BULLISH；swing 确认后 2 htf bar = TRANSITION）
- **Bias Phase 1 historical note**：Narrative Formation = Opposite Raid（SSL→Bull / BSL→Bear）+ Structural MSS + Displacement；旧 directional-change replay artifacts 已移至 research archive，不再代表 production。

  **Bias Phase 1 — Ground Truth（冻结定义，用户 2026-08-21 09:08）**：

  ```
  历史市场
     ↓
  Opposite-side Liquidity Raid
     ↓
  同方向 DC Structural MSS
     ↓
  同方向 Displacement
     ↓
  NARRATIVE FORMED
     ├─ Formation 本身：数量 / 方向 / 频率
     │    Raid→MSS 时间
     │    MSS→Disp 时间
     └─ Outcome（独立观察）
          MFE / MAE
          continuation
          invalidation
          30m / 1h / 4h
  ```

  **⚠️ Follow-through 继续只当 Outcome，禁止加入 NARRATIVE FORMED 定义**——否则用 Bias 预测
  Narrative 时，等于提前把"后来走对了"写进正确答案（target leakage）。机器统计过关 + 人眼
  Narrative 抽查过关，才真正测试 Daily Bias。

## 10. 用户工作约定

- 中文输出，技术术语保留英文
- 结构化、逐阶段交付：文件清单 + 阶段规划 + acceptance criteria 表
- 先对齐架构原则/参数化/测试要求，再实现；**单变量实验**；人工复核 + 统计幻觉检验
- 审计式验收：baseline byte-identical、shadow diagnostics 先行、promotion 前零侵入证明
- 生产级质量：完整测试 + inspect 脚本 + 自主 BASELINE vs SHADOW 对比；锁定边界用例（INVALID_REFERENCE、future leakage、self-fill 等）
- 重大语义决策先跑数据再定（11L.5 教训：审计假设被 90d 数据推翻）
