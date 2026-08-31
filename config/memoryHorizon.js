/**
 * Memory Horizon（Phase 11R.2 — State Convergence Audit）
 *
 * 每个模块/状态对象的记忆范围定义。Warmup Stability 不能要求所有模块
 * 在不同 warmup 下完全 identical——需要区分：
 *
 *   MUST_CONVERGE（有限记忆）  ：warmup 足够长后应收敛
 *   EXPECTED_LONG_MEMORY（长期记忆）：差异是合理的市场结构记忆（可解释）
 *
 * 判定标准：
 *   - MUST_CONVERGE 模块出现 warmup 差异 → UNEXPECTED_DIVERGENCE（bug / 状态泄漏）
 *   - EXPECTED_LONG_MEMORY 模块出现差异 → EXPECTED_DIVERGENCE（需追溯具体 liquidity 来源）
 *
 * 审计结论（2026-08-17）：
 *   - AMD 状态机本身 bounded（accumulation lookback 36 根 + phase-local 事件消费 + reset）
 *   - 但 AMD 的【输入】依赖长期 registry：collectEqualLiquidity 全量过滤（EQH 加分）
 *     与 sweep 事件流（来自长期 swing/calendar liquidity）→ AMD 输出经市场结构传导，
 *     归类 EXPECTED_LONG_MEMORY（非状态泄漏），但使 AMD 的独立收敛性无法验证
 *   - FVG displacement 关联 time-bounded（≤2 bars）→ MUST_CONVERGE
 *   - ATR14 Wilder 递减记忆，warmup 后收敛 → MUST_CONVERGE
 */
module.exports = {
    atr14: {
        horizon: 'decreasing (Wilder, ~14 bars)',
        classification: 'MUST_CONVERGE'
    },
    pivot5m: {
        horizon: 'few bars (left/right=2)',
        classification: 'MUST_CONVERGE'
    },
    equalLiquidity: {
        horizon: 'long (registry persistent)',
        classification: 'EXPECTED_LONG_MEMORY' // EQH 成员来自长期 swing
    },
    displacement: {
        horizon: 'current closed candle price facts',
        classification: 'MUST_CONVERGE'
    },
    amd: {
        horizon: 'bounded: accumulation + manipulation + displacement timeout',
        classification: 'MUST_CONVERGE (state machine), ' +
            'but inputs (EQH bonus / sweep events) depend on long-term registry ' +
            '→ practical convergence via EXPECTED_LONG_MEMORY path'
    },
    fvgLifecycle: {
        horizon: 'long but terminal (FILLED/INVALIDATED ends)',
        classification: 'EXPECTED_LONG_MEMORY (filled zones are historical facts)'
    },
    pddPdl: {
        horizon: '1 day (UTC)',
        classification: 'MUST_CONVERGE'
    },
    pwhPwl: {
        horizon: '1 week (UTC Monday)',
        classification: 'MUST_CONVERGE'
    },
    pmhPml: {
        horizon: '1 month (UTC)',
        classification: 'MUST_CONVERGE'
    },
    oldSwingLiquidity: {
        horizon: 'long (registry persistent)',
        classification: 'EXPECTED_LONG_MEMORY'
    },
    draw: {
        horizon: 'long (consumes liquidity registry + clusters)',
        classification: 'EXPECTED_LONG_MEMORY (differs only if liquidity source differs)'
    },
    bias: {
        horizon: 'long via draw/liquidity; short via delivery events',
        classification: 'EXPECTED_LONG_MEMORY (explainable via liquidity)'
    },
    scenario: {
        horizon: 'current context (bias + draw + AMD + alignment)',
        classification: 'MUST_CONVERGE given converged inputs'
    },
    entryGate: {
        horizon: 'previousState (current WATCH lifecycle)',
        classification: 'MUST_CONVERGE'
    },
    pendingTrade: {
        horizon: 'plan lifecycle (maxEntryWaitBars + hold)',
        classification: 'MUST_CONVERGE'
    }
};
