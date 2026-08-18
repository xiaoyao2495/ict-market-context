/**
 * 周期定义
 *
 * 设计目标：
 *   Binance 获取 5m
 *        ↓ 本地聚合
 *   15m / 1h / 4h / 1d
 *
 * V1 暂时直接请求 Binance（5m / 1h / 4h / 1d），
 * Liquidity 模型稳定后再统一为 5m 本地聚合。
 */
module.exports = {
    BASE: '5m',
    ANALYSIS: ['5m', '15m', '1h', '4h', '1d']
};
