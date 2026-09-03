/**
 * 全局阈值配置（统一入口，禁止散落在各模块中）
 */
module.exports = {
    /**
     * Equal Liquidity V2（EQH / EQL）
     * Pipeline: Lifecycle → Price → Formation → bounded anchor grouping
     *
     * Price Gate 主尺度：distanceATR（第二个 swing confirmedAt 时的 ATR）。
     * Formation Gate：departureATR + 0.5 ATR zone 外完整 candle 的最大连续根数。
     * barsApart 仅保留为 diagnostic，不再参与 hard gate。
     * percentageTolerance / minBarsApart / maxBarsApart 仅保留给历史 audit 兼容读取，
     * V2 production classifier 不使用它们作判定。
     */
    equalLiquidity: {
        version: 2,
        atrPeriod: 14,
        priceStrongMaxATR: 0.7,
        priceFailAboveATR: 1.1,
        formationDepartureMinATR: 1.75,
        formationZoneATR: 0.5,
        formationMinConsecutiveOutsideBars: 1,
        percentageTolerance: 0.0002,
        minBarsApart: 3,
        maxBarsApart: 200,
        minTouches: 2
    },

    /**
     * Liquidity Cluster 聚类参数
     * - percentageTolerance: 成员并入 cluster zone 的百分比容差（0.0003 = 0.03%）
     *   聚类采用 zone 链式扩展：新成员 price - zoneHigh <= price * tolerance 即并入
     */
    liquidityCluster: {
        percentageTolerance: 0.0003
    },

    /**
     * Strength Score（项目自定义量化模型，不是 ICT 官方评分）
     *
     * Individual: score = round((typeWeight + swingTimeframeBonus) * freshness)
     *   - 非 SWING 类型不加 timeframeBonus（如 EQH/EQL 已含均衡 significance，防 double counting）
     *   - SWING: swingBaseWeight + swingTimeframeBonus = 表值（5m 20 / 15m 30 / 1h 45 / 4h 60 / 1d 75）
     *
     * Cluster: final = min(100, max(memberStrength) + confluence + diversity)
     *   - confluence = (有效成员数 - 1) * confluencePerAdditionalMember
     *   - diversity = (有效成员类别数 - 1) * diversityPerCategory
     *
     * Strength 只回答“流动性本身有多重要”，不掺入与当前价格的距离；
     * Distance / Draw probability 留给后续 Draw Engine。
     */
    strength: {
        typeWeights: {
            EQH: 55,
            EQL: 55,
            ASIA_HIGH: 45,
            ASIA_LOW: 45,
            LONDON_HIGH: 50,
            LONDON_LOW: 50,
            NEW_YORK_HIGH: 50,
            NEW_YORK_LOW: 50
        },
        swingBaseWeight: 20,
        swingTimeframeBonus: {
            '5m': 0,
            '15m': 10,
            '1h': 25,
            '4h': 40,
            '1d': 55
        },
        freshness: {
            ACTIVE: 1.0,
            TOUCHED: 0.8,
            SWEPT: 0,
            BROKEN: 0
        },
        confluencePerAdditionalMember: 6,
        confluenceMax: 24,
        diversityPerCategory: 5,
        diversityMax: 15
    },

    /**
     * tickSize 基础设施（来自交易所 PRICE_FILTER）
     * tolerance 在 tickSize 存在时升级为：
     *   max(percentageTolerance, tickSize * multiplier)
     * tickSize 缺失（受限环境）时退化为纯百分比，不影响系统运行。
     */
    tickSize: {
        equalMultiplier: 2,
        clusterMultiplier: 2
    },

    /**
     * Draw on Liquidity Engine 参数
     *
     * Draw Score = Strength×w1 + Distance×w2 + Freshness×w3（w 之和必须 = 1）
     * Draw Score 不是 probability，只是“作为当前 liquidity target 的相对优先级”。
     *
     * 方向 label 表达 Liquidity Draw imbalance，不是 Bias：
     *   imbalance >= strongBsl            → 'BSL'
     *   leanBsl <= imbalance < strongBsl  → 'LEAN_BSL'
     *   leanSsl < imbalance < leanBsl     → 'BALANCED'
     *   strongSsl < imbalance <= leanSsl  → 'LEAN_SSL'
     *   imbalance <= strongSsl            → 'SSL'
     */
    draw: {
        weights: {
            strength: 0.55,
            distance: 0.3,
            freshness: 0.15
        },
        distanceBands: [
            { maxPct: 0.0025, score: 100 },
            { maxPct: 0.005, score: 85 },
            { maxPct: 0.01, score: 70 },
            { maxPct: 0.02, score: 50 },
            { maxPct: 0.04, score: 30 }
        ],
        distanceFallbackScore: 15,
        clusterStateMultiplier: {
            ACTIVE: 1.0,
            PARTIAL: 0.75,
            CONSUMED: 0
        },
        directionThresholds: {
            strongBsl: 25,
            leanBsl: 10,
            leanSsl: -10,
            strongSsl: -25
        }
    },

    /**
     * Bias Engine 参数（Phase 6，工程初始值，Replay 后校准）
     *
     * Bias 是方向性判断，与 Draw（目标吸引力）分开。
     * 分项：Liquidity / Structure / Location /（Delivery / Conflict 在 Phase 6.2）
     *
     * - liquidity: Draw direction → bias evidence points
     *   BSL +30 / LEAN_BSL +15 / BALANCED 0 / LEAN_SSL -15 / SSL -30
     * - structure: 各周期结构（BULLISH ±maxWeight），主周期优先加权合成
     * - location: 只给已有方向加减可信度（接收 drawDirection，不独立判断方向）
     *   正数 = 支持 draw 方向，负数 = 削弱
     * - rangeThresholds: premium/discount 的 ratio 分界
     *   ratio = (price - low) / (high - low)，0=low，1=high
     */
    bias: {
        liquidity: {
            BSL: 30,
            LEAN_BSL: 15,
            BALANCED: 0,
            LEAN_SSL: -15,
            SSL: -30
        },
        structure: {
            maxWeights: {
                '1d': 25,
                '4h': 20,
                '1h': 10
            },
            mix: {
                '1d': 0.45,
                '4h': 0.4,
                '1h': 0.15
            }
        },
        location: {
            // 以 bullish 参考（draw 偏 BSL）为例；bearish 参考时对称取反
            premiumExtreme: -10,
            premium: -5,
            equilibrium: 0,
            discount: 10,
            discountExtreme: 15
        },
        rangeThresholds: {
            extremePremium: 0.8,
            premium: 0.55,
            discount: 0.45,
            extremeDiscount: 0.2
        },

        /**
         * Delivery Bias（Phase 6.2）
         * 事件链：Sweep → Displacement（方向必须匹配、顺序严格、窗口内）
         *   sweepPoints 8 / displacementPoints 10 → 完整链 ±18
         * 窗口：Sweep→Displacement <= 18 bars（沿用旧两段窗口总长度）
         * freshness：0-6 bars ×1.0 / 7-12 ×0.75 / 13-24 ×0.5 / >24 ×0.25
         */
        delivery: {
            sweepPoints: 8,
            displacementPoints: 10,
            sweepToDisplacementBars: 18,
            // Phase 11R.2：Delivery 查询从【数学上被 freshness 压低】升级为【结构上有限记忆】。
            // 事件先裁切到 evaluationTime - maxLookbackBars 再构造 chain（覆盖完整链 18 bars + freshness 24 bars）。
            maxLookbackBars: 48,
            freshnessBands: [
                { maxBars: 6, multiplier: 1.0 },
                { maxBars: 12, multiplier: 0.75 },
                { maxBars: 24, multiplier: 0.5 }
            ],
            freshnessFallback: 0.25
        },

        /**
         * 五档方向阈值（Bias Score，与 draw.directionThresholds 不同）：
         *   >= +35            BULLISH
         *   +15 ~ +34.999     LEAN_BULLISH
         *   -14.999 ~ +14.999 NEUTRAL
         *   -34.999 ~ -15     LEAN_BEARISH
         *   <= -35            BEARISH
         */
        directionThresholds: {
            strongBias: 35,
            leanBias: 15,
            leanBear: -15,
            strongBear: -35
        },

        /**
         * Confidence（只输出 LOW / MEDIUM / HIGH，不做伪概率）
         * 基础：abs(score) < 15 LOW / < 35 MEDIUM / >= 35 HIGH
         * 每个 MAJOR conflict 降 1 级（2+ 降 2 级）
         * evidence coverage：< 0.5 强制 LOW；< 0.75 最大 MEDIUM
         */
        confidence: {
            lowThreshold: 15,
            highThreshold: 35,
            majorConflictDowngrade: 1,
            coverageForcedLow: 0.5,
            coverageMaxMedium: 0.75
        }
    },

    /**
     * Market Event Layer（Phase 7.1）
     * 统一事件：LIQUIDITY_SWEEP / DISPLACEMENT
     * 所有事件 confirmedAt = 触发 candle.closeTime（禁止用 openTime）
     */
    events: {
        atr: {
            period: 14
        },
        displacement: {
            bodyRatioThreshold: 0.6,
            rangeAtrThreshold: 1.2,
            bodyAtrThreshold: 0.8,
            closeExtremeThreshold: 0.75,
            multiCandle: {
                atrPeriod: 14,
                nVariants: [2, 3, 4, 5],
                normalizedMoveThreshold: 1.0,
                directionalEfficiencyThreshold: 0.70,
                normalizedSpeedThreshold: 0.30
            }
        },
        /**
         * Phase 11L.8 — Sweep Provenance 关联（Liquidity Taken 通知行）
         * maxLookbackBars：sweep 候选窗口 = leg.startIndex - N → leg.endIndex。
         * 11L.8 定稿 = 48（production explainability 窗口）：90d 数据 N=48 关联率 ~90%，
         * 避免为了 99% 关联率把过旧 sweep 强行挂到当前 Opportunity。
         * 只影响通知的 Liquidity Taken 行，不影响 HIGH/WATCH/LOW 判定。
         */
        sweepProvenance: {
            maxLookbackBars: 48
        },
        /**
         * Phase 11L.13 — Liquidity Incremental Value Audit（旁路，不改生产）。
         * 判定两个 sweep 是否"同一价格区域 + 时间窗口"（共现）：
         *   priceTolerance：价格相对容差（0.001 = 0.1%）
         *   overlapBars：时间窗口（12 = 1h）
         * 仅审计参数。
         */
        sweepIncremental: {
            priceTolerance: 0.001,
            overlapBars: 12
        },
        /**
         * Phase 11L.14 — EXTERNAL_SWING Shadow（旁路，不改生产）。
         * 透明规则把普通 5m SWING 拆成 INTERNAL/EXTERNAL：
         *   EXTERNAL = 形成后 >= ageMinBars 才被 sweep（长期未被取）
         *              OR 接近 1h/4h 极值（± htfTolerance，截至 sweep 时刻，无 future leakage）
         * 仅审计参数。
         */
        sweepExternal: {
            ageMinBars: 24,
            htfTolerance: 0.002
        }
    },

    /**
     * Phase 11L.15 — Alert Prioritization（通知层筛选，检测层零改动）
     *
     * 背景：Top10 → 更多币 + 美股合约后"所有 HIGH 都推钉钉"不可持续。
     * 拆两层：Detection（HIGH/WATCH/LOW 全保留落日志）与 Notification（Alert Filter → 钉钉）。
     *
     * B 口径（用户选定，A 口径数据失败已关闭）：
     *   HIGH + 48 窗口内存在任一 Significant Liquidity（EQL/EQH/Session）
     *     → notifyPriority = PRIORITY_HIGH → 钉钉立即推
     *   HIGH + 窗口内无显著流动性
     *     → notifyPriority = STANDARD_HIGH → 只落日志 / shadow（3-7 天 Live 对比后决定是否正式只推 PRIORITY）
     *
     * 硬约束：notifyPriority 只决定通知优先级，绝不回写 tier（Detection 冻结；
     * 通知筛选层不得混进机会检测层）。
     *
     * enabled=true  → 钉钉只推 PRIORITY_HIGH，STANDARD_HIGH 只落日志（Live Shadow Prioritization）
     * enabled=false → 全部 HIGH 照常推钉钉（仅记录 notifyPriority 字段供审计）——回滚开关
     */
    notify: {
        prioritization: {
            enabled: true
        }
    },

    /**
     * AMD（Accumulation → Manipulation → Distribution）参数（Phase 7.2）
     * AMD 不重新检测事件，只消费 Event Registry / Liquidity Map / Bias。
     * AMD Score 不是 probability。
     */
    amd: {
        accumulation: {
            minBars: 12,
            maxBars: 36,
            maxNormalizedRange: 3.0,
            maxEfficiency: 0.35,
            minMidCrosses: 3,
            scoreWeights: {
                rangeCompression: 30,
                lowEfficiency: 25,
                midCrosses: 20,
                equalLiquidity: 15,
                duration: 10
            },
            confirmThreshold: 60
        },
        manipulation: {
            maxBars: 12,
            atrTolerance: 0.1,
            percentageTolerance: 0.001,
            scoreWeights: {
                rangeBoundarySweep: 35,
                equalLiquiditySweep: 15,
                calendarSessionSweep: 15,
                fastReclaim: 20,
                reasonablePenetration: 15
            },
            // 阈值冻结（Phase 11R，2026-08-17）：用户审计要求撤回 50 实验值，
            // 恢复 baseline 60。Replay Correctness 修完前不调策略阈值。
            // 实验值 50 保留在 git 历史 / 诊断脚本，Phase 11R 完成后用 Diagnostics
            // 对比 50/55/60（比较状态数量 + 后续 excursion + draw hit rate，非收益）。
            confirmThreshold: 60
        },
        distribution: {
            displacementMaxBars: 6
        },
        score: {
            accumulation: 0.3,
            manipulation: 0.3,
            distribution: 0.4
        },
        invalidate: {
            manipulationTimeoutBars: 12,
            distributionTimeoutBars: 12
        },
        // Phase 11T.5（正式化）：Narrative Snapshot Retention
        // DISTRIBUTION/INVALIDATED reset 前冻结本轮 narrative 为不可变 TradeContextSnapshot，
        // TradePlanner stop reference 顺序：current AMD boundary → retained boundary → SWING/FVG。
        // lastNarrative 有明确 expiry（maxAgeBars），且新一轮 manipulation confirmed 时覆盖，
        // scenario/draw flip 清空 —— Persistent for trade-context, not permanent memory。
        // 已通过 warmup 稳定性验证（FINITE_MEMORY）。设置 DISABLE_LAST_NARRATIVE=1 强制关闭（诊断）。
        lastNarrative: {
            enabled: true,
            maxAgeBars: 1440
        }
    },

    /**
     * Scenario / Action Engine 参数（Phase 8）
     * 核心原则：Direction ≠ Action。Bias 有方向不代表 BUY。
     * Scenario Score 是自定义工程评分，不是 probability。
     */
    scenario: {
        score: {
            weights: {
                bias: 30,
                draw: 20,
                amd: 30,
                delivery: 15,
                conflict: 5
            },
            bias: {
                high: 30,
                medium: 22,
                low: 12
            },
            draw: {
                matchingStrong: 20,
                matchingLean: 12,
                balanced: 5,
                opposite: 0
            },
            amd: {
                completeMatch: 30,
                distributionConfirmed: 26,
                manipulationConfirmed: 20,
                accumulationConfirmed: 12,
                candidate: 5,
                opposite: 0
            },
            delivery: {
                matchingComplete: 15,
                matchingPartial: 8,
                neutral: 3,
                opposite: 0
            },
            conflict: {
                noMajor: 5,
                hasMajor: 0
            }
        },
        quality: {
            lowMax: 40,
            mediumMax: 70
        }
    },

    /**
     * FVG（Fair Value Gap）参数（Phase 9.1）
     * 核心原则：FVG 不是独立交易信号，只有 Action = WATCH 时才参与 Entry Gate。
     * FVG 必须优先关联已确认的 DISPLACEMENT 事件。
     */
    fvg: {
        minTickMultiplier: 2,
        minAtrMultiplier: 0.05,
        percentageFallback: 0.00005,
        maxDisplacementBars: 2,
        detector: {
            minGap: {
                tickMultiplier: 2,
                atrMultiplier: 0.05,
                percentageFallback: 0.00005
            }
        },
        scorer: {
            weights: {
                displacementAssociation: 40,
                gapSize: 20,
                amdAlignment: 15,
                scenarioMatch: 10
            },
            gapSizeAtrFactor: 1.0,
            entryThreshold: 60
        }
    },

    /**
     * Entry Gate（Phase 9.2）
     * 只在 Action = WATCH 时运行；WAIT / NO_TRADE 时 Gate 必须 CLOSED。
     * ENTRY_READY 只是 entry confirmation ready，不是自动交易。
     */
    entry: {
        preferredEntry: 'MIDPOINT',
        invalidation: {
            scenarioMismatch: true,
            amdInvalidated: true,
            alignmentOpposite: true,
            fvgInvalidated: true,
            oppositeDelivery: true
        }
    },

    /**
     * Trade Planning + Simulation（Phase 10）
     * 原则：ENTRY_READY ≠ 自动交易。Trade Plan 必须通过 Risk/Reward 检查。
     * 不为了满足 RR 人工修改 liquidity target；不接真实订单。
     */
    trade: {
        entry: {
            mode: 'MIDPOINT', // MIDPOINT | ZONE_EDGE | MARKET_ON_CONFIRMATION
            missedTolerancePct: 0.0015 // 价格明显越过 entry 且超出此比例 → ENTRY_MISSED
        },
        stop: {
            tickBufferMultiplier: 2,
            atrBufferMultiplier: 0.05
        },
        rr: {
            minRR: 1.5
        },
        simulator: {
            maxEntryWaitBars: 12
        }
    }
};
