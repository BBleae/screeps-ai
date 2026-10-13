'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function parseValue(value) {
    const trimmed = String(value == null ? '' : value).trim();
    if (trimmed.length < 2) return trimmed;
    const quote = trimmed[0];
    if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed;
    const inner = trimmed.slice(1, -1);
    if (quote === "'") return inner.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    return inner
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
}

function loadProjectEnv(filename) {
    const envPath = path.resolve(filename || path.join(PROJECT_ROOT, '.env'));
    if (!fs.existsSync(envPath)) return {};
    const loaded = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const name = match[1];
        const value = parseValue(match[2]);
        loaded[name] = value;
        if (!(name in process.env)) process.env[name] = value;
    }
    return loaded;
}

function requireEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is missing; add it to ${path.join(PROJECT_ROOT, '.env')}`);
    return value;
}

module.exports = { PROJECT_ROOT, loadProjectEnv, parseValue, requireEnvironment };
