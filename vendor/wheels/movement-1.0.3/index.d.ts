// 此文件是 AI 写的，仅供参考

type SquadMoveTarget = Array<RoomPosition | Creep>;

interface MoveToExtendedOpts extends MoveToOpts {
    priority?: number;
    ignoreSwamps?: boolean;
    bypassHostileCreeps?: boolean;
    bypassRange?: number;
    avoidRooms?: Set<string>;
    avoidExits?: Map<string, Set<string>>;
}

interface SquadMoveToOpts extends MoveToOpts {
    enableAutoPull?: boolean;
}

interface EndTickResolveOpts {
    isWorkTile?: (creep: Creep, pos: RoomPosition) => boolean;
}

declare module '超级移动优化' {
    function getSquadCostMatrix(roomName: string, ignoreDestructibleStructures?: boolean): CostMatrix | undefined;
    function squadMove(squad: Creep[], target?: SquadMoveTarget): ScreepsReturnCode;
    function squadMoveTo(squad: Creep[], firstArg: RoomPosition | number, secondArg?: number | SquadMoveToOpts, opts?: SquadMoveToOpts): ScreepsReturnCode;
    function preTickBetterMove(): void;
    function endTickResolve(userIsWorkTile?: (creep: Creep, pos: RoomPosition) => boolean): void;
    function setPathClearDelay(number?: number): OK | ERR_INVALID_ARGS;
    function setHostileCostMatrixClearDelay(number?: number): OK | ERR_INVALID_ARGS;
    function deleteCostMatrix(roomName: string): OK | ERR_INVALID_ARGS;
    function deletePathInRoom(roomName: string): OK | ERR_INVALID_ARGS;
    function addAvoidRooms(roomName: string): OK | ERR_INVALID_ARGS;
    function deleteAvoidRooms(roomName: string): OK | ERR_INVALID_ARGS;
    function addAvoidExits(fromRoomName: string, toRoomName: string): OK | ERR_INVALID_ARGS;
    function deleteAvoidExits(fromRoomName: string, toRoomName: string): OK | ERR_INVALID_ARGS;
    function print(): void;
}

interface RoomPosition {
    findSquadPathTo(toPos: RoomPosition | RoomObject, opts?: PathFinderOpts): PathFinderResult | ERR_NO_PATH | ERR_INVALID_TARGET;
}

interface Creep {
    moveTo(firstArg: RoomPosition | number, secondArg?: number | MoveToExtendedOpts, opts?: MoveToExtendedOpts): ScreepsReturnCode;
    moveTo(target: RoomPosition | { pos: RoomPosition }, opts?: MoveToExtendedOpts): ScreepsReturnCode;
}

interface PowerCreep {
    moveTo(firstArg: RoomPosition | number, secondArg?: number | MoveToExtendedOpts, opts?: MoveToExtendedOpts): ScreepsReturnCode;
    moveTo(target: RoomPosition | { pos: RoomPosition }, opts?: MoveToExtendedOpts): ScreepsReturnCode;
}
