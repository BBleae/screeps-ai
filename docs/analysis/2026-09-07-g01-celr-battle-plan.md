# 作战计划 — G01(W38S4/W38S5/W38S6) 与 Celr(W39S7/W39S8),2026-09-07

> 由 11-agent 侦察 workflow 产出(逐房实时情报 + 地理/respawn 门 + Overmind 研究 + 我方能力 → 对抗验证 → 综合)。
> 所有坐标/血量/能量均为**当日实拉**;地形逐格核实过。**等用户说开火再执行。**


## 开火门(GO / NO-GO)

GATE = GO. TRIGGER = NO-GO on the current working tree.

LEGAL/PHYSICAL GATE: GO. Re-verified myself today (2026-09-07, tick 73,529,197) via /api/game/room-status: W33S7, W35S7 and all five targets (W38S4/S5/S6, W39S7/S8) plus every staging candidate (W38S6/W38S7/W38S8/W37S6/W37S5/W39S5) all return status=normal, respawnArea=1791427536774, novice=null — one area, one expiry (2026-10-08 02:45 UTC). The engine's only status gate is StructureNuker.launchNuke; attack/rangedAttack/dismantle/attackController/claimController have none. The shield does not protect us from G01 or Celr — they are inside it with us. Nukes are off both directions until 2026-10-08.

OPERATIONAL GATE: NO-GO. Four hard blockers, two of which make "issue a directive today" silently fail.

B-1 (NEW THIS SESSION, most dangerous) config.conquest.entryLaneWidth = 0 (src/config.js:106). A concurrent session set the entry lane to 0 as an A/B control, so siegeDismantler.js:94-95 falls back to movement.go(creep, RoomPosition(25,25,target), {range:20}) — everyone walks to room centre = the single-file snake that produced 19/28 at W32S4 and 2/17 in the B0 oracle. Must be 10 before firing.

B-2 storageFloor:15000 blocks all four real sponsors. Live storage: W33S7 9,468 / W34S7 12,665 / W35S7 8,903 / W33S8 5,703 (total 36,739). demandsFor returns [] when storageOk is false. Rooms WITHOUT storage always pass, so sponsors:'all' (minCapacity is now 800) would emit only W31S8/W31S6 750e/1000-hit chaff — and they still count toward the squad quorum. Result today: either zero dismantlers or only the wrong ones, with no error.

B-3 No muster quorum or timeout. squad = dismantlers+guards is frozen into creep memory at spawn and never recomputed; siegeDismantler.js:78-84 launches only on here >= squad with no timeout branch. One casualty en route = permanent deadlock until the wave dies of old age at 1,500 ticks.

B-4 CLAIM-class creeps physically cannot reach the theatre. downgrader.js, claimer.js and pioneer.js all call movement.go(..., {range:20, reusePath:40}) with no avoidRooms, so applyDangerAvoidance engages and routes around every SK room. The only SK-free path is W33S8-W34S8-W34S9-W35S9-W35S8-W36S8(Alepoldar RCL5, tower)-W36S7-W37S7-W37S6-W38S6: 9-10 hops, 650-900 ticks, versus CREEP_CLAIM_LIFE_TIME 600. I verified the terrain myself: W35S7 has W=0 and S=0 open tiles, so there is no W35S7-to-W36S7 shortcut; the whole theatre sits behind the SK ring. Consequence: the downgrade tail AND the "claim W38S6/W38S7" options are both non-executable as the code stands. Worse, nDg = Math.max(1, Number(d.downgraders) || 1), so writing downgraders:0 still spawns one — every directive that reaches phase 'downgrade' burns 1,300e on a creep that dies en route.

EARLIEST FIRE: B-1 is one line; B-2 is either waiting for storage or a per-directive storageFloor override; B-3 is squadWait + fractional quorum (half a day); B-4 is optional (only needed if we want a downgrade tail). With the CLAUDE.md-mandated private-server pass (effects.js already carries a conquest.breach assertion to extend), realistically 12-24 hours to a legitimate W38S5 launch.

MEANWHILE: bank storage (do NOT spend it), run the corridor probe (see checklist), keep pushing W33S7 to RCL6 (662,841/1,215,000) because labs are the only thing that ever unlocks W39S7.


## 执行摘要

The five-room framing is the error. GCL 12 with 10 rooms owned leaves 2 claim slots; the economy funds one breach; the code today funds zero. The correct campaign is TWO rooms, serial, deny-only, no downgrade tail.

W38S5 is the one unambiguously correct move: RCL3, zero towers, zero ramparts, zero combat parts anywhere in G01's territory, spawn (7,40) eight steps from the south edge. Six dismantlers, ~8,400e, zero expected in-room losses. It is simultaneously (a) the safe-mode reflex probe, (b) the live-fire rehearsal of the rebuilt siege stack, and (c) the mandatory staging room for W38S4, whose only door it is.

W38S4 is conditional and thinner than briefed. I re-pulled it live: the tower is at 930/1000 and rising (it was 540 at first recon), room stored energy 2,564 against a 10 e/tick tower burn and 20 e/tick income — the "49-shot magazine race" in the recon and capability report is FALSE, delete it. And the room now holds THREE 9W/9C/9M workers (Evelyn, Thomas, Lauren) = up to 2,700 hits/tick of repair, so the advertised "five dismantlers, one tick, one tower" is wrong. Twelve dismantlers deliver 5,400/tick gross, net >=2,700 against repair, tower dead in <=2 ticks. Expect 4-7 losses of 12 and accept a real probability of a clean abort, because safeModeAvailable=4 with no cooldown and the shieldlock counter is dead (see below).

The shieldlock is dead at W38S4 and must be struck from the sequence. The controller (13,38) has exactly ONE walkable neighbour, (12,37) — I verified it is plain — at Chebyshev 4 from the tower = 600 dmg/tick, and the maximum downgrader repeatBody can build at our 1,800 cap is [CLAIM x2, MOVE x2] = 400 HP. It dies in one tick. Permanent lockout needs 45,000 ticks shaved at 1,600/1,000-tick cycle through a single access tile = 28,100 ticks of unbroken relay into a live killbox. Not achievable. W38S4 therefore reduces to a straight bet that G01's hand-rolled bot has no safe-mode reflex — and W38S5 tests that bet for one third of the price.

W38S6: do nothing. ttd is 17,510 as of tick 73,529,197 — it reverts to neutral in ~18.5 hours by itself, has zero structures and zero creeps, and safeModeAvailable is already 0.

W39S8: skip. Seven hops, no claim slot, and the "self-sustaining denial" claim is false at account level — W39S7 holds 452,693 energy, ~90 tower rebuilds.

W39S7: hard no, and not merely "not viable unboosted". attackController is geometrically impossible: the controller (19,44) has one walkable neighbour, (20,45), and that tile holds their controller LINK under a rampart — STRUCTURE_LINK is an obstacle. The one lever that works unboosted does not exist there. The cheap correct denial is occupying neutral W38S7, its only door — but that needs a GCL slot and B-4 fixed first.

Two corrections that propagate: W33S7 is RCL5 (1,800 cap, 30 extensions, 0 labs, 0 terminal), not RCL7 — every body in this plan is sized to 1,800. And W37S7's derelict Lucas21 spawn is NOT a risk: siegeDismantler only acts when creep.room.name === target, so it never dismantles in transit rooms. The recon's warning there can be dropped.


## 目标排序


### 1. W38S5（G01）→ **deny**,难度 trivial

Zero towers, zero ramparts, zero combat parts in G01's entire territory. Spawn 5,000 + 10 extensions x 1,000 = 15,000 hits, spawn (7,40) is 8 walkable steps from the south edge. Six dismantlers, ~8,400e, zero expected in-room losses. It is the safe-mode probe (safeModeAvailable 2, no cooldown), the live-fire rehearsal for the rebuilt siege stack, and W38S4's ONLY door - we have to hold it anyway. Verified live: 1 spawn, 10 ext, 6 economy creeps, ttd pinned at 20,001.

### 2. W38S4（G01）→ **deny**,难度 hard-but-doable

The only defended target worth hitting. One UNRAMPARTED 3,000-hit tower, zero ramparts, zero player walls, zero combat parts, one 24-tile door (south, from W38S5). Conditional on three things: W38S5 having answered the safe-mode question, B-1/B-2/B-3 landed and privately validated, and a sponsor actually clearing the storage floor. Force 12 dismantlers, 0 guards, 0 downgraders. Expect 4-7 losses. Do NOT count on ammo starvation (tower at 930/1000 and rising) and DO count on ~2,700/tick of worker repair.

### 3. W38S6（G01）→ **skip**,难度 free

Four objects in the entire room: 2 sources, 1 mineral, 1 controller. No spawn, no tower, no creep. ttd 17,510 at tick 73,529,197 = it reverts to neutral on its own in ~18.5 hours, and safeModeAvailable is already 0 so nothing can shield it. Spending anything here is waste. Use it as the staging room for W38S5, nothing more. Do NOT spend a GCL slot on it: 59% wall, far source 39 tiles from a single-access-tile controller, wedged between G01's W38S5 and Celr's reserved W38S7 - W36S7/W37S7 are strictly better free claims.

### 4. W39S8（Celr）→ **skip**,难度 medium

Seven hops behind two SK rooms, no GCL slot to spare, and the denial does not stick: Celr's W39S7 holds 452,693 energy = ~90 tower rebuilds, so 'they cannot afford a 5,000e tower' is false at account level. The west (near-tower, 10-step) edge needs the W40 highway corridor, which is a separate reachability project. Its unique 18,774-tick safe-mode blackout will lapse long before we are ready. Spend the ~18-20k energy on W33S7's RCL6 instead.

### 5. W39S7（Celr）→ **defer-until-boosted**,难度 infeasible-unboosted

Not merely unbreachable - the downgrade doctrine is unavailable too. Controller (19,44) has exactly ONE walkable neighbour, (20,45), occupied by their controller LINK under a rampart; STRUCTURE_LINK is an obstacle, so no creep can ever reach attackController range. Plus: one 18-tile east door with every entry tile at 480/tick, a 26-rampart min-cut at x=47 all at 600/tick, two towers fed by 452,693 storage (they never run dry), and safeModeAvailable 4 with no cooldown. Our best unboosted heal anywhere is 36/tick. Re-profile only after the first XLHO2 batch exists (needs RCL6 at a sponsor). The cheap denial is occupying W38S7, its only door - a claim decision, not an assault.


## 逐目标方案


### W38S5

- **集结点**:W38S6
- **进入边**:SOUTH (y=49, x=5-15, 11 open tiles) from W38S6. Terrain-verified: W38S6 N edge = 11 tiles at x=5-15, matching W38S5 S edge. This is the near-spawn edge - 8 steps to spawn (7,40) versus 19 from the west (W39S5), 39 from the north, 41 from the east. NOTE: entryEdge is NOT consumed by any code; the entry anchor is hard-coded as stagePos(target,staging) = (25,41) in W38S5, which is a WALL tile - harmless because laneTile is terrain-aware and shifts along x, and because W38S5 has no tower so the extra walking is free.
- **兵力**:6 x siegeDismantler, 0 guards, 0 downgraders. dPer = ceil(6/3) = 2 per sponsor, exact. Bodies from repeatBody(['work','move'], min(cap,1800)): W33S7 (cap 1800) -> [WORK x12, MOVE x12] = 1,800e, 2,400 hits, 600 dismantle/tick, 72t spawn; W34S7 and W33S8 (cap 1300) -> [WORK x8, MOVE x8] = 1,200e, 1,600 hits, 400/tick, 48t. Total 2x1800 + 4x1200 = 8,400e, 2,800 dismantle/tick gross. Against up to 1,200/tick of repair from their three 4W/4C/4M workers, net >=1,600/tick: spawn (5,000) in ~4 ticks, 10 extensions (10,000) in ~4 more. Zero guards - G01 has no ATTACK/RANGED_ATTACK/HEAL/TOUGH part anywhere in W38S4, W38S5 or W38S6.

- **阶段**:1) Spawn ~180 ticks (parallel across 3 sponsors; W33S7 is energy-bound at ~90t per 1,800e body). 2) March to W38S6: W33S7-W34S7-W35S7-W35S6[SK]-W36S6[SK]-W37S6-W38S6, ~420 ticks for a 1:1 body; W33S8 is one hop longer, ~480. 3) Muster at holdTile around (25,8) in W38S6 - I verified that tile and its 5x5 neighbourhood are all plain. 4) Launch when here >= 6. 5) Cross into W38S5, shared focus-fire the lowest-hits target: spawn first (no towers), then the 10 extensions. 6) Dismantlers self-retire and recycle. 7) THE MOMENT runOne sets phase='downgrade', DELETE the directive - otherwise nDg=max(1,0)=1 spawns a 1,300e downgrader that cannot reach the room. First blow lands ~700-900 ticks after the directive is written (~45-60 min at 3.85 s/tick).

- **可利用点**:G01 is definitively NOT Overmind (Spawn1/Spawn2, human first names, 5W1M + 2C1M + NxW/C/M tutorial body vocabulary, no ramparts at RCL5, empty storage, claim-and-forget expansion). None of the Overmind findings apply. The exploitable facts are plain: no tower means the loss integral is zero and the entire 19/28 model is moot; the base is packed into an 8x8 pocket at x1-8,y35-42; logistics are visibly broken (two 5W1M miners feeding ONE 2-CARRY hauler, 8,445e rotting on the ground at (4,31)); and W38S4's tower cannot reach into W38S5, so there is no covering fire.


**指令(直接粘贴)**:
```js
Memory.conquest = [{ target: 'W38S5', sponsors: ['W33S7','W34S7','W33S8'], staging: 'W38S6', dismantlers: 6, guards: 0, downgraders: 0, downgraderBudget: 1300, avoid: ['W38S4','W34S4','W34S5','W34S6','W35S4','W36S4','W36S5','W35S8','W36S8','W36S9','W37S9'], noClaim: true, phase: 'breach' }];  // NOTE the avoid list deliberately OMITS W35S6 and W36S6 - we accept the 2-SK-room short corridor (6 hops) rather than the 10-hop southern detour through Alepoldar's towered W36S8/W36S9. Because avoidSet() always returns a non-empty set, passing `avoid` at all DISABLES movement.js's automatic SK avoidance for the march-to-staging leg - that is exactly what we want here, but it means the SK rooms must be probed first (see prerequisites).
```


**风险**:1) safeModeAvailable 2, no cooldown - if they pop it, siegeDismantler retreats to staging automatically, we lose nothing but the trip, and we have bought the answer cheaply. That IS the point of hitting this room first. 2) SK transit through W35S6 (lairs 46,7 / 10,12 / 33,36 / 1,41) and W36S6 (lairs 8,2 / 43,7 / 15,31 / 43,38) with no in-room lair avoidance in movement.go - W36S6's (15,31) lair sits near the straight E-to-W line and is the real hazard. Budget 1-2 creeps, probe first. 3) The (25,41) entry anchor is a wall tile and pushes creeps ~18 tiles east of the spawn before they turn around - costs ticks, costs nothing else. 4) W38S6 is 59% wall; expect slow maze-walking to the muster anchor.


### W38S4

- **集结点**:W38S5
- **进入边**:SOUTH (y=49, x=8-31, 24 open tiles) - and it is the ONLY edge. Terrain-verified: N=17 tiles at x=5-21 but sealed by respawn boundary wall (W38S3 is out of area), E=14 tiles at y=21-34 likewise sealed (W37S4 out of area), W=0 open tiles. The one door is also the near-tower side, so the retro's 'stage nearest the towers' rule is satisfied for free. Effective entry anchor is hard-coded (25,41) - verified plain - with laneTile spreading x in [15,35]. That band costs roughly 8,000-9,000 cumulative tower damage versus the Dijkstra-optimal 5,970 from a west-hug at x=8-10. Closing that ~30% gap needs retro item B2 (entryEdge selector); it is an improvement, not a blocker, and the force below is sized for the worse number.
- **兵力**:12 x siegeDismantler, 0 guards, 0 downgraders. dPer = ceil(12/4) = 3 per sponsor, exact. W33S7 3 x [WORK x12, MOVE x12] (1,800e, 2,400 hits, 600/tick); W34S7, W35S7, W33S8 3 each of [WORK x8, MOVE x8] (1,200e, 1,600 hits, 400/tick). Total 16,200e, 5,400 dismantle/tick gross. Tower (16,38) has exactly 5 free adjacent tiles - (16,37),(17,37),(17,38),(16,39),(17,39), all verified plain - so at most 5 dismantlers touch it at once (3,000/tick if they are the big ones). Against up to 2,700/tick of repair from their three 9-WORK workers that is net >=300 worst case and ~2,700 realistically (their repair is energy-bound: 2,700 hits/tick costs 27 e/tick against 20 e/tick income and 2,564e in the room). Tower dies in 1-3 ticks. Then spawn (16,42), 5,000 hits, ~2 ticks; then 30 extensions. ZERO guards (nothing to fight) and ZERO downgraders (shieldlock is dead here - see risks).

- **阶段**:1) Spawn ~400 ticks (W35S7 is the bottleneck at ~9 e/tick income for 3,600e). 2) March to W38S5 via the same SK corridor plus W38S6, ~450-500 ticks. 3) Muster in W38S5 at holdTile around (25,8) - W38S5 is already flattened and holds no tower. 4) Launch on here >= 12. 5) Cross y=49 into W38S4 across the x=15-31 lane; shared focus-fire drives everyone onto the lowest-hits armed tower. 6) Tower dead in 1-3 ticks; spawn next; extensions last. 7) Delete the directive the instant phase flips to 'downgrade'. Total ~900-1,100 ticks from directive to first blow, ~1 to 1.2 hours.

- **可利用点**:The room is a cul-de-sac with one door that we will already own, so G01 cannot flank, reinforce or evacuate once W38S5 is ours. All 31 constructedWall objects are respawn-area boundary walls (hitsMax 300,000,000, decayTime = the area end timestamp), not defences. The tower is unramparted at base 3,000 hits. Every structure in the room is bare. Note the closing window in the other direction too: RCL5 permits a second tower and they have not built one, they are 662k/1,215k toward RCL6, and on 2026-10-08 the boundary walls drop and W38S4 gains its N and E entrances (much easier for us, but also for everyone else).


**指令(直接粘贴)**:
```js
Memory.conquest = [{ target: 'W38S4', sponsors: ['W33S7','W34S7','W35S7','W33S8'], staging: 'W38S5', dismantlers: 12, guards: 0, downgraders: 0, downgraderBudget: 1300, avoid: ['W34S4','W34S5','W34S6','W35S4','W36S4','W36S5','W35S8','W36S8','W36S9','W37S9'], noClaim: true, phase: 'breach' }];  // Fire ONLY after the W38S5 directive has been deleted. Never both at once - getDemands aggregates every directive into every sponsor and there is no maxConcurrentBreaches gate (retro D3 open).
```


**风险**:1) THE KILLER IS SAFE MODE, and there is no counter. safeModeAvailable=4, safeModeCooldown=null, upgradeBlocked=null. Countermeasure (a) shieldlock is DEAD: the controller (13,38) has exactly ONE walkable neighbour, (12,37) - verified plain - at Chebyshev 4 from the tower = 600 dmg/tick, and our maximum downgrader is [CLAIM x2, MOVE x2] = 400 HP. Countermeasure (c) permanent denial is also unreachable: threshold is 80,000/2-5,000 = 35,000 against ttd 80,001, and a single access tile caps us at -1,600 per 1,000-tick cycle = 28,100 ticks of unbroken relay into a live killbox. So this is a bet that their bot has no safe-mode reflex, and W38S5 is how we buy that information. Circumstantial evidence for the bet: safeModeAvailable equals level-1 in all three of their rooms, i.e. exactly the free per-level grant with none ever spent, and the 73,455,268 field is the expiring initial respawn grant, not a spent activation. 2) 2,700/tick of worker repair - sized for above; do not send 5 dismantlers. 3) The tower is NOT starvable (930/1000 and rising, 20 e/tick income vs 10 e/tick burn). 4) G01 is GCL 15 mid-respawn: this is a snapshot of a weak moment, not a weak player. Expect their code to improve.


### W38S7

- **集结点**:n/a - occupation, not assault
- **进入边**:From W37S7 (W38S7 E edge = 21 tiles at y=14-34). Route W35S7-W35S6[SK]-W36S6[SK]-W37S6-W37S7-W38S7, 5 hops.
- **兵力**:1 claimer + 1-2 pioneers. ZERO combat units. Nothing in W38S7 can shoot; it is a neutral 2-source room Celr merely reserves.

- **阶段**:Deferred. Presented because it is the ONLY cost-effective answer to W39S7: W38S7 is that room's single doorway (W39S7 has N/S/W solid terrain and one 18-tile east edge), so holding it is a permanent zero-combat blockade of Celr's capital plus a forward base that would finally put CLAIM creeps within lifetime range of the whole W38 column.

- **可利用点**:n/a


**指令(直接粘贴)**:
```js
NOT a Memory.conquest directive - this is a claim and belongs to the external brain's claim queue (data/brain/locks.json + scripts/brain). DO NOT write it as a conquest entry. PREREQUISITE B-4: claimer.js/pioneer.js path with default SK avoidance, giving a 650-900 tick route against CREEP_CLAIM_LIFE_TIME 600 - the claimer dies before arrival. This is unbuildable until claimer/pioneer accept an avoid override, exactly like the downgrader.
```


**风险**:Costs one of our two remaining GCL slots for a room we cannot garrison (defense.js engages NPCs only; retro D1 unimplemented), sits at the end of a 5-hop supply line, and Celr will contest the reservation. Weigh against the free 2-source claims at W36S7 and W37S7, which are 2-3 hops from W35S7 and far more defensible. My recommendation is to take W36S7/W37S7 and leave W38S7 alone until we have hold capability.


## Overmind(Celr)专项结论

HONEST VERDICT: there is no Overmind exploit plan worth firing, and the two rooms it would apply to are the two we are not attacking.

1) IDENTIFICATION IS ~50/50 AND EVERYTHING DOWNSTREAM INHERITS IT. Celr's controller carries the genuine Unicode small-caps overmind signature, but the live creeps are named next_<role>_<tick>_<Spawn> with roles miner/hauler/remoteMiner/transport/queen/worker/upgrader. Overmind's Hatchery.generateCreepName emits <role>_<i> with no tick and no spawn name, its miner is 'drone', and 'miner'/'hauler'/'remoteMiner' are not Overmind role names at all — identical in 0.5.2 (2019) and dev (2024), so version drift cannot explain it. Either they ran Overmind once and switched, or it is a fork with a rewritten hatchery. Do not size any force on an Overmind-derived number.

2) THE ONE FINDING THAT WOULD MATTER IS GEOMETRICALLY DEAD. The real, version-robust Overmind weakness is that a pure CLAIM/MOVE/TOUGH creep is invisible to dangerousPlayerHostiles, hence to DEFCON, unsafeFor, DirectiveInvasionDefense and BOTH safe-mode triggers — so a lone downgrader could walk a colony from "safe mode ready" to "safe mode gone forever" unnoticed. At W39S7 that is unusable: the controller (19,44) has exactly ONE walkable neighbour, (20,45), and it holds their controller LINK under a rampart. STRUCTURE_LINK is an OBSTACLE_OBJECT_TYPE. No creep can reach attackController range at all. Opening it means killing an 8,501-hit rampart plus a 1,000-hit link from (21,45) at 300/tick while the towers, fed by 452,693 stored energy, fire indefinitely. That is a boosted operation.

3) FINDINGS I AM CUTTING, WITH REASONS. The TOUGH-decoy tower-aggro trick rests entirely on Overmind's maxBy(hitsMax - hitsPredicted + ...) scoring — against G01, which is definitively NOT Overmind (Spawn1, human first names, tutorial bodies, no ramparts at RCL5), it is pure speculation, and the W38S4 tank plan in the recon rests on exactly that assumption applied to an unidentified bot. Cut. The avgHostileHealingTo max/N inhibition bug never closes unboosted (600/tower at range<=5 versus a realistic 100-200 threshold) — boost-era only, cut. CPU-bucket starvation via junk-creep flooding would break us first (our CPU is mean 98.5, peak 165 against a 140 limit) — cut. Assimilator / RemoteDebugger / "Overmind bloc" is near-dead (Muon inactive since ~2020, assimilation unfinished in 0.5.2) — treat as zero risk and zero opportunity, and the console-injection vector must not be pursued at all: that is an attack on a person's machine, not a game move, and it is server-side patched. Tower drain does not work either — isEdgeDancing is competently implemented and explicitly refuses to fire at edge-dancers it cannot kill.

4) ONE ENGINE CORRECTION WORTH RECORDING. The claim that same-tick mass attackController is "a bug on their side" is flatly wrong. attackController.js gates on the PERSISTED controller.upgradeBlocked; a successful attack sets target._upgradeBlocked (underscore-prefixed, stripped by removeHidden) which is only committed in controllers/tick.js after all creep intents, while bulk.update genuinely mutates downgradeTime. So N creeps attacking the same controller in one tick each land -300 x CLAIM. Overmind's DirectiveControllerAttack mass-claimer pattern is correct and WE are leaving an N-times multiplier on the table. CAVEAT: it is geometrically unavailable at W38S4, W38S5 and W38S6 — each has exactly one controller access tile — and only W39S8 (3 tiles) could use it. Confirm on the private server before relying on it; this is engine 4.3.0 and live shard1 may differ.

5) WHAT WE ACTUALLY DO ABOUT CELR. Nothing offensive. Two cheap, reversible things: (a) if we ever want the identification, one MOVE-only scout into W39S7 for ~60 ticks discriminates Overmind from anything else — watch whether safe mode fires the instant a single ARMED creep touches the room (their barrier is not a closed perimeter, so trigger (b) would fire on entry, not on breach), whether exactly one ranged defender appears 21+ ticks later, and whether towers refocus onto the most-wounded creep; never probe with an armed creep. (b) Record W39S7 in Memory.map / brain intel with a hard avoid flag and re-profile only after the first XLHO2 batch exists. Two force-design rules survive regardless of identification and we already satisfy both: keep total ATTACK+RANGED_ATTACK under ~50 parts (BunkerDefenseOverlord needs 2,100 damage and scores WORK at literally zero), and keep HEAL low (defender count is driven solely by OUR healing). Finally, note the strategic trap: Overmind never unclaims and re-places DirectiveColonize every 25 ticks on a spawnless colony, so "deny by killing the spawn" does not stick against it — which is another reason the Celr theatre is a claim-or-nothing problem we cannot currently afford.

6) A FUTURE BOOSTED FORCE MUST BE SIZED AGAINST A BOOSTED DEFENCE. Crossing 1,500 damage/tick flips their defenders to T3 and 2,100 summons bunker lurkers. The boost investment is a step function, not a gradient. Track 2 (task #10) plus W33S7 RCL5->RCL6 is the blocking path; there is no shortcut.


## 前置条件(开火前必须满足)


- CODE P1 (one line, blocking): set config.conquest.entryLaneWidth back to 10. It is currently 0 in the working tree, which silently restores the room-centre single-file march that produced 19/28 and the 2/17 B0 oracle result. Coordinate with the concurrent session that set it (src/config.js, src/conquest.js, src/roles/siege*.js and test/conquest_test.js are all modified right now — git status --short before touching anything).

- CODE P2 (blocking): resolve the storageFloor paradox. Live storage is W33S7 9,468 / W34S7 12,665 / W35S7 8,903 / W33S8 5,703 against a floor of 15,000, so today every real sponsor is silently muted. Preferred fix: honour a per-directive d.storageFloor in conquest.demandsFor (~3 lines) and set it to 6,000 for the 8,400e W38S5 wave and 9,000 for the 16,200e W38S4 wave — the 15,000 global was calibrated for a 28-creep, 28,600e wave, not these. Zero-code alternative: bank energy until all pinned sponsors clear 15,000 (needs +23,261e account-wide, several hours to a day at the realistic 30-50 e/tick net surplus). Either way NEVER use sponsors:'all' — minCapacity is now 800, so it pulls in storage-less W31S8/W31S6, which always pass the floor, emit 750e/1,000-hit chaff, and inflate the squad quorum.

- CODE P3 (blocking): muster quorum and timeout (retro B6, task #7). Add config.conquest.squadWait (~300) plus a fractional quorum — launch on present >= ceil(0.8 x squad) OR now - firstArrival >= squadWait — and recompute squad from LIVE survivors instead of the value frozen into creep memory at spawn. Without this a single casualty en route deadlocks the wave permanently. Emergency manual lever if we fire without it: Object.keys(Game.creeps).filter(n => Game.creeps[n].memory.targetRoom === 'W38S5').forEach(n => Game.creeps[n].memory.launched = true).

- ROUTE PROBE (blocking, cheap): the march-to-staging leg passes avoidRooms, which DISABLES movement.js's automatic SK avoidance, so the wave will transit W35S6 (lairs 46,7 / 10,12 / 33,36 / 1,41) and W36S6 (lairs 8,2 / 43,7 / 15,31 / 43,38) with no in-room lair avoidance. Send ONE throwaway creep down the exact same code path first: Game.spawns.<name>.spawnCreep([MOVE,MOVE,MOVE,MOVE,MOVE],'probe1',{memory:{role:'siegeDismantler',home:'W35S7',targetRoom:'W38S5',staging:'W38S6',squad:2,avoid:['W38S4','W34S4','W34S5','W34S6','W35S4','W36S4','W36S5','W35S8','W36S8','W36S9','W37S9']}}). squad:2 with only one creep alive forces the avoidRooms march branch and parks it at W38S6, giving persistent vision. If it dies in an SK room, the corridor is not safe with our pathing and we need a lair-avoiding costCallback before any wave moves.

- PRIVATE-SERVER VALIDATION (blocking, CLAUDE.md hard gate): extend scripts/private_server/effects.js (conquest.breach at line 384 is the existing hook) with an effect assertion for the lane-width restore and the quorum/timeout, seed a fixture matching W38S5's geometry (no tower, spawn 8 steps from the entry edge, three repairing workers), and run node scripts/private_server/run_validation.js with a raised --effect-ticks. Compare against data/validation/baseline.json for regressions. No game-code change ships without an effects assertion.

- CPU HEADROOM (blocking): stop generatePixel before launch. Live CPU is mean 98.5 / peak 165 against a 140 limit, and main.js:203-207 burns the whole 10,000 bucket every ~300 ticks. Zero-code kill switch: Memory.pixelRetry = Game.time + 100000. Require bucket >= 5,000 and mean CPU <= 120 at launch.

- ENERGY: the W38S5 wave costs 8,400e of bodies and the W38S4 wave 16,200e, against 36,739e of total account storage. Serial only. Do not start W38S4 until W38S5 is finished, the directive deleted, and storage has recovered.

- BOOSTS: not required for W38S5 or W38S4 (zero and one unramparted tower respectively). Absolutely required for W39S7, and no sponsor has a lab or terminal — W33S7 is RCL5 at 662,841/1,215,000, so labs are one full RCL away. Track 2 (task #10) is the blocking path there.

- GCL: 12 (345.9M points), 10 rooms owned, 2 free claim slots. A five-room CLAIM campaign is arithmetically impossible. Both W38S4 and W38S5 are planned as DENY. Reserve the two slots for the free 2-source neutrals W36S7 and W37S7 unless the user overrides.

- NOT A PREREQUISITE (correcting the recon): W37S7's derelict Lucas21 spawn does NOT need to be in avoid. siegeDismantler.run() returns early unless creep.room.name === target, so it never dismantles anything in a transit or staging room. Verified in src/roles/siegeDismantler.js:74-102.


## 时序与时间成本

STRICTLY SERIAL. There is no maxConcurrentBreaches gate (retro D3 open) and conquest.getDemands aggregates EVERY directive into EVERY sponsor, so two live directives would hang 2 x dPer 1,800e slots on each sponsor simultaneously — the same shape as the failure that zeroed 8 reservers at W32S4. Memory.conquest array length must be 1 at all times.

Tick rate measured at 3.81-3.90 s/tick on shard1, so ~920-945 ticks/hour.

PHASE 0 — prerequisites (12-24 h wall clock). Land P1/P2/P3, run the corridor probe, pass private-server validation, bank storage, kill generatePixel. Nothing moves toward the enemy except probe1.

PHASE 1 — W38S5 deny. Spawn ~180 ticks (parallel across three sponsors; W33S7 is energy-bound at ~90 ticks per 1,800e body). March ~420-480 ticks over 6-7 hops for a 1:1 WORK/MOVE body (1 tile/tick on plain, 5 on swamp). Muster + launch ~30 ticks. Engagement 10-15 ticks. TOTAL ~700-900 ticks = 45-60 minutes from writing the directive to the spawn falling. Delete the directive at phase flip.

DECISION POINT — did G01 activate safe mode? If YES: W38S4 is off the table for 20,000 ticks (~21 h) per charge and they hold four charges. Stand down, bank the information, and spend the cycle on W33S7's RCL6. If NO: proceed, with the caveat that a per-controller charge at W38S5 tells us about their bot's reflex, not about W38S4's charges, which are independent.

PHASE 2 — W38S4 deny. Wait for storage recovery (the W38S5 wave costs 8,400e). Spawn ~400 ticks — W35S7 is the bottleneck at ~9 e/tick income for 3,600e of bodies. March ~450-500 ticks. Engagement 3-6 ticks for the tower, ~2 for the spawn, then extensions at leisure. TOTAL ~900-1,100 ticks = 1.0-1.2 hours from directive to breach, plus the storage-recovery wait, so realistically Phase 2 starts 4-8 hours after Phase 1 ends.

NO DOWNGRADE TAILS ARE SCHEDULED, and that is deliberate. Every published tail estimate is unexecutable today for a mechanical reason, not an economic one: downgrader.js paths with default SK avoidance onto a 650-900 tick route against CREEP_CLAIM_LIFE_TIME 600. Even if B-4 were fixed, the honest tails (using the corrected engine arithmetic — a level drop refills the timer with only CONTROLLER_DOWNGRADE[newLevel]/2 + 1, so every estimate in the dossier is ~25-30% too pessimistic) are: W38S5 L3->0 = 35,000 ticks ~ 1.4 days of unbroken relay for a room with no tower, which is the only one that is even arguable; W38S4 L5->0 = 125,000 ticks and requires 28,100 ticks of relay through a single access tile at 600 dmg/tick, which is impossible. Recommendation: deny-only, no tails, revisit after a forward base exists.

FREE EVENTS ON THE CLOCK, no action required: W38S6 reverts to neutral at ~tick 73,546,707 (~18.5 h from now). W39S8's safe-mode cooldown expires at tick 73,547,971 (~18,774 ticks, ~20 h) — we will not be ready and that is fine. The respawn area ends 2026-10-08 02:45 UTC (~31 days), at which point W38S4 gains two extra entrances (better for us) and outside veterans reach our sector (worse for us). That deadline argues for resolving the W38 column soon, not for rushing a half-built wave.


## 经济护栏

HARD LIMITS. Enforce by hand — none of these exist as code gates today.

1. ONE directive at a time. JSON.stringify(Memory.conquest) must show an array of length 1. Two directives means 2 x dPer 1,800e slots hung on every sponsor at once.

2. sponsors is ALWAYS an explicit array, NEVER 'all'. minCapacity is now 800, so 'all' pulls in storage-less W31S8 (850 cap) and W31S6 (800 cap) — they bypass storageFloor entirely (storageOk is true when a room has no storage), emit 750e/1,000-hit dismantlers that die on the march, and inflate the squad quorum so the whole wave waits for them.

3. Per-sponsor storage floor at fire time: >= 6,000 for the W38S5 wave (8,400e total, 2,400-3,600e per sponsor), >= 9,000 for the W38S4 wave (16,200e, 3,600-5,400e per sponsor). Never let a single wave exceed ~40% of the sponsor's storage.

4. CIRCUIT BREAKERS — trip any one and delete the directive immediately: account-wide storage total below 20,000 (currently 36,739); any single sponsor's storage below 3,000; any sponsor's reserver headcount reaching 0 (the exact W32S4 signature — check Memory.rooms[<home>].remotes[*].reservation and the live reserver count); any remote suspended for lack of a miner or hauler for more than 200 ticks.

5. Spawn-time budget. W33S7's spawn is already near 100% occupied maintaining ~115 economy creeps. Conquest sits at class 2, ahead of expansion, remoteMaintain, development, aid and remote — it does not use spare capacity, it EVICTS economy spawning. Three 1,800e bodies from W33S7 is ~216 ticks of spawn time plus ~270 ticks of energy accumulation. Cap any single wave at 3 bodies per sponsor and abort if a sponsor's harvester or hauler count drops below its config.roster floor.

6. CPU. Kill generatePixel for the duration (Memory.pixelRetry = Game.time + 100000). Launch only with bucket >= 5,000 and mean CPU <= 120 against the 140 limit (current mean 98.5, peak 165). If mean CPU exceeds 135 for 30 consecutive samples, abort — taskBroker's cpuReserve will start skipping economy creeps and the collapse compounds.

7. Do not touch W33S7's upgrade pipeline. It is at 662,841/1,215,000 toward RCL6, and RCL6 is the gate for terminal + labs, which is the only thing that ever unlocks W39S7. Every energy diverted from that is a direct trade against the Celr answer.

8. No aid/courier disruption. aid.js and the courier flow to the weak rooms sit at class 6, below conquest, and will be starved for the duration of a wave. Accept that for ~900 ticks; if a wave stretches past ~2,000 ticks, it has failed — abort.


## 中止条件

IN-GAME AUTOMATIC (the only one that exists): the target activates safe mode. siegeDismantler.js:106-112 and siegeGuard.js clear launched/pushed/enteredAt and retreat to the staging room. This is correct behaviour, but it is NOT an abort — the creeps then loiter at staging for up to 1,500 ticks. YOU MUST manually set Memory.conquest = [] the same tick, so the survivors fall through to retire.retireAtSpawn and recycle instead of dying of old age.

MANUAL ABORTS — check these on a ~30-tick cadence; there is no in-game control loop (retro D4 open) and external monitoring at 24-55 tick granularity is far coarser than the ~2-tick creep-death timescale:

1. NO PROGRESS: the wave is inside the target room, 20 ticks have elapsed, and the armed tower's hits have not fallen. Combined with >= 50% losses, that means the repair is out-pacing us or the entry lane failed. Abort.

2. MUSTER DEADLOCK: creeps present at staging has not reached squad within 300 ticks of the first arrival. With B-3 unfixed this is permanent. Either force it (set memory.launched = true on every member via console) or delete the directive and recycle.

3. ECONOMY: any circuit breaker in economyGuardrails trips — account storage below 20,000, a sponsor below 3,000, or any sponsor's reserver count reaching 0.

4. CPU: mean CPU above 135 for 30 consecutive samples, or bucket below 2,000.

5. TRANSIT ATTRITION: more than 2 creeps lost in the SK rooms before reaching staging. That means the corridor is not passable with our pathing; abort, and build lair avoidance before trying again.

6. THIRD PARTY: any armed creep belonging to Alepoldar, Jumpp, _oleksii or Ctharo appears in the corridor (W35S6, W36S6, W37S6, W36S7, W37S7) or in one of our sponsor rooms. We have no answer — defense.js engages NPCs only.

7. TARGET HARDENS: W38S4 builds a second tower (RCL5 permits 2 and they have not), or either target places ramparts. Re-run the recon and re-size before committing; do not launch into changed intel.

8. LOSSES: more than 8 of 12 dismantlers dead at W38S4 before the tower falls. That is worse than the modelled 4-7 and means an assumption broke. Retreat to W38S5 and stop.

CALL THE WHOLE CAMPAIGN OFF IF: G01 activates safe mode at W38S5 (four more charges wait at W38S4 — 80,000 ticks of immunity is not a fight we can win, and the correct response is to spend the cycle on RCL6 and boosts); or storage cannot sustain the second wave within ~5,000 ticks of the first; or the private-server run cannot reproduce a clean breach of the W38S5 geometry.


## 开火清单


1. 1. git status --short is clean and the concurrent session's siege work is merged and agreed. Confirm grep -n 'entryLaneWidth' src/config.js shows 10, not 0.

2. 2. node test/smoke.js, node test/conquest_test.js, python3 -m unittest discover -s test -p '*_test.py' all green; for f in src/*.js src/roles/*.js; do node --check "$f"; done clean.

3. 3. node scripts/private_server/run_validation.js passes with the new effect assertion, and shows no regression against data/validation/baseline.json.

4. 4. Corridor probe survived: probe1 reached W38S6 alive. If it died in W35S6 or W36S6, STOP and build lair avoidance first.

5. 5. Storage check immediately before firing — bash scripts/api.sh GET '/api/game/room-objects?room=W33S7&shard=shard1' etc. for each pinned sponsor — every one at or above the effective floor (6,000 for W38S5, 9,000 for W38S4). Today they read 9,468 / 12,665 / 8,903 / 5,703.

6. 6. Target re-check immediately before firing (they move fast — the W38S4 tower went 540 -> 801 -> 930 across three pulls): bash scripts/api.sh GET '/api/game/room-objects?room=W38S5&shard=shard1' — confirm still 0 towers, 0 ramparts, 0 construction sites, spawn still at (7,40); and for W38S4 confirm still 1 tower, 0 ramparts, no second tower, and note safeModeAvailable / safeModeCooldown / upgradeBlocked.

7. 7. CPU gate: Memory.pixelRetry set into the future, Game.cpu.bucket >= 5000, Memory.stats mean CPU <= 120.

8. 8. Deploy: re-confirm activeWorld with bash scripts/api.sh GET /api/user/branches, then npx grunt, then wait for 'New code uploaded' in console.

9. 9. Write EXACTLY ONE directive (the W38S5 one). Verify with JSON.stringify(Memory.conquest) that the array length is 1 and sponsors is an explicit array, never 'all'.

10. 10. Watch Memory.rooms[<sponsor>].spawnQueue and the per-room reserver counts every ~30 ticks for the first 300 ticks. If any sponsor's reserver count trends to 0, abort immediately — that is the exact W32S4 failure signature.

11. 11. When runOne flips phase to 'downgrade', delete the directive the same tick: Memory.conquest = []. Do not leave it running — downgraders:0 is coerced to 1 and the creep cannot reach the room.

12. 12. Log the result in logs/optimizations.md and update docs/analysis/2026-09-06-conquest-retro.md with the measured loss count before touching W38S4.


## 需要你拍板的问题


- GCL SLOTS. We have exactly 2 left (GCL 12, 10 rooms owned). My recommendation is to spend both on the free 2-source neutrals W36S7 and W37S7 (2-3 hops from W35S7, defensible, no owner to fight) and to run the entire W38 column as DENY with no claims at all. The alternative reading is that W38S4 — RCL5, 30 extensions, 2 sources — is worth more than a free claim and should get a slot. But we cannot garrison it (defense.js engages NPCs only, retro D1 unimplemented) and W32S4 is already an ungarrisoned RCL2 with safeModeAvailable 0. Which way?

- STORAGE FLOOR. Wait several hours to a day for all four sponsors to bank past 15,000, or land the ~3-line per-directive d.storageFloor override so the 8,400e W38S5 wave can fire against a 6,000 floor? The global 15,000 was calibrated for a 28-creep 28,600e wave and is wildly conservative for a 6-creep one, but changing it is a game-code change and needs the full private-server gate.

- SK TRANSIT. Every route to the theatre crosses W35S6 and W36S6 (4 lairs each) — I verified W35S7 has zero open tiles on its west and south edges, so there is no shortcut around the ring. The SK-free southern detour is 9-10 hops through Alepoldar's towered W36S8. Do we (a) accept SK transit and budget 1-2 creeps per wave to keeper fire, (b) invest first in a lair-avoiding costCallback for movement.go, or (c) take the southern detour and accept 650-900 tick marches?

- DOWNGRADE TAILS. Do you want them at all? They need a code fix (downgrader/claimer/pioneer must accept an avoid override, or they cannot outrun the 600-tick CLAIM lifetime on the current 650-900 tick default route). The only tail worth having is W38S5's 35,000-tick L3->0, which would permanently zero G01's two safe-mode charges there. W38S4's is impossible through a single 600-dmg/tick access tile. My recommendation is deny-only, no tails.

- IS THIS THEATRE WORTH IT AT ALL? G01 borders none of our rooms and contests none of our sources. Denying W38S5 + W38S4 costs ~25,000e of bodies plus 4-7 dead creeps and buys no territory, no energy and no GCL. The same energy plus the same attention put into W33S7's remaining 552,159 control points to RCL6 gets us terminal + labs, which is the only thing that ever unlocks W39S7 and every future fortified target. Is the W38 column a strategic objective, or is it a live-fire proving ground for the siege stack that happens to also slow a neighbour?

- SAFE-MODE BET. W38S4 comes down to a bet that G01's bot has no safe-mode reflex. Evidence for: safeModeAvailable equals level-1 in all three of their rooms, i.e. exactly the free per-level grant with none ever spent, and their bot shows no defensive branch of any kind. Evidence against: they are GCL 15, i.e. a veteran mid-respawn whose code will improve. If the bet loses we eat 80,000 ticks of immunity and lose the wave. Do you want to take it after W38S5 answers, or only after we have boosts and the bet no longer matters?

