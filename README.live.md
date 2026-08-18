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
   - 编辑 `config/live.json`：
     ```json
     {
       "symbols": ["BTCUSDT"],
       "warmupDays": 3,
       "pollMs": 30000,
       "dataDir": ".live-state",
       "dingtalk": {
         "webhook": "https://oapi.dingtalk.com/robot/send?access_token=你的TOKEN",
         "secret": "你的SEC"
       }
     }
     ```

5. **首次启动**（会拉 warmupDays 天历史并重建状态，约 1-3 分钟）：
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

## 网络注意

- Binance API（fapi.binance.com）在服务器上需可达。若需代理：
  ```
  set HTTP_PROXY=http://127.0.0.1:7890
  set HTTPS_PROXY=http://127.0.0.1:7890
  pm2 restart ict-radar
  ```
  （Node 22 fetch 会读取 HTTP_PROXY/HTTPS_PROXY 环境变量）
- 首次下载数据较慢属正常；之后 `data-cache/` 命中 + 增量轮询，开销极小。

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
- 长期运行内存：candles 窗口随运行时间增长（每根 ~100B，1 年约 3MB/币），
  如需无限运行可定期重启（重启会从 candles.jsonl 尾部重放，幂等）。
