'use strict';
/** Destructive fixture check for an explicitly selected, disposable validation world.
 * Run after run_validation --keep-running. Never points at the public server.
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { CliClient } = require('./cli_client');
const { getUserId, readRootMemory, mintAuthToken, waitForGameTime, httpJson } = require('./run_validation');

async function main() {
    const [cliPort, gamePort, output] = process.argv.slice(2);
    assert(cliPort && gamePort && output, 'usage: mineral_lifecycle.js CLI_PORT GAME_PORT OUTPUT_DIR');
    const cli = new CliClient({ port: Number(cliPort) });
    await cli.connect();
    const room = 'E40S40';
    const username = 'ValidationIndustry';
    const id = await getUserId(cli, username);
    assert(id, 'selected world is not the disposable industry fixture');
    const tick = () => cli.evaluateJson('storage.env.get(storage.env.keys.GAMETIME)').then(Number);
    const objects = () => cli.evaluateJson(`storage.db['rooms.objects'].find({room:${JSON.stringify(room)}})`);
    async function brain() {
        const token = await mintAuthToken(cli, id);
        execFileSync('python3', [path.join(__dirname, '../brain/run.py'), '--server', 'private',
            '--base-url', 'http://127.0.0.1:' + gamePort, '--username', username, '--token', token,
            '--homes', room, '--radius', '0', '--write', '--out', path.resolve(output), '--min-interval', '0'],
        { encoding: 'utf8', timeout: 120000 });
        await waitForGameTime(cli, await tick() + 3, 30000);
        return (await readRootMemory(cli, id)).brain.rooms[room].mineral;
    }
    try {
        const initial = await objects();
        const mineral = initial.find(o => o.type === 'mineral');
        const extractor = initial.find(o => o.type === 'extractor');
        assert(mineral && extractor);
        await cli.run('system.pauseSimulation()');
        await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${JSON.stringify(mineral._id)}},{$set:{mineralAmount:0,nextRegenerationTime:${await tick() + 40}}}).then(function(){return true})`);
        await cli.run('system.resumeSimulation()');
        const depleted = await brain();
        assert(!depleted.enabled && depleted.reason === 'depleted', 'brain did not stop depleted mining');
        await cli.run('system.pauseSimulation()');
        await cli.evaluateJson(`storage.db['rooms.objects'].removeWhere({_id:${JSON.stringify(extractor._id)}}).then(function(){return true})`);
        await cli.run('system.resumeSimulation()');
        const rebuilding = await brain();
        assert(rebuilding.build && !rebuilding.enabled && rebuilding.reason === 'extractor');
        let site;
        for (let tries = 0; tries < 8; tries++) {
            site = (await objects()).find(o => o.type === 'constructionSite' && o.structureType === 'extractor');
            if (site) break;
            await waitForGameTime(cli, await tick() + 25, 30000);
        }
        assert(site && site.x === mineral.x && site.y === mineral.y, 'project did not place extractor site');
        // Shorten only fixture construction time; require the real builder and engine
        // to complete the last progress, rather than inserting a built extractor.
        await cli.run('system.pauseSimulation()');
        const current = await objects();
        const worker = current.find(o => o.type === 'creep' && o.user === id &&
            (o.store || {}).energy > 0 && o.body.some(p => p.type === 'work' && p.hits > 0));
        assert(worker, 'no fixture builder candidate');
        const stand = rebuilding.stand;
        await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${JSON.stringify(site._id)}},{$set:{progress:${site.progressTotal - 1}}}).then(function(){return true})`);
        await cli.evaluateJson(`storage.db['rooms.objects'].update({_id:${JSON.stringify(worker._id)}},{$set:{x:${stand.x},y:${stand.y},fatigue:0}}).then(function(){return true})`);
        // Console mutates the live Memory object; a raw Memory write would be
        // overwritten by the production parsed-Memory reuse cache.
        const token = await mintAuthToken(cli, id);
        const changed = await httpJson('POST', Number(gamePort), '/api/user/console', {
            expression: `Memory.creeps[${JSON.stringify(worker.name)}]={home:${JSON.stringify(room)},role:'builder'}`,
        }, { 'X-Username': username, 'X-Token': token });
        assert(changed && changed.ok === 1);
        await cli.run('system.resumeSimulation()');
        let rebuilt;
        for (let tries = 0; tries < 8; tries++) {
            await waitForGameTime(cli, await tick() + 20, 30000);
            rebuilt = (await objects()).find(o => o.type === 'extractor');
            if (rebuilt) break;
        }
        assert(rebuilt && rebuilt._id !== extractor._id, 'real builder did not finish extractor');
        const resumed = await brain();
        assert(resumed.enabled && resumed.extractorId === rebuilt._id, 'brain did not resume after regeneration and rebuilding');
        console.log(JSON.stringify({ ok: true, depletionStopped: true, sitePlaced: site._id, extractorBuilt: rebuilt._id,
            regenerated: resumed.enabled, tick: await tick() }));
    } finally {
        await cli.run('system.resumeSimulation()');
        cli.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
