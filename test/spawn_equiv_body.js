const spawnMod = process.env.VERSION === 'old' ? require('spawn_old') : require('spawn');
const crypto = require('crypto');
const out = [];
let seed = Number(process.env.SEED || 7);
function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
const TICKS = Number(process.env.TICKS || 600);
resetWorld(50000);
if (process.env.VERSION !== 'old') utils.setCreepIndexRecount(false);
Game.cpu = { getUsed: () => 0, limit: 160, bucket: 10000, tickLimit: 500 };
const ROLE_BODY = {
    harvester: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move'],
    hauler: ['carry', 'carry', 'carry', 'carry', 'move', 'move'],
    upgrader: ['work', 'work', 'work', 'carry', 'move', 'move'],
    builder: ['work', 'work', 'carry', 'carry', 'move', 'move'],
    labTech: ['carry', 'carry', 'move'],
    mineralMiner: ['work', 'work', 'carry', 'move'],
    operator: ['carry', 'carry', 'carry', 'carry', 'move'],
};
const rooms = [];
function build(name, rcl, cap, nSpawns, storageE, crew, extra = {}) {
    const room = makeRoom(name, { rcl, energy: cap, cap, ctrl: { x: 22, y: 31 } });
    room._sources = [makeSource(room, 14, 6, name + 's0'), makeSource(room, 31, 12, name + 's1')];
    room._mineral = { id: name + 'm', mineralType: 'H', mineralAmount: 50000, pos: new RoomPosition(40, 40, name), room };
    world.byId[room._mineral.id] = room._mineral;
    const spawns = [];
    for (let i = 0; i < nSpawns; i++) spawns.push(makeSpawn(room, 23 + i * 2, 21));
    if (storageE != null) makeStructure(room, C.STRUCTURE_STORAGE, 25, 25, { energy: storageE, capacity: 1000000 });
    if (extra.terminal) makeStructure(room, C.STRUCTURE_TERMINAL, 27, 25, { energy: 20000, capacity: 300000 });
    if (extra.labs) for (let i = 0; i < extra.labs; i++) makeStructure(room, C.STRUCTURE_LAB, 30 + i, 30, { energy: 2000, capacity: 5000 });
    if (extra.towers) for (let i = 0; i < extra.towers; i++) makeStructure(room, C.STRUCTURE_TOWER, 20 + i, 28, { store: mkStore(800, 1000) });
    if (extra.extractor) makeStructure(room, C.STRUCTURE_EXTRACTOR, 40, 40);
    if (extra.sites) for (let i = 0; i < extra.sites; i++) room.createConstructionSite(10 + i, 40, C.STRUCTURE_EXTENSION);
    if (extra.damaged) for (let i = 0; i < extra.damaged; i++) makeStructure(room, C.STRUCTURE_ROAD, 5 + i, 45, { hits: 100, hitsMax: 5000 });
    Memory.rooms[name] = { sources: [name + 's0', name + 's1'], plan: { sourceIds: [name + 's0', name + 's1'], containers: {}, roads: {}, links: {} } };
    let k = 0;
    for (const [role, n] of Object.entries(crew)) {
        for (let i = 0; i < n; i++) {
            const cname = name + '_' + role + '_' + (k++);
            const mem = { home: name, role };
            if (role === 'harvester') { mem.sourceIdx = i % 2; mem.sourceId = name + 's' + (i % 2); }
            const c = makeCreep(room, cname, ROLE_BODY[role] || ['carry', 'move'], mem, { ticksToLive: 50 + Math.floor(rnd() * 1450) });
            world.creeps[cname] = c;
            Memory.creeps[cname] = c.memory;
        }
    }
    rooms.push({ room, spawns, cap });
    return room;
}
build('W31S4', 3, 800, 1, null, { harvester: 2, hauler: 1, upgrader: 2, builder: 1 }, { sites: 3 });
build('W33S7', 6, 2300, 1, 60000, { harvester: 2, hauler: 2, upgrader: 2 }, { towers: 2, damaged: 2 });
build('W37S5', 7, 5600, 2, 140000, { harvester: 2, hauler: 2, upgrader: 1, builder: 1, labTech: 1 }, { terminal: true, labs: 6, towers: 3, sites: 2, extractor: true });
build('W33S3', 8, 12900, 3, 400000, { harvester: 2, hauler: 2, upgrader: 1, labTech: 1, mineralMiner: 1, operator: 1 }, { terminal: true, labs: 10, towers: 6, extractor: true });
build('W38S7', 8, 12900, 3, 4000, { harvester: 1, hauler: 1, upgrader: 1 }, { terminal: true, labs: 3, towers: 3 });

const busy = {};
let calls = [];
for (const r of rooms) for (const s of r.spawns) {
    s.spawnCreep = function (body, name, o) {
        if (busy[s.id] > world.time) return C.ERR_BUSY;
        const cost = costOf(body);
        if (cost > s.room.energyAvailable) return C.ERR_NOT_ENOUGH_ENERGY;
        s.room.energyAvailable -= cost;
        calls.push({ spawn: s.id, body: body.join(','), name, memory: o && o.memory });
        return C.OK;
    };
}
function relink() {
    for (const c of Object.values(world.creeps)) {
        if (!Memory.creeps[c.name]) Memory.creeps[c.name] = c.memory;
        c.memory = Memory.creeps[c.name];
    }
}
const STRIP = new Set(process.env.STRICT ? [] : ['criticalRepair', 'outOfReachRepair']);
function canon(v) { return JSON.stringify(v, (k, x) => (STRIP.has(k) && x && typeof x === 'object' ? Object.assign({}, x, { n: undefined }) : x)); }
function runAll(mod) {
    calls = [];
    for (const r of rooms) { try { mod.run(r.room); } catch (e) { calls.push({ error: String(e && e.stack || e).slice(0, 300) }); } }
    return calls;
}
let mism = 0, spawned = 0, ticksWithSpawn = 0, firstDiff = null;
for (let t = 0; t < TICKS; t++) {
    world.time++;
    for (const r of rooms) {
        r.room.energyAvailable = Math.min(r.cap, r.room.energyAvailable + Math.floor(rnd() * r.cap * 0.08));
        if (r.room.storage) r.room.storage.store.energy = Math.max(0, r.room.storage.store.energy + Math.floor((rnd() - 0.5) * 4000));
        for (const s of r.spawns) {
            if (busy[s.id] && busy[s.id] <= world.time) { s.spawning = null; delete busy[s.id]; }
        }
        if (rnd() < 0.01) r.room.createConstructionSite(5 + Math.floor(rnd() * 40), 47, C.STRUCTURE_ROAD);
        if (rnd() < 0.02 && r.room._sites.length) r.room._sites[0].remove();
        r.room._hostiles = (t % 200 > 150 && r.room.name === 'W33S7') ? [makeHostile(r.room, 10, 10, ['attack', 'move'])] : [];
    }
    for (const c of Object.values(world.creeps)) {
        if (c.spawning && c._readyAt <= world.time) c.spawning = false;
        if (!c.spawning) c.ticksToLive--;
        if (c.ticksToLive <= 0) { delete world.creeps[c.name]; delete Memory.creeps[c.name]; }
    }
    const a = { calls: runAll(spawnMod).map((x) => canon(x)) };
    const h = crypto.createHash('md5').update(canon(Memory.rooms) + canon(Memory.creeps) + canon(rooms.map((r) => r.room.energyAvailable))).digest('hex');
    out.push(world.time + ' ' + h + ' ' + a.calls.join(' | '));
    if (process.env.DUMP && Number(process.env.DUMP) === world.time) fs.writeFileSync('/tmp/equiv_dump_' + process.env.VERSION + '.json', JSON.stringify({ rooms: Memory.rooms, creeps: Memory.creeps }, null, 1));
    for (const raw of a.calls) {
        const x = JSON.parse(raw);
        if (!x.spawn) continue;
        const s = world.byId[x.spawn];
        const body = x.body.split(',');
        const c = makeCreep(s.room, x.name, body, x.memory);
        c.spawning = true;
        c._readyAt = world.time + body.length * 3;
        world.creeps[x.name] = c;
        Memory.creeps[x.name] = c.memory;
        busy[s.id] = world.time + body.length * 3;
        s.spawning = { name: x.name, remainingTime: body.length * 3 };
        spawned++;
    }
    if (a.calls.some((x) => x.includes('"spawn"'))) ticksWithSpawn++;
}
fs.writeFileSync(process.env.OUT || '/tmp/equiv_' + (process.env.VERSION || 'new') + '.txt', out.join('\n'));
console.log(JSON.stringify({ version: process.env.VERSION, ticks: TICKS, spawned, ticksWithSpawn, creeps: Object.keys(world.creeps).length, errors: out.filter((l) => l.includes('error')).length }));
