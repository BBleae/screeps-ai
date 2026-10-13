#!/usr/bin/env node
'use strict';
/**
 * 私服 soak 模拟：把线上快照（真实地形 + 真实建筑 + Memory 的 plan/外矿/大脑白名单）搬进私服，
 * 高速跑 N tick，每 sample tick 采一次全量快照写 JSONL，供 analyze.py 用不变量规则找问题。
 *
 * 用法：node scripts/soak/soak.js [--snapshot data/soak/live_snapshot.json] [--ticks 3000] [--sample 25]
 *        [--tick-duration 5] [--invader-every 900] [--out data/soak/run-<时间>] [--keep-running]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { PrivateServer, createWorld, resolveServerDir, sleep } = require('../private_server/server_process');
const { loadProjectEnv } = require('../private_server/env');
const fixtures = require('../private_server/fixtures');
const validation = require('../private_server/run_validation');

const NEUTRAL_TYPES = new Set(['container', 'road', 'constructedWall']);
const USERNAME = 'SoakBBleae';

function parseArgs(argv) {
    const out = { snapshot: path.join(ROOT, 'data', 'soak', 'live_snapshot.json'), ticks: 3000, sample: 25, tickDuration: 5,
        invaderEvery: 900, out: null, keepRunning: false, homes: ['W33S7', 'W34S7'] };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--snapshot') { out.snapshot = value; i++; }
        else if (key === '--ticks') { out.ticks = Number(value); i++; }
        else if (key === '--sample') { out.sample = Number(value); i++; }
        else if (key === '--tick-duration') { out.tickDuration = Number(value); i++; }
        else if (key === '--invader-every') { out.invaderEvery = Number(value); i++; }
        else if (key === '--out') { out.out = value; i++; }
        else if (key === '--homes') { out.homes = value.split(',').filter(Boolean); i++; }
        else if (key === '--keep-running') out.keepRunning = true;
    }
    if (!out.out) out.out = path.join(ROOT, 'data', 'soak', 'run-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    return out;
}

const literal = fixtures.literal;

async function insertRoom(cli, roomName, terrain) {
    await cli.evaluateJson(`storage.db.rooms.insert(${literal({ _id: roomName, status: 'normal', active: true })}).then(function(){return true})`);
    await cli.evaluateJson(`storage.db['rooms.terrain'].insert(${literal({ room: roomName, terrain, type: 'terrain' })}).then(function(){return true})`);
}

function objectDocument(roomName, obj, userId, gameTime) {
    const doc = { type: obj.type, room: roomName, x: obj.x, y: obj.y };
    switch (obj.type) {
    case 'source':
        // 源按满能量播种：快照里的剩余能量只是抓取瞬间的值，照搬会让前 300 tick 出现"矿被挖空、全房零收入"的假象
        Object.assign(doc, { energy: obj.energyCapacity || 3000, energyCapacity: obj.energyCapacity || 3000, ticksToRegeneration: 300 });
        break;
    case 'mineral':
        Object.assign(doc, { mineralType: obj.mineralType || 'H', mineralAmount: obj.mineralAmount || 70000, density: obj.density || 3 });
        break;
    case 'controller':
        Object.assign(doc, { level: 0, progress: 0 });
        break;
    case 'constructedWall':
        Object.assign(doc, { hits: obj.hits || 1, hitsMax: 300000000 });
        break;
    case 'road':
        Object.assign(doc, { hits: obj.hits || 5000, hitsMax: obj.hitsMax || 5000, nextDecayTime: gameTime + 1000 });
        break;
    case 'container':
        Object.assign(doc, { hits: obj.hits || 250000, hitsMax: 250000, store: { energy: Number(obj.store && obj.store.energy || 0) },
            storeCapacity: 2000, nextDecayTime: gameTime + 500 });
        break;
    case 'rampart':
        Object.assign(doc, { user: userId, hits: obj.hits || 1000, hitsMax: 300000000, isPublic: false, nextDecayTime: gameTime + 100 });
        break;
    case 'spawn':
        Object.assign(doc, { user: userId, name: obj.name || ('Spawn_' + roomName), hits: 5000, hitsMax: 5000, store: { energy: 300 },
            storeCapacityResource: { energy: 300 }, spawning: null, notifyWhenAttacked: false });
        break;
    case 'extension':
        Object.assign(doc, { user: userId, hits: 1000, hitsMax: 1000, store: { energy: 50 }, storeCapacityResource: { energy: 50 }, notifyWhenAttacked: false });
        break;
    case 'tower':
        Object.assign(doc, { user: userId, hits: 3000, hitsMax: 3000, store: { energy: 500 }, storeCapacityResource: { energy: 1000 }, notifyWhenAttacked: false });
        break;
    case 'link':
        Object.assign(doc, { user: userId, hits: obj.hits == null ? 1000 : obj.hits, hitsMax: 1000,
            store: { energy: Number(obj.store && obj.store.energy || 0) }, storeCapacityResource: { energy: 800 },
            cooldown: Math.max(0, Number(obj.cooldown) || 0), notifyWhenAttacked: false });
        break;
    case 'storage':
        Object.assign(doc, { user: userId, hits: 10000, hitsMax: 10000, store: { energy: Number(obj.store && obj.store.energy || 0) }, storeCapacity: 1000000, notifyWhenAttacked: false });
        break;
    case 'constructionSite':
        Object.assign(doc, { user: userId, structureType: obj.structureType, progress: obj.progress || 0, progressTotal: obj.progressTotal || 1 });
        break;
    default:
        return null;
    }
    return doc;
}

function snapshotReservation(controller, snapshot, userId, gameTime) {
    const reservation = controller && controller.reservation;
    if (!reservation || reservation.user !== snapshot.me) return null;
    const remaining = Number(reservation.endTime) - Number(snapshot.tick);
    return remaining > 0 ? { user: userId, endTime: gameTime + remaining } : null;
}

async function seedFromSnapshot(cli, snapshot, homes) {
    await cli.run('system.pauseSimulation()', { timeoutMs: 8000 });
    const gameTime = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)')) || 1;
    const rooms = Object.keys(snapshot.rooms);
    for (const roomName of rooms) await insertRoom(cli, roomName, snapshot.rooms[roomName].terrain);
    await cli.evaluateJson('map.updateTerrainData()', { timeoutMs: 60000 });
    await fixtures.ensureTerrainNeighbors(cli);
    await cli.evaluateJson(
        `storage.db.rooms.find({status:'normal'}).then(function(rooms){var names=rooms.map(function(room){return room._id});return Promise.all([storage.env.set(storage.env.keys.ACCESSIBLE_ROOMS,JSON.stringify(names)),storage.env.set(storage.env.keys.ROOM_STATUS_DATA,JSON.stringify({novice:{},respawn:{},closed:{}}))]).then(function(){return names.length})})`,
        { timeoutMs: 30000 });
    // 先放 controller/source/mineral（bots.spawn 需要房间已存在），再用 bots.spawn 建用户
    for (const roomName of rooms) {
        for (const obj of snapshot.rooms[roomName].objects) {
            if (!['controller', 'source', 'mineral'].includes(obj.type)) continue;
            const doc = objectDocument(roomName, obj, null, gameTime);
            await cli.evaluateJson(`storage.db['rooms.objects'].insert(${literal(doc)}).then(function(){return true})`);
        }
    }
    const primary = homes[0];
    await cli.evaluateJson(
        `bots.spawn('project',${literal(primary)},{username:${literal(USERNAME)},cpu:140,gcl:12}).then(function(){return true})`,
        { timeoutMs: 30000 });
    const user = await cli.evaluateJson(`storage.db.users.findOne({username:${literal(USERNAME)}}).then(function(u){return {id:String(u._id)}})`);
    const userId = user.id;
    // bots.spawn 自己放的 spawn 去掉，按快照放我方建筑
    await cli.evaluateJson(`storage.db['rooms.objects'].removeWhere({type:'spawn',user:${literal(userId)}}).then(function(){return true})`);
    const inserted = {};
    for (const roomName of rooms) {
        const mine = homes.includes(roomName);
        inserted[roomName] = 0;
        for (const obj of snapshot.rooms[roomName].objects) {
            if (['controller', 'source', 'mineral', 'ruin', 'tombstone', 'energy', 'creep'].includes(obj.type)) continue;
            if (!mine && !NEUTRAL_TYPES.has(obj.type)) continue;
            const doc = objectDocument(roomName, obj, userId, gameTime);
            if (!doc) continue;
            await cli.evaluateJson(`storage.db['rooms.objects'].insert(${literal(doc)}).then(function(){return true})`);
            inserted[roomName]++;
        }
        const ctrl = snapshot.rooms[roomName].objects.find((o) => o.type === 'controller');
        if (mine && ctrl) {
            await cli.evaluateJson(`storage.db['rooms.objects'].update({room:${literal(roomName)},type:'controller'},{$set:${literal({
                user: userId, level: ctrl.level || 1, progress: ctrl.progress || 0, downgradeTime: gameTime + 100000,
                safeModeAvailable: ctrl.safeModeAvailable || 0 })}}).then(function(){return true})`);
        } else if (!mine && ctrl) {
            const reservation = snapshotReservation(ctrl, snapshot, userId, gameTime);
            if (reservation) await cli.evaluateJson(`storage.db['rooms.objects'].update({room:${literal(roomName)},type:'controller'},{$set:{reservation:${literal(reservation)}}}).then(function(){return true})`);
        }
    }
    // Memory：plan/外矿/大脑白名单（issuedAt 刷新、TTL 放到 7 天，让游戏内 brain 整个 soak 期间都认它）
    const memory = { rooms: {}, creeps: {}, roomPlanner: snapshot.memory.roomPlanner || {} };
    for (const roomName of homes) memory.rooms[roomName] = snapshot.memory.rooms[roomName] || {};
    // 线上的对象 id 在私服里不存在：按坐标把 plan.sourceIds / sources / 外矿源 id 重映射到新世界的 id，容器 id 清空让 bot 自己刷新
    const idByPos = {};
    const sourceRows = await cli.evaluateJson(`storage.db['rooms.objects'].find({type:'source'}).then(function(list){return list.map(function(o){return [o.room,o.x,o.y,String(o._id)]})})`);
    for (const [room, x, y, id] of sourceRows || []) idByPos[room + ':' + x + ',' + y] = id;
    const remap = (roomName, oldId) => {
        const source = (snapshot.rooms[roomName] || { objects: [] }).objects.find((o) => o.type === 'source' && (o._id === oldId || o.id === oldId));
        return source ? idByPos[roomName + ':' + source.x + ',' + source.y] : null;
    };
    for (const roomName of homes) {
        const mem = memory.rooms[roomName];
        delete mem.demolition; delete mem.layoutBlocked; delete mem.state; delete mem.demand; delete mem.defenseLog;
        const sources = (snapshot.rooms[roomName].objects || []).filter((o) => o.type === 'source')
            .sort((a, b) => String(a._id || '').localeCompare(String(b._id || '')));
        const newIds = sources.map((o) => idByPos[roomName + ':' + o.x + ',' + o.y]).filter(Boolean);
        if (mem.plan) mem.plan.sourceIds = newIds;
        mem.sources = newIds;
        for (const remoteName in mem.remotes || {}) {
            const record = mem.remotes[remoteName];
            for (const source of record.sources || []) {
                const newId = source.pos ? idByPos[remoteName + ':' + source.pos.x + ',' + source.pos.y] : null;
                if (newId) source.id = newId;
                source.containerId = null;
            }
        }
    }
    const brain = snapshot.memory.brain;
    if (brain) {
        memory.brain = Object.assign({}, brain, { issuedAt: Date.now(), ttlMs: 7 * 24 * 3600 * 1000 });
        delete memory.brain.ack;
    }
    await cli.evaluateJson(`storage.env.set(storage.env.keys.MEMORY+${literal(userId)},${literal(JSON.stringify(memory))}).then(function(){return true})`);
    return { userId, inserted, gameTime };
}

async function seedCreeps(cli, userId, snapshot, homes, gameTime) {
    // 每个母房：静态矿工 ×2（站在方案工位）、hauler ×2、upgrader ×2、builder ×1；能量按身体给满
    let n = 0;
    const memory = {};
    for (const roomName of homes) {
        const room = snapshot.rooms[roomName];
        const plan = (snapshot.memory.rooms[roomName] || {}).plan || {};
        const sources = room.objects.filter((o) => o.type === 'source');
        const cap = Math.min(1300, 300 + 50 * room.objects.filter((o) => o.type === 'extension').length);
        const spawn = room.objects.find((o) => o.type === 'spawn');
        // 刚占下、spawn 还是工地的新房（2026-09-06 线上 W31S6/W31S8）：不播种 creep，靠母房的开荒 pioneer（expansion.js 记忆里有目标）
        if (!spawn) continue;
        const near = (target, dx, dy) => ({ x: Math.max(1, Math.min(48, target.x + dx)), y: Math.max(1, Math.min(48, target.y + dy)) });
        const creeps = [];
        sources.forEach((source, index) => {
            const spot = (plan.containers && plan.containers['src' + index]) || near(source, 1, 1);
            const work = cap >= 550 ? 5 : 2;
            creeps.push({ name: `soak-h-${roomName}-${index}`, role: 'harvester', body: Array(work).fill('work').concat(['move']),
                pos: spot, memory: { sourceIdx: index, staticMiner: true } });
        });
        const haulerCarry = Math.max(2, Math.min(17, Math.floor(cap / 100)));
        for (let i = 0; i < 2; i++) {
            creeps.push({ name: `soak-ha-${roomName}-${i}`, role: 'hauler', body: Array(haulerCarry).fill('carry').concat(Array(Math.ceil(haulerCarry / 2)).fill('move')), pos: near(spawn, 2 + i, 1) });
            creeps.push({ name: `soak-u-${roomName}-${i}`, role: 'upgrader', body: Array(Math.max(1, Math.min(11, Math.floor(cap / 120)))).fill('work').concat(['carry', 'carry', 'move']), pos: near(spawn, -2 - i, 1) });
        }
        creeps.push({ name: `soak-b-${roomName}`, role: 'builder', body: ['work', 'work', 'work', 'carry', 'carry', 'carry', 'move', 'move', 'move'], pos: near(spawn, 0, 2) });
        for (const creep of creeps) {
            const body = creep.body.map((type) => ({ type, hits: 100 }));
            const carry = body.filter((p) => p.type === 'carry').length;
            const doc = { name: creep.name, type: 'creep', room: roomName, x: creep.pos.x, y: creep.pos.y, user: userId, body,
                hits: body.length * 100, hitsMax: body.length * 100, spawning: false, fatigue: 0, notifyWhenAttacked: false,
                store: { energy: 0 }, storeCapacity: carry * 50, ageTime: gameTime + 1500 };
            await cli.evaluateJson(`storage.db['rooms.objects'].insert(${literal(doc)}).then(function(){return true})`);
            memory[creep.name] = Object.assign({ home: roomName, role: creep.role }, creep.memory || {});
            n++;
        }
    }
    const raw = await cli.evaluateJson(`storage.env.get(storage.env.keys.MEMORY+${literal(userId)})`);
    const mem = raw ? JSON.parse(raw) : {};
    mem.creeps = Object.assign({}, mem.creeps || {}, memory);
    await cli.evaluateJson(`storage.env.set(storage.env.keys.MEMORY+${literal(userId)},${literal(JSON.stringify(mem))}).then(function(){return true})`);
    return n;
}

async function insertInvader(cli, roomName, gameTime, index) {
    const doc = { name: `soak-invader-${index}`, type: 'creep', room: roomName, x: 25, y: 25, user: '2',
        body: ['tough', 'tough', 'move', 'move', 'move', 'move', 'ranged_attack', 'attack', 'move'].map((type) => ({ type, hits: 100 })),
        hits: 900, hitsMax: 900, spawning: false, fatigue: 0, notifyWhenAttacked: false, store: {}, storeCapacity: 0, ageTime: gameTime + 1500 };
    await cli.evaluateJson(`storage.db['rooms.objects'].insert(${literal(doc)}).then(function(){return true})`);
}

const PROBE = 'typeof soakProbe==="function"?soakProbe():(Memory._soak={missing:true},0)';

async function main(argv) {
    loadProjectEnv();
    const args = parseArgs(argv);
    const snapshot = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
    fs.mkdirSync(args.out, { recursive: true });
    await validation.waitForLeftoverServers(90000);
    const serverDir = resolveServerDir();
    const worldDir = createWorld({ serverDir }).worldDir;
    console.log(JSON.stringify({ worldDir, out: args.out, ticks: args.ticks, sample: args.sample }));

    // 阶段一：播种（无 runner）
    const seedServer = new PrivateServer({ serverDir, worldDir, runnersCnt: 0, runnerThreads: 1 });
    const seedCli = await seedServer.start();
    let seeded;
    try {
        await validation.waitForHttpReady(seedServer.gamePort, 30000);
        await sleep(1000);
        await seedCli.run(`system.setTickDuration(${Math.max(1, Math.floor(args.tickDuration))})`, { timeoutMs: 10000 });
        seeded = await seedFromSnapshot(seedCli, snapshot, args.homes);
        const creeps = await seedCreeps(seedCli, seeded.userId, snapshot, args.homes, seeded.gameTime);
        console.log(JSON.stringify({ seeded: seeded.inserted, creeps, userId: seeded.userId }));
        await validation.persistMarker(seedCli, worldDir, 'soak');
    } finally {
        await validation.stopServer(seedServer, seedCli);
    }

    // 阶段二：跑
    const server = new PrivateServer({ serverDir, worldDir, runnersCnt: 1, runnerThreads: 1 });
    const cli = await server.start();
    const samplesPath = path.join(args.out, 'samples.jsonl');
    const samples = fs.createWriteStream(samplesPath, { flags: 'a' });
    let anomalies = 0;
    try {
        await validation.waitForHttpReady(server.gamePort, 30000);
        await sleep(500);
        await cli.run(`system.setTickDuration(${Math.max(1, Math.floor(args.tickDuration))})`, { timeoutMs: 10000 });
        await cli.run('system.resumeSimulation()', { timeoutMs: 10000 });
        const userId = await validation.getUserId(cli, USERNAME);
        const token = await validation.mintAuthToken(cli, userId);
        const start = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        const end = start + args.ticks;
        let nextSample = start + 5;
        let nextInvader = args.invaderEvery > 0 ? start + args.invaderEvery : Infinity;
        let invaders = 0;
        const remoteRooms = (snapshot.focus || Object.keys(snapshot.rooms)).filter((name) => !args.homes.includes(name));
        let lastTick = start;
        let cliFailures = 0;
        while (lastTick < end) {
            const target = Math.min(nextSample, nextInvader, end);
            try {
                await validation.waitForGameTime(cli, target, Math.max(60000, args.ticks * 200));
                lastTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
                cliFailures = 0;
            } catch (error) {
                // 私服 storage 偶发 RPC 异常会把 backend/CLI 连接一起带走（run-2k-b 在 t=1434 遇到 lokijs "fun is not a function"）：
                // 采样已经逐行落盘，连续失败就带着现有采样收尾，而不是丢掉整轮
                cliFailures++;
                process.stdout.write(`t=${lastTick} cli failure ${cliFailures}: ${String(error && error.message).slice(0, 120)}\n`);
                if (cliFailures >= 3) { process.stdout.write('CLI unrecoverable, finishing with the samples collected so far\n'); break; }
                await new Promise((resolve) => setTimeout(resolve, 5000));
                continue;
            }
            if (lastTick >= nextInvader && remoteRooms.length) {
                const roomName = remoteRooms[invaders % remoteRooms.length];
                await insertInvader(cli, roomName, lastTick, invaders++);
                samples.write(JSON.stringify({ event: 'invader', t: lastTick, room: roomName }) + '\n');
                nextInvader += args.invaderEvery;
            }
            if (lastTick >= nextSample) {
                const posted = await validation.httpJson('POST', server.gamePort, '/api/user/console', { expression: PROBE }, { 'X-Username': USERNAME, 'X-Token': token });
                await validation.waitForGameTime(cli, lastTick + 3, 60000);
                const memory = await validation.readUserMemory(server.gamePort, USERNAME, token);
                const sample = memory && memory._soak;
                if (!sample) {
                    process.stdout.write(`t=${lastTick} no sample: console=${JSON.stringify(posted).slice(0, 120)} memoryKeys=${Object.keys(memory || {}).join(',')} errs=${JSON.stringify((memory && memory.errors || []).slice(0, 1)).slice(0, 200)}\n`);
                }
                if (sample) {
                    samples.write(JSON.stringify(sample) + '\n');
                    if (sample.errN) anomalies++;
                    process.stdout.write(`t=${sample.t} cpu=${sample.cpu} err=${sample.errN} ` +
                        Object.entries(sample.rooms).filter(([, r]) => r.mine).map(([n, r]) => `${n}:rcl${r.rcl} ${r.e}/${r.cap} prog${r.prog}`).join(' ') + '\n');
                }
                nextSample = lastTick + args.sample;
            }
        }
        let root = null;
        try { root = await validation.readRootMemory(cli, userId); } catch (error) { process.stdout.write(`final memory unavailable: ${String(error && error.message).slice(0, 120)}\n`); }
        fs.writeFileSync(path.join(args.out, 'final_memory.json'), JSON.stringify(root));
        let notifications = [];
        try { notifications = await validation.readErrorNotifications(cli); } catch (error) { process.stdout.write(`notifications unavailable: ${String(error && error.message).slice(0, 120)}\n`); }
        fs.writeFileSync(path.join(args.out, 'notifications.json'), JSON.stringify(notifications));
        console.log(JSON.stringify({ ok: true, ticks: lastTick - start, samples: samplesPath, errorSamples: anomalies, notifications: (notifications || []).length,
            keepRunning: args.keepRunning, ports: args.keepRunning ? { gamePort: server.gamePort, cliPort: server.cliPort } : undefined }, null, 1));
    } finally {
        samples.end();
        if (!args.keepRunning) await validation.stopServer(server, cli);
    }
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
}

module.exports = { main, parseArgs, seedFromSnapshot, objectDocument, snapshotReservation };
