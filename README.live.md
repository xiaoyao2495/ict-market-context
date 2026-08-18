# Phase 11L — Live Opportunity Radar 部署说明（Windows 服务器）

实时机会提醒系统：每根 5m 收盘检测 HIGH_QUALITY ICT 机会，钉钉推送。
**不含下单/仓位/交易执行**——纯机会雷达。

## 架构

```
Binance REST (5m closed)
   → live/dataSource.js（初始历史 + 轮询增量 + HTF 收盘维护）
   → live/liveEngine.js（复用回测检测器：liquidity/MSS/DisplacementLeg/FVG/AMD + rebuildSnapshot）
   → Opportunity tier（MSS × Leg × Near Draw，与 11D.7 同一规则）
   → 去重（pushed.json，跨重启）
   → 钉钉推送（notify/dingTalk.js，加签）
```

持久化（`.live-state/<SYMBOL>/`）：
- `candles.jsonl`：已收盘 5m 追加日志（重启时读尾部重放重建状态，幂等）
- `pushed.json`：已推送机会 id（去重）
- `cursor.json`：最后处理位置
- `live.log`：运行日志

## Windows 部署步骤

1. **安装 Node.js 22+**（https://nodejs.org，选 LTS，安装时勾选 "Add to PATH"）

2. **获取代码**（三选一）：
   ```
   git clone https://github.com/xiaoyao2495/ict-market-context.git
   cd ict-market-context
   ```
   或从本机拷贝目录（保留 `data-cache/` 可免首次下载）。

3. **安装依赖**（如有）：
   ```
   npm install
   ```

4. **配置钉钉机器人**：
   - 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义
   - 安全设置选 **"加签"**（复制 secret）
   - 复制 webhook 地址（含 access_token）
   - 编辑 `config/live.json`（默认值已与生产一致，只需填 webhook/secret；未列出的字段用默认值）：
     ```json
     {
       "symbols": ["BTCUSDT"],
       "symbolsMode": "fixed",
       "warmupDays": 30,
       "pollMs": 30000,
       "dataDir": ".live-state",
       "requireFutures": true,
       "dingtalk": {
         "webhook": "https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN",
         "secret": "你的SEC",
         "keyword": "监测"
       }
     }
     ```
   - **第一版建议 fixed 模式（只监控 `symbols` 列表，默认 BTCUSDT）**：先验证单币
     通知质量，跑稳一周后再切 `"symbolsMode": "top10"`（自动监控成交量前 10 永续，
     每日 UTC 8:00 刷新名单，新进自动加入、掉出自动停掉并保留状态）。

5. **首次启动**（fixed 模式只初始化 `symbols` 列表，约 1-3 分钟；top10 模式约 3-10 分钟）：
   ```
   node scripts/live.js
   ```
   看到 `=== 全部 symbol 就绪，开始轮询 ===` 即正常运行。

6. **后台保活**（推荐 pm2）：
   ```
   npm install -g pm2
   pm2 start scripts/live.js --name ict-radar
   pm2 save
   ```
   开机自启：`pm2 startup`（按提示执行生成的命令；Windows 用管理员 PowerShell）。
   或不用 pm2：任务计划程序 → 创建任务 → 触发器"系统启动" → 操作 `node scripts/live.js`（工作目录设为项目目录）。
   （若服务器需要代理，pm2 场景请用 ecosystem 文件把 `ICT_PROXY_ENABLED=1` 等写入进程环境，
   而不是临时 CMD 的 set。）

### Windows 启动（webhook 用环境变量，token 不进 git 文件）

```bat
set DINGTALK_WEBHOOK=https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN
set DINGTALK_SECRET=你的SEC      :: 若机器人用"加签"；关键词模式可省略
pm2 start scripts/live.js --name ict-radar
pm2 save
```

注意（Windows CMD）：
- `set` 与 `pm2 start` 必须在**同一个 CMD 窗口**执行（set 只对当前会话生效，
  PM2 启动时会捕获当前环境；换窗口后 set 丢失）
- **set 的值不要加引号**：CMD 的 `set` 会把引号原样存进值，webhook 会带上引号导致请求失败
- `pm2 save` 后：`pm2 restart` 保留首次启动时的环境变量（pm2 存了 env dump）；
  开机自启（pm2 startup）同样从 dump 恢复，环境变量不丢
- 不想依赖 CMD 会话时，更稳的做法：在服务器项目目录建 `config/live.local.json`
  （已 gitignore，token 不进仓库）：
  ```json
  { "dingtalk": { "webhook": "https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN", "secret": "你的SEC" } }
  ```
  然后直接 `pm2 start scripts/live.js --name ict-radar`，无需 set

## 网络注意

- Binance API（fapi.binance.com）在服务器上需可达。**默认直连，无需任何设置**（config/network.js）：
  - 服务器可直连：零配置（生产默认）
  - 需要代理（受限网络 / 本机开发）：`set ICT_PROXY_ENABLED=1` + `set ICT_PROXY_HOST=127.0.0.1` + `set ICT_PROXY_PORT=7890`
    （macOS/Linux 用 `export`；仅本机开发需开启，服务器不要开）
- **网络健康日志**：运行日志区分 `NO_NEW_BAR`（正常）/ `NETWORK_ERROR`（网络失败，跳过本轮）/
  `DATA_GAP`（5m 不连续，自动补历史后恢复）/ `DATA_GAP_UNRESOLVED`（backfill 未补全，不推进 engine，
  下轮继续补）/ `DATA_SOURCE_DEGRADED`（requireFutures 下非 futures 数据，不推进）
- 首次下载数据较慢属正常；之后 `data-cache/` 命中 + 增量轮询，开销极小。

## 生产保护（11L.3，上线前必须）

- **Futures-only fail-closed**：`requireFutures=true` 时——
  - 初始化历史（5m/1h/4h/1d/1w/1M + exchangeInfo）只要发现非 futures 源 → 该 symbol **拒绝启动**
    （抛 `DATA_SOURCE_DEGRADED`，不 warmup 不建引擎），绝不带污染状态上线
  - HTF 增量返回非 futures → **拒绝 append**（Bias/Draw 不被 spot 污染），网络失败明确记
    `HTF_NETWORK_ERROR`（保留旧 snapshot，标记 stale，不吞错）
  - Top10 名单刷新同样要求 futures 源，否则保留现有监控
- **DATA_GAP 严格验证**：backfill 后必须通过 `validate5mContinuity`（首根紧接 + 逐根连续），
  任何缺口 → `DATA_GAP_UNRESOLVED` 不推进 engine，下轮继续补
- **钉钉确认投递**：`res.errcode === 0` 才算投递成功并记入去重集合（pushed.json）；
  失败（网络 / errcode!=0）→ 机会保留 pending，每轮 tick 自动重试，**不会漏掉 HIGH 通知**

## 验证（可选，需网络/缓存）

```
node scripts/verifyLiveEngine.js BTCUSDT 90
```
用历史数据逐根推进 live 引擎，输出 tier 分布并与回测 11D.8 对比
（回测参考（共享 15min 窗实现）：BTC 90d HIGH 539 / WATCH 935 / LOW 2773；
Live 逐根推进 HIGH 546 —— 30d parity 100% / 90d 98.7%，同一机会完全一致）。

## 消息示例

```
🔴 HIGH QUALITY WATCH · BTCUSDT
LONG (BULLISH)
MSS: PROTECTED_SWING · Leg: EXPLOSIVE (3.0 ATR)
Near Draw: 0.36% 距离（target 64513.2）
历史同级机会：1h Near Draw Hit 88%
时间: 2026-08-18 14:20 (UTC+8)
```

## 已知边界

- leg 机会语义 = 共享 15min 时间窗 builder（`createWindowedLegBuilder`，Replay/Live 单一实现，
  与 `buildOpportunities` 合并规则一致）；无 FVG 归属的 leg 不构成机会（与 Replay 身份一致）。
- 快照（bias/draw）每 12 根重建一次（与回测 SNAPSHOT_INTERVAL 一致）。
- 长期运行内存：candles 窗口随运行时间增长（每根 ~100B，1 年约 3MB/币）。
- **重启恢复（当前实现）**：`candles.jsonl` 全量加载并重放（幂等，重启安全），
  但跑半年后重启会重放全部 5m（启动变慢）——`replayTailBars` 目前未启用，
  长期方案（定期 state snapshot + 有限 tail replay）挂账，第一版不影响。
