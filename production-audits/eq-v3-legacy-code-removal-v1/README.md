# EQ V3 Legacy Code Removal V1

TASK_NAME=EQ_V3_LEGACY_CODE_REMOVAL_V1
BASELINE_COMMIT=ab887b9c3851e00144ef92512cfd3fbb195751d3
DATE=2026-09-01
VERDICT=EQ_V3_LEGACY_ISLAND_REMOVED
HARD_STOP_TRIGGERED=false
COMMIT=NONE
PUSHED=false

## 任务目标

清理已经退出 production runtime 的旧 EQ V3 legacy island。

当前 production EQ 已替换为：

```
ordinary confirmed 2/2
↔
prior 36H unviolated ATR50 ZigZag
→
EQH / EQL
```

并且：

- OLD_EQ_V3_RUNTIME_PATH_ENABLED=false
- EQ_PERSISTENT_IDENTITY=false
- EQ_CLUSTER_LIFECYCLE=false

本任务只删除服务旧 EQ V3 production / migration / shadow / audit / tests 的陈旧代码。
不做功能开发、不做 semantic 调整、不做 Sweep cleanup、不做 research cleanup 总清仓。

## 执行摘要

- **删除 58 个已跟踪文件**（18 个 JS + 40 个 JSON/MD 归档），另部分编辑 1 个混合测试
- **保留**：当前 production EQ（`productionEqualLiquidityV1` + `atr50CausalZigZag` + ordinary causal 2/2）、
  Liquidity Registry/Map、LIQUIDITY_TAKEN、Displacement、Taken 24-bar WATCH、FVG、Scenario、Notification 全部语义
- **LINES_REMOVED_ESTIMATE=28020**（git diff --cached --stat 精确值）
- **生产可达性**：删除前所有候选 productionRuntimeReachable=false（§3 反向/正向 trace 全 0 引用）
- **回归**：删除后全量 `node test/run.js` ALL TESTS PASSED（EXIT=0）
- **Sweep cleanup 明确延期**：sweepEventAdapter / sweepContext / liquidityProvenance /
  watchLiquidityEvidence / sweepNarrativeEligibility 全部保留（SWEEP_LEGACY_CLEANUP_DEFERRED=true）

## Legacy island 结构（删除前）

```
liquidity/persistentEqualLiquidityV3.js        ← V3 producer（cluster identity / member evolution）
  ├─ audit/eqPersistentClusterShadowV3.js      ← V3 shadow 核心
  │   ├─ audit/eqStructuralRetirementShadowV1.js
  │   ├─ audit/eqV2V3BlindComparisonV1.js
  │   ├─ scripts/eqClusterIdentityCollisionFixV1.js
  │   ├─ scripts/eqClusterLifecycleBoundaryAuditV1.js
  │   ├─ scripts/eqPersistentClusterShadowV3.js
  │   ├─ scripts/eqStructuralRetirementBoundedShadowV1.js
  │   ├─ scripts/eqV2V3BlindComparisonV1.js
  │   └─ tests × 3
  ├─ audit/eqHistoricalStateProjectorV1.js     ← V3 object/member 事件投影
  │   ├─ scripts/eqHistoricalMembershipEventStreamAuditV1.js
  │   └─ test × 1
  ├─ scripts/eqV3ProductionMigrationAcceptanceV1.js  ← V3 migration 验收（已失效）
  │   └─ eqh-eql-v3-production-migration-v1/（39 JSON/MD）
  ├─ scripts/eqhEqlProductionAlgorithmAuditV3.js     ← V3 生产算法审计
  │   └─ eqh-eql-production-algorithm-audit-v3/
  └─ eqh-eql-persistent-cluster-identity-design-v3/  ← V3 cluster identity 设计包（0 引用）
```

## 关键判定记录（§9 / §10）

| 目录 | 判定 | 理由 |
|---|---|---|
| `eqh-eql-persistent-cluster-identity-design-v3/` | DELETE | V3 cluster identity 设计包，0 外部引用；production 已废弃 cluster identity |
| `eqh-eql-production-algorithm-audit-v3/` | DELETE | V3 生产算法审计证据，审查对象（V3 算法）已退役；唯一消费者脚本同步删除；证据保留于 git 历史（HEAD 树完整） |
| `eqh-eql-v3-production-migration-v1/` | DELETE | V3 migration 验收包（PRODUCTION_EQ_SOURCE:'V3'），语义已被 ATR50 切换取代；消费者脚本同步删除 |
| `research/liquidity-sweep-confirmation-semantics-v1/` | KEEP | 闭包测试 SHA256 依赖（A 类） |
| `research/watch-narrative-sweep-association-audit-v1/` | KEEP | 已提交审计脚本 FIXTURES/OUT 路径依赖（A 类） |
| `production-audits/` 其余 3 目录 | KEEP | 进行中 WATCH_DUPLICATION 审计证据链（B 类） |

## 部分编辑（非删除）

`test/eqV3ProductionMigrationV1.test.js`：原 48 行含 1 个 legacy 用例（验证 V3 模块可 require）
+ 5 个 production 契约守卫用例。仅删除 legacy 用例与 `require('../liquidity/persistentEqualLiquidityV3')`，
保留 5 个契约守卫（ReplayState 忽略旧 toggles、production 不 import V3、config DEPRECATED 标记、
V3 cluster 不能伪装 partner provenance、replacement metadata 拒绝 persistent identity/member evolution）。
编辑后 5/5 PASS。

## 附带引用清理（§12）

6 个 accumulation 测试（`accumulationAuctionRepresentationV1` / `accumulationComparativeAuditV1` /
`accumulationEqRoleAuditV1` / `accumulationGroundTruthV1` / `accumulationRepresentationV2PrototypeV1` /
`accumulationResearchV1`）将已删的 `liquidity/persistentEqualLiquidityV3.js` 列入 production-baseline
hash 列表并 `fs.readFileSync`（无 existsSync 保护）。从列表移除该条目——测试意图
（research 调用不突变 production 源码）不变。6/6 EXIT=0。

## Final Audit 字段（§25）

```
OLD_EQ_V3_RUNTIME_PATH_ENABLED=false
NEW_PRODUCTION_EQ_ENABLED=true

LEGACY_EQ_V3_FILES_FOUND=58（18 JS + 40 JSON/MD）
LEGACY_EQ_V3_FILES_REMOVED=58
LEGACY_EQ_V3_TESTS_REMOVED=5
LEGACY_EQ_V3_SCRIPTS_REMOVED=8
LEGACY_EQ_V3_CONFIG_KEYS_REMOVED=0（无旧 EQ V3-only config keys；equalLiquidity 段被当前 production 读取，保留）

PRODUCTION_RUNTIME_REFERENCES_TO_REMOVED_EQ_V3=0
SHARED_EQ_TOLERANCE_STILL_COUPLED=false
SWEEP_LEGACY_CLEANUP_DEFERRED=true
HISTORICAL_RESEARCH_ARTIFACTS_PRESERVED=true

PRODUCTION_EQ_SEMANTICS_CHANGED=false
TAKEN_SEMANTICS_CHANGED=false
WATCH_SEMANTICS_CHANGED=false
FVG_SEMANTICS_CHANGED=false
NOTIFICATION_SEMANTICS_CHANGED=false

FILES_BEFORE=519
FILES_AFTER=461
FILES_REMOVED=58

LINES_REMOVED_ESTIMATE=28020

HARD_STOP_TRIGGERED=false
VERDICT=EQ_V3_LEGACY_ISLAND_REMOVED
COMMIT=NONE
PUSHED=false
```

## 当前 production EQ source of truth（§22）

```
CURRENT_EQ_SOURCE_OF_TRUTH =
  liquidity/productionEqualLiquidityV1.js
  + liquidity/atr50CausalZigZag.js
  + ordinary causal 2/2（equalLiquidity.js V2 pairwise utility，保留）

旧 persistentEqualLiquidityV3 标记：REMOVED FROM PRODUCTION（已删除）
```

## 保留项（§6 / §7 / §8 / §11）

- `liquidity/productionEqualLiquidityV1.js` / `atr50CausalZigZag.js` / `productionEqProvenance.js` — 未修改
- `liquidity/equalLiquidity.js`（V2 pairwise）— 保留（§14 类型 B，被 inspect/production 测试/阈值共享）
- `liquidity/liquidityLifecycle.js` — 保留（replay/replayState.js、stats/watchLiquidityEvidenceV1.js 等 production 依赖）
- `liquidity/liquidityCluster.js` — 保留（Liquidity Map 派生视图，与 EQ V3 cluster identity 无关）
- `config/thresholds.js` — 未改；`equalLiquidity` 段被 productionEqualLiquidityV1 读取（§11 无删除）
- Sweep 全套（sweepEventAdapter / sweepContext / liquidityProvenance / watchLiquidityEvidence / sweepNarrativeEligibility）— 全部保留
- `config/eqProductionVersion.js` / `eqSwingSource.js` — 保留 `DEPRECATED_FOR_PRODUCTION` 软标记（归档审计工具兼容）

## 参考文件

- `dependency-graph.json` — legacy island 依赖图与生产可达性证明
- `deleted-files.json` — 58 个删除文件的逐项记录
- `kept-files.json` — 保留的关键文件与理由
- `config-cleanup.json` — §11 config 审计结论
- `regression.json` — 基线 / 删除后回归 / smoke / 分类测试证据
