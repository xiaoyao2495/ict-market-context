/**
 * Event Registry —— 统一市场事件存储
 *
 * Market Event 统一格式：
 * {
 *   id, symbol, timeframe, type, direction,
 *   occurredAt, confirmedAt, candleIndex, price, source, metadata
 * }
 *
 * Event Type（第一版）：
 *   LIQUIDITY_SWEEP / STRUCTURAL_BOS / STRUCTURAL_CONTINUATION /
 *   STRUCTURAL_PENETRATION / DISPLACEMENT
 * （未来 FVG_CREATED / AMD_* 等继续复用）
 *
 * 规则：
 * - id 为唯一键，相同 id 不允许重复加入（deterministic）
 * - getBefore 只返回 confirmedAt <= evaluationTime 的事件（防未来数据）
 * - 不删除任何历史事件（Delivery / AMD 都可能需要）
 */
function createEventRegistry() {
    var store = {};
    var order = [];

    function add(event) {
        if (!event || !event.id) {
            return false;
        }
        if (store[event.id]) {
            return false;
        }
        store[event.id] = event;
        order.push(event.id);
        return true;
    }

    function addMany(events) {
        var count = 0;
        if (!events) {
            return 0;
        }
        events.forEach(function (e) {
            if (add(e)) {
                count++;
            }
        });
        return count;
    }

    function getAll(symbol) {
        var out = [];
        order.forEach(function (id) {
            var e = store[id];
            if (!symbol || e.symbol === symbol) {
                out.push(e);
            }
        });
        return out;
    }

    function getByType(symbol, type) {
        return getAll(symbol).filter(function (e) {
            return e.type === type;
        });
    }

    function getByDirection(symbol, direction) {
        return getAll(symbol).filter(function (e) {
            return e.direction === direction;
        });
    }

    /**
     * confirmedAt <= evaluationTime 的事件（防未来数据）
     */
    function getBefore(symbol, evaluationTime) {
        return getAll(symbol).filter(function (e) {
            return e.confirmedAt <= evaluationTime;
        });
    }

    /**
     * 某类型最近 limit 条（按 confirmedAt 升序返回，供顺序消费）
     * type 可空（null/undefined = 全部类型）
     */
    function getRecent(symbol, type, evaluationTime, limit) {
        var filtered = getAll(symbol).filter(function (e) {
            if (e.confirmedAt > evaluationTime) {
                return false;
            }
            if (type && e.type !== type) {
                return false;
            }
            return true;
        });
        filtered.sort(function (a, b) {
            return a.confirmedAt - b.confirmedAt;
        });
        if (limit !== undefined && filtered.length > limit) {
            return filtered.slice(filtered.length - limit);
        }
        return filtered;
    }

    function getById(id) {
        return store[id] || null;
    }

    function size() {
        return order.length;
    }

    function clear() {
        store = {};
        order = [];
    }

    return {
        add: add,
        addMany: addMany,
        getAll: getAll,
        getByType: getByType,
        getByDirection: getByDirection,
        getBefore: getBefore,
        getRecent: getRecent,
        getById: getById,
        size: size,
        clear: clear
    };
}

module.exports = {
    createEventRegistry: createEventRegistry
};
