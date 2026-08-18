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
 * 代理（2026-08-18 起默认直连）：
 * - 生产服务器（Windows）可直连 fapi.binance.com，零配置
 * - 需要代理的环境（本机开发等）显式开启 ICT_PROXY_ENABLED=1
 * - 环境变量 HTTP_PROXY/HTTPS_PROXY 会覆盖代码内配置（沙箱/CI 场景可整体禁用）
 */
// Fix 5（11L.2）+ 默认直连（11L.2）：代理环境化，默认直连（服务器零配置）
//   ICT_PROXY_ENABLED=1  → 走代理（本机开发 / 受限网络）
//   ICT_PROXY_ENABLED=0  → 直连（默认，服务器无代理时）
//   ICT_PROXY_HOST / ICT_PROXY_PORT → 覆盖代理地址（默认 127.0.0.1:7890）
module.exports = {
    baseUrl: 'https://fapi.binance.com',
    fallbackBaseUrl: 'https://data-api.binance.vision',
    useFallback: process.env.ICT_USE_FALLBACK === '1',
    proxy: {
        enabled: process.env.ICT_PROXY_ENABLED !== undefined
            ? process.env.ICT_PROXY_ENABLED === '1'
            : false,
        host: process.env.ICT_PROXY_HOST || '127.0.0.1',
        port: parseInt(process.env.ICT_PROXY_PORT || '7890', 10)
    }
};
