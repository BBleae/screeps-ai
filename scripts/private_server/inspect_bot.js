#!/usr/bin/env node
'use strict';
/**
 * 对 --keep-running 的私服取证：读某个验证用户的根 Memory 片段、房间对象与最近统计。
 * 用法：node scripts/private_server/inspect_bot.js --cli-port 21026 --username ValidationBrain --room E11S11 [--path rooms.E11S11.demand]
 */
const { CliClient } = require('./cli_client');

function parseArgs(argv) {
    const args = { cliPort: 21026, username: 'ValidationBrain', room: 'E11S11', paths: [] };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--cli-port') { args.cliPort = Number(value); i++; }
        else if (key === '--username') { args.username = value; i++; }
        else if (key === '--room') { args.room = value; i++; }
        else if (key === '--path') { args.paths.push(value); i++; }
    }
    return args;
}

function dig(object, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cli = new CliClient({ port: args.cliPort, timeoutMs: 20000 });
    await cli.connect();
    try {
        const user = await cli.evaluateJson(
            `storage.db.users.findOne({username:${JSON.stringify(args.username)}}).then(function(u){return u&&{id:String(u._id),gcl:u.gcl,cpu:u.cpu}})`);
        const memory = await cli.evaluateJson(
            `storage.env.get(storage.env.keys.MEMORY+${JSON.stringify(user.id)}).then(function(raw){return raw?JSON.parse(raw):null})`);
        const time = Number(await cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)'));
        const objects = await cli.evaluateJson(
            `storage.db['rooms.objects'].find({room:${JSON.stringify(args.room)}}).then(function(list){return list.filter(function(o){return o.type==='creep'||o.type==='spawn'||o.type==='extension'||o.type==='container'}).map(function(o){return {type:o.type,name:o.name,x:o.x,y:o.y,energy:o.store&&o.store.energy,ttl:o.ageTime?o.ageTime-${'0'}:null,spawning:o.spawning?1:0,body:o.body&&o.body.length}})})`);
        const out = { time, user, room: args.room };
        out.objects = objects;
        out.creepsMemory = Object.keys(memory && memory.creeps || {});
        out.errors = memory && memory.errors;
        out.stats = memory && Array.isArray(memory.stats) ? memory.stats.slice(-6) : null;
        for (const path of args.paths) out[path] = dig(memory, path);
        if (!args.paths.length) {
            out.demand = dig(memory, 'rooms.' + args.room + '.demand');
            out.state = dig(memory, 'rooms.' + args.room + '.state');
            out.brainAck = dig(memory, 'brain.ack');
            out.brainRooms = dig(memory, 'brain.rooms');
        }
        console.log(JSON.stringify(out, null, 1));
    } finally {
        cli.close && cli.close();
        process.exit(0);
    }
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
