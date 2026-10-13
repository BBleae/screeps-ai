'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { loadProjectEnv } = require('./env');
const { PrivateServer, createWorld, resolveServerDir, sleep } = require('./server_process');
const { GENERATION, ROOMS, seedAllScenarios, generateWorld, waitForGeneratedRooms, reserveOrderedObserver, upgraderActualRouteObserver, storageUpgradeFeedObserver, repairPoolNeutralObserver,
    ROUTE_OBSERVER_MARK, FEED_OBSERVER_MARK, REPAIR_OBSERVER_MARK, UPGRADER_ROUTE } = require('./fixtures');
// 这个场景房故意不开可视化：用来观察 config.visuals 的门闸真的把渲染关掉了（生效断言 core.visualsGated）
const VISUALS_OFF_ROOM = ROOMS.blueprint;
const effects = require('./effects');
const baseline = require('./baseline');
const ROOT = path.join(__dirname, '..', '..');

const PERSISTENCE_TIMEOUT_MS = 30000;

function parseArgs(argv) {
    const out = {
        keepRunning: false,
        worldDir: null,
        seedDb: null,
        serverDir: null,
        tickDuration: 1,
        warmupTicks: 90,
        maxTicks: 900,
        effectTicks: 400,
        seedWaitMs: 1500,
        gamePort: null,
        cliPort: null,
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--keep-running') out.keepRunning = true;
        else if (arg === '--world-dir') out.worldDir = argv[++index];
        else if (arg === '--seed-db') out.seedDb = argv[++index];
        else if (arg === '--server-dir') out.serverDir = argv[++index];
        else if (arg === '--tick-duration') out.tickDuration = Number(argv[++index]);
        else if (arg === '--warmup-ticks') out.warmupTicks = Number(argv[++index]);
        else if (arg === '--max-ticks') out.maxTicks = Number(argv[++index]);
        else if (arg === '--effect-ticks') out.effectTicks = Number(argv[++index]);
        else if (arg === '--seed-wait-ms') out.seedWaitMs = Number(argv[++index]);
        else if (arg === '--game-port') out.gamePort = Number(argv[++index]);
        else if (arg === '--cli-port') out.cliPort = Number(argv[++index]);
        else if (arg === '--help' || arg === '-h') out.help = true;
        else throw new Error(`Unknown argument ${arg}`);
    }
    return out;
}

function usage() {
    return [
        'Usage: node scripts/private_server/run_validation.js [options]',
        '',
        'Options:',
        '  --keep-running        Leave the private server up for Steam client inspection',
        '  --world-dir PATH      Use an empty directory for this validation run',
        '  --seed-db PATH        Restore a paused scenario seed DB instead of generating/seeding',
        '  --server-dir PATH     Use a custom Screeps private server checkout',
        '  --tick-duration N     Set minimum tick duration in ms (default: 1)',
        '  --warmup-ticks N      Ticks to let the seeded world settle (default: 90)',
        '  --max-ticks N         Safety cap for validation wait (default: 900)',
        '  --effect-ticks N      Extra ticks after the base wait so change effects can show (default: 400)',
        '  --seed-wait-ms N      Milliseconds to wait before phase restart (default: 1500)',
        '  --game-port N         Pin the game HTTP port for Steam client inspection',
        '  --cli-port N          Pin the private server CLI port',
    ].join('\n');
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function httpJson(method, port, pathname, body, headers) {
    const payload = body == null ? null : JSON.stringify(body);
    const options = {
        hostname: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    };
    if (payload != null) options.headers['Content-Length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                try {
                    resolve(text ? JSON.parse(text) : {});
                } catch (error) {
                    reject(new Error(`Invalid JSON from ${method} ${pathname}: ${text}`));
                }
            });
        });
        req.on('error', reject);
        if (payload != null) req.write(payload);
        req.end();
    });
}

function decodeMemoryPayload(payload) {
    if (payload == null) return null;
    if (typeof payload !== 'string') return payload;
    if (payload.startsWith('gz:')) {
        return JSON.parse(zlib.unzipSync(Buffer.from(payload.slice(3), 'base64')).toString('utf8'));
    }
    return JSON.parse(payload);
}

function chooseWorldDir(explicitDir) {
    return explicitDir ? path.resolve(explicitDir) : null;
}

async function stopServer(server, cli) {
    if (cli && typeof cli.close === 'function') {
        await Promise.resolve(cli.close()).catch(() => {});
    }
    if (server && typeof server.stop === 'function') await server.stop();
}

async function waitForGameTime(cli, target, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        if (last >= target) return last;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for Game.time >= ${target}; last=${last}`);
}

// Observe an independent deadline without postponing the caller's phase target.
async function waitForGameTimeWithObserver(cli, target, timeoutMs, observer, wait = waitForGameTime) {
    const deadline = Date.now() + timeoutMs;
    while (!observer.complete) {
        const tick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        if (observer.lastSample == null || tick >= observer.lastSample + 5 || tick >= observer.until) {
            await observer.sample(tick);
            observer.lastSample = tick;
        }
        if (tick >= observer.until) {
            await observer.finish(tick);
            observer.complete = true;
            break;
        }
        if (tick >= target) return tick;
        await wait(cli, Math.min(target, tick + 5), Math.max(1, deadline - Date.now()));
    }
    return wait(cli, target, Math.max(1, deadline - Date.now()));
}

async function waitForHttpReady(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await httpJson('GET', port, '/api/version');
            if (response && response.ok) return response;
        } catch (error) {
            lastError = error;
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for HTTP backend on ${port}: ${lastError && lastError.message || 'unavailable'}`);
}

/**
 * 等 backend 启动时的 calcMarketStats 把 market 场景的成交史重算出来（fixtures seedTerminalNet：种子里直接插的 market.stats 行带
 * seeded 标记，cron 会 removeWhere({}) 后从 users.money 重算）。恢复模拟前等它跑完：runner 把 getHistory 缓存 3 小时，
 * 赶上 removeWhere 与重插之间读到空表就一整轮都没有成交史。超时不抛（cron 没跑时种子行还在，成交史照样有），只记下来。
 */
async function waitMarketHistory(cli, timeoutMs) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        last = await cli.evaluateJson(`Promise.all([storage.db['market.stats'].count({resourceType:'U'}),storage.db['market.stats'].count({seeded:true})])`
            + `.then(function(v){return {rows:v[0],seeded:v[1]}})`);
        if (last && last.rows > 0 && last.seeded === 0) return Object.assign({ rebuilt: true, waitedMs: Date.now() - started }, last);
        await sleep(200);
    }
    return Object.assign({ rebuilt: false, waitedMs: Date.now() - started }, last || {});
}

async function persistMarker(cli, worldDir, label, timeoutMs) {
    const marker = `__validation_persist_${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const dbPath = path.join(worldDir, 'db.json');
    let previousMtime = null;
    let lastReadAt = 0;
    try {
        previousMtime = fs.statSync(dbPath).mtimeMs;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await cli.evaluateJson(
        `storage.env.set(${JSON.stringify(marker)},${JSON.stringify(marker)}).then(function(){return true})`,
        { timeoutMs: 10000 });
    const deadline = Date.now() + Number(timeoutMs || PERSISTENCE_TIMEOUT_MS);
    while (Date.now() < deadline) {
        try {
            const stat = fs.statSync(dbPath);
            if (stat.size > 0 && (previousMtime == null || stat.mtimeMs !== previousMtime || Date.now() - lastReadAt >= 250)) {
                const contents = fs.readFileSync(dbPath, 'utf8');
                previousMtime = stat.mtimeMs;
                lastReadAt = Date.now();
                if (contents.includes(marker)) return marker;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await sleep(50);
    }
    throw new Error(`Timed out waiting for private-server database flush (${label})`);
}

async function getUserId(cli, username) {
    const user = await cli.evaluateJson(
        `storage.db.users.findOne({username:${JSON.stringify(username)}}).then(function(user){return user && {id:String(user._id), username:user.username}})`);
    return user && user.id || null;
}

async function mintAuthToken(cli, userId) {
    const token = crypto.createHmac('sha1', 'hsdhweh342sdbj34e')
        .update(String(Date.now()) + String(userId))
        .digest('hex');
    await cli.evaluateJson(`storage.env.set('auth_${token}',${JSON.stringify(String(userId))}).then(function(){return true})`);
    return token;
}

async function readUserMemory(port, username, token) {
    // 探针写进 Memory 后经引擎序列化才能从 HTTP 读到；偶发读到旧快照或空响应时重试几次，失败时把原始响应留在结果里便于定位
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        const response = await httpJson('GET', port, '/api/user/memory', null, { 'X-Username': username, 'X-Token': token });
        const memory = decodeMemoryPayload(response && response.data);
        if (memory && memory._validation) return memory;
        last = { memory, response: response && Object.assign({}, response, { data: response.data ? String(response.data).slice(0, 80) : response.data }) };
        await sleep(1500);
    }
    return Object.assign({}, last.memory || {}, { _readDiagnostics: last.response });
}

async function readRootMemory(cli, userId) {
    return cli.evaluateJson(
        `storage.env.get(storage.env.keys.MEMORY+${JSON.stringify(String(userId))}).then(function(raw){return raw ? JSON.parse(raw) : null})`);
}

async function readErrorNotifications(cli) {
    const expression = `(function(){var collection=storage.db['users.notifications'];if(!collection)return Promise.resolve([]);return collection.find({type:'error'}).then(function(items){return Promise.all(items.map(function(item){return storage.db.users.findOne({_id:item.user}).then(function(user){return {userId:String(item.user),username:user&&user.username||null,message:String(item.message||'').slice(0,2000)};});}));});})()`;
    return cli.evaluateJson(expression);
}

async function postValidationProbe(port, username, token, roomName) {
    // 控制台表达式有 1024 字符上限（backend user.js /console）：探针本体在 src/soak_probe.js（随 bot 上传，线上不调用零开销），
    // 这里只调一行；返回值必须检查——2026-09-06 探针涨到 1125 字符被静默拒绝，报告阶段只看到 "HTTP probe missing"
    const expression = `require('soak_probe').validationProbe(${JSON.stringify(roomName)})`;
    const result = await httpJson('POST', port, '/api/user/console', { expression }, { 'X-Username': username, 'X-Token': token });
    if (!result || result.error || result.ok !== 1) {
        throw new Error(`console probe rejected for ${roomName}: ${JSON.stringify(result)}`);
    }
    return result;
}

/** 房间可视化默认关（config.visuals）：私服里显式打开，好让渲染路径继续被覆盖；
 *  VISUALS_OFF_ROOM 故意不开，用来观察门闸真的生效（生效断言 core.visualsGated）。 */
async function enableVisuals(port, username, token, ticks) {
    const expression = `require('visuals').show(${Number(ticks) || 100000})`;
    const result = await httpJson('POST', port, '/api/user/console', { expression }, { 'X-Username': username, 'X-Token': token });
    if (!result || result.error || result.ok !== 1) {
        throw new Error(`console showVisuals rejected for ${username}: ${JSON.stringify(result)}`);
    }
    return result;
}

async function prepareReserveDeadline(cli) {
    await cli.run('system.pauseSimulation()');
    try {
        const userId = await getUserId(cli, 'ValidationReserveDeadline');
        const memory = await readRootMemory(cli, userId);
        const home = memory && memory.rooms && memory.rooms[ROOMS.reserveDeadlineHome];
        const record = home && home.remotes && home.remotes[ROOMS.reserveDeadlineTarget];
        if (!record || record.controllerDistanceVersion !== 3 || record.controllerDistanceIncomplete !== false) throw new Error('reserveDeadline requires this user\'s complete production controller route');
        const objects = await cli.evaluateJson(`storage.db['rooms.objects'].find({user:${JSON.stringify(userId)}})`);
        const incumbent = objects.find((o) => o.type === 'creep' && o.name === 'reserve-incumbent');
        const spawn = objects.find((o) => o.type === 'spawn');
        const controller = record.controllerPos;
        if (!incumbent || !incumbent.body.some((p) => p.type === 'claim') || incumbent.room !== ROOMS.reserveDeadlineTarget ||
            Math.max(Math.abs(incumbent.x-controller.x), Math.abs(incumbent.y-controller.y)) > 1 || !spawn || spawn.spawning) throw new Error('reserveDeadline incumbent position/CLAIM or idle-spawn prerequisite failed');
        const energyStructures = objects.filter((o) => o.room === ROOMS.reserveDeadlineHome && ['spawn','extension'].includes(o.type));
        if (energyStructures.length !== 21) throw new Error('reserveDeadline requires 1300 spawn capacity');
        const config = require(path.join(ROOT, 'src/config'));
        const lead = Number(config.remote.reserverGrace) + 12 + Math.max(record.controllerDistance,
            Math.max(Math.abs(controller.x-spawn.x), Math.abs(100+controller.y-spawn.y))-1) + 20;
        const at = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        const oldDiesAt = at + lead + 30;
        await cli.evaluateJson(`Promise.all([storage.db['rooms.objects'].update({_id:${JSON.stringify(incumbent._id)}},{$set:{ageTime:${oldDiesAt}}}),storage.db['rooms.objects'].update({user:${JSON.stringify(userId)},type:'spawn'},{$merge:{store:{energy:300}}}),storage.db['rooms.objects'].update({user:${JSON.stringify(userId)},type:'extension'},{$merge:{store:{energy:50}}}),storage.db['rooms.objects'].update({room:${JSON.stringify(ROOMS.reserveDeadlineHome)},type:'container'},{$merge:{store:{energy:2000}}})]).then(function(){return true})`);
        return { userId, at, lead, oldDiesAt, initialTtl: lead+30, energy:1300, controller, samples:[] };
    } finally { await cli.run('system.resumeSimulation()'); }
}

async function sampleReserveDeadline(cli, test) {
    const sample = await cli.evaluateJson(`Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({user:${JSON.stringify(test.userId)},type:'creep'})]).then(function(v){return {t:Number(v[0]),creeps:v[1].filter(function(o){return o.body.some(function(p){return p.type==='claim'})}).map(function(o){return {id:o._id,name:o.name,spawning:o.spawning,room:o.room,x:o.x,y:o.y}})}})`);
    if (!test.event) {
        const memory = await readRootMemory(cli, test.userId);
        const home = memory && memory.rooms && memory.rooms[ROOMS.reserveDeadlineHome];
        const event = home && home.reserveHandoff;
        if (event && event.remoteRoom === ROOMS.reserveDeadlineTarget && event.at >= test.at && event.at < test.oldDiesAt) {
            test.event = JSON.parse(JSON.stringify(event));
        }
    }
    if (test.event && !test.successorId) {
        const successor = sample.creeps.find((o) => o.name === test.event.name && o.id);
        if (successor) test.successorId = successor.id;
    }
    test.samples.push(sample);
    return !!test.successorId && sample.creeps.some((o) => o.name === 'reserve-incumbent') &&
        sample.creeps.some((o) => o.id === test.successorId && !o.spawning && o.room === ROOMS.reserveDeadlineTarget &&
            Math.max(Math.abs(o.x-test.controller.x), Math.abs(o.y-test.controller.y)) <= 1 && sample.t < test.oldDiesAt);
}

async function prepareReserveBudget(cli, ordered = false) {
    const homeName = ordered ? ROOMS.reserveOrderedHome : ROOMS.reserveBudgetHome;
    const targetName = ordered ? ROOMS.reserveOrderedTarget : ROOMS.reserveBudgetTarget;
    await cli.run('system.pauseSimulation()');
    try {
        const userId = await getUserId(cli, ordered ? 'ValidationReserveOrdered' : 'ValidationReserveBudget');
        const memory = await readRootMemory(cli, userId);
        const home = memory.rooms[homeName];
        const record = home.remotes[targetName];
        if (record.controllerDistanceVersion !== 3 || record.controllerDistanceIncomplete !== false) throw new Error('reserveBudget needs complete production route');
        const objects = await cli.evaluateJson(`storage.db['rooms.objects'].find({user:${JSON.stringify(userId)}})`);
        const incumbent = objects.find(o => o.type === 'creep' && o.name === 'reserve-incumbent');
        const spawn = objects.find(o => o.type === 'spawn');
        const controller = record.controllerPos;
        const extensions = objects.filter(o => o.type === 'extension');
        const initialHaulers = objects.filter(o => o.type === 'creep' && o.name.startsWith('reserve-core-hauler-')).length;
        const wantedHaulers = Number(home.demand && home.demand.targets && home.demand.targets.hauler);
        if (!Number.isFinite(wantedHaulers) || initialHaulers < wantedHaulers) throw new Error('reserveBudget core fleet shortage: '+JSON.stringify({homeName,initialHaulers,wantedHaulers}));
        const initialCarry = objects.filter(o=>o.type==='creep'&&o.name.startsWith('reserve-core-hauler-'))
            .reduce((sum,o)=>sum+o.body.filter(p=>p.type==='carry'&&p.hits>0).length,0);
        const wantedCarry = Number(home.haulModel && home.haulModel.cstar) || 0;
        if (initialCarry < wantedCarry) throw new Error('reserveBudget core CARRY shortage: '+JSON.stringify({homeName,initialCarry,wantedCarry}));
        if (!incumbent || incumbent.room !== targetName || !spawn || spawn.spawning || extensions.length !== 30 ||
            Math.max(Math.abs(incumbent.x-controller.x), Math.abs(incumbent.y-controller.y)) > 1) throw new Error('reserveBudget fixture prerequisites failed');
        const travel = Math.max(record.controllerDistance,
            Math.max(Math.abs(controller.x-spawn.x), Math.abs(100+controller.y-spawn.y))-1);
        const at = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        const oldDiesAt = at + travel + 6 + 20;
        // Full capacity1800, available1100: dual CLAIM cannot be paid, one CLAIM can arrive in time.
        const funded = extensions.slice(0,16).map(o => o._id);
        await cli.evaluateJson(`Promise.all([storage.db['rooms.objects'].update({_id:${JSON.stringify(incumbent._id)}},{$set:{ageTime:${oldDiesAt}}}),storage.db['rooms.objects'].update({user:${JSON.stringify(userId)},type:'spawn'},{$merge:{store:{energy:300}}}),storage.db['rooms.objects'].update({user:${JSON.stringify(userId)},type:'extension'},{$merge:{store:{energy:0}}}),storage.db['rooms.objects'].update({room:${JSON.stringify(homeName)},type:'container'},{$merge:{store:{energy:0}}})]).then(function(){return true})`);
        await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:{$in:${JSON.stringify(funded)}}},{$merge:{store:{energy:50}}}).then(function(){return true})`);
        const fundedEnergy = await cli.evaluateJson(`storage.db['rooms.objects'].find({user:${JSON.stringify(userId)},type:{$in:['spawn','extension']}}).then(function(objects){return objects.reduce(function(sum,o){return sum+(o.store.energy||0)},0)})`);
        if (fundedEnergy !== 1100) throw new Error('reserveBudget actual funding must be1100, got '+fundedEnergy);
        if (ordered) {
            const earlier=home.remotes[ROOMS.reserveOrderedEarly];
            if (!earlier || !earlier.sources.length || !memory.brain || memory.brain.rooms[homeName].remotes[0]!==ROOMS.reserveOrderedEarly)
                throw new Error('ordered fixture requires the producing remote first in real brain order');
        }
        return {ordered,userId,at,oldDiesAt,initialTtl:oldDiesAt-at,travel,energy:fundedEnergy,capacity:1800,initialHaulers,wantedHaulers,initialCarry,wantedCarry,incumbentId:incumbent._id,controller,samples:[]};
    } finally { await cli.run('system.resumeSimulation()'); }
}

async function sampleReserveBudget(cli, test) {
    const sample = await cli.evaluateJson(`Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({user:${JSON.stringify(test.userId)},type:'creep'})]).then(function(v){return {t:Number(v[0]),creeps:v[1].filter(function(o){return o.body.some(function(p){return p.type==='claim'})}).map(function(o){return {id:o._id,name:o.name,spawning:o.spawning,room:o.room,x:o.x,y:o.y,claim:o.body.filter(function(p){return p.type==='claim'}).length,parts:o.body.length}})}})`);
    if (!test.successorId) {
        const next = sample.creeps.find(o => o.id !== test.incumbentId);
        if (next) { test.successorId = next.id; test.successorClaim = next.claim; test.successorParts = next.parts; }
    }
    test.samples.push(sample);
    if (test.ordered && !test.evidence) {
        const memory = await readRootMemory(cli,test.userId);
        if (memory._reserveOrderedEvidence) test.evidence=memory._reserveOrderedEvidence;
    }
}

function bootstrapRoadMove(objects,terrain,expectedPlan,expectedSpawn) {
    const sites=objects.filter(o=>o.type==='constructionSite'&&o.structureType==='road'&&o.progress===120);
    const spawn=objects.find(o=>o.type==='spawn');
    if(sites.length!==1||!spawn||!expectedPlan||!expectedSpawn||spawn.x!==expectedSpawn.x||spawn.y!==expectedSpawn.y||
        expectedPlan.sourceIds.some(id=>!objects.some(o=>o.type==='source'&&o._id===id)))
        throw new Error('Fixed bootstrap plan does not match seeded room');
    const before=sites[0],x=10,y=2;
    if(!terrain||terrain[y*50+x]!=='0'||objects.some(o=>o._id!==before._id&&o.x===x&&o.y===y)||
        expectedPlan.roads.all.split(';').includes(x+'.'+y)) throw new Error('Fixed bootstrap investment destination is not empty plain outside plan');
    return {before,after:Object.assign({},before,{x,y})};
}

async function moveBootstrapInvestment(cli,worldDir) {
    const file=process.env.VALIDATION_BOOTSTRAP_PLAN_FIXTURE;
    if(!file)return;
    const input=JSON.parse(fs.readFileSync(file,'utf8'));
    const expected=input.expectedBootstrapPlan;
    const data=await cli.evaluateJson(`Promise.all([storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.bootstrap)}}),storage.db['rooms.terrain'].findOne({room:${JSON.stringify(ROOMS.bootstrap)}})]).then(v=>({objects:v[0],terrain:v[1].terrain}))`);
    const move=bootstrapRoadMove(data.objects,data.terrain,expected,input.expectedBootstrapSpawn);
    await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${JSON.stringify(move.before._id)}},{$set:{x:10,y:2}}).then(()=>true)`);
    fs.writeFileSync(path.join(worldDir,'bootstrap-investment-input.json'),JSON.stringify({planFile:file,expectedPlan:expected,...move},null,2));
}

/** 测试专用包装的安装/补装（一次 CLI 调用）：每个包装 {name,userId,module,marker,code}，模块里还没有 marker 才追加。
 *  backend 进程崩溃重启时会从 project-bot 重新加载 bot 代码、把包装全部冲掉（validation-xKltxj：t566–573 backend 因
 *  私服 roomsForceUpdate 的未处理 rejection 退出，重启后 route 观察器没了，后面的升级事件一条都没记下）。
 *  返回每个包装本次追加的份数与该用户的代码份数。 */
function wrapperInstallExpression(wrappers) {
    const list = wrappers.map((w) => ({ name: w.name, u: String(w.userId), m: w.module, k: w.marker, c: w.code }));
    return `Promise.all(${JSON.stringify(list)}.map(function(w){return storage.db['users.code'].find({user:w.u}).then(function(codes){`
        + `return Promise.all(codes.map(function(code){var src=code.modules[w.m]||'';if(src.indexOf(w.k)>=0)return 0;`
        + `var modules=Object.assign({},code.modules);modules[w.m]=src+w.c;`
        + `return storage.db['users.code'].update({_id:code._id},{$set:{modules:modules,timestamp:Date.now()}}).then(function(){return 1});}))`
        + `.then(function(v){return {name:w.name,appended:v.reduce(function(a,b){return a+b},0),codes:codes.length};});});}))`;
}

async function installWrappers(cli, wrappers) {
    return cli.evaluateJson(wrapperInstallExpression(wrappers));
}

async function prepareUpgraderRoute(cli) {
    const userId=await getUserId(cli,'ValidationUpgraderActualRoute');
    const data=await cli.evaluateJson(`Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.upgraderActualRoute)}})]).then(v=>({at:Number(v[0]),objects:v[1]}))`);
    const old=data.objects.find(o=>o.name==='route-incumbent');
    const spawn=data.objects.find(o=>o.type==='spawn'&&o.user===userId);
    const controller=data.objects.find(o=>o.type==='controller');
    // 截止 tick 相对播种 tick 换算：一期起服到暂停之间引擎可能多跑一 tick（validation-2Av9CU：播种在 tick 2，ageTime 602），
    // 写死 601 会让整轮在这里中止、后面所有生效断言都没机会跑
    const memory=await readRootMemory(cli,userId);
    const seedTick=Number(memory&&memory._fixtureSeedAt);
    if(!Number.isFinite(seedTick)||!old||!spawn||spawn.x!==27||spawn.y!==18||!controller||controller.x!==31||controller.y!==41||
        old.ageTime!==seedTick+UPGRADER_ROUTE.incumbentTtl)
        throw new Error('Actual-spawn handoff fixture origin/deadline mismatch: '+JSON.stringify({seedTick,ageTime:old&&old.ageTime,ttl:UPGRADER_ROUTE.incumbentTtl}));
    return {userId,at:data.at,seedTick,oldDiesAt:old.ageTime,incumbentId:old._id,spawn:{id:spawn._id,x:spawn.x,y:spawn.y},controller:{x:controller.x,y:controller.y},samples:[]};
}

async function sampleUpgraderRoute(cli,test) {
    const memory=await readRootMemory(cli,test.userId);
    const names=Object.keys(memory.creeps||{}).filter(name=>memory.creeps[name].role==='upgrader');
    const sample=await cli.evaluateJson(`Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({user:${JSON.stringify(test.userId)},type:'creep',name:{$in:${JSON.stringify(names)}}})]).then(v=>({t:Number(v[0]),creeps:v[1].map(o=>({id:o._id,name:o.name,room:o.room,x:o.x,y:o.y,spawning:o.spawning,body:o.body.map(p=>p.type),ageTime:o.ageTime}))}))`);
    test.samples.push(sample);
    if(!test.successorId) {
        const next=sample.creeps.find(c=>c.id!==test.incumbentId);
        if(next){test.successorId=next.id;test.firstSeenAt=sample.t;test.body=next.body;}
    }
    const home=memory.rooms&&memory.rooms[ROOMS.upgraderActualRoute];
    if(!test.plan&&home&&home.plan)test.plan=home.plan;
    if(!test.leg&&home&&home.upgraderLeg)test.leg=home.upgraderLeg;
    if(memory._upgraderRouteProof)test.proof=memory._upgraderRouteProof;
}

async function countNormalRooms(cli) {
    return cli.evaluateJson(`storage.db.rooms.find({status:'normal'}).then(function(rooms){return rooms.map(function(room){return room._id}).sort()})`);
}

function runExternalBrain(port, username, token, homeRoom, worldDir) {
    const script = path.join(ROOT, 'scripts', 'brain', 'run.py');
    const args = [script, '--server', 'private', '--base-url', `http://127.0.0.1:${port}`, '--username', username,
        '--token', token, '--homes', homeRoom, '--radius', '1', '--write', '--min-interval', '0',
        '--out', path.join(worldDir, 'brain-' + homeRoom)];
    const output = execFileSync('python3', args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    return JSON.parse(output.trim().split('\n').pop());
}

async function phaseOne(worldDir, serverDir, tickDuration, seedWaitMs, ports) {
    const server = new PrivateServer(Object.assign({ serverDir, worldDir, runnersCnt: 0, runnerThreads: 1 }, ports || {}));
    const cli = await server.start();
    try {
        await generateWorld(cli);
        await persistMarker(cli, worldDir, 'world');
        await sleep(seedWaitMs);
    } finally {
        await stopServer(server, cli);
    }
}

async function phaseTwo(worldDir, serverDir, opts) {
    const options = opts || {};
    const serverOptions = {
        serverDir,
        worldDir,
        gamePort: options.gamePort,
        cliPort: options.cliPort,
        runnerThreads: 1,
    };

    if (!options.seedDb) {
    const seedServer = new PrivateServer(Object.assign({}, serverOptions, { runnersCnt: 0 }));
    const seedCli = await seedServer.start();
    try {
        await waitForHttpReady(seedServer.gamePort, 30000);
        await sleep(1000);
        await seedCli.run(`system.setTickDuration(${Math.max(1, Math.floor(options.tickDuration || 1))})`, { timeoutMs: 10000 });
        await waitForGeneratedRooms(seedCli);
        await seedAllScenarios(seedCli);
        // Preserve the complete paused input before any optional fixture validation can throw.
        await persistMarker(seedCli, worldDir, 'scenarios_raw');
        fs.copyFileSync(path.join(worldDir,'db.json'),path.join(worldDir,'scenario-seed-raw-db.json'));
        await moveBootstrapInvestment(seedCli,worldDir);
        await persistMarker(seedCli, worldDir, 'scenarios');
        fs.copyFileSync(path.join(worldDir,'db.json'),path.join(worldDir,'scenario-seed-db.json'));
    } finally {
        await stopServer(seedServer, seedCli);
    }

    }

    const server = new PrivateServer(Object.assign({}, serverOptions, { runnersCnt: 1 }));
    const cli = await server.start();
    try {
        await waitForHttpReady(server.gamePort, 30000);
        await cli.run('system.pauseSimulation()', {timeoutMs:10000});
        const pausedTick=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        if (options.seedTick!=null && pausedTick!==options.seedTick) throw new Error('Restored scenario advanced before activation: seed='+options.seedTick+' actual='+pausedTick);
        await sleep(500);
        await cli.run(`system.setTickDuration(${Math.max(1, Math.floor(options.tickDuration || 1))})`, { timeoutMs: 10000 });
        // Backend startup reloads bot code from project-bot. Install the test-only
        // wrapper after that final reload, while the scenario seed is still paused.
        const orderedUser=await getUserId(cli,'ValidationReserveOrdered');
        const upgraderRoute=await prepareUpgraderRoute(cli);
        const wrappers=[
            {name:'reserveOrdered',userId:orderedUser,module:'spawn_queue',marker:'const observeSchedule',
                code:reserveOrderedObserver(ROOMS.reserveOrderedHome,ROOMS.reserveOrderedEarly,ROOMS.reserveOrderedTarget)},
            {name:'upgraderRoute',userId:upgraderRoute.userId,module:'main',marker:ROUTE_OBSERVER_MARK,code:upgraderActualRouteObserver(ROOMS.upgraderActualRoute)},
            {name:'storageUpgradeFeed',userId:await getUserId(cli,'ValidationAid'),module:'main',marker:FEED_OBSERVER_MARK,code:storageUpgradeFeedObserver(ROOMS.aidHome)},
            {name:'repairPoolNeutral',userId:await getUserId(cli,'ValidationMaintenance'),module:'main',marker:REPAIR_OBSERVER_MARK,code:repairPoolNeutralObserver(ROOMS.maintenance)},
        ];
        const installation=await installWrappers(cli,wrappers);
        for (const item of installation) if (!(item.codes>0)) throw new Error('Test wrapper '+item.name+' was not installed after bot code reload');
        const observerPresent=installation.find(i=>i.name==='reserveOrdered').codes>0;
        const routeObserverInstalled=installation.find(i=>i.name==='upgraderRoute').codes>0;
        assert(routeObserverInstalled,'Actual-spawn observer not installed after runtime reload');
        // 矿物场景（minerals.extractorDrone / externalDelivery）：恢复模拟前先跑一轮 industry 大脑，mineral 指令在第 1–2 tick 就到。
        // 以前首轮放在预留窗口之后（t≈211–251），钻机最多剩 560 tick；矿脉 ≥26 格时大脑给 3W4C4M、装满 200 格约 400 tick，
        // 加上孵化与往返第一次投递落在 771 tick 的结束点上或之后（2026-10-14 validation-mZRVaL：t751 才排上孵化）。HTTP 在暂停时照常服务
        const industryUser=await getUserId(cli,'ValidationIndustry');
        const industryBrainAt=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        runExternalBrain(server.gamePort,'ValidationIndustry',await mintAuthToken(cli,industryUser),ROOMS.industry,worldDir);
        const marketHistory=await waitMarketHistory(cli,15000);
        if(!marketHistory.rebuilt) console.error('[market] calcMarketStats did not rebuild the seeded history before resume: '+JSON.stringify(marketHistory));
        fs.writeFileSync(path.join(worldDir,'observer-installation.json'),JSON.stringify({pausedTick,seedTick:options.seedTick,orderedObserverInstalled:observerPresent,upgraderRouteObserverInstalled:routeObserverInstalled,installation,marketHistory,industryBrainAt},null,2));
        // backend 中途重启会冲掉包装：观察期内每次采样前补装，补装记在 wrapperReinstalls（报告里能看出哪段时间闩锁可能漏记）
        const wrapperReinstalls=[];
        const ensureWrappers=async()=>{
            const result=await installWrappers(cli,wrappers);
            const lost=result.filter(i=>i.appended>0);
            if(lost.length){
                const at=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
                for(const item of lost){wrapperReinstalls.push({name:item.name,at});console.error('[wrappers] reinstalled '+item.name+' at tick '+at+' (bot code was reloaded)');}
            }
        };
        await cli.run('system.resumeSimulation()', { timeoutMs: 10000 });
        const startTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        // 防御场景的早期快照：Invader 是否在场、bot 头几十 tick 孵了什么
        const earlyDefense = [];
        const earlyReserve = [];
        let reserveDeadline = null;
        let reserveBudget = null;
        let reserveOrdered = null;
        const reserveUserId = await getUserId(cli, 'ValidationReserveContinuity');
        for (const offset of [5, 25, 60, 120]) {
            if (reserveBudget) {
                let tick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
                while (tick < startTick + offset) {
                    await ensureWrappers();
                    await sampleUpgraderRoute(cli,upgraderRoute);
                    await sampleReserveBudget(cli, reserveBudget);
                    if (reserveOrdered) await sampleReserveBudget(cli,reserveOrdered);
                    if (reserveDeadline) await sampleReserveDeadline(cli,reserveDeadline);
                    await waitForGameTime(cli, Math.min(startTick+offset,tick+5), 120000);
                    tick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
                }
            } else await waitForGameTime(cli, startTick + offset, 120000);
            await ensureWrappers();
            await sampleUpgraderRoute(cli,upgraderRoute);
            if (!reserveDeadline) reserveDeadline = await prepareReserveDeadline(cli);
            if (!reserveBudget) reserveBudget = await prepareReserveBudget(cli);
            if (!reserveOrdered) reserveOrdered = await prepareReserveBudget(cli,true);
            await sampleReserveBudget(cli,reserveOrdered);
            await sampleReserveBudget(cli, reserveBudget);
            await sampleReserveDeadline(cli, reserveDeadline);
            earlyReserve.push(await cli.evaluateJson(
                `Promise.all([storage.env.get(storage.env.keys.GAMETIME),storage.db['rooms.objects'].find({user:${JSON.stringify(reserveUserId)},type:'creep'})]).then(function(v){return {offset:Number(v[0])-${startTick},creeps:v[1].filter(function(o){return o.body.some(function(p){return p.type==='claim'})}).map(function(o){return {name:o.name,spawning:o.spawning,room:o.room}})}})`));
            earlyDefense.push(await cli.evaluateJson(
                `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.defenseHome)},type:'creep'}).then(function(l){return {t:${startTick + offset},creeps:l.map(function(o){return [o.user==='2'?'INV':'me',o.name,o.x,o.y,o.hits]})}})`));
        }
        const lastReserveDeath = Math.max(reserveDeadline.oldDiesAt,reserveBudget.oldDiesAt,reserveOrdered.oldDiesAt);
        while (Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)')) < lastReserveDeath) {
            await ensureWrappers();
            await sampleUpgraderRoute(cli,upgraderRoute);
            // All scenarios run concurrently: never wait out one incumbent while missing another's arrival.
            await sampleReserveDeadline(cli,reserveDeadline);
            await sampleReserveBudget(cli,reserveBudget);
            await sampleReserveBudget(cli,reserveOrdered);
            const tick=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
            await waitForGameTime(cli,tick+5,120000);
        }
        const reserveEarly = { validationStartTick:startTick, reserveDeadline, reserveBudget, reserveOrdered, upgraderRoute, wrapperReinstalls };
        fs.writeFileSync(path.join(worldDir,'reserve-early-evidence.json'),JSON.stringify(reserveEarly,null,2));
        const orderedEarly = effects.EFFECTS.find(effect=>effect.id==='remote.orderedReserverDeadline').check(reserveEarly,ROOMS);
        assert(orderedEarly.ok, 'Ordered reserve early arrival failed: '+orderedEarly.why);
        const phaseTimes={industryBrainAt,originalReserveWindowCompleteAt:Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)')),upgraderSamples:[]};
        const savePhaseTimes=()=>fs.writeFileSync(path.join(worldDir,'phase-timestamps.json'),JSON.stringify(phaseTimes,null,2));
        const routeObserver={until:upgraderRoute.oldDiesAt+25,complete:false,lastSample:null,
            sample:async tick=>{await ensureWrappers();await sampleUpgraderRoute(cli,upgraderRoute);phaseTimes.upgraderSamples.push({requestedAt:tick,observedAt:upgraderRoute.samples[upgraderRoute.samples.length-1].t});},
            finish:async tick=>{
                phaseTimes.upgraderAssertionAt=tick;
                fs.writeFileSync(path.join(worldDir,'reserve-early-evidence.json'),JSON.stringify(reserveEarly,null,2));
                savePhaseTimes();
                const routeEarly=effects.EFFECTS.find(effect=>effect.id==='upgrader.actualSpawnHandoff').check(reserveEarly,ROOMS);
                assert(routeEarly.ok,'Actual-spawn upgrader handoff failed: '+routeEarly.why);
            }};
        const waitObserved=(target,timeout)=>waitForGameTimeWithObserver(cli,target,timeout,routeObserver);
        savePhaseTimes();
        await waitObserved(startTick + Math.max(30, Math.floor(options.warmupTicks || 0)), Math.max(60000, options.maxTicks * 200));

        const usernameByRoom = {
            [ROOMS.bootstrap]: 'ValidationBootstrap',
            [ROOMS.recovery]: 'ValidationRecovery',
            [ROOMS.logistics]: 'ValidationLogistics',
            [ROOMS.storageConsumer]: 'ValidationStorageConsumer',
            [ROOMS.controllerLinkConsumer]: 'ValidationControllerLinkConsumer',
            [ROOMS.upgraderActualRoute]: 'ValidationUpgraderActualRoute',
            [ROOMS.links]: 'ValidationLinks',
            [ROOMS.blueprint]: 'ValidationBlueprint',
            [ROOMS.industry]: 'ValidationIndustry',
            [ROOMS.remoteHome]: 'ValidationRemote',
            [ROOMS.reserveHome]: 'ValidationReserveContinuity',
            [ROOMS.roadTrailHome]: 'ValidationRoadTrail',
            [ROOMS.reserveDeadlineHome]: 'ValidationReserveDeadline',
            [ROOMS.reserveBudgetHome]: 'ValidationReserveBudget',
            [ROOMS.reserveOrderedHome]: 'ValidationReserveOrdered',
            [ROOMS.conflict]: 'ValidationConflict',
            [ROOMS.brainHome]: 'ValidationBrain',
            [ROOMS.defenseHome]: 'ValidationDefense',
            [ROOMS.aidHome]: 'ValidationAid',
            [ROOMS.aidWeak]: 'ValidationAid',
            [ROOMS.aidNew1]: 'ValidationAid',
            [ROOMS.aidSafeHome]: 'ValidationAidSafeRoute',
            [ROOMS.aidSafeFar]: 'ValidationAidSafeRoute',
            [ROOMS.layoutOneOff]: 'ValidationLayoutOneOff',
            [ROOMS.layoutLeftover]: 'ValidationLayoutLeftover',
            [ROOMS.terminalHome]: 'ValidationTerminalNet',
            [ROOMS.terminalPeer]: 'ValidationTerminalNet',
            [ROOMS.terminalDrainLow]: 'ValidationTerminalDrainLow',
            [ROOMS.labHome]: 'ValidationLabChain',
            [ROOMS.labPeer]: 'ValidationLabChain',
            [ROOMS.boostLabGated]: 'ValidationBoostLabGated',
            [ROOMS.boostHome]: 'ValidationBoost',
            [ROOMS.skHome]: 'ValidationSk',
            [ROOMS.autoClaimHome]: 'ValidationAutoClaim',
            [ROOMS.autoClaimCpuHome]: 'ValidationAutoClaimCpu',
            [ROOMS.storageFed]: 'ValidationStorageFed',
            [ROOMS.containerGap]: 'ValidationRecovery',
            [ROOMS.claimBlocked]: 'ValidationClaimBlocked',
            [ROOMS.maintenance]: 'ValidationMaintenance',
            [ROOMS.auditHome]: 'ValidationAudit',
            [ROOMS.auditRich]: 'ValidationAudit',
            [ROOMS.auditLink]: 'ValidationAudit',
            [ROOMS.auditZero]: 'ValidationAudit',
            [ROOMS.minerPair]: 'ValidationMinerPair',
            [ROOMS.auditPocket]: 'ValidationAudit',
            [ROOMS.auditWalled]: 'ValidationAudit',
        };
        // 攻占场景由 VALIDATE_CONQUEST 门控（fixtures 同款开关）：只有播种了才有这两个用户可探针
        if (process.env.VALIDATE_CONQUEST) {
            usernameByRoom[ROOMS.conquestHome] = 'ValidationConquest';
            usernameByRoom[ROOMS.conquestTarget] = 'ValidationConquestEnemy';
            // conquestTransit（过境房）的用户 inactive、不跑代码：不列入 usernameByRoom，否则每房错误/stats 检查会因它没有 Memory.errors/stats 而失败。
            // 塔由 fixtures 直接建（属该用户、对我方敌对），过境避塔只需塔的存在与位置，不需要它跑 bot。
        }
        // keeper 过境场景（VALIDATE_KEEPER 门控）：只列 keeperHome（活跃 bot，跑 claimer + 记 Memory.keeperTransit）；
        // keeperRoom 中立（只有直接插入的 keeper lair、无 bot）、keeperTarget 中立，都不列（无 Memory.errors/stats）。
        if (process.env.VALIDATE_KEEPER) {
            usernameByRoom[ROOMS.keeperHome] = 'ValidationKeeper';
        }

        const roomIds = {};
        const roomUsernames = {};
        for (const [roomName, username] of Object.entries(usernameByRoom)) {
            const userId = await getUserId(cli, username);
            assert(userId, `missing user for ${roomName}`);
            roomIds[roomName] = userId;
            roomUsernames[roomName] = username;
        }

        // token 在 backend 里 60 秒不用就过期（auth.tokenAuth 每次使用续期）：同一用户只铸一个，长等待之后用前重铸——
        // 同一用户两个房各铸一个时，结束重投探针只有第一个房的 token 被续期，第二个房的报 unauthorized（两次铸造落在同一毫秒才碰巧相同）
        const tokenByUser = {};
        const mintTokens = async (fresh) => {
            for (const roomName of Object.keys(roomUsernames)) {
                const userId = roomIds[roomName];
                if (fresh || !tokenByUser[userId]) tokenByUser[userId] = await mintAuthToken(cli, userId);
                probeTokens[roomName] = tokenByUser[userId];
            }
        };
        const probeTokens = {};
        await mintTokens(false);
        for (const [roomName, username] of Object.entries(roomUsernames)) {
            if (roomName !== VISUALS_OFF_ROOM) await enableVisuals(server.gamePort, username, probeTokens[roomName], 100000);
            await postValidationProbe(server.gamePort, username, probeTokens[roomName], roomName);
        }

        // 外部大脑端到端：对私服拉情报、写 segment 90，再给 bot 几十 tick 去消费
        phaseTimes.initialBrainAt=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));savePhaseTimes();
        const brainResult = runExternalBrain(server.gamePort, roomUsernames[ROOMS.brainHome], probeTokens[ROOMS.brainHome], ROOMS.brainHome, worldDir);
        runExternalBrain(server.gamePort, roomUsernames[ROOMS.industry], probeTokens[ROOMS.industry], ROOMS.industry, worldDir);
        // 占领邻房：claimer 孵化 + 走过去 + 放 spawn 工地，给足 tick
        // 占领邻房 + 生效断言（援建 hauler/courier 要孵出来、走过去、取到能量）：基础等待之外再给 effectTicks
        // 时限按 1 s/tick 给：11 个用户的代码每 tick 约 0.6 s，200 ms/tick 的老预算在 +400 tick 时会在 700 多 tick 处超时
        const effectTicks = Math.max(0, Math.floor(options.effectTicks || 0));
        const endTick = startTick + Math.max(300, Math.floor(options.warmupTicks || 0) + 280) + effectTicks;
        // Production brain runs periodically; exercise refreshed routes and lifecycle decisions too.
        let currentTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        // 维修饥饿场景的中途采样：broker 的维修任务池是每 tick 现算的（不落 Memory），而结束时道路通常已经修好、
        // 池子空了——只有中途取一次才看得到"池里有路"（生效断言 maintenance.repairPoolNeutral）
        let maintenanceEarly = null;
        while (currentTick < endTick) {
            await waitObserved(Math.min(endTick, currentTick + 150), 210000);
            await ensureWrappers();
            await mintTokens(true);
            (phaseTimes.brainRefreshAt||(phaseTimes.brainRefreshAt=[])).push(Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)')));savePhaseTimes();
            runExternalBrain(server.gamePort, roomUsernames[ROOMS.industry], probeTokens[ROOMS.industry], ROOMS.industry, worldDir);
            currentTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
            if (!maintenanceEarly && currentTick >= startTick + 300) {
                await postValidationProbe(server.gamePort, roomUsernames[ROOMS.maintenance], probeTokens[ROOMS.maintenance], ROOMS.maintenance);
                await waitObserved(currentTick + 4, 120000);
                const earlyMemory = await readUserMemory(server.gamePort, roomUsernames[ROOMS.maintenance], probeTokens[ROOMS.maintenance]);
                phaseTimes.maintenanceSampleAt=Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));savePhaseTimes();
                maintenanceEarly = (earlyMemory && earlyMemory._validationRooms && earlyMemory._validationRooms[ROOMS.maintenance]) || null;
                currentTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
            }
        }

        // 结束前再投一次探针：报告里的房间快照（storage 能量、援建需求、spawn 队列）要反映结束时的状态，不是第 90 tick 的
        await ensureWrappers();
        await mintTokens(true);
        for (const [roomName, username] of Object.entries(roomUsernames)) {
            await postValidationProbe(server.gamePort, username, probeTokens[roomName], roomName);
        }
        const probeTick = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        await waitObserved(probeTick + 6, 120000);
        const roomNames = await countNormalRooms(cli);
        const rootMemories = {};
        for (const [roomName, userId] of Object.entries(roomIds)) {
            rootMemories[roomName] = await readRootMemory(cli, userId);
        }
        const probeMemories = {};
        for (const [roomName, username] of Object.entries(roomUsernames)) {
            probeMemories[roomName] = await readUserMemory(server.gamePort, username, probeTokens[roomName]);
        }
        const notifications = await readErrorNotifications(cli);
        const hostileCounts = {};
        for (const roomName of [ROOMS.brainRemote, ROOMS.brainRemote2, ROOMS.brainHome, ROOMS.defenseHome]) {
            hostileCounts[roomName] = Number(await cli.evaluateJson(
                `storage.db['rooms.objects'].count({room:${JSON.stringify(roomName)},type:'creep',user:'2'})`));
        }
        // 攻占破防断言用：目标房里敌方（ValidationConquestEnemy）残余的塔/spawn 数——原始 DB 计数，不依赖敌方探针。
        // 未播种（无 VALIDATE_CONQUEST）时保持 undefined，effects 的 conquest.breach 会自动跳过、不影响部署门
        let conquestStructures;
        if (process.env.VALIDATE_CONQUEST) {
            const conquestEnemyId = roomIds[ROOMS.conquestTarget];
            const conquestAttackerId = roomIds[ROOMS.conquestHome];
            conquestStructures = {
                towers: Number(await cli.evaluateJson(
                    `storage.db['rooms.objects'].count({room:${JSON.stringify(ROOMS.conquestTarget)},type:'tower',user:${JSON.stringify(conquestEnemyId)}})`)),
                spawns: Number(await cli.evaluateJson(
                    `storage.db['rooms.objects'].count({room:${JSON.stringify(ROOMS.conquestTarget)},type:'spawn',user:${JSON.stringify(conquestEnemyId)}})`)),
                survivorsInTarget: Number(await cli.evaluateJson(
                    `storage.db['rooms.objects'].count({room:${JSON.stringify(ROOMS.conquestTarget)},type:'creep',user:${JSON.stringify(conquestAttackerId)}})`)),
            };
            // **有效的**损失指标：conquest.runOne 在破防那一刻快照的存活数（事后再数只能数到零星掉队者——
            // 幸存者会把 extension 拆完就退役离场，第一版指标因此完全失效）
            const attackerMem = rootMemories[ROOMS.conquestHome] || {};
            const dirs = Array.isArray(attackerMem.conquest) ? attackerMem.conquest : (attackerMem.conquest ? [attackerMem.conquest] : []);
            const dir = dirs.find((x) => x && x.target === ROOMS.conquestTarget);
            conquestStructures.siegeAtBreach = dir && dir.siegeAtBreach != null ? dir.siegeAtBreach : null;
            conquestStructures.siegeSeeded = 17;
            // 过境避塔遥测：siege 冲锋经过 conquestTransit 时到过境塔的最近距离（越大越好；避塔生效应远大于塔最佳射程 5）
            const siegeTransit = (attackerMem && attackerMem.siegeTransit) || {};
            conquestStructures.transitMinDist = siegeTransit[ROOMS.conquestTransit] != null ? siegeTransit[ROOMS.conquestTransit] : null;
            console.log(`[transit] 过境避塔：siege 到 ${ROOMS.conquestTransit} 过境塔(25,25)的最近距离=${conquestStructures.transitMinDist}（>5 = 未进塔最佳射程；避塔生效）`);
            console.log(`[B0] conquest 破防: towers=${conquestStructures.towers} spawns=${conquestStructures.spawns} `
                + `**破防瞬间存活=${conquestStructures.siegeAtBreach}/17**（有效损失指标，越高越好） `
                + `结束时仍在目标房=${conquestStructures.survivorsInTarget}（掉队者，仅供参考）`);
        }
        // keeper 过境遥测：claimer 穿中立 keeperRoom 时到 lair(25,25) 的最近 Chebyshev 距离（越大越好；避让生效应 ≥ keeperAvoid.range=5）。
        // minDist 非空即证明 claimer 确实进过 keeperRoom（noteKeeperTransit 只在有 lair 的房记录）——不会"没走也绿"。未播种时 undefined，effects 自动跳过。
        let keeperTransit;
        if (process.env.VALIDATE_KEEPER) {
            const keeperMem = rootMemories[ROOMS.keeperHome] || {};
            const kt = (keeperMem && keeperMem.keeperTransit) || {};
            const reached = Number(await cli.evaluateJson(
                `storage.db['rooms.objects'].count({room:${JSON.stringify(ROOMS.keeperTarget)},type:'creep',user:${JSON.stringify(roomIds[ROOMS.keeperHome])}})`));
            keeperTransit = {
                minDist: kt[ROOMS.keeperRoom] != null ? kt[ROOMS.keeperRoom] : null,
                claimerReachedTarget: reached > 0,
            };
            console.log(`[keeper] claimer 穿 ${ROOMS.keeperRoom} 到 lair(25,25) 最近距离=${keeperTransit.minDist}`
                + `（≥5 = 保持了安全距离、避让生效）；到达 ${ROOMS.keeperTarget}=${keeperTransit.claimerReachedTarget}`);
        }
        const storageConsumerProgress = await cli.evaluateJson(
            `storage.db['rooms.objects'].findOne({room:${JSON.stringify(ROOMS.storageConsumer)},type:'controller'}).then(function(o){return o && o.progress || 0})`);
        const towerMaintenance = await cli.evaluateJson(
            `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.logistics)},type:'tower'}).then(function(list){return list.map(function(t){return t.validationRepairs || null})})`);
        const protectedStore = await cli.evaluateJson(
            `storage.db['rooms.objects'].findOne({room:${JSON.stringify(ROOMS.conflict)},type:'storage',_validationLoadedStore:true}).then(function(s){return s ? {id:s._id,resources:Object.values(s.store||{}).reduce(function(a,b){return a+b},0)} : null})`);
        // 敌方遗留 spawn 场景：结束时那个房里还剩哪些 spawn（主人）、有没有我们的 spawn 工地
        const foreignQuota = await cli.evaluateJson(
            `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.foreignSpawn)},$or:[{type:'spawn'},{type:'constructionSite',structureType:'spawn'}]}).then(function(list){`
            + `return (list||[]).map(function(o){return {type:o.type,user:o.user,x:o.x,y:o.y,progress:o.progress||0}})})`);
        const controllerLinkConsumerProgress = await cli.evaluateJson(
            `storage.db['rooms.objects'].findOne({room:${JSON.stringify(ROOMS.controllerLinkConsumer)},type:'controller'}).then(function(o){return o && o.progress || 0})`);
        // 维修饥饿场景：道路血量（builder/塔的维修结果）、工地类型（名额让位）、塔能量与建筑数量
        const maintenance = await cli.evaluateJson(
            `Promise.all([storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.maintenance)},type:'road'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.maintenance)},type:'constructionSite'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.maintenance)},type:'tower'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.maintenance)},type:'link'})]).then(function(values){`
            + `return {roads:(values[0]||[]).map(function(o){return [o.x,o.y,o.hits]}),`
            + `sites:(values[1]||[]).map(function(o){return [o.structureType,o.progress,o.progressTotal,o.x,o.y]}),`
            + `towers:(values[2]||[]).map(function(o){return [o.x,o.y,(o.store&&o.store.energy)||0]}),`
            + `links:(values[3]||[]).map(function(o){return [o.x,o.y,(o.store&&o.store.energy)||0]})};})`);
        // 外矿漏能量场景：**满容器那一格**地上的能量（remoteMiner 满仓 + 容器满时旧代码每 tick 让引擎把溢出的采集丢到地上）。
        // 只数这一格：另一个源的矿工在容器建好之前也会落地（那条与本改动无关），会把整房的总量搅浑。
        const remoteHomeMem = rootMemories[ROOMS.remoteHome] || {};
        const remoteRecord = ((remoteHomeMem.rooms || {})[ROOMS.remoteHome] || {}).remotes
            && ((remoteHomeMem.rooms || {})[ROOMS.remoteHome] || {}).remotes[ROOMS.remote];
        const overflowSource = ((remoteRecord || {}).sources || []).find((source) => source && source.distance === 500);
        const overflowSpot = overflowSource && overflowSource.spot;
        const remoteGround = overflowSpot ? await cli.evaluateJson(
            `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.remote)},type:'energy',`
            + `x:${JSON.stringify(overflowSpot.x)},y:${JSON.stringify(overflowSpot.y)}}).then(function(list){`
            + `return (list||[]).reduce(function(sum,o){return sum + (o.energy||0)},0)})`) : null;
        // 打捞场景（2026-09-12）：linkDrink 房的 storage/terminal 里最终有没有非能量资源——光"捡起来"不算生效，
        // 化合物要真的落进库；同时看播的入侵者 tombstone / 它衰减出的掉落还剩多少
        const salvageSink = await cli.evaluateJson(
            `Promise.all([storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.linkDrink)},type:'storage'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.linkDrink)},type:'terminal'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.linkDrink)},type:'tombstone'}),`
            + `storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.linkDrink)},type:'energy'})]).then(function(v){`
            + `return {sinks:(v[0]||[]).concat(v[1]||[]).map(function(o){return {type:o.type,store:o.store}}),`
            + `tombs:(v[2]||[]).map(function(o){return {x:o.x,y:o.y,store:o.store}}),`
            + `drops:(v[3]||[]).map(function(o){return {x:o.x,y:o.y,resourceType:o.resourceType,amount:o.energy||o.amount}})};})`);
        // terminal 补能 / 终端网络 / 市场场景（2026-10-13）：terminal 与 storage 的结束态（原始 DB，不看 bot 自己的记账）
        // 市场对手方那张 U 买单的剩余量（引擎处理了 deal 才会变少）
        const terminalNetRooms = [ROOMS.terminalHome, ROOMS.terminalPeer, ROOMS.terminalMarket];
        const terminalNet = await cli.evaluateJson(
            `Promise.all(${JSON.stringify(terminalNetRooms)}.map(function(room){return storage.db['rooms.objects'].find({room:room,$or:[{type:'terminal'},{type:'storage'}]})})`
            + `.concat([storage.db['market.orders'].find({roomName:${JSON.stringify(ROOMS.terminalMarket)},type:'buy',resourceType:'U'}),storage.db['market.stats'].count({resourceType:'U'})])).then(function(values){`
            + `var out={};${JSON.stringify(terminalNetRooms)}.forEach(function(room,i){out[room]=(values[i]||[]).map(function(o){return {type:o.type,user:o.user,store:o.store||{}}})});`
            + `var orders=(values[${terminalNetRooms.length}]||[]).map(function(o){return {active:o.active,remainingAmount:o.remainingAmount,totalAmount:o.totalAmount,amount:o.amount}});`
            + `return {rooms:out,npcOrders:orders,marketStats:values[${terminalNetRooms.length + 1}]};})`);
        // 矿物链场景（2026-10-13）：lab / terminal / storage 的结束态（原始 DB）——lab 里的矿物与产物只可能是 labTech 搬进去、反应做出来的
        const labChainRooms = [ROOMS.labHome, ROOMS.labPeer, ROOMS.boostLabGated, ROOMS.industry];   // industry：强化没打开时 boost lab 不补能（broker.labEnergyNeedsBoosts）
        const labChain = await cli.evaluateJson(
            `Promise.all(${JSON.stringify(labChainRooms)}.map(function(room){return storage.db['rooms.objects'].find({room:room,$or:[{type:'lab'},{type:'terminal'},{type:'storage'}]})})).then(function(values){`
            + `var out={};${JSON.stringify(labChainRooms)}.forEach(function(room,i){out[room]=(values[i]||[]).map(function(o){return {id:String(o._id),type:o.type,x:o.x,y:o.y,store:o.store||{}}})});`
            + `return {rooms:out};})`);
        // 攻城强化场景（2026-10-13）：boostHome 的 lab 结束态（原始 DB）——夹具没有 storage，没有别的东西会动 lab 里的 XZH2O/能量，少了就是 boostCreep 扣的；
        // 被强化的 siegeDismantler 还在就顺便带上它的身体（寿终/回收后只剩 lab 与 boostLog 两条证据）
        const boostScene = await cli.evaluateJson(
            `Promise.all([storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.boostHome)},type:'lab'}),`
            + `storage.db['rooms.objects'].findOne({type:'creep',name:'boost-siege'})]).then(function(v){`
            + `return {labs:(v[0]||[]).map(function(o){return {id:String(o._id),x:o.x,y:o.y,store:o.store||{}}}),`
            + `creep:v[1]?{room:v[1].room,body:(v[1].body||[]).map(function(p){return {type:p.type,boost:p.boost||null}})}:null};})`);
        // SK 采矿（2026-10-13）：keeper 房的结束态（原始 DB）——keeper（user '3'）的 _id/血量、lair 的孵化计时、源的容量/存量、ValidationSk 的 creep。
        // 夹具播的那只 keeper 只会在掉血（引擎才排重生）或被打死时从 DB 里消失/换 _id，房里会打它的只有 reaper
        const skScene = await cli.evaluateJson(
            `Promise.all([storage.db.users.findOne({username:'ValidationSk'}),storage.db['rooms.objects'].find({room:${JSON.stringify(ROOMS.skRoom)}})]).then(function(v){`
            + `var user=v[0],objects=v[1]||[];return {`
            + `keepers:objects.filter(function(o){return o.type==='creep'&&String(o.user)==='3'}).map(function(o){return {id:String(o._id),name:o.name,hits:o.hits}}),`
            + `lairs:objects.filter(function(o){return o.type==='keeperLair'}).map(function(o){return {id:String(o._id),nextSpawnTime:o.nextSpawnTime==null?null:o.nextSpawnTime}}),`
            + `sources:objects.filter(function(o){return o.type==='source'}).map(function(o){return {id:String(o._id),energy:o.energy,energyCapacity:o.energyCapacity}}),`
            + `controller:objects.some(function(o){return o.type==='controller'}),`
            + `creeps:objects.filter(function(o){return o.type==='creep'&&user&&String(o.user)===String(user._id)}).map(function(o){return {name:o.name,x:o.x,y:o.y,hits:o.hits,hitsMax:o.hitsMax}})};})`);
        // 自治占领兜底（2026-10-13）：正南目标房 controller 的结束态（原始 DB）——占下了就归 ValidationAutoClaim；
        // claimer 占下即自杀、Memory.creeps 里留不下它，controller 归属是"真的去占了"最硬的证据
        const autoClaimScene = await cli.evaluateJson(
            `Promise.all([storage.db.users.findOne({username:'ValidationAutoClaim'}),storage.db['rooms.objects'].findOne({room:${JSON.stringify(ROOMS.autoClaimTarget)},type:'controller'}),`
            + `storage.db['rooms.objects'].find({type:'creep',room:{$in:${JSON.stringify([ROOMS.autoClaimHome, ROOMS.autoClaimTarget])}}})]).then(function(v){`
            + `var user=v[0],ctrl=v[1];return {owned:!!(user&&ctrl&&String(ctrl.user)===String(user._id)),level:ctrl?ctrl.level||0:null,`
            + `creeps:(v[2]||[]).filter(function(o){return user&&String(o.user)===String(user._id)}).map(function(o){return {name:o.name,room:o.room}})};})`);
        // audit 场景（2026-09-11）：三个己方房的结束态对象（工地进度、墙/路血量、creep 位置与身体、link 能量）
        const auditRoomsQuery = [ROOMS.auditHome, ROOMS.auditRich, ROOMS.auditLink, ROOMS.auditRemote, ROOMS.auditDrop, ROOMS.auditZero, ROOMS.auditPocket, ROOMS.auditWalled, ROOMS.remoteHome, ROOMS.remote, ROOMS.roadTrailTarget, ROOMS.roadTrailForeign];
        const audit = await cli.evaluateJson(
            `Promise.all(${JSON.stringify(auditRoomsQuery)}.map(function(room){return storage.db['rooms.objects'].find({room:room})})).then(function(values){`
            + `var keep=['constructionSite','road','constructedWall','creep','link','container','storage','tower','lab','spawn','extension','energy'];`
            + `var out={};${JSON.stringify(auditRoomsQuery)}.forEach(function(room,i){out[room]=(values[i]||[]).filter(function(o){return keep.indexOf(o.type)>=0}).map(function(o){`
            + `return {type:o.type,structureType:o.structureType,x:o.x,y:o.y,hits:o.hits,progress:o.progress,name:o.name,energy:o.type==='energy'?o.energy:(o.store&&o.store.energy),`
            + `body:o.type==='creep'?(o.body||[]).map(function(p){return p.type}):undefined,user:o.user}})});return out;})`);
        const expectedBootstrapFile=process.env.VALIDATION_BOOTSTRAP_PLAN_FIXTURE;
        const bootstrapPlanCheck=expectedBootstrapFile ? {file:expectedBootstrapFile,matches:JSON.stringify(rootMemories[ROOMS.bootstrap].rooms[ROOMS.bootstrap].plan)===JSON.stringify(JSON.parse(fs.readFileSync(expectedBootstrapFile,'utf8')).expectedBootstrapPlan)} : null;
        return { bootstrapPlanCheck, validationStartTick:startTick, roomNames, rootMemories, probeMemories, notifications, brainResult, hostileCounts, conquestStructures, keeperTransit, earlyDefense, earlyReserve, reserveDeadline, reserveBudget, reserveOrdered, upgraderRoute, storageConsumerProgress, controllerLinkConsumerProgress, towerMaintenance, protectedStore, foreignQuota, maintenance, maintenanceEarly, remoteGround, audit, salvageSink, terminalNet, labChain, boostScene, skScene, autoClaimScene, wrapperReinstalls, industryBrainAt };
    } finally {
        if (!options.keepRunning) await stopServer(server, cli);
        else {
            console.log(JSON.stringify({
                keepRunning: true,
                worldDir,
                ports: { gamePort: server.gamePort, cliPort: server.cliPort },
            }, null, 2));
        }
    }
}

function validateReport(report) {
    if(report.bootstrapPlanCheck)assert(report.bootstrapPlanCheck.matches,'Moving the fixed bootstrap investment changed its real plan');
    assert(Array.isArray(report.roomNames), 'room listing missing');
    assert(Array.isArray(report.notifications), 'notification report missing');
    assert(report.notifications.length === 0,
        `runtime notifications detected: ${report.notifications.map((item) => `${item.username || item.userId}: ${item.message}`).join(' | ')}`);
    for (const spec of GENERATION) {
        assert(report.roomNames.includes(spec.room), `missing generated room ${spec.room}`);
    }
    assert(report.roomNames.length >= GENERATION.length, 'generated rooms were not persisted');

    for (const [roomName, memory] of Object.entries(report.rootMemories || {})) {
        assert(memory, `memory missing for ${roomName}`);
        assert(Array.isArray(memory.errors) && memory.errors.length === 0,
            `runtime errors detected in ${roomName}: ${JSON.stringify((memory.errors || []).slice(0, 3))}`);
        assert(Array.isArray(memory.stats) && memory.stats.length > 0, `stats missing for ${roomName}`);
        const lastStat = memory.stats[memory.stats.length - 1];
        assert(lastStat && typeof lastStat.cpu === 'number', `cpu stat missing for ${roomName}`);
        if (memory._validation) {
            assert(memory._validation.errN === 0, `probe errors detected in ${roomName}`);
            const rootRoom = effects.roomProbe({ probeMemories: { [roomName]: memory } }, roomName);
            assert(rootRoom, `room probe missing for ${roomName}`);
            assert(roomName === VISUALS_OFF_ROOM || rootRoom.visualSize == null || rootRoom.visualSize > 0, `room visual missing for ${roomName}`);
        }
        const probe = report.probeMemories && report.probeMemories[roomName];
        assert(probe && probe._validation, `HTTP probe missing for ${roomName}: keys=${JSON.stringify(Object.keys(probe || {}))} diagnostics=${JSON.stringify(probe && probe._readDiagnostics)}`);
        assert(probe._validation.errN === 0, `HTTP probe errors detected in ${roomName}`);
        const probeRoom = effects.roomProbe(report, roomName);
        assert(probeRoom, `HTTP room probe missing for ${roomName}`);
        assert(roomName === VISUALS_OFF_ROOM || probeRoom.visualSize == null || probeRoom.visualSize > 0,
            `HTTP room visual missing for ${roomName}`);
    }
    // 生效断言：每个改动都要在私服里观察到（scripts/private_server/effects.js）。
    // 收集全部失败再一次性抛：过去在第一条失败就抛出，后面的断言根本没被评估——
    // 一轮验证要 15–20 分钟，只看到一个失败等于每个失败都要单独跑一轮。
    const effectFailures = [];
    effects.assertEffects(report, ROOMS, (condition, message) => { if (!condition) effectFailures.push(message); });
    if (effectFailures.length) {
        throw new Error(`生效断言未通过 ${effectFailures.length} 条：\n- ${effectFailures.join('\n- ')}`);
    }

    const bootstrap = report.rootMemories[ROOMS.bootstrap];
    assert(bootstrap && bootstrap.rooms && bootstrap.rooms[ROOMS.bootstrap] && bootstrap.rooms[ROOMS.bootstrap].state, 'bootstrap memory missing');

    const recovery = report.rootMemories[ROOMS.recovery];
    assert(recovery && recovery.rooms && recovery.rooms[ROOMS.recovery] && recovery.rooms[ROOMS.recovery].plan, 'recovery plan missing');

    const logistics = report.rootMemories[ROOMS.logistics];
    assert(logistics && logistics.rooms && logistics.rooms[ROOMS.logistics] && logistics.rooms[ROOMS.logistics].plan, 'logistics plan missing');

    const links = report.rootMemories[ROOMS.links];
    assert(links && links.rooms && links.rooms[ROOMS.links] && links.rooms[ROOMS.links].plan && links.rooms[ROOMS.links].plan.links, 'links plan missing');

    const blueprint = report.rootMemories[ROOMS.blueprint];
    assert(blueprint, 'blueprint memory missing');
    // 布局唯一来源是轮子：RCL8 空内存的房应在引擎里跑出完整的轮子方案
    const wheelPlan = blueprint.rooms && blueprint.rooms[ROOMS.blueprint] && blueprint.rooms[ROOMS.blueprint].plan;
    assert(wheelPlan && wheelPlan.wheel === true && wheelPlan.version === 'wheel-layout-2.1.0',
        `wheel plan missing for ${ROOMS.blueprint}: ${JSON.stringify(wheelPlan && { version: wheelPlan.version, wheel: wheelPlan.wheel, err: blueprint.rooms[ROOMS.blueprint].planError })}`);
    // 轮子文档：受地形/其它建筑阻挡时 extension/tower 可能摆不满，放宽为下限
    assert(wheelPlan.ext.length >= 50 && wheelPlan.towers.length >= 5 && wheelPlan.labs.length === 10 && wheelPlan.spawns.length === 3 && wheelPlan.storage && wheelPlan.terminal,
        `wheel plan incomplete: ext=${wheelPlan.ext.length} towers=${wheelPlan.towers.length} labs=${wheelPlan.labs.length} spawns=${wheelPlan.spawns.length}`);
    assert(wheelPlan.containers.src0 && wheelPlan.containers.src1 && wheelPlan.containers.ctrl, 'wheel plan lacks derived containers');

    const industry = report.rootMemories[ROOMS.industry];
    assert(industry && industry.rooms && industry.rooms[ROOMS.industry] && industry.rooms[ROOMS.industry].industry, 'industry memory missing');

    const remote = report.rootMemories[ROOMS.remoteHome];
    assert(remote && remote.rooms && remote.rooms[ROOMS.remoteHome] && remote.rooms[ROOMS.remoteHome].plan, 'remote memory missing');

    const conflict = report.rootMemories[ROOMS.conflict];
    assert(conflict && conflict.rooms && conflict.rooms[ROOMS.conflict] && conflict.rooms[ROOMS.conflict].plan, 'conflict memory missing');

    const brain = report.rootMemories[ROOMS.brainHome];
    assert(brain && brain.rooms && brain.rooms[ROOMS.brainHome] && brain.rooms[ROOMS.brainHome].plan, 'brain memory missing');
    // 占领目标（brainRemote）不再兼作外矿，外矿应落到另一相邻房（brainRemote2）
    assert(report.brainResult && report.brainResult.plans && report.brainResult.plans[ROOMS.brainHome] &&
        report.brainResult.plans[ROOMS.brainHome].remotes.includes(ROOMS.brainRemote2) &&
        !report.brainResult.plans[ROOMS.brainHome].remotes.includes(ROOMS.brainRemote),
        `external brain remotes wrong: ${JSON.stringify(report.brainResult && report.brainResult.plans)}`);
    assert(brain.brain && brain.brain.ack && brain.brain.ack.issuedAt === brain.brain.issuedAt,
        'bot did not ingest the segment directive (no ack)');
    // 情报合并以游戏内回执为准（预热期孵化的 scout 可能随后用自己的记录覆盖同一房间）
    assert(brain.map && brain.map[ROOMS.brainRemote2], 'no Memory.map entry for the remote room');
    const applied = (brain.brain.ack.applied || []).find((item) => /^intel:\d+$/.test(item));
    assert(applied && Number(applied.split(':')[1]) >= 1, `external intel was not merged into Memory.map: ${JSON.stringify(brain.brain.ack)}`);
    const brainRemotes = brain.rooms[ROOMS.brainHome].remotes || {};
    assert(brainRemotes[ROOMS.brainRemote2] && brainRemotes[ROOMS.brainRemote2].enabled === true,
        `remote ${ROOMS.brainRemote2} not admitted from external intel: ${JSON.stringify(Object.keys(brainRemotes))}`);
    const claim = report.brainResult.plans[ROOMS.brainHome].claim;
    // spawn 位不再由大脑给出（布局唯一来源是新房自己的轮子方案），指令只带房名
    assert(claim && claim.room === ROOMS.brainRemote, `external brain did not plan the claim: ${JSON.stringify(claim)}`);
    assert(brain.rooms[ROOMS.brainRemote], `claimer did not take ${ROOMS.brainRemote} (no room memory yet): creeps=${JSON.stringify(Object.keys(brain.creeps || {}))}`);

    // 防御场景：无塔的 RCL3 母房被塞了两只 Invader；bot 应派 defender（或开盾），结束时该房不再有敌对 creep
    const defense = report.rootMemories[ROOMS.defenseHome];
    assert(defense && defense.rooms && defense.rooms[ROOMS.defenseHome], 'defense memory missing');
    const defenseCreeps = Object.keys(defense.creeps || {});
    const defenseProbe = ((report.probeMemories[ROOMS.defenseHome] || {})._validation || {}).room || {};
    const defenseDiag = JSON.stringify({ hostiles: defenseProbe.hostiles, defense: defenseProbe.defense, safeMode: defenseProbe.safeMode,
        energy: defenseProbe.energy, cap: defenseProbe.cap, creeps: (defenseProbe.creeps || []).map((c) => c.name + '@' + c.x + ',' + c.y),
        demand: defense.rooms[ROOMS.defenseHome].demand && defense.rooms[ROOMS.defenseHome].demand.targets,
        state: defense.rooms[ROOMS.defenseHome].state });
    // defender 清场后会退役，结束时不一定还活着：以 defenseLog 遥测为准
    const defenseLog = defense.rooms[ROOMS.defenseHome].defenseLog;
    assert(defenseLog && defenseLog.spawned >= 1,
        `no defender was spawned in ${ROOMS.defenseHome}: creeps=${JSON.stringify(defenseCreeps)} diag=${defenseDiag} early=${JSON.stringify(report.earlyDefense)}`);
    assert(report.hostileCounts[ROOMS.defenseHome] === 0,
        `invaders still alive in ${ROOMS.defenseHome}: ${report.hostileCounts[ROOMS.defenseHome]}`);
}

/** 上一轮验证的私服进程还在收尾时立刻起新一轮，会撞上它的端口（"CLI connection is closed"）：先等它退出。 */
async function waitForLeftoverServers(maxMs) {
    const { execSync } = require('child_process');
    const deadline = Date.now() + maxMs;
    let waited = false;
    for (;;) {
        let leftovers = '';
        try {
            leftovers = execSync("ps -axo pid=,command= | grep -E '[l]auncher_entry|[s]creeps-launcher' || true", { encoding: 'utf8' }).trim();
        } catch (error) { leftovers = ''; }
        if (!leftovers || Date.now() >= deadline) {
            if (waited) await sleep(5000);
            return;
        }
        waited = true;
        await sleep(2000);
    }
}

function scenarioSeedInfo(file) {
    const bytes=fs.readFileSync(file);
    const db=JSON.parse(bytes);
    const collection=(db.collections||[]).find(c=>c.name==='env');
    const env=collection&&collection.data&&collection.data[0]&&collection.data[0].data;
    if (!env || String(env.mainLoopPaused)!=='1' || !Number.isFinite(Number(env.gameTime)))
        throw new Error('Scenario seed must contain a paused simulation and finite gameTime');
    return {source:path.resolve(file),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),tick:Number(env.gameTime),paused:true};
}

async function main(argv) {
    loadProjectEnv();
    const args = parseArgs(argv);
    if (args.help) {
        console.log(usage());
        return 0;
    }
    await waitForLeftoverServers(90000);

    const serverDir = resolveServerDir(args.serverDir);
    let worldDir = chooseWorldDir(args.worldDir);
    const seedInfo=args.seedDb ? scenarioSeedInfo(args.seedDb) : null;
    if (seedInfo && worldDir && fs.existsSync(worldDir) && fs.readdirSync(worldDir).length)
        throw new Error('Refusing to restore a scenario seed over a non-empty world: '+worldDir);
    if (worldDir) {
        const modsPath = path.join(worldDir, 'mods.json');
        if (!fs.existsSync(modsPath)) createWorld({ serverDir, worldDir });
    } else {
        worldDir = createWorld({ serverDir }).worldDir;
    }

    console.log(JSON.stringify({
        worldDir,
        serverDir,
        keepRunning: !!args.keepRunning,
    }, null, 2));

    if (seedInfo) {
        fs.copyFileSync(seedInfo.source,path.join(worldDir,'db.json'));
        fs.writeFileSync(path.join(worldDir,'seed-origin.json'),JSON.stringify(seedInfo,null,2));
        args.seedTick=seedInfo.tick;
    }
    else {
    await phaseOne(worldDir, serverDir, args.tickDuration, args.seedWaitMs, {
        gamePort: args.gamePort,
        cliPort: args.cliPort,
    });
    }
    const report = await phaseTwo(worldDir, serverDir, args);
    fs.writeFileSync(path.join(worldDir, 'validation-report.json'), JSON.stringify(report, null, 2));
    validateReport(report);
    // 无回归：与上一次通过的基线比（data/validation/baseline.json）；硬回归算失败，抖动只警告
    const current = baseline.metrics(report);
    const previous = baseline.load();
    const regression = baseline.compare(previous, current);
    for (const warning of regression.warnings) console.error('[baseline] warn: ' + warning);
    assert(regression.failures.length === 0, `regression against the last passing baseline: ${regression.failures.join(' | ')}`);
    baseline.save(current);

    console.log(JSON.stringify({
        ok: true,
        rooms: report.roomNames,
        runtime: Object.fromEntries(Object.entries(report.rootMemories || {}).map(([roomName, memory]) => [
            roomName,
            memory && memory._validation ? {
                t: memory._validation.t,
                errN: memory._validation.errN,
                cpu: memory._validation.cpu,
                cpuLimit: memory._validation.cpuLimit,
            } : null,
        ])),
        notificationErrors: report.notifications.length,
        effects: effects.EFFECTS.map((effect) => effect.id),
        baselineWarnings: regression.warnings,
    }, null, 2));

    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }).catch((error) => {
        console.error(error && error.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {
    main,
    waitMarketHistory,
    parseArgs,
    usage,
    validateReport,
    phaseOne,
    phaseTwo,
    persistMarker,
    readErrorNotifications,
    waitForGameTime,
    waitForGameTimeWithObserver,
    waitForLeftoverServers,
    waitForHttpReady,
    stopServer,
    httpJson,
    decodeMemoryPayload,
    getUserId,
    mintAuthToken,
    readUserMemory,
    readRootMemory,
    chooseWorldDir,
    scenarioSeedInfo,
    bootstrapRoadMove,
    prepareUpgraderRoute,
    wrapperInstallExpression,
};
