'use strict';
/** scripts/soak/rcl_benchmark.js 的纯函数单测：账本（采集回绕、creep 只记一次、工地完工/被拆、升级 tick 插值、多房分账与占领时间线）与播种文档。 */
const bench = require('../scripts/soak/rcl_benchmark');

let failures = 0;
function check(condition, message) {
    if (!condition) { failures++; console.log('FAIL: ' + message); }
}

function ctrl(level, progress, t) {
    return { level, progress, downgradeTime: t + 20000, safeMode: 0 };
}

function sample(t, over) {
    return Object.assign({
        t, gcl: 0, owned: { W1N1: ctrl(1, 0, t) },
        sources: [['W1N1', 10, 10, 3000, 0, 0, 3000], ['W1N1', 20, 20, 3000, 0, 0, 3000]],
        creeps: [], hostiles: {}, cores: [], rooms: { W1N1: { n: { spawn: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 } },
        sites: [], spawning: 0, keys: ['W1N1:5,5:spawn'],
    }, over);
}

// 播种文档与小工具
check(bench.neutralDocument('W1N1', { type: 'keeperLair', x: 1, y: 2 }).type === 'keeperLair', 'keeperLair doc');
check(bench.neutralDocument('W1N1', { type: 'source', x: 1, y: 2, energyCapacity: 4000 }).energyCapacity === 4000, 'source keeps capacity');
check(bench.neutralDocument('W1N1', { type: 'source', x: 1, y: 2 }).invaderHarvested === 0, 'source starts invaderHarvested at 0');
check(bench.neutralDocument('W1N1', { type: 'road', x: 1, y: 2 }) === null, 'non-neutral objects are not seeded');
check(bench.bodyCost({ W: 2, C: 1, M: 1 }) === 300 && bench.bodyParts({ W: 2, C: 1, M: 1 }) === 4, 'body cost/parts');
check(!/\n/.test(bench.oneLine(bench.aggregateSource)) && bench.oneLine(bench.aggregateSource).includes('rooms.objects'), 'aggregate expression is one line');
// 压成一行后必须仍是合法 JS（行注释会吞掉后面的代码），且不残留 //
for (const [name, fn] of [['aggregateSource', bench.aggregateSource], ['memorySource', bench.memorySource]]) {
    const src = bench.oneLine(fn);
    let ok = true;
    try { new Function('storage', 'return ' + src); } catch (e) { ok = false; }
    check(ok && !src.includes('//'), name + ' survives oneLine as valid single-line JS');
}
check(bench.oneLine(function () {
    // 整行注释
    var a = 1; /* 块 */
    return a;
}).replace(/\s+/g, ' ').includes('var a = 1; return a;'), 'oneLine strips full-line // comments and block comments');
check(bench.gclLevel(0) === 1 && bench.gclLevel(999999) === 1 && bench.gclLevel(1000000) === 2 && bench.gclLevel(5300000) === 3 && bench.gclLevel(5200000) === 2, 'gcl level from points');
check(bench.parseArgs(['--gcl', '12', '--lock-claim']).gcl === 12 && bench.parseArgs(['--lock-claim']).lockClaim === true && bench.parseArgs([]).lockClaim === false, 'gcl/lock-claim args');
check(JSON.stringify(bench.parseArgs(['--brain-arg', '--remote-min-score', '--brain-arg', '-20']).brainArgs) === '["--remote-min-score","-20"]' && bench.parseArgs([]).brainArgs.length === 0, 'repeatable --brain-arg passthrough');

check(bench.parseArgs([]).username === 'BenchBBleae', 'default benchmark username remains compatible');
check(bench.parseArgs(['--username', 'SoakBBleae']).username === 'SoakBBleae', 'fork supports captured soak user');
let missingUsernameRejected = false;
try { bench.parseArgs(['--username', '--ticks', '100']); } catch (_) { missingUsernameRejected = true; }
check(missingUsernameRejected, 'missing username is rejected before starting a server');
check(bench.runUsername({username: 'SoakBBleae'}) === 'SoakBBleae' && bench.runUsername({}) === 'BenchBBleae', 'resume uses recorded username with legacy fallback');

// 账本
const args = { home: 'W1N1' };
const state = bench.newState();
state.startTick = 100;
const r1 = bench.account(state, sample(100), null, args);
check(r1.acc.harvest === 0 && r1.stock.total === 300 && r1.rcl === 1 && r1.ownedN === 1, 'baseline record');
check(r1.acc.residual === 0 && Object.keys(r1.claims).length === 0, 'baseline residual is zero, primary room is not a claim');

const mem = { roles: { A: ['harvester', 'W1N1'], B: ['upgrader', 'W1N1'], R: ['reserver', 'W1N1', 'W2N1'], D: ['defender', 'W1N1', 'W2N1'], P: ['pioneer', 'W1N1', 'W5N5'] }, rooms: { W1N1: { remotes: [['W2N1', 1, '', 0]] } } };
const r2 = bench.account(state, sample(150, {
    gcl: 40, owned: { W1N1: ctrl(1, 150, 150) },
    sources: [['W1N1', 10, 10, 2900, 100, 400, 3000], ['W1N1', 20, 20, 2950, 50, 400, 3000], ['W2N1', 5, 5, 1400, 100, 400, 1500]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 20, 1600, 0, 6, 6]],
    sites: [['X', 'W1N1', 'extension', 6, 6, 100, 3000], ['Y', 'W1N1', 'road', 7, 7, 50, 300]],
    rooms: { W1N1: { n: { spawn: 1 }, e: { spawn: 50 }, drop: 30, tomb: 0, ruin: 0 }, W2N1: { n: { container: 1 }, e: { container: 200 }, drop: 0, tomb: 0, ruin: 0 }, W9N9: { n: { container: 1 }, e: { container: 999 }, drop: 0, tomb: 0, ruin: 0 } },
}), mem, args);
check(r2.acc.harvest === 250 && r2.acc.harvestHome === 150 && r2.acc.harvestRemote === 100 && r2.acc.harvestByRoom.W2N1 === 100, 'harvest split home/remote: ' + JSON.stringify([r2.acc.harvest, r2.acc.harvestHome, r2.acc.harvestRemote]));
check(r2.acc.upgrade === 40 && r2.acc.upgradeByRoom.W1N1 === 150, 'total CP = gcl delta, room progress from controller: ' + JSON.stringify(r2.acc.upgradeByRoom));
check(r2.acc.spawn === 300 && r2.acc.parts === 4 && r2.acc.creeps === 1 && r2.acc.spawnByRole.harvester === 300 && r2.acc.spawnByHome.W1N1 === 300, 'first creep counted once with role and home');
check(r2.acc.build === 150 && r2.acc.buildByType.extension === 100 && r2.acc.buildByType.road === 50, 'site progress counted: ' + r2.acc.build);
check(r2.stock.total === 300 && r2.stock.carried === 20 && r2.stock.dropped === 30 && r2.stock.spawn === 50 && r2.stock.containerRemote === 200, 'stock counts enabled remote containers, not unrelated rooms: ' + JSON.stringify(r2.stock));
check(r2.remoteRooms.length === 1 && r2.remoteRooms[0] === 'W2N1', 'remote rooms come from creeps + enabled Memory remotes');
check(r2.acc.residual === 250 - 40 - 300 - 150 - (300 - 300), 'residual formula: ' + r2.acc.residual);
check(r2.roles.harvester === 1 && r2.idleSources === 0, 'roles and idle sources');
check(!r2.levelUp && !r2.levelUps, 'no level-up yet');

const r3 = bench.account(state, sample(200, {
    gcl: 100, owned: { W1N1: ctrl(2, 10, 200), W3N1: ctrl(1, 0, 200) },
    // 源 1 的 invaderHarvested 被 Invader 刷新清零后回到 30：按回绕只加 30
    sources: [['W1N1', 10, 10, 2800, 30, 400, 3000], ['W1N1', 20, 20, 2900, 80, 400, 3000], ['W2N1', 5, 5, 1400, 100, 400, 1500]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 0, 1600, 0, 6, 6], ['B', 'W1N1', { W: 1, C: 1, M: 1 }, 0, 1650, 1, 5, 5]],
    sites: [],
    rooms: { W1N1: { n: { spawn: 1, extension: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 }, W3N1: { n: {}, e: {}, drop: 0, tomb: 0, ruin: 0 } },
    keys: ['W1N1:5,5:spawn', 'W1N1:6,6:extension'],
}), mem, args);
check(r3.acc.harvest === 250 + 30 + 30, 'harvest handles the invader reset wrap: ' + r3.acc.harvest);
check(r3.acc.spawn === 500 && r3.acc.creeps === 2 && r3.acc.spawnByRole.upgrader === 200, 'second creep added, first not double counted');
check(Object.keys(r3.acc.spawnByRemote).length === 0, 'home creeps carry no remote room');
check(r3.acc.build === 150 + 2900 && r3.acc.buildLost === 50, 'completed site gets its remainder, removed site is a loss: ' + r3.acc.build + '/' + r3.acc.buildLost);
check(r3.sitesCompleted === 1 && r3.sitesRemoved === 1, 'site completion/removal counters');
check(r3.levelUp && r3.levelUp.room === 'W1N1' && r3.levelUp.level === 2 && r3.levelUp.tick === 192 && r3.levelUp.sincePrev === 92 && r3.levelUp.sinceStart === 92,
    'level-up tick interpolated: ' + JSON.stringify(r3.levelUp && [r3.levelUp.room, r3.levelUp.tick, r3.levelUp.sincePrev]));
check(r3.acc.upgradeByRoom.W1N1 === 150 + 50 + 10, 'room progress crosses the level boundary: ' + r3.acc.upgradeByRoom.W1N1);
check(r3.claims.W3N1 === 200 && r3.ownedN === 2 && r3.owned.W3N1.rcl === 1 && r3.spawnBuilt.W3N1 == null && r3.spawnBuilt.W1N1 === 100, 'new room recorded as claim at first sight, spawn timeline: ' + JSON.stringify([r3.claims, r3.spawnBuilt]));
check(state.levels.length === 1 && state.levels[0].acc.spawnByRole.harvester === 300 && state.levels[0].ownedRooms === 2, 'level record keeps the cumulative account and room count');

// 外矿分账：reserver（memory.remoteRoom）与派往外矿的 defender（targetRoom ≠ home）记到外矿房，母房自己的 creep 不记
const stateR = bench.newState();
stateR.startTick = 100;
bench.account(stateR, sample(100), mem, args);
const rr = bench.account(stateR, sample(150, {
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 0, 1600, 0, 6, 6, 'idA'], ['R', 'W2N1', { L: 2, M: 2 }, 0, 1600, 0, 6, 6, 'idR'], ['D', 'W2N1', { A: 2, M: 2 }, 0, 1600, 0, 7, 7, 'idD'], ['P', 'W5N5', { W: 1, C: 1, M: 1 }, 0, 1600, 0, 8, 8, 'idP']],
}), mem, args);
check(rr.acc.spawnByRemote.W2N1 === 1300 + 260 && Object.keys(rr.acc.spawnByRemote).length === 1 && rr.acc.spawnByHome.W1N1 === 300 + 1300 + 260 + 200,
    'remote creeps charged to their remote room (pioneer bound for a claim target is not), home total unchanged: ' + JSON.stringify([rr.acc.spawnByRemote, rr.acc.spawnByHome]));

// 续跑迁移：旧 state.json 没有 spawnByRemote 等新键，补齐后 account() 不再在 undefined 上写入
const oldStateR = JSON.parse(JSON.stringify(bench.newState()));
delete oldStateR.acc.spawnByRemote;
delete oldStateR.downgrades;
oldStateR.startTick = 100;
const migratedR = bench.migrateState(oldStateR);
bench.account(migratedR, sample(100), mem, args);
let resumeOk = true;
try { bench.account(migratedR, sample(150, { creeps: [['R', 'W2N1', { L: 2, M: 2 }, 0, 1600, 0, 6, 6, 'idR']] }), mem, args); } catch (e) { resumeOk = false; }
check(resumeOk && migratedR.acc.spawnByRemote.W2N1 === 1300, 'resume from an old state backfills new accumulators: ' + JSON.stringify(migratedR.acc.spawnByRemote));

// 运输诊断：hauler 的 broker 任务按取货来源分类（源容器 / storage / 掉落 / 投递 / 空闲），每房源容器/控制器容器/掉落能量进 owned
const memT = { roles: { H1: ['hauler', 'W1N1', '', 'collect', 'cidS:collect'], H2: ['hauler', 'W1N1', '', 'deliver', 'sid'], H3: ['hauler', 'W1N1', ''], H4: ['hauler', 'W1N1', '', 'collect', 'dropid'], H5: ['hauler', 'W1N1', '', 'collect', 'stid:collect'], U: ['upgrader', 'W1N1', ''], F1: ['feeder', 'W1N1', ''], F2: ['feeder', 'W1N1', ''] } };
const stateT = bench.newState();
stateT.startTick = 100;
bench.account(stateT, sample(100), memT, args);
const rt = bench.account(stateT, sample(150, {
    creeps: ['H1', 'H2', 'H3', 'H4', 'H5', 'U'].map((n, i) => [n, 'W1N1', { C: 2, M: 1 }, 0, 1600, 0, i, i, 'id' + n]).concat([['F1', 'W1N1', { C: 4, M: 2 }, 150, 1600, 0, 9, 9, 'idF1'], ['F2', 'W1N1', { C: 4, M: 2 }, 0, 1600, 0, 9, 8, 'idF2']]),
    collect: { cidS: 'srcContainer', dropid: 'drop', stid: 'storage' },
    rooms: { W1N1: { n: { spawn: 1, container: 2, link: 2, tower: 1 }, e: { spawn: 300, container: 1700, link: 1500, tower: 640 }, drop: 30, dropN: 1, tomb: 0, ruin: 0, srcCont: 1500, ctrlCont: 200, contHits: 310000, contMinHits: 110000 } },
}), memT, args);
check(JSON.stringify(rt.haulerTasks.W1N1) === JSON.stringify({ srcContainer: 1, ctrlContainer: 0, container: 0, storage: 1, drop: 1, tomb: 0, other: 0, deliver: 1, idle: 1 }),
    'hauler tasks classified by collect target: ' + JSON.stringify(rt.haulerTasks));
check(rt.owned.W1N1.srcCont === 1500 && rt.owned.W1N1.ctrlCont === 200 && rt.owned.W1N1.drop === 30 && rt.owned.W1N1.dropN === 1 && rt.owned.W1N1.linkE === 1500 && rt.owned.W1N1.links === 2, 'per-room container/drop/link energy in owned: ' + JSON.stringify(rt.owned.W1N1));
check(rt.owned.W1N1.contHits === 310000 && rt.owned.W1N1.contMinHits === 110000 && rt.owned.W1N1.contN === 2 && rt.owned.W1N1.towerE === 640 && rt.owned.W1N1.towerN === 1, 'container hits and tower energy in owned: ' + JSON.stringify(rt.owned.W1N1));
check(rt.owned.W1N1.srcContHits === null && rt.owned.W1N1.ctrlContHits === null, 'per-class container hits are null when the sample carries no container list');
check(rt.owned.W1N1.rampHits === 0 && rt.owned.W1N1.rampMinHits === null && rt.owned.W1N1.rampN === 0, 'rampart hits default to zero when the room has none');
check(rt.feeders.W1N1.n === 2 && rt.feeders.W1N1.loaded === 1 && rt.roles.feeder === 2, 'feeders counted per home with loaded share: ' + JSON.stringify(rt.feeders));

const r4 = bench.account(state, sample(250, {
    gcl: 160, owned: { W1N1: ctrl(2, 40, 250), W3N1: ctrl(2, 5, 250) },
    sources: [['W1N1', 10, 10, 2800, 30, 400, 3000], ['W1N1', 20, 20, 2900, 80, 400, 3000], ['W2N1', 5, 5, 1400, 100, 400, 1500]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 0, 1600, 0, 6, 6]],
    rooms: { W1N1: { n: { spawn: 1, extension: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 }, W3N1: { n: { spawn: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 } },
    keys: ['W1N1:5,5:spawn', 'W1N1:6,6:extension', 'W3N1:9,9:spawn'],
}), mem, args);
check(r4.levelUps && r4.levelUps.length === 1 && r4.levelUps[0].room === 'W3N1' && r4.levelUps[0].level === 2 && r4.levelUps[0].sincePrev === r4.levelUps[0].tick - 200,
    'second room level-up is attributed to that room and timed from its claim: ' + JSON.stringify(r4.levelUps));
check(!r4.levelUp, 'primary room did not level up this sample');
check(r4.acc.upgradeByRoom.W3N1 === 205 && r4.acc.upgradeByRoom.W1N1 === 240, 'per-room CP: ' + JSON.stringify(r4.acc.upgradeByRoom));
check(r4.spawnBuilt.W3N1 === 250 && r4.stock.spawnExt === 600, 'new spawn detected and counted in stock');
check(state.samples === 4 && Object.keys(state.seen).length === 1, 'state bookkeeping drops dead creeps');

// 名字复用：同名但对象 id 不同的 creep 要再记一次孵化
const r5 = bench.account(state, sample(300, {
    gcl: 160, owned: { W1N1: ctrl(2, 60, 300), W3N1: ctrl(2, 20, 300) },
    sources: [['W1N1', 10, 10, 2800, 30, 400, 3000], ['W1N1', 20, 20, 2900, 80, 400, 3000], ['W2N1', 5, 5, 1400, 100, 400, 1500]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 0, 1600, 1, 6, 6, 'id-A2']],
    rooms: { W1N1: { n: { spawn: 1, extension: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 }, W3N1: { n: { spawn: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 } },
    keys: ['W1N1:5,5:spawn', 'W1N1:6,6:extension', 'W3N1:9,9:spawn'],
}), mem, args);
check(r5.acc.spawn === 800 && r5.acc.creeps === 3, 'a reused name with a new object id counts as a new spawn: ' + r5.acc.spawn);

// 续跑迁移：按名字记的旧状态 + migrateNames，活着的同名 creep 迁到 id 键而不重复计孵化
const migrated = bench.newState();
migrated.startTick = 100;
migrated.seen = { A: 300 };
migrated.acc.spawn = 300; migrated.acc.creeps = 1;
migrated.migrateNames = true;
const r6 = bench.account(migrated, sample(400, { creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 0, 1600, 0, 6, 6, 'id-A1']] }), mem, args);
check(r6.acc.spawn === 300 && r6.acc.creeps === 1 && migrated.seen['id-A1'] === 300 && migrated.seen.A == null && migrated.migrateNames === false, 'resume migrates name-keyed entries to ids without recounting: ' + JSON.stringify(migrated.seen));

// 分叉基线：第一次采样只记状态不记账，之后正常累计
const forked = bench.newState();
forked.startTick = 1000;
forked.baseline = true;
const f1 = bench.account(forked, sample(1000, {
    gcl: 5000, owned: { W1N1: ctrl(3, 500, 1000), W3N1: ctrl(2, 10, 1000) },
    sources: [['W1N1', 10, 10, 2000, 9000, 400, 3000], ['W1N1', 20, 20, 3000, 7000, 0, 3000]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 20, 1600, 0, 6, 6, 'id-A9']],
    sites: [['X', 'W1N1', 'extension', 6, 6, 100, 3000]],
    rooms: { W1N1: { n: { spawn: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 }, W3N1: { n: { spawn: 1 }, e: { spawn: 100 }, drop: 0, tomb: 0, ruin: 0 } },
}), mem, args);
check(f1.acc.harvest === 0 && f1.acc.spawn === 0 && f1.acc.build === 0 && f1.acc.upgrade === 0 && Object.keys(f1.claims).length === 0 && (f1.acc.upgradeByRoom.W3N1 || 0) === 0,
    'fork baseline sample books nothing: ' + JSON.stringify(f1.acc));
const f2 = bench.account(forked, sample(1050, {
    gcl: 5100, owned: { W1N1: ctrl(3, 560, 1050), W3N1: ctrl(2, 50, 1050) },
    sources: [['W1N1', 10, 10, 1900, 9100, 400, 3000], ['W1N1', 20, 20, 2950, 7050, 400, 3000]],
    creeps: [['A', 'W1N1', { W: 2, C: 1, M: 1 }, 20, 1600, 0, 6, 6, 'id-A9'], ['B', 'W1N1', { W: 1, C: 1, M: 1 }, 0, 1650, 1, 5, 5, 'id-B1']],
    sites: [['X', 'W1N1', 'extension', 6, 6, 400, 3000]],
    rooms: { W1N1: { n: { spawn: 1 }, e: { spawn: 300 }, drop: 0, tomb: 0, ruin: 0 }, W3N1: { n: { spawn: 1 }, e: { spawn: 100 }, drop: 0, tomb: 0, ruin: 0 } },
}), mem, args);
check(f2.acc.harvest === 150 && f2.acc.spawn === 200 && f2.acc.build === 300 && f2.acc.upgrade === 100 && f2.acc.upgradeByRoom.W1N1 === 60 && f2.acc.upgradeByRoom.W3N1 === 40,
    'after the baseline the deltas are booked normally: ' + JSON.stringify(f2.acc));
check(bench.parseArgs(['--fork-world', 'x/y']).forkWorld === 'x/y', 'fork-world arg');
check(bench.parseArgs(['--snapshot-every', '50000', '--fork-db', 'a.json']).snapshotEvery === 50000 && bench.parseArgs(['--fork-db', 'a.json']).forkDb === 'a.json', 'snapshot/fork-db args');

// forkWorld / snapshotWorld 的文件搬运（临时目录，不碰真正的 worlds/）
const fs = require('fs');
const os = require('os');
const path = require('path');

// 大脑钉版：--src-rev 导出里有 scripts/brain/run.py 时用它（工作树里的大脑随时在变，会污染同快照的分叉对比）
const brainTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rclbrain-'));
check(bench.brainScriptPath(brainTmp) === null, 'no pinned brain when the export has none');
fs.mkdirSync(path.join(brainTmp, 'src-export', 'scripts', 'brain'), { recursive: true });
fs.writeFileSync(path.join(brainTmp, 'src-export', 'scripts', 'brain', 'run.py'), '# pinned\n');
check(bench.brainScriptPath(brainTmp) === path.join(brainTmp, 'src-export', 'scripts', 'brain', 'run.py'), 'pinned brain script is used when exported');
fs.rmSync(brainTmp, { recursive: true, force: true });

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcl-fork-test-'));
    const src = path.join(tmp, 'source-world');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'db.json'), JSON.stringify({ collections: [] }));
    fs.writeFileSync(path.join(src, '.screepsrc'), 'db = db.json\n');
    const snap = await bench.snapshotWorld(src, path.join(tmp, 'out'), 1234);
    check(fs.existsSync(snap) && /db-1234\.json$/.test(snap), 'snapshotWorld writes <out>/world-snapshots/db-<tick>.json');
    fs.mkdirSync(path.join(tmp, 'nested', 'actual-worlds'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'nested', 'actual-worlds'), path.join(tmp, 'worlds'), 'dir');
    const worldDir = await bench.forkWorld(src, 1, null, { worldRoot: path.join(tmp, 'worlds'), dbFile: snap });
    const mods = JSON.parse(fs.readFileSync(path.join(worldDir, 'mods.json'), 'utf8'));
    check(fs.existsSync(path.join(worldDir, 'db.json')) && fs.existsSync(path.join(worldDir, '.screepsrc')) && fs.existsSync(path.join(worldDir, 'project-bot', 'main.js')) &&
        mods.bots.project === path.join(worldDir, 'project-bot') && /benchmark_mod\.js$/.test(mods.mods[0]), 'forkWorld copies the db snapshot, aux files, writes bot code and mods.json');
    check(fs.existsSync(path.resolve(fs.realpathSync(worldDir), mods.mods[0])), 'benchmark mod resolves from real cwd under symlinked worlds');
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) { console.log(`${failures} failing check(s)`); process.exit(1); }
    console.log('rcl_benchmark_test: ok');
})().catch((error) => { console.log('FAIL: ' + error.message); process.exit(1); });

