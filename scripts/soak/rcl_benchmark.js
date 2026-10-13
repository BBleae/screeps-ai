#!/usr/bin/env node
'use strict';
/**
 * RCL 基准：让指定版本的 bot 在私服里从"一个 300 能量的 spawn + 空 Memory"起跑，直到母房 RCL8（或 tick 上限），
 * 记录每级 RCL 的到达 tick、账号总 Control Point 增长（= 用户 gcl 点数增量）、占领时间线，以及从数据库侧看到的能量收支账，
 * 供 scripts/soak/rcl_report.py 做理论上限/效率/浪费分析。
 *
 * 世界：线上快照（data/soak/live_snapshot.json）里 30 个房的真实地形，但只播种中立对象——控制器、源、矿、Source Keeper lair
 *      （引擎自己会孵 keeper；sector 中心房存在时后端 cron 会生成 stronghold，进而按采集量刷 Invader）。其它玩家的建筑不播种。
 *      账号按我们线上的 GCL（--gcl，默认 12）起，外部大脑允许占领（--lock-claim 可锁死只测单房），母房数会随占领增加。
 * 账本（每 --sample tick 一次，全部来自 storage.db，不占 bot CPU）：
 *      采集 = 源的 invaderHarvested 增量（引擎在 harvest 意图里累加，Invader 刷新时清零→按回绕处理），按房分账（己方房 / 外矿）
 *      升级 = 用户 gcl 点数增量（引擎 upgradeController 对 gcl 加同样的能量数）= 账号总 CP；各房再按控制器进度分账
 *      孵化 = 首次见到的 creep 身体成本之和（按角色、按母房、按外矿房 spawnByRemote）；建造 = 工地进度增量 + 完工时的剩余量；库存 = 建筑/creep/地面/墓碑里的能量
 *      残差 = 采集 − 升级 − 孵化 − 建造 − Δ库存 ≈ 修理/塔/衰减/被拆工地/采样间隔内出现又完工的小工地
 * 用法：node scripts/soak/rcl_benchmark.js [--src-rev <git rev>] [--home W33S7] [--spawn 23,21] [--cpu 140] [--gcl 12] [--lock-claim]
 *        [--sample 50] [--probe-every 500] [--brain-every 5000] [--brain-homes W33S7] [--until-rcl 8] [--ticks 1500000] [--max-hours 30]
 *        [--out data/soak/rcl-bench-<时间>] [--resume <out>] [--keep-running]
 *        [--snapshot-every 50000]（定期把 db.json 存到 <out>/world-snapshots/，供分叉）
 *        [--fork-world <世界目录> [--fork-db <db.json 快照>] --src-rev <rev> [--username <快照用户名>]]（从现有世界/历史快照分叉换代码，账本从分叉点归零）
 *        [--brain-arg <参数>]（可重复，原样透传给外部大脑 run.py：同一提交只改一个大脑参数做 A/B）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { PrivateServer, createWorld, resolveServerDir, sleep, sourceModules } = require('../private_server/server_process');
const { loadProjectEnv } = require('../private_server/env');
const fixtures = require('../private_server/fixtures');
const validation = require('../private_server/run_validation');

const USERNAME = 'BenchBBleae';
const NEUTRAL = new Set(['controller', 'source', 'mineral', 'keeperLair']);
/** 按外矿房分账的角色：外矿三件套与派往外矿的 defender；claimer/pioneer 的 targetRoom 是占领目标，不算外矿成本 */
const REMOTE_ATTRIB_ROLES = new Set(['remoteMiner', 'remoteHauler', 'reserver', 'defender']);
const PART_COST = { M: 50, W: 100, C: 50, A: 80, R: 150, H: 250, L: 600, T: 10 };
const CONTROLLER_LEVELS = { 1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000 };
const GCL_MULTIPLY = 1000000;
const GCL_POW = 2.4;
const literal = fixtures.literal;

function parseArgs(argv) {
    const out = { username: USERNAME, snapshot: path.join(ROOT, 'data', 'soak', 'live_snapshot.json'), home: 'W33S7', spawn: { x: 23, y: 21 }, cpu: 140, gcl: 12, lockClaim: false,
        sample: 50, probeEvery: 500, brainEvery: 5000, brainHomes: null, untilRcl: 8, ticks: 1500000, maxHours: 30, tickDuration: 1,
        out: null, resume: null, keepRunning: false, srcRev: null, processors: 1, forkWorld: null, forkDb: null, snapshotEvery: 0, brainArgs: [] };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--username') { if (!value || value.startsWith('--')) throw new Error('--username requires a value'); out.username = value; i++; }
        else if (key === '--snapshot') { out.snapshot = value; i++; }
        else if (key === '--home') { out.home = value; i++; }
        else if (key === '--spawn') { const [x, y] = value.split(',').map(Number); out.spawn = { x, y }; i++; }
        else if (key === '--cpu') { out.cpu = Number(value); i++; }
        else if (key === '--gcl') { out.gcl = Number(value); i++; }
        else if (key === '--lock-claim') out.lockClaim = true;
        else if (key === '--sample') { out.sample = Number(value); i++; }
        else if (key === '--probe-every') { out.probeEvery = Number(value); i++; }
        else if (key === '--brain-every') { out.brainEvery = Number(value); i++; }
        else if (key === '--brain-homes') { out.brainHomes = value; i++; }
        else if (key === '--until-rcl') { out.untilRcl = Number(value); i++; }
        else if (key === '--ticks') { out.ticks = Number(value); i++; }
        else if (key === '--max-hours') { out.maxHours = Number(value); i++; }
        else if (key === '--tick-duration') { out.tickDuration = Number(value); i++; }
        else if (key === '--out') { out.out = value; i++; }
        else if (key === '--resume') { out.resume = value; out.out = value; i++; }
        else if (key === '--src-rev') { out.srcRev = value; i++; }
        else if (key === '--processors') { out.processors = Number(value); i++; }
        // --brain-arg 可重复：原样透传给 scripts/brain/run.py，用来在同一提交上只改一个大脑参数做 A/B（如外矿评分门槛）
        else if (key === '--brain-arg') { out.brainArgs.push(value); i++; }
        else if (key === '--fork-world') { out.forkWorld = value; i++; }
        else if (key === '--fork-db') { out.forkDb = value; i++; }
        else if (key === '--snapshot-every') { out.snapshotEvery = Number(value); i++; }
        else if (key === '--keep-running') out.keepRunning = true;
        else throw new Error(`Unknown argument ${key}`);
    }
    if (!out.out) out.out = path.join(ROOT, 'data', 'soak', 'rcl-bench-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16));
    return out;
}

/** 把 git 某个版本的 src/ 与 vendor/wheels/ 导出到 outDir（基准要钉住"线上版本"，不受工作树里未部署的改动影响） */
function exportSources(rev, outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    // 大脑（scripts/brain）也按 rev 导出：它每 --brain-every tick 跑一次、决定外矿与占领，工作树里的大脑随时在变，
    // 不钉版的话同一快照的两次分叉会用到不同的大脑（2026-09-06 的第 5–7 轮就是这样，外矿采集差 ±5–15/tick）
    const tar = execFileSync('git', ['archive', '--format=tar', rev, 'src', 'vendor/wheels', 'scripts/brain'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', outDir], { input: tar });
    const commit = execFileSync('git', ['rev-parse', rev], { cwd: ROOT, encoding: 'utf8' }).trim();
    return { srcRoot: outDir, commit };
}

function runUsername(run) {
    return run.username || USERNAME;
}

function gclLevel(points) {
    return Math.floor(Math.pow(Math.max(0, points) / GCL_MULTIPLY, 1 / GCL_POW)) + 1;
}

function neutralDocument(roomName, obj) {
    const doc = { type: obj.type, room: roomName, x: obj.x, y: obj.y };
    switch (obj.type) {
    case 'source':
        // 引擎按房间状态自己校正容量（无主 1500 / 有主或预定 3000 / SK 房 4000）
        Object.assign(doc, { energy: obj.energyCapacity || 3000, energyCapacity: obj.energyCapacity || 3000, invaderHarvested: 0 });
        break;
    case 'mineral':
        Object.assign(doc, { mineralType: obj.mineralType || 'H', mineralAmount: obj.mineralAmount || 70000, density: obj.density || 3 });
        break;
    case 'controller':
        Object.assign(doc, { level: 0, progress: 0 });
        break;
    case 'keeperLair':
        break;
    default:
        return null;
    }
    return doc;
}

async function insertRoom(cli, roomName, terrain) {
    await cli.evaluateJson(`storage.db.rooms.insert(${literal({ _id: roomName, status: 'normal', active: true })}).then(function(){return true})`);
    await cli.evaluateJson(`storage.db['rooms.terrain'].insert(${literal({ room: roomName, terrain, type: 'terrain' })}).then(function(){return true})`);
}

async function seedFresh(cli, snapshot, args) {
    await cli.run('system.pauseSimulation()', { timeoutMs: 8000 });
    const gameTime = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)')) || 1;
    const rooms = Object.keys(snapshot.rooms);
    // 私服初始世界自带 121 个房（4 个 simplebot、SK 房、stronghold），每 tick 都要跑它们的代码和 keeper：全部删掉，只留快照的 30 房
    const removed = await cli.evaluateJson(
        `storage.db.rooms.find({}).then(function(list){var keep=${literal(rooms)};var names=list.map(function(r){return r._id}).filter(function(n){return keep.indexOf(n)<0});var db=storage.db;return Promise.all(names.map(function(n){return Promise.all([db.rooms.removeWhere({_id:n}),db['rooms.objects'].removeWhere({room:n}),db['rooms.flags'].removeWhere({room:n}),db['rooms.terrain'].removeWhere({room:n}),db['rooms.intents'].removeWhere({room:n})])})).then(function(){return names.length})})`,
        { timeoutMs: 120000 });
    await cli.evaluateJson(`storage.db.users.find({bot:{$exists:true}}).then(function(users){return Promise.all(users.map(function(user){return storage.db.users.update({_id:user._id},{$set:{active:0,cpu:0}})}))}).then(function(){return true})`, { timeoutMs: 30000 });
    for (const roomName of rooms) await insertRoom(cli, roomName, snapshot.rooms[roomName].terrain);
    await cli.evaluateJson('map.updateTerrainData()', { timeoutMs: 60000 });
    await fixtures.ensureTerrainNeighbors(cli);
    await cli.evaluateJson(
        `storage.db.rooms.find({status:'normal'}).then(function(rooms){var names=rooms.map(function(room){return room._id});return Promise.all([storage.env.set(storage.env.keys.ACCESSIBLE_ROOMS,JSON.stringify(names)),storage.env.set(storage.env.keys.ROOM_STATUS_DATA,JSON.stringify({novice:{},respawn:{},closed:{}}))]).then(function(){return names.length})})`,
        { timeoutMs: 30000 });
    const neutral = {};
    for (const roomName of rooms) {
        for (const obj of snapshot.rooms[roomName].objects) {
            if (!NEUTRAL.has(obj.type)) continue;
            const doc = neutralDocument(roomName, obj);
            if (!doc) continue;
            await cli.evaluateJson(`storage.db['rooms.objects'].insert(${literal(doc)}).then(function(){return true})`);
            neutral[obj.type] = (neutral[obj.type] || 0) + 1;
        }
    }
    // bots.spawn：建用户（cpu、gcl 点数、Memory "{}"）、在指定格放 300 能量的 spawn、控制器升到 1 级并给 20000 tick 安全模式（与官方重生一致）
    await cli.evaluateJson(
        `bots.spawn('project',${literal(args.home)},{username:${literal(args.username)},cpu:${Number(args.cpu)},gcl:${Number(args.gcl)},x:${Number(args.spawn.x)},y:${Number(args.spawn.y)}}).then(function(){return true})`,
        { timeoutMs: 30000 });
    const userId = await validation.getUserId(cli, args.username);
    if (!userId) throw new Error('bots.spawn did not create the user');
    const spawn = await cli.evaluateJson(`storage.db['rooms.objects'].findOne({type:'spawn',user:${literal(userId)}}).then(function(s){return s&&{x:s.x,y:s.y,room:s.room,energy:s.store.energy}})`);
    if (!spawn || spawn.x !== args.spawn.x || spawn.y !== args.spawn.y) throw new Error(`spawn landed at ${JSON.stringify(spawn)} instead of ${JSON.stringify(args.spawn)}`);
    return { userId, gameTime, neutral, spawn, removedRooms: removed };
}

/** 从一个正在跑（或跑完）的世界分叉：拷贝 db.json 等文件到新世界目录，换上另一版本的 bot 代码；
 *  源世界的私服可能正在写 db.json，拷贝后必须能 JSON.parse，否则重试。返回新世界目录。 */
async function forkWorld(sourceWorld, version, srcRoot, options) {
    const opts = options || {};
    const worldRoot = opts.worldRoot || path.join(ROOT, 'private-server', 'worlds');
    fs.mkdirSync(worldRoot, { recursive: true });
    const worldDir = fs.mkdtempSync(path.join(worldRoot, 'fork-'));
    const dbPath = path.join(worldDir, 'db.json');
    // 默认取源世界当前的 db.json；--fork-db 可指定 --snapshot-every 留下的历史快照，从任意 tick 点分叉
    const dbSource = opts.dbFile ? path.resolve(opts.dbFile) : path.join(sourceWorld, 'db.json');
    for (let attempt = 0; ; attempt++) {
        fs.copyFileSync(dbSource, dbPath);
        try { JSON.parse(fs.readFileSync(dbPath, 'utf8')); break; } catch (error) {
            if (attempt >= 5) throw new Error(`db.json copied from ${dbSource} never parsed: ${error.message}`);
            await sleep(1500);
        }
    }
    for (const name of ['.screepsrc', 'assets', 'example-mods', 'mods.example.json']) {
        const from = path.join(sourceWorld, name);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(worldDir, name), { recursive: true });
    }
    const botDir = path.join(worldDir, 'project-bot');
    fs.mkdirSync(botDir, { recursive: true });
    for (const [moduleName, source] of Object.entries(sourceModules(version, srcRoot))) fs.writeFileSync(path.join(botDir, moduleName + '.js'), source, 'utf8');
    fs.writeFileSync(path.join(worldDir, 'mods.json'), JSON.stringify({
        mods: [fs.realpathSync(path.join(ROOT, 'scripts', 'private_server', 'benchmark_mod.js'))], bots: { project: botDir } }, null, 2) + '\n');
    return worldDir;
}

/* 数据库侧采样：一次 CLI 调用拿到全部对象并在后端进程里聚合（对象数几百，传回的只是摘要）。只统计我方或无主对象。 */
function aggregateSource(uid, home) {
    var db = storage.db;
    return Promise.all([db['rooms.objects'].find({}), db.users.findOne({ _id: uid }), storage.env.get(storage.env.keys.GAMETIME)]).then(function (r) {
        var objects = r[0], user = r[1];
        var out = { t: Number(r[2]), gcl: user && user.gcl || 0, ctrl: null, owned: {}, sources: [], creeps: [], hostiles: {}, cores: [], rooms: {}, sites: [], spawning: 0, keys: [], collect: {} };
        var LETTER = { move: 'M', work: 'W', carry: 'C', attack: 'A', ranged_attack: 'R', heal: 'H', claim: 'L', tough: 'T' };
        function room(name) { return out.rooms[name] || (out.rooms[name] = { n: {}, e: {}, drop: 0, dropN: 0, tomb: 0, ruin: 0 }); }
        objects.forEach(function (o) {
            if (o.type === 'controller') {
                if (o.user === uid) out.owned[o.room] = { level: o.level || 0, progress: o.progress || 0, downgradeTime: o.downgradeTime || 0, safeMode: o.safeMode || 0, safeModeAvailable: o.safeModeAvailable || 0, x: o.x, y: o.y };
                else if (o.reservation || o.user) { room(o.room).ctrl = { user: o.user || null, res: o.reservation ? o.reservation.endTime : 0 }; }
                room(o.room).ctrlPos = [o.x, o.y];
                return;
            }
            if (o.type === 'source') { out.sources.push([o.room, o.x, o.y, o.energy || 0, o.invaderHarvested || 0, o.nextRegenerationTime || 0, o.energyCapacity || 0]); return; }
            if (o.type === 'creep') {
                if (o.user === uid) {
                    var body = {};
                    (o.body || []).forEach(function (p) { var l = LETTER[p.type] || '?'; body[l] = (body[l] || 0) + 1; });
                    out.creeps.push([o.name, o.room, body, o.store && o.store.energy || 0, o.ageTime || 0, o.spawning ? 1 : 0, o.x, o.y, String(o._id)]);
                } else {
                    var h = out.hostiles[o.room] || (out.hostiles[o.room] = {});
                    h[o.user] = (h[o.user] || 0) + 1;
                }
                return;
            }
            if (o.type === 'invaderCore') { out.cores.push([o.room, o.level || 0, o.x, o.y]); return; }
            if (o.type === 'constructionSite') { if (o.user === uid) out.sites.push([String(o._id), o.room, o.structureType, o.x, o.y, o.progress || 0, o.progressTotal || 0]); return; }
            if (o.type === 'mineral' || o.type === 'keeperLair') return;
            if (o.user && o.user !== uid) return;
            var rr = room(o.room);
            if (o.type === 'energy') { if (!o.resourceType || o.resourceType === 'energy') { rr.drop += o.energy || 0; rr.dropN++; out.collect[String(o._id)] = 'drop'; } return; }
            if (o.type === 'tombstone') { rr.tomb += o.store && o.store.energy || 0; out.collect[String(o._id)] = 'tomb'; return; }
            if (o.type === 'ruin') { rr.ruin += o.store && o.store.energy || 0; out.collect[String(o._id)] = 'ruin'; return; }
            if (o.type === 'container') { (rr.conts || (rr.conts = [])).push([String(o._id), o.x, o.y, o.store && o.store.energy || 0, o.hits || 0]); rr.contHits = (rr.contHits || 0) + (o.hits || 0); rr.contMinHits = rr.contMinHits == null ? (o.hits || 0) : Math.min(rr.contMinHits, o.hits || 0); }
            else if (o.type === 'storage' || o.type === 'terminal' || o.type === 'link') out.collect[String(o._id)] = o.type;
            // rampart 血量：塔每 tick 只修一个目标，比值最低的 rampart 会独占维修动作、把容器饿死（2026-09-07 查明），所以要能看见 rampart 的血量走势才能判「排除 rampart」这类改动
            if (o.type === 'rampart') { rr.rampHits = (rr.rampHits || 0) + (o.hits || 0); rr.rampMinHits = rr.rampMinHits == null ? (o.hits || 0) : Math.min(rr.rampMinHits, o.hits || 0); }
            rr.n[o.type] = (rr.n[o.type] || 0) + 1;
            out.keys.push(o.room + ':' + o.x + ',' + o.y + ':' + o.type);
            if (o.store && o.store.energy) rr.e[o.type] = (rr.e[o.type] || 0) + o.store.energy;
            if (o.type === 'spawn' && o.spawning) out.spawning++;
        });
        /* 容器分类：与源切比雪夫距离 ≤ 1 是源容器，与控制器 ≤ 3 是控制器容器；每房汇总两类能量，供运输诊断（hauler 取货来源比例、源容器/控制器容器均值） */
        var srcPos = {};
        out.sources.forEach(function (s) { (srcPos[s[0]] || (srcPos[s[0]] = [])).push([s[1], s[2]]); });
        Object.keys(out.rooms).forEach(function (name) {
            var rr = out.rooms[name];
            rr.srcCont = 0; rr.ctrlCont = 0;
            (rr.conts || []).forEach(function (c) {
                var nearSrc = (srcPos[name] || []).some(function (p) { return Math.max(Math.abs(p[0] - c[1]), Math.abs(p[1] - c[2])) <= 1; });
                var nearCtrl = rr.ctrlPos && Math.max(Math.abs(rr.ctrlPos[0] - c[1]), Math.abs(rr.ctrlPos[1] - c[2])) <= 3;
                var cls = nearSrc ? 'srcContainer' : (nearCtrl ? 'ctrlContainer' : 'container');
                out.collect[c[0]] = cls;
                // 血量按类分开：源容器只靠塔和矿工自修，控制器容器还有升级者顺手修，两者的衰减处境不同（无主房的容器还快 5 倍，那些记在外矿房自己的项里）
                if (cls === 'srcContainer') { rr.srcCont += c[3]; rr.srcContHits = Math.min(rr.srcContHits == null ? Infinity : rr.srcContHits, c[4]); }
                else if (cls === 'ctrlContainer') { rr.ctrlCont += c[3]; rr.ctrlContHits = Math.min(rr.ctrlContHits == null ? Infinity : rr.ctrlContHits, c[4]); }
            });
            delete rr.conts; delete rr.ctrlPos;
        });
        out.ctrl = out.owned[home] || null;
        return out;
    });
}

function memorySource(uid) {
    return storage.env.get(storage.env.keys.MEMORY + uid).then(function (raw) {
        var m = raw ? JSON.parse(raw) : {};
        var roles = {};
        Object.keys(m.creeps || {}).forEach(function (n) { var c = m.creeps[n] || {}; var remoteRoom = c.remoteRoom || (c.targetRoom && c.targetRoom !== c.home ? c.targetRoom : '') || '';
            var task = c.role === 'hauler' && c.brokerTask ? [c.brokerTask.kind || '', String(c.brokerTask.id || '')] : null;
            roles[n] = task ? [c.role || '?', c.home || '', remoteRoom, task[0], task[1]] : [c.role || '?', c.home || '', remoteRoom]; });
        var rooms = {};
        Object.keys(m.rooms || {}).forEach(function (name) {
            var rm = m.rooms[name] || {};
            if (!rm.plan && !rm.spawnQueue && !rm.remotes && !rm.state) return;
            rooms[name] = { state: rm.state || null, queue: rm.spawnQueue || null,
                remotes: Object.keys(rm.remotes || {}).map(function (k) { var x = rm.remotes[k] || {}; return [k, x.enabled ? 1 : 0, x.suspendReason || '', (x.reservation && x.reservation.ticksToEnd) || 0]; }),
                planVer: (rm.plan && rm.plan.version) || null, planError: rm.planError || null, expansion: rm.expansion || null, targets: (rm.demand && rm.demand.targets) || null };
        });
        var errs = m.errors || [];
        var brain = null;
        if (m.brain) {
            brain = { issuedAt: m.brain.issuedAt, ack: m.brain.ack && m.brain.ack.issuedAt, stale: !!m.brain.stale, claims: {}, remotes: {} };
            Object.keys(m.brain.rooms || {}).forEach(function (h) { var d = m.brain.rooms[h] || {}; brain.claims[h] = d.claim && d.claim.room || null; brain.remotes[h] = d.remotes || []; });
        }
        return { roles: roles, rooms: rooms, stat: (m.stats || []).slice(-1)[0] || null, errN: errs.length, lastErr: errs.length ? errs[errs.length - 1] : null,
            brain: brain, memBytes: raw ? raw.length : 0, mapN: Object.keys(m.map || {}).length, haul: m.haulStats || null };
    });
}

/** 把函数源码压成一行送进私服 CLI：块注释去掉，整行的 // 注释也去掉（压成一行后 // 会吞掉后面全部代码，CLI 报 "Unexpected end of input"） */
function oneLine(fn) {
    return fn.toString().replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '').replace(/\s*\n\s*/g, ' ');
}
const AGGREGATE = oneLine(aggregateSource);
const MEMORY = oneLine(memorySource);

function bodyCost(body) {
    let cost = 0;
    for (const letter in body) cost += (PART_COST[letter] || 0) * body[letter];
    return cost;
}
function bodyParts(body) {
    let n = 0;
    for (const letter in body) n += body[letter];
    return n;
}

function newState() {
    return { seen: {}, sourcesLast: {}, sites: {}, roomLast: {}, claims: {}, spawnBuilt: {}, lost: {}, claimsLogged: {}, gcl0: null, stock0: null, levels: [], restarts: 0, brainRuns: 0, samples: 0,
        lastRcl: null, lastProg: null, lastT: null, lastWall: null,
        acc: { harvest: 0, harvestHome: 0, harvestRemote: 0, harvestByRoom: {}, upgrade: 0, upgradeByRoom: {}, spawn: 0, parts: 0, creeps: 0, spawnByRole: {}, spawnByHome: {}, spawnByRemote: {},
            build: 0, buildLost: 0, buildByType: {}, buildHome: 0 } };
}

function creepInfo(mem, name) {
    const info = mem && mem.roles && mem.roles[name];
    if (Array.isArray(info)) return { role: info[0] || '?', home: info[1] || '', remote: info[2] || '', task: info[3] ? { kind: info[3], id: info[4] || '' } : null };
    return { role: info || '?', home: '', remote: '', task: null };
}

/** 续跑时把旧 state.json 补齐新版本加的键（acc.spawnByRemote 等），否则 account() 会在 undefined 上写入 */
function migrateState(state) {
    const fresh = newState();
    for (const key of Object.keys(fresh)) if (state[key] === undefined) state[key] = fresh[key];
    if (!state.acc) state.acc = fresh.acc;
    for (const key of Object.keys(fresh.acc)) if (state.acc[key] === undefined) state.acc[key] = fresh.acc[key];
    return state;
}

/** 把一次采样并进账本，返回写入 progress.jsonl 的记录（含累计值） */
function account(state, sample, mem, args) {
    const acc = state.acc;
    const primary = args.home;
    const owned = Object.keys(sample.owned || {});
    const ownedSet = new Set(owned);
    const wall = Date.now();
    // 分叉世界的第一次采样：只记基线（源的累计采集、活着的 creep、已有工地、已占的房），不算进账本
    const baseline = !!state.baseline;
    // 采集：invaderHarvested 增量（cron 刷 Invader 时归零 → 新值就是刷新后的采集量）；己方房 / 外矿分账
    for (const [room, x, y, , ih] of sample.sources) {
        const key = room + ':' + x + ',' + y;
        const last = state.sourcesLast[key];
        const delta = last == null ? (baseline ? 0 : ih) : (ih >= last ? ih - last : ih);
        state.sourcesLast[key] = ih;
        if (!delta) continue;
        acc.harvest += delta;
        acc.harvestByRoom[room] = (acc.harvestByRoom[room] || 0) + delta;
        if (ownedSet.has(room)) acc.harvestHome += delta; else acc.harvestRemote += delta;
    }
    // 升级：gcl 点数就是账号累计升级能量（总 CP）
    if (state.gcl0 == null) state.gcl0 = sample.gcl;
    acc.upgrade = sample.gcl - state.gcl0;
    // 孵化：首次见到的 creep（孵化开始时对象就已存在，能量当时已扣），按角色 / 母房分账。
    // 按对象 id 去重而不是名字：bot 会复用死掉 creep 的名字，同一采样间隔内死一只再孵一只同名的会被漏记
    if (state.migrateNames) {
        // 从按名字记的旧状态续跑：世界在停机期间没有前进，此刻活着的 creep 就是上次采样里的那些，把它们迁到 id 键上，不重复计孵化
        for (const c of sample.creeps) {
            const key = c[8] || c[0];
            if (key !== c[0] && state.seen[key] == null && state.seen[c[0]] != null) { state.seen[key] = state.seen[c[0]]; delete state.seen[c[0]]; }
        }
        state.migrateNames = false;
    }
    const liveNames = new Set();
    for (const c of sample.creeps) {
        const [name, , body] = c;
        const key = c[8] || name;
        liveNames.add(key);
        if (state.seen[key] != null) continue;
        const cost = bodyCost(body);
        state.seen[key] = cost;
        if (baseline) continue;
        acc.spawn += cost;
        acc.parts += bodyParts(body);
        acc.creeps++;
        const info = creepInfo(mem, name);
        acc.spawnByRole[info.role] = (acc.spawnByRole[info.role] || 0) + cost;
        const home = info.home || primary;
        acc.spawnByHome[home] = (acc.spawnByHome[home] || 0) + cost;
        // 外矿角色（memory.remoteRoom）与派往外矿的 defender（targetRoom ≠ home）按外矿房分账，供每个外矿的“采集 − 孵化”净值
        if (info.remote && REMOTE_ATTRIB_ROLES.has(info.role)) acc.spawnByRemote[info.remote] = (acc.spawnByRemote[info.remote] || 0) + cost;
    }
    // 见过的名字集合只保留活着的（否则 80 万 tick 会累积几万条）
    for (const key in state.seen) if (!liveNames.has(key)) delete state.seen[key];
    // 建造：工地进度增量；消失的工地看同格是否出现了同类建筑（完工→补剩余量；被拆→已花的算损失）
    const nowSites = {};
    for (const [id, room, type, x, y, progress, total] of sample.sites) {
        nowSites[id] = { room, type, x, y, progress, total };
        const last = state.sites[id];
        const delta = last ? Math.max(0, progress - last.progress) : (baseline ? 0 : progress);
        if (delta) {
            acc.build += delta;
            acc.buildByType[type] = (acc.buildByType[type] || 0) + delta;
            if (ownedSet.has(room)) acc.buildHome += delta;
        }
    }
    let completed = 0, removed = 0;
    const structKeys = new Set(sample.keys || []);
    for (const id in state.sites) {
        if (nowSites[id]) continue;
        const last = state.sites[id];
        // 同格出现了同类建筑 = 完工（补上采样间隔内花掉的剩余量）；否则是被拆/被踩掉的工地，已花的算损失
        if (structKeys.has(last.room + ':' + last.x + ',' + last.y + ':' + last.type)) {
            const rest = Math.max(0, last.total - last.progress);
            acc.build += rest;
            acc.buildByType[last.type] = (acc.buildByType[last.type] || 0) + rest;
            if (ownedSet.has(last.room)) acc.buildHome += rest;
            completed++;
        } else {
            acc.buildLost += last.progress;
            removed++;
        }
    }
    state.sites = nowSites;
    // 外矿 = 有我方 creep 的非己方房 ∪ Memory 里任一母房启用的外矿；其它房（SK 房、stronghold 房）的无主容器/掉落不算我们的库存
    const remoteRooms = new Set(sample.creeps.map((c) => c[1]).filter((r) => !ownedSet.has(r)));
    for (const roomName in (mem && mem.rooms) || {}) {
        for (const entry of mem.rooms[roomName].remotes || []) if (entry[1] && !ownedSet.has(entry[0])) remoteRooms.add(entry[0]);
    }
    // 库存（己方房 + 外矿）；spawn 自身每 tick 自产 1 能量（低于 300 时），报告里按 spawn 能量与 dt 估算，这里把 spawn 与 extension 分开记
    const stock = { spawnExt: 0, tower: 0, storage: 0, terminal: 0, link: 0, container: 0, containerRemote: 0, carried: 0, dropped: 0, droppedRemote: 0, tomb: 0, ruin: 0, other: 0 };
    let spawnOnly = 0;
    let piles = 0;
    for (const roomName in sample.rooms) {
        const rr = sample.rooms[roomName];
        const isHome = ownedSet.has(roomName);
        if (!isHome && !remoteRooms.has(roomName)) continue;
        for (const type in rr.e) {
            const e = rr.e[type];
            if (type === 'spawn' || type === 'extension') { stock.spawnExt += e; if (type === 'spawn') spawnOnly += e; }
            else if (type === 'tower') stock.tower += e;
            else if (type === 'storage') stock.storage += e;
            else if (type === 'terminal') stock.terminal += e;
            else if (type === 'link') stock.link += e;
            else if (type === 'container') { if (isHome) stock.container += e; else stock.containerRemote += e; }
            else stock.other += e;
        }
        if (isHome) stock.dropped += rr.drop; else stock.droppedRemote += rr.drop;
        piles += rr.dropN || 0;
        stock.tomb += rr.tomb;
        stock.ruin += rr.ruin;
    }
    for (const c of sample.creeps) stock.carried += c[3];
    stock.total = Object.values(stock).reduce((a, b) => a + b, 0);
    stock.spawn = spawnOnly;
    stock.piles = piles;
    if (state.stock0 == null) state.stock0 = stock.total;
    const residual = acc.harvest - acc.upgrade - acc.spawn - acc.build - (stock.total - state.stock0);
    // 角色人数
    const roles = {};
    // hauler 当前 broker 任务按母房分类：collect 的目标 id（去掉 ':collect' 后缀）查采样里的对象分类；没有任务算 idle
    const haulerTasks = {};
    // feeder（storage → 控制器容器的短途搬运工）按母房计数，载货的算在送货途中：载货占比 ≈ 送/取时间比
    const feeders = {};
    for (const c of sample.creeps) {
        const info = creepInfo(mem, c[0]);
        roles[info.role] = (roles[info.role] || 0) + 1;
        if (c[5]) continue;
        const home = info.home || primary;
        if (info.role === 'feeder') {
            const f = feeders[home] || (feeders[home] = { n: 0, loaded: 0 });
            f.n++;
            if (c[3] > 0) f.loaded++;
            continue;
        }
        if (info.role !== 'hauler') continue;
        const bucket = haulerTasks[home] || (haulerTasks[home] = { srcContainer: 0, ctrlContainer: 0, container: 0, storage: 0, drop: 0, tomb: 0, other: 0, deliver: 0, idle: 0 });
        let cls = 'idle';
        if (info.task) {
            if (info.task.kind === 'collect') cls = (sample.collect || {})[String(info.task.id).split(':')[0]] || 'other';
            else if (info.task.kind === 'deliver') cls = 'deliver';
            else cls = 'other';
        }
        if (cls === 'ruin') cls = 'tomb';
        if (!(cls in bucket)) cls = 'other';
        bucket[cls]++;
    }
    // 各己方房：控制器进度分账、升级事件（前后两次采样线性插值）、占领 / 建成 spawn 的时间线
    const levelUps = [];
    const ownedInfo = {};
    for (const roomName of owned) {
        const c = sample.owned[roomName];
        const rr = sample.rooms[roomName] || { n: {}, e: {} };
        ownedInfo[roomName] = { rcl: c.level, prog: c.progress, progTotal: CONTROLLER_LEVELS[c.level] || 0,
            downgradeIn: c.downgradeTime ? c.downgradeTime - sample.t : null, safe: c.safeMode > sample.t ? c.safeMode - sample.t : 0,
            spawn: rr.n.spawn || 0, ext: rr.n.extension || 0, tower: rr.n.tower || 0, storage: rr.e.storage || 0, links: rr.n.link || 0, labs: rr.n.lab || 0,
            srcCont: rr.srcCont || 0, ctrlCont: rr.ctrlCont || 0, drop: rr.drop || 0, dropN: rr.dropN || 0, linkE: rr.e.link || 0,
            contHits: rr.contHits || 0, contMinHits: rr.contMinHits == null ? null : rr.contMinHits, contN: rr.n.container || 0, towerE: rr.e.tower || 0, towerN: rr.n.tower || 0,
            srcContHits: rr.srcContHits == null || rr.srcContHits === Infinity ? null : rr.srcContHits, ctrlContHits: rr.ctrlContHits == null || rr.ctrlContHits === Infinity ? null : rr.ctrlContHits,
            rampHits: rr.rampHits || 0, rampMinHits: rr.rampMinHits == null ? null : rr.rampMinHits, rampN: rr.n.rampart || 0 };
        if ((rr.n.spawn || 0) > 0 && state.spawnBuilt[roomName] == null) state.spawnBuilt[roomName] = sample.t;
        const last = state.roomLast[roomName];
        if (!last) {
            if (!baseline && (state.samples > 0 || roomName !== primary)) state.claims[roomName] = sample.t;
            acc.upgradeByRoom[roomName] = (acc.upgradeByRoom[roomName] || 0) + (baseline ? 0 : c.progress);
            state.roomLast[roomName] = { level: c.level, progress: c.progress, t: sample.t };
            continue;
        }
        let gained = 0;
        if (c.level > last.level) {
            let total = 0;
            for (let l = last.level; l < c.level; l++) total += CONTROLLER_LEVELS[l] || 0;
            gained = Math.max(0, total - last.progress + c.progress);
            const need = CONTROLLER_LEVELS[last.level] || 0;
            // 降级后引擎把进度记成"旧进度 + 下一级的 90%"，可能已超过本级所需：第一次 upgrade 就回到上一级，不做插值
            const reup = last.progress >= need;
            const frac = reup ? 1 : (gained > 0 ? Math.min(1, Math.max(0, (need - last.progress) / gained)) : 1);
            const tick = Math.round(last.t + frac * (sample.t - last.t));
            const previous = state.levels.filter((l) => l.room === roomName).pop();
            const since = previous ? previous.tick : (state.claims[roomName] != null ? state.claims[roomName] : state.startTick);
            levelUps.push({ room: roomName, level: c.level, tick, sampleTick: sample.t, wall, sinceStart: tick - state.startTick, sincePrev: tick - since, reup,
                creeps: sample.creeps.length, roles, structs: rr.n, remotes: [...remoteRooms].sort(), ownedRooms: owned.length, gclLevel: gclLevel(sample.gcl) });
        } else if (c.level === last.level) gained = Math.max(0, c.progress - last.progress);
        else {
            // 控制器降级：进度会被引擎重置，本区间不计升级；记事件供报告列出
            if (!state.downgrades) state.downgrades = [];
            state.downgrades.push({ room: roomName, from: last.level, to: c.level, tick: sample.t, sinceStart: sample.t - state.startTick, progressBefore: last.progress });
            if (!state.pendingDowngrades) state.pendingDowngrades = [];
            state.pendingDowngrades.push(state.downgrades[state.downgrades.length - 1]);
        }
        acc.upgradeByRoom[roomName] = (acc.upgradeByRoom[roomName] || 0) + gained;
        state.roomLast[roomName] = { level: c.level, progress: c.progress, t: sample.t };
    }
    for (const roomName in state.roomLast) if (!ownedSet.has(roomName) && state.lost[roomName] == null) { state.lost[roomName] = sample.t; delete state.roomLast[roomName]; }
    // 母房源状态：满且未启动再生 = 闲置
    const homeSources = sample.sources.filter((s) => s[0] === primary).map((s) => ({ x: s[1], y: s[2], energy: s[3], regenAt: s[5], cap: s[6] }));
    const idleSources = homeSources.filter((s) => s.energy >= s.cap && !s.regenAt).length;
    const homeRoom = sample.rooms[primary] || { n: {}, e: {} };
    const ctrl = (sample.owned && sample.owned[primary]) || sample.ctrl || { level: 0, progress: 0 };
    const record = {
        t: sample.t, wall, dt: state.lastT == null ? 0 : sample.t - state.lastT, dwall: state.lastWall == null ? 0 : wall - state.lastWall,
        rcl: ctrl.level, prog: ctrl.progress, progTotal: CONTROLLER_LEVELS[ctrl.level] || 0,
        downgradeIn: ctrl.downgradeTime ? ctrl.downgradeTime - sample.t : null, safe: ctrl.safeMode > sample.t ? ctrl.safeMode - sample.t : 0,
        gcl: sample.gcl, gclLevel: gclLevel(sample.gcl), owned: ownedInfo, ownedN: owned.length, claims: Object.assign({}, state.claims), spawnBuilt: Object.assign({}, state.spawnBuilt), lost: Object.assign({}, state.lost),
        downgrades: (state.downgrades || []).length,
        acc: { harvest: acc.harvest, harvestHome: acc.harvestHome, harvestRemote: acc.harvestRemote, upgrade: acc.upgrade, spawn: acc.spawn, parts: acc.parts, creeps: acc.creeps,
            build: acc.build, buildHome: acc.buildHome, buildLost: acc.buildLost, residual,
            spawnByRole: Object.assign({}, acc.spawnByRole), spawnByHome: Object.assign({}, acc.spawnByHome), spawnByRemote: Object.assign({}, acc.spawnByRemote || {}), buildByType: Object.assign({}, acc.buildByType),
            harvestByRoom: Object.assign({}, acc.harvestByRoom), upgradeByRoom: Object.assign({}, acc.upgradeByRoom) },
        stock, creeps: sample.creeps.length, spawning: sample.spawning, roles, haulerTasks, feeders,
        homeStructs: homeRoom.n, homeSources, idleSources, sitesN: sample.sites.length, sitesCompleted: completed, sitesRemoved: removed,
        hostiles: sample.hostiles, cores: sample.cores,
        remoteRooms: [...remoteRooms].sort(),
        reservations: Object.keys(sample.rooms).filter((r) => sample.rooms[r].ctrl).map((r) => [r, sample.rooms[r].ctrl.res ? sample.rooms[r].ctrl.res - sample.t : 0, sample.rooms[r].ctrl.user]),
    };
    if (mem) {
        const rm = (mem.rooms && mem.rooms[primary]) || {};
        record.cpu = mem.stat ? mem.stat.cpu : null;
        record.bucket = mem.stat ? mem.stat.bucket : null;
        record.errN = mem.errN;
        record.lastErr = mem.lastErr;
        record.state = rm.state || null;
        record.queue = rm.queue || null;
        record.remotes = rm.remotes || [];
        record.planVer = rm.planVer || null;
        record.planError = rm.planError || null;
        record.targets = rm.targets || null;
        record.expansion = rm.expansion || null;
        record.roomsMem = mem.rooms || {};
        record.brain = mem.brain;
        record.memBytes = mem.memBytes;
        record.mapN = mem.mapN;
        /* 运输饱和度遥测（src/haul_stats.js 的累计计数，母房 × 角色）：A/B 取两次采样的差分 */
        record.haul = mem.haul || null;
    }
    for (const level of levelUps) {
        level.acc = JSON.parse(JSON.stringify(record.acc));
        level.stock = stock.total;
        level.cpu = record.cpu;
        state.levels.push(level);
        if (level.room === primary) record.levelUp = level;
    }
    if (levelUps.length) record.levelUps = levelUps;
    if (state.pendingDowngrades && state.pendingDowngrades.length) { record.downgradeEvents = state.pendingDowngrades; state.pendingDowngrades = []; }
    state.lastRcl = ctrl.level;
    state.lastProg = ctrl.progress;
    state.lastT = sample.t;
    state.lastWall = wall;
    state.samples++;
    state.baseline = false;
    return record;
}

/** 本次跑该用哪个大脑脚本：优先 --src-rev 导出的副本（run.json 的 brainScript 记下来，续跑时不换），否则工作树。
 *  导出副本里 run.py 的 ROOT 变成导出目录，.env 不存在也没关系——私服路径的 token 由 --token 传入。 */
function brainScriptPath(outDir) {
    const pinned = path.join(outDir, 'src-export', 'scripts', 'brain', 'run.py');
    return fs.existsSync(pinned) ? pinned : null;
}

function runBrain(port, username, token, args, outDir, scriptPath) {
    fs.mkdirSync(outDir, { recursive: true });
    const locksPath = path.join(outDir, 'locks.json');
    if (args.lockClaim && !fs.existsSync(locksPath)) {
        fs.writeFileSync(locksPath, JSON.stringify({ [args.home + '.claim']: { value: null, until: Date.now() + 365 * 24 * 3600 * 1000, by: 'rcl_benchmark',
            reason: 'single-room RCL benchmark: never claim, only assign remotes' } }, null, 1));
    }
    const script = scriptPath || path.join(ROOT, 'scripts', 'brain', 'run.py');
    // --homes 留空 = 与线上 launchd 一样从 Memory.rooms（有 plan 的房）推断母房，新占的房建成方案后自动纳入
    const cmd = [script, '--server', 'private', '--base-url', `http://127.0.0.1:${port}`, '--username', username, '--token', token,
        '--radius', '2', '--write', '--min-interval', '0', '--out', outDir];
    if (args.brainHomes) cmd.push('--homes', args.brainHomes);
    for (const extra of args.brainArgs || []) cmd.push(extra);
    const output = execFileSync('python3', cmd, { cwd: ROOT, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(output.trim().split('\n').pop());
}

const PROBE = 'typeof soakProbe==="function"?soakProbe():(Memory._soak={missing:true},0)';

/** 把世界当前的 db.json 复制到输出目录（能 JSON.parse 才算成功；lokijs 每 5 s 自动存档，快照最多落后 5 s）。供 --fork-db 从历史 tick 分叉。 */
async function snapshotWorld(worldDir, outDir, tick) {
    const dir = path.join(outDir, 'world-snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `db-${tick}.json`);
    for (let attempt = 0; attempt < 5; attempt++) {
        fs.copyFileSync(path.join(worldDir, 'db.json'), target);
        try { JSON.parse(fs.readFileSync(target, 'utf8')); return target; } catch (error) { await sleep(1500); }
    }
    fs.rmSync(target, { force: true });
    throw new Error('world snapshot never parsed');
}

function appendLine(file, obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function main(argv) {
    loadProjectEnv();
    const args = parseArgs(argv);
    fs.mkdirSync(args.out, { recursive: true });
    const files = {
        run: path.join(args.out, 'run.json'), state: path.join(args.out, 'state.json'), progress: path.join(args.out, 'progress.jsonl'),
        levels: path.join(args.out, 'levels.json'), samples: path.join(args.out, 'samples.jsonl'), events: path.join(args.out, 'events.jsonl'),
        brain: path.join(args.out, 'brain'),
    };
    await validation.waitForLeftoverServers(90000);
    const serverDir = resolveServerDir();
    let run, state;
    if (args.resume) {
        run = JSON.parse(fs.readFileSync(files.run, 'utf8'));
        state = migrateState(JSON.parse(fs.readFileSync(files.state, 'utf8')));
        state.migrateNames = true;
        appendLine(files.events, { event: 'resume', wall: Date.now(), samples: state.samples });
    } else if (args.forkWorld) {
        // 分叉：拷贝现有世界、换 bot 代码（bots.reload 把新代码写进 users.code），账本从分叉点归零起算
        const version = Date.now();
        const exported = args.srcRev ? exportSources(args.srcRev, path.join(args.out, 'src-export')) : null;
        const worldDir = await forkWorld(path.resolve(args.forkWorld), version, exported ? exported.srcRoot : null, { dbFile: args.forkDb });
        const seedServer = new PrivateServer({ serverDir, worldDir, runnersCnt: 0, runnerThreads: 1 });
        const seedCli = await seedServer.start();
        let info;
        try {
            await validation.waitForHttpReady(seedServer.gamePort, 30000);
            await sleep(1000);
            await seedCli.run('system.pauseSimulation()', { timeoutMs: 8000 });
            const reloaded = await seedCli.run("bots.reload('project')", { timeoutMs: 30000 });
            const userId = await validation.getUserId(seedCli, args.username);
            if (!userId) throw new Error('forked world has no benchmark user');
            const gameTime = Number(await seedCli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
            const code = await seedCli.evaluateJson(`storage.db['users.code'].find({user:${literal(userId)}}).then(function(l){return l.map(function(c){return [c.branch,c.activeWorld,String(c.modules&&c.modules.version||'').replace(/\s+/g,' ').slice(0,60)]})})`);
            await validation.persistMarker(seedCli, worldDir, 'fork');
            info = { userId, gameTime, code, reloaded: String(reloaded).slice(0, 120) };
        } finally {
            await validation.stopServer(seedServer, seedCli);
        }
        run = { args, worldDir, userId: info.userId, username: args.username, version, srcRev: args.srcRev, srcCommit: exported ? exported.commit : null, brainScript: brainScriptPath(args.out),
            workTree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), forkedFrom: { worldDir: path.resolve(args.forkWorld), dbFile: args.forkDb || null, tick: info.gameTime },
            code: info.code, startTick: info.gameTime, startedAt: Date.now() };
        state = newState();
        state.startTick = info.gameTime;
        state.baseline = true;
        fs.writeFileSync(files.run, JSON.stringify(run, null, 1));
        fs.writeFileSync(files.state, JSON.stringify(state));
        console.log(JSON.stringify({ worldDir, forkedFrom: run.forkedFrom, out: args.out, userId: info.userId, srcCommit: run.srcCommit, code: info.code, reloaded: info.reloaded }));
    } else {
        const snapshot = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
        const version = Date.now();
        const exported = args.srcRev ? exportSources(args.srcRev, path.join(args.out, 'src-export')) : null;
        const world = createWorld({ serverDir, version, srcRoot: exported ? exported.srcRoot : null });
        // 换成基准 mod（自动存档 5 s 一次而不是 250 ms）
        const modsPath = path.join(world.worldDir, 'mods.json');
        const mods = JSON.parse(fs.readFileSync(modsPath, 'utf8'));
        mods.mods = [fs.realpathSync(path.join(ROOT, 'scripts', 'private_server', 'benchmark_mod.js'))];
        fs.writeFileSync(modsPath, JSON.stringify(mods, null, 2) + '\n');
        const seedServer = new PrivateServer({ serverDir, worldDir: world.worldDir, runnersCnt: 0, runnerThreads: 1 });
        const seedCli = await seedServer.start();
        let seeded;
        try {
            await validation.waitForHttpReady(seedServer.gamePort, 30000);
            await sleep(1000);
            await seedCli.run(`system.setTickDuration(${Math.max(1, Math.floor(args.tickDuration))})`, { timeoutMs: 10000 });
            seeded = await seedFresh(seedCli, snapshot, args);
            await validation.persistMarker(seedCli, world.worldDir, 'bench');
        } finally {
            await validation.stopServer(seedServer, seedCli);
        }
        run = { args, worldDir: world.worldDir, userId: seeded.userId, username: args.username, version, srcRev: args.srcRev, srcCommit: exported ? exported.commit : null, brainScript: brainScriptPath(args.out),
            workTree: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), seeded: seeded.neutral, spawn: seeded.spawn,
            startTick: seeded.gameTime, startedAt: Date.now(), rooms: Object.keys(snapshot.rooms).length };
        state = newState();
        state.startTick = seeded.gameTime;
        fs.writeFileSync(files.run, JSON.stringify(run, null, 1));
        fs.writeFileSync(files.state, JSON.stringify(state));
        console.log(JSON.stringify({ worldDir: world.worldDir, out: args.out, userId: seeded.userId, seeded: seeded.neutral, removedRooms: seeded.removedRooms, spawn: seeded.spawn, srcCommit: run.srcCommit, gcl: args.gcl }));
    }

    let server = null, cli = null, token = null;
    const startServer = async () => {
        server = new PrivateServer({ serverDir, worldDir: run.worldDir, runnersCnt: 1, runnerThreads: 1, processorsCnt: args.processors });
        cli = await server.start();
        await validation.waitForHttpReady(server.gamePort, 30000);
        await sleep(500);
        await cli.run(`system.setTickDuration(${Math.max(1, Math.floor(args.tickDuration))})`, { timeoutMs: 10000 });
        await cli.run('system.resumeSimulation()', { timeoutMs: 10000 });
        token = await validation.mintAuthToken(cli, run.userId);
        run.launcherPid = server.child && server.child.pid;
        run.ports = { gamePort: server.gamePort, cliPort: server.cliPort };
        fs.writeFileSync(files.run, JSON.stringify(run, null, 1));
    };
    const shutdown = async () => { if (server) { const s = server, c = cli; server = null; cli = null; await validation.stopServer(s, c); } };
    let stopping = false;
    const onSignal = (signal) => {
        if (stopping) return;
        stopping = true;
        appendLine(files.events, { event: 'signal', signal, wall: Date.now() });
        shutdown().then(() => process.exit(130));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    await startServer();
    const wallDeadline = run.startedAt + args.maxHours * 3600 * 1000;
    const end = run.startTick + args.ticks;
    const saveState = () => {
        fs.writeFileSync(files.state, JSON.stringify(state));
        fs.writeFileSync(files.levels, JSON.stringify(state.levels, null, 1));
    };
    let last = state.lastT == null ? run.startTick : state.lastT;
    let nextSample = last + args.sample;
    let nextProbe = args.probeEvery > 0 ? Math.max(run.startTick + 5, last + 5) : Infinity;
    let nextBrain = args.brainEvery > 0 ? Math.max(run.startTick + 60, last + 60) : Infinity;
    let nextPrint = last + 1000;
    let nextSnapshot = args.snapshotEvery > 0 ? last + args.snapshotEvery : Infinity;
    let failures = 0;
    let reached = false;
    try {
        while (!stopping && last < end && Date.now() < wallDeadline) {
            const target = Math.min(nextSample, nextProbe, nextBrain, nextSnapshot, end);
            let sample, mem;
            try {
                await validation.waitForGameTime(cli, target, 180000);
                sample = await cli.evaluateJson(`(${AGGREGATE})(${literal(run.userId)},${literal(args.home)})`, { timeoutMs: 60000 });
                mem = await cli.evaluateJson(`(${MEMORY})(${literal(run.userId)})`, { timeoutMs: 60000 });
                failures = 0;
            } catch (error) {
                failures++;
                const message = String(error && error.message).slice(0, 200);
                process.stdout.write(`t=${last} failure ${failures}: ${message}\n`);
                appendLine(files.events, { event: 'failure', t: last, wall: Date.now(), failures, message });
                if (failures >= 2) {
                    // storage 偶发 RPC 异常会带走 CLI（soak 见过 lokijs "fun is not a function"）：整组重启，db.json 每 5 s 自动落盘
                    await shutdown();
                    await sleep(3000);
                    await startServer();
                    state.restarts++;
                    appendLine(files.events, { event: 'restart', t: last, wall: Date.now(), restarts: state.restarts });
                    failures = 0;
                } else await sleep(5000);
                continue;
            }
            if (!sample || !sample.owned) { appendLine(files.events, { event: 'no-sample', t: last, wall: Date.now() }); await sleep(2000); continue; }
            last = sample.t;
            if (last >= nextSample || last >= end) {
                const record = account(state, sample, mem, args);
                appendLine(files.progress, record);
                for (const l of record.levelUps || []) {
                    process.stdout.write(`RCL${l.level} ${l.room} at tick ${l.sinceStart} (+${l.sincePrev} ticks) cp=${l.acc.upgrade} harvest=${l.acc.harvest} spawn=${l.acc.spawn} build=${l.acc.build} creeps=${l.creeps} rooms=${l.ownedRooms} gcl=${l.gclLevel}\n`);
                    appendLine(files.events, Object.assign({ event: 'levelUp', wall: Date.now() }, l));
                }
                for (const d of record.downgradeEvents || []) {
                    process.stdout.write(`DOWNGRADE ${d.room} RCL${d.from}->${d.to} at tick ${d.sinceStart} (progress ${d.progressBefore} lost)\n`);
                    appendLine(files.events, Object.assign({ event: 'downgrade', wall: Date.now() }, d));
                }
                for (const roomName in record.claims) {
                    if (state.claimsLogged[roomName]) continue;
                    state.claimsLogged[roomName] = true;
                    process.stdout.write(`CLAIM ${roomName} at tick ${record.claims[roomName] - run.startTick} rooms=${record.ownedN}\n`);
                    appendLine(files.events, { event: 'claim', room: roomName, t: record.claims[roomName], sinceStart: record.claims[roomName] - run.startTick, wall: Date.now() });
                }
                if (last >= nextPrint) {
                    const rate = record.dwall > 0 ? (record.dt / (record.dwall / 1000)).toFixed(1) : '?';
                    const rooms = Object.entries(record.owned).map(([n, o]) => `${n}:rcl${o.rcl}`).join(',');
                    process.stdout.write(`t=${last - run.startTick} ${rooms} ${record.prog}/${record.progTotal} cp=${record.acc.upgrade} gclL=${record.gclLevel} harvest=${record.acc.harvest}(${record.acc.harvestRemote}) spawn=${record.acc.spawn} build=${record.acc.build} stock=${record.stock.total} creeps=${record.creeps} remotes=${record.remoteRooms.length} cpu=${record.cpu} err=${record.errN} ${rate}t/s\n`);
                    nextPrint = last + 1000;
                }
                saveState();
                nextSample = last + args.sample;
                if (record.rcl >= args.untilRcl) { reached = true; break; }
            }
            if (last >= nextSnapshot) {
                try {
                    const file = await snapshotWorld(run.worldDir, args.out, last - run.startTick);
                    appendLine(files.events, { event: 'snapshot', t: last, sinceStart: last - run.startTick, wall: Date.now(), file });
                } catch (error) {
                    appendLine(files.events, { event: 'snapshot-failure', t: last, wall: Date.now(), message: String(error && error.message).slice(0, 200) });
                }
                nextSnapshot = last + args.snapshotEvery;
            }
            if (last >= nextProbe) {
                try {
                    await validation.httpJson('POST', server.gamePort, '/api/user/console', { expression: PROBE }, { 'X-Username': runUsername(run), 'X-Token': token });
                    await validation.waitForGameTime(cli, last + 3, 60000);
                    const memory = await validation.readUserMemory(server.gamePort, runUsername(run), token);
                    if (memory && memory._soak) appendLine(files.samples, memory._soak);
                } catch (error) {
                    appendLine(files.events, { event: 'probe-failure', t: last, wall: Date.now(), message: String(error && error.message).slice(0, 200) });
                }
                nextProbe = last + args.probeEvery;
            }
            if (last >= nextBrain) {
                const startedAt = Date.now();
                try {
                    const result = runBrain(server.gamePort, runUsername(run), token, args, files.brain, run.brainScript || null);
                    state.brainRuns++;
                    appendLine(path.join(files.brain, 'runs.jsonl'), { t: last, wall: startedAt, ms: Date.now() - startedAt, result });
                } catch (error) {
                    appendLine(files.events, { event: 'brain-failure', t: last, wall: Date.now(), message: String(error && (error.stderr || error.message)).slice(0, 400) });
                }
                nextBrain = last + args.brainEvery;
            }
        }
        let root = null;
        try { root = await validation.readRootMemory(cli, run.userId); } catch (error) { process.stdout.write(`final memory unavailable: ${String(error && error.message).slice(0, 120)}\n`); }
        fs.writeFileSync(path.join(args.out, 'final_memory.json'), JSON.stringify(root));
        saveState();
        run.finishedAt = Date.now();
        run.reached = reached;
        run.lastTick = last;
        fs.writeFileSync(files.run, JSON.stringify(run, null, 1));
        console.log(JSON.stringify({ ok: true, reached, ticks: last - run.startTick, levels: state.levels.map((l) => [l.room, l.level, l.sinceStart]), claims: state.claims, restarts: state.restarts, brainRuns: state.brainRuns,
            hours: ((Date.now() - run.startedAt) / 3600000).toFixed(2), keepRunning: args.keepRunning, ports: args.keepRunning ? run.ports : undefined }));
    } finally {
        if (!args.keepRunning) await shutdown();
    }
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}

module.exports = { main, parseArgs, runUsername, neutralDocument, account, newState, migrateState, bodyCost, bodyParts, oneLine, aggregateSource, memorySource, gclLevel, forkWorld, snapshotWorld, brainScriptPath, CONTROLLER_LEVELS };
