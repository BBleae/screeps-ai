declare type WheelPoint = { x: number; y: number; };
declare type WheelPointWithRoom = WheelPoint & { roomName?: string; };
declare type WheelRawLayout = Record<string, WheelPoint[]>;

declare interface WheelPlanLinkMap {
  [key: string]: WheelPoint | null | undefined;
  ctrl?: WheelPoint | null;
  src?: WheelPoint | null;
  src0?: WheelPoint | null;
  src1?: WheelPoint | null;
  store?: WheelPoint | null;
}

declare interface WheelNormalizedPlan {
  version: string;
  wheel: true;
  anchor: WheelPoint;
  made: number;
  sourceIds: string[];
  containers: Record<string, WheelPoint | null | undefined>;
  roads: Record<string, string>;
  ext: WheelPoint[];
  towers: WheelPoint[];
  storage: WheelPoint | null;
  terminal: WheelPoint | null;
  spawns: WheelPoint[];
  spawn2: WheelPoint[];
  spawn3: WheelPoint[];
  labs: WheelPoint[];
  links: WheelPlanLinkMap;
  misc: WheelPoint[];
  structures: Record<string, WheelPoint | null | undefined>;
  ramparts: WheelPoint[];
  walls: WheelPoint[];
  workPositions: Record<string, WheelPoint | null | undefined>;
  rawLayout?: WheelRawLayout;
}

declare interface WheelLayoutValidationResult {
  ok: boolean;
  errors: string[];
}

declare interface WheelLayoutAdoptResult extends WheelLayoutValidationResult {
  plan?: WheelNormalizedPlan;
}

declare interface WheelPlanCacheEntry {
  layout: WheelRawLayout;
  timestamp: number;
  roomName: string;
}

declare interface WheelMoveToOpts extends MoveToOpts {
  priority?: number;
  ignoreSwamps?: boolean;
  bypassHostileCreeps?: boolean;
  bypassRange?: number;
  avoidRooms?: Set<string>;
  avoidExits?: Map<string, Set<string>>;
}

declare interface WheelSquadMoveToOpts extends WheelMoveToOpts {
  enableAutoPull?: boolean;
}

declare type WheelSquadMoveTarget = Array<RoomPosition | Creep>;

declare interface WheelMovementEngineAPI {
  squadMove(squad: Creep[], target?: WheelSquadMoveTarget): ScreepsReturnCode;
  squadMoveTo(squad: Creep[], firstArg: RoomPosition | number, secondArg?: number | WheelSquadMoveToOpts, opts?: WheelSquadMoveToOpts): ScreepsReturnCode;
  preTickBetterMove(): void;
  endTickResolve(userIsWorkTile?: (creep: Creep, pos: RoomPosition) => boolean): void;
  getSquadCostMatrix(roomName: string, ignoreDestructibleStructures?: boolean): CostMatrix | undefined;
  setPathClearDelay(number?: number): OK | ERR_INVALID_ARGS;
  setHostileCostMatrixClearDelay(number?: number): OK | ERR_INVALID_ARGS;
  deleteCostMatrix(roomName: string): OK | ERR_INVALID_ARGS;
  deletePath(fromPos: RoomPosition, toPos: RoomPosition, opts?: { range?: number; [key: string]: any }): OK | ERR_INVALID_ARGS;
  deletePathInRoom(roomName: string): OK | ERR_INVALID_ARGS;
  addAvoidRooms(roomName: string): OK | ERR_INVALID_ARGS;
  deleteAvoidRooms(roomName: string): OK | ERR_INVALID_ARGS;
  addAvoidExits(fromRoomName: string, toRoomName: string): OK | ERR_INVALID_ARGS;
  deleteAvoidExits(fromRoomName: string, toRoomName: string): OK | ERR_INVALID_ARGS;
  print(): string;
  clear(): OK;
}

declare interface WheelLayoutPlannerAPI {
  plan(room: Room | string, showPlan?: boolean): WheelRawLayout | false;
  runPlan(room: Room | string): boolean;
  visualizePlan(roomName: string): boolean;
  listPlanCache(): void;
  clearRoomPlanCache(roomName: string): void;
  savePlanToMemory(roomName: string): boolean;
}

declare interface WheelLayoutAPI extends WheelLayoutPlannerAPI {
  VERSION: string;
  ensureColours(): Record<string, string>;
  visualize(roomName: string): boolean;
  list(): void;
  clear(roomName: string): void;
  save(roomName: string): boolean;
  normalize(room: Room, raw: WheelRawLayout): WheelNormalizedPlan;
  validateExisting(room: Room, planValue: WheelNormalizedPlan): WheelLayoutValidationResult;
  adopt(roomName: string): WheelLayoutAdoptResult;
  autoPlannerByFlag(): void;
  visualizePlan: WheelLayoutPlannerAPI['visualizePlan'];
  listPlanCache: WheelLayoutPlannerAPI['listPlanCache'];
  clearRoomPlanCache: WheelLayoutPlannerAPI['clearRoomPlanCache'];
  savePlanToMemory: WheelLayoutPlannerAPI['savePlanToMemory'];
}

declare interface WheelRoomVisualStructureOpts {
  opacity?: number;
  isCore?: boolean;
  [key: string]: any;
}

declare module 'RoomVisual' {
  const sideEffectModule: any;
  export = sideEffectModule;
}

declare module 'MinCut' {
  const api: {
    minCut: (...args: any[]) => any;
    getTowerCandidatePoses: (...args: any[]) => any;
    getVisitedAndDist: (...args: any[]) => any;
  };
  export = api;
}

declare module 'wheel_movement_engine' {
  const api: WheelMovementEngineAPI;
  export = api;
}

declare module 'movement' {
  const api: WheelMovementEngineAPI & {
    go(creep: Creep | PowerCreep, target: RoomPosition | RoomObject | { pos: RoomPosition } | null | undefined, opts?: WheelMoveToOpts): ScreepsReturnCode;
    beginTick(): void;
    endTick(userIsWorkTile?: (creep: Creep, pos: RoomPosition) => boolean): void;
    preTickBetterMove(): void;
    endTickResolve(userIsWorkTile?: (creep: Creep, pos: RoomPosition) => boolean): void;
    isWorkTile(creep: Creep, pos: RoomPosition): boolean;
    invalidateRoom(roomName: string): ScreepsReturnCode | undefined;
    stats(): {
      calls: number;
      engineCalls: number;
      nativeCalls: number;
      inRange: number;
      invalidTargets: number;
      invalidations: number;
      beginTicks: number;
      endTicks: number;
      engineLoadErrors: number;
      workTileErrors: number;
      engineAvailable: boolean;
      lastEngineError: string | null;
    };
  };
  export = api;
}

declare module 'wheel_layout_planner' {
  const api: WheelLayoutPlannerAPI;
  export = api;
}

declare module 'wheel_layout' {
  const api: WheelLayoutAPI;
  export = api;
}

declare interface MoveToOpts {
  priority?: number;
  ignoreSwamps?: boolean;
  bypassHostileCreeps?: boolean;
  bypassRange?: number;
  avoidRooms?: Set<string>;
  avoidExits?: Map<string, Set<string>>;
}

declare interface RoomVisual {
  structure(x: number, y: number, type: StructureConstant | string, opts?: WheelRoomVisualStructureOpts): RoomVisual;
  connectRoads(opts?: { color?: string; opacity?: number }): RoomVisual | undefined;
  speech(text: string, x: number, y: number, opts?: {
    background?: string;
    textcolor?: string;
    textstyle?: string;
    textsize?: number;
    textfont?: string;
    opacity?: number;
  }): RoomVisual;
  animatedPosition(x: number, y: number, opts?: {
    color?: string;
    opacity?: number;
    radius?: number;
    frames?: number;
  }): RoomVisual;
  test(): RoomVisual;
  resource(type: ResourceConstant, x: number, y: number, size?: number): ScreepsReturnCode;
  _fluid(type: ResourceConstant, x: number, y: number, size?: number): void;
  _mineral(type: ResourceConstant, x: number, y: number, size?: number): void;
  _compound(type: ResourceConstant, x: number, y: number, size?: number): void;
}

declare interface RoomPosition {
  findSquadPathTo(toPos: RoomPosition | RoomObject, opts?: PathFinderOpts): PathFinderResult | ERR_NO_PATH | ERR_INVALID_TARGET;
}

declare var colours: Record<string, string> | undefined;
declare var roomPlanCache: Record<string, WheelPlanCacheEntry> | undefined;
declare var RP: (room: Room | string, showPlan?: boolean) => WheelRawLayout | false;
declare var runPlan: (room: Room | string) => boolean;
declare var visualizePlan: (roomName: string) => boolean;
declare var listPlanCache: () => void;
declare var clearRoomPlanCache: (roomName: string) => void;
declare var savePlanToMemory: (roomName: string) => boolean;
declare var autoPlannerByFlag: () => void;
declare var WheelLayout: WheelLayoutAPI;
