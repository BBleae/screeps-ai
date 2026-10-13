'use strict';

const path = require('path');

/**
 * 私服 mod：
 *  1. 开启自动存档，供验证脚本等待落盘标记；
 *  2. 补一个与官方同形状的 GET /api/game/room-objects 路由（私服后端没有这个接口），
 *     让外部大脑（scripts/brain）可以对私服做端到端验证。
 */
function guardCronjobs(cronjobs) {
    if (!cronjobs || typeof cronjobs !== 'object') return;
    for (const [key, job] of Object.entries(cronjobs)) {
        if (!Array.isArray(job) || typeof job[1] !== 'function' || job[1].validationGuarded) continue;
        const run = job[1];
        const guarded = function (...args) {
            const report = (error) => { console.error(`[validation_mod] cronjob '${key}' failed: ${error && error.stack || error}`); };
            try {
                return Promise.resolve(run.apply(this, args)).catch(report);
            } catch (error) {
                report(error);
                return Promise.resolve();
            }
        };
        guarded.validationGuarded = true;
        job[1] = guarded;
    }
}

module.exports = function validationMod(config) {
    if (config.storage) {
        config.storage.dbOptions = Object.assign({}, config.storage.dbOptions, {
            autosave: true,
            // 5 s（与 benchmark_mod 一致）：每次存盘都序列化整库，39 个场景用户时库 > 100 MB，250 ms 一存会把 storage 进程占满，
            // tick 慢到 5 s 触发引擎 "Main loop reset"、整 tick 没有 creep 移动（2026-10-13 实测 250 ms 2.6–5 s/tick，5 s 0.8 s/tick）；
            // persistMarker 最多等 30 s，5 s 一存足够
            autosaveInterval: 5000,
        });
    }
    // Private-server-only evidence: successful engine repair intents, not a
    // tower's remaining energy after it has already spent its maintenance budget.
    if (config.engine && typeof config.engine.on === 'function') {
        config.engine.on('processObjectIntents', (object, userId, intents, objects, terrain, tick, roomInfo, bulk) => {
            if (object.room !== 'W40N40' || object.type !== 'tower' || !intents.repair ||
                !object.actionLog || !object.actionLog.repair) return;
            const target = objects[intents.repair.id];
            if (!target) return;
            const sourceContainer = target.type === 'container' && Object.values(objects).some(source =>
                source.type === 'source' && Math.max(Math.abs(source.x - target.x), Math.abs(source.y - target.y)) <= 1);
            const previous = object.validationRepairs || {};
            const evidence = {
                n: (previous.n || 0) + 1,
                source: (previous.source || 0) + (sourceContainer ? 1 : 0),
                peakBeforeRepair: Math.max(previous.peakBeforeRepair || 0, (object.store.energy || 0) + 10),
                at: tick,
            };
            bulk.update(object, { validationRepairs: evidence });
        });
    }
    // 私服 backend 的 cronjob 返回的 promise 没人接：roomsForceUpdate 在 env 里暂时没有 activeRooms 时查询
    // {_id:{$nin:undefined}}，序列化成 {_id:{}}，lokijs 抛 "fun is not a function"，Node 22 把这个未处理的 rejection
    // 当致命错误、backend 退出重启（44 个私服世界的 storage.log 里都有）。重启会从 project-bot 重新加载 bot 代码，
    // 冲掉验证脚本装的观察包装——validation-xKltxj 的 upgrader.actualSpawnHandoff 就是这样丢了证据。
    // 这里给每个 cronjob 接住 rejection（只记日志），下一轮照常再跑。config.cronjobs 在 mod 加载前已由 backend 的
    // cronjobs.js 建好（index.js 先 require 再 configManager.load）；其他进程没有它，跳过。
    guardCronjobs(config.cronjobs);
    if (!config.backend || typeof config.backend.on !== 'function') return;
    config.backend.on('expressPreConfig', (app) => {
        app.get('/api/game/room-objects', (request, response) => {
            const roomName = String(request.query.room || '');
            if (!roomName) {
                response.json({ error: 'invalid params' });
                return;
            }
            let common;
            try {
                const serverRoot = path.join(__dirname, '..', '..', 'private-server', 'server');
                common = require(path.join(serverRoot, 'node_modules', '@screeps', 'common'));
            } catch (error) {
                response.json({ error: 'common unavailable: ' + error.message });
                return;
            }
            const db = common.storage.db;
            db['rooms.objects'].find({ room: roomName })
                .then((objects) => {
                    const userIds = Array.from(new Set(objects.map((object) => object.user).filter(Boolean).map(String)));
                    const lookup = userIds.length ? db.users.find({ _id: { $in: userIds } }) : Promise.resolve([]);
                    return Promise.resolve(lookup).then((users) => {
                        const map = {};
                        for (const user of users || []) map[String(user._id)] = { _id: String(user._id), username: user.username };
                        response.json({ ok: 1, objects, users: map });
                    });
                })
                .catch((error) => response.json({ error: String(error && error.message || error) }));
        });
    });
};

module.exports.guardCronjobs = guardCronjobs;
