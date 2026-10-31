const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('idle cleanup exempts both server-authorized admin roles across instances', async () => {
    const source = fs.readFileSync(require.resolve('../server'), 'utf8');
    const start = source.indexOf('    async function kickIdlePlayers()');
    const end = source.indexOf('    async function kickPlayer(', start);
    const removed = [], invalidated = [];
    const context = {
        Date, JSON, Object, console,
        io: {
            fetchSockets: async () => [
                { id: 'owner', data: { adminRole: 'full' } },
                { id: 'limited', data: { adminRole: 'rooms-clothing' } },
                { id: 'regular', data: { adminRole: 'none' } }
            ],
            to: () => ({ emit() {} }), emit() {},
            in: () => ({ disconnectSockets() {} })
        },
        redis: { eval: async (_script, options) => {
            const exempt = JSON.parse(options.arguments[2]);
            assert.deepEqual(exempt, { owner: true, limited: true });
            return ['owner', 'limited', 'regular'].filter((id) => !exempt[id]);
        } },
        getAllRoomIds: async () => ['lobby'], roomKeys: () => ({ players: 'players', cells: 'cells' }),
        KICK_IDLE_PLAYERS_SCRIPT: '', PLAYER_IDLE_TIMEOUT: 20 * 60 * 1000,
        activeSocketIds: { delete: (id) => removed.push(id) },
        invisibleSocketIds: new Set(), activeSocketRooms: new Map(), activeSocketUsers: new Map(),
        accountOnlineSession: async () => {},
        invalidateSocketSession: async (id) => invalidated.push(id),
        roomChannel: (id) => id, broadcastChatOnlineCount: async () => {},
        setTimeout: (callback) => callback()
    };
    vm.runInNewContext(source.slice(start, end) + '\nthis.run = kickIdlePlayers;', context);
    await context.run();
    assert.deepEqual(removed, ['regular']);
    assert.deepEqual(invalidated, ['regular']);
    assert.match(source, /if lastActivityAt < cutoff and not exemptIds\[id\] then/);
});
