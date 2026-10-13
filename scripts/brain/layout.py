"""布局相关的外部计算。spawn 选址/蓝图已由游戏内的轮子规划接管（wheel_layout.generate），这里只保留地形工具。"""

WALL = 1
INTERIOR = range(4, 46)


def is_wall(terrain, x, y):
    if x < 0 or x > 49 or y < 0 or y > 49:
        return True
    return int(terrain[y * 50 + x]) & WALL == WALL


def wall_clearance(terrain, x, y, cap=8):
    """到最近墙（含房间边界）的 Chebyshev 距离，最大 cap。"""
    if is_wall(terrain, x, y):
        return 0
    for radius in range(1, cap + 1):
        for dx in range(-radius, radius + 1):
            for dy in (-radius, radius):
                if is_wall(terrain, x + dx, y + dy):
                    return radius
        for dy in range(-radius + 1, radius):
            for dx in (-radius, radius):
                if is_wall(terrain, x + dx, y + dy):
                    return radius
    return cap


def choose_spawn_pos(terrain, objects, min_clearance=3, keep_away=2):
    """选一个离墙 ≥ min_clearance、避开 source/controller/mineral 与残留建筑、离资源重心近的格子。"""
    objects = objects or []
    anchors = [(o['x'], o['y']) for o in objects if o.get('type') in ('source', 'controller')]
    avoid = [(o['x'], o['y']) for o in objects if o.get('type') in ('source', 'controller', 'mineral', 'keeperLair')]
    blocked = {(o['x'], o['y']) for o in objects
               if o.get('type') not in ('creep', 'energy', 'tombstone', 'ruin', 'source', 'controller', 'mineral')}
    best = None
    for y in INTERIOR:
        for x in INTERIOR:
            if (x, y) in blocked or is_wall(terrain, x, y):
                continue
            if any(max(abs(ax - x), abs(ay - y)) <= keep_away for ax, ay in avoid):
                continue
            clearance = wall_clearance(terrain, x, y, cap=min_clearance + 3)
            if clearance < min_clearance:
                continue
            travel = sum(max(abs(ax - x), abs(ay - y)) for ax, ay in anchors)
            score = travel - 1.5 * clearance
            key = (score, y, x)
            if best is None or key < best[0]:
                best = (key, {'x': x, 'y': y})
    return best[1] if best else None
