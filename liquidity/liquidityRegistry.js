/**
 * Liquidity Registry —— 所有流动性的统一管理者
 *
 * Swing / Daily / Weekly / EQH / EQL /（未来 PMH / PML / Session）
 * 全部进入同一个 Registry，避免各管各的。
 *
 * 核心规则：
 * - 以 id 为唯一键，相同 id 不允许重复加入
 * - 状态字段 status 驱动生命周期：ACTIVE / TOUCHED / SWEPT / BROKEN
 * - SWEPT / BROKEN 的 liquidity【不删除】——Bias Engine 需要知道
 *   “哪些流动性已经被获取”，因此所有历史状态都可查询
 * - getActive 只返回 status === 'ACTIVE'（严格定义）
 * - 所有查询默认按 symbol 过滤
 */
function createRegistry() {
    var store = {}; // id -> liquidity
    var order = []; // 加入顺序（保证输出稳定）

    /**
     * 新增一条 liquidity
     * @returns {boolean} 是否真正加入（重复 id 返回 false）
     */
    function add(liquidity) {
        if (!liquidity || !liquidity.id) {
            return false;
        }
        if (store[liquidity.id]) {
            return false; // 去重
        }
        store[liquidity.id] = liquidity;
        order.push(liquidity.id);
        return true;
    }

    /**
     * 批量新增
     * @returns {number} 实际加入数量
     */
    function addMany(liquidities) {
        var count = 0;
        if (!liquidities) {
            return 0;
        }
        liquidities.forEach(function (liquidity) {
            if (add(liquidity)) {
                count++;
            }
        });
        return count;
    }

    /**
     * 获取某 symbol 的全部 liquidity（按加入顺序）
     */
    function getAll(symbol) {
        var result = [];
        order.forEach(function (id) {
            var l = store[id];
            if (!symbol || l.symbol === symbol) {
                result.push(l);
            }
        });
        return result;
    }

    /**
     * 获取 status === 'ACTIVE' 的 liquidity
     */
    function getActive(symbol) {
        return getAll(symbol).filter(function (l) {
            return l.status === 'ACTIVE';
        });
    }

    /**
     * 按方向获取（BSL / SSL）
     */
    function getBySide(symbol, side) {
        return getAll(symbol).filter(function (l) {
            return l.side === side;
        });
    }

    function getBSL(symbol) {
        return getBySide(symbol, 'BSL');
    }

    function getSSL(symbol) {
        return getBySide(symbol, 'SSL');
    }

    /**
     * 获取某 symbol 下 status === 'ACTIVE' 且 side 匹配的 liquidity
     */
    function getActiveBySide(symbol, side) {
        return getActive(symbol).filter(function (l) {
            return l.side === side;
        });
    }

    /**
     * 获取某回放时刻已确认（confirmedAt <= evaluationTime）的 ACTIVE liquidity
     * （历史回放安全：回放时刻之前未确认的流动性不可见）
     */
    function getActiveAt(symbol, evaluationTime) {
        return getActive(symbol).filter(function (l) {
            return l.confirmedAt <= evaluationTime;
        });
    }

    /**
     * 按类型获取（SWING_HIGH / PDH / PWH / ...）
     */
    function getByType(symbol, type) {
        return getAll(symbol).filter(function (l) {
            return l.type === type;
        });
    }

    /**
     * 获取某 symbol 下 status === 'ACTIVE' 且类型匹配的 liquidity
     */
    function getActiveByType(symbol, type) {
        return getActive(symbol).filter(function (l) {
            return l.type === type;
        });
    }

    /**
     * 按 id 精确获取
     */
    function getById(id) {
        return store[id] || null;
    }

    /**
     * 按状态获取（ACTIVE / TOUCHED / SWEPT / BROKEN）
     */
    function getByStatus(symbol, status) {
        return getAll(symbol).filter(function (l) {
            return l.status === status;
        });
    }

    /**
     * 局部更新（patch 中 undefined 的字段不覆盖）
     * @returns {Object|null} 更新后的 liquidity；不存在返回 null
     */
    function update(id, patch) {
        var target = store[id];
        if (!target || !patch) {
            return null;
        }
        Object.keys(patch).forEach(function (key) {
            if (patch[key] !== undefined) {
                target[key] = patch[key];
            }
        });
        return target;
    }

    /**
     * 应用 lifecycle 状态变化（不删除 liquidity）
     * @param {string} id
     * @param {Object} result evaluateLiquidity 的返回值
     * @returns {Object|null} 更新后的 liquidity；无结果/不存在返回 null
     */
    function applyLifecycleEvent(id, result) {
        if (!result || !store[id]) {
            return null;
        }
        return update(id, {
            status: result.status,
            touchedAt: result.touchedAt,
            sweptAt: result.sweptAt,
            brokenAt: result.brokenAt
        });
    }

    /**
     * 当前总条数
     */
    function size() {
        return order.length;
    }

    /**
     * 清空（测试/重放场景）
     */
    function clear() {
        store = {};
        order = [];
    }

    return {
        add: add,
        addMany: addMany,
        getAll: getAll,
        getActive: getActive,
        getBySide: getBySide,
        getBSL: getBSL,
        getSSL: getSSL,
        getActiveBySide: getActiveBySide,
        getActiveAt: getActiveAt,
        getByType: getByType,
        getActiveByType: getActiveByType,
        getById: getById,
        getByStatus: getByStatus,
        update: update,
        applyLifecycleEvent: applyLifecycleEvent,
        size: size,
        clear: clear
    };
}

module.exports = {
    createRegistry: createRegistry
};
