"use strict"

/**
 *    require('超级移动优化').print()
 */

let { preTickBetterMove, endTickResolve, squadMoveTo } = require('超级移动优化');

const roleHarvester = {

    /** @param {Creep} creep **/
    run: function (creep) {
        if (creep.store.getFreeCapacity() > 0) {
            var sources = creep.room.find(FIND_SOURCES).sort((a, b) => a.pos.x - b.pos.x);
            const sourceIdx = 0;
            if (creep.harvest(sources[sourceIdx]) == ERR_NOT_IN_RANGE) {
                creep.moveTo(sources[sourceIdx]);
            }
        }
        else if (Game.spawns['Spawn1'].energy < Game.spawns['Spawn1'].energyCapacity) {
            if (creep.transfer(Game.spawns['Spawn1'], RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
                creep.moveTo(Game.spawns['Spawn1']);
            }
        }
    }
};

function isHarWorkTile(creep, pos) {
    if (creep.store.getFreeCapacity() > 0) {
        const sourceIdx = 0;
        const source = creep.room.find(FIND_SOURCES).sort((a, b) => a.pos.x - b.pos.x)[sourceIdx];
        return source.pos.getRangeTo(pos) <= 1;
    } else {
        return true;
    }
}

const roleUpgrader = {

    /** @param {Creep} creep **/
    run: function (creep) {
        if (creep.memory.stage === undefined) creep.memory.stage = 0;
        if (creep.memory.stage == 0) {
            if (creep.store[RESOURCE_ENERGY] < 50) {
                const sourceIdx = 1;
                var sources = creep.room.find(FIND_SOURCES).sort((a, b) => a.pos.x - b.pos.x);
                if (creep.harvest(sources[sourceIdx]) == ERR_NOT_IN_RANGE) {
                    creep.moveTo(sources[sourceIdx]);
                }
            } else {
                creep.memory.stage = 1;
            }
        } else {
            if (creep.upgradeController(creep.room.controller) == ERR_NOT_IN_RANGE) {
                creep.moveTo(creep.room.controller);
            }
            if (creep.store[RESOURCE_ENERGY] == 0) creep.memory.stage = 0;
        }
    }
};

function isUpWorkTile(creep, pos) {
    if (creep.memory.stage == 0) {
        const sourceIdx = 1;
        const source = creep.room.find(FIND_SOURCES).sort((a, b) => a.pos.x - b.pos.x)[sourceIdx];
        return source.pos.getRangeTo(pos) <= 1;
    } else {
        return creep.room.controller.pos.getRangeTo(pos) <= 3;
    }
}

function isWorkTile(creep, pos) {
    if (creep.name[0] === 'u') {
        return isUpWorkTile(creep, pos);
    } else {
        return isHarWorkTile(creep, pos);
    }
}

let squad1State = 0, squad2State = 0;
const roleSquad = {
    run: function (squad, idx) {
        let target;
        if (idx == 0) {
            switch (squad1State) {
                case 0:
                    target = Game.flags["Flag3"];
                    break;
                case 1:
                    target = Game.flags["Flag2"];
                    break;
                case 2:
                    target = Game.flags["Flag1"];
                    break;
                default:
                    break;
            }
        } else {
            switch (squad2State) {
                case 0:
                    target = Game.flags["Flag1"];
                    break;
                case 1:
                    target = Game.flags["Flag2"];
                    break;
                case 2:
                    target = Game.flags["Flag3"];
                    break;
                default:
                    break;
            }
        }
        const ret = squadMoveTo(squad, target, { visualizePathStyle: {} });
        if (ret === ERR_NOT_IN_RANGE) {
            squad[0].moveTo(target);
            squad[1].moveTo(new RoomPosition(target.pos.x - 1, target.pos.y, target.pos.roomName));
            squad[2].moveTo(new RoomPosition(target.pos.x, target.pos.y - 1, target.pos.roomName));
            squad[3].moveTo(new RoomPosition(target.pos.x - 1, target.pos.y - 1, target.pos.roomName));
        } else if (ret === OK && target.pos.getRangeTo(squad[0].pos) <= 1) {
            if (idx == 0) {
                squad1State += 1;
                if (squad1State == 3) {
                    squad1State = 0;
                }
            } else {
                squad2State += 1;
                if (squad2State == 3) {
                    squad2State = 0;
                }
            }
        }
    }
}


module.exports.loop = function () {
    preTickBetterMove();
    
    let hcount = 0;
    for (var name in Memory.creeps) {
        if (!Game.creeps[name]) {
            delete Memory.creeps[name];
        } else if (name[0] == 'h') {
            hcount++;
        }
    }

    const lackSquadMembers = [];
    if (!("a1" in Game.creeps)) lackSquadMembers.push("a1");
    if (!("b1" in Game.creeps)) lackSquadMembers.push("b1");
    if (!("c1" in Game.creeps)) lackSquadMembers.push("c1");
    if (!("d1" in Game.creeps)) lackSquadMembers.push("d1");
    // if (!("a2" in Game.creeps)) lackSquadMembers.push("a2");
    // if (!("b2" in Game.creeps)) lackSquadMembers.push("b2");
    // if (!("c2" in Game.creeps)) lackSquadMembers.push("c2");
    // if (!("d2" in Game.creeps)) lackSquadMembers.push("d2");

    if (!Game.spawns['Spawn1'].spawning) {
        const numCreeps = Object.keys(Game.creeps).length;
        if (lackSquadMembers.length > 0) {
            Game.spawns['Spawn1'].spawnCreep([MOVE], lackSquadMembers[0]);
        } else if (hcount > 1) {
            var newName = 'upgrader' + Game.time;
            Game.spawns['Spawn1'].spawnCreep([WORK, CARRY, MOVE, MOVE], newName);
        } else {
            var newName = 'havester' + Game.time;
            Game.spawns['Spawn1'].spawnCreep([WORK, CARRY, WORK, MOVE], newName);
        }
    }

    if (lackSquadMembers.length === 0) {
        Game.creeps["a1"].say('a1');
        Game.creeps["b1"].say('b1');
        Game.creeps["c1"].say('c1');
        Game.creeps["d1"].say('d1');
        roleSquad.run([Game.creeps["a1"], Game.creeps["b1"], Game.creeps["c1"], Game.creeps["d1"]], 0);
        // roleSquad.run([Game.creeps["a2"], Game.creeps["b2"], Game.creeps["c2"], Game.creeps["d2"]], 1);
    }

    for (var name in Game.creeps) {
        var creep = Game.creeps[name];
        if (name[0] === 'u') {
            roleUpgrader.run(creep);
        } else if (name[0] === 'h') {
            roleHarvester.run(creep);
        }
    }
    // Game.cpu.generatePixel();

    endTickResolve(isWorkTile);
}
