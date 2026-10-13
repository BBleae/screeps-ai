'use strict';

/**
 * 长跑基准用的私服 mod：沿用 validation_mod（自动存档 + /api/game/room-objects 路由），
 * 但把 lokijs 自动存档间隔从 250 ms 放宽到 5 s——几十万 tick 的基准里每秒写四次几 MB 的 db.json 只是白白拖慢 storage 进程。
 */
const validationMod = require('./validation_mod');

module.exports = function benchmarkMod(config) {
    validationMod(config);
    if (config.storage) {
        config.storage.dbOptions = Object.assign({}, config.storage.dbOptions, { autosave: true, autosaveInterval: 5000 });
    }
};
