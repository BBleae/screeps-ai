// 轮子 isSameOps：危险名单（显式 avoidRooms）变化时，不经过回避房的缓存路沿用，经过的才重算
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'vendor/wheels/movement-1.0.3/超级移动优化.js'), 'utf8');
function grab(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('missing ' + name);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    return src.slice(start, i + 1);
}
const code = ['let routePolicyVersion = 0; let avoidKeptPaths = 0; const optionFunctionIds = new Map(); let nextOptionFunctionId = 1;',
    grab('optionFunctionId'), grab('setKey'), grab('mapKey'), grab('pathOptionsKey'), grab('isSameOps'),
    'module.exports = { isSameOps, pathOptionsKey, kept: () => avoidKeptPaths };'].join('\n');
const ctx = { module: { exports: {} }, Game: { time: 1 }, Map, Set, Array };
vm.runInNewContext(code, ctx);
const { isSameOps, pathOptionsKey, kept } = ctx.module.exports;
let fail = 0;
const assert = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } else console.log('ok', m); };
const pos = (roomName) => ({ roomName, x: 1, y: 1 });
const mk = (ops, rooms) => ({ optionsKey: pathOptionsKey(ops), posArray: rooms.map(pos) });

let p = mk({ avoidRooms: new Set(['W1N1']) }, ['W2N2', 'W3N2']);
assert(isSameOps(p, { avoidRooms: new Set(['W1N1', 'W9N9']) }), '新增回避房不在路上：沿用');
assert(p.optionsKey === pathOptionsKey({ avoidRooms: new Set(['W1N1', 'W9N9']) }), '沿用后 key 改成当前的');
assert(kept() === 1, '遥测计数 +1');
p = mk({ avoidRooms: new Set(['W1N1']) }, ['W2N2', 'W3N2']);
assert(!isSameOps(p, { avoidRooms: new Set(['W1N1', 'W3N2']) }), '新增回避房在路上：重算');
p = mk({ avoidRooms: new Set(['W1N1', 'W5N5']) }, ['W2N2']);
assert(!isSameOps(p, { avoidRooms: new Set(['W1N1']) }), '回避房被移除、公用缓存查找：不命中');
const oldKey = p.optionsKey;
assert(isSameOps(p, { avoidRooms: new Set(['W1N1']) }, true), '回避房被移除、自己正在走的路：走完');
assert(p.optionsKey === oldKey, '移除时不改 key（公用缓存仍按旧 key）');
assert(isSameOps(p, { avoidRooms: new Set(['W1N1']) }, true), 'keptFor 直接命中');
assert(!isSameOps(p, { avoidRooms: new Set(['W1N1', 'W2N2']) }, true), '自己的路、新回避房在路上：重算');
p = mk({ avoidRooms: new Set(['W1N1']), range: 1 }, ['W2N2']);
assert(!isSameOps(p, { avoidRooms: new Set(['W9N9']), range: 3 }), '其它参数不同：重算');
p = mk({}, ['W2N2']);
assert(!isSameOps(p, { avoidRooms: new Set(['W9N9']) }), '缓存路是默认回避（default@）：不放宽');
p = mk({ avoidRooms: new Set(['W1N1']) }, ['W2N2']);
assert(!isSameOps(p, {}), '当前是默认回避：不放宽');
assert(isSameOps(mk({ avoidRooms: new Set(['A']) }, ['W2N2']), { avoidRooms: new Set(['A']) }), '完全相同：命中');
process.exit(fail ? 1 : 0);
