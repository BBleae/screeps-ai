"""Owned-room mineral policy and routing. No in-game planner or offline fallback.

The miner carries its own output; energy haulers remain dedicated to energy.
All route searches and body enumeration run here, outside the shard CPU budget.
"""
import heapq
import math

DIRECTIONS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1))
WALKABLE = {'road', 'container', 'extractor', 'creep', 'powerCreep', 'energy', 'tombstone', 'ruin'}
DEFAULTS = {'minEnergy': 10000, 'maxStock': 50000, 'reserveFree': 5000, 'maxBodyCost': 3000}


def xy(obj):
    return obj['x'], obj['y']


def adjacent(point):
    for dx, dy in DIRECTIONS:
        x, y = point[0] + dx, point[1] + dy
        if 1 <= x <= 48 and 1 <= y <= 48:
            yield x, y


def field(goals, costs):
    """Reverse Dijkstra: distance includes the cost of entering the next tile."""
    distances = {p: 0 for p in goals if p in costs}
    queue = [(0, p) for p in distances]
    heapq.heapify(queue)
    steps = {}
    while queue:
        distance, point = heapq.heappop(queue)
        if distance != distances[point]:
            continue
        for other in adjacent(point):
            if other not in costs:
                continue
            candidate = distance + costs[point]
            if candidate < distances.get(other, math.inf):
                distances[other] = candidate
                steps[other] = point
                heapq.heappush(queue, (candidate, other))
    return distances, steps


def route_map(starts, steps):
    """Sparse shared direction table, O(1) lookup by x + 50*y on the shard."""
    result = {}
    for start in starts:
        point = start
        while point in steps and str(point[0] + point[1] * 50) not in result:
            nxt = steps[point]
            result[str(point[0] + point[1] * 50)] = DIRECTIONS.index((nxt[0] - point[0], nxt[1] - point[1])) + 1
            point = nxt
    return result


def body_for(capacity, distance):
    """Maximise delivered units/tick, including round trips; MOVE supports plains.

Extractor intents set cooldown=5 after the harvesting tick, hence six ticks
between harvests in the engine. Live execution always tests actual cooldown.
"""
    best = (0, 0, [])
    for work in range(1, 25):
        for carry in range(1, 25):
            move = math.ceil((work + carry) / 2)
            cost = work * 100 + (carry + move) * 50
            if cost > capacity or work + carry + move > 50:
                continue
            load = carry * 50
            rate = load / (math.ceil(load / work) * 6 + 2 * distance * 2)
            key = (rate, -cost)
            if key > best[:2]:
                best = (*key, ['work'] * work + ['carry'] * carry + ['move'] * move)
    return best[2]


def plan(objects, terrain, user_id, tick, capacity, creep_memory=None, settings=None):
    cfg = dict(DEFAULTS, **(settings or {}))
    result = {'version': 1, 'at': tick, 'enabled': False, 'build': False, 'count': 0,
              'reason': 'rcl', 'maxStock': cfg['maxStock'], 'reserveFree': cfg['reserveFree']}
    own = lambda o: str(o.get('user')) == str(user_id)
    controller = next((o for o in objects if o.get('type') == 'controller'), {})
    level = int(controller.get('level') or 0)
    if not own(controller) or level < 4:
        return result
    mineral = next((o for o in objects if o.get('type') == 'mineral'), None)
    if not mineral or not terrain or len(terrain) != 2500:
        result['reason'] = 'missing-mineral-or-terrain'
        return result
    result.update(mineralId=mineral['_id'], mineralType=mineral['mineralType'],
                  pos={'x': mineral['x'], 'y': mineral['y']},
                  regenerationAt=mineral.get('nextRegenerationTime'))
    costs = {(x, y): (10 if int(terrain[y * 50 + x]) & 2 else 2)
             for y in range(1, 49) for x in range(1, 49) if not int(terrain[y * 50 + x]) & 1}
    for obj in objects:
        if obj.get('type') == 'road' and xy(obj) in costs:
            costs[xy(obj)] = 1
    for obj in objects:
        kind = obj.get('type')
        if kind == 'constructionSite':
            if obj.get('structureType') not in WALKABLE | {'rampart'}:
                costs.pop(xy(obj), None)
        elif kind == 'rampart':
            if not own(obj) and not obj.get('isPublic'):
                costs.pop(xy(obj), None)
        elif kind not in WALKABLE:
            costs.pop(xy(obj), None)
    sinks = [o for kind in ('terminal', 'storage') for o in objects if o.get('type') == kind and own(o)]
    spawns = [o for o in objects if o.get('type') == 'spawn' and own(o)]
    starts = {p for spawn in spawns for p in adjacent(xy(spawn)) if p in costs}
    for obj in objects:
        if obj.get('type') == 'creep' and own(obj):
            memory = (creep_memory or {}).get(obj.get('name'), {})
            if memory.get('role') == 'mineralMiner':
                starts.add(xy(obj))
                blocked = memory.get('mineralBlocked')
                if isinstance(blocked, dict) and 'x' in blocked and 'y' in blocked:
                    costs.pop(xy(blocked), None)
    # Keep IDs even when a sink is full, so existing cargo can be delivered after
    # consumers free space. New harvesting reserves space for the energy economy.
    sink_fields = [(o, field(adjacent(xy(o)), costs)) for o in sinks]
    candidates = [p for p in adjacent(xy(mineral)) if p in costs]
    reachable = [(i, distances.get(p, math.inf), p) for i, (_, (distances, _)) in enumerate(sink_fields)
                 for p in candidates if p in distances]
    if not reachable or not starts:
        result['reason'] = 'unreachable'
        return result
    _, distance, spot = min(reachable)
    outbound_distance, outbound_steps = field([spot], costs)
    if not any(p in outbound_distance for p in starts):
        result['reason'] = 'unreachable-spawn'
        return result
    result['stand'] = {'x': spot[0], 'y': spot[1]}
    result['outbound'] = route_map(starts | {p for o in sinks for p in adjacent(xy(o))}, outbound_steps)
    result['sinks'] = [{'id': o['_id'], 'path': route_map(starts | {spot} | {p for sink in sinks for p in adjacent(xy(sink))}, steps)}
                       for o, (distances, steps) in sink_fields if spot in distances]
    reachable_ids = {s['id'] for s in result['sinks']}
    sinks = [o for o in sinks if o['_id'] in reachable_ids]
    # Conservative lifetime margin: weighted distance plus a congestion allowance.
    result['returnTicks'] = max(20, int(distance * 2 + 20))
    result['body'] = body_for(min(capacity, cfg['maxBodyCost']), distance / 2)
    if spawns:
        spawn = min(spawns, key=lambda o: max(abs(o['x'] - spot[0]), abs(o['y'] - spot[1])))
        _, recycle_steps = field(adjacent(xy(spawn)), costs)
        result['recycle'] = {'id': spawn['_id'], 'path': route_map(starts | {spot} |
                            {p for o in sinks for p in adjacent(xy(o))}, recycle_steps)}
    result['build'] = bool(level >= 6 and sinks and result['body'])
    extractor = next((o for o in objects if o.get('type') == 'extractor' and own(o) and xy(o) == xy(mineral)), None)
    result['extractorId'] = extractor['_id'] if extractor else None
    stock = sum((o.get('store') or {}).get(mineral['mineralType'], 0) for o in sinks)
    energy = sum((o.get('store') or {}).get('energy', 0) for o in sinks)
    def free(o):
        total = o.get('storeCapacity')
        if not isinstance(total, (int, float)):
            total = 300000 if o['type'] == 'terminal' else 1000000
        return total - sum((o.get('store') or {}).values())
    reason = ('rcl' if level < 6 else 'extractor' if not extractor else 'depleted' if not mineral.get('mineralAmount') else
              'stock' if stock >= cfg['maxStock'] else 'energy' if energy < cfg['minEnergy'] else
              'full' if not any(free(o) > cfg['reserveFree'] + 1250 for o in sinks) else
              'body' if not result['body'] else 'harvest')
    result.update(reason=reason, enabled=reason == 'harvest', count=int(reason == 'harvest'))
    return result
