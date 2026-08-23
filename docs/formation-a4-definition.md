# A.4 — Terminal Manipulation Episode Definition

> **阶段定位**：Bias Phase 1 — Narrative Ground Truth 的最后边界病例清理。
> **本步只做两件事**：① 冻结 `Terminal Causal Raid` 的语义定义；② 用现有 23 条人工裁决 material case 逐条验证该定义是否解释得通。
> **本步不写代码、不调任何参数**（`GAP_MAX` / `REP_THRESHOLD` / `ALIGN_ATR` 维持冻结）。定义能解释 23 条后，再操作化成 Shadow。
> **输入**：`outputs/a2sanity23_BTCUSDT_futures.txt`（23 条 confusion + 逐案）+ `outputs/a2dissect_MAT4_MAT18_BTCUSDT_futures.txt`（两条边界病例打穿）。

---

## 1. 从 A.2 到 A.4 的概念升级

A.2（Raid Cluster → terminal causal = 最深层 cluster → NO_CLEAR 闸门）暴露了两个**结构性盲点**（见 A.3 诊断）：

- **MAT#4（AMBIGUOUS → A.2 误判 A）**：ALIGN gate 只前向看 `[cStar.extremeIdx..Mi]`，漏掉了 cStar 之前更深、未注册的 wick（73699.2 @ idx=2721）。真正启动 repricing 的 terminal extreme 根本不在 eligible raid candidates 里。
- **MAT#18（B_CAUSAL → A.2 误杀 NO_CLEAR_ALIGN）**：Cluster 合并把 B 与 A 及后续 higher-high 揉成一个 nearest cluster，使 repricing discriminator（rule4）形同虚设；而"B 后已启动 repricing 到 63634"落在 cStar 之后，整个含 B 的 cluster 被 align 误杀。

两条病例共同指向：**A.2 把"Cluster"当成了 causal unit，并提前用极值/距离替我们决定了 causal identity。**

A.4 的核心转向：

```
A.2 思路（顺序反了）：
  多个 raid → 先 cluster → cluster 选 extreme → 再判断 causal
                ↑ cluster 提前替我们决定了因果身份

A.4 思路（正确顺序）：
  多个 liquidity interactions
        ↓
  识别 manipulation episode（负责"组织事件"）
        ↓
  在 episode 内寻找：
  "从哪一个 interaction 开始，
   市场第一次持续 repricing toward MSS？"
        ↓
  terminal causal point
        ↓
  最后才把同 episode 的 SWING / EQH / Session...
  挂到这个 causal episode 上（cluster 只负责组织，不决定因果）
```

> **关键原则**：Cluster 应该负责组织事件，不应该提前替我们决定 causal identity。
> **关键原则**：price path 本身可以否决 liquidity attribution —— 若 price 在 MSS 前继续产生更深的同侧 extreme 且无法对应到已登记 liquidity object，则 causal identity 未知。

这正是从"哪一个 sweep 离 MSS 最近？"转向真正的 ICT 问题：**"哪一次 manipulation 结束后，市场开始 delivery？"** —— 这才是未来拿来考 Daily Bias 的 Narrative Ground Truth。

---

## 2. Terminal Causal Raid — 冻结定义

> **Terminal Causal Raid** =
> 在 MSS 前最后一个 manipulation episode 中，
>
> ① 存在真实 liquidity interaction（已登记或可从 price path 识别的 manipulation 行为）；
> ② 从某个 interaction / extreme 开始，price 不再继续有效扩展 manipulation（即该 extreme 是该 episode 的 terminal 端点）；
> ③ 随后开始持续向 MSS 方向 repricing；
> ④ repricing 最终产生该 Structural MSS；
> ⑤ 若真实 terminal extreme 无法对应到已登记 liquidity object → **NO_CLEAR_CAUSAL_RAID**；
> ⑥ 若 episode 内无法客观确定哪个 interaction 启动 repricing → **NO_CLEAR_CAUSAL_RAID**。

**故意不进入定义的操作化参数**（以后只是"操作化参数"，不能进入 Ground Truth 语义）：

- ❌ "最近优先"（nearest-first）
- ❌ "Structural 优先"（structural-first）
- ❌ "最深优先"（deepest-first）
- ❌ 固定 `12 bars`（GAP_MAX）
- ❌ 固定 `0.6 ATR`（REP_THRESHOLD）
- ❌ 固定 `1.5 ATR`（ALIGN_ATR）

这些全部推迟到"操作化成 Shadow"阶段再给定，且必须作为可配置参数、不作为语义本身。

### 2.1 决策流（语义层，非代码层）

```
Raid Cluster（组织事件）
    ↓
从 cluster 开始观察 price path
    ↓
在 MSS 之前是否继续产生更深的同侧 extreme？
    │
    ├─ YES，且这个 extreme 没有对应合法 raid
    │       ↓
    │   CAUSAL IDENTITY UNKNOWN
    │       ↓
    │   NO_CLEAR_CAUSAL_RAID        ← 对应定义 ⑤
    │
    └─ NO（terminal extreme 已落在 episode 内）
        ↓
    episode 内寻找 "启动 repricing 的 interaction"
        │
        ├─ 可客观确定（B 后启动 repricing，A 只是 delivery 途中 liquidity）
        │       ↓
        │   terminal causal = 该 interaction（B）
        │
        └─ 无法客观确定（candidate pool 未抓到真正 terminal / 多个 interaction 等价）
                ↓
            NO_CLEAR_CAUSAL_RAID     ← 对应定义 ⑥
```

### 2.2 与 displacement 质量闸门的关系

定义 ①–⑥ 只解决 **causal attribution（哪次 manipulation 启动了 delivery）**。
"MSS 是否绑定合法 displacement leg"是**正交的质量闸门**（当前 `NO_DISP`），不进入本定义：
- 若 causal attribution 成功但无 bound displacement → 仍 `EXCLUDE`（不进 GT Narrative）。
- 若 causal attribution 失败（NO_CLEAR） → 无论有无 displacement 都不进 GT Narrative。

---

## 3. 两条边界病例如何用 A.4 解释

### MAT#4（Human = AMBIGUOUS，A.2 = A ← 机器过度自信）

```
registered B raid (2716, 73836)
  ↓
继续下探
  ↓
73699.2 ← 真正最低点，但没有对应 registered raid
  ↓
registered A raid (2725, 73813.4)
  ↓
MSS (2741)
  ↓
Displacement
```

- 按 A.4：cluster 内 B 之后 price 继续创新低（73699.2），该 extreme **无法对应到已登记 liquidity object** → 触发定义 **⑤ NO_CLEAR_CAUSAL_RAID**。
- 不是"硬选 A 还是 B"，而是 **causal identity unknown**。
- ✅ 与人工 `AMBIGUOUS` 完全一致（人工正是因"真正 terminal 极值未注册"而判 AMBIGUOUS）。
- 注：A.2 当前误判为 A，正是因为 ALIGN gate 前向盲点看不到 2721 的 73699。A.4 的 price-path 否决机制直接修复此误判。

### MAT#18（Human = B_CAUSAL，A.2 = NO_CLEAR_ALIGN ← 机器误杀）

```
B interaction (20791, SWING_HIGH 63550)
  ↓
开始 repricing sequence（上冲至 63634）
  ↓
途中 A / minor liquidity interaction (20807, EQH 63492)
  ↓
没有重新开启新的 manipulation sequence
  ↓
MSS (20841)
  ↓
Displacement (-7.86 ATR)
```

- 按 A.4：B 启动了 repricing sequence；A 只是 delivery 过程中的 liquidity interaction，未开启新的 manipulation episode；episode 内可客观确定 B 是 causal 起点 → **terminal causal = B**。
- A 只是 delivery 途中的 noise，不应抢 Narrative。
- ✅ 与人工 `B_CAUSAL` 完全一致。
- 注：A.2 当前误杀为 NO_CLEAR_ALIGN，是因为 cluster 合并把 B+A+63634 揉成 nearest cluster，使 rule4 永不触发、align 又因 63634 高于 cStar.extreme 而误杀整个 cluster。A.4 把"cluster 负责组织、causal 由 price path 决定"解耦，直接修复此误判。

---

## 4. 23 条人工 case 逐条验证（A.4 是否解释得通）

判定方法：对每条 case，按 §2 定义推导 A.4 预测裁决，与人工裁决比对。
`✓` = A.4 解释与人工一致；`(修)` = A.2 当前误判、A.4 会纠正。

| MAT# | 人工裁决 | A.4 预测 | 命中定义条款 | 说明 |
|------|----------|----------|--------------|------|
| 1  | A_CAUSAL  | A_CAUSAL  | ①②③④ | 单 cluster，A=nearest=deepest=terminal，无更深未注册 extreme，repricing→MSS ✓ |
| 2  | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=1862 为最后 episode terminal，B=1841 较早 ✓ |
| 3  | AMBIGUOUS | AMBIGUOUS | ⑤/⑥   | candidate pool 未抓到真正 terminal / A 后仍继续扩展 → NO_CLEAR ✓ |
| 4  | AMBIGUOUS | AMBIGUOUS | ⑤     | 73699.2 未注册更深 extreme → NO_CLEAR **(修：A.2 误判 A)** ✓ |
| 5  | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=6543 terminal ✓ |
| 6  | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=6696 terminal ✓ |
| 7  | EXCLUDE    | EXCLUDE    | 正交质量闸门 | 无 bound displacement（Disp:-）→ 不进 GT ✓ |
| 8  | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=7549 terminal，align 误杀应纠正 **(修：A.2 误杀 NO_CLEAR_ALIGN)** ✓ |
| 9  | SAME_POOL | SAME_POOL | ①②③④（合并）| A/B 同池(Δ1)，episode 内合并取主身份 ✓ **(修：A.2 误杀 NO_CLEAR_ALIGN)** |
| 10 | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=8777 terminal ✓ |
| 11 | AMBIGUOUS | AMBIGUOUS | ⑤/⑥   | 无法客观确定 terminal → NO_CLEAR ✓ |
| 12 | AMBIGUOUS | AMBIGUOUS | ⑤/⑥   | 无法客观确定 terminal → NO_CLEAR ✓ |
| 13 | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=13326 terminal ✓ |
| 14 | AMBIGUOUS | AMBIGUOUS | ⑤     | 真正 terminal 极值未标记 → NO_CLEAR ✓ |
| 15 | B_CAUSAL  | B_CAUSAL  | ①②③④ | B=15333 启动 repricing，A=15336 仅途中 minor ✓ |
| 16 | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=17832 terminal ✓ |
| 17 | SAME_POOL | SAME_POOL | ①②③④（合并）| A/B 同池(Δ2)，合并 ✓ **(修：A.2 误杀 NO_CLEAR_ALIGN)** |
| 18 | B_CAUSAL  | B_CAUSAL  | ①②③④ | B=20791 启动 repricing，A 仅途中 **(修：A.2 误杀 NO_CLEAR_ALIGN)** ✓ |
| 19 | SAME_POOL | SAME_POOL | ①②③④（合并）| A/B 同池(Δ1)，合并取主身份 ✓ |
| 20 | EXCLUDE    | EXCLUDE    | 正交质量闸门 | 无 bound displacement → 不进 GT ✓ |
| 21 | EXCLUDE    | EXCLUDE    | 正交质量闸门 | 无 bound displacement → 不进 GT ✓ |
| 22 | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=23771 terminal ✓ |
| 23 | A_CAUSAL  | A_CAUSAL  | ①②③④ | A=23771(24177) terminal ✓ |

### 4.1 汇总

| 人工裁决 | 条数 | A.4 解释 | 一致性 |
|----------|------|----------|--------|
| A_CAUSAL  | 10 | 10/10 均解释（MAT#8 当前被 A.2 误杀，A.4 纠正） | ✅ 10/10 |
| B_CAUSAL  | 2  | 2/2 均解释（MAT#18 当前被 A.2 误杀，A.4 纠正） | ✅ 2/2 |
| SAME_POOL | 3  | 3/3 均解释（MAT#9/17 当前被 A.2 误杀，A.4 纠正为合并 causal） | ✅ 3/3 |
| AMBIGUOUS | 5  | 5/5 均解释（MAT#4 经 ⑤ 未注册 extreme；其余经 ⑤/⑥） | ✅ 5/5 |
| EXCLUDE   | 3  | 3/3 均解释（正交 displacement 质量闸门，与 causal attribution 无关） | ✅ 3/3 |

**→ A.4 定义解释 23/23 人工裁决。**

### 4.2 A.4 相对 A.2 会纠正的 case（共 5 条）

| MAT# | A.2 当前 | A.4 预测 | 纠正机制 |
|------|----------|----------|----------|
| 4  | A (误判)   | AMBIGUOUS (NO_CLEAR) | price-path 否决：2721 的 73699 未注册 → ⑤ |
| 8  | NO_CLEAR_ALIGN (误杀) | A_CAUSAL | A 为真实 terminal，无更深未注册 extreme → ①②③④ |
| 9  | NO_CLEAR_ALIGN (误杀) | SAME_POOL | 同池合并，episode 内 causal 成立 |
| 17 | NO_CLEAR_ALIGN (误杀) | SAME_POOL | 同池合并，episode 内 causal 成立 |
| 18 | NO_CLEAR_ALIGN (误杀) | B_CAUSAL | B 启动 repricing，A 仅途中 → ①②③④ |

> 注：MAT#3/11/12/14 在 A.2 与 A.4 下均为 NO_CLEAR/AMBIGUOUS（一致），不需纠正。

---

## 5. 冻结条件检查（A.4 是否达到"可操作化"门槛）

按用户锁的路线，A.4 达到以下状态即可进入"操作化成 Shadow"：

- [x] Terminal Causal Raid 语义定义已冻结（§2，无 nearest/structural/deepest 优先级，无固定 12/0.6/1.5）。
- [x] Cluster 角色重新定位为"组织事件"，不决定 causal identity（§1）。
- [x] price path 可否决 liquidity attribution（定义 ⑤）。
- [x] 23/23 人工 case 用定义解释得通（§4）。
- [x] displacement 质量闸门明确为正交（§2.2）。
- [ ] **待用户确认定义文本后**，再操作化成 Shadow（本步不写代码）。

---

## 6. 下一步（用户确认定义后）

1. 操作化 A.4 为 Shadow（`buildNarrativesA4` 或扩展 `buildNarrativesA2` 的 shadow 分支），参数仍作可配置项（GAP_MAX / REP_THRESHOLD / ALIGN_ATR 不写死在语义里）。
2. 重跑 23 条 sanity set，验证是否达：A_CAUSAL 10/10、B_CAUSAL 2/2、AMBIGUOUS 5/5→NO_CLEAR、SAME_POOL 合理合并、EXCLUDE 3/3。
3. 通过后 → 90d Population Audit → 新 20 Bull + 20 Bear 人眼验收 → Ground Truth 冻结 → 正式开始 Daily Bias Validation。

**纪律重申**：本步未写任何代码、未改任何参数；production `buildNarratives` / Bias / Outcome / 13A.2 / raid quality gate 全不动。
