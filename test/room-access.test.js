const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRoomLevel, publicRoomAccessError, parsePrisonRoomNumber } = require('../lib/room-access');

test('optional room levels accept only whole levels 1–20', () => {
    assert.equal(normalizeRoomLevel(), 1);
    for (const value of [1, '6', 20]) assert.equal(normalizeRoomLevel(value), Number(value));
    for (const value of [null, true, '', [], {}, 0, 21, 2.5, '3.5']) assert.equal(normalizeRoomLevel(value), null);
});

test('room access checks level, visibility and lock while all admins bypass restrictions', () => {
    const room = { required_level: 6 };
    assert.match(publicRoomAccessError(room, false, 5), /level 6/);
    assert.equal(publicRoomAccessError(room, false, 6), '');
    assert.equal(publicRoomAccessError({}, false), '');
    assert.match(publicRoomAccessError({ ...room, is_locked: true }, false, 20), /låst/);
    assert.match(publicRoomAccessError({ ...room, is_hidden: true }, false, 20), /findes ikke/);
    assert.equal(publicRoomAccessError({ ...room, is_locked: true, is_hidden: true }, true, 1), '');
    assert.match(publicRoomAccessError(null, true), /findes ikke/);
});

test('warning transfer accepts a room number or /tr and rejects arbitrary commands', () => {
    assert.equal(parsePrisonRoomNumber('/tr 99'), '99');
    assert.equal(parsePrisonRoomNumber(' 42 '), '42');
    assert.equal(parsePrisonRoomNumber('/TR 2'), '2');
    for (const value of ['/tb Tommy', '/tr -1', '/tr 99 extra', '0', '1.5', '/tr 9999999999999999999', null]) {
        assert.equal(parsePrisonRoomNumber(value), null);
    }
});
