/**
 * Session 定义（集中配置，禁止散落在 Engine 中）
 *
 * 【重要说明】
 * - Engine 内部一律使用 UTC session definition（不写北京/东京本地时间）
 * - 以下时间为当前工程初始配置，不是 ICT 唯一固定定义
 * - 后续可单独校正 DST / Kill Zone，只需替换本配置，无需改动计算层
 * - 配置结构已支持 start > end 的跨 UTC 日边界定义（sessionLiquidity 会处理）
 */
module.exports = {
    ASIA: {
        startHourUtc: 0,
        startMinuteUtc: 0,
        endHourUtc: 5,
        endMinuteUtc: 0
    },
    LONDON: {
        startHourUtc: 7,
        startMinuteUtc: 0,
        endHourUtc: 10,
        endMinuteUtc: 0
    },
    NEW_YORK: {
        startHourUtc: 12,
        startMinuteUtc: 0,
        endHourUtc: 16,
        endMinuteUtc: 0
    }
};
