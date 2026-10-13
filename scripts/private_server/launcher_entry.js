'use strict';

const path = require('path');
const { loadProjectEnv, requireEnvironment } = require('./env');

loadProjectEnv();

const serverDir = path.resolve(requireEnvironment('SCREEPS_PRIVATE_SERVER_DIR'));
const start = require(path.join(serverDir, 'node_modules', '@screeps', 'launcher', 'lib', 'start'));

const options = {
    port: requireEnvironment('SCREEPS_PRIVATE_GAME_PORT'),
    cli_port: requireEnvironment('SCREEPS_PRIVATE_CLI_PORT'),
    host: process.env.SCREEPS_PRIVATE_HOST || '127.0.0.1',
    cli_host: process.env.SCREEPS_PRIVATE_CLI_HOST || '127.0.0.1',
    runners_cnt: process.env.SCREEPS_PRIVATE_RUNNERS,
    runner_threads: process.env.SCREEPS_PRIVATE_RUNNER_THREADS || '2',
    processors_cnt: process.env.SCREEPS_PRIVATE_PROCESSORS || '1',
    restart_interval: '0',
    steam_api_key: requireEnvironment('STEAM_API_KEY'),
};

start(options, process.stdout).catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
