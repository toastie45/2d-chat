const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareRoomBackgroundBundle } = require('../lib/room-background-bundle');
const animation = { columns: 4, rows: 2, frames: 8, fps: 6 };
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const fs = require('node:fs');
const vm = require('node:vm');

test('manual background uploads preserve the current overlay and floor layout', () => {
    const bundle = prepareRoomBackgroundBundle();
    assert.equal(bundle.replaceOverlay, false);
    assert.equal(bundle.image, null);
    assert.deepEqual(bundle.layout, {});
});

test('DJ preset carries its aligned overlay, animation and standing cell together', () => {
    const bundle = prepareRoomBackgroundBundle({ overlay: { image: png, animation }, openCells: ['-1:1'] });
    assert.equal(bundle.replaceOverlay, true);
    assert.equal(bundle.mimeType, 'image/png');
    assert.deepEqual(bundle.image, png);
    assert.deepEqual(bundle.transform, { x: 0, y: 0, rotation: 0, scale: 1, animation });
    assert.deepEqual(bundle.layout, { '-1:1': 'open' });
});

test('switching to a preset without an overlay explicitly clears the old DJ desk', () => {
    const bundle = prepareRoomBackgroundBundle({ clearOverlay: true });
    assert.equal(bundle.replaceOverlay, true);
    assert.equal(bundle.image, null);
    assert.equal(bundle.transform.animation.frames, 1);
    assert.deepEqual(bundle.layout, {});
});

test('the DJ standing space opens while the desk itself stays blocked', () => {
    const bundle = prepareRoomBackgroundBundle({ openCells: ['-1:1'], closedCells: ['-1:2'] });
    assert.deepEqual(bundle.layout, { '-1:1': 'open', '-1:2': 'closed' });
    assert.throws(() => prepareRoomBackgroundBundle({ openCells: ['-1:1'], closedCells: ['-1:1'] }));
});

test('invalid overlays, frame settings and movement coordinates are rejected', () => {
    assert.throws(() => prepareRoomBackgroundBundle({ overlay: { image: Buffer.from('invalid'), animation } }));
    assert.throws(() => prepareRoomBackgroundBundle({ overlay: { image: png, animation: { ...animation, frames: 9 } } }));
    assert.throws(() => prepareRoomBackgroundBundle({ overlay: { image: Buffer.alloc(850_001), animation } }));
    assert.throws(() => prepareRoomBackgroundBundle({ openCells: ['999:999'] }));
    assert.throws(() => prepareRoomBackgroundBundle({ clearOverlay: 'yes' }));
    assert.throws(() => prepareRoomBackgroundBundle({ overlay: { image: png, animation }, clearOverlay: true }));
});

test('admin activation saves background and animated foreground in one update before broadcasting', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const start = source.indexOf("socket.on('admin-public-room-background-upload'");
    const end = source.indexOf("socket.on('admin-public-room-background-activate'", start);
    const queries = [], events = [];
    let handler;
    const room = { id: 'disco', room_number: 2, name: 'Disco', overlay_transform: { animation } };
    const context = {
        Buffer, Uint8Array, prepareRoomBackgroundBundle, JSON, console,
        socket: { id: 'admin', data: { canManagePublicRooms: true }, on: (_event, callback) => { handler = callback; },
            emit: (event, payload) => events.push({ event, payload }) },
        activeSocketIds: new Set(['admin']),
        normalizeClothingAnimation: (value) => value,
        pool: { query: async (sql, values) => { queries.push({ sql, values }); return sql.includes('UPDATE') ? { rowCount: 1 } : { rows: [room] }; } },
        loadApartmentTiles: async () => ({ '-1:1': 'open' }),
        io: { to: () => ({ emit: (event, payload) => events.push({ event, payload }) }), emit() {} },
        roomChannel: (id) => id,
        formatPublicRoomName: () => '#2 Disco',
        getPublicRoomBackgroundUrl: () => '/background',
        getPublicRoomBackgroundAnimation: () => animation,
        getPublicRoomOverlayUrl: () => '/overlay',
        getPublicRoomOverlayTransform: (record) => record.overlay_transform,
        sendAdminPublicRooms: async () => {}, getSafeErrorCode: () => 'test'
    };
    vm.runInNewContext(source.slice(start, end), context);
    await handler({ id: 'disco', image: png, animation, type: 'spritesheet',
        overlay: { image: png, animation }, openCells: ['-1:1'] });
    assert.equal(queries.length, 2);
    assert.match(queries[0].sql, /background_spritesheet_image/);
    assert.match(queries[0].sql, /overlay_image/);
    assert.deepEqual(queries[0].values[4], png);
    assert.deepEqual(JSON.parse(queries[0].values[6]).animation, animation);
    assert.deepEqual(JSON.parse(queries[0].values[7]), { '-1:1': 'open' });
    assert.equal(queries[0].values[8], true);
    assert.equal(events.find((event) => event.event === 'admin-room-background-result').payload.success, true);
    assert.deepEqual(events.find((event) => event.event === 'public-room-metadata').payload.roomOverlayTransform.animation, animation);
    context.socket.data.canManagePublicRooms = false;
    await handler({ id: 'disco', image: png, animation, type: 'spritesheet' });
    assert.equal(queries.length, 2, 'non-admin cannot save the bundle');
});
