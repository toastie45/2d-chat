const test = require('node:test');
const assert = require('node:assert/strict');
const grid = require('../public/grid-layout');
const placement = require('../docs/disco-standing-placement.json');
const catalog = require('../public/room-backgrounds.json');
const fs = require('node:fs');
const vm = require('node:vm');

test('every furniture support matches a real movement cell and is opened by the preset', () => {
    const preset = catalog.backgrounds.find((entry) => entry.id === 'disco-standing-v4');
    assert.equal(catalog.backgrounds.length, 1);
    assert.equal(placement.seats.length, 5);
    assert.equal(new Set(placement.seats.map((seat) => seat.cell)).size, 5);
    for (const seat of placement.seats) {
        const cell = grid.cells.find(({ col, row }) => `${col}:${row}` === seat.cell);
        assert.ok(cell, seat.cell);
        assert.equal(cell.x, seat.x);
        assert.equal(cell.y, seat.y);
        assert.ok(preset.openCells.includes(seat.cell));
        assert.ok(!preset.closedCells.includes(seat.cell));
    }
    assert.equal(placement.gridCanvas.width, grid.width);
    assert.equal(placement.gridCanvas.height, grid.height);
    assert.equal(placement.backgroundCanvas.width / grid.width, placement.backgroundCanvas.height / grid.height);
});

test('furniture uses the actual standing avatar feet, including bottom-row clamping', () => {
    const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
    const start = html.indexOf('function getAvatarDrawY(');
    const end = html.indexOf('function getBubblePlacement(', start);
    const context = { gridLayout: grid, avatarImageLoaded: true, avatarHeight: placement.avatar.height, avatarRadius: 13 };
    vm.runInNewContext(html.slice(start, end), context);
    assert.match(html, new RegExp(`const avatarWidth = ${placement.avatar.width};`));
    assert.match(html, new RegExp(`const avatarHeight = ${placement.avatar.height};`));
    for (const seat of placement.seats) {
        const actualFootY = context.getAvatarDrawY(seat) + placement.avatar.height / 2;
        assert.equal(actualFootY, seat.footY, seat.cell);
    }
    assert.equal(context.getAvatarDrawY({ y: 315 }), 298.5);
});
