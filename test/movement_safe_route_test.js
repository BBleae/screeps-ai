'use strict';
// movement.safeRouteExists 的缓存语义（2026-10-13 移植 wip/deploy-20260920 c7cc6f2）：危险房集合变了缓存立即失效、
// 不变时按 cacheTicks 缓存、目的地不避、findRoute 抛错不缓存、没有地图 API 放行。在独立 vm 里加载 movement.js，
// 不经 smoke 的 mock 引擎。用法：node test/movement_safe_route_test.js

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function scenario() {
    let calls = 0;
    let failure = null;
    const context = {
        module: { exports: {} },
        global: {},
        Game: { time: 100, rooms: {}, map: {} },
        Memory: { map: {} },
        require(name) {
            if (name === 'utils') return { roomCoords: () => null };
            if (name === 'layout' || name === 'config') return {};
            throw new Error('Unexpected module: ' + name);
        },
    };
    context.Game.map.findRoute = (from, to, options) => {
        calls += 1;
        if (failure) throw failure;
        const blocked = ['W1N0', to].some(room => options.routeCallback(room, from) === Infinity);
        return blocked ? -2 : [{ exit: 7, room: 'W1N0' }, { exit: 7, room: to }];
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/movement.js'), 'utf8'), context);
    return {
        context,
        movement: context.module.exports,
        get calls() { return calls; },
        set failure(error) { failure = error; },
    };
}

const cases = [
    ['new danger invalidates a cached reachable route', () => {
        const world = scenario();
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        world.context.Memory.map.W1N0 = { owner: 'enemy' };
        world.context.Game.time += 1;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), false);
        assert.strictEqual(world.calls, 2);
    }],
    ['cleared danger invalidates a cached unreachable route', () => {
        const world = scenario();
        world.context.Memory.map.W1N0 = { owner: 'enemy' };
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), false);
        delete world.context.Memory.map.W1N0;
        world.context.Game.time += 1;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 2);
    }],
    ['unchanged danger preserves the configured cache lifetime', () => {
        const world = scenario();
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        world.context.Game.time += 999;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 1);
        world.context.Game.time += 1;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 2);
    }],
    ['the destination remains exempt from danger avoidance', () => {
        const world = scenario();
        world.context.Memory.map.W2N0 = { owner: 'enemy' };
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
    }],
    ['map exceptions propagate without caching an unreachable result', () => {
        const world = scenario();
        const failure = new Error('map unavailable');
        world.failure = failure;
        assert.throws(() => world.movement.safeRouteExists('W0N0', 'W2N0', 1000), error => error === failure);
        world.failure = null;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 2);
    }],
    ['an SK room on the only route blocks it like an owned room', () => {
        const world = scenario();
        world.context.Memory.map.W1N0 = { class: 'sk', lairs: 3 };
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), false);
    }],
    ['resetSafeRoutes forces a recompute inside the cache lifetime', () => {
        const world = scenario();
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        world.movement.resetSafeRoutes();
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 2);
    }],
    ['missing map API keeps the existing permissive fallback', () => {
        const world = scenario();
        delete world.context.Game.map.findRoute;
        assert.strictEqual(world.movement.safeRouteExists('W0N0', 'W2N0', 1000), true);
        assert.strictEqual(world.calls, 0);
    }],
];

const failed = [];
for (const [name, check] of cases) {
    try {
        check();
    } catch (error) {
        failed.push(name + ': ' + error.message);
    }
}
assert.deepStrictEqual(failed, [], failed.join('\n'));
console.log('movement safe-route checks: ' + cases.length + ' passed');
