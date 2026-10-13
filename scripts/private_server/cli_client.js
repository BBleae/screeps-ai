'use strict';

const net = require('net');

class CliError extends Error {
    constructor(message, command) {
        super(message);
        this.name = 'CliError';
        this.command = command;
    }
}

function resultLine(buffer) {
    const match = /(?:^|\r?\n)< ([^\r\n]*)\r?\n/.exec(buffer);
    if (!match) return null;
    return {
        value: match[1],
        rest: buffer.slice(match.index + match[0].length),
    };
}

function parseCliScalar(value) {
    const text = String(value == null ? '' : value).trim();
    if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
        return text.slice(1, -1)
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, '\\');
    }
    if (text.length >= 2 && text[0] === '`' && text[text.length - 1] === '`') {
        return text.slice(1, -1)
            .replace(/\\`/g, '`')
            .replace(/\\\\/g, '\\');
    }
    return text;
}

class CliClient {
    constructor(options) {
        const opts = options || {};
        this.host = opts.host || '127.0.0.1';
        this.port = Number(opts.port || 21026);
        this.timeoutMs = Number(opts.timeoutMs || 15000);
        this.socket = null;
        this.buffer = '';
        this.pending = null;
        this.connected = null;
        this.closed = false;
    }

    connect() {
        if (this.connected) return this.connected;
        this.connected = new Promise((resolve, reject) => {
            const socket = net.connect(this.port, this.host);
            this.socket = socket;
            socket.setEncoding('utf8');
            let greeting = '';
            let ready = false;
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Timed out connecting to CLI ${this.host}:${this.port}`));
            }, this.timeoutMs);

            socket.on('data', (chunk) => {
                if (!ready) {
                    greeting += chunk;
                    const first = resultLine(greeting);
                    if (!first) return;
                    ready = true;
                    clearTimeout(timer);
                    this.buffer = first.rest;
                    resolve(this);
                } else {
                    this.buffer += chunk;
                }
                this.consume();
            });
            socket.on('error', (error) => {
                if (!ready) {
                    clearTimeout(timer);
                    reject(error);
                }
                if (this.pending) {
                    this.pending.reject(error);
                    this.pending = null;
                }
            });
            socket.on('close', () => {
                this.closed = true;
                const error = new Error('Screeps CLI connection closed');
                if (!ready) {
                    clearTimeout(timer);
                    reject(error);
                }
                if (this.pending) {
                    this.pending.reject(error);
                    this.pending = null;
                }
            });
        });
        return this.connected;
    }

    consume() {
        if (!this.pending) return;
        const result = resultLine(this.buffer);
        if (!result) return;
        this.buffer = result.rest;
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(result.value);
    }

    /** 服务器启动期 CLI 端会偶发关闭连接（"CLI connection is closed"）：重置状态后重连，而不是让整轮验证失败 */
    async reconnect() {
        if (this.socket) { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
        this.socket = null;
        this.connected = null;
        this.closed = false;
        this.buffer = '';
        this.pending = null;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return this.connect();
    }

    async run(command, options) {
        if (typeof command !== 'string' || !command.trim()) {
            throw new TypeError('CLI command must be a non-empty string');
        }
        if (/[\r\n]/.test(command)) throw new TypeError('CLI command must be one line');
        const attempts = Math.max(1, Number(options && options.attempts) || 8);
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                if (this.closed) await this.reconnect();
                else await this.connect();
                if (this.closed || !this.socket) throw new Error('CLI connection is closed');
                return await this.runOnce(command, options);
            } catch (error) {
                lastError = error;
                const message = String(error && error.message || error);
                const transient = /connection (?:is )?closed|ECONNRESET|EPIPE|ECONNREFUSED/i.test(message);
                if (!transient || attempt === attempts - 1) throw error;
                this.closed = true;
            }
        }
        throw lastError;
    }

    async runOnce(command, options) {
        if (this.pending) throw new Error('Concurrent CLI commands are not supported');
        const timeoutMs = Number(options && options.timeoutMs || this.timeoutMs);
        const value = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending = null;
                reject(new CliError(`Timed out after ${timeoutMs}ms`, command));
            }, timeoutMs);
            this.pending = { resolve, reject, timer };
            this.socket.write(command + '\r\n');
            this.consume();
        });
        if (value.startsWith('Error: ')) throw new CliError(value.slice(7), command);
        if (/^(?:SyntaxError|TypeError|ReferenceError|RangeError):/.test(value)) {
            throw new CliError(value, command);
        }
        return value;
    }

    async runJson(command, options) {
        const value = parseCliScalar(await this.run(command, options));
        try {
            return JSON.parse(value);
        } catch (error) {
            throw new CliError(`CLI command did not return JSON: ${value}`, command);
        }
    }

    async evaluateJson(expression, options) {
        const key = `__validation_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
        const keyLiteral = JSON.stringify(key);
        const command = `Promise.resolve(${expression}).then(function(value){globalThis[${keyLiteral}]=JSON.stringify({ok:true,value:value});return 'READY'},function(error){globalThis[${keyLiteral}]=JSON.stringify({ok:false,error:String(error&&error.stack||error)});return 'READY'})`;
        await this.run(command, options);
        const envelope = await this.runJson(`globalThis[${keyLiteral}]`, options);
        await this.run(`delete globalThis[${keyLiteral}]`, options);
        if (!envelope || !envelope.ok) {
            throw new CliError(envelope && envelope.error || 'CLI promise failed', expression);
        }
        return envelope.value;
    }

    async close() {
        if (!this.socket || this.closed) return;
        const socket = this.socket;
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                socket.destroy();
                resolve();
            }, 1000);
            socket.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
            socket.end();
        });
    }
}

async function waitForCli(options) {
    const opts = options || {};
    const timeoutMs = Number(opts.waitTimeoutMs || 30000);
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        const client = new CliClient(opts);
        try {
            await client.connect();
            return client;
        } catch (error) {
            lastError = error;
            await client.close().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Timed out waiting for private server CLI: ${lastError && lastError.message || 'unavailable'}`);
}

module.exports = { CliClient, CliError, parseCliScalar, waitForCli };
