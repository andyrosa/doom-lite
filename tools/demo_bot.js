// The demo bot. tools/record_demo.js puts this script into a recording page ahead of the game script. During the
// recording, the game calls window.testBot once for each tic and uses the returned key mask as the input for that tic.
// The bot kills every monster, collects every item, and uses the exit switch. It moves in any direction relative to its
// facing (forward, back, strafe), so it collects items while it aims and fires.
// The waypoints, zones, and obstacles in this file are coordinates of the level in index.html.
(function () {
    'use strict';
    const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16, SHIFT = 32, COMMA = 128, PERIOD = 256, USE = 512;
    const SLOW_TURN = 0.03068, WALK_TURN = 0.06136, RUN_TURN = 0.12272, SLOW_TURN_TICS = 6;
    // Forward 50 plus strafe 40 moves faster than forward alone; the travel direction then lies this far to the right of the facing.
    const STRAFE_RUN_OFFSET = Math.atan2(40, 50);
    const OBSTACLE_MARGIN = 22;
    // Rectangles [left, bottom, right, top] that block a straight walk: two pillars, the computer block, the platform's south edge.
    const OBSTACLES = [[272, 176, 304, 208], [464, 176, 496, 208], [432, 1184, 560, 1264], [0, 254, 224, 258]];
    const NAV_POINTS = [[250, 352], [320, 300], [380, 110], [560, 300], [448, 400], [200, 120], [400, 250],
        [350, 1120], [350, 1320], [640, 1320], [640, 1120]];
    const HALL = [0, 0, 640, 448];
    const WALKWAY = [128, 496, 672, 1008];
    const ROOM = [272, 1056, 720, 1376];
    const EXIT_ROOM = [864, 1120, 1024, 1312];
    const HALL_STIMPACK = [600, 48];
    const WALKWAY_STIMPACK = [496, 990];
    const TASKS = [
        { kind: 'zone', ids: [0, 1], zone: HALL, patrol: [[320, 300], [540, 330], [380, 110], [150, 130]] },
        { kind: 'go', x: 448, y: 410 },
        { kind: 'go', x: 448, y: 520 },
        { kind: 'zone', ids: [2, 3], zone: WALKWAY, patrol: [[448, 560], [310, 700], [310, 770], [490, 950]] },
        { kind: 'soak', x: 560, y: 880 },
        { kind: 'go', x: 448, y: 530, ifItemAt: HALL_STIMPACK },
        { kind: 'go', x: 448, y: 420, ifItemAt: HALL_STIMPACK },
        { kind: 'zone', ids: [], zone: HALL, patrol: [] },
        { kind: 'go', x: 448, y: 410, ifSouthOf: 460 },
        { kind: 'go', x: 448, y: 520, ifSouthOf: 460 },
        { kind: 'zone', ids: [], zone: WALKWAY, patrol: [] },
        { kind: 'go', x: 494, y: 985 },
        { kind: 'go', x: 496, y: 1072 },
        { kind: 'zone', ids: [4, 5, 6], zone: ROOM, patrol: [[350, 1120], [350, 1320], [640, 1320], [640, 1120]] },
        { kind: 'go', x: 730, y: 1216 },
        { kind: 'go', x: 800, y: 1216 },
        { kind: 'zone', ids: [7], zone: EXIT_ROOM, patrol: [[880, 1216], [930, 1180]] },
        { kind: 'switch' }
    ];

    let taskIndex = 0;
    let taskTics = 0;
    let patrolIndex = 0;
    let wakeShotAmmo = null;
    let monsters = null;
    let currentEnemy = null;
    let turnHeld = 0;
    let sidestepTics = 0;
    let sidestepSign = 1;
    const recentPositions = [];
    window.testMasks = [];
    window.testLog = [];

    function normalize(angle) {
        let result = angle % (2 * Math.PI);
        if (result > Math.PI) { result -= 2 * Math.PI; }
        if (result < -Math.PI) { result += 2 * Math.PI; }
        return result;
    }

    function nearBox(pointX, pointY, box) {
        return pointX > box[0] - OBSTACLE_MARGIN && pointX < box[2] + OBSTACLE_MARGIN
            && pointY > box[1] - OBSTACLE_MARGIN && pointY < box[3] + OBSTACLE_MARGIN;
    }

    // An obstacle whose margin already holds an end point of the path does not count, because that end point is reachable.
    function pathIsClear(fromX, fromY, toX, toY) {
        const boxes = OBSTACLES.filter(function (box) { return !nearBox(fromX, fromY, box) && !nearBox(toX, toY, box); });
        const length = Math.hypot(toX - fromX, toY - fromY);
        const stepCount = Math.max(1, Math.ceil(length / 6));
        for (let stepIndex = 1; stepIndex < stepCount; stepIndex++) {
            const pointX = fromX + (toX - fromX) * stepIndex / stepCount;
            const pointY = fromY + (toY - fromY) * stepIndex / stepCount;
            for (const box of boxes) {
                if (nearBox(pointX, pointY, box)) { return false; }
            }
        }
        return true;
    }

    // Returns the point to move toward now in order to reach the goal.
    function nextStep(fromX, fromY, goalX, goalY) {
        if (pathIsClear(fromX, fromY, goalX, goalY)) { return [goalX, goalY]; }
        let best = null;
        let bestCost = Infinity;
        for (const point of NAV_POINTS) {
            if (!pathIsClear(fromX, fromY, point[0], point[1])) { continue; }
            const viaClear = pathIsClear(point[0], point[1], goalX, goalY);
            const cost = Math.hypot(point[0] - fromX, point[1] - fromY) + Math.hypot(goalX - point[0], goalY - point[1]) + (viaClear ? 0 : 400);
            if (Math.hypot(point[0] - fromX, point[1] - fromY) > 20 && cost < bestCost) { bestCost = cost; best = point; }
        }
        return best === null ? [goalX, goalY] : best;
    }

    function isStimpack(item) { return item.itemKind.message.indexOf('STIMPACK') >= 0; }
    function isArmor(item) { return item.itemKind.message.indexOf('ARMOR') >= 0; }
    function inZone(thing, zone) { return thing.x >= zone[0] && thing.x <= zone[2] && thing.y >= zone[1] && thing.y <= zone[3]; }

    window.testBot = function (state) {
        const player = state.player;
        const items = state.things.filter(function (thing) { return thing.type === 'item'; });
        if (monsters === null) { monsters = state.things.filter(function (thing) { return thing.type === 'monster'; }); }
        let mask = 0;

        function itemAt(point) { return items.some(function (item) { return Math.hypot(item.x - point[0], item.y - point[1]) < 8; }); }
        function pickable(item) {
            if (isStimpack(item)) { return player.health < 100; }
            if (isArmor(item)) { return player.armor < 100; }
            return player.ammo < 200;
        }
        function nearestLoot(zone) {
            let nearest = null;
            let nearestDistance = Infinity;
            for (const item of items) {
                const distance = Math.hypot(item.x - player.x, item.y - player.y);
                if (inZone(item, zone) && pickable(item) && distance < nearestDistance) { nearest = item; nearestDistance = distance; }
            }
            return nearest;
        }

        // Advance past finished and inapplicable tasks.
        let task = null;
        for (;;) {
            task = TASKS[taskIndex];
            let done = false;
            if (task.kind === 'go') {
                const applies = (task.ifItemAt === undefined || itemAt(task.ifItemAt)) && (task.ifSouthOf === undefined || player.y < task.ifSouthOf);
                done = !applies || Math.hypot(task.x - player.x, task.y - player.y) < 24;
            } else if (task.kind === 'zone') {
                done = task.ids.every(function (id) { return monsters[id].health <= 0; }) && nearestLoot(task.zone) === null;
            } else if (task.kind === 'soak') {
                done = player.health <= 89 || !itemAt(WALKWAY_STIMPACK);
            }
            if (!done) { break; }
            taskIndex++;
            taskTics = 0;
            patrolIndex = 0;
            wakeShotAmmo = null;
        }
        taskTics++;

        // Choose the enemy: keep the current one while it lives and is visible, otherwise the nearest visible living monster.
        function visible(monster) { return monster.health > 0 && state.canSee(player.x, player.y, player.z + 32, monster); }
        if (currentEnemy !== null && !visible(currentEnemy)) { currentEnemy = null; }
        if (currentEnemy === null) {
            let nearestDistance = Infinity;
            for (const monster of monsters) {
                const distance = Math.hypot(monster.x - player.x, monster.y - player.y);
                if (distance < nearestDistance && visible(monster)) { currentEnemy = monster; nearestDistance = distance; }
            }
        }
        const enemy = task.kind === 'switch' ? null : currentEnemy;

        // Choose the movement goal.
        let goal = null;
        if (task.kind === 'go') {
            goal = [task.x, task.y];
        } else if (task.kind === 'soak') {
            if (Math.hypot(task.x - player.x, task.y - player.y) > 16) { goal = [task.x, task.y]; }
        } else if (task.kind === 'switch') {
            if (state.exitTics === 0) { goal = [1024, 1216]; }
        } else if (task.kind === 'zone') {
            const loot = nearestLoot(task.zone);
            const livingIds = task.ids.filter(function (id) { return monsters[id].health > 0; });
            if (loot !== null) {
                goal = [loot.x, loot.y];
            } else if (enemy === null && livingIds.length > 0) {
                if (wakeShotAmmo === null) { wakeShotAmmo = player.ammo; }
                if (player.ammo === wakeShotAmmo) {
                    if (state.weaponReady) { mask |= FIRE; }
                } else if (taskTics > 350 || task.patrol.length === 0) {
                    const hidden = monsters[livingIds[0]];
                    goal = [hidden.x, hidden.y];
                } else {
                    const point = task.patrol[patrolIndex % task.patrol.length];
                    if (Math.hypot(point[0] - player.x, point[1] - player.y) < 30) { patrolIndex++; }
                    goal = point;
                }
            }
        }
        // Keep away from a close monster.
        for (const monster of monsters) {
            const distance = Math.hypot(monster.x - player.x, monster.y - player.y);
            if (monster.health > 0 && distance < (monster.kind.melee ? 115 : 60) && task.kind !== 'switch') {
                goal = [player.x + (player.x - monster.x) / distance * 100, player.y + (player.y - monster.y) / distance * 100];
            }
        }

        // Move toward the goal with the keys that fit the current facing.
        let travelAngle = null;
        if (goal !== null) {
            const step = nextStep(player.x, player.y, goal[0], goal[1]);
            travelAngle = Math.atan2(step[1] - player.y, step[0] - player.x);
            if (sidestepTics > 0) { travelAngle += sidestepSign * Math.PI / 2; }
            const relative = normalize(travelAngle - player.angle);
            if (Math.cos(relative) > 0.38) { mask |= UP; } else if (Math.cos(relative) < -0.38) { mask |= DOWN; }
            if (Math.sin(relative) > 0.38) { mask |= COMMA; } else if (Math.sin(relative) < -0.38) { mask |= PERIOD; }
            mask |= SHIFT;
        }

        // Choose the facing.
        let facing = null;
        let closedDoor = null;
        if (enemy === null && travelAngle !== null) {
            for (const sector of state.doorSectors) {
                const doorDistance = Math.hypot(sector.centerX - player.x, sector.centerY - player.y);
                const doorAngle = Math.atan2(sector.centerY - player.y, sector.centerX - player.x);
                if (sector.door.state === 'closed' && doorDistance < 150 && Math.abs(normalize(doorAngle - travelAngle)) < 1.0) { closedDoor = sector; }
            }
        }
        if (enemy !== null) {
            facing = Math.atan2(enemy.y - player.y, enemy.x - player.x);
        } else if (closedDoor !== null) {
            facing = Math.atan2(closedDoor.centerY - player.y, closedDoor.centerX - player.x);
        } else if (task.kind === 'switch') {
            facing = 0;
        } else if (travelAngle !== null) {
            facing = travelAngle + STRAFE_RUN_OFFSET;
        }
        let difference = 0;
        if (facing !== null) {
            difference = normalize(facing - player.angle);
            const turnStep = turnHeld + 1 < SLOW_TURN_TICS ? SLOW_TURN : (mask & SHIFT) !== 0 ? RUN_TURN : WALK_TURN;
            const wantsTurn = Math.abs(difference) > turnStep * 0.5 && !(turnStep > SLOW_TURN && Math.abs(difference) < turnStep);
            if (wantsTurn) {
                mask |= difference > 0 ? LEFT : RIGHT;
                turnHeld++;
            } else {
                turnHeld = 0;
            }
        } else {
            turnHeld = 0;
        }

        // Fire single aimed shots: a held fire key adds spread, a fresh press does not.
        if (enemy !== null) {
            const enemyDistance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
            if (state.weaponReady && Math.abs(difference) < Math.atan(12 / enemyDistance)) { mask |= FIRE; }
        }
        if (closedDoor !== null && Math.abs(difference) < 0.3) { mask |= USE; }
        if (task.kind === 'switch' && state.exitTics === 0 && Math.cos(player.angle) > 0) {
            const reach = (1024 - player.x) / Math.cos(player.angle);
            const hitY = player.y + reach * Math.sin(player.angle);
            if (reach < 62 && hitY > 1188 && hitY < 1244) { mask |= USE; }
        }

        // A blocked move gets a short sidestep.
        recentPositions.push([player.x, player.y]);
        if (recentPositions.length > 10) { recentPositions.shift(); }
        const doorMoving = state.doorSectors.some(function (sector) {
            return sector.door.state === 'opening' && Math.hypot(sector.centerX - player.x, sector.centerY - player.y) < 120;
        });
        if (sidestepTics > 0) {
            sidestepTics--;
        } else if (goal !== null && !doorMoving && closedDoor === null && recentPositions.length === 10
            && Math.hypot(player.x - recentPositions[0][0], player.y - recentPositions[0][1]) < 3) {
            sidestepTics = 8;
            sidestepSign = -sidestepSign;
            recentPositions.length = 0;
        }

        window.testMasks.push(mask);
        if (state.levelTic % 50 === 0) {
            window.testLog.push(state.levelTic + ':' + Math.round(player.x) + ',' + Math.round(player.y) + ' hp' + player.health
                + ' ar' + player.armor + ' am' + player.ammo + ' task' + taskIndex + (enemy !== null ? ' fight' : '')
                + ' alive' + monsters.filter(function (monster) { return monster.health > 0; }).length + ' items' + items.length);
        }
        return mask;
    };
}());
