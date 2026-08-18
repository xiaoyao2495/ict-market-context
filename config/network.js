/**
 * 网络配置
 *
 * 主域名：Binance USDⓈ-M Futures（fapi.binance.com）
 * 回退镜像：data-api.binance.vision（Binance 官方数据镜像）
 *   - 注意：镜像只有现货端点 /api/v3/klines，无 /fapi 端点
 *   - 现货与永续的 5m K 线 OHLC 基本一致（开发期验证用，数据会标记 source）
 *
 * 使用方式：
 * - 默认走合约主域名（可经 proxy 访问）；主域名失败自动回退镜像
 * - 或显式设置 useFallback: true / 环境变量 ICT_USE_FALLBACK=1 强制走镜像
 *
 * 代理（2026-08-17 起启用）：
 * - 本机 Clash 7890 已验证可访问 fapi.binance.com（USDⓈ-M 合约数据）
 * - axios 通过 proxy 配置直接走代理（无需额外依赖）
 * - 环境变量 HTTP_PROXY/HTTPS_PROXY 会覆盖代码内配置（沙箱/CI 场景可整体禁用）
 */
module.exports = {
    baseUrl: 'https://fapi.binance.com',
    fallbackBaseUrl: 'https://data-api.binance.vision',
    useFallback: false,
    proxy: {
        enabled: true,
        host: '127.0.0.1',
        port: 7890
    }
};
