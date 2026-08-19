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
  events：pivotDetector → mssDetector（MSS）→ displacementDetector（Displacement）→ eventRegistry
  amd/amdState.js        Accumulation/Manipulation/Distribution/Invalidation 状态机
  FVG（incrementalFvg，leg 归属）

机会质量层（11D 系列，纯诊断 + tier）
  stats/displacementLeg.js   DisplacementLeg（candle→leg）；createWindowedLegBuilder = 15min 时间窗
                             （同向 && confirmedAt 差 ≤15min 合并）；**Replay/Live 单一实现**
  stats/mssReference.js      MSS 质量：PROTECTED_SWING / INTERNAL / MICRO
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
- 机器人：关键词模式（secret 可省略，消息首行含「监测」）；`config/live.local.json`（gitignored）可替代 env
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

## 10. 用户工作约定

- 中文输出，技术术语保留英文
- 结构化、逐阶段交付：文件清单 + 阶段规划 + acceptance criteria 表
- 先对齐架构原则/参数化/测试要求，再实现；**单变量实验**；人工复核 + 统计幻觉检验
- 审计式验收：baseline byte-identical、shadow diagnostics 先行、promotion 前零侵入证明
- 生产级质量：完整测试 + inspect 脚本 + 自主 BASELINE vs SHADOW 对比；锁定边界用例（INVALID_REFERENCE、future leakage、self-fill 等）
- 重大语义决策先跑数据再定（11L.5 教训：审计假设被 90d 数据推翻）
