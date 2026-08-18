/**
 * FVG Registry（Phase 9.1）
 *
 * 统一管理 FVG，模式与 eventRegistry 一致：
 * - id 去重
 * - getBefore 过滤未来（confirmedAt > evaluationTime 不返回）
 * - getActive / getByDirection / getByStatus / getById
 */
function createFvgRegistry() {
    var store = {};
    var order = [];

    /**
     * 新增，相同 id 去重（重复返回 false）
     */
    function add(fvg) {
        if (!fvg || !fvg.id) {
            return false;
        }
        if (store[fvg.id]) {
            return false;
        }
        store[fvg.id] = fvg;
        order.push(fvg.id);
        return true;
    }

    function addMany(fvgs) {
        var added = 0;
        (fvgs || []).forEach(function (f) {
            if (add(f)) {
                added++;
            }
        });
        return added;
    }

    /**
     * 全部（按加入顺序）
     */
    function getAll(symbol) {
        var out = [];
        order.forEach(function (id) {
            var f = store[id];
            if (!symbol || f.symbol === symbol) {
                out.push(f);
            }
        });
        return out;
    }

    /**
     * 已确认（confirmedAt <= evaluationTime）的 FVG
     */
    function getBefore(evaluationTime) {
        return order
            .map(function (id) {
                return store[id];
            })
            .filter(function (f) {
                return f.confirmedAt <= evaluationTime;
            });
    }

    function getById(id) {
        return store[id] || null;
    }

    function getActive(symbol) {
        return getAll(symbol).filter(function (f) {
            return f.status === 'ACTIVE';
        });
    }

    function getByDirection(symbol, direction) {
        return getAll(symbol).filter(function (f) {
            return f.direction === direction;
        });
    }

    function getByStatus(symbol, status) {
        return getAll(symbol).filter(function (f) {
            return f.status === status;
        });
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
        getBefore: getBefore,
        getById: getById,
        getActive: getActive,
        getByDirection: getByDirection,
        getByStatus: getByStatus,
        size: size,
        clear: clear
    };
}

module.exports = {
    createFvgRegistry: createFvgRegistry
};
