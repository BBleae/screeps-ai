'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

function withMockedRequires(stubs, factory) {
    const target = require.resolve('../scripts/private_server/run_validation');
    const originalLoad = Module._load;
    delete require.cache[target];
    Module._load = function mockedLoad(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return factory(require('../scripts/private_server/run_validation'));
    } finally {
        Module._load = originalLoad;
        delete require.cache[target];
    }
}

// 2026-10-14：恢复模拟前等 calcMarketStats 把种子成交史（seeded 行）清掉并从 users.money 重算出来；cron 没跑时超时放行、记 rebuilt:false
async function testWaitMarketHistory() {
    const { waitMarketHistory } = require('../scripts/private_server/run_validation');
    const sequence = [{ rows: 5, seeded: 5 }, { rows: 0, seeded: 0 }, { rows: 5, seeded: 0 }];
    let calls = 0;
    const rebuilt = await waitMarketHistory({ evaluateJson: async (expr) => {
        assert(/market\.stats/.test(expr) && /seeded:true/.test(expr), 'waitMarketHistory 查 market.stats 的 U 行与 seeded 行');
        return sequence[Math.min(calls++, sequence.length - 1)];
    } }, 5000);
    assert.equal(rebuilt.rebuilt, true, '种子行被清、重算出 U 行 ⇒ rebuilt');
    assert.equal(rebuilt.rows, 5);
    assert.equal(calls, 3, '种子行还在（cron 还没跑）或表空（removeWhere 后、重插前）都要接着等');
    const stale = await waitMarketHistory({ evaluateJson: async () => ({ rows: 5, seeded: 5 }) }, 300);
    assert.equal(stale.rebuilt, false, 'cron 没跑：超时放行、记 rebuilt:false（种子行仍在）');
}

function testDefaultArgs() {
    const { parseArgs } = require('../scripts/private_server/run_validation');
    const args = parseArgs([]);
    assert.equal(args.keepRunning, false);
    assert.equal(args.tickDuration, 1);
    assert.equal(args.warmupTicks, 90);
    assert.equal(args.gamePort, null);
    assert.equal(args.cliPort, null);
    const pinned = parseArgs(['--game-port', '21025', '--cli-port', '21026']);
    assert.equal(pinned.gamePort, 21025);
    assert.equal(pinned.cliPort, 21026);
}

async function testPhaseOneKeepsSimulationPaused() {
    const calls = [];
    let constructorOptions;
    const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-validation-test-'));
    const databasePath = path.join(worldDir, 'db.json');
    fs.writeFileSync(databasePath, '{}');
    const fakeCli = {
        run: async (command) => { calls.push(['run', command]); },
        evaluateJson: async (command) => {
            calls.push(['evaluateJson', command]);
            const match = command.match(/storage\.env\.set\("([^"]+)","([^"]+)"\)/);
            if (match) {
                fs.writeFileSync(databasePath, JSON.stringify({ marker: match[1] }));
            }
            return true;
        },
    };
    const fakeServer = {
        gamePort: 12345,
        cliPort: 12346,
        start: async () => {
            calls.push(['start']);
            return fakeCli;
        },
        stop: async () => {
            calls.push(['stop']);
        },
    };
    try {
        await withMockedRequires({
            './env': { loadProjectEnv: () => ({}) },
            './server_process': {
                PrivateServer: function PrivateServer(options) {
                    constructorOptions = options;
                    return fakeServer;
                },
                sleep: async (ms) => { calls.push(['sleep', ms]); },
            },
            './fixtures': {
                generateWorld: async () => { calls.push(['generateWorld']); },
                seedAllScenarios: async () => { calls.push(['seedAllScenarios']); },
                GENERATION: [],
                ROOMS: {},
            },
        }, async ({ phaseOne }) => {
            await phaseOne(worldDir, 'server-dir', 1, 42);
        });

        assert.equal(calls[0][0], 'start');
        assert.equal(calls[1][0], 'generateWorld');
        assert.equal(calls.filter(([kind]) => kind === 'evaluateJson').length, 1);
        assert(calls.some(([kind, value]) => kind === 'sleep' && value === 42));
        assert.equal(calls[calls.length - 1][0], 'stop');
        assert.equal(constructorOptions.runnersCnt, 0);
        assert.equal(constructorOptions.runnerThreads, 1);
        assert(!calls.some(([kind, command]) => kind === 'run' && command === 'system.resumeSimulation()'));
    } finally {
        fs.rmSync(worldDir, { recursive: true, force: true });
    }
}

function testEffectsObserveTheAidChange() {
    const effects = require('../scripts/private_server/effects');
    const ROOMS = { upgraderActualRoute:'W34S7', reserveOrderedTarget:'W63N53', roadTrailHome: 'W59N55', roadTrailTarget: 'W59N53', roadTrailForeign: 'W59N54', linkDrink: 'W60N61', linkInPlace: 'W60N62', reserveBudgetTarget: 'W62N53', reserveDeadlineHome: 'W61N55', reserveDeadlineTarget: 'W61N53', controllerLinkConsumer: 'W42N40', storageConsumer: 'W41N40', reserveHome: 'W58N55', reserveTarget: 'W58N53', claimBlocked: 'W70N70', claimBlockedTarget: 'W70N69', aidHome: 'E15S15', aidWeak: 'E15S16', aidNew1: 'E14S15', aidNew2: 'E15S17', aidSafeHome: 'W82S77', aidSafeRoadblock: 'W83S77', aidSafeFar: 'W84S77', layoutOneOff: 'W72N72', layoutLeftover: 'W74N74', layoutDedupe: 'W73N72', terminalHome: 'W86S80', terminalPeer: 'W87S80', terminalMarket: 'W86S81', terminalDrainLow: 'W89S84', labHome: 'W92S80', labPeer: 'W93S80', boostLabGated: 'W94S84', boostHome: 'W96S85', boostTarget: 'W97S85', skHome: 'W44S43', skRoom: 'W44S44', skDemoted: 'W45S43', autoClaimHome: 'W78N72', autoClaimTarget: 'W78N71', autoClaimDecoy: 'W77N72', autoClaimCpuHome: 'W80N76', autoClaimCpuTarget: 'W80N75', brainHome: 'E11S11', brainRemote2: 'E12S11', remoteHome: 'W50N50', remote: 'W50N49', logistics: 'W40N40', blueprint: 'E30S30', links: 'E20S20', conquestHome: 'E18S18', conquestTransit: 'E18S16', conquestTarget: 'E18S15', defenseHome: 'E13S13', bootstrap: 'W20N20', industry: 'E40S40', conflict: 'E50S50', foreignSpawn: 'E50S51', storageFed: 'W60N60', maintenance: 'W61N60', recovery: 'W30N30', containerGap: 'W30N29', repairOnly: 'W61N59',
        auditHome: 'W64N60', auditRemote: 'W64N59', auditRich: 'W65N60', auditDrop: 'W65N59', auditLink: 'W63N60', auditZero: 'W62N60', minerPair: 'W69N66', auditPocket: 'W63N61', auditWalled: 'W62N61' };
    const okReport = {
        upgraderRoute: upgraderRouteReport(),
        reserveOrdered: orderedReport(),
        reserveBudget: affordableReport(),
        reserveDeadline: { at: 1, successorId: 'actual', event: {at:2,remoteRoom:'W61N53',name:'next',lead:189,blockedTicks:78,candidates:[{role:'hauler',parts:26,cost:1300}]}, lead: 189, initialTtl: 219, energy: 1300, oldDiesAt: 250, controller: {x:20,y:20}, samples: [{t:150,creeps:[{name:'reserve-incumbent'},{name:'next',id:'actual',spawning:false,room:'W61N53',x:20,y:21}]}] },
        storageConsumerProgress: 100,
        controllerLinkConsumerProgress: 100,
        // 维修饥饿场景：塔在 (6,40)，射程外的危急路在 (41,33)（播种 60 血 → 已被 builder 修到 3000），
        // 射程内的危急路在 (11,40)；工地里有让位出来的道路工地 + 减少的 rampart 工地
        maintenanceEarly: { repair: [['road', 3, 4900], ['road', 3, 3100]], rampartTarget: { target: 5000, count: 1, budget: 0, floor: 5000 } },
        maintenance: { roads: [[11, 40, 900], [41, 33, 3000], [20, 20, 5000], [21, 20, 5000], [22, 20, 5000], [23, 20, 5000]], towers: [[6, 40, 500]], links: [[30, 24, 500]],
            sites: [['road', 0, 300], ['road', 100, 300], ['road', 0, 300], ['road', 0, 300], ...Array.from({ length: 32 }, () => ['constructedWall', 0, 1]), ['terminal', 0, 100000], ['lab', 0, 50000]] },
        earlyReserve: [{ offset: 25, creeps: [{ name: 'replacement', spawning: false }] }],
        hostileCounts: { E13S13: 0 },
        rootMemories: { W60N60: { rooms: { W60N60: { criticalBuilder: { at: 640, n: 12 }, linkRelief: { at: 300, n: 4, x: 10, y: 10 } }, W60N61: { upgraderDrink: { linkOverStorage: 40, at: 700 }, ctrlLinkFeedSkip: { n: 30, at: 700 } }, W60N62: { linkReliefInPlace: { at: 3, first: 3, n: 1, drank: 200 } } } },
 W61N60: { rooms: { W61N59: { state: { builderTarget: 2, builderRepairDebt: 18000, builderOutOfReach: 14 },
                outOfReachRepair: { at: 900, count: 14, debt: 18000, n: 5 } },
            W61N60: { towerCritical: { at: 700, energy: 500, x: 6, y: 40 },
            maintenanceSeed: { nearRoad: { x: 11, y: 40 }, farRoad: { x: 41, y: 33 }, tower: { x: 6, y: 40 }, ctrlLink: { x: 30, y: 24 }, missingRoads: [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 22, y: 20 }, { x: 23, y: 20 }] },
            builderSource: { at: 700, type: 'storage', x: 12, y: 41 }, builderSourceLog: [{ at: 690, type: 'storage', x: 12, y: 41 }], builderSourceFirst: { at: 120, type: 'storage', x: 12, y: 41 },
            upgradeBudget: { at: 700, supply: 20, work: 21, cap: 12, duty: 0.571, storage: 800, low: true },
            builderFeed: { at: 700, wait: 0, self: 6 } } } }, W61N55: { rooms: { W61N55: { reserveHandoff: {name:'next',lead:189,blockedTicks:78,candidates:[{role:'hauler',parts:26,cost:1300}]} } } }, W42N40: { rooms: { W42N40: { storageConsumerFallback: 100 } } }, W41N40: { rooms: { W41N40: { storageConsumerFallback: 100 } }, creeps: { 'storage-consumer-hauler': { role: 'hauler' } }, _validationCtrlBesideSource: { ctrl: { x: 42, y: 31 }, source: { x: 43, y: 30 }, sourceId: 's' } }, W58N55: { rooms: { W58N55: { remoteRoadBudget: { spent: 100, maxTripSpent: 50, deliveredTrips: 2, delivered: 2300 }, remotes: { W58N53: { roadCoverageRepair: { reason: 'incompleteRoadCoverage' }, distanceRepair: { source: 'test-source', before: 1, after: 140 }, sources: [{ id: 'test-source', distanceVersion: 3, distanceIncomplete: false }], controllerDistanceVersion: 3, controllerDistanceIncomplete: false, drop: { distanceVersion: 3 } } } } } }, W70N70: { rooms: { W70N70: { claimReachability: { W70N69: { failures: 1, reason: 'unreachable', suspendedUntil: 2150 } } } },
                cpuHardStop: { n: 30, at: 130, cut: 4, line: 0 },
                pixelGate: { skip: 55, at: 150, mean: 124.2, line: 105, n: 5 },
                stats: [{ t: 90, shed: { ticks: 30, low: 0, crit: 30, forced: 30, skip: 0, roles: {}, hard: 30, cut: 120, hardEnd: 29 } },
                    { t: 600, shed: { ticks: 30, low: 0, crit: 30, forced: 30, skip: 30, roles: { scout: 20, hauler: 10 }, hard: 0, cut: 0, hardEnd: 1 } },
                    { t: 630, shed: { ticks: 30, low: 0, crit: 30, forced: 30, skip: 30, roles: { scout: 20, hauler: 10 } } }] },
            W30N30: { creeps: { gb: { role: 'builder', home: 'W30N29' } },
                rooms: { W30N29: { containerGapBuilder: { at: 12, n: 8, recovering: true }, spawnSince: { 'core:builder:0': 12 } } } },
            W20N20: { rooms: { W20N20: { roadsTrimmed: 4, roadsTrimmedAt: 300, layoutAt: 800 } } },
            E13S13: { rooms: { E13S13: { defenseLog: { spawned: 2, losses: 1, streak: 0 } } } },
            E11S11: { rooms: { E11S11: { remotes: { E12S11: { drop: { room: 'E11S11', hops: 1, distance: null, at: 100 } } },
                defenseLog: { spawned: 0, safeMode: { at: 120, by: 'brain:no-help', hostiles: [['ValidationBootstrap', '20A25T', 4500]] } } } } },
            W50N50: { creeps: { ok: { role: 'hauler', home: 'W50N50' } },
                rooms: { W50N50: { remoteEnergySalvaged: { amount: 100, n: 1 }, layoutAt: 801, crippledLog: [{ name: 'remote-crippled-hauler', role: 'hauler', room: 'W50N50', lost: ['carry'], ttl: 1400, at: 60 }],
                    remotes: { W50N49: { room: 'W50N49', lairs: 0, unreachableAt: 5, unreachableCount: 0, lastSeen: 700, roadSitesYielded: 1, containerSiteAt: 300, roadsHeldAt: 650,
                        sources: [{ id: 's', containerId: 'c' }, { id: 's2', containerId: 'c2', distance: 500 }] } },
                    // 编制预算遥测：一条在编外矿，成本 ≤ 预算（生效断言 remote.incomeBudgetedStaffing 的不变量）
                    remoteStaff: { at: 700, income: 20, budget: 10, used: 7, staffed: ['W50N49'], dropped: [], cost: { W50N49: 7 } },
                    // core hauler 按 CARRY 定编（hauling.spawnSpend / hauling.tempHead）：孵化花费记账、源容器满仓的临时编制
                    spawnSpend: { ema: 12, at: 690, n: 9 }, haulTemp: { at: 30, why: 'overflow', overflow: 25 } } } },
            W40N40: { _gcSeen: { _validation: { t: 700, n: -1 }, _validationRooms: { t: 700, n: -1 } },
                memReuse: { hit: 1, n: 80, at: 700 },
                stats: [{ t: 690, rooms: { W40N40: [4, 12000, 31000] }, creeps: 9, cpu: 3.2, bucket: 10000, cpuBy: { spawn: 0.4 }, cpuRooms: { W40N40: 0.9 },
                    cpuSpawn: { pre: 0.11, counts: 0.05, targets: 0.3, schedule: 0.04, exec: 0.002 },
                    cpuDispatch: { order: 0.04, retire: 0.6, start: 1.1, run: 18.2, finish: 0.9 }, cpuRoles: { harvester: 6.1, hauler: 9.4 }, cpuSampled: [6, 1],
                    cache: { srcOrder: [300, 260], workTile: [4200, 3300] } }],
                creeps: { f: { role: 'feeder', home: 'W40N40' }, hv: { role: 'harvester', home: 'W40N40', sourceId: 'srcA' } }, rooms: { W40N40: { sources: ['srcA', 'srcB'], layoutAt: 803, demand: { at: 700, skipped: 42, quietSkipped: 17 }, storageRich: { on: true, at: 5 }, towerFirstAt: 2, towerUrgent: { t1: 0 }, spawnIncome: { ema: 6.2, n: 12, starved: 82 } } } },
            E40S40: { rooms: { E40S40: { industryState: { labs: { present: 4, configured: true, derived: { product: 'OH', output: 'lab1' }, active: true } }, plan: { labs: [{ x: 20, y: 20 }, { x: 21, y: 21 }, { x: 22, y: 20 }, { x: 40, y: 40 }] } } } },
            E15S15: { creeps: {
            h: { role: 'hauler', home: 'E15S16', aid: 'E15S15' },
            c: { role: 'courier', home: 'E15S16', from: 'E15S15', aid: 'E15S15' },
            p1: { role: 'pioneer', home: 'E15S15', targetRoom: 'E14S15' },
            p2: { role: 'pioneer', home: 'E15S16', targetRoom: 'E15S17' },
            u1: { role: 'upgrader', home: 'E15S15' }, u2: { role: 'upgrader', home: 'E15S15' }, u3: { role: 'upgrader', home: 'E15S15' },
        } },
            E18S18: { creeps: { ch0: { role: 'harvester', home: 'E18S18' }, ch1: { role: 'harvester', home: 'E18S18' },
                sg0: { role: 'siegeGuard', home: 'E18S18', targetRoom: 'E18S15', stagedAt: 300 } },
                conquest: [{ target: 'E18S15', sponsors: ['E18S18'], phase: 'breach' }], errors: [] },
            E20S20: { creeps: { op: { role: 'operator', home: 'E20S20' } },
                rooms: { E20S20: { operator: { at: 700, withdrawn: 700, transferred: 700, n: 8 },
                    haulerSize: { at: 300, parts: 4, full: 4, need: 3.1, count: 2, heads: 2, min: 4, mode: 'fallback', production: 0, base: 1.4, burst: 0.3, spend: 1.2 } } } } },
        conquestStructures: { towers: 0, spawns: 0, transitMinDist: 8 },
        probeMemories: { W42N40: { _validationRooms: { W42N40: { name: 'W42N40', storage: 2500, links: 1 } } }, W41N40: { _validationRooms: { W41N40: { name: 'W41N40', storage: 2000 } } }, E11S11: { _validationRooms: { E11S11: { name: 'E11S11', safeMode: 19500 } } },
            E50S50: { _validationRooms: { E50S50: { name: 'E50S50', stores: [['storage', 5000]] } } },
            E40S40: { _validationRooms: { E40S40: { name: 'E40S40',
                mined: { type: 'Z', left: 49000, terminal: 120, storage: 0, carried: 40, drones: 1 } } } },
            E18S18: { _validationRooms: { E18S18: { name: 'E18S18',
                actionGuard: { attackBlockedByHeal: true, rangedBlockedByRangedHeal: true, skipped: { rangedHeal: 3 } } } } },
            W20N20: { _validationRooms: { W20N20: { name: 'W20N20', rcl: 1, homeIndexed: 3, visualSize: 12000, actionGuard: { attackBlockedByHeal: true, rangedBlockedByRangedHeal: true, skipped: {} }, sites: [['container', 10, 10, 0, 5000]] } } },
            E15S15: { _validationRooms: { E15S15: { name: 'E15S15', storage: 27000, aidExport: { above: 20000, keep: 10000 } }, E15S16: { name: 'E15S16', storage: null } } },
            E14S15: { _validationRooms: { E14S15: { name: 'E14S15', sites: [['spawn', 6000, 15000], ['road', 0, 300], ['road', 100, 300]] } } },
            E30S30: { _validationRooms: { E30S30: { name: 'E30S30', links: 0, visualSize: 0, sites: [['link', 0, 5000], ['extension', 0, 3000]] } } },
            E20S20: { _validationRooms: { E20S20: { name: 'E20S20', homeIndexed: 4, visualSize: 9000, ctrlLink: 800, storeLink: 120, upgradeSupply: { ema: 0.9, emaMax: 0.95, src: 'link', extra: 1, at: 700, changedAt: 400 }, targets: { hauler: 2, operator: 1 }, haulModel: { production: 0, carry: 400, load: 0, demand: 0, floor: 2, linkFed: 2, linkDrain: 20, at: 700 } } } },
            W50N50: { _validationRooms: { W50N50: { name: 'W50N50', homeIndexed: 5, visualSize: 8000, creeps: [{ name: 'rsv', role: 'reserver', body: '2C2M' }], haulModel: { production: 20, spawnShare: 0.6, spend: 12, deliveryTicks: 9.6, maxDeliveryTicks: 9.6, carry: 400, load: 2.3, demand: 3, at: 700 } } } },
            W40N40: { _validationRooms: { W40N40: { name: 'W40N40', homeIndexed: 6, visualSize: 7000, storage: 31000, ctrlContainerHits: 140000, srcContainerHits: [52000, 48000], towers: [820], collect: [['container', 7, 1500, false], ['container', 7, 900, false], ['storage', 6, 39000, true], ['drop', 6, 120, false]] } } },
            W61N60: { _validationRooms: { W61N60: { name: 'W61N60', storage: 0, repair: [['road', 3, 4900], ['road', 3, 3100], ['rampart', 3, 220000]] } } },
            W60N60: { _validationRooms: { W60N60: { name: 'W60N60', storage: 2600, ctrlFeedBand: { at: 640, energy: 2100, floor: 3000, n: 37 }, criticalRepair: { at: 620, hits: 12800, type: 'container', n: 14, noSites: true }, repairSplit: { crit: 18400, ram: 40 } } } } },
    };
    // storage → 升级的机制闩锁（upgrade.storageRich）：link 供能的几何里 hauler 从 storage 送进 ctrl link 的量
    okReport.rootMemories.E15S15._storageUpgradeFeed = { direct: 0, hauled: 4200, link: 0, withdrawn: 11000, total: 4200, firstAt: 310, at: 760 };
    // 维修池闩锁（maintenance.repairPoolNeutral）：第 1 tick 池里就有 250 血的路
    okReport.rootMemories.W61N60._repairPoolNeutral = { t: 2, type: 'road', backlog: 4750, n: 3, x: 11, y: 40 };
    okReport.rootMemories.E40S40.brain = { rooms: { E40S40: { mineral: { enabled: true, outbound: {} } } } };
    okReport.rootMemories.E40S40.rooms.E40S40.mineralStats = { harvested: 160, delivered: 120 };
    // 强化没打开时不给 boost lab 补能（2026-10-14 复审，industry 场景）：有 boost lab、记了 labEnergyHeld、没有 labEnergy、原始 DB 里 boost lab 0 能量
    okReport.rootMemories.E40S40.rooms.E40S40.labRoles = { inputs: ['lab1a', 'lab1b'], outputs: ['lab1'], boost: 'lab4' };
    okReport.rootMemories.E40S40.rooms.E40S40.labEnergyHeld = { at: 300, want: 2000, lab: 'lab4', energy: 0 };
    okReport.towerMaintenance = [{ n: 10, source: 10, peakBeforeRepair: 800 }];
    okReport.remoteGround = 0;   // 外矿房地面能量：满容器下矿工停手的观察面（生效断言 remote.minerNoGroundOverflow）
    okReport.protectedStore = { id: 'seeded-store', resources: 1 };
    // 敌方遗留 spawn 场景：别人的 spawn 已拆（demolition 记 hostile-quota）、出现我们的 spawn 工地（生效断言 demolition.hostileQuota）
    okReport.foreignQuota = [{ type: 'constructionSite', user: 'u-conflict', x: 20, y: 20, progress: 0 }];
    okReport.rootMemories.E50S50 = okReport.rootMemories.E50S50 || {};
    okReport.rootMemories.E50S50.rooms = Object.assign({}, okReport.rootMemories.E50S50.rooms,
        { E50S51: { demolition: [{ t: 30, type: 'spawn', x: 20, y: 20, reason: 'hostile-quota' }], layoutFirstSpawn: 60 } });
    // 运输饱和度遥测（haulStats.telemetry）：五类恰好分完 t、idle = 空等 + 满等
    okReport.rootMemories.W40N40.haulStats = { v: 2, since: 1, t: 690, rooms: { W40N40: { hauler: { t: 100, cap: 50000, idle: 20, idleE: 15, idleL: 5, fat: 0,
        mvE: 30, mvL: 30, lf: 22, ld: 10, ul: 10, ch: 12, in: 2500, out: 2400, ac: 22, acm: 12, idSt: 5, idOv: 10, idWa: 5, rs: {}, ri: {} },
        _room: { ticks: 690, rfN: 12, rfT: 300, rfD: 9000, lkF: 0, lsF: 0, spW: 0 } } } };
    okReport.rootMemories.W40N40.rooms.W40N40.haulFill = { start: 4, left: 3, share: 0.62, at: 650 };
    okReport.rootMemories.W61N60.rooms.W61N60.pathRefresh = { n: 2, at: 600, sig: '6:3', regen: 2 };
    okReport.rootMemories.E20S20.rooms.E20S20.hubBudgetedWithdraw = { n: 5, amount: 1400, at: 680 };
    okReport.rootMemories.W40N40.rooms.W40N40.spillFlips = 3;
    okReport.rootMemories.W40N40.rooms.W40N40.haulInflowDry = { n: 120, at: 660 };
    okReport.rootMemories.W40N40.rooms.W40N40.haulCargoRelease = { n: 2, at: 640 };
    okReport.rootMemories.W40N40.rooms.W40N40.haulLoadedStorageSkip = { n: 9, at: 655 };
    okReport.rootMemories.W60N60.rooms.W60N61.haulSalvage = { n: 1, at: 30 };
    // 主动打捞（hauler.salvagePickup）：遥测 + 化合物真的落进了 storage
    okReport.rootMemories.W60N60.rooms.W60N61.salvaged = { n: 4, amount: 146, at: 640 };
    okReport.salvageSink = { sinks: [{ type: 'storage', store: { energy: 50000, GO: 95, KO: 17, ZH: 23, UH: 11 } }], tombs: [], drops: [] };
    okReport.rootMemories.E15S15.rooms = okReport.rootMemories.E15S15.rooms || {};
    okReport.rootMemories.E15S15.rooms.E15S16 = Object.assign({ brokerFarClaims: { n: 45, at: 600 } }, okReport.rootMemories.E15S15.rooms.E15S16);
    // 外矿运输饱和（remoteHauler.* / remote.measuredStops）：reserveContinuity 母房的决策事件
    Object.assign(okReport.rootMemories.W58N55.rooms.W58N55, {
        remoteHaulAct: { ac: 30, acm: 14, at: 690 },
        remoteHaul: { buildMove: 2, stepOff: 1, yieldDepart: 1, yieldLoad: 1200, trips: 6, at: 690 },
        remoteTtl: { retire: 1, at: 12, last: { kind: 'retire', ttl: 148, cycle: 240 } },
        remoteStop: { ema: 3.2, n: 6, last: 2, at: 680 },
    });
    okReport.rootMemories.W58N55.rooms.W58N55.remotes.W58N53.sources[0].haulStops = 3.2;
    // 路线失配自愈（remote.roadTrailReplan）：规划的 5 格假路线被满载腿的真实走线替换，新路线逐格相邻且贴着矿位
    okReport.rootMemories[ROOMS.roadTrailHome] = { errors: [], stats: [{ cpu: 1 }], rooms: {
        [ROOMS.roadTrailHome]: { remotes: { [ROOMS.roadTrailTarget]: {
            // 配额口径：停用房 roadTrailForeign 里有 12 个（= cap），旧口径会独占配额把本房饿死；新口径只数启用外矿
            roadQuota: { at: 700, mine: 2, others: 12, cap: 12 },
            sources: [{ id: 'rt-src', spot: { x: 20, y: 20 }, road: '21.21;21.20;20.20;19.20', roadComplete: false,
                roadReplan: { at: 640, was: 5, tiles: 4, n: 1 } }],
        } } } } };
    // audit 场景（2026-09-11 全面审计的一批修复）：一份让 17 条 audit.* 断言全部通过的合成数据
    const auditSeed = { at: 100, legPos: { x: 20, y: 20 }, legKey: 'remote:W64N59:src', terminalPos: { x: 25, y: 25 }, terminalProgress: 1000,
        wallPos: { x: 30, y: 30 }, wallHits: 11954101, roadSitePos: { x: 31, y: 30 }, damagedRoadPos: { x: 32, y: 30 }, linkGeom: { labs: [{ x: 1, y: 1 }] },
        orphanPos: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 5, y: 7 }, { x: 8, y: 10 }], orphanKept: { x: 6, y: 6 }, dropLost: { source: 'lostB', spot: { x: 10, y: 10 } }, haulSeed: { room: ROOMS.auditHome, n: 1800 },
        pocket: { room: ROOMS.auditPocket, spawn: { x: 20, y: 21 }, pocket: { x: 20, y: 20 }, spawnName: 'AuditPocketSpawn', upgrader: 'audit-pocket-upgrader', mineral: { x: 21, y: 19 } },
        walled: { room: ROOMS.auditWalled, controller: { x: 25, y: 25 }, ring: 32, spawn: { x: 25, y: 35 }, spawnName: 'AuditWalledSpawn', upgrader: 'audit-walled-upgrader', retireSeeded: 2,
            born: 'audit-walled-born', exits: [3, 5], vacateTile: { x: 26, y: 35 }, anchorTile: { x: 25, y: 36 }, pocket: { x: 24, y: 34 },
            parked: 'audit-walled-parked', anchor: 'audit-walled-anchor' } };
    okReport.rootMemories[ROOMS.auditHome] = { errors: [], stats: [{ cpu: 1 }], rooms: {
        [ROOMS.auditHome]: { auditSeed, plan: { roads: { all: '', 'remote:W64N59:src': '20.20' } }, linkHold: { n: 5 }, builderHunger: { n: 3 },
            luxuryHeld: { at: 120, storage: 0 }, spawnIncome: { noCarrier: { n: 2 }, minerNotCarrier: { at: 3, n: 5, miners: 2 }, noRegen: 1 }, spawnFirst: { key: 'core:hauler:0', cost: 1100, t: 101 },
            upgradeSupply: { capCount: 1, extra: 1 }, demand: { targets: { upgrader: 1 } },
            // hauling.measuredSize：播下的实测窗口（1800）之后又进了真实 flush，按实测定的每只 7 < 满配 30 的一半
            haulCtl: { decisions: [{ at: 1, per: 7, prev: null, reason: 'init', mode: 'measured', full: 30, cstar: 17.5 }], meas: { n: 2400 } },
            minerUpgradeUrgent: { at: 40, slot: 'remoteMiner:W65N59:a', rate: 4, ideal: 10 },
            remotes: { [ROOMS.auditRemote]: { reserverSkip: { at: 101, reservation: 4900 }, residualSeen: { at: 101, gap: 13, live: 4, required: 17 }, orphanRoadSites: { at: 11, n: 7, lost: 100 },
                    sources: [{ id: 's', containerId: 'c', distance: 30, energyCapacity: 3000, haulNeed: 17 }] },
                [ROOMS.auditDrop]: { enabled: true, sources: [{ id: 'dropA', routeRoads: { [ROOMS.auditRemote]: '10.8;9.9;8.10' } }],
                    drop: { room: ROOMS.auditHome, skippedRicher: [ROOMS.auditRich] }, reserverWeakMiner: { at: 20, gain: 0, n: 30 },
                    containerLostHaul: { at: 20, source: 'lostB', lostAt: 2 }, minerPickupBuild: { at: 30, n: 12 }, entry: { x: 49, y: 25 } } } },
        [ROOMS.auditRich]: { remoteOverBudgetSeen: { rooms: ['W66N60'], budget: 1.5 }, reserveLog: { hauler: { cost: 900, ideal: 900, capacity: 1800 } },
            haulerSize: { at: 5, parts: 12, full: 24, need: 20.4, count: 2, heads: 2, min: 4, mode: 'fallback' }, builderRepairHold: { at: 9, n: 3 },
            harvesterEarlyReplace: { at: 150, name: 'audit-rich-miner-1', ttl: 50, lead: 33, replaceLead: 60 },
            remoteSpawnCapped: true, remoteSpawnCappedSeen: { rooms: ['W66N59'], cap: 0.5, used: 0.44 } },
        [ROOMS.auditLink]: { state: { builderOutOfReach: 2, builderRepairDebt: 2000 }, demand: { targets: { builder: 0 } }, upgraderLinkSide: { n: 1 },
            outOfReachBelowFloor: { at: 5, count: 2, debt: 2000 }, upgradeSupply: { low: true, capFree: { at: 5, n: 3 }, unfullIgnored: { at: 9, n: 4 } } },
        [ROOMS.auditZero]: { zeroIncomeHeld: { n: 1, key: 'core:builder:0' }, spawnLog: [] },
        // 口袋里的升级者连续两轮扫描都在口袋格就被标记、贴着的 spawn 回收（spawn.pocketTrappedRecycle）
        [ROOMS.auditPocket]: { spawnPocket: { AuditPocketSpawn: { at: 30, pockets: [1], dirs: [4, 5, 6] } },
            spawnStallLog: { n: 0, trapped: { n: 1, at: 20, spawn: 'AuditPocketSpawn', name: 'audit-pocket-upgrader', role: 'upgrader', x: 20, y: 20, recycled: 1, code: 0 } },
            upgradeSupply: { low: true, sizeCap: { at: 600, cap: 20, would: 21, n: 400 } } },
        // 控制器够不着：播的 2 次 + 真实 1 次退役 → 退避 1500 tick，之后卡住的替补被留着（held）
        // 看门狗先重算一次（repath/reset）再退役；出口：RIGHT (26,35) 上的 parked 让路，播种的 hauler 生在 RIGHT，口袋 (24,34) 空着
        [ROOMS.auditWalled]: { upgraderStuck: { at: 120, name: 'audit-walled-upgrader', action: 'retire', retire: 3, streak: 3, mark: { l: 6, p: 0, d: 200100 },
            backoffs: 1, backoffAt: 120, backoffUntil: 1620, held: 1, heldAt: 480, repath: 1, reset: 1 },
            spawnStallLog: { n: 0, vacate: { n: 1, at: 2, spawn: 'AuditWalledSpawn', name: 'audit-walled-born', blocker: 'audit-walled-parked', role: 'parked', x: 26, y: 35, moved: 1, failed: 0 },
                born: { at: 4, spawn: 'AuditWalledSpawn', name: 'audit-walled-born', x: 26, y: 35, dir: 3, waited: 1, vacate: 'audit-walled-parked', released: false, pocket: false },
                bornHistory: [{ at: 4, spawn: 'AuditWalledSpawn', name: 'audit-walled-born', x: 26, y: 35, pocket: false, vacate: 'audit-walled-parked' }] } },
    } };
    okReport.audit = {
        [ROOMS.auditHome]: [{ type: 'road', x: 20, y: 20, hits: 3000 }, { type: 'constructionSite', structureType: 'terminal', x: 25, y: 25, progress: 1300 }],
        [ROOMS.auditRich]: [{ type: 'constructedWall', x: 30, y: 30, hits: 11954101 }, { type: 'constructionSite', structureType: 'road', x: 31, y: 30, progress: 50 },
            { type: 'road', x: 32, y: 30, hits: 2950 }],
        [ROOMS.auditLink]: [{ type: 'lab', x: 1, y: 1 }], [ROOMS.auditZero]: [],
        // 出生口袋：结束态口袋格 (20,20) 空着，新孵的 creep 在 spawn 下方
        [ROOMS.auditPocket]: [{ type: 'spawn', x: 20, y: 21 }, { type: 'creep', name: 'audit-pocket-new', x: 20, y: 22, body: ['work', 'carry', 'move'] },
            { type: 'creep', name: 'audit-pocket-up2', x: 25, y: 30, body: Array(20).fill('work').concat(['carry', 'carry', 'move']) }],
        // 有进度的孤儿 (6,6) 已被清掉（2026-09-12 新语义）：房里不再有它的工地，丢掉的 100 进度记在 orphanRoadSites.lost
        // (8,10) 播种时是"孤儿"，但 auditDrop 过境本房的路线经过它（validation-VoKyKM 的形态）：生产规则留下它是对的
        [ROOMS.auditRemote]: [{ type: 'creep', name: 'auditRM', body: ['work', 'work', 'work', 'work', 'work', 'carry', 'move', 'move', 'move', 'move', 'move'] },
            { type: 'constructionSite', structureType: 'road', x: 8, y: 10, progress: 0 }],
        [ROOMS.auditDrop]: [{ type: 'constructionSite', structureType: 'container', x: 10, y: 10, progress: 1600 }],
        [ROOMS.auditWalled]: [{ type: 'spawn', x: 25, y: 35 }, { type: 'creep', name: 'audit-walled-up2', x: 25, y: 31, body: ['work', 'carry', 'move'] },
            { type: 'creep', name: 'audit-walled-parked', x: 27, y: 34, body: ['carry', 'move'] }, { type: 'creep', name: 'audit-walled-anchor', x: 25, y: 36, body: ['carry'] },
            { type: 'creep', name: 'audit-walled-born', x: 30, y: 38, body: ['carry', 'move'] }],
        [ROOMS.roadTrailTarget]: [{ type: 'constructionSite', structureType: 'road', x: 21, y: 21, progress: 0 },
            { type: 'constructionSite', structureType: 'road', x: 21, y: 20, progress: 0 }],
        [ROOMS.roadTrailForeign]: Array.from({ length: 12 }, (unused, i) =>
            ({ type: 'constructionSite', structureType: 'road', x: 10 + i, y: 20, progress: 0 })),
    };
    okReport.rootMemories[ROOMS.auditHome].creeps = { auditRM: { role: 'remoteMiner', home: ROOMS.auditHome },
        'audit-pocket-up2': { role: 'upgrader', home: ROOMS.auditPocket } };
    // 矿工换代不成对 + 攒批交货（2026-10-08，minerPair 场景）：替补孵化时另一只 spawn 空闲、只孵了一只；link 矿工整批交 40
    okReport.rootMemories[ROOMS.minerPair] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.minerPair]: { harvesterSpawnCover: { at: 340, src: 1, idle: 1, n: 5 },
            spawnLog: [{ t: 12, key: 'opportunistic:scout:0', cost: 50, scaled: false }, { t: 336, key: 'core:harvester:1', cost: 650, scaled: false }] } },
        creeps: { m0: { role: 'harvester', home: ROOMS.minerPair, sourceIdx: 0, sourceId: 's0', xferBatch: 40 },
            m1: { role: 'harvester', home: ROOMS.minerPair, sourceIdx: 1, sourceId: 's1', staticMiner: true } } };
    // 援建安全路线（2026-10-13，aidSafeRoute 场景）：母房记下对弱房的拒援，搁浅的援建 hauler 已标退役并回收掉，没给弱房孵援建 creep
    okReport.rootMemories[ROOMS.aidSafeHome] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.aidSafeHome]: { aidNoRoute: { room: ROOMS.aidSafeFar, at: 900 } },
            [ROOMS.aidSafeFar]: { aidStranded: { name: 'aid-safe-stranded-hauler', role: 'hauler', from: ROOMS.aidSafeHome, aid: ROOMS.aidSafeHome, at: 2 } } },
        creeps: { 'aid-safe-hauler-0': { role: 'hauler', home: ROOMS.aidSafeHome }, fh: { role: 'harvester', home: ROOMS.aidSafeFar } } };
    // 一次性 storage/terminal 先于道路（2026-10-13，layoutOneOff 场景）：刚到 RCL6、extension 还缺时 terminal 提前放出，lab 仍被门槛挡住
    okReport.rootMemories[ROOMS.layoutOneOff] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.layoutOneOff]: { oneOffAhead: { at: 5, type: 'terminal', extNeed: 9, level: 6 }, luxuryHeld: { at: 900, storage: 0 } },
            // 同 tick 去重（2026-10-14 复审，layoutDedupe 第二房）：早轮放出 terminal，兜底轮同 tick 跳过、没有假的 oneOffLeftover
            [ROOMS.layoutDedupe]: { oneOffAhead: { at: 7, type: 'terminal', extNeed: 10, level: 6 }, oneOffDeduped: { at: 7, type: 'terminal', budget: 30 } } }, creeps: {} };
    // terminal 中段取回（2026-10-13 复审，terminalDrainLow 场景）：富余滞回开着、storage 低于取回线 ⇒ 出留 feeReserve 的取货任务，hauler 取过
    okReport.rootMemories[ROOMS.terminalDrainLow] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.terminalDrainLow]: { storageRich: { on: true, at: 1 }, terminalDrainLow: { at: 4, storage: 19800, terminal: 30000, keep: 2000 },
            terminalDrain: { n: 3, amount: 3900, low: 3900, at: 9 } } }, creeps: {} };
    // 一次性建筑的兜底轮（2026-10-13 复审，layoutLeftover 场景）：只剩 1 个名额、extension 放不出、塔不缺 ⇒ 兜底轮放 terminal
    okReport.rootMemories[ROOMS.layoutLeftover] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.layoutLeftover]: { oneOffLeftover: { at: 3, type: 'terminal', extNeed: 10, level: 6 } } }, creeps: {} };
    // terminal 补能（2026-10-13，terminalNet 场景）：storage 20 万的房出了 terminal 投递任务，播 0 能量的 terminal 结束时有能量
    // 终端网络（同一场景）：富房 → storage 0 的接收房发过成功的转账，接收房 hauler 从 terminal 取出过能量
    okReport.rootMemories[ROOMS.terminalHome] = { errors: [], stats: [{ cpu: 1 }],
        terminalNetwork: { last: { at: 600, from: ROOMS.terminalHome, to: ROOMS.terminalPeer, amount: 6000, cost: 200, result: 0 }, sent: 2, amount: 13000 },
        market: { last: { at: 400, room: ROOMS.terminalHome, resource: 'U', amount: 5000, cost: 165, price: 1, effective: 0.999, floor: 0.7, result: 0 }, deals: 1, sold: 5000 },
        rooms: { [ROOMS.terminalHome]: { terminalFill: { at: 700, want: 30000, terminal: 0 } },
            [ROOMS.terminalPeer]: { terminalDrain: { n: 9, amount: 7000, at: 690 } } }, creeps: {} };
    okReport.terminalNet = { rooms: { [ROOMS.terminalHome]: [{ type: 'storage', store: { energy: 180000 } }, { type: 'terminal', store: { energy: 12000 } }],
        [ROOMS.terminalPeer]: [{ type: 'storage', store: { energy: 3000 } }, { type: 'terminal', store: { energy: 6000 } }] },
        npcOrders: [{ active: true, remainingAmount: 1000, totalAmount: 6000, amount: 1000 }] };
    // 矿物链（2026-10-13，labChain 场景）：labTech 装过货、lab 里有 OH 产物；反应链按 XZH2O 选出 OH 这一步
    okReport.rootMemories[ROOMS.labHome] = { errors: [], stats: [{ cpu: 1 }],
        terminalNetwork: { mineral: { last: { at: 30, from: ROOMS.labPeer, to: ROOMS.labHome, resource: 'O', amount: 2000, cost: 300, result: 0 }, sent: 1, amount: 2000 } },
        rooms: { [ROOMS.labHome]: { labTech: { loaded: 2, loadedAmount: 2000, drained: 0, drainedAmount: 0, at: 300 },
            labRoles: { inputs: ['la', 'lb'], outputs: ['lc'], boost: 'ld', step: { product: 'OH', target: 'XZH2O', at: 40 } },
            labEnergy: { at: 300, want: 2000, lab: 'ld', energy: 0 },
            industryState: { labs: { present: 4, configured: true, derived: { product: 'OH', output: 'lc' }, target: 'XZH2O', product: 'OH', active: true } } } },
        creeps: {} };
    okReport.labChain = { rooms: { [ROOMS.labHome]: [
        { id: 'la', type: 'lab', store: { energy: 0, H: 900 } }, { id: 'lb', type: 'lab', store: { energy: 0, O: 900 } },
        { id: 'lc', type: 'lab', store: { energy: 0, OH: 200 } }, { id: 'ld', type: 'lab', store: { energy: 1200, XZH2O: 1000 } },
        { id: 't', type: 'terminal', store: { energy: 20000, H: 1000, O: 1000 } }],
        [ROOMS.labPeer]: [{ id: 'pt', type: 'terminal', store: { energy: 4700, O: 4000 } }, { id: 'ps', type: 'storage', store: { energy: 60000 } }] } };
    // 攻城强化（2026-10-13，boost 场景）：母房 boostLog 记了 3 个 WORK 的 XZH2O，lab 少了 90 XZH2O / 60 能量，creep 还在且 WORK 全强化
    okReport.rootMemories[ROOMS.boostHome] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.boostHome]: { boostLog: [{ at: 8, creep: 'boost-siege', role: 'siegeDismantler', compound: 'XZH2O', part: 'work', parts: 3, room: ROOMS.boostHome }] } },
        creeps: { 'boost-siege': { role: 'siegeDismantler', home: ROOMS.boostHome, targetRoom: ROOMS.boostTarget, boosts: ['XZH2O'] } } };
    okReport.boostScene = { labs: [{ id: 'bl', x: 20, y: 20, store: { energy: 1940, XZH2O: 510 } }],
        creep: { room: ROOMS.boostTarget, body: [{ type: 'work', boost: 'XZH2O' }, { type: 'work', boost: 'XZH2O' }, { type: 'work', boost: 'XZH2O' }, { type: 'move', boost: null }, { type: 'move', boost: null }, { type: 'move', boost: null }] } };
    // 储备闸关着时 boost lab 照样补能（2026-10-13 复审，boostLabGated 场景）：gated + boostLab 记着、出过补能任务、boost lab 有能量、三连没有
    okReport.rootMemories[ROOMS.boostLabGated] = { errors: [], stats: [{ cpu: 1 }], _validationBoostGated: { farLabId: 'gl3' },
        rooms: { [ROOMS.boostLabGated]: { industryState: { labs: { present: 4, configured: false, gated: true, boostLab: 'gl3' } },
            labEnergy: { at: 9, want: 2000, lab: 'gl3', energy: 0 } } }, creeps: {} };
    okReport.labChain.rooms[ROOMS.industry] = [{ id: 'lab1', type: 'lab', store: { energy: 2000 } }, { id: 'lab4', type: 'lab', store: { energy: 0 } }];
    okReport.labChain.rooms[ROOMS.boostLabGated] = [{ id: 'gl0', type: 'lab', store: { energy: 0 } }, { id: 'gl1', type: 'lab', store: { energy: 0 } },
        { id: 'gl2', type: 'lab', store: { energy: 0 } }, { id: 'gl3', type: 'lab', store: { energy: 1200, XZH2O: 600 } }];
    // SK 采矿（2026-10-13，sk 场景）：收成 SK 外矿、reaper 到岗前扣过矿工、reaper 开过火、播的 keeper 掉了血、矿工在 reaper 到岗后采到能量
    okReport.rootMemories[ROOMS.skHome] = { errors: [], stats: [{ cpu: 1 }],
        _validationSk: { keeperId: 'k0', lairIds: ['l0', 'l1'], seededAt: 1, demotedReapers: ['sk-demoted-reaper-0', 'sk-demoted-reaper-1'] },
        rooms: { [ROOMS.skHome]: { remotes: { [ROOMS.skRoom]: { room: ROOMS.skRoom, sk: true, enabled: true, lairs: 2,
            skWaitReaper: 180, skStation: { first: 181, at: 700 }, skReaper: { first: 181, at: 690, shots: 60, kills: 1 },
            skHarvest: { first: 320, at: 700, n: 200 }, skRetreat: { at: 500, kind: 'lair', n: 12 } },
        [ROOMS.skDemoted]: { room: ROOMS.skDemoted, sk: false, enabled: false, lairs: 2, suspendReason: 'keeperRoom', suspendedUntil: Number.MAX_SAFE_INTEGER } } } },
        creeps: { 'sk-reaper': { role: 'skReaper', home: ROOMS.skHome, remoteRoom: ROOMS.skRoom, slotKey: 'skReaper:' + ROOMS.skRoom },
            'sk-demoted-reaper-1': { role: 'skReaper', home: ROOMS.skHome, remoteRoom: ROOMS.skDemoted, retired: true } } };
    okReport.skScene = { keepers: [{ id: 'k1', name: 'Keeperl1', hits: 3200 }], lairs: [{ id: 'l0', nextSpawnTime: 760 }, { id: 'l1', nextSpawnTime: null }],
        sources: [{ id: 's0', energy: 1200, energyCapacity: 4000 }, { id: 's1', energy: 4000, energyCapacity: 4000 }], controller: false,
        creeps: [{ name: 'sk-reaper', x: 20, y: 20, hits: 4000, hitsMax: 4000 }] };
    // 自治占领兜底（2026-10-13，autoClaim 场景）：挑中正南房（from map），claimer 在途、开荒记录标 autonomous；目标 controller 尚未归属
    okReport.rootMemories[ROOMS.autoClaimHome] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.autoClaimHome]: { autoClaim: { at: 5, room: ROOMS.autoClaimTarget, from: 'map', named: false, distance: 1 },
            autoClaimPicked: { room: ROOMS.autoClaimTarget, from: 'map', at: 5, distance: 1 },
            expansion: { target: ROOMS.autoClaimTarget, spawnPos: null, since: 5, autonomous: true } } },
        creeps: { 'claimer-1': { role: 'claimer', home: ROOMS.autoClaimHome, targetRoom: ROOMS.autoClaimTarget, slotKey: 'claimer:' + ROOMS.autoClaimTarget } } };
    okReport.autoClaimScene = { owned: false, level: 0, creeps: [{ name: 'claimer-1', room: ROOMS.autoClaimHome }] };
    // 自治占领的 CPU 闸（2026-10-13 复审，autoClaimCpu 场景）：同样掉线，近期用量远超线 ⇒ 被挡下、没有开荒
    okReport.rootMemories[ROOMS.autoClaimCpuHome] = { errors: [], stats: [{ cpu: 1 }],
        rooms: { [ROOMS.autoClaimCpuHome]: { autoClaim: { at: 5, room: null, why: 'cpu', bucket: 10000, mean: 1000, line: 112 },
            autoClaimCpuHeld: { first: 5, at: 5, n: 1, bucket: 10000, mean: 1000, line: 112 } } }, creeps: {} };
    okReport.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].industryState = { labs: { present: 0, configured: false, derived: null, target: null, product: null, active: false, gated: true } };
    for (const [id, mutate] of [
        // 旧行为：没人往 lab 里装货（没有 labTech 遥测）；装了货但反应没跑（没有 OH）；lab 被拆
        ['minerals.labChain', (report) => { delete report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labTech; }],
        ['minerals.labChain', (report) => { report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labTech.loaded = 0; }],
        ['minerals.labChain', (report) => { report.labChain.rooms[ROOMS.labHome][2].store = { energy: 0 }; }],
        ['minerals.labChain', (report) => { report.labChain.rooms[ROOMS.labHome] = report.labChain.rooms[ROOMS.labHome].slice(2); }],
        ['minerals.labChain', (report) => { delete report.rootMemories[ROOMS.labHome]; }],
        // 旧行为：只会按 lab 里已有的矿物推导/贪心配对（没有 step 或 step 没有 target）
        ['industry.reactionChain', (report) => { delete report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labRoles; }],
        ['industry.reactionChain', (report) => { report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labRoles.step.target = null; }],
        ['industry.reactionChain', (report) => { report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].industryState.labs.target = null; }],
        // 旧行为：没有 boost lab（产物只回 terminal）；boost lab 没装上；boost lab 混进了三连
        ['industry.boostLab', (report) => { delete report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labRoles.boost; }],
        ['industry.boostLab', (report) => { report.labChain.rooms[ROOMS.labHome][3].store = { energy: 1200 }; }],
        ['industry.boostLab', (report) => { report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labRoles.boost = 'lc'; }],
        // 旧行为：投递目标里没有 lab（没有 labEnergy、boost lab 0 能量）；所有 lab 都补
        // 旧行为：没有 boost 代码（没有 boostLog、lab 原封不动、身体没强化）；只强化了一部分；场景没播种
        // 旧行为（3d5d49f）：闸关分支不记 boostLab；没出补能任务；boost lab 0 能量；三连被补；不是闸关分支；场景没播种
        ['industry.boostLabGatedEnergy', (report) => { delete report.rootMemories[ROOMS.boostLabGated].rooms[ROOMS.boostLabGated].industryState.labs.boostLab; }],
        ['industry.boostLabGatedEnergy', (report) => { delete report.rootMemories[ROOMS.boostLabGated].rooms[ROOMS.boostLabGated].labEnergy; }],
        ['industry.boostLabGatedEnergy', (report) => { report.labChain.rooms[ROOMS.boostLabGated][3].store = { energy: 0, XZH2O: 600 }; }],
        ['industry.boostLabGatedEnergy', (report) => { report.labChain.rooms[ROOMS.boostLabGated][0].store = { energy: 500 }; }],
        ['industry.boostLabGatedEnergy', (report) => { report.rootMemories[ROOMS.boostLabGated].rooms[ROOMS.boostLabGated].industryState.labs.gated = false; }],
        ['industry.boostLabGatedEnergy', (report) => { delete report.rootMemories[ROOMS.boostLabGated]; }],
        // 旧行为（强化没打开也补）：出了 labEnergy、boost lab 被补了能量、没有 labEnergyHeld；前提不对：没有 boost lab、用户的指令打开了强化
        ['broker.labEnergyNeedsBoosts', (report) => { report.rootMemories.E40S40.rooms.E40S40.labEnergy = { at: 300, want: 2000, lab: 'lab4', energy: 0 }; }],
        ['broker.labEnergyNeedsBoosts', (report) => { report.labChain.rooms[ROOMS.industry][1].store = { energy: 2000 }; }],
        ['broker.labEnergyNeedsBoosts', (report) => { delete report.rootMemories.E40S40.rooms.E40S40.labEnergyHeld; }],
        ['broker.labEnergyNeedsBoosts', (report) => { delete report.rootMemories.E40S40.rooms.E40S40.labRoles; }],
        ['broker.labEnergyNeedsBoosts', (report) => { report.rootMemories.E40S40.conquest = [{ target: 'W99N99', sponsors: ['E40S40'], boosts: { dismantler: ['XZH2O'] } }]; }],
        ['broker.labEnergyNeedsBoosts', (report) => { report.labChain.rooms[ROOMS.industry] = []; }],
        ['combat.boostBeforeLaunch', (report) => { delete report.rootMemories[ROOMS.boostHome].rooms[ROOMS.boostHome].boostLog; }],
        ['combat.boostBeforeLaunch', (report) => { report.boostScene.labs[0].store = { energy: 2000, XZH2O: 600 }; }],
        ['combat.boostBeforeLaunch', (report) => { report.boostScene.creep.body[2].boost = null; }],
        ['combat.boostBeforeLaunch', (report) => { report.rootMemories[ROOMS.boostHome].rooms[ROOMS.boostHome].boostLog[0].parts = 1; }],
        ['combat.boostBeforeLaunch', (report) => { report.boostScene.labs = []; }],
        ['combat.boostBeforeLaunch', (report) => { delete report.rootMemories[ROOMS.boostHome]; }],
        // 旧行为：keeper 房永久停用（没有记录 / 不是 SK）；没有 reaper 闸（从没扣过矿工）；reaper 没到岗；keeper 毫发无伤；没开火；
        // 矿工没采到 / 比 reaper 先开采；夹具没删 controller；场景没播种
        ['sk.keeperMining', (report) => { delete report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom]; }],
        ['sk.keeperMining', (report) => { const r = report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom]; r.sk = false; r.enabled = false; r.suspendReason = 'keeperRoom'; }],
        ['sk.keeperMining', (report) => { delete report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom].skWaitReaper; }],
        ['sk.keeperMining', (report) => { delete report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom].skStation; }],
        ['sk.keeperMining', (report) => { report.skScene.keepers.push({ id: 'k0', name: 'Keeperl0', hits: 5000 }); }],
        ['sk.keeperMining', (report) => { report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom].skReaper.shots = 0; }],
        ['sk.keeperMining', (report) => { delete report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom].skHarvest; }],
        ['sk.keeperMining', (report) => { report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skRoom].skHarvest.first = 100; }],
        ['sk.keeperMining', (report) => { report.skScene.controller = true; }],
        ['sk.keeperMining', (report) => { delete report.rootMemories[ROOMS.skHome]; }],
        // 旧行为：回收的 reaper 被记成阵亡（skLosses / 永久停用被改写成 skReaperLost）；两只都没走到回收；活着的没标 retired；场景没播种
        ['sk.demotedReaperNotLoss', (report) => { report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skDemoted].skLosses = { n: 1, at: 9 }; }],
        ['sk.demotedReaperNotLoss', (report) => { report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skDemoted].suspendReason = 'skReaperLost'; }],
        ['sk.demotedReaperNotLoss', (report) => { report.rootMemories[ROOMS.skHome].creeps['sk-demoted-reaper-0'] = { role: 'skReaper', retired: true }; }],
        ['sk.demotedReaperNotLoss', (report) => { delete report.rootMemories[ROOMS.skHome].creeps['sk-demoted-reaper-1'].retired; }],
        ['sk.demotedReaperNotLoss', (report) => { delete report.rootMemories[ROOMS.skHome].rooms[ROOMS.skHome].remotes[ROOMS.skDemoted]; }],
        ['sk.demotedReaperNotLoss', (report) => { delete report.rootMemories[ROOMS.skHome]; }],
        // 旧行为：掉线后不挑目标；挑了 decoy（不看 owner）；挑了但没去占；别的场景（没有掉线的大脑）也跑了兜底；场景没播种
        ['expansion.autoClaimOffline', (report) => { delete report.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].autoClaimPicked; }],
        ['expansion.autoClaimOffline', (report) => { report.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].autoClaimPicked.room = ROOMS.autoClaimDecoy; }],
        ['expansion.autoClaimOffline', (report) => { report.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].autoClaimPicked.from = 'queue'; }],
        ['expansion.autoClaimOffline', (report) => { delete report.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].expansion.autonomous; }],
        ['expansion.autoClaimOffline', (report) => { report.rootMemories[ROOMS.autoClaimHome].creeps = {}; }],
        ['expansion.autoClaimOffline', (report) => { delete report.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].expansion; }],
        ['expansion.autoClaimOffline', (report) => { report.rootMemories[ROOMS.claimBlocked].rooms[ROOMS.claimBlocked].autoClaim = { at: 1, room: ROOMS.claimBlockedTarget }; }],
        ['expansion.autoClaimOffline', (report) => { delete report.rootMemories[ROOMS.autoClaimHome]; }],
        // 旧行为：没有 CPU 闸（没有 autoClaimCpuHeld、直接开荒）；挡住的同时开了荒；场景没播种
        ['expansion.autoClaimCpuGate', (report) => { delete report.rootMemories[ROOMS.autoClaimCpuHome].rooms[ROOMS.autoClaimCpuHome].autoClaimCpuHeld; }],
        ['expansion.autoClaimCpuGate', (report) => { report.rootMemories[ROOMS.autoClaimCpuHome].rooms[ROOMS.autoClaimCpuHome].autoClaimCpuHeld.mean = 50; }],
        ['expansion.autoClaimCpuGate', (report) => { report.rootMemories[ROOMS.autoClaimCpuHome].rooms[ROOMS.autoClaimCpuHome].expansion = { target: ROOMS.autoClaimCpuTarget, since: 3, autonomous: true }; }],
        ['expansion.autoClaimCpuGate', (report) => { report.rootMemories[ROOMS.autoClaimCpuHome].creeps = { c: { role: 'claimer', targetRoom: ROOMS.autoClaimCpuTarget } }; }],
        ['expansion.autoClaimCpuGate', (report) => { delete report.rootMemories[ROOMS.autoClaimCpuHome]; }],
        ['broker.labEnergy', (report) => { delete report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].labEnergy; }],
        ['broker.labEnergy', (report) => { report.labChain.rooms[ROOMS.labHome][3].store.energy = 0; }],
        ['broker.labEnergy', (report) => { report.labChain.rooms[ROOMS.labHome][0].store.energy = 2000; }],
        // 旧行为：闸关着也照算计划（没有 gated）；闸开着的房也被挡住
        ['industry.labPlanGated', (report) => { delete report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].industryState.labs.gated; }],
        ['industry.labPlanGated', (report) => { report.rootMemories[ROOMS.labHome].rooms[ROOMS.labHome].industryState.labs.gated = true; }],
        // 旧行为：终端只发能量（没有 mineral 遥测）；发错方向/资源；记了但 O 没过去（labHome 的 O+OH 仍是播种的 600）；发送方 O 没少
        ['terminal.mineralTransfer', (report) => { delete report.rootMemories[ROOMS.labHome].terminalNetwork; }],
        ['terminal.mineralTransfer', (report) => { report.rootMemories[ROOMS.labHome].terminalNetwork.mineral.sent = 0; }],
        ['terminal.mineralTransfer', (report) => { report.rootMemories[ROOMS.labHome].terminalNetwork.mineral.last.to = ROOMS.labPeer; }],
        ['terminal.mineralTransfer', (report) => { report.rootMemories[ROOMS.labHome].terminalNetwork.mineral.last.resource = 'energy'; }],
        ['terminal.mineralTransfer', (report) => { report.labChain.rooms[ROOMS.labHome] = [{ id: 't', type: 'terminal', store: { O: 400 } }, { id: 'lc', type: 'lab', store: { OH: 200 } }]; }],
        ['terminal.mineralTransfer', (report) => { report.labChain.rooms[ROOMS.labPeer][0].store.O = 6000; }],
        // 旧行为：投递目标里没有 terminal（没有 terminalFill、terminal 一直 0）；补能把 storage 抽到门槛以下也不算
        ['broker.terminalFill', (report) => { delete report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalHome].terminalFill; }],
        ['broker.terminalFill', (report) => { report.terminalNet.rooms[ROOMS.terminalHome][1].store.energy = 0; delete report.rootMemories[ROOMS.terminalHome].terminalNetwork; }],
        ['broker.terminalFill', (report) => { report.terminalNet.rooms[ROOMS.terminalHome] = [{ type: 'storage', store: { energy: 180000 } }]; }],
        ['broker.terminalFill', (report) => { report.terminalNet.rooms[ROOMS.terminalHome][0].store.energy = 1000; }],
        ['broker.terminalFill', (report) => { delete report.rootMemories[ROOMS.terminalHome]; }],
        // 旧行为：没有终端网络（没有 terminalNetwork）；发错方向；send 全失败；接收房 terminal 空且没取过；storage 0 的接收房被补能
        ['terminal.network', (report) => { delete report.rootMemories[ROOMS.terminalHome].terminalNetwork; }],
        ['terminal.network', (report) => { report.rootMemories[ROOMS.terminalHome].terminalNetwork.last.to = 'W1N1'; }],
        ['terminal.network', (report) => { report.rootMemories[ROOMS.terminalHome].terminalNetwork.sent = 0; }],
        ['terminal.network', (report) => { report.terminalNet.rooms[ROOMS.terminalPeer][1].store.energy = 0; delete report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].terminalDrain; }],
        ['terminal.network', (report) => { report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].terminalFill = { at: 5, want: 1000 }; }],
        // 旧行为：没有市场模块（没有 Memory.market）；卖错房/资源；deal 全失败；买单剩余量没变；买单被 cron 删了
        ['market.sellSurplus', (report) => { delete report.rootMemories[ROOMS.terminalHome].market; }],
        ['market.sellSurplus', (report) => { report.rootMemories[ROOMS.terminalHome].market.last.resource = 'energy'; }],
        ['market.sellSurplus', (report) => { report.rootMemories[ROOMS.terminalHome].market.deals = 0; }],
        ['market.sellSurplus', (report) => { report.terminalNet.npcOrders[0].remainingAmount = 6000; }],
        ['market.sellSurplus', (report) => { report.terminalNet.npcOrders = []; }],
        // 2026-10-14：成交史被 cron 清空 ⇒ avg null、一单没做（why 里要带 avg/marketStats，见下方 why 断言）
        ['market.sellSurplus', (report) => { const mk = report.rootMemories[ROOMS.terminalHome].market; delete mk.last; mk.deals = 0; mk.avg = { U: { at: 600, avg: null } }; report.terminalNet.marketStats = 0; }],
        // 旧行为：hauler 不认 terminal 取货（没有 terminalDrain）；富余母房也在取
        ['hauler.terminalDrain', (report) => { delete report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].terminalDrain; }],
        ['hauler.terminalDrain', (report) => { report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalPeer].terminalDrain.amount = 0; }],
        ['hauler.terminalDrain', (report) => { report.rootMemories[ROOMS.terminalHome].rooms[ROOMS.terminalHome].terminalDrain = { n: 1, amount: 500 }; }],
        // 旧顺序：不写 oneOffAhead（terminal 排在塔之后）；extNeed 0 说明场景没摆出饥饿窗口；luxuryHeld 消失说明 lab 门槛被一起放开了
        ['layout.oneOffBeforeRoads', (report) => { delete report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutOneOff].oneOffAhead; }],
        ['layout.oneOffBeforeRoads', (report) => { report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutOneOff].oneOffAhead.type = 'storage'; }],
        ['layout.oneOffBeforeRoads', (report) => { report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutOneOff].oneOffAhead.extNeed = 0; }],
        ['layout.oneOffBeforeRoads', (report) => { delete report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutOneOff].luxuryHeld; }],
        ['layout.oneOffBeforeRoads', (report) => { delete report.rootMemories[ROOMS.layoutOneOff]; }],
        // 旧行为：富余滞回开着时不取 terminal（没有 terminalDrainLow）；出了任务但 hauler 没取；场景没播种
        ['broker.terminalDrainLow', (report) => { delete report.rootMemories[ROOMS.terminalDrainLow].rooms[ROOMS.terminalDrainLow].terminalDrainLow; }],
        ['broker.terminalDrainLow', (report) => { delete report.rootMemories[ROOMS.terminalDrainLow].rooms[ROOMS.terminalDrainLow].terminalDrain.low; }],
        ['broker.terminalDrainLow', (report) => { delete report.rootMemories[ROOMS.terminalDrainLow].rooms[ROOMS.terminalDrainLow].terminalDrain; }],
        ['broker.terminalDrainLow', (report) => { delete report.rootMemories[ROOMS.terminalDrainLow]; }],
        // 旧行为：提前开着时不跑兜底轮（没有 oneOffLeftover）；放的不是 terminal；extension 不缺；场景没播种
        ['layout.oneOffLeftover', (report) => { delete report.rootMemories[ROOMS.layoutLeftover].rooms[ROOMS.layoutLeftover].oneOffLeftover; }],
        ['layout.oneOffLeftover', (report) => { report.rootMemories[ROOMS.layoutLeftover].rooms[ROOMS.layoutLeftover].oneOffLeftover.type = 'storage'; }],
        ['layout.oneOffLeftover', (report) => { report.rootMemories[ROOMS.layoutLeftover].rooms[ROOMS.layoutLeftover].oneOffLeftover.extNeed = 0; }],
        ['layout.oneOffLeftover', (report) => { delete report.rootMemories[ROOMS.layoutLeftover]; }],
        // 同 tick 早轮已放过、兜底轮又写 oneOffLeftover：重复放置的假阳性
        ['layout.oneOffLeftover', (report) => { report.rootMemories[ROOMS.layoutLeftover].rooms[ROOMS.layoutLeftover].oneOffAhead = { at: 3, type: 'terminal', extNeed: 10, level: 6 }; }],
        // 旧行为：兜底轮同 tick 重放 terminal（同 tick 的 oneOffLeftover、没有去重遥测）；早轮没放出（前提没摆出来）；去重时已没名额
        ['layout.oneOffSameTickDedupe', (report) => { const m = report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe];
            delete m.oneOffDeduped; m.oneOffLeftover = { at: 7, type: 'terminal', extNeed: 10, level: 6 }; }],
        ['layout.oneOffSameTickDedupe', (report) => { report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe].oneOffLeftover = { at: 7, type: 'terminal', extNeed: 10, level: 6 }; }],
        ['layout.oneOffSameTickDedupe', (report) => { delete report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe].oneOffDeduped; }],
        ['layout.oneOffSameTickDedupe', (report) => { delete report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe].oneOffAhead; }],
        ['layout.oneOffSameTickDedupe', (report) => { report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe].oneOffDeduped.budget = 0; }],
        ['layout.oneOffSameTickDedupe', (report) => { report.rootMemories[ROOMS.layoutOneOff].rooms[ROOMS.layoutDedupe].oneOffDeduped.at = 40; }],
        // 控制器容器贴着源：夹具没摆出几何；旧行为（hauler park、从没走 storage 兜底、控制器进度 0）；storage 被取穿底线
        ['hauling.ctrlContainerBesideSource', (report) => { delete report.rootMemories.W41N40._validationCtrlBesideSource; }],
        ['hauling.ctrlContainerBesideSource', (report) => { report.rootMemories.W41N40._validationCtrlBesideSource.source = { x: 45, y: 30 }; }],
        ['hauling.ctrlContainerBesideSource', (report) => { delete report.rootMemories.W41N40.rooms.W41N40.storageConsumerFallback; report.storageConsumerProgress = 0; }],
        ['hauling.ctrlContainerBesideSource', (report) => { report.storageConsumerProgress = 0; }],
        ['hauling.ctrlContainerBesideSource', (report) => { report.probeMemories.W41N40._validationRooms.W41N40.storage = 1500; }],
        // 旧行为：needsAid 只看直线距离（没有 aidNoRoute、给弱房孵援建 creep），搁浅的 creep 原地寻路到老死
        ['aid.safeRoute', (report) => { delete report.rootMemories[ROOMS.aidSafeHome].rooms[ROOMS.aidSafeHome].aidNoRoute; }],
        ['aid.safeRoute', (report) => { delete report.rootMemories[ROOMS.aidSafeHome].rooms[ROOMS.aidSafeFar].aidStranded; }],
        ['aid.safeRoute', (report) => { report.rootMemories[ROOMS.aidSafeHome].creeps['aid-safe-stranded-hauler'] = { role: 'hauler', home: ROOMS.aidSafeFar, aid: ROOMS.aidSafeHome, bodyUpgradeRetiring: true }; }],
        ['aid.safeRoute', (report) => { report.rootMemories[ROOMS.aidSafeHome].creeps.x = { role: 'harvester', home: ROOMS.aidSafeFar, aid: ROOMS.aidSafeHome }; }],
        ['aid.safeRoute', (report) => { delete report.rootMemories[ROOMS.aidSafeHome]; }],
        // terminal 不受门槛：工地没推进（旧行为：门槛挡着）必须判红；lab 工地在 storage 0 时出现也必须判红
        ['audit.terminalUngated', (report) => { report.audit[ROOMS.auditHome][1].progress = 1000; }],
        ['audit.luxuryGate', (report) => { report.audit[ROOMS.auditHome].push({ type: 'constructionSite', structureType: 'lab', x: 26, y: 25, progress: 0 }); }],
        ['spawn.quietDemandSkip', (report) => { report.rootMemories.W40N40.rooms.W40N40.demand.quietSkipped = 0; }],
        // 出生口袋：没有口袋遥测（旧代码不看口袋）、或新孵的 creep 进了口袋格，都必须判红
        ['spawn.pocketDirections', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnPocket; }],
        ['spawn.pocketDirections', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnPocket.AuditPocketSpawn.dirs = [1, 4, 5, 6]; }],
        ['spawn.pocketDirections', (report) => { report.audit[ROOMS.auditPocket].push({ type: 'creep', name: 'audit-pocket-trapped', x: 20, y: 20, body: ['work', 'carry', 'move'] }); }],
        ['spawn.pocketMineralObstacle', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].auditSeed.pocket.mineral; }],
        ['spawn.pocketMineralObstacle', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnPocket.AuditPocketSpawn.pockets = []; }],
        // 出生口袋：卡过的出生落进口袋（bornPocket）也必须判红
        ['spawn.pocketDirections', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnStallLog.bornPocket = 1; }],
        // 看门狗（改在 auditWalled 观察）：退役没超过播种次数（旧代码没有看门狗）、或卡死的升级者结束时还在，都必须判红
        ['upgrader.stuckWatchdog', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck; }],
        ['upgrader.stuckWatchdog', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck.retire = 2; }],
        ['upgrader.stuckWatchdog', (report) => { report.audit[ROOMS.auditWalled].push({ type: 'creep', name: 'audit-walled-upgrader', x: 25, y: 30, body: ['work', 'carry', 'move'] }); }],
        ['upgrader.stuckRepathPerCreep', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck.reset; }],
        ['upgrader.stuckRepathPerCreep', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck.repath = 0; }],
        ['upgrader.stuckBackoff', (report) => { const log = report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck; delete log.backoffs; delete log.backoffUntil; }],
        ['upgrader.stuckBackoff', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck.retire = 5; }],
        ['upgrader.stuckBackoff', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].upgraderStuck.retire = 2; }],
        ['upgrader.stuckBackoff', (report) => { report.audit[ROOMS.auditWalled].push({ type: 'creep', name: 'audit-walled-upgrader', x: 25, y: 30, body: ['work', 'carry', 'move'] }); }],
        // 口袋里的 creep 回收：没有 trapped 遥测（旧代码）、标记了没回收、或结束时还在口袋里，都必须判红
        ['spawn.pocketTrappedRecycle', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnStallLog.trapped; }],
        ['spawn.pocketTrappedRecycle', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].spawnStallLog.trapped.recycled = 0; }],
        ['spawn.pocketTrappedRecycle', (report) => { report.audit[ROOMS.auditPocket].push({ type: 'creep', name: 'audit-pocket-upgrader', x: 20, y: 20, body: ['work', 'carry', 'move'] }); }],
        // 出口让路：没有让路记录（旧代码只放开方向）、生进口袋（旧兜底）、没靠让路生在 RIGHT、兜底放开了口袋方向、结束时口袋格有 creep，都必须判红
        ['spawn.exitVacate', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog.vacate; }],
        ['spawn.exitVacate', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog.vacate.moved = 0; }],
        ['spawn.exitVacate', (report) => { const b = report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog.bornHistory[0]; b.x = 24; b.y = 34; b.pocket = true; }],
        ['spawn.exitVacate', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog.bornHistory = []; }],
        ['spawn.exitVacate', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog.bornHistory[0].vacate = null; }],
        ['spawn.exitVacate', (report) => { Object.assign(report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditWalled].spawnStallLog, { n: 1, from: [3, 5], to: [3, 5, 1, 2, 4, 6, 7, 8] }); }],
        ['spawn.exitVacate', (report) => { report.audit[ROOMS.auditWalled].push({ type: 'creep', name: 'audit-walled-x', x: 24, y: 34, body: ['carry', 'move'] }); }],
        // 供给封顶：没有 sizeCap 遥测（旧代码按瞬时限流定身体）、或新孵的升级者超过封顶（限流放开时的 W21/W47），都必须判红
        ['spawn.upgraderSupplyCap', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditPocket].upgradeSupply.sizeCap; }],
        ['spawn.upgraderSupplyCap', (report) => { report.audit[ROOMS.auditPocket][2].body = Array(21).fill('work').concat(['carry', 'carry', 'move']); }],
        ['audit.wallNotCritical', (report) => { report.audit[ROOMS.auditRich][0].hits = 12000000; }],
        ['audit.vitalFirst', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].spawnFirst.key = 'core:upgrader:0'; }],
        ['audit.linkMinersNotCarriers', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].spawnIncome.minerNotCarrier; }],
        ['audit.remoteLegRepaired', (report) => { report.audit[ROOMS.auditHome][0].hits = 1900; }],
        ['audit.zeroIncomeVitalOnly', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditZero].spawnLog = [{ key: 'core:builder:0', cost: 600, scaled: true }]; }],
        ['audit.outOfReachDebtFloor', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditLink].outOfReachBelowFloor; }],
        ['audit.upgradeCapNeedsDemand', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditLink].upgradeSupply.capFree; }],
        ['audit.upgradeCapNearFull', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditLink].upgradeSupply.unfullIgnored; }],
        ['audit.coreHaulerSized', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].haulerSize; }],
        ['audit.builderRepairHold', (report) => { report.audit[ROOMS.auditRich][2].hits = 1300; }],
        ['audit.builderRepairHold', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].builderRepairHold; }],
        ['audit.reserverNeedsMiner', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditDrop].reserverWeakMiner; }],
        ['audit.minerUpgradeUrgent', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].minerUpgradeUrgent; }],
        ['audit.lostContainerHauler', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditDrop].containerLostHaul; }],
        ['audit.minerPickupBuild', (report) => { report.audit[ROOMS.auditDrop][0].progress = 1000; }],
        ['audit.remoteEntryTowardHome', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditDrop].entry = { x: 0, y: 25 }; }],
        // 矿物外送：容量 300 的夹具下 1W 矿工到结束都没装满、一次没投递（validation-P08lHz：harvested 77、没有 delivered）
        ['minerals.externalDelivery', (report) => { report.rootMemories.E40S40.rooms.E40S40.mineralStats = { harvested: 77 }; }],
        // storage 富余：闩锁缺失（包装没装上/被冲掉）或只有零星几次（旧规则下 hauler 不碰 storage）都判未生效
        ['upgrade.storageRich', (report) => { delete report.rootMemories.E15S15._storageUpgradeFeed; }],
        ['upgrade.storageRich', (report) => { report.rootMemories.E15S15._storageUpgradeFeed = { direct: 0, hauled: 300, link: 0, withdrawn: 11000, total: 300 }; }],
        // 维修池：闩锁里只有 rampart（旧写法 FIND_MY_STRUCTURES 的池子）、快照里也没有中立建筑 → 判未生效
        ['maintenance.repairPoolNeutral', (report) => { report.rootMemories.W61N60._repairPoolNeutral = { t: 2, type: 'rampart', backlog: 9000, n: 1 };
            report.maintenanceEarly.repair = [['rampart', 3, 94399]]; report.probeMemories.W61N60._validationRooms.W61N60.repair = [['rampart', 3, 95199]]; }],
        ['maintenance.repairPoolNeutral', (report) => { delete report.rootMemories.W61N60._repairPoolNeutral;
            report.maintenanceEarly.repair = []; report.probeMemories.W61N60._validationRooms.W61N60.repair = [['rampart', 3, 95199]]; }],
        ['audit.orphanRoadSitesPruned', (report) => { report.audit[ROOMS.auditRemote].push({ type: 'constructionSite', structureType: 'road', x: 5, y: 6, progress: 0 }); }],
        // 过境路线停用后它就是孤儿：还挂着就必须判红（wanted 只认启用外矿）
        ['audit.orphanRoadSitesPruned', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditDrop].enabled = false; }],
        // 防同义反复：播种的零进度工地全落在启用路线上（真孤儿不足 3 个）时不能平凡通过
        ['audit.orphanRoadSitesPruned', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditDrop].sources[0].routeRoads[ROOMS.auditRemote] = '8.10;5.5;5.6'; }],
        // 新语义：有进度的孤儿不能还以**工地**的形式挂着（旧断言要求它留下，2653a40 翻转）
        ['audit.orphanRoadSitesPruned', (report) => { report.audit[ROOMS.auditRemote].push({ type: 'constructionSite', structureType: 'road', x: 6, y: 6, progress: 100 }); }],
        // 清掉了却没把丢掉的进度记进 lost（且 (6,6) 也不是被建完的路）：遥测缺了止损的账
        ['audit.orphanRoadSitesPruned', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].remotes[ROOMS.auditRemote].orphanRoadSites.lost; }],
        ['audit.coreHaulerSized', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].haulerSize.parts = 24; }],
        ['audit.reserveAtAcceptedBody', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].reserveLog.hauler.cost = 1800; }],
        // 按 CARRY 定编（2026-09-12）：旧格式的尺寸记录、没有实测却低于兜底、只数 × 每只盖不住 C* 都判未生效
        ['audit.coreHaulerSized', (report) => { delete report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].haulerSize.heads; }],
        ['audit.coreHaulerSized', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].haulerSize.parts = 8; }],
        ['audit.coreHaulerSized', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditRich].haulerSize.heads = 1; }],
        ['hauling.spawnSpend', (report) => { delete report.rootMemories.W50N50.rooms.W50N50.spawnSpend; }],
        ['hauling.spawnSpend', (report) => { report.probeMemories.W50N50._validationRooms.W50N50.haulModel.spawnShare = 0.95; }],
        ['hauling.spawnSpend', (report) => { delete report.probeMemories.W50N50._validationRooms.W50N50.haulModel.spend; }],
        ['hauling.hubBaseRefill', (report) => { delete report.rootMemories.E20S20.rooms.E20S20.haulerSize; }],
        ['hauling.hubBaseRefill', (report) => { report.rootMemories.E20S20.rooms.E20S20.haulerSize.base = 0; }],
        ['hauling.tempHead', (report) => { delete report.rootMemories.W50N50.rooms.W50N50.haulTemp; }],
        ['hauling.measuredSize', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].haulCtl.meas.n = 1800; }],
        ['hauling.measuredSize', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].haulCtl.decisions[0].mode = 'fallback'; }],
        ['hauling.measuredSize', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].haulCtl.decisions[0].per = 15; }],
        ['hauling.measuredSize', (report) => { report.rootMemories[ROOMS.auditHome].rooms[ROOMS.auditHome].state = { emergencyHarvest: true }; }],
        ['hauling.linkFloor', (report) => { report.probeMemories.E20S20._validationRooms.E20S20.haulModel.temp = 'refill'; }],
        ['haulStats.telemetry', (report) => { delete report.rootMemories.W40N40.haulStats; }],
        ['haulStats.telemetry', (report) => { report.rootMemories.W40N40.haulStats.rooms.W40N40.hauler.mvE = 31; }],
        ['haulStats.telemetry', (report) => { report.rootMemories.W40N40.haulStats.rooms.W40N40.hauler.out = 0; }],
        ['haulStats.telemetry', (report) => { report.rootMemories.W40N40.haulStats.v = 1; }],
        ['haulStats.telemetry', (report) => { report.rootMemories.W40N40.haulStats.rooms.W40N40.hauler.idWa = 0; }],
        ['hauler.actAndMove', (report) => { report.rootMemories.W40N40.haulStats.rooms.W40N40.hauler.ch = 1; }],
        ['upgrader.linkBeforeStorage', (report) => { delete report.rootMemories.W60N60.rooms.W60N61.upgraderDrink; }],
        ['upgrader.linkRelief', (report) => { delete report.rootMemories.W60N60.rooms.W60N60.linkRelief; }],
        ['upgrader.linkReliefInPlace', (report) => { delete report.rootMemories.W60N60.rooms.W60N62.linkReliefInPlace; }],
        ['upgrader.linkReliefInPlace', (report) => { report.rootMemories.W60N60.rooms.W60N62.linkReliefInPlace.n = 0; }],
        // 2026-10-13 复审：决策记了但从没就地取到（空手站着）；每 tick 都判一次（卡住）
        ['upgrader.linkReliefInPlace', (report) => { report.rootMemories.W60N60.rooms.W60N62.linkReliefInPlace.drank = 0; }],
        ['upgrader.linkReliefInPlace', (report) => { Object.assign(report.rootMemories.W60N60.rooms.W60N62.linkReliefInPlace, { first: 100, at: 399, n: 300 }); }],
        ['movement.pathRefreshOnRoads', (report) => { delete report.rootMemories.W61N60.rooms.W61N60.pathRefresh; }],
        ['movement.pathRefreshOnRoads', (report) => { report.rootMemories.W61N60.rooms.W61N60.pathRefresh.regen = 0; }],
        ['broker.ctrlLinkSkipAtStorageStation', (report) => { delete report.rootMemories.W60N60.rooms.W60N61.ctrlLinkFeedSkip; }],
        ['hauler.hubBudgetedWithdraw', (report) => { delete report.rootMemories.E20S20.rooms.E20S20.hubBudgetedWithdraw; }],
        ['broker.spillHysteresis', (report) => { report.rootMemories.W40N40.rooms.W40N40.spillFlips = 0; }],
        ['broker.spillHysteresis', (report) => { report.rootMemories.W40N40.rooms.W40N40.spillFlips = 40; }],
        ['hauler.fillAtFedContainer', (report) => { delete report.rootMemories.W40N40.rooms.W40N40.haulFill; }],
        ['hauler.fillAtFedContainer', (report) => { report.rootMemories.W40N40.rooms.W40N40.haulFill.share = 0.1; }],
        ['broker.drySourceNoInflow', (report) => { delete report.rootMemories.W40N40.rooms.W40N40.haulInflowDry; }],
        ['broker.farClaimIgnored', (report) => { delete report.rootMemories.E15S15.rooms.E15S16.brokerFarClaims; }],
        // 旧代码不记 shed 遥测；强制没生效、scout 没被跳、不可跳的被跳、hauler 一 tick 跳两只、scout 被连跳饿死都不算生效
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { delete entry.shed; }); }],
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { entry.shed.forced = 0; }); }],
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { delete entry.shed.roles.scout; }); }],
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats[0].shed.roles.claimer = 1; }],
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { entry.shed.roles.hauler = 31; }); }],
        ['cpu.shedCritical', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { entry.shed.roles.scout = 30; }); }],
        ['cpu.tickLimitHardStop', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { delete entry.shed.hard; delete entry.shed.cut; delete entry.shed.hardEnd; }); }],
        ['cpu.tickLimitHardStop', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { entry.shed.cut = 0; }); }],
        ['cpu.tickLimitHardStop', (report) => { report.rootMemories.W70N70.stats.forEach((entry) => { entry.shed.hardEnd = 0; }); }],
        ['cpu.tickLimitHardStop', (report) => { delete report.rootMemories.W70N70.cpuHardStop; }],
        // 源顺序缓存（2026-10-13）：没有遥测 / 一次没命中 / 命中 ≥ 调用 / 写回被吃掉 / 矿工身份落在源顺序外都不算生效
        ['cpu.sourceOrderCache', (report) => { delete report.rootMemories.W40N40.stats[0].cache; }],
        ['cpu.sourceOrderCache', (report) => { report.rootMemories.W40N40.stats[0].cache.srcOrder = [300, 0]; }],
        ['cpu.sourceOrderCache', (report) => { report.rootMemories.W40N40.stats[0].cache.srcOrder = [300, 300]; }],
        ['cpu.sourceOrderCache', (report) => { delete report.rootMemories.W40N40.rooms.W40N40.sources; }],
        ['cpu.sourceOrderCache', (report) => { report.rootMemories.W40N40.creeps.hv.sourceId = 'srcZ'; }],
        // 工位判定缓存（2026-10-13）：没有遥测 / 一次没命中 / 命中 ≥ 调用 / 某用户的口径反了都不算生效
        ['cpu.workTileCache', (report) => { delete report.rootMemories.W40N40.stats[0].cache.workTile; }],
        ['cpu.workTileCache', (report) => { report.rootMemories.W40N40.stats[0].cache.workTile = [4200, 0]; }],
        ['cpu.workTileCache', (report) => { report.rootMemories.W40N40.stats[0].cache.workTile = [4200, 4200]; }],
        ['cpu.workTileCache', (report) => { report.rootMemories.W70N70.stats[0].cache = { workTile: [10, 30] }; }],
        // spawn 阶段计时（2026-10-13）：没有 cpuSpawn / 没记 pre / pre 之后一段都没有 / 出现未知阶段或负值都不算生效
        ['cpu.spawnPhases', (report) => { delete report.rootMemories.W40N40.stats[0].cpuSpawn; }],
        ['cpu.spawnPhases', (report) => { delete report.rootMemories.W40N40.stats[0].cpuSpawn.pre; }],
        ['cpu.spawnPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuSpawn = { pre: 0.1, exec: 0.01 }; }],
        ['cpu.spawnPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuSpawn.bogus = 1; }],
        ['cpu.spawnPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuSpawn.counts = -0.2; }],
        // 分发阶段计时（2026-10-13）：没有 cpuDispatch / run 或 start 没记到 / 未知阶段 / cpuRoles 被吃空都不算生效
        // 阶段计时变稀（2026-10-13 复审）：旧代码没有 cpuSampled；阶段与角色同频（6/6）；完整窗口一次都没量
        ['cpu.dispatchSparse', (report) => { delete report.rootMemories.W40N40.stats[0].cpuSampled; }],
        ['cpu.dispatchSparse', (report) => { report.rootMemories.W40N40.stats[0].cpuSampled = [6, 6]; }],
        ['cpu.dispatchSparse', (report) => { report.rootMemories.W40N40.stats[0].cpuSampled = [6, 0]; }],
        ['cpu.dispatchPhases', (report) => { delete report.rootMemories.W40N40.stats[0].cpuDispatch; }],
        ['cpu.dispatchPhases', (report) => { delete report.rootMemories.W40N40.stats[0].cpuDispatch.run; }],
        ['cpu.dispatchPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuDispatch.start = 0; }],
        ['cpu.dispatchPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuDispatch.vacate = 0.2; }],
        ['cpu.dispatchPhases', (report) => { report.rootMemories.W40N40.stats[0].cpuRoles = {}; }],
        ['cpu.pixelGate', (report) => { delete report.rootMemories.W70N70.pixelGate; }],
        ['cpu.pixelGate', (report) => { report.rootMemories.W70N70.pixelGate.mean = 90; }],
        ['hauler.mineralSalvage', (report) => { delete report.rootMemories.W60N60.rooms.W60N61.haulSalvage; }],
        ['hauler.salvagePickup', (report) => { delete report.rootMemories.W60N60.rooms.W60N61.salvaged; }],
        // 捡起来了但没卸进库（车上揣着 / 被扔掉）同样不算生效
        ['hauler.salvagePickup', (report) => { report.salvageSink = { sinks: [{ type: 'storage', store: { energy: 50000 } }], tombs: [], drops: [] }; }],
        // 库里只有被动出口卸的 K（同一夹具里 link-drink-salvage 身上那 200）：这是改动之前就有的行为，不能算生效
        ['hauler.salvagePickup', (report) => { report.salvageSink = { sinks: [{ type: 'storage', store: { energy: 50000, K: 200 } }], tombs: [], drops: [] }; }],
        ['hauler.storageResidualRelease', (report) => { delete report.rootMemories.W40N40.rooms.W40N40.haulCargoRelease; }],
        ['hauler.loadedSkipsStorage', (report) => { delete report.rootMemories.W40N40.rooms.W40N40.haulLoadedStorageSkip; }],
        ['remoteHauler.actAndMove', (report) => { delete report.rootMemories.W58N55.rooms.W58N55.remoteHaulAct; }],
        ['remoteHauler.actAndMove', (report) => { report.rootMemories.W58N55.rooms.W58N55.remoteHaulAct.acm = 5; }],
        ['remoteHauler.roadBuildMoves', (report) => { report.rootMemories.W58N55.rooms.W58N55.remoteHaul.buildMove = 0; }],
        ['remoteHauler.spotYield', (report) => { delete report.rootMemories.W58N55.rooms.W58N55.remoteHaul.stepOff; }],
        ['remoteHauler.spotYield', (report) => { report.rootMemories.W58N55.rooms.W58N55.remoteHaul.yieldLoad = 100; }],
        ['remoteHauler.ttlRetire', (report) => { delete report.rootMemories.W58N55.rooms.W58N55.remoteTtl; }],
        ['remote.measuredStops', (report) => { delete report.rootMemories.W58N55.rooms.W58N55.remoteStop; }],
        ['remote.measuredStops', (report) => { delete report.rootMemories.W58N55.rooms.W58N55.remotes.W58N53.sources[0].haulStops; }],
        ['remote.roadQuotaCountsOwnRemotesOnly', (report) => { delete report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].roadQuota; }],
        // 旧口径的结果：别人的工地占满配额时我自己的外矿一个都放不出来
        ['remote.roadQuotaCountsOwnRemotesOnly', (report) => { report.audit[ROOMS.roadTrailTarget] = []; }],
        // others 没统计到别人占着的工地：遥测就看不出配额被谁占着
        ['remote.roadQuotaCountsOwnRemotesOnly', (report) => { report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].roadQuota.others = 0; }],
        // 夹具没摆出前提（别人的工地不足以占满旧配额）：断言必须判红而不是蒙混通过
        ['remote.roadQuotaCountsOwnRemotesOnly', (report) => { report.audit[ROOMS.roadTrailForeign] = report.audit[ROOMS.roadTrailForeign].slice(0, 3); }],
        ['remote.roadTrailReplan', (report) => { delete report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].sources[0].roadReplan; }],
        // 断言不能只看遥测：路线必须逐格相邻（走出来的），且必须贴着矿位（播种的假路线离矿位 ≥ 12 格）
        ['remote.roadTrailReplan', (report) => { report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].sources[0].road = '21.21;21.20;40.40;19.20'; }],
        ['remote.roadTrailReplan', (report) => { report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].sources[0].spot = { x: 44, y: 44 }; }],
        // 遥测语义退化（roadReplan 被后续重规划整体覆盖，was 不再是播种的 5 格）必须判红——2026-09-12 就是这样误报的
        ['remote.roadTrailReplan', (report) => { Object.assign(report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].sources[0].roadReplan, { was: 29, tiles: 29 }); }],
        ['remote.roadTrailReplan', (report) => { delete report.rootMemories[ROOMS.roadTrailHome].rooms[ROOMS.roadTrailHome].remotes[ROOMS.roadTrailTarget].sources[0].roadReplan.n; }],
        // 旧行为三种形态：别人的 spawn 还在 / 拆了但没放出我们的 spawn / 没有拆除记录
        ['demolition.hostileQuota', (report) => { report.foreignQuota.push({ type: 'spawn', user: '2', x: 20, y: 20, progress: 0 }); }],
        ['demolition.hostileQuota', (report) => { report.foreignQuota = []; }],
        ['demolition.hostileQuota', (report) => { report.rootMemories.E50S50.rooms.E50S51.demolition = []; }],
        ['demolition.hostileQuota', (report) => { delete report.foreignQuota; }],
        // 旧行为：没有遥测（孵化中的替补不算覆盖）/ 同源两只矿工几 tick 内先后孵出 / 同源 3 只
        ['spawn.harvesterSpawningCovers', (report) => { delete report.rootMemories[ROOMS.minerPair].rooms[ROOMS.minerPair].harvesterSpawnCover; }],
        ['spawn.harvesterSpawningCovers', (report) => { report.rootMemories[ROOMS.minerPair].rooms[ROOMS.minerPair].harvesterSpawnCover.idle = 0; }],
        ['spawn.harvesterSpawningCovers', (report) => { report.rootMemories[ROOMS.minerPair].rooms[ROOMS.minerPair].spawnLog.push({ t: 337, key: 'core:harvester:2', cost: 650, scaled: false }); }],
        ['spawn.harvesterSpawningCovers', (report) => { report.rootMemories[ROOMS.minerPair].creeps.m1c = { role: 'harvester', home: ROOMS.minerPair, sourceIdx: 1, sourceId: 's1' }; }],
        // 旧行为的真实结束态：成对的两条孵化记录已被后续孵化挤出 spawnLog（只留 10 条），源 1 留着成对孵出的 2 只矿工
        ['spawn.harvesterSpawningCovers', (report) => {
            const mem = report.rootMemories[ROOMS.minerPair];
            mem.rooms[ROOMS.minerPair].spawnLog = Array.from({ length: 10 }, (unused, i) => ({ t: 400 + i * 30, key: 'development:hauler:' + i, cost: 1300, scaled: false }));
            mem.creeps.m1b = { role: 'harvester', home: ROOMS.minerPair, sourceIdx: 1, sourceId: 's1', staticMiner: true };
        }],
        ['spawn.harvesterSpawningCovers', (report) => { report.rootMemories[ROOMS.minerPair].rooms[ROOMS.minerPair].spawnLog = []; delete report.rootMemories[ROOMS.minerPair].creeps.m1; }],
        // 旧行为：每 tick 交一次采集量（5W 交 10），或者根本没有交货遥测
        ['harvester.batchTransfer', (report) => { report.rootMemories[ROOMS.minerPair].creeps.m0.xferBatch = 10; }],
        ['harvester.batchTransfer', (report) => { delete report.rootMemories[ROOMS.minerPair].creeps.m0.xferBatch; }],
        ['conquest.transitTowerAvoid', (report) => { report.conquestStructures.transitMinDist = 3; }],
        ['conquest.transitTowerAvoid', (report) => { report.conquestStructures.transitMinDist = null; }],
    ]) {
        const invalid = JSON.parse(JSON.stringify(okReport));
        mutate(invalid);
        assert.equal(effects.EFFECTS.find((effect) => effect.id === id).check(invalid, ROOMS).ok, false, id + ' must fail on the old behaviour');
    }
    // 已经占下（claimer 自杀、Memory.creeps 里没有它）：controller 归属（原始 DB）一条证据就够
    // 2026-10-14：没成交时 why 直接点出成交史为空（avg null / marketStats 0），而不是只怪传送费
    const marketEmpty = JSON.parse(JSON.stringify(okReport));
    delete marketEmpty.rootMemories[ROOMS.terminalHome].market.last;
    marketEmpty.rootMemories[ROOMS.terminalHome].market.avg = { U: { at: 600, avg: null } };
    marketEmpty.terminalNet.marketStats = 0;
    const marketWhy = effects.EFFECTS.find((effect) => effect.id === 'market.sellSurplus').check(marketEmpty, ROOMS);
    assert(!marketWhy.ok && /"avg":\{"U":\{"at":600,"avg":null\}\}/.test(marketWhy.why) && /"marketStats":0/.test(marketWhy.why), '没成交的 why 带上 avg 与 marketStats: ' + marketWhy.why);
    // 2026-10-14：钻机没孵出来时 why 带上 spawnLog 里 core:mineralMiner 的孵化 tick 与首轮 industry 大脑的 tick（分清孵晚了还是挖矿出错）
    const minerLate = { rootMemories: { [ROOMS.industry]: { rooms: { [ROOMS.industry]: { spawnLog: [{ t: 1, key: 'core:harvester:0' }, { t: 751, key: 'core:mineralMiner:0', cost: 700 }] } } } },
        probeMemories: { [ROOMS.industry]: { _validationRooms: { [ROOMS.industry]: { mined: { type: 'Z', terminal: 0, storage: 0, carried: 0, drones: 0 } } } } },
        industryBrainAt: 1 };
    const minerWhy = effects.EFFECTS.find((effect) => effect.id === 'minerals.extractorDrone').check(minerLate, ROOMS);
    assert(!minerWhy.ok && /"t":751,"key":"core:mineralMiner:0"/.test(minerWhy.why) && /"industryBrainAt":1/.test(minerWhy.why), '钻机没孵的 why 带孵化 tick 与大脑 tick: ' + minerWhy.why);
    const deliveryWhy = effects.EFFECTS.find((effect) => effect.id === 'minerals.externalDelivery').check(minerLate, ROOMS);
    assert(!deliveryWhy.ok && /core:mineralMiner:0/.test(deliveryWhy.why), '没投递的 why 带孵化 tick: ' + deliveryWhy.why);
    const autoClaimDone = JSON.parse(JSON.stringify(okReport));
    autoClaimDone.rootMemories[ROOMS.autoClaimHome].creeps = {};
    autoClaimDone.autoClaimScene = { owned: true, level: 1, creeps: [] };
    assert(effects.EFFECTS.find((effect) => effect.id === 'expansion.autoClaimOffline').check(autoClaimDone, ROOMS).ok, '目标已占下时自治占领仍算生效');
    // 2026-10-14 validation-mZRVaL：占下后重扫记 busy:<目标> 覆盖了 autoClaim，挑中的结论在 autoClaimPicked 里，仍算生效
    autoClaimDone.rootMemories[ROOMS.autoClaimHome].rooms[ROOMS.autoClaimHome].autoClaim = { at: 86, room: null, why: 'busy:' + ROOMS.autoClaimTarget };
    assert(effects.EFFECTS.find((effect) => effect.id === 'expansion.autoClaimOffline').check(autoClaimDone, ROOMS).ok, '占下后 autoClaim 被 busy 覆盖时自治占领仍算生效');
    // 被强化的 creep 已经退役回收（原始 DB 里没有它）：boostLog + lab 扣量两条证据仍够
    const boostRecycled = JSON.parse(JSON.stringify(okReport));
    boostRecycled.boostScene.creep = null;
    assert(effects.EFFECTS.find((effect) => effect.id === 'combat.boostBeforeLaunch').check(boostRecycled, ROOMS).ok, 'boost-siege 回收后 boostLog + lab 扣量仍算生效');
    // validation-u84Rjo 形态：两次快照都只剩 rampart，但闩锁记下了第 2 tick 池里的路 → 通过
    const latchedOnly = JSON.parse(JSON.stringify(okReport));
    latchedOnly.maintenanceEarly.repair = [];
    latchedOnly.probeMemories.W61N60._validationRooms.W61N60.repair = [['rampart', 3, 95199]];
    assert(effects.EFFECTS.find((effect) => effect.id === 'maintenance.repairPoolNeutral').check(latchedOnly, ROOMS).ok, 'latch observes the pool window the snapshots miss');
    // validation-jcpzXR 形态：storage 离控制器远、末态只降到 74161，但 storage 的能量确实进了升级 → 通过
    const farStorage = JSON.parse(JSON.stringify(okReport));
    farStorage.probeMemories.E15S15._validationRooms.E15S15.storage = 74161;
    assert(effects.EFFECTS.find((effect) => effect.id === 'upgrade.storageRich').check(farStorage, ROOMS).ok, 'end-state storage level no longer decides storageRich');
    const towerEffect = effects.EFFECTS.find(effect => effect.id === 'tower.maintenanceBudget');
    const storeEffect = effects.EFFECTS.find(effect => effect.id === 'demolition.keepsLoadedStore');
    const consumed = JSON.parse(JSON.stringify(okReport));
    consumed.probeMemories.W40N40._validationRooms.W40N40.towers = [500];
    consumed.probeMemories.E50S50._validationRooms.E50S50.stores = [['storage', 0]];
    assert(towerEffect.check(consumed, ROOMS).ok, 'spent maintenance energy is not a failure');
    assert(storeEffect.check(consumed, ROOMS).ok, 'energy consumption does not destroy a mineral-loaded store');
    consumed.towerMaintenance = [];
    consumed.protectedStore = null;
    assert(!towerEffect.check(consumed, ROOMS).ok, 'require actual tower repair');
    assert(!storeEffect.check(consumed, ROOMS).ok, 'replacement or missing store must fail');
    const failures = [];
    const collect = (condition, message) => { if (!condition) failures.push(message); };
    const results = effects.assertEffects(okReport, ROOMS, collect);
    assert.equal(failures.length, 0, '援建 hauler + courier 且 storage 减少：生效断言通过 ' + JSON.stringify(failures));
    assert(results.every((item) => item.ok));
    const controllerLinkEffect = effects.EFFECTS.find((effect) => effect.id === 'links.controllerConsumerReserve');
    for (const mutate of [
        (report) => { report.controllerLinkConsumerProgress = 0; },
        (report) => { report.probeMemories.W42N40._validationRooms.W42N40.storage = 1999; },
        (report) => { report.probeMemories.W42N40._validationRooms.W42N40.links = 0; },
    ]) {
        const invalid = JSON.parse(JSON.stringify(okReport));
        mutate(invalid);
        assert.equal(controllerLinkEffect.check(invalid, ROOMS).ok, false, 'controller link must produce upgrades while preserving the reserve');
    }
    const roadBudgetEffect = effects.EFFECTS.find((effect) => effect.id === 'remote.roadBudgetDelivery');
    for (const bad of [{ spent: 50, maxTripSpent: 50, deliveredTrips: 0, delivered: 0 },
        { spent: 600, maxTripSpent: 600, deliveredTrips: 1, delivered: 600 }]) {
        const badRoadBudget = JSON.parse(JSON.stringify(okReport));
        badRoadBudget.rootMemories.W58N55.rooms.W58N55.remoteRoadBudget = bad;
        assert.equal(roadBudgetEffect.check(badRoadBudget, ROOMS).ok, false, 'must complete delivery without exceeding per-trip budget');
    }
    const noReuse = JSON.parse(JSON.stringify(okReport));
    const salvageEffect = effects.EFFECTS.find((effect) => effect.id === 'remote.salvageBeforeContainer');
    const staffingEffect = effects.EFFECTS.find((effect) => effect.id === 'remote.incomeBudgetedStaffing');
    const overBudget = JSON.parse(JSON.stringify(okReport));
    overBudget.rootMemories.W50N50.rooms.W50N50.remoteStaff = { at: 700, income: 20, budget: 10, used: 30, staffed: ['W50N49'], dropped: [], cost: { W50N49: 30 } };
    assert.equal(staffingEffect.check(overBudget, ROOMS).ok, false, '买不起的外矿留在编制里必须判失败');
    const unknownIncome = JSON.parse(JSON.stringify(okReport));
    unknownIncome.rootMemories.W50N50.rooms.W50N50.remoteStaff = { at: 700, income: null, budget: null, used: 7, staffed: ['W50N49'], dropped: [], cost: { W50N49: 7 } };
    assert.equal(staffingEffect.check(unknownIncome, ROOMS).ok, true, '收入未知时不做预算（不裁编制）应通过');
    const noStaffTelemetry = JSON.parse(JSON.stringify(okReport));
    delete noStaffTelemetry.rootMemories.W50N50.rooms.W50N50.remoteStaff;
    assert.equal(staffingEffect.check(noStaffTelemetry, ROOMS).ok, false, '没有任何房评估外矿编制必须判失败');
    const overflowGround = JSON.parse(JSON.stringify(okReport));
    overflowGround.remoteGround = 5000;
    const minerEffect = effects.EFFECTS.find((effect) => effect.id === 'remote.minerNoGroundOverflow');
    assert.equal(minerEffect.check(overflowGround, ROOMS).ok, false, '满容器下矿工仍把能量丢地上必须判失败');
    const noSalvage = JSON.parse(JSON.stringify(okReport));
    delete noSalvage.rootMemories.W50N50.rooms.W50N50.remoteEnergySalvaged;
    assert.equal(salvageEffect.check(noSalvage, ROOMS).ok, false, '没有实际到账记录不能通过拾取生效断言');
    delete noReuse.rootMemories.W40N40.memReuse;
    const noReuseFailures = [];
    effects.assertEffects(noReuse, ROOMS, (condition, message) => { if (!condition) noReuseFailures.push(message); });
    assert(noReuseFailures.some((message) => message.includes('core.parsedMemoryReuse')), '没有 memReuse 时判未生效');
    const suppressOk = JSON.parse(JSON.stringify(okReport));
    suppressOk.rootMemories.E18S18 = suppressOk.rootMemories.E18S18 || { creeps: {}, conquest: [] };
    suppressOk.rootMemories.E18S18.conquest = [{ target: 'W38S9', sponsors: ['E18S18'], suppress: true, phase: 'deny', noClaim: true }];
    suppressOk.rootMemories.E18S18.creeps.dg0 = { role: 'downgrader', home: 'E18S18', targetRoom: 'W38S9', suppress: true };
    const suppressFail = [];
    const suppressResults = effects.assertEffects(suppressOk, ROOMS, (condition, message) => { if (!condition) suppressFail.push(message); });
    assert.equal(suppressFail.length, 0, 'suppress deny + downgrader：生效断言通过 ' + JSON.stringify(suppressFail));
    assert(suppressResults.every((item) => item.ok));
    const suppressBad = JSON.parse(JSON.stringify(suppressOk));
    suppressBad.rootMemories.E18S18.conquest[0].phase = 'claim';
    delete suppressBad.rootMemories.E18S18.creeps.dg0;
    const suppressBadFail = [];
    effects.assertEffects(suppressBad, ROOMS, (condition, message) => { if (!condition) suppressBadFail.push(message); });
    assert(suppressBadFail.some((message) => message.includes('conquest.suppressDeny')), 'suppress 却走 claim 且无 downgrader 时判未生效');
    // 没有 courier / storage 没动：判未生效
    const badReport = JSON.parse(JSON.stringify(okReport));
    delete badReport.rootMemories.E15S15.creeps.c;
    const bad = [];
    effects.assertEffects(badReport, ROOMS, (condition, message) => { if (!condition) bad.push(message); });
    assert(bad.some((message) => message.includes('aid.courier')), '缺 courier 时 aid.courier 断言失败');
    // 旧代码（补给地板 = upgrading.reserve）的形态：storage 从没在取用底线之上被补过，探针里就没有 ctrlFeedBand
    const noBand = JSON.parse(JSON.stringify(okReport));
    delete noBand.probeMemories.W60N60._validationRooms.W60N60.ctrlFeedBand;
    const noBandFailures = [];
    effects.assertEffects(noBand, ROOMS, (condition, message) => { if (!condition) noBandFailures.push(message); });
    assert(noBandFailures.some((message) => message.includes('upgrade.storageFeedBand')), '没有 ctrlFeedBand 时 upgrade.storageFeedBand 断言失败');
    // 旧代码（塔有能量就不为维修孵 builder）：从没在"危急 + 塔武装"时算过 builder work，探针里就没有 criticalRepair
    const noCrit = JSON.parse(JSON.stringify(okReport));
    delete noCrit.probeMemories.W60N60._validationRooms.W60N60.criticalRepair;
    const noCritFailures = [];
    effects.assertEffects(noCrit, ROOMS, (condition, message) => { if (!condition) noCritFailures.push(message); });
    assert(noCritFailures.some((message) => message.includes('build.criticalRepairBuilder')), '没有 criticalRepair 时 build.criticalRepairBuilder 断言失败');
    // 只在有工地时命中过：旧代码同样返回 true，不算观察到新行为
    const sitesOnly = JSON.parse(JSON.stringify(okReport));
    sitesOnly.probeMemories.W60N60._validationRooms.W60N60.criticalRepair.noSites = false;
    const sitesOnlyFailures = [];
    effects.assertEffects(sitesOnly, ROOMS, (condition, message) => { if (!condition) sitesOnlyFailures.push(message); });
    assert(sitesOnlyFailures.some((message) => message.includes('build.criticalRepairBuilder')), 'noSites 为假时 build.criticalRepairBuilder 断言失败');
    // 旧排序（只看比值）：比值更低的 rampart 拿走全部产出，危急容器从 12000 一路衰减
    const ramWins = JSON.parse(JSON.stringify(okReport));
    ramWins.probeMemories.W60N60._validationRooms.W60N60.repairSplit = { crit: 7200, ram: 9000 };
    const ramWinsFailures = [];
    effects.assertEffects(ramWins, ROOMS, (condition, message) => { if (!condition) ramWinsFailures.push(message); });
    assert(ramWinsFailures.some((message) => message.includes('repair.criticalBeatsRampart')), '危急容器继续衰减时 repair.criticalBeatsRampart 断言失败');
    // 容量门槛没放行（旧值 800 下 needsAid 对 800 容量的弱房直接 return false）：一只援建 creep 都没有 → aid.untilCapacity1300 判未生效
    const noAid = JSON.parse(JSON.stringify(okReport));
    delete noAid.rootMemories.E15S15.creeps.h;
    delete noAid.rootMemories.E15S15.creeps.c;
    const noAidFailures = [];
    effects.assertEffects(noAid, ROOMS, (condition, message) => { if (!condition) noAidFailures.push(message); });
    assert(noAidFailures.some((message) => message.includes('aid.untilCapacity1300')), '弱房一只援建 creep 都没有时 aid.untilCapacity1300 判未生效');
    // 只有 courier（没有援建 hauler）仍算生效：容量门槛放行了，孵哪个角色是母房的排队结果，不是这条改动管的事
    const courierOnly = JSON.parse(JSON.stringify(okReport));
    delete courierOnly.rootMemories.E15S15.creeps.h;
    const courierOnlyFailures = [];
    effects.assertEffects(courierOnly, ROOMS, (condition, message) => { if (!condition) courierOnlyFailures.push(message); });
    assert(!courierOnlyFailures.some((message) => message.includes('aid.untilCapacity1300')), '只有 courier 时 aid.untilCapacity1300 仍算生效');
    const lateReserve = JSON.parse(JSON.stringify(okReport));
    lateReserve.earlyReserve = [{ offset: 60, creeps: [{ name: 'replacement' }] }];
    const lateFailures = [];
    effects.assertEffects(lateReserve, ROOMS, (condition, message) => { if (!condition) lateFailures.push(message); });
    assert(lateFailures.some((message) => message.includes('remote.reservationLeadGrace')), 'late replacement cannot satisfy early handoff assertion');
    const remoteCandidate = JSON.parse(JSON.stringify(okReport));
    remoteCandidate.reserveDeadline.event.candidates[0].role = 'remoteHauler';
    const remoteCandidateFailures = [];
    effects.assertEffects(remoteCandidate, ROOMS, (ok, message) => { if (!ok) remoteCandidateFailures.push(message); });
    assert(!remoteCandidateFailures.some((message) => message.includes('reserverNonPreemptiveHandoff')),
        'a real equal-duration remote hauling candidate also exercises the non-preemptible deadline');
    for (const wrong of [{ parts: 25 }, { cost: 1250 }, { role: 'defender' }]) {
        const invalidCandidate = JSON.parse(JSON.stringify(remoteCandidate));
        Object.assign(invalidCandidate.reserveDeadline.event.candidates[0], wrong);
        const failures = [];
        effects.assertEffects(invalidCandidate, ROOMS, (ok, message) => { if (!ok) failures.push(message); });
        assert(failures.some((message) => message.includes('reserverNonPreemptiveHandoff')),
            'wrong hauling candidate body, cost, or role must still fail');
    }
    const overwrittenHandoff = JSON.parse(JSON.stringify(okReport));
    overwrittenHandoff.rootMemories.W61N55.rooms.W61N55.reserveHandoff.name = 'second-generation';
    const overwrittenFailures = [];
    effects.assertEffects(overwrittenHandoff, ROOMS, (ok, message) => { if (!ok) overwrittenFailures.push(message); });
    assert(!overwrittenFailures.some((message) => message.includes('reserverNonPreemptiveHandoff')),
        'a later handoff event must not erase the first verified arrival');
    const reusedName = JSON.parse(JSON.stringify(okReport));
    reusedName.reserveDeadline.samples[0].creeps[1].id = 'different-generation-id';
    const reusedNameFailures = [];
    effects.assertEffects(reusedName, ROOMS, (ok, message) => { if (!ok) reusedNameFailures.push(message); });
    assert(reusedNameFailures.some((message) => message.includes('reserverNonPreemptiveHandoff')),
        'a same-name different-ID creep cannot satisfy the frozen handoff');
    const lateDeadlineArrival = JSON.parse(JSON.stringify(okReport));
    lateDeadlineArrival.reserveDeadline.samples[0].t = 251;
    const deadlineArrivalFailures = [];
    effects.assertEffects(lateDeadlineArrival, ROOMS, (ok, message) => { if (!ok) deadlineArrivalFailures.push(message); });
    assert(deadlineArrivalFailures.some((message) => message.includes('reserverNonPreemptiveHandoff')), 'late arrival fails even with a successful decision event');
    const stale = JSON.parse(JSON.stringify(okReport));
    stale.probeMemories.E15S15._validationRooms.E15S15.storage = 80000;
    const staleFailures = [];
    effects.assertEffects(stale, ROOMS, (condition, message) => { if (!condition) staleFailures.push(message); });
    assert(staleFailures.some((message) => message.includes('没取走能量')), 'storage 没减少时判未生效');
    // 并行开荒：少一个房的 pioneer 就判未生效；无 spawn 的房收到援建 creep 判未生效
    const oneBootstrap = JSON.parse(JSON.stringify(okReport));
    delete oneBootstrap.rootMemories.E15S15.creeps.p2;
    const bootstrapFailures = [];
    effects.assertEffects(oneBootstrap, ROOMS, (condition, message) => { if (!condition) bootstrapFailures.push(message); });
    assert(bootstrapFailures.some((message) => message.includes('expansion.concurrentBootstraps') && message.includes('E15S17')), '第二个新房没 pioneer 时判未生效');
    const aidedOrphan = JSON.parse(JSON.stringify(okReport));
    aidedOrphan.rootMemories.E15S15.creeps.x = { role: 'harvester', home: 'E14S15', aid: 'E15S15' };
    const orphanFailures = [];
    effects.assertEffects(aidedOrphan, ROOMS, (condition, message) => { if (!condition) orphanFailures.push(message); });
    assert(orphanFailures.some((message) => message.includes('aid.requiresSpawn')), '无 spawn 的房收到援建 creep 时判未生效');
    // storage 富余但升级者只有 2 只：判未生效
    const fewUpgraders = JSON.parse(JSON.stringify(okReport));
    delete fewUpgraders.rootMemories.E15S15.creeps.u3;
    const richFailures = [];
    effects.assertEffects(fewUpgraders, ROOMS, (condition, message) => { if (!condition) richFailures.push(message); });
    assert(richFailures.some((message) => message.includes('upgrade.storageRich')), 'storage 富余而升级者不到 3 只时判未生效');
    // 道路进度超过 spawn：判未生效
    const roadsFirst = JSON.parse(JSON.stringify(okReport));
    roadsFirst.probeMemories.E14S15._validationRooms.E14S15.sites = [['spawn', 100, 15000], ['road', 300, 300], ['road', 300, 300]];
    const roadFailures = [];
    effects.assertEffects(roadsFirst, ROOMS, (condition, message) => { if (!condition) roadFailures.push(message); });
    assert(roadFailures.some((message) => message.includes('build.spawnFirst')), '道路先于 spawn 时判未生效');
    // 残废 creep：没进 crippledLog、或还活在 Memory.creeps 里：判未生效
    const noCripple = JSON.parse(JSON.stringify(okReport));
    noCripple.rootMemories.W50N50.rooms.W50N50.crippledLog = [];
    const crippleFailures = [];
    effects.assertEffects(noCripple, ROOMS, (condition, message) => { if (!condition) crippleFailures.push(message); });
    assert(crippleFailures.some((message) => message.includes('retire.crippled') && message.includes('crippledLog')), '残废 creep 没记进 crippledLog 时判未生效');
    const stillAlive = JSON.parse(JSON.stringify(okReport));
    stillAlive.rootMemories.W50N50.creeps['remote-crippled-hauler'] = { role: 'hauler', home: 'W50N50', crippled: 70 };
    const aliveFailures = [];
    effects.assertEffects(stillAlive, ROOMS, (condition, message) => { if (!condition) aliveFailures.push(message); });
    assert(aliveFailures.some((message) => message.includes('retire.crippled') && message.includes('仍在')), '残废 creep 没被回收时判未生效');
    // storage 富余修正：storage 取货压过容器、或没标 rich、或没进入富余状态：判未生效
    const storageFirst = JSON.parse(JSON.stringify(okReport));
    storageFirst.probeMemories.W40N40._validationRooms.W40N40.collect[2] = ['storage', 8, 39000, true];
    const storageFailures = [];
    effects.assertEffects(storageFirst, ROOMS, (condition, message) => { if (!condition) storageFailures.push(message); });
    assert(storageFailures.some((message) => message.includes('storage.collectFallback') && message.includes('没有低于容器')), 'storage 取货权重压过容器时判未生效');
    // 控制器容器已喂到 80% 以上：富余取货不发布也算通过
    const fedContainer = JSON.parse(JSON.stringify(okReport));
    fedContainer.probeMemories.W40N40._validationRooms.W40N40.ctrl = 1834;
    fedContainer.probeMemories.W40N40._validationRooms.W40N40.collect[2] = ['storage', 2, 26850, false];
    const fedFailures = [];
    effects.assertEffects(fedContainer, ROOMS, (condition, message) => { if (!condition) fedFailures.push(message); });
    assert(!fedFailures.some((message) => message.includes('storage.collectFallback')), '容器 ≥ 80% 时 storage 取货不 rich 也不判失败 ' + JSON.stringify(fedFailures));
    const notRich = JSON.parse(JSON.stringify(okReport));
    notRich.rootMemories.W40N40.rooms.W40N40.storageRich = { on: false, at: 5 };
    const richFailures2 = [];
    effects.assertEffects(notRich, ROOMS, (condition, message) => { if (!condition) richFailures2.push(message); });
    assert(richFailures2.some((message) => message.includes('storage.collectFallback') && message.includes('富余状态')), '没进入富余状态时判未生效');
    // 不可达退避：计数没清零、或字段被丢掉：判未生效
    const staleCount = JSON.parse(JSON.stringify(okReport));
    staleCount.rootMemories.W50N50.rooms.W50N50.remotes.W50N49.unreachableCount = 1;
    const countFailures = [];
    effects.assertEffects(staleCount, ROOMS, (condition, message) => { if (!condition) countFailures.push(message); });
    assert(countFailures.some((message) => message.includes('remote.unreachableBackoff') && message.includes('清零')), 'unreachableCount 没清零时判未生效');
    const droppedField = JSON.parse(JSON.stringify(okReport));
    delete droppedField.rootMemories.W50N50.rooms.W50N50.remotes.W50N49.unreachableAt;
    const fieldFailures = [];
    effects.assertEffects(droppedField, ROOMS, (condition, message) => { if (!condition) fieldFailures.push(message); });
    assert(fieldFailures.some((message) => message.includes('remote.unreachableBackoff') && message.includes('unreachableAt')), '记录丢了 unreachableAt 时判未生效');
    // feeder：没孵出、或 storage 没搬动：判未生效
    const noFeeder = JSON.parse(JSON.stringify(okReport));
    delete noFeeder.rootMemories.W40N40.creeps.f;
    const feederFailures = [];
    effects.assertEffects(noFeeder, ROOMS, (condition, message) => { if (!condition) feederFailures.push(message); });
    assert(feederFailures.some((message) => message.includes('feeder.storageToController') && message.includes('没有孵出')), '没孵出 feeder 时判未生效');
    const idleFeeder = JSON.parse(JSON.stringify(okReport));
    idleFeeder.probeMemories.W40N40._validationRooms.W40N40.storage = 39900;
    const idleFailures = [];
    effects.assertEffects(idleFeeder, ROOMS, (condition, message) => { if (!condition) idleFailures.push(message); });
    assert(idleFailures.some((message) => message.includes('feeder.storageToController') && message.includes('应把容器喂到')), 'storage 没搬动且容器没喂满时判未生效');
    const fedByFeeder = JSON.parse(JSON.stringify(idleFeeder));
    fedByFeeder.probeMemories.W40N40._validationRooms.W40N40.ctrl = 1798;
    const fedFeederFailures = [];
    effects.assertEffects(fedByFeeder, ROOMS, (condition, message) => { if (!condition) fedFeederFailures.push(message); });
    assert(!fedFeederFailures.some((message) => message.includes('feeder.storageToController')), 'storage 没降但控制器容器 ≥ 80%：feeder 判生效 ' + JSON.stringify(fedFeederFailures));
    // 塔的维修目标排序：源容器没高过播下的 40000：判未生效
    const unrepairedSrc = JSON.parse(JSON.stringify(okReport));
    unrepairedSrc.probeMemories.W40N40._validationRooms.W40N40.srcContainerHits = [38000, 36000];
    const unrepairedSrcFailures = [];
    effects.assertEffects(unrepairedSrc, ROOMS, (condition, message) => { if (!condition) unrepairedSrcFailures.push(message); });
    assert(unrepairedSrcFailures.some((message) => message.includes('tower.maintenanceBudget')), '源容器没被修时判未生效');
    // 塔的维修预算：塔仍卡在储备线上（≤ 500）：判未生效
    const stuckTower = JSON.parse(JSON.stringify(okReport));
    stuckTower.probeMemories.W40N40._validationRooms.W40N40.towers = [500];
    stuckTower.towerMaintenance = [];
    const stuckTowerFailures = [];
    effects.assertEffects(stuckTower, ROOMS, (condition, message) => { if (!condition) stuckTowerFailures.push(message); });
    assert(stuckTowerFailures.some((message) => message.includes('tower.maintenanceBudget')), '塔卡在储备线上时判未生效');
    // 升级者维修站位容器：血量没高过播下的 125000、或探针没记：判未生效
    const decayedContainer = JSON.parse(JSON.stringify(okReport));
    decayedContainer.probeMemories.W40N40._validationRooms.W40N40.ctrlContainerHits = 117000;
    const decayedContainerFailures = [];
    effects.assertEffects(decayedContainer, ROOMS, (condition, message) => { if (!condition) decayedContainerFailures.push(message); });
    assert(decayedContainerFailures.some((message) => message.includes('upgrade.repairStation')), '容器只衰减不回升时判未生效');
    const noHits = JSON.parse(JSON.stringify(okReport));
    delete noHits.probeMemories.W40N40._validationRooms.W40N40.ctrlContainerHits;
    const noHitsFailures = [];
    effects.assertEffects(noHits, ROOMS, (condition, message) => { if (!condition) noHitsFailures.push(message); });
    assert(noHitsFailures.some((message) => message.includes('upgrade.repairStation') && message.includes('血量')), '探针没记血量时判未生效');
    // 己方房连续阵亡计数：defenseLog 没有 streak、或清场后 streak 没归零：判未生效
    const noStreak = JSON.parse(JSON.stringify(okReport));
    delete noStreak.rootMemories.E13S13.rooms.E13S13.defenseLog.streak;
    const streakFailures = [];
    effects.assertEffects(noStreak, ROOMS, (condition, message) => { if (!condition) streakFailures.push(message); });
    assert(streakFailures.some((message) => message.includes('defense.ownLossStreak')), 'defenseLog 没有 streak 时判未生效');
    const staleStreakReport = JSON.parse(JSON.stringify(okReport));
    staleStreakReport.rootMemories.E13S13.rooms.E13S13.defenseLog.streak = 2;
    const staleStreakFailures = [];
    effects.assertEffects(staleStreakReport, ROOMS, (condition, message) => { if (!condition) staleStreakFailures.push(message); });
    assert(staleStreakFailures.some((message) => message.includes('defense.ownLossStreak')), '清场后 streak 仍 > 0 时判未生效');
    // link 房 hauler 底线：目标仍是 RCL 底线 3、或 haulModel 没记 linkDrain：判未生效
    const oldFloor = JSON.parse(JSON.stringify(okReport));
    oldFloor.probeMemories.E20S20._validationRooms.E20S20.targets.hauler = 3;
    oldFloor.probeMemories.E20S20._validationRooms.E20S20.haulModel.floor = 3;
    delete oldFloor.probeMemories.E20S20._validationRooms.E20S20.haulModel.linkDrain;
    const floorFailures = [];
    effects.assertEffects(oldFloor, ROOMS, (condition, message) => { if (!condition) floorFailures.push(message); });
    assert(floorFailures.some((message) => message.includes('hauling.linkFloor')), 'link 房 hauler 目标仍是 3 时判未生效');
    // 底线 2 + 1 只临时编制（haulModel.temp）= 目标 3：仍算生效（底线本身没回到 3）
    const tempFloor = JSON.parse(JSON.stringify(okReport));
    tempFloor.probeMemories.E20S20._validationRooms.E20S20.targets.hauler = 3;
    tempFloor.probeMemories.E20S20._validationRooms.E20S20.haulModel.temp = 'refill';
    assert(effects.EFFECTS.find((effect) => effect.id === 'hauling.linkFloor').check(tempFloor, ROOMS).ok, '底线 2 加 1 只临时编制的目标 3 不算回退');
    const noOperator = JSON.parse(JSON.stringify(okReport));
    delete noOperator.rootMemories.E20S20.creeps.op;
    const noOperatorFailures = [];
    effects.assertEffects(noOperator, ROOMS, (condition, message) => { if (!condition) noOperatorFailures.push(message); });
    assert(noOperatorFailures.some((message) => message.includes('links.operatorToStorage') && message.includes('operator')), '没孵出 operator 时判未生效');
    const idleOperator = JSON.parse(JSON.stringify(okReport));
    idleOperator.rootMemories.E20S20.rooms.E20S20.operator.transferred = 0;
    idleOperator.probeMemories.E20S20._validationRooms.E20S20.storeLink = 700;
    const idleOperatorFailures = [];
    effects.assertEffects(idleOperator, ROOMS, (condition, message) => { if (!condition) idleOperatorFailures.push(message); });
    assert(idleOperatorFailures.some((message) => message.includes('links.operatorToStorage') && message.includes('没把 store link')), 'operator 没倒仓时判未生效');
    // hauler 投递停靠：没有 haulModel、或停靠项为 0：判未生效
    const noModel = JSON.parse(JSON.stringify(okReport));
    delete noModel.probeMemories.W50N50._validationRooms.W50N50.haulModel;
    const modelFailures = [];
    effects.assertEffects(noModel, ROOMS, (condition, message) => { if (!condition) modelFailures.push(message); });
    assert(modelFailures.some((message) => message.includes('hauling.deliveryStops') && message.includes('haulModel')), '没有 haulModel 时判未生效');
    const zeroStops = JSON.parse(JSON.stringify(okReport));
    zeroStops.probeMemories.W50N50._validationRooms.W50N50.haulModel.deliveryTicks = 0;
    zeroStops.probeMemories.W50N50._validationRooms.W50N50.haulModel.maxDeliveryTicks = 0;
    // 期末停靠项为 0 但峰值 > 0（spawn 满仓、收入 EMA 衰减）：仍算生效
    const decayed = JSON.parse(JSON.stringify(okReport));
    decayed.probeMemories.W50N50._validationRooms.W50N50.haulModel.deliveryTicks = 0;
    decayed.probeMemories.W50N50._validationRooms.W50N50.haulModel.spawnShare = 0;
    const decayedFailures = [];
    effects.assertEffects(decayed, ROOMS, (condition, message) => { if (!condition) decayedFailures.push(message); });
    assert(!decayedFailures.some((message) => message.includes('hauling.deliveryStops')), '停靠项峰值 > 0 时不因期末为 0 判未生效');
    const stopFailures = [];
    effects.assertEffects(zeroStops, ROOMS, (condition, message) => { if (!condition) stopFailures.push(message); });
    assert(stopFailures.some((message) => message.includes('hauling.deliveryStops') && message.includes('没有生效')), '停靠项为 0 时判未生效');
    // 紧急塔第 1 层：没记 towerFirstAt、或塔仍低于储备：判未生效
    const noTowerFirst = JSON.parse(JSON.stringify(okReport));
    delete noTowerFirst.rootMemories.W40N40.rooms.W40N40.towerFirstAt;
    const towerFailures = [];
    effects.assertEffects(noTowerFirst, ROOMS, (condition, message) => { if (!condition) towerFailures.push(message); });
    assert(towerFailures.some((message) => message.includes('tower.refillBeforeSpawn') && message.includes('towerFirstAt')), '没记 towerFirstAt 时判未生效');
    const lowTower = JSON.parse(JSON.stringify(okReport));
    lowTower.probeMemories.W40N40._validationRooms.W40N40.towers = [120];
    const lowFailures = [];
    effects.assertEffects(lowTower, ROOMS, (condition, message) => { if (!condition) lowFailures.push(message); });
    assert(lowFailures.some((message) => message.includes('tower.refillBeforeSpawn') && message.includes('低于维修储备附近')), '塔仍低于储备时判未生效');
    // link 工地没放出也没建成：判未生效
    const noLinkSite = JSON.parse(JSON.stringify(okReport));
    noLinkSite.probeMemories.E30S30._validationRooms.E30S30 = { name: 'E30S30', links: 0, sites: [['extension', 500, 3000], ['road', 0, 300]] };
    const linkFailures = [];
    effects.assertEffects(noLinkSite, ROOMS, (condition, message) => { if (!condition) linkFailures.push(message); });
    assert(linkFailures.some((message) => message.includes('layout.linkSitesFirst') && message.includes('既没有')), 'link 工地没放出时判未生效');
    // safe mode 由大脑决定：没开、或开了但依据不是大脑：判未生效
    const noShield = JSON.parse(JSON.stringify(okReport));
    noShield.probeMemories.E11S11._validationRooms.E11S11.safeMode = 0;
    const shieldFailures = [];
    effects.assertEffects(noShield, ROOMS, (condition, message) => { if (!condition) shieldFailures.push(message); });
    assert(shieldFailures.some((message) => message.includes('safeMode.brainDecides') && message.includes('没有开')), '没开 safe mode 时判未生效');
    const localShield = JSON.parse(JSON.stringify(okReport));
    localShield.rootMemories.E11S11.rooms.E11S11.defenseLog.safeMode.by = 'fallback:core-hurt';
    const localFailures = [];
    effects.assertEffects(localShield, ROOMS, (condition, message) => { if (!condition) localFailures.push(message); });
    assert(localFailures.some((message) => message.includes('safeMode.brainDecides') && message.includes('不是大脑')), '开盾依据不是大脑时判未生效');
    // 探针按房：老格式 _validation.room 房名对得上也认
    const legacy = { probeMemories: { E15S15: { _validation: { room: { name: 'E15S15', storage: 1 } } } } };
    assert.equal(effects.roomProbe(legacy, 'E15S15').storage, 1);
    assert.equal(effects.roomProbe(legacy, 'E15S16'), null);
    assert(effects.EFFECTS.every((effect) => effect.id && effect.since && effect.change && typeof effect.check === 'function'), '每条生效断言都带 id/日期/说明/check');
}

function testBaselineFlagsHardRegressions() {
    const baseline = require('../scripts/private_server/baseline');
    const report = {
        rootMemories: { A: { creeps: { x: { home: 'A' }, y: { home: 'A' } }, errors: [] }, B: { creeps: { z: { home: 'B' } }, errors: [] } },
        probeMemories: { A: { _validationRooms: { A: { name: 'A', rcl: 4, energy: 300 } } }, B: { _validation: { room: { name: 'B', rcl: 3, energy: 50 } } } },
    };
    const current = baseline.metrics(report);
    assert.equal(current.rooms.A.creepsAll, 2);
    assert.equal(current.rooms.B.rcl, 3);
    assert.deepEqual(baseline.compare(null, current), { failures: [], warnings: [] }, '没有基线时不比较');
    const worse = JSON.parse(JSON.stringify(current));
    worse.rooms.A.creepsAll = 0;
    worse.rooms.B.errors = 2;
    const result = baseline.compare(current, worse);
    assert.equal(result.failures.length, 2, 'creep 归零与新错误都是硬回归: ' + JSON.stringify(result));
    const jitter = JSON.parse(JSON.stringify(current));
    jitter.rooms.A.creepsAll = 0.4 * 2;
    assert.equal(baseline.compare(current, jitter).failures.length, 0);
    assert.equal(baseline.compare(current, jitter).warnings.length, 1, 'creep 掉过半只警告');
    // RCL 回退：播种 ≥3 的房算失败，起步房（基线 RCL ≤2）只警告
    const rclDrop = JSON.parse(JSON.stringify(current));
    rclDrop.rooms.A.rcl = 3;
    assert.equal(baseline.compare(current, rclDrop).failures.length, 1, 'RCL4 → 3 是硬回归');
    const bootstrapDrop = JSON.parse(JSON.stringify(current));
    bootstrapDrop.rooms.B.rcl = 2;
    const bootstrapBase = JSON.parse(JSON.stringify(current)); bootstrapBase.rooms.B.rcl = 2;
    bootstrapDrop.rooms.B.rcl = 1;
    const bootstrapResult = baseline.compare(bootstrapBase, bootstrapDrop);
    assert.equal(bootstrapResult.failures.length, 0, '起步房 RCL2 → 1 不算失败');
    assert.equal(bootstrapResult.warnings.length, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
    try {
        const file = path.join(dir, 'baseline.json');
        baseline.save(current, file);
        assert.equal(baseline.load(file).rooms.A.creepsAll, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function affordableReport() {
    return {at:5,travel:66,initialTtl:92,oldDiesAt:97,energy:1100,capacity:1800,initialHaulers:3,incumbentId:'old-id',
        successorId:'new-id',successorClaim:1,successorParts:2,controller:{x:20,y:20},
        samples:[{t:80,creeps:[{id:'old-id'},{id:'new-id',claim:1,spawning:false,room:'W62N53',x:20,y:21}]}]};
}
function testAffordableDeadlineEvidence() {
    const effect = require('../scripts/private_server/effects').EFFECTS.find(e => e.id === 'remote.affordableReserverDeadline');
    const check = r => effect.check({reserveBudget:r},{reserveBudgetTarget:'W62N53'}).ok;
    assert(check(affordableReport()), 'real affordable successor arrival should pass');
    for (const mutate of [
        r => {r.successorClaim=2;},
        r => {r.successorParts=4;},
        r => {r.samples[0].t=r.oldDiesAt;},
        r => {r.samples[0].creeps.shift();},
        r => {r.samples[0].creeps[1].id='same-name-new-generation';},
        r => {r.samples[0].creeps[1].x=40;},
        r => {r.energy=1300;},
        r => {r.initialHaulers=1;},
        r => {delete r.initialHaulers;},
    ]) { const r=affordableReport(); mutate(r); assert(!check(r), 'invalid identity/body/deadline/energy must not pass'); }
}

function upgraderRouteReport() {
    return {at:1,seedTick:1,oldDiesAt:601,incumbentId:'old',successorId:'new',spawn:{x:27,y:18},
        plan:{anchor:{x:27,y:36},roads:{}},leg:{complete:true,ticks:446,spawns:1,goals:4},
        body:Array(21).fill('work').concat(['carry','carry','move']),
        samples:[{t:500,creeps:[{id:'old'},{id:'new',spawning:true}]},{t:550,creeps:[{id:'old'},{id:'new',room:'W34S7',x:32,y:40,spawning:false}]}],
        proof:{spawn:{key:'core:upgrader:0',cost:2250,t:499},events:{old:{observedAt:2,event:{event:9,objectId:'old',data:{amount:21}}},new:{observedAt:551,event:{event:9,objectId:'new',data:{amount:21}}}}}};
}

function testBootstrapInvestmentMovement() {
    const {bootstrapRoadMove}=require('../scripts/private_server/run_validation');
    const road={_id:'r',type:'constructionSite',structureType:'road',x:35,y:19,progress:120,user:'u'};
    const objects=[road,{_id:'s',type:'source',x:40,y:30},{type:'spawn',x:35,y:21}];
    const plan={anchor:{x:35,y:18},sourceIds:['s'],roads:{all:'35.19;35.20'}};
    const expectedSpawn={x:35,y:21};
    const result=bootstrapRoadMove(objects,'0'.repeat(2500),plan,expectedSpawn);
    assert.deepStrictEqual(result.after,{...road,x:10,y:2});assert.deepStrictEqual(objects[0],road);
    assert.throws(()=>bootstrapRoadMove(objects,'1'.repeat(2500),plan,expectedSpawn),/empty plain/);
    assert.throws(()=>bootstrapRoadMove(objects,'0'.repeat(2500),{...plan,roads:{all:'10.2'}},expectedSpawn),/outside plan/);
    assert.throws(()=>bootstrapRoadMove(objects.concat([{type:'container',x:10,y:2}]),'0'.repeat(2500),plan,expectedSpawn),/empty plain/);
    assert.throws(()=>bootstrapRoadMove(objects,'0'.repeat(2500),plan,plan.anchor),/does not match/);
    assert.throws(()=>bootstrapRoadMove(objects,'0'.repeat(2500),plan),/does not match/);
}

function testUpgraderActualRouteFixtureAndObserver() {
    const fixture=require('./fixtures/upgrader_legacy_spawn_W34S7.json');
    assert.equal(fixture.terrain.length,2500);
    assert.equal(fixture.incumbentTtl,600);
    assert.equal(fixture.structures.filter(o=>o.type==='road').length,66);
    assert(fixture.structures.some(o=>o.type==='spawn'&&o.x===27&&o.y===18));
    assert.equal(fixture.plan.anchor.y,36);
    assert.equal(fixture.plan.roads.ctrl,undefined);
    const observer=require('../scripts/private_server/fixtures').upgraderActualRouteObserver('W34S7');
    const vm=require('vm');let calls=0;
    const context={module:{exports:{loop:()=>{calls++;}}},Memory:{rooms:{W34S7:{upgraderLeg:{complete:true,ticks:446}}}},
        Game:{time:550,rooms:{W34S7:{name:'W34S7',getEventLog:()=>[{event:9,objectId:'new',data:{amount:21}}]}},
            getObjectById:()=>({memory:{role:'upgrader'}})},EVENT_UPGRADE_CONTROLLER:9};
    vm.runInNewContext(observer,context);context.module.exports.loop();
    assert.equal(calls,1);assert.equal(context.Memory._upgraderRouteProof.events.new.event.data.amount,21);
    context.Game.time=551;context.module.exports.loop();
    assert.equal(context.Memory._upgraderRouteProof.events.new.observedAt,550,'first actual event remains frozen');
}

async function testUpgraderRoutePrepareUsesSeedTick() {
    const {prepareUpgraderRoute}=require('../scripts/private_server/run_validation');
    // 假 CLI：按表达式内容分派（getUserId / 房间对象 / Memory）
    const fakeCli=(seedTick,ageTime)=>({evaluateJson:async(expr)=>{
        if(expr.includes('users.findOne'))return {id:'u1',username:'ValidationUpgraderActualRoute'};
        if(expr.includes('MEMORY+'))return seedTick==null?{}:{_fixtureSeedAt:seedTick};
        return {at:seedTick||1,objects:[{name:'route-incumbent',_id:'old',ageTime},{type:'spawn',user:'u1',_id:'s',x:27,y:18},{type:'controller',x:31,y:41}]};
    }});
    const late=await prepareUpgraderRoute(fakeCli(2,602));
    assert.equal(late.oldDiesAt,602);assert.equal(late.seedTick,2);
    assert.equal((await prepareUpgraderRoute(fakeCli(1,601))).oldDiesAt,601);
    // 夹具寿命被改坏（或种子 tick 丢了）仍然要在这里拦下
    await assert.rejects(()=>prepareUpgraderRoute(fakeCli(2,601)),/origin\/deadline mismatch/);
    await assert.rejects(()=>prepareUpgraderRoute(fakeCli(null,601)),/origin\/deadline mismatch/);
}

async function testWrapperReinstallAndCronGuard() {
    const vm=require('vm');
    const {wrapperInstallExpression}=require('../scripts/private_server/run_validation');
    // 假 storage：两份代码（两个分支），模拟 backend 重启后从 project-bot 重新加载（包装被冲掉）
    const codes=[{_id:'a',user:'u1',modules:{main:'MAIN'}},{_id:'b',user:'u1',modules:{main:'MAIN'}}];
    const storage={db:{'users.code':{
        find:async q=>codes.filter(c=>c.user===q.user),
        update:async(q,u)=>{const c=codes.find(x=>x._id===q._id);Object.assign(c,u.$set);},
    }}};
    const wrappers=[{name:'w',userId:'u1',module:'main',marker:'const markX',code:';const markX=1;'}];
    const expr=wrapperInstallExpression(wrappers);
    const run=async()=>JSON.parse(JSON.stringify(await vm.runInNewContext(expr,{storage})));
    let result=await run();
    assert.deepStrictEqual(result,[{name:'w',appended:2,codes:2}]);
    assert(codes.every(c=>c.modules.main==='MAIN;const markX=1;'));
    result=await run();
    assert.deepStrictEqual(result,[{name:'w',appended:0,codes:2}],'already installed wrapper is not appended twice');
    codes[1].modules={main:'MAIN'};
    result=await run();
    assert.equal(result[0].appended,1,'a reload that wiped the wrapper is detected and repaired');
    // 私服 backend 的 cronjob rejection 不能成为未处理 rejection（Node 22 下会让 backend 退出、重载 bot 代码）
    const {guardCronjobs}=require('../scripts/private_server/validation_mod');
    const cron={roomsForceUpdate:[20,async()=>{throw 'fun is not a function';}],fine:[60,()=>7]};
    const originalError=console.error;const logged=[];console.error=m=>logged.push(String(m));
    try {
        guardCronjobs(cron);guardCronjobs(cron);
        assert.equal(await cron.roomsForceUpdate[1]({}),undefined);
        assert.equal(await cron.fine[1]({}),7);
    } finally { console.error=originalError; }
    assert.equal(logged.filter(m=>m.includes('roomsForceUpdate')).length,1,'guarded once even when the mod loads twice');
}

function testValidationLatchObservers() {
    const vm=require('vm');
    const fixtures=require('../scripts/private_server/fixtures');
    // storage → 升级的闩锁：升级者直接取、hauler 从 storage 取货送 ctrl link、源容器的货不算、送回 storage 的扣掉、store link → ctrl link
    const creeps={up:{memory:{role:'upgrader'}},h1:{memory:{role:'hauler'}},h2:{memory:{role:'hauler'}}};
    let events=[];
    const room={name:'E15S15',storage:{id:'st'},controller:{},getEventLog:()=>events,lookForAt:()=>[{structureType:'container',id:'cc'}]};
    const ctx={module:{exports:{loop:()=>{}}},Memory:{rooms:{E15S15:{plan:{containers:{ctrl:{x:1,y:1}}}}}},global:{},
        require:()=>({getLink:()=>({id:'cl'}),storeLinkReady:()=>({id:'sl'})}),
        Game:{time:100,rooms:{E15S15:room},getObjectById:id=>creeps[id]},
        EVENT_TRANSFER:4,RESOURCE_ENERGY:'energy',LOOK_STRUCTURES:'structure',STRUCTURE_CONTAINER:'container'};
    vm.runInNewContext(fixtures.storageUpgradeFeedObserver('E15S15'),ctx);
    const T=(objectId,targetId,amount)=>({event:4,objectId,data:{targetId,resourceType:'energy',amount}});
    events=[T('st','up',100),T('st','h1',500),T('src','h2',400)];ctx.module.exports.loop();
    events=[T('h1','cl',300),T('h2','cc',400),T('h1','st',150),T('sl','cl',200)];ctx.Game.time=101;ctx.module.exports.loop();
    events=[T('h1','cc',300)];ctx.Game.time=102;ctx.module.exports.loop();
    // 从 storage 取的货先送去 spawn/extension：再送控制器的就不能算 storage 的
    events=[T('st','h2',200),T('h2','ext',200),T('h2','cc',100)];ctx.Game.time=103;ctx.module.exports.loop();
    const feed=JSON.parse(JSON.stringify(ctx.Memory._storageUpgradeFeed));
    assert.deepStrictEqual({direct:feed.direct,hauled:feed.hauled,link:feed.link,withdrawn:feed.withdrawn,total:feed.total},
        {direct:100,hauled:350,link:200,withdrawn:700,total:650},'only storage-sourced cargo counts: '+JSON.stringify(feed));
    assert.equal(feed.firstAt,100);assert.equal(ctx.Memory._storageUpgradeFeedError,undefined);
    // 维修池闩锁：第一次出现道路/容器就锁住，之后不再算
    let calls=0;
    const tasks=[{kind:'repair',target:{structureType:'rampart',pos:{x:1,y:1}},backlog:9000}];
    const rctx={module:{exports:{loop:()=>{}}},Memory:{},Game:{time:5,rooms:{W61N60:{}}},STRUCTURE_ROAD:'road',STRUCTURE_CONTAINER:'container',
        require:()=>({roomTasks:()=>{calls++;return tasks;}})};
    vm.runInNewContext(fixtures.repairPoolNeutralObserver('W61N60'),rctx);
    rctx.module.exports.loop();assert.equal(rctx.Memory._repairPoolNeutral,undefined,'ramparts alone do not latch');
    tasks.push({kind:'repair',target:{structureType:'road',pos:{x:11,y:40}},backlog:4750});
    rctx.Game.time=6;rctx.module.exports.loop();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rctx.Memory._repairPoolNeutral)),{t:6,type:'road',backlog:4750,n:1,x:11,y:40});
    rctx.Game.time=7;rctx.module.exports.loop();assert.equal(calls,2,'latched observer stops computing the pool');
    // 升级者到岗诊断：非 incumbent、进控制器 3 格内的第一 tick 记下身上与站位能量，之后冻结
    const succ={id:'new',name:'next',spawning:false,memory:{role:'upgrader'},pos:{x:32,y:40},store:{energy:0}};
    const old={id:'old',name:'route-incumbent',spawning:false,memory:{role:'upgrader'},pos:{x:32,y:41},store:{energy:100}};
    const aroom={name:'W34S7',controller:{pos:{x:31,y:41}},storage:{store:{energy:0}},getEventLog:()=>[],
        find:k=>k==='creeps'?[succ,old]:[{structureType:'container',pos:{x:32,y:40},store:{energy:0}},{structureType:'link',pos:{x:31,y:40},store:{energy:597}},{structureType:'link',pos:{x:10,y:10},store:{energy:800}}]};
    const actx={module:{exports:{loop:()=>{}}},Memory:{rooms:{}},Game:{time:536,rooms:{W34S7:aroom},creeps:{'route-incumbent':old},getObjectById:()=>null},
        EVENT_UPGRADE_CONTROLLER:9,FIND_MY_CREEPS:'creeps',FIND_STRUCTURES:'structures'};
    vm.runInNewContext(fixtures.upgraderActualRouteObserver('W34S7'),actx);
    actx.module.exports.loop();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(actx.Memory._upgraderRouteProof.arrival.new)),{t:536,name:'next',x:32,y:40,carried:0,
        station:[['container',32,40,0],['link',31,40,597]],storage:0,incumbentAlive:true});
    assert.equal(actx.Memory._upgraderRouteProof.arrival.old,undefined,'the incumbent is not an arrival');
    succ.store.energy=42;actx.Game.time=537;actx.module.exports.loop();
    assert.equal(actx.Memory._upgraderRouteProof.arrival.new.carried,0,'arrival snapshot stays frozen');
}

function testUpgraderActualRouteEffect() {
    const effect=require('../scripts/private_server/effects').EFFECTS.find(e=>e.id==='upgrader.actualSpawnHandoff');
    const check=r=>effect.check({upgraderRoute:r},{upgraderActualRoute:'W34S7'}).ok;
    assert(check(upgraderRouteReport()));
    for(const mutate of [r=>{r.spawn.y=36;},r=>{r.leg.complete=false;},r=>{r.leg.ticks=55;},
        r=>{r.oldDiesAt=700;},r=>{delete r.seedTick;},r=>{r.seedTick=2;},r=>{r.body[0]='move';},r=>{r.samples[1].t=602;},
        r=>{r.samples[1].creeps.shift();},r=>{r.samples[1].creeps[1].id='another';},
        r=>{r.proof.events={};},r=>{r.proof.events.new.observedAt=602;},r=>{r.proof.events.new.event.event=4;}]) {
        const report=upgraderRouteReport();mutate(report);assert(!check(report),'wrong origin/body/deadline/actual event must fail');
    }
    // 播种落在 tick 2（一期起服的暂停竞态，validation-2Av9CU）：整条时间线平移一 tick，截止按播种 tick 换算仍然通过
    const shifted=upgraderRouteReport();
    shifted.seedTick=2;shifted.oldDiesAt=602;shifted.at=2;
    assert(check(shifted),'deadline is relative to the seed tick, not the literal 601');
}

function orderedReport() {
    const test=affordableReport();
    Object.assign(test,{wantedHaulers:3,initialCarry:120,wantedCarry:60});
    test.samples[0].creeps[1].room='W63N53';
    test.evidence={at:6,haulIndex:0,reserveIndex:1,haulKey:'haul',reserveKey:'reserve',haulOrdered:true,reserveOrdered:true,
        haulPriority:4,reservePriority:4,energy:1100,capacity:1800,haulCost:1050,haulParts:20,haulSince:-56,haulGrace:60,
        neededBy:7,blocked:['haul'],actions:[{key:'reserve',cost:650,parts:2}]};
    return test;
}
function testOrderedDeadlineEvidence() {
    const effect=require('../scripts/private_server/effects').EFFECTS.find(e=>e.id==='remote.orderedReserverDeadline');
    const check=r=>effect.check({reserveOrdered:r},{reserveOrderedTarget:'W63N53'}).ok;
    assert(check(orderedReport()));
    for (const mutate of [r=>{r.wantedHaulers=8;},r=>{r.wantedCarry=150;},r=>{delete r.wantedCarry;},r=>{r.evidence.haulIndex=2;},r=>{r.evidence.haulCost=1000;},r=>{r.evidence.haulParts=18;},
        r=>{r.evidence.haulSince=5;},r=>{r.evidence.reservePriority=7;},r=>{r.evidence.reserveOrdered=false;},
        r=>{r.evidence.blocked=[];},r=>{r.evidence.actions=[];},r=>{r.evidence.neededBy=100;},
        r=>{r.samples[0].creeps[1].id='unrelated';},r=>{r.samples[0].creeps.shift();}]) {
        const r=orderedReport();mutate(r);assert(!check(r),'invalid ordered handoff evidence must fail');
    }
}

async function testFixedTerrainCommands() {
    const fixtures=require('../scripts/private_server/fixtures');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-terrain-'));
    const previous=process.env.VALIDATION_TERRAIN_FIXTURE;
    try {
        const rooms={};
        for (const spec of fixtures.GENERATION) rooms[spec.room]={terrain:'0'.repeat(2500),objects:[
            {type:'controller',room:spec.room,x:20,y:20,level:0},
            ...Array.from({length:spec.sources},(_,i)=>({type:'source',room:spec.room,x:10+i,y:10}))]};
        const file=path.join(dir,'terrain.json');fs.writeFileSync(file,JSON.stringify({rooms}));
        process.env.VALIDATION_TERRAIN_FIXTURE=file;
        let inserted=0;
        const cli={run:async()=>{},evaluateJson:async command=>{
            assert(!/[\r\n]/.test(command),'fixed terrain commands must satisfy the one-line CLI protocol');
            if(command.includes('storage.db.rooms.insert')) inserted++;
            if(command.includes('var objects=values[2]'))return {room:true,terrain:true,controller:true,sources:2,mineral:true};
            return null;
        }};
        await fixtures.generateWorld(cli);
        assert.strictEqual(inserted,fixtures.GENERATION.length,'fixed mode imports every scenario without random generation');
    } finally {
        if(previous===undefined) delete process.env.VALIDATION_TERRAIN_FIXTURE;else process.env.VALIDATION_TERRAIN_FIXTURE=previous;
        fs.rmSync(dir,{recursive:true,force:true});
    }
}

function testScenarioSeedInfo() {
    const {scenarioSeedInfo}=require('../scripts/private_server/run_validation');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scenario-seed-'));
    try {
        const file=path.join(dir,'db.json');
        const db={collections:[{name:'env',data:[{data:{gameTime:1,mainLoopPaused:'1'}}]}]};
        fs.writeFileSync(file,JSON.stringify(db));
        const info=scenarioSeedInfo(file);assert.equal(info.tick,1);assert.equal(info.paused,true);assert.equal(info.sha256.length,64);
        db.collections[0].data[0].data.mainLoopPaused='0';fs.writeFileSync(file,JSON.stringify(db));
        assert.throws(()=>scenarioSeedInfo(file),/paused simulation/,'a mature running world cannot silently be used as a paused scenario seed');
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

function testCompleteSeedPersistedBeforeOptionalMove() {
    const source = fs.readFileSync(path.join(__dirname, '../scripts/private_server/run_validation.js'), 'utf8');
    const seeded = source.indexOf('await seedAllScenarios(seedCli)');
    const raw = source.indexOf("await persistMarker(seedCli, worldDir, 'scenarios_raw')", seeded);
    const copy = source.indexOf("'scenario-seed-raw-db.json'", raw);
    const move = source.indexOf('await moveBootstrapInvestment(seedCli,worldDir)', seeded);
    assert(seeded < raw && raw < copy && copy < move, 'a failed optional move must leave a complete persisted seed');
}

async function testIndependentUpgraderObservationDoesNotDelayExistingPhases() {
    const {waitForGameTimeWithObserver}=require('../scripts/private_server/run_validation');
    let tick=120;const phases=[],samples=[],waits=[];
    const cli={evaluateJson:async()=>tick};
    const wait=async(_cli,target)=>{waits.push(target);tick=Math.max(tick,target);return tick;};
    const observer={until:626,complete:false,sample:async t=>samples.push(t),finish:async t=>phases.push(['handoff',t])};
    await waitForGameTimeWithObserver(cli,120,10000,observer,wait);
    phases.push(['brainInitial',tick]);
    for(const target of [270,420,570,720]) {
        await waitForGameTimeWithObserver(cli,target,10000,observer,wait);
        phases.push(['brainRefresh',tick]);
        if(target===420)phases.push(['maintenance',tick]);
    }
    assert.deepStrictEqual(phases.filter(p=>p[0]==='brainInitial'),[['brainInitial',120]]);
    assert.deepStrictEqual(phases.filter(p=>p[0]==='brainRefresh').map(p=>p[1]),[270,420,570,720]);
    assert.deepStrictEqual(phases.find(p=>p[0]==='maintenance'),['maintenance',420]);
    assert.deepStrictEqual(phases.filter(p=>p[0]==='handoff'),[['handoff',630]]);
    assert(samples.includes(535)&&samples.includes(600),'five-tick samples capture arrival before fixed old death');
    const before=samples.length;
    await waitForGameTimeWithObserver(cli,1271,10000,observer,wait);
    assert.equal(tick,1271);assert.equal(samples.length,before,'completed observer stops its bounded sampling');
    assert.equal(waits[waits.length-1],1271);
    const jumping={until:626,complete:false,sample:async t=>samples.push(t),finish:async()=>{}};
    tick=650;await waitForGameTimeWithObserver(cli,660,10000,jumping,wait);
    assert(samples.includes(650),'actual timing jumps are recorded, never backdated');
}

// 夹具的规划位必须放得出工地（validation-52vHk6：plan.terminal 落在 (42,1)、上方 (41..43,0) 是出口 ⇒ 引擎 ERR_INVALID_TARGET）
function testAllocatorStructureTilesAvoidExitBorder() {
    const { PositionAllocator } = require('../scripts/private_server/fixtures');
    // 全平原、只有左边 x=0 的 y=10..12 是墙
    const terrain = Array.from({ length: 2500 }, (unused, i) => (i % 50 === 0 && Math.floor(i / 50) >= 10 && Math.floor(i / 50) <= 12 ? '1' : '0')).join('');
    const alloc = new PositionAllocator(terrain, []);
    assert.equal(alloc.buildable(42, 1), false, '贴着出口的 y=1 格放不出非路建筑');
    assert.equal(alloc.buildable(1, 11), true, 'x=1 且左侧三格全是墙：放得出');
    assert.equal(alloc.buildable(1, 20), false, 'x=1 左侧是出口：放不出');
    assert.equal(alloc.buildable(48, 48), false, '角落贴出口：放不出');
    assert.equal(alloc.buildable(2, 2), true, '内圈格不受出口规则约束');
    // near 从贴边的目标出发：structure:true 只取放得出的格，不带时照旧可取 y=1
    const plain = new PositionAllocator(terrain, []);
    const edgeTarget = { x: 25, y: 2 };
    assert.equal(plain.near(edgeTarget, { minRange: 1, maxRange: 1 }).y <= 2, true);
    const strict = new PositionAllocator(terrain, []);
    for (let i = 0; i < 6; i++) {
        const pos = strict.near(edgeTarget, { minRange: 1, maxRange: 3, structure: true });
        assert(strict.buildable(pos.x, pos.y) && pos.y >= 2, 'structure:true 的位置都放得出工地: ' + JSON.stringify(pos));
    }
}

async function main() {
    await testIndependentUpgraderObservationDoesNotDelayExistingPhases();
    testCompleteSeedPersistedBeforeOptionalMove();
    testUpgraderActualRouteEffect();
    await testUpgraderRoutePrepareUsesSeedTick();
    await testWrapperReinstallAndCronGuard();
    testValidationLatchObservers();
    testBootstrapInvestmentMovement();
    testUpgraderActualRouteFixtureAndObserver();
    testScenarioSeedInfo();
    await testFixedTerrainCommands();
    testOrderedDeadlineEvidence();
    testAffordableDeadlineEvidence();
    testDefaultArgs();
    await testWaitMarketHistory();
    await testPhaseOneKeepsSimulationPaused();
    testEffectsObserveTheAidChange();
    testBaselineFlagsHardRegressions();
    testAllocatorStructureTilesAvoidExitBorder();
}

main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
