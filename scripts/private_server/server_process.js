'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { waitForCli } = require('./cli_client');
const { loadProjectEnv, requireEnvironment } = require('./env');

const ROOT = path.resolve(__dirname, '..', '..');

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function freePort(host) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, host || '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

function waitForPort(options) {
    const opts = options || {};
    const host = opts.host || '127.0.0.1';
    const port = Number(opts.port);
    const timeoutMs = Number(opts.waitTimeoutMs || 30000);
    const deadline = Date.now() + timeoutMs;
    let lastError;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (Date.now() >= deadline) {
                reject(new Error(`Timed out waiting for ${host}:${port}: ${lastError && lastError.message || 'unavailable'}`));
                return;
            }
            const socket = net.connect(port, host);
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                if (!error) resolve();
                else {
                    lastError = error;
                    setTimeout(attempt, 100);
                }
            };
            socket.once('connect', () => finish());
            socket.once('error', finish);
            socket.once('close', () => {
                if (!settled) finish(new Error('connection closed'));
            });
        };
        attempt();
    });
}

function resolveServerDir(value) {
    const serverDir = path.resolve(value || process.env.SCREEPS_PRIVATE_SERVER_DIR ||
        path.join(ROOT, 'private-server', 'server'));
    const launcher = path.join(serverDir, 'bin', 'screeps.js');
    const initDist = path.join(serverDir, 'node_modules', '@screeps', 'launcher', 'init_dist');
    if (!fs.existsSync(launcher) || !fs.existsSync(initDist)) {
        throw new Error(`Screeps private server is not installed at ${serverDir}; run setup.sh first`);
    }
    return serverDir;
}

function sourceModules(version, root) {
    // root：可选，指定另一棵源码树（例如 git archive 导出的历史版本），默认用工作树
    const base = root ? path.resolve(root) : ROOT;
    const modules = {};
    const sourceDir = path.join(base, 'src');
    const visit = (directory) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const full = path.join(directory, name);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) visit(full);
            else if (stat.isFile() && name.endsWith('.js')) {
                const relative = path.relative(sourceDir, full).replace(/\\/g, '/');
                modules[relative.slice(0, -3).replace(/\//g, '_')] = fs.readFileSync(full, 'utf8');
            }
        }
    };
    visit(sourceDir);

    const wheelFiles = [
        ['layout-2.1.0/MinCut.js', 'MinCut'],
        ['layout-2.1.0/RoomVisual.js', 'RoomVisual'],
        ['layout-2.1.0/planner.js', 'wheel_layout_planner'],
        ['movement-1.0.3/moveMatch.js', 'moveMatch'],
        ['movement-1.0.3/超级移动优化.js', 'wheel_movement_engine'],
    ];
    for (const [relative, moduleName] of wheelFiles) {
        const full = path.join(base, 'vendor', 'wheels', relative);
        if (!fs.existsSync(full)) throw new Error(`Missing wheel module ${full}`);
        modules[moduleName] = fs.readFileSync(full, 'utf8');
    }
    modules.version = `${modules.version || ''}\nglobal.SCRIPT_VERSION = ${Number(version || Date.now())};\n`;
    return modules;
}

function createWorld(options) {
    const opts = options || {};
    const serverDir = resolveServerDir(opts.serverDir);
    const version = Number(opts.version || Date.now());
    const worldRoot = path.resolve(opts.worldRoot || path.join(ROOT, 'private-server', 'worlds'));
    fs.mkdirSync(worldRoot, { recursive: true });
    const worldDir = opts.worldDir ? path.resolve(opts.worldDir) :
        fs.mkdtempSync(path.join(worldRoot, 'validation-'));
    if (opts.worldDir) {
        if (fs.existsSync(worldDir) && fs.readdirSync(worldDir).length) {
            throw new Error(`Refusing to overwrite non-empty world directory ${worldDir}`);
        }
        fs.mkdirSync(worldDir, { recursive: true });
    }

    const initDist = path.join(serverDir, 'node_modules', '@screeps', 'launcher', 'init_dist');
    fs.cpSync(initDist, worldDir, { recursive: true });
    const botDir = path.join(worldDir, 'project-bot');
    fs.mkdirSync(botDir, { recursive: true });
    const modules = sourceModules(version, opts.srcRoot);
    for (const [moduleName, source] of Object.entries(modules)) {
        fs.writeFileSync(path.join(botDir, moduleName + '.js'), source, 'utf8');
    }
    const validationMod = path.join(ROOT, 'scripts', 'private_server', 'validation_mod.js');
    fs.writeFileSync(path.join(worldDir, 'mods.json'), JSON.stringify({
        // The server resolves cwd symlinks; a relative path could load another worktree.
        mods: [fs.realpathSync(validationMod)],
        bots: { project: botDir },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(worldDir, '.screepsrc'), [
        'host = 127.0.0.1',
        'cli_host = 127.0.0.1',
        'password =',
        'runners_cnt = 1',
        'runner_threads = 1',
        'processors_cnt = 1',
        'logdir = logs',
        'modfile = mods.json',
        'assetdir = assets',
        'db = db.json',
        'log_console = false',
        'log_rotate_keep = 4',
        'storage_disabled = false',
        'restart_interval = 0',
        '',
    ].join('\n'));
    return { serverDir, worldDir, botDir, modules, version };
}

class PrivateServer {
    constructor(options) {
        const opts = options || {};
        this.serverDir = resolveServerDir(opts.serverDir);
        this.worldDir = path.resolve(opts.worldDir);
        this.host = opts.host || '127.0.0.1';
        this.gamePort = opts.gamePort || null;
        this.cliPort = opts.cliPort || null;
        this.runnersCnt = opts.runnersCnt == null ? null : Number(opts.runnersCnt);
        if (this.runnersCnt != null && (!Number.isInteger(this.runnersCnt) || this.runnersCnt < 0)) {
            throw new Error(`Invalid private server runner count: ${opts.runnersCnt}`);
        }
        this.processorsCnt = opts.processorsCnt == null ? 1 : Number(opts.processorsCnt);
        if (!Number.isInteger(this.processorsCnt) || this.processorsCnt < 1) {
            throw new Error(`Invalid private server processor count: ${opts.processorsCnt}`);
        }
        this.runnerThreads = opts.runnerThreads == null ? 2 : Number(opts.runnerThreads);
        if (!Number.isInteger(this.runnerThreads) || this.runnerThreads < 1) {
            throw new Error(`Invalid private server runner thread count: ${opts.runnerThreads}`);
        }
        this.child = null;
        this.logStream = null;
    }

    async start() {
        if (this.child) throw new Error('Private server is already running');
        loadProjectEnv();
        requireEnvironment('STEAM_API_KEY');
        if (!this.gamePort) this.gamePort = await freePort(this.host);
        if (!this.cliPort) this.cliPort = await freePort(this.host);
        const logPath = path.join(this.worldDir, 'validation-launcher.log');
        this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
        const launcherEntry = path.join(ROOT, 'scripts', 'private_server', 'launcher_entry.js');
        const child = spawn(process.execPath, [launcherEntry], {
            cwd: this.worldDir,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, {
                SCREEPS_PRIVATE_SERVER_DIR: this.serverDir,
                SCREEPS_PRIVATE_GAME_PORT: String(this.gamePort),
                SCREEPS_PRIVATE_CLI_PORT: String(this.cliPort),
                SCREEPS_PRIVATE_HOST: this.host,
                SCREEPS_PRIVATE_CLI_HOST: this.host,
                ...(this.runnersCnt == null ? {} : { SCREEPS_PRIVATE_RUNNERS: String(this.runnersCnt) }),
                SCREEPS_PRIVATE_RUNNER_THREADS: String(this.runnerThreads),
                SCREEPS_PRIVATE_PROCESSORS: String(this.processorsCnt),
            }),
        });
        this.child = child;
        child.stdout.pipe(this.logStream, { end: false });
        child.stderr.pipe(this.logStream, { end: false });
        const earlyExit = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => reject(new Error(
                `Private server exited before CLI was ready (code=${code}, signal=${signal})`)));
        });
        try {
            const cli = await Promise.race([
                waitForCli({ host: this.host, port: this.cliPort, waitTimeoutMs: 45000 }),
                earlyExit,
            ]);
            await waitForPort({ host: this.host, port: this.gamePort, waitTimeoutMs: 45000 });
            return cli;
        } catch (error) {
            await this.stop().catch(() => {});
            throw new Error(`${error.message}; see ${logPath}`);
        }
    }

    async stop() {
        const child = this.child;
        if (!child) return;
        this.child = null;
        const exited = new Promise((resolve) => {
            if (child.exitCode != null || child.signalCode != null) {
                resolve();
                return;
            }
            child.once('exit', resolve);
        });
        try {
            // Stop the launcher first. Its child-process exit handlers otherwise
            // restart workers after a process-group TERM reaches them.
            child.kill('SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH' && error.code !== 'EINVAL') throw error;
        }
        await Promise.race([exited, sleep(3000)]);
        if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 1) {
            try {
                // Workers are intentionally force-killed after the launcher has
                // exited, so no orphan can survive a validation run.
                process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
                // 进程组已不存在（ESRCH）或已被回收成别的组（EPERM）都视为已停止
                if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
            }
        } else if (child.exitCode == null && child.signalCode == null) {
            try { child.kill('SIGKILL'); } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
        await Promise.race([exited, sleep(2000)]);
        if (this.logStream) {
            const stream = this.logStream;
            this.logStream = null;
            await new Promise((resolve) => stream.end(resolve));
        }
    }
}

module.exports = {
    ROOT,
    PrivateServer,
    createWorld,
    freePort,
    waitForPort,
    resolveServerDir,
    sleep,
    sourceModules,
};
