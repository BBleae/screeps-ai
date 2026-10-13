# Wheel Integration Notes

Date: 2026-09-01

## Status

The two wheel archives are now fully integrated as project code.
The bot runtime in this checkout loads the extracted modules through the project wrappers, and the main loop uses them directly:

- [`src/main.js`](../src/main.js) calls `movement.beginTick()`, `wheelLayout.autoPlannerByFlag()`, and `movement.endTick()` every tick.
- [`src/movement.js`](../src/movement.js) is the runtime wrapper around `wheel_movement_engine`.
- [`src/wheel_layout.js`](../src/wheel_layout.js) is the runtime wrapper around `wheel_layout_planner`.
- [`Gruntfile.js`](../Gruntfile.js) copies the wheel sources into `dist/` under their runtime module names.

## Archive Fingerprints

| Archive | SHA-256 |
| --- | --- |
| `轮子/自动建筑布局2.1.0.zip` | `f84ead992c31cb489546605118830f7ef0ed106d0afe5be1e2d834f15324cd8f` |
| `轮子/超级移动优化1.0.3.zip` | `d3af67bafce846d3768c282d863e2d02915e0fe061d47ab9d24952c6bd9e4eaa` |

## Runtime Wiring

| Build artifact | Runtime name | Used by |
| --- | --- | --- |
| `dist/MinCut.js` | `MinCut` | `wheel_layout_planner` |
| `dist/RoomVisual.js` | `RoomVisual` | `wheel_layout_planner` and its visual helpers |
| `dist/wheel_layout_planner.js` | `wheel_layout_planner` | `src/wheel_layout.js` |
| `dist/moveMatch.js` | `moveMatch` | `wheel_movement_engine` |
| `dist/wheel_movement_engine.js` | `wheel_movement_engine` | `src/movement.js` |

## Layout Integration

The wheel layout package is not just archived reference material. Its runtime entrypoints are wired into the bot through [`src/wheel_layout.js`](../src/wheel_layout.js):

- `plan(room, showPlan)` remains the raw planner entrypoint.
- `runPlan(room)` clears the cache and repopulates it.
- `visualizePlan(roomName)` renders a cached plan.
- `savePlanToMemory(roomName)` writes the cached plan into `Memory.roomPlanner`.
- `listPlanCache()` and `clearRoomPlanCache(roomName)` manage the cache.

The wrapper adds project-facing entrypoints and globals:

- `wheelLayout.plan`
- `wheelLayout.runPlan`
- `wheelLayout.visualize`
- `wheelLayout.list`
- `wheelLayout.clear`
- `wheelLayout.save`
- `wheelLayout.normalize`
- `wheelLayout.validateExisting`
- `wheelLayout.adopt`
- `wheelLayout.autoPlannerByFlag`
- `global.WheelLayout`
- `global.autoPlannerByFlag`

Flag flow is active in the main loop:

- `RP` runs a new plan and refreshes the cache.
- `VP` visualizes the cached plan.
- `SP` saves the cached plan and then tries to adopt it into `Memory.rooms[roomName].plan`.

The layout runtime also uses the upstream visual and cut helpers:

- `wheel_layout_planner` imports `MinCut` for scoring, perimeter, and tower placement.
- `wheel_layout_planner` imports `RoomVisual` and extends `RoomVisual.prototype`.
- The extended methods are `structure`, `connectRoads`, `speech`, `animatedPosition`, `test`, `resource`, `_fluid`, `_mineral`, and `_compound`.

## Movement Integration

The movement package is also active runtime code, not a passive reference.

The wrapper in [`src/movement.js`](../src/movement.js):

- lazily loads `wheel_movement_engine` once the Screeps constructors are ready;
- falls back to native `moveTo` if the engine cannot be loaded;
- exposes `go`, `beginTick`, `endTick`, `isWorkTile`, `invalidateRoom`, and `stats`;
- forwards the engine exports that the bot uses for traffic resolution and path cache control.

The main loop calls `movement.beginTick()` at the start of each tick and `movement.endTick()` at the end of each tick.
Roles and support code call `movement.go()` throughout the bot, so the wheel movement engine is not dormant.

The wheel movement engine patches these prototypes at runtime:

- `Creep.prototype.move`
- `Creep.prototype.moveTo`
- `Creep.prototype.pull`
- `Creep.prototype.cancelOrder`
- `PowerCreep.prototype.move`
- `PowerCreep.prototype.moveTo`
- `PowerCreep.prototype.cancelOrder`
- `RoomPosition.prototype.findSquadPathTo`

The engine exports these callable helpers:

- `squadMove`
- `squadMoveTo`
- `preTickBetterMove`
- `endTickResolve`
- `getSquadCostMatrix`
- `setPathClearDelay`
- `setHostileCostMatrixClearDelay`
- `deleteCostMatrix`
- `deletePath`
- `deletePathInRoom`
- `refreshRoom` — project patch (2026-09-12): `deletePathInRoom` plus an immediate `generateCostMatrix` for a visible room. The upstream engine only schedules matrix expiry for other players' rooms, so our own and remote rooms kept stale matrices and in-room paths for the whole global (new roads unused, vanished roads still preferred). `src/movement.js` calls it when a room's road/obstacle layout signature changes (`refreshRoomNetworks`, at most once per room per 200 ticks).
- `resetCreepPath` — project patch (2026-10-08): drops one creep's cached path (and the shared path it was following, otherwise the in-room cache lookup hands the same stale path back) so its next `moveTo` re-searches. It touches no cost matrix and scans no global path table. `src/movement.js` `resetCreepPath(creep)` wraps it (no-op without the patch, never falling back to `refreshRoom`); the upgrader stuck watchdog uses it instead of `invalidateRoom`, which rebuilt the room's matrix and dropped every path in the room outside the `refreshRoomNetworks` throttle.
- `addAvoidRooms`
- `deleteAvoidRooms`
- `addAvoidExits`
- `deleteAvoidExits`
- `print`
- `clear`

## Adaptation Boundary

The upstream sources are integrated through project wrappers and build output, not by calling the archive zip files directly.

The sample `main.js` inside the movement archive is not used as the runtime entrypoint. The bot instead routes movement through [`src/movement.js`](../src/movement.js) and layout through [`src/wheel_layout.js`](../src/wheel_layout.js).

The two wheel packages are adapted to the current Screeps bot architecture, including the project's memory layout, tick loop, and phase-based room processing.

## Runtime Usage Boundary

Complete integration means every upstream source module, prototype patch, exported helper, and planner workflow is packaged and reachable through the project runtime. It does not mean every optional helper is called unconditionally:

- Normal creep movement and the original end-of-tick traffic resolver are active every tick.
- Path caching, cross-room routing, pull handling, and patched movement prototypes are used whenever matching movement intents occur.
- Squad movement and manual cache/avoidance helpers are callable through `movement`, but the current bot has no squad role that would invoke them continuously.
- The layout planner is deliberately operator-triggered through `RP` / `VP` / `SP`; after a successful `SP` adoption, the normal room loop continuously builds from the wheel plan.

## Conflict Policy

Layout conflicts are handled conservatively.

- `src/wheel_layout.js` validates a plan against the existing room state before adoption.
- If an occupied tile contains a non-shareable existing structure, adoption is rejected.
- `trimSites()` removes stale construction sites, but it only removes sites, not built structures.
- The code does not automatically destroy old buildings and rebuild them in a different position.
- When a conflict exists, the room keeps the old structure until manual cleanup makes the new plan valid.

This means the answer to "will it wait for the right time and then demolish the old building and rebuild in the correct place" is no: conflict handling defaults to rejection, not auto-demolition.
