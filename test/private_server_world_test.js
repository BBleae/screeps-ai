'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorld, ROOT } = require('../scripts/private_server/server_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-mod-path-'));
try {
    const serverDir = path.join(root, 'server');
    fs.mkdirSync(path.join(serverDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'bin', 'screeps.js'), '');
    fs.mkdirSync(path.join(serverDir, 'node_modules', '@screeps', 'launcher', 'init_dist'), { recursive: true });
    const physical = path.join(root, 'physical', 'nested', 'worlds');
    fs.mkdirSync(physical, { recursive: true });
    const alias = path.join(root, 'shared-worlds');
    fs.symlinkSync(physical, alias, 'dir');
    const world = createWorld({ serverDir, worldRoot: alias, version: 1 });
    const mods = JSON.parse(fs.readFileSync(path.join(world.worldDir, 'mods.json'), 'utf8'));
    const resolved = path.resolve(fs.realpathSync(world.worldDir), mods.mods[0]);
    assert.strictEqual(resolved, fs.realpathSync(path.join(ROOT, 'scripts/private_server/validation_mod.js')),
        'a symlinked private-server world must load the originating worktree validation mod');
    assert(fs.existsSync(path.join(world.botDir, 'main.js')), 'the world keeps the originating game modules');
    console.log('private world: mod provenance survives shared directory symlinks');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
