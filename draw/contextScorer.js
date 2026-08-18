/**
 * Context Scorer —— Phase 6 扩展点（当前为占位接口）
 *
 * 故意保持空实现：
 * - 不参与 Draw Score final
 * - 禁止现在把 structure / premium-discount / MSS / displacement / AMD 塞进来
 * - Phase 6 接入 HTF Structure / Premium Discount / Delivery 时在此扩展
 */
/**
 * @param {Object} candidate 统一 candidate
 * @param {Object} [context] 未来上下文（HTF structure 等）
 * @returns {Object} { score: 0, reasons: [] }
 */
function scoreContext(candidate, context) {
    return {
        score: 0,
        reasons: []
    };
}

module.exports = {
    scoreContext: scoreContext
};
