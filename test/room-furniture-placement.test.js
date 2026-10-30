const test = require('node:test');
const assert = require('node:assert/strict');
const grid = require('../public/grid-layout');
const placement = require('../docs/disco-dj-grid-placement.json');
const catalog = require('../public/room-backgrounds.json');

test('every stool seat center matches a real movement cell and is opened by the preset', () => {
    const preset = catalog.backgrounds.find((entry) => entry.id === 'disco-dj-grid-v3');
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
