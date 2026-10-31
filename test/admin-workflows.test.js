const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parsePrisonRoomNumber, normalizeRoomLevel } = require('../lib/room-access');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');

function getHandler(event, context) {
    let handler;
    const start = source.indexOf(`        socket.on('${event}'`);
    const end = source.indexOf('\n        socket.on(', start + 1);
    context.socket.on = (_, callback) => { handler = callback; };
    vm.runInNewContext(source.slice(start, end), context);
    return handler;
}

function warningContext() {
    const events = [], transfers = [];
    const target = { id: 'guest', data: { user: { username: 'Guest' } }, emit: (event, payload) => events.push({ event, ...payload }) };
    const context = {
        parsePrisonRoomNumber, console,
        socket: { id: 'admin', data: { isAdmin: true }, emit: (event, payload) => events.push({ event, ...payload }) },
        activeSocketIds: new Set(['admin', 'guest']), activeSocketRooms: new Map([['guest', 'common']]),
        io: { sockets: { sockets: new Map([['guest', target]]) } },
        pool: { query: async () => ({ rows: [{ id: 'public:99' }] }) },
        placeSocketInRoom: async (...args) => { transfers.push(args); return true; },
        getSafeErrorCode: () => 'test'
    };
    return { context, target, events, transfers };
}

test('warning transfer requires full admin, prevents self/admin targets, and validates destination', async () => {
    const { context, target, transfers } = warningContext();
    const handler = getHandler('admin-user-prison', context);
    context.socket.data.isAdmin = false;
    await handler({ targetSocketId: 'guest', destination: '/tr 99' });
    context.socket.data.isAdmin = true;
    await handler({ targetSocketId: 'guest', destination: '/tb Guest' });
    await handler({ targetSocketId: 'admin', destination: '/tr 99' });
    target.data.isChatAdmin = true;
    await handler({ targetSocketId: 'guest', destination: '/tr 99' });
    assert.equal(transfers.length, 0);
});

test('warning transfer moves through normal room lifecycle and permits a locked destination', async () => {
    const { context, target, events, transfers } = warningContext();
    await getHandler('admin-user-prison', context)({ targetSocketId: 'guest', destination: '/tr 99' });
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0][0], target);
    assert.equal(transfers[0][1], 'public:99');
    assert.equal(transfers[0][2].bypassRoomAccess, true);
    assert.equal(target.data.switchingRoom, false);
    assert.ok(events.some((event) => event.success === true));
});

test('warning transfer handles missing/full rooms and restores switching state on failure', async () => {
    const { context, target, events, transfers } = warningContext();
    const handler = getHandler('admin-user-prison', context);
    context.pool.query = async () => ({ rows: [] });
    await handler({ targetSocketId: 'guest', destination: '99' });
    assert.equal(transfers.length, 0);
    assert.match(events.at(-1).message, /findes ikke/);
    assert.equal(target.data.switchingRoom, false);
    context.pool.query = async () => ({ rows: [{ id: 'public:99' }] });
    context.placeSocketInRoom = async () => null;
    await handler({ targetSocketId: 'guest', destination: '99' });
    assert.match(events.at(-1).message, /fyldt/);
    assert.equal(target.data.switchingRoom, false);
});

test('system room names and level restrictions save together without altering room identity', async () => {
    const calls = [], events = [];
    const context = {
        normalizeRoomLevel, console,
        socket: { id: 'admin', data: { canManagePublicRooms: true }, emit: (event, value) => events.push({ event, ...value }) },
        activeSocketIds: new Set(['admin']),
        pool: { query: async (sql, values) => { calls.push({ sql, values }); return { rowCount: 1, rows: [{ id: 'common', name: 'Nyt navn' }] }; } },
        io: { to: () => ({ emit() {} }), emit() {} }, roomChannel: (id) => id,
        formatPublicRoomName: (room) => room.name,
        getPublicRoomBackgroundUrl: () => null, getPublicRoomBackgroundAnimation: () => null,
        getPublicRoomOverlayUrl: () => null, getPublicRoomOverlayTransform: () => null,
        sendAdminPublicRooms: async () => {}, getSafeErrorCode: () => 'test'
    };
    const handler = getHandler('admin-public-room-update', context);
    await handler({ id: 'common', name: 'Nyt navn', floorNumber: 1, isLocked: false, isHidden: false, isShop: false, requiredLevel: 6 });
    assert.equal(calls[0].values[0], 'common');
    assert.equal(calls[0].values[1], 'Nyt navn');
    assert.equal(calls[0].values[6], 6);
    assert.match(calls[0].sql, /required_level = \$7/);
    assert.ok(events.some((event) => event.success));
    calls.length = 0;
    await handler({ id: 'common', name: 'Nyt navn', floorNumber: 1, isLocked: false, isHidden: false, isShop: false, requiredLevel: 21 });
    assert.equal(calls.length, 0);
});

test('profile outfit changes notify only authenticated watchers of the matching account', async () => {
    const start = source.indexOf('    async function refreshOnlineUserClothing(');
    const end = source.indexOf('    async function enforceClothingLevelForAssignments', start);
    const notifications = [];
    const viewer = (id, userId) => ({ id, data: { viewingProfileUserId: userId }, emit: (event, payload) => notifications.push({ id, event, payload }) });
    const context = {
        getUserClothing: async () => [{ id: 'shirt' }],
        io: { sockets: { sockets: new Map([['viewer', viewer('viewer', '2')], ['other', viewer('other', '3')], ['loggedout', viewer('loggedout', '2')]]) } },
        activeSocketIds: new Set(['viewer', 'other']), activeSocketUsers: new Map()
    };
    vm.runInNewContext(source.slice(start, end) + '\nthis.refresh = refreshOnlineUserClothing;', context);
    await context.refresh('2');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].id, 'viewer');
    assert.equal(notifications[0].payload.clothing[0].id, 'shirt');
});

test('editing catalog appearance preserves shop levels and refreshes every assigned outfit', async () => {
    const queries = [], refreshed = [], events = [];
    const context = {
        Buffer, Uint8Array, console, isValidClothingAnimation: () => true,
        socket: { id: 'admin', data: { canManageClothing: true }, emit: (event, value) => events.push({ event, ...value }) },
        activeSocketIds: new Set(['admin']),
        pool: { query: async (sql, values) => {
            queries.push({ sql, values });
            if (sql.includes('incompatible') || sql.includes('SELECT 1')) return { rowCount: 0 };
            if (sql.includes('UPDATE chat_clothing_catalog')) return { rows: [{ id: '7', required_level: 17 }] };
            if (sql.includes('SELECT DISTINCT target_user_id')) return { rows: [{ user_id: '2' }, { user_id: '3' }] };
            return { rows: [] };
        } },
        io: { to: () => ({ emit() {} }) }, roomChannel: (id) => id,
        refreshOnlineUserClothing: async (id) => refreshed.push(id), sendAdminClothingItems: async () => {},
        getSafeErrorCode: () => 'test'
    };
    await getHandler('admin-clothing-item-update', context)({
        id: '7', name: 'Trøje', category: 'clothing', targetAvatarType: 'boy', requiredLevel: 1,
        price: 42, x: 0, y: 0, rotation: 0, scale: 1, animation: { frames: 1, columns: 1, rows: 1, fps: 8 }
    });
    const update = queries.find(({ sql }) => sql.includes('UPDATE chat_clothing_catalog'));
    assert.ok(update);
    assert.equal(update.values[5], 42);
    assert.equal(update.values.length, 12);
    assert.doesNotMatch(update.sql, /required_level\s*=/);
    assert.ok(!queries.some(({ sql }) => sql.includes('UPDATE chat_shop_room_items')));
    assert.deepEqual(refreshed.sort(), ['2', '3']);
    assert.ok(events.some((event) => event.success));
});
