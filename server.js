const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Server } = require('socket.io');
const {
    MAX_MESSAGE_LENGTH,
    isValidPassword,
    normalizeUsername,
    redactSecrets,
    sanitizeChatMessage
} = require('./lib/chat-security');
const {
    isAuthorizedTabSession,
    isValidTabId,
    mapTabSessionCookie,
    renameSessionSetCookie
} = require('./lib/tab-session');
const { hashRegistrationIp, MAX_ACCOUNTS_PER_IP } = require('./lib/account-ip-limit');
const { calculateAge, getDanishRegions, getSteamUrl, normalizePublicProfile } = require('./lib/public-profile');
const { registerChatMessage } = require('./lib/chat-rate-limit');
const { analyzeProgressionMessage, SPAM_HISTORY_LIMIT, SPAM_HISTORY_WINDOW_MS } = require('./lib/chat-spam-filter');
const { GUESTBOOK_MESSAGE_MAX_LENGTH, normalizeGuestbookMessage } = require('./lib/guestbook');
const { USER_SEARCH_RESULT_LIMIT, getUserSearchPatterns } = require('./lib/user-search');
const GRID_LAYOUT = require('./public/grid-layout');
const { LEVEL_REQUIREMENTS, getUserLevel } = require('./public/level-progression');
const PRIVATE_MAIL_SUBJECT_MAX_LENGTH = 100;
const PRIVATE_MAIL_MESSAGE_MAX_LENGTH = 2000;

const MESSAGE_DURATION = 10_000;
const OFFLINE_PROFILE_PREFIX = 'user:';
const HISTORY_LIMIT = 500;
const PRESENCE_HEARTBEAT_INTERVAL = 10_000;
const PRESENCE_EXPIRY = 45_000;
const PRESENCE_CLEANUP_INTERVAL = 15_000;
const ONLINE_TIME_ACCOUNTING_INTERVAL = 10_000;
const PROGRESSION_UPDATE_INTERVAL = 60_000;
const PLAYER_IDLE_TIMEOUT = 20 * 60 * 1000;
const PLAYER_IDLE_CHECK_INTERVAL = 10_000;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_ROOM_NAMES = Object.freeze({ common: '#1 Fællesrum', disco: '#2 Diskoteket' });
const GRID_CELLS = [...GRID_LAYOUT.cells];
GRID_CELLS.sort((first, second) => {
    const firstDistance = Math.abs(first.x - GRID_LAYOUT.width / 2) + Math.abs(first.y - GRID_LAYOUT.height / 2);
    const secondDistance = Math.abs(second.x - GRID_LAYOUT.width / 2) + Math.abs(second.y - GRID_LAYOUT.height / 2);
    return firstDistance - secondDistance;
});
const GRID_CELL_KEYS = new Set(GRID_CELLS.map(({ col, row }) => `${col}:${row}`));
const DEFAULT_CLOSED_CELL_KEYS = new Set(GRID_CELLS
    .filter((cell) => cell.kind === 'edge' && cell.y === 0 && cell.x < GRID_LAYOUT.width)
    .map(({ col, row }) => `${col}:${row}`));

function getApartmentRoomName(apartment) {
    const apartmentName = typeof apartment.apartment_name === 'string' && apartment.apartment_name.trim()
        ? apartment.apartment_name.trim()
        : `${apartment.username}s Lejlighed`;
    return `#${apartment.apartment_number} ${apartmentName}`;
}

function parseApartmentTileState(value) {
    if (typeof value !== 'string' || value.length > 80) return null;
    const separator = value.indexOf('|');
    const base = separator === -1 ? value : value.slice(0, separator);
    const color = separator === -1 ? '' : value.slice(separator + 1);
    if (separator !== -1 && (!/^#[0-9a-f]{6}$/i.test(color) || value.indexOf('|', separator + 1) !== -1)) return null;
    if (/^#[0-9a-f]{6}$/i.test(base)) {
        if (separator !== -1) return null;
        return { kind: 'floor', color: base.toLowerCase() };
    }
    if (base === 'open') return { kind: 'floor', color: color ? color.toLowerCase() : '' };
    if (base === 'closed') return { kind: 'closed', color: color ? color.toLowerCase() : '' };
    if (base === 'door') return { kind: 'door', destination: 'common', color: color ? color.toLowerCase() : '' };
    const door = /^door:(common|disco|apartment:[1-9]\d{0,18})$/.exec(base);
    if (door) return { kind: 'door', destination: door[1], color: color ? color.toLowerCase() : '' };
    return null;
}

function serializeApartmentTileState({ kind, destination, color = '' }) {
    const base = kind === 'closed' ? 'closed' : kind === 'door' ? `door:${destination || 'common'}` : '';
    if (base) return color ? `${base}|${color}` : base;
    return color || '';
}

function normalizeApartmentTiles(value) {
    const tiles = Object.fromEntries([...DEFAULT_CLOSED_CELL_KEYS].map((cell) => [cell, 'closed']));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return tiles;
    for (const [cell, state] of Object.entries(value)) {
        if (!GRID_CELL_KEYS.has(cell)) continue;
        const parsed = parseApartmentTileState(state);
        if (!parsed) continue;
        const explicitOpen = typeof state === 'string' && state.startsWith('open');
        const normalized = DEFAULT_CLOSED_CELL_KEYS.has(cell) && parsed.kind === 'floor' && !explicitOpen
            ? (parsed.color ? `open|${parsed.color}` : '')
            : explicitOpen
                ? (parsed.color ? `open|${parsed.color}` : 'open')
                : serializeApartmentTileState(parsed);
        if (normalized) tiles[cell] = normalized;
        else if (DEFAULT_CLOSED_CELL_KEYS.has(cell)) delete tiles[cell];
    }
    return tiles;
}

const PLAYER_JOIN_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
    local player = cjson.decode(existing)
    player.lastSeen = tonumber(ARGV[3])
    player.joinedAt = tonumber(player.joinedAt or ARGV[3])
    player.lastActivityAt = tonumber(player.lastActivityAt or ARGV[3])
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
    return cjson.encode(player)
end

local function tryJoin(cell)
    local tileState = redis.call('HGET', KEYS[3], cell)
    local isClosed = tileState == 'closed' or (tileState and string.sub(tileState, 1, 7) == 'closed|')
    if redis.call('HEXISTS', KEYS[2], cell) == 0 and not isClosed then
        local col, row = string.match(cell, '^([%-]?%d+):([%-]?%d+)$')
        local player = {
            id = ARGV[1],
            name = ARGV[2],
            col = tonumber(col),
            row = tonumber(row),
            mood = 'glad',
            text = '',
            messageTime = 0,
            lastSeen = tonumber(ARGV[3]),
            joinedAt = tonumber(ARGV[3]),
            lastActivityAt = tonumber(ARGV[3])
        }
        redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
        redis.call('HSET', KEYS[2], cell, ARGV[1])
        return cjson.encode(player)
    end
    return false
end

-- In an apartment, prefer a designated door as the spawn point when available.
for index = 4, #ARGV do
    local cell = ARGV[index]
    local tileState = redis.call('HGET', KEYS[3], cell)
    if tileState == 'door' or (tileState and string.sub(tileState, 1, 5) == 'door:') then
        local player = tryJoin(cell)
        if player then return player end
    end
end
for index = 4, #ARGV do
    local player = tryJoin(ARGV[index])
    if player then return player end
end
return false
`;

const PLAYER_MOVE_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end

local player = cjson.decode(encoded)
local nextCell = ARGV[2] .. ':' .. ARGV[3]
local tileState = redis.call('HGET', KEYS[3], nextCell)
if tileState == 'closed' or (tileState and string.sub(tileState, 1, 7) == 'closed|') then return false end
local occupant = redis.call('HGET', KEYS[2], nextCell)
if occupant and occupant ~= ARGV[1] then return false end

local previousCell = player.col .. ':' .. player.row
if previousCell ~= nextCell and redis.call('HGET', KEYS[2], previousCell) == ARGV[1] then
    redis.call('HDEL', KEYS[2], previousCell)
end

player.col = tonumber(ARGV[2])
player.row = tonumber(ARGV[3])
player.lastSeen = tonumber(ARGV[4])
player.lastActivityAt = tonumber(ARGV[4])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
redis.call('HSET', KEYS[2], nextCell, ARGV[1])
return cjson.encode(player)
`;

const UPDATE_PLAYER_MESSAGE_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end

local player = cjson.decode(encoded)
player.text = ARGV[2]
player.messageTime = tonumber(ARGV[3])
player.lastSeen = tonumber(ARGV[4])
player.lastActivityAt = tonumber(ARGV[4])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
return cjson.encode(player)
`;

const KICK_IDLE_PLAYERS_SCRIPT = `
local removed = {}
local entries = redis.call('HGETALL', KEYS[1])
local cutoff = tonumber(ARGV[1])
for index = 1, #entries, 2 do
    local id = entries[index]
    local player = cjson.decode(entries[index + 1])
    local lastActivityAt = tonumber(player.lastActivityAt or player.joinedAt or player.lastSeen or 0)
    if lastActivityAt < cutoff then
        local cell = player.col .. ':' .. player.row
        if redis.call('HGET', KEYS[2], cell) == id then
            redis.call('HDEL', KEYS[2], cell)
        end
        redis.call('HDEL', KEYS[1], id)
        table.insert(removed, id)
    end
end
return removed
`;

const EXPIRE_PLAYER_MESSAGE_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end

local player = cjson.decode(encoded)
if tonumber(player.messageTime) ~= tonumber(ARGV[2]) then return false end

player.text = ''
player.messageTime = 0
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
return true
`;

const REMOVE_PLAYER_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end

local player = cjson.decode(encoded)
local cell = player.col .. ':' .. player.row
if redis.call('HGET', KEYS[2], cell) == ARGV[1] then
    redis.call('HDEL', KEYS[2], cell)
end
redis.call('HDEL', KEYS[1], ARGV[1])
return true
`;

const HEARTBEAT_SCRIPT = `
local now = tonumber(ARGV[1])
local missing = {}
for index = 2, #ARGV do
    local id = ARGV[index]
    local encoded = redis.call('HGET', KEYS[1], id)
    if encoded then
        local player = cjson.decode(encoded)
        player.lastSeen = now
        redis.call('HSET', KEYS[1], id, cjson.encode(player))
    else
        table.insert(missing, id)
    end
end
return missing
`;

const CLEAN_STALE_PLAYERS_SCRIPT = `
local removed = {}
local entries = redis.call('HGETALL', KEYS[1])
local cutoff = tonumber(ARGV[1])
for index = 1, #entries, 2 do
    local id = entries[index]
    local player = cjson.decode(entries[index + 1])
    if tonumber(player.lastSeen or 0) < cutoff then
        local cell = player.col .. ':' .. player.row
        if redis.call('HGET', KEYS[2], cell) == id then
            redis.call('HDEL', KEYS[2], cell)
        end
        redis.call('HDEL', KEYS[1], id)
        table.insert(removed, id)
    end
end

local occupiedCells = redis.call('HGETALL', KEYS[2])
for index = 1, #occupiedCells, 2 do
    local cell = occupiedCells[index]
    local id = occupiedCells[index + 1]
    local encoded = redis.call('HGET', KEYS[1], id)
    if not encoded then
        redis.call('HDEL', KEYS[2], cell)
    else
        local player = cjson.decode(encoded)
        local playerCell = player.col .. ':' .. player.row
        if playerCell ~= cell then
            redis.call('HDEL', KEYS[2], cell)
        end
    end
end

return removed
`;

const LOGIN_RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

function isGridCoordinate(col, row) {
    return Number.isInteger(col) && Number.isInteger(row) && GRID_CELL_KEYS.has(`${col}:${row}`);
}

function publicPlayer(player) {
    return {
        id: player.id,
        name: player.name,
        col: player.col,
        row: player.row,
        mood: ['glad', 'mobset', 'ked', 'blappet'].includes(player.mood) ? player.mood : 'glad',
        text: player.text,
        messageTime: player.messageTime
    };
}

function getPublicPlayers(redisPlayers) {
    const players = {};
    for (const [id, encoded] of Object.entries(redisPlayers)) {
        const player = JSON.parse(encoded);
        players[id] = publicPlayer(player);
    }
    return players;
}

function getSafeErrorCode(error) {
    return error && (error.code || error.name) || 'UnknownError';
}

async function startServer() {
    const { DATABASE_URL, REDIS_URL, SESSION_SECRET } = process.env;
    if (!DATABASE_URL) throw new Error('Set DATABASE_URL to your PostgreSQL connection string.');
    if (!REDIS_URL) throw new Error('Set REDIS_URL to your Render Key Value connection string.');
    if (!SESSION_SECRET || Buffer.byteLength(SESSION_SECRET, 'utf8') < 32) {
        throw new Error('Set SESSION_SECRET to a random value of at least 32 bytes.');
    }

    const poolSsl = process.env.PGSSLMODE === 'require'
        ? {
            rejectUnauthorized: true,
            ...(process.env.PGSSLROOTCERT
                ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
                : {})
        }
        : undefined;
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: poolSsl,
        max: 10
    });
    pool.on('error', (error) => {
        console.error('Unexpected PostgreSQL pool error:', getSafeErrorCode(error));
    });

    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (error) => {
        console.error('Unexpected Redis connection error:', getSafeErrorCode(error));
    });

    const redisPublisher = redis;
    const redisSubscriber = redis.duplicate();
    redisSubscriber.on('error', (error) => {
        console.error('Unexpected Redis subscriber connection error:', getSafeErrorCode(error));
    });
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    const PgSessionStore = connectPgSimple(session);
    const sessionStore = new PgSessionStore({
        pool,
        createTableIfMissing: true,
        ttl: SESSION_MAX_AGE / 1000,
        pruneSessionInterval: 15 * 60
    });
    const sessionMiddleware = session({
        store: sessionStore,
        name: 'chat.sid',
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        proxy: process.env.NODE_ENV === 'production',
        cookie: {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax'
        }
    });
    const useTabSession = (getTabId) => (request, response, next) => {
        const tabId = getTabId(request);
        if (!isValidTabId(tabId)) {
            next();
            return;
        }
        request.headers.cookie = mapTabSessionCookie(request.headers.cookie, tabId);
        const originalSetHeader = response.setHeader;
        response.setHeader = function (name, value, ...args) {
            const mappedValue = String(name).toLowerCase() === 'set-cookie'
                ? renameSessionSetCookie(value, tabId)
                : value;
            return originalSetHeader.call(this, name, mappedValue, ...args);
        };
        sessionMiddleware(request, response, next);
    };
    const getHttpTabId = (request) => request.get('x-chat-tab-id');
    const getSocketTabId = (request) => request._query && request._query.tabId;
    const activeSocketIds = new Set();
    const activeSocketRooms = new Map();
    const activeSocketUsers = new Map();
    const roomChannel = (roomId) => `chatroom:${roomId}`;
    const roomKeys = (roomId) => ({
        players: `chat:${roomId}:players`,
        cells: `chat:${roomId}:cells`,
        tiles: `chat:${roomId}:tiles`
    });
    async function getAllRoomIds() {
        const { rows } = await pool.query('SELECT id FROM chat_apartments');
        return ['common', 'disco', ...rows.map((row) => `apartment:${row.id}`)];
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_users (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(18) NOT NULL,
            username_normalized VARCHAR(18) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            registration_ip_hash TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS real_name VARCHAR(80)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS profile_text VARCHAR(500)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS welcome_message VARCHAR(500)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS discord_name VARCHAR(64)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS interests VARCHAR(160)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS registration_ip_hash TEXT');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS total_online_ms BIGINT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS steam_name VARCHAR(256)');
    await pool.query('ALTER TABLE chat_users ALTER COLUMN steam_name TYPE VARCHAR(256)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS birth_date DATE');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS postal_code VARCHAR(4)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS region VARCHAR(32)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS accepted_chat_messages BIGINT NOT NULL DEFAULT 0');
    await pool.query(`
        CREATE SEQUENCE IF NOT EXISTS chat_apartment_number_seq START WITH 101
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_apartments (
            id BIGSERIAL PRIMARY KEY,
            room_type VARCHAR(16) NOT NULL DEFAULT 'apartment' CHECK (room_type = 'apartment'),
            owner_id BIGINT NOT NULL UNIQUE REFERENCES chat_users(id) ON DELETE CASCADE,
            apartment_number BIGINT NOT NULL UNIQUE DEFAULT nextval('chat_apartment_number_seq'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query("ALTER TABLE chat_apartments ADD COLUMN IF NOT EXISTS room_type VARCHAR(16) NOT NULL DEFAULT 'apartment'");
    await pool.query("ALTER TABLE chat_apartments ADD COLUMN IF NOT EXISTS layout_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query('ALTER TABLE chat_apartments ADD COLUMN IF NOT EXISTS apartment_name VARCHAR(60)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_users_registration_ip_hash_idx ON chat_users (registration_ip_hash) WHERE registration_ip_hash IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_online_sessions (
            socket_id TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            ip_hash TEXT,
            last_accounted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_online_sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_online_sessions_user_id_idx ON chat_online_sessions (user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_online_sessions_ip_hash_idx ON chat_online_sessions (ip_hash) WHERE ip_hash IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_profile_relationships (
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            target_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            relationship VARCHAR(8) NOT NULL CHECK (relationship IN ('friend', 'enemy')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, target_user_id),
            CHECK (user_id <> target_user_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_profile_mutes (
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            target_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, target_user_id),
            CHECK (user_id <> target_user_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_guestbook_entries (
            id BIGSERIAL PRIMARY KEY,
            profile_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            author_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            message VARCHAR(${GUESTBOOK_MESSAGE_MAX_LENGTH}) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_guestbook_profile_recent_idx ON chat_guestbook_entries (profile_user_id, id DESC)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_private_messages (
            id BIGSERIAL PRIMARY KEY,
            sender_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            recipient_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            subject VARCHAR(${PRIVATE_MAIL_SUBJECT_MAX_LENGTH}) NOT NULL,
            message VARCHAR(${PRIVATE_MAIL_MESSAGE_MAX_LENGTH}) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            read_at TIMESTAMPTZ,
            deleted_by_sender_at TIMESTAMPTZ,
            deleted_by_recipient_at TIMESTAMPTZ,
            CHECK (sender_user_id <> recipient_user_id)
        )
    `);
    await pool.query('ALTER TABLE chat_private_messages ADD COLUMN IF NOT EXISTS deleted_by_sender_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE chat_private_messages ADD COLUMN IF NOT EXISTS deleted_by_recipient_at TIMESTAMPTZ');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_private_messages_inbox_idx ON chat_private_messages (recipient_user_id, id DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_private_messages_sent_idx ON chat_private_messages (sender_user_id, id DESC)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            username VARCHAR(18) NOT NULL,
            message TEXT NOT NULL CHECK (char_length(message) <= ${MAX_MESSAGE_LENGTH}),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_recent_idx ON chat_messages (id DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_user_recent_idx ON chat_messages (user_id, id DESC)');

    await redisPublisher.connect();
    await redisSubscriber.connect();
    const publicRoomKeys = roomKeys('common');
    if (await redis.exists('chat:players') && !(await redis.exists(publicRoomKeys.players))) {
        await redis.rename('chat:players', publicRoomKeys.players);
    }
    if (await redis.exists('chat:cells') && !(await redis.exists(publicRoomKeys.cells))) {
        await redis.rename('chat:cells', publicRoomKeys.cells);
    }
    io.adapter(createAdapter(redisPublisher, redisSubscriber));
    app.set('trust proxy', 1);
    app.get('/health', (_request, response) => response.status(200).type('text/plain').send('ok'));
    app.use(express.static(path.join(__dirname, 'public')));
    app.use(express.json({ limit: '8kb' }));
    app.use(useTabSession(getHttpTabId));
    io.engine.use(useTabSession(getSocketTabId));

    const getRateLimitKey = (request) => {
        const address = request.ip || request.socket.remoteAddress || 'unknown';
        return `chat:auth-rate:${crypto.createHash('sha256').update(address).digest('hex')}`;
    };

    const enforceAuthRateLimit = async (request, response, next) => {
        try {
            const count = Number(await redis.eval(LOGIN_RATE_LIMIT_SCRIPT, {
                keys: [getRateLimitKey(request)],
                arguments: [String(LOGIN_ATTEMPT_WINDOW_SECONDS)]
            }));
            if (count > LOGIN_ATTEMPT_LIMIT) {
                response.status(429).json({ error: 'For mange forsøg. Prøv igen om 15 minutter.' });
                return;
            }
            next();
        } catch (error) {
            next(error);
        }
    };

    const getRequestTabId = (request) => request.get('x-chat-tab-id');

    async function getTotalOnlineMs(userId) {
        const { rows: [row] } = await pool.query(`
            SELECT
                u.total_online_ms::text AS total_online_ms,
                COALESCE(MAX(GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_accounted_at)) * 1000)
                )), 0)::text AS pending_online_ms
            FROM chat_users u
            LEFT JOIN chat_online_sessions s ON s.user_id = u.id
            WHERE u.id = $1
            GROUP BY u.id
        `, [userId]);
        if (!row) return 0;
        return Number(row.total_online_ms) + Number(row.pending_online_ms);
    }

    async function getApartmentForUser(userId) {
        const { rows: [apartment] } = await pool.query(
            'SELECT id, apartment_number FROM chat_apartments WHERE owner_id = $1',
            [userId]
        );
        return apartment || null;
    }

    async function accountOnlineSession(socketId, finish = false, accountedUntil = new Date()) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [targetSession] } = await client.query(
                'SELECT user_id FROM chat_online_sessions WHERE socket_id = $1', [socketId]
            );
            if (targetSession) {
                await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [targetSession.user_id]);
                const { rows: onlineSessions } = await client.query(`
                    SELECT socket_id, last_accounted_at
                    FROM chat_online_sessions
                    WHERE user_id = $1
                    ORDER BY socket_id
                    FOR UPDATE
                `, [targetSession.user_id]);
                if (!onlineSessions.some((row) => row.socket_id === socketId)) {
                    await client.query('COMMIT');
                    return false;
                }
                const previousAccountedAt = onlineSessions.reduce((earliest, row) =>
                    !earliest || new Date(row.last_accounted_at) < earliest
                        ? new Date(row.last_accounted_at)
                        : earliest, null);
                await client.query(`
                    UPDATE chat_users
                    SET total_online_ms = total_online_ms + GREATEST(
                        0,
                        FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - $3::timestamptz)) * 1000)::bigint
                    )
                    WHERE id = $1
                `, [targetSession.user_id, accountedUntil, previousAccountedAt]);
                await client.query(
                    'UPDATE chat_online_sessions SET last_accounted_at = $2 WHERE user_id = $1 AND last_accounted_at <= $2',
                    [targetSession.user_id, accountedUntil]
                );
                if (finish) {
                    await client.query('DELETE FROM chat_online_sessions WHERE socket_id = $1', [socketId]);
                }
            }
            await client.query('COMMIT');
            return Boolean(targetSession);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async function startOnlineSession(socketId, userId, ipHash) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`active-chat-ip:${ipHash}`]);
            await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [userId]);
            const { rows: [existingSession] } = await client.query(
                'SELECT socket_id FROM chat_online_sessions WHERE user_id = $1 LIMIT 1 FOR UPDATE',
                [userId]
            );
            if (existingSession) {
                const error = new Error('CHAT_ACCOUNT_ALREADY_ONLINE');
                error.code = 'CHAT_ACCOUNT_ALREADY_ONLINE';
                throw error;
            }
            const { rows: [onlineIpUsers] } = await client.query(
                'SELECT COUNT(DISTINCT user_id)::int AS count FROM chat_online_sessions WHERE ip_hash = $1',
                [ipHash]
            );
            if (onlineIpUsers.count >= 2) {
                const error = new Error('CHAT_IP_ACTIVE_USER_LIMIT');
                error.code = 'CHAT_IP_ACTIVE_USER_LIMIT';
                throw error;
            }
            await client.query(`
                INSERT INTO chat_online_sessions (socket_id, user_id, ip_hash, last_accounted_at)
                VALUES ($1, $2, $3, NOW())
            `, [socketId, userId, ipHash]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    const requireTabId = (request, response) => {
        const tabId = getRequestTabId(request);
        if (!isValidTabId(tabId)) {
            response.status(400).json({ error: 'Fanens session mangler. Genindlæs siden, og prøv igen.' });
            return null;
        }
        return tabId;
    };

    const saveAuthenticatedSession = async (request, user, tabId) => {
        await new Promise((resolve, reject) => {
            request.session.regenerate((error) => error ? reject(error) : resolve());
        });
        request.session.user = { id: user.id, username: user.username };
        request.session.tabId = tabId;
        request.session.ipHash = hashRegistrationIp(
            request.ip || request.socket.remoteAddress,
            SESSION_SECRET
        );
        await new Promise((resolve, reject) => {
            request.session.save((error) => error ? reject(error) : resolve());
        });
    };

    app.get('/api/auth/me', (request, response) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        response.json({ user: request.session.user });
    });

    const OWN_PROFILE_COLUMNS = 'real_name, profile_text, welcome_message, discord_name, interests, steam_name, birth_date::text AS birth_date, region';

    function serializeOwnProfile(row) {
        return {
            realName: row.real_name || '',
            profileText: row.profile_text || '',
            welcomeMessage: row.welcome_message || '',
            discordName: row.discord_name || '',
            interests: row.interests || '',
            steamName: row.steam_name || '',
            birthDate: row.birth_date || '',
            region: row.region || '',
            regions: getDanishRegions()
        };
    }

    app.get('/api/profile', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        try {
            const { rows: [profile] } = await pool.query(
                `SELECT ${OWN_PROFILE_COLUMNS}, created_at, last_login_at,
                        (SELECT apartment_number FROM chat_apartments WHERE owner_id = chat_users.id) AS apartment_number
                 FROM chat_users WHERE id = $1`,
                [request.session.user.id]
            );
            if (!profile) {
                response.status(404).json({ error: 'Profilen blev ikke fundet.' });
                return;
            }
            response.json({
                ...serializeOwnProfile(profile),
                apartmentNumber: profile.apartment_number ? Number(profile.apartment_number) : null,
                createdAt: profile.created_at,
                lastLoginAt: profile.last_login_at
            });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/profile/password', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        const currentPassword = request.body && request.body.currentPassword;
        const newPassword = request.body && request.body.newPassword;
        if (!isValidPassword(currentPassword) || !isValidPassword(newPassword)) {
            response.status(400).json({ error: 'Adgangskoder skal være 8–72 UTF-8-bytes.' });
            return;
        }
        if (currentPassword === newPassword) {
            response.status(400).json({ error: 'Den nye adgangskode skal være anderledes end den nuværende.' });
            return;
        }
        try {
            const { rows: [account] } = await pool.query(
                'SELECT password_hash FROM chat_users WHERE id = $1',
                [request.session.user.id]
            );
            if (!account || !(await bcrypt.compare(currentPassword, account.password_hash))) {
                response.status(400).json({ error: 'Den nuværende adgangskode er forkert.' });
                return;
            }
            const passwordHash = await bcrypt.hash(newPassword, 12);
            await pool.query(
                'UPDATE chat_users SET password_hash = $1 WHERE id = $2',
                [passwordHash, request.session.user.id]
            );
            response.json({ success: true });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/profile/welcome', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        const welcomeMessage = request.body && request.body.welcomeMessage;
        if (typeof welcomeMessage !== 'string' || welcomeMessage.length > 500) {
            response.status(400).json({ error: 'Velkomstteksten må højst være 500 tegn.' });
            return;
        }
        try {
            await pool.query(
                'UPDATE chat_users SET welcome_message = $1 WHERE id = $2',
                [welcomeMessage.trim(), request.session.user.id]
            );
            const { rows: [apartment] } = await pool.query(
                'SELECT a.id, a.apartment_number, a.apartment_name, u.username FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id WHERE a.owner_id = $1',
                [request.session.user.id]
            );
            if (apartment) {
                io.to(roomChannel(`apartment:${apartment.id}`)).emit('room-welcome-updated', {
                    welcomeTitle: `Velkommen i ${getApartmentRoomName(apartment)}`,
                    welcomeText: welcomeMessage.trim() || `${apartment.username} har ikke skrevet en velkomst endnu.`
                });
            }
            response.json({ success: true, welcomeMessage: welcomeMessage.trim() });
        } catch (error) {
            next(error);
        }
    });

    app.put('/api/profile', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        const regionValue = request.body && request.body.region !== undefined ? request.body.region : '';
        if (typeof regionValue !== 'string') {
            response.status(400).json({ error: 'Vælg en gyldig dansk region.' });
            return;
        }
        const requestedRegion = regionValue.trim();
        if (requestedRegion && !getDanishRegions().includes(requestedRegion)) {
            response.status(400).json({ error: 'Vælg en gyldig dansk region.' });
            return;
        }
        const profile = normalizePublicProfile({ ...request.body, postalCode: '' });
        if (!profile) {
            response.status(400).json({ error: 'Profilen indeholder ugyldige felter eller overskrider tegnbegrænsningen.' });
            return;
        }
        try {
            const result = await pool.query(
                `UPDATE chat_users
                 SET real_name = $1, profile_text = $2, discord_name = $3, interests = $4,
                     steam_name = $5, birth_date = $6, region = $7
                 WHERE id = $8
                 RETURNING ${OWN_PROFILE_COLUMNS}`,
                [
                    profile.realName || null,
                    profile.profileText || null,
                    profile.discordName || null,
                    profile.interests || null,
                    profile.steamName || null,
                    profile.birthDate || null,
                    requestedRegion || null,
                    request.session.user.id
                ]
            );
            if (!result.rowCount) {
                response.status(404).json({ error: 'Profilen blev ikke fundet.' });
                return;
            }
            response.json(serializeOwnProfile(result.rows[0]));
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/register', enforceAuthRateLimit, async (request, response, next) => {
        const tabId = requireTabId(request, response);
        if (!tabId) return;
        const account = normalizeUsername(request.body && request.body.username);
        const password = request.body && request.body.password;
        if (!account) {
            response.status(400).json({ error: 'Brugernavnet skal være 3–18 tegn: bogstaver, tal, punktum, bindestreg eller underscore.' });
            return;
        }
        if (redactSecrets(account.username) !== account.username) {
            response.status(400).json({ error: 'Brugernavnet må ikke indeholde adgangskoder eller hemmelige nøgler.' });
            return;
        }
        if (!isValidPassword(password)) {
            response.status(400).json({ error: 'Adgangskoden skal være 8–72 UTF-8-bytes.' });
            return;
        }
        if (account.username !== request.body.username.trim()) {
            response.status(400).json({ error: 'Brugernavnet indeholder følsomme eller ugyldige tegn.' });
            return;
        }

        try {
            const registrationIpHash = hashRegistrationIp(
                request.ip || request.socket.remoteAddress,
                SESSION_SECRET
            );
            const passwordHash = await bcrypt.hash(password, 12);
            const client = await pool.connect();
            let user;
            let transactionStarted = false;
            try {
                await client.query('BEGIN');
                transactionStarted = true;
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [registrationIpHash]);
                const { rows: [accountCount] } = await client.query(
                    'SELECT COUNT(*)::int AS count FROM chat_users WHERE registration_ip_hash = $1',
                    [registrationIpHash]
                );
                if (accountCount.count >= MAX_ACCOUNTS_PER_IP) {
                    await client.query('ROLLBACK');
                    response.status(429).json({ error: 'Der kan højst oprettes 2 brugere fra samme IP-adresse.' });
                    return;
                }
                const result = await client.query(
                    'INSERT INTO chat_users (username, username_normalized, password_hash, registration_ip_hash, last_login_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, username',
                    [account.username, account.normalized, passwordHash, registrationIpHash]
                );
                await client.query('COMMIT');
                user = { id: result.rows[0].id, username: result.rows[0].username };
            } catch (error) {
                if (transactionStarted) await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
            await saveAuthenticatedSession(request, user, tabId);
            response.status(201).json({ user });
        } catch (error) {
            if (error.code === '23505') {
                response.status(409).json({ error: 'Brugernavnet er allerede i brug.' });
                return;
            }
            next(error);
        }
    });

    app.post('/api/auth/login', enforceAuthRateLimit, async (request, response, next) => {
        const tabId = requireTabId(request, response);
        if (!tabId) return;
        const account = normalizeUsername(request.body && request.body.username);
        const password = request.body && request.body.password;
        if (!account || !isValidPassword(password)) {
            response.status(401).json({ error: 'Forkert brugernavn eller adgangskode.' });
            return;
        }

        try {
            const result = await pool.query(
                'SELECT id, username, password_hash FROM chat_users WHERE username_normalized = $1',
                [account.normalized]
            );
            const userRecord = result.rows[0];
            const passwordMatches = await bcrypt.compare(
                password,
                userRecord ? userRecord.password_hash : DUMMY_PASSWORD_HASH
            );
            if (!userRecord || !passwordMatches) {
                response.status(401).json({ error: 'Forkert brugernavn eller adgangskode.' });
                return;
            }

            const user = { id: userRecord.id, username: userRecord.username };
            await saveAuthenticatedSession(request, user, tabId);
            await pool.query('UPDATE chat_users SET last_login_at = NOW() WHERE id = $1', [user.id]);
            await redis.del(getRateLimitKey(request));
            response.json({ user });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/logout', (request, response, next) => {
        const tabId = getRequestTabId(request);
        if (!isAuthorizedTabSession(request.session, tabId)) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        const sessionId = request.sessionID;
        request.session.destroy((error) => {
            if (error) {
                next(error);
                return;
            }
            response.clearCookie('chat.sid', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            });
            if (sessionId) io.in(`session:${sessionId}`).disconnectSockets(true);
            response.status(204).end();
        });
    });

    app.use((error, request, response, next) => {
        console.error('Request failed:', getSafeErrorCode(error));
        if (response.headersSent) {
            next(error);
            return;
        }
        response.status(500).json({ error: 'Der opstod en serverfejl. Prøv igen senere.' });
    });

    io.use((socket, next) => {
        const session = socket.request.session;
        const tabId = socket.handshake.auth && socket.handshake.auth.tabId;
        if (!isAuthorizedTabSession(session, tabId)) {
            next(new Error('Log ind for at fortsætte.'));
            return;
        }
        socket.data.user = session.user;
        socket.data.tabId = tabId;
        socket.data.sessionId = socket.request.sessionID;
        const forwardedAddresses = String(socket.request.headers['x-forwarded-for'] || '')
            .split(',').map((address) => address.trim()).filter(Boolean);
        socket.data.ipHash = session.ipHash || hashRegistrationIp(
            forwardedAddresses.at(-1) || socket.handshake.address || socket.request.socket.remoteAddress,
            SESSION_SECRET
        );
        next();
    });

    io.use((socket, next) => {
        socket.use((packet, continuePacket) => {
            sessionStore.get(socket.request.sessionID, (error, storedSession) => {
                if (error) {
                    continuePacket(error);
                    return;
                }
                if (
                    !storedSession ||
                    !storedSession.user ||
                    storedSession.user.id !== socket.data.user.id ||
                    storedSession.tabId !== socket.data.tabId
                ) {
                    socket.disconnect(true);
                    return;
                }
                continuePacket();
            });
        });
        next();
    });

    async function cleanupStalePlayers(roomId = null) {
        const roomIds = roomId ? [roomId] : await getAllRoomIds();
        for (const currentRoomId of roomIds) {
            const keys = roomKeys(currentRoomId);
            const removedIds = await redis.eval(CLEAN_STALE_PLAYERS_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [String(Date.now() - PRESENCE_EXPIRY)]
            });
            for (const id of removedIds) {
                activeSocketIds.delete(id);
                activeSocketRooms.delete(id);
                activeSocketUsers.delete(id);
                try {
                    await accountOnlineSession(id, true, new Date(Date.now() - PRESENCE_EXPIRY));
                } catch (error) {
                    console.error('Could not account for expired chat session:', getSafeErrorCode(error));
                }
                io.to(roomChannel(currentRoomId)).emit('playerDisconnected', id);
            }
            if (removedIds.length > 0) io.emit('navigator-refresh');
        }
        await cleanupOrphanedOnlineSessions();
    }

    async function cleanupOrphanedOnlineSessions() {
        const [roomIds, { rows: onlineSessions }] = await Promise.all([
            getAllRoomIds(), pool.query('SELECT socket_id, last_accounted_at FROM chat_online_sessions')
        ]);
        const playerIds = new Set();
        for (const roomId of roomIds) {
            Object.keys(await redis.hGetAll(roomKeys(roomId).players)).forEach((id) => playerIds.add(id));
        }
        for (const onlineSession of onlineSessions) {
            if (playerIds.has(onlineSession.socket_id)) continue;
            const lastAccountedAt = new Date(onlineSession.last_accounted_at).getTime();
            const maxAccountedAt = Math.min(Date.now(), lastAccountedAt + ONLINE_TIME_ACCOUNTING_INTERVAL);
            try {
                await accountOnlineSession(onlineSession.socket_id, true, new Date(maxAccountedAt));
            } catch (error) {
                console.error('Could not close orphaned online-time session:', getSafeErrorCode(error));
            }
        }
    }

    async function invalidateSocketSession(socketId) {
        const sockets = await io.in(socketId).fetchSockets();
        const sessionIds = new Set(
            sockets
                .map((socket) => socket.data.sessionId)
                .filter((sessionId) => typeof sessionId === 'string' && sessionId)
        );
        for (const sessionId of sessionIds) {
            await new Promise((resolve, reject) => {
                sessionStore.destroy(sessionId, (error) => error ? reject(error) : resolve());
            });
        }
    }

    async function kickIdlePlayers() {
        for (const roomId of await getAllRoomIds()) {
            const keys = roomKeys(roomId);
            const removedIds = await redis.eval(KICK_IDLE_PLAYERS_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [String(Date.now() - PLAYER_IDLE_TIMEOUT)]
            });
            for (const id of removedIds) {
            activeSocketIds.delete(id);
            activeSocketRooms.delete(id);
            activeSocketUsers.delete(id);
            try {
                await accountOnlineSession(id, true);
            } catch (error) {
                console.error('Could not account for inactive chat session:', getSafeErrorCode(error));
            }
            try {
                await invalidateSocketSession(id);
            } catch (error) {
                console.error('Could not invalidate inactive participant session:', getSafeErrorCode(error));
            }
            io.to(id).emit('session-kicked', { message: 'Du blev fjernet fra rummet efter 20 minutters inaktivitet.' });
            io.to(roomChannel(roomId)).emit('playerDisconnected', id);
            io.emit('navigator-refresh');
            setTimeout(() => io.in(id).disconnectSockets(true), 100);
            }
        }
    }

    async function kickPlayer(socketId, message) {
        const roomId = activeSocketRooms.get(socketId) || 'common';
        const keys = roomKeys(roomId);
        activeSocketIds.delete(socketId);
        activeSocketRooms.delete(socketId);
        activeSocketUsers.delete(socketId);
        try {
            const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [socketId]
            });
            if (removed) {
                io.to(roomChannel(roomId)).emit('playerDisconnected', socketId);
                io.emit('navigator-refresh');
            }
        } catch (error) {
            console.error('Could not remove kicked chat participant:', getSafeErrorCode(error));
        }
        try {
            await accountOnlineSession(socketId, true);
        } catch (error) {
            console.error('Could not account for kicked chat session:', getSafeErrorCode(error));
        }
        try {
            await invalidateSocketSession(socketId);
        } catch (error) {
            console.error('Could not invalidate kicked participant session:', getSafeErrorCode(error));
        }
        io.to(socketId).emit('session-kicked', { message });
        setTimeout(() => io.in(socketId).disconnectSockets(true), 100);
    }

    async function getPlayers(roomId = 'common') {
        await cleanupStalePlayers(roomId);
        return getPublicPlayers(await redis.hGetAll(roomKeys(roomId).players));
    }

    function getMissingTargetMessage(targetId) {
        return targetId.startsWith(OFFLINE_PROFILE_PREFIX)
            ? 'Brugeren findes ikke længere.'
            : 'Brugeren er ikke længere i rummet.';
    }

    async function getProfileTarget(playerId, roomId = 'common') {
        if (typeof playerId !== 'string' || playerId.length > 128) return null;
        const accountMatch = /^user:([1-9]\d{0,18})$/.exec(playerId);
        if (accountMatch) {
            const { rows: [profile] } = await pool.query(
                'SELECT id, username, real_name, profile_text, discord_name, interests, steam_name, birth_date::text AS birth_date, region, created_at, last_login_at FROM chat_users WHERE id = $1',
                [accountMatch[1]]
            );
            return profile ? { player: null, profile } : null;
        }
        const playerJson = await redis.hGet(roomKeys(roomId).players, playerId);
        if (!playerJson) return null;
        const player = JSON.parse(playerJson);
        const account = normalizeUsername(player.name);
        if (!account) return null;
        const { rows: [profile] } = await pool.query(
            'SELECT id, username, real_name, profile_text, discord_name, interests, steam_name, birth_date::text AS birth_date, region, created_at, last_login_at FROM chat_users WHERE username_normalized = $1',
            [account.normalized]
        );
        return profile ? { player, profile } : null;
    }

    async function isValidRoomId(roomId) {
        if (roomId === 'common' || roomId === 'disco') return true;
        const match = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
        if (!match) return false;
        const { rowCount } = await pool.query('SELECT 1 FROM chat_apartments WHERE id = $1', [match[1]]);
        return rowCount > 0;
    }

    async function canEditApartmentRoom(userId, roomId) {
        const match = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
        if (!match) return false;
        const { rowCount } = await pool.query(
            'SELECT 1 FROM chat_apartments WHERE id = $1 AND owner_id = $2',
            [match[1], userId]
        );
        return rowCount > 0;
    }

    async function loadApartmentTiles(roomId) {
        const match = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
        if (!match) {
            const defaults = Object.fromEntries([...DEFAULT_CLOSED_CELL_KEYS].map((cell) => [cell, 'closed']));
            const tilesKey = roomKeys(roomId).tiles;
            await redis.del(tilesKey);
            if (Object.keys(defaults).length) await redis.hSet(tilesKey, defaults);
            return defaults;
        }
        const { rows: [apartment] } = await pool.query(
            'SELECT layout_json FROM chat_apartments WHERE id = $1',
            [match[1]]
        );
        if (!apartment) return {};
        const tiles = normalizeApartmentTiles(apartment.layout_json);
        const tilesKey = roomKeys(roomId).tiles;
        await redis.del(tilesKey);
        if (Object.keys(tiles).length) await redis.hSet(tilesKey, tiles);
        return tiles;
    }

    async function getRoomWelcome(roomId) {
        if (roomId.startsWith('apartment:')) {
            const { rows: [apartment] } = await pool.query(`
                SELECT a.apartment_number, a.apartment_name, u.username, u.welcome_message
                FROM chat_apartments a
                JOIN chat_users u ON u.id = a.owner_id
                WHERE a.id = $1
            `, [roomId.slice('apartment:'.length)]);
            if (apartment) {
                return {
                    welcomeTitle: `Velkommen i ${getApartmentRoomName(apartment)}`,
                    welcomeText: apartment.welcome_message || `${apartment.username} har ikke skrevet en velkomst endnu.`
                };
            }
        }
        const roomName = PUBLIC_ROOM_NAMES[roomId] || 'chatten';
        return {
            welcomeTitle: `Velkommen i ${roomName}`,
            welcomeText: 'Her kan du møde andre og chatte sammen. God fornøjelse!'
        };
    }

    async function placeSocketInRoom(socket, roomId) {
        const keys = roomKeys(roomId);
        const apartmentTiles = await loadApartmentTiles(roomId);
        const joined = await redis.eval(PLAYER_JOIN_SCRIPT, {
            keys: [keys.players, keys.cells, keys.tiles],
            arguments: [socket.id, socket.data.user.username, String(Date.now()),
                ...GRID_CELLS.map((cell) => `${cell.col}:${cell.row}`)]
        });
        if (!joined) return null;
        const previousRoom = activeSocketRooms.get(socket.id);
        if (previousRoom && previousRoom !== roomId) {
            const previousKeys = roomKeys(previousRoom);
            await redis.eval(REMOVE_PLAYER_SCRIPT, { keys: [previousKeys.players, previousKeys.cells], arguments: [socket.id] });
            socket.leave(roomChannel(previousRoom));
            io.to(roomChannel(previousRoom)).emit('playerDisconnected', socket.id);
        }
        activeSocketRooms.set(socket.id, roomId);
        socket.data.roomId = roomId;
        await socket.join(roomChannel(roomId));
        const players = await getPlayers(roomId);
        for (const player of Object.values(players)) {
            player.text = '';
            player.messageTime = 0;
        }
        let roomName = PUBLIC_ROOM_NAMES[roomId] || 'Lejlighed';
        if (roomId.startsWith('apartment:')) {
            const { rows: [apartment] } = await pool.query(`
                SELECT u.username, a.apartment_number, a.apartment_name FROM chat_apartments a
                JOIN chat_users u ON u.id = a.owner_id WHERE a.id = $1
            `, [roomId.slice('apartment:'.length)]);
            if (apartment) roomName = getApartmentRoomName(apartment);
        }
        const [welcome, canEditApartment] = await Promise.all([
            getRoomWelcome(roomId),
            canEditApartmentRoom(socket.data.user.id, roomId)
        ]);
        socket.emit('room-changed', { roomId, roomName, players, apartmentTiles, canEditApartment, ...welcome });
        socket.to(roomChannel(roomId)).emit('newPlayer', publicPlayer(JSON.parse(joined)));
        io.emit('navigator-refresh');
        return publicPlayer(JSON.parse(joined));
    }

    async function moveSocketNearTarget(socket, roomId, targetSocketId) {
        const keys = roomKeys(roomId);
        const targetJson = await redis.hGet(keys.players, targetSocketId);
        if (!targetJson) return false;
        const target = JSON.parse(targetJson);
        const nearbyCells = GRID_CELLS
            .filter((cell) => cell.col !== target.col || cell.row !== target.row)
            .slice()
            .sort((first, second) => {
                const firstDistance = Math.max(Math.abs(first.col - target.col), Math.abs(first.row - target.row));
                const secondDistance = Math.max(Math.abs(second.col - target.col), Math.abs(second.row - target.row));
                return firstDistance - secondDistance
                    || Math.abs(first.col - target.col) + Math.abs(first.row - target.row)
                    - Math.abs(second.col - target.col) - Math.abs(second.row - target.row);
            });

        for (const cell of nearbyCells) {
            const movedJson = await redis.eval(PLAYER_MOVE_SCRIPT, {
                keys: [keys.players, keys.cells, keys.tiles],
                arguments: [socket.id, String(cell.col), String(cell.row), String(Date.now())]
            });
            if (!movedJson) continue;
            const player = publicPlayer(JSON.parse(movedJson));
            io.to(roomChannel(roomId)).emit('playerMoved', { id: player.id, col: player.col, row: player.row });
            return true;
        }
        return false;
    }

    io.on('connection', (socket) => {
        socket.join(`session:${socket.request.sessionID}`);
        socket.on('room-switch', async (payload = {}) => {
            if (!activeSocketIds.has(socket.id) || socket.data.switchingRoom) return;
            const roomId = String(payload.roomId || '');
            if (!await isValidRoomId(roomId)) return;
            socket.data.switchingRoom = true;
            try {
                const apartmentMatch = /^apartment:([1-9]\d{0,18})$/.exec(roomId);
                if (apartmentMatch) {
                    const { rows: [apartment] } = await pool.query('SELECT owner_id FROM chat_apartments WHERE id = $1', [apartmentMatch[1]]);
                    if (!apartment) return;
                    if (String(apartment.owner_id) !== String(socket.data.user.id)) {
                        const admissionKey = `chat:apartment-admission:${socket.id}:${apartment.id}`;
                        const admission = await redis.getDel(admissionKey);
                        if (!admission) {
                            socket.emit('room-error', { message: 'Du skal banke på og blive lukket ind først.' });
                            return;
                        }
                    }
                }
                const moved = await placeSocketInRoom(socket, roomId);
                if (!moved) socket.emit('room-error', { message: 'Rummet er fyldt. Prøv igen senere.' });
            } catch (error) {
                console.error('Could not switch chat room:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Kunne ikke skifte rum. Prøv igen.' });
            } finally {
                socket.data.switchingRoom = false;
            }
        });

        socket.on('apartment-kick-option-request', async ({ targetPlayerId } = {}) => {
            if (!activeSocketIds.has(socket.id) || typeof targetPlayerId !== 'string' || targetPlayerId.length > 128) return;
            const roomId = activeSocketRooms.get(socket.id);
            const apartmentMatch = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
            if (!apartmentMatch || targetPlayerId === socket.id || !activeSocketIds.has(targetPlayerId)
                || activeSocketRooms.get(targetPlayerId) !== roomId) return;
            try {
                const { rows: [apartment] } = await pool.query(
                    'SELECT owner_id FROM chat_apartments WHERE id = $1', [apartmentMatch[1]]
                );
                if (!apartment || String(apartment.owner_id) !== String(socket.data.user.id)
                    || activeSocketRooms.get(socket.id) !== roomId
                    || activeSocketRooms.get(targetPlayerId) !== roomId
                    || !activeSocketIds.has(targetPlayerId)
                    || String(activeSocketUsers.get(targetPlayerId)) === String(apartment.owner_id)) return;
                socket.emit('apartment-kick-option', { targetPlayerId, roomId });
            } catch (error) {
                console.error('Could not verify apartment kick option:', getSafeErrorCode(error));
            }
        });

        socket.on('apartment-guest-kick', async ({ targetPlayerId } = {}) => {
            if (!activeSocketIds.has(socket.id) || socket.data.switchingRoom
                || typeof targetPlayerId !== 'string' || targetPlayerId.length > 128) return;
            const roomId = activeSocketRooms.get(socket.id);
            const apartmentMatch = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
            const targetSocket = io.sockets.sockets.get(targetPlayerId);
            if (!apartmentMatch || !targetSocket || targetPlayerId === socket.id
                || !activeSocketIds.has(targetPlayerId) || activeSocketRooms.get(targetPlayerId) !== roomId
                || targetSocket.data.switchingRoom) return;

            try {
                const { rows: [apartment] } = await pool.query(
                    'SELECT owner_id FROM chat_apartments WHERE id = $1', [apartmentMatch[1]]
                );
                if (!apartment || String(apartment.owner_id) !== String(socket.data.user.id)
                    || activeSocketRooms.get(socket.id) !== roomId
                    || activeSocketRooms.get(targetPlayerId) !== roomId
                    || !activeSocketIds.has(targetPlayerId)
                    || io.sockets.sockets.get(targetPlayerId) !== targetSocket
                    || targetSocket.data.switchingRoom
                    || String(activeSocketUsers.get(targetPlayerId)) === String(apartment.owner_id)) return;

                targetSocket.data.switchingRoom = true;
                try {
                    const publicRooms = ['common', 'disco'];
                    if (crypto.randomInt(2) === 1) publicRooms.reverse();
                    let destination = '';
                    for (const publicRoomId of publicRooms) {
                        if (await placeSocketInRoom(targetSocket, publicRoomId)) {
                            destination = PUBLIC_ROOM_NAMES[publicRoomId];
                            break;
                        }
                    }
                    if (!destination) {
                        socket.emit('apartment-kick-result', { message: 'De offentlige rum er fyldt. Prøv igen senere.' });
                        return;
                    }
                    const message = `${targetSocket.data.user.username} blev sendt til ${destination}.`;
                    socket.emit('apartment-kick-result', { message });
                    targetSocket.emit('apartment-kick-notice', { message: `Lejlighedens ejer har sendt dig til ${destination}.` });
                } finally {
                    targetSocket.data.switchingRoom = false;
                }
            } catch (error) {
                console.error('Could not remove guest from apartment:', getSafeErrorCode(error));
                socket.emit('apartment-kick-result', { message: 'Gæsten kunne ikke sendes ud. Prøv igen.' });
            }
        });

        socket.on('apartment-layout-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            const roomId = activeSocketRooms.get(socket.id);
            try {
                if (!await canEditApartmentRoom(socket.data.user.id, roomId)) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Du kan kun indrette din egen lejlighed, når du er der.' });
                    return;
                }
                const tiles = await loadApartmentTiles(roomId);
                const { rows: [apartment] } = await pool.query(
                    'SELECT a.apartment_name, a.apartment_number, u.username, u.welcome_message FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id WHERE a.id = $1',
                    [roomId.slice('apartment:'.length)]
                );
                socket.emit('apartment-layout-data', {
                    roomId,
                    tiles,
                    name: apartment?.apartment_name || '',
                    welcomeMessage: apartment?.welcome_message || '',
                    roomName: apartment ? getApartmentRoomName(apartment) : ''
                });
            } catch (error) {
                console.error('Could not load apartment tiles:', getSafeErrorCode(error));
                socket.emit('apartment-layout-result', { success: false, message: 'Lejligheden kunne ikke indlæses.' });
            }
        });

        socket.on('apartment-door-options-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!await canEditApartmentRoom(socket.data.user.id, roomId)) return;
            socket.emit('apartment-door-options', {
                roomId,
                rooms: [
                    { id: 'common', name: PUBLIC_ROOM_NAMES.common },
                    { id: 'disco', name: PUBLIC_ROOM_NAMES.disco }
                ]
            });
        });

        socket.on('apartment-door-use', async ({ col, row } = {}) => {
            if (!activeSocketIds.has(socket.id) || !Number.isInteger(col) || !Number.isInteger(row)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!String(roomId || '').startsWith('apartment:') || !GRID_CELL_KEYS.has(`${col}:${row}`)) return;
            try {
                const state = await redis.hGet(roomKeys(roomId).tiles, `${col}:${row}`);
                const tile = parseApartmentTileState(state);
                const destination = tile?.kind === 'door' ? tile.destination : '';
                if (!['common', 'disco'].includes(destination) && !/^apartment:[1-9]\d{0,18}$/.test(destination)) {
                    socket.emit('room-error', { message: 'Der er ingen dør på det felt.' });
                    return;
                }
                if (destination.startsWith('apartment:')) {
                    const apartmentId = destination.slice('apartment:'.length);
                    const { rowCount } = await pool.query('SELECT 1 FROM chat_apartments WHERE id = $1', [apartmentId]);
                    if (!rowCount) {
                        socket.emit('room-error', { message: 'Døren fører ikke længere til en eksisterende lejlighed.' });
                        return;
                    }
                }
                socket.emit('apartment-door-destination', { roomId: destination });
            } catch (error) {
                console.error('Could not use apartment door:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Døren kunne ikke bruges. Prøv igen.' });
            }
        });

        socket.on('apartment-layout-save', async ({ tiles: requestedTiles, name: requestedName, welcomeMessage: requestedWelcomeMessage } = {}) => {
            if (!activeSocketIds.has(socket.id) || !Array.isArray(requestedTiles) || requestedTiles.length > GRID_CELLS.length) return;
            const roomId = activeSocketRooms.get(socket.id);
            try {
                if (!await canEditApartmentRoom(socket.data.user.id, roomId)) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Du kan kun indrette din egen lejlighed, når du er der.' });
                    return;
                }
                if (typeof requestedName !== 'string' || requestedName.trim().length > 60) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Lejlighedens navn må højst være 60 tegn.' });
                    return;
                }
                const apartmentName = requestedName.trim();
                let welcomeMessage = requestedWelcomeMessage;
                if (welcomeMessage === undefined) {
                    const { rows: [owner] } = await pool.query(
                        'SELECT welcome_message FROM chat_users WHERE id = $1',
                        [socket.data.user.id]
                    );
                    welcomeMessage = owner?.welcome_message || '';
                }
                if (typeof welcomeMessage !== 'string' || welcomeMessage.length > 500) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Velkomstteksten må højst være 500 tegn.' });
                    return;
                }
                welcomeMessage = welcomeMessage.trim();
                const nextTiles = {};
                const seenTiles = new Set();
                for (const tile of requestedTiles) {
                    const parsedState = tile && parseApartmentTileState(tile.state);
                    if (!tile || !Number.isInteger(tile.col) || !Number.isInteger(tile.row)
                        || !parsedState) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Lejlighedsplanen indeholder ugyldige felter.' });
                        return;
                    }
                    const key = `${tile.col}:${tile.row}`;
                    if (!GRID_CELL_KEYS.has(key) || seenTiles.has(key)) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Lejlighedsplanen indeholder ugyldige eller gentagne felter.' });
                        return;
                    }
                    seenTiles.add(key);
                    const normalizedState = serializeApartmentTileState(parsedState);
                    if (DEFAULT_CLOSED_CELL_KEYS.has(key) && parsedState.kind === 'floor') {
                        nextTiles[key] = parsedState.color ? `open|${parsedState.color}` : 'open';
                    } else if (normalizedState) nextTiles[key] = normalizedState;
                }
                const doorApartmentIds = [...new Set(Object.values(nextTiles)
                    .map(parseApartmentTileState)
                    .filter((tile) => tile?.kind === 'door' && tile.destination.startsWith('apartment:'))
                    .map((tile) => tile.destination.slice('apartment:'.length)))];
                if (doorApartmentIds.length) {
                    const { rows: destinations } = await pool.query(
                        'SELECT id FROM chat_apartments WHERE id = ANY($1::bigint[]) AND id <> $2',
                        [doorApartmentIds, roomId.slice('apartment:'.length)]
                    );
                    if (destinations.length !== doorApartmentIds.length) {
                        socket.emit('apartment-layout-result', { success: false, message: 'En dør peger på en lejlighed, der ikke findes.' });
                        return;
                    }
                }
                if (Object.values(nextTiles).filter((state) => parseApartmentTileState(state)?.kind === 'closed').length >= GRID_CELLS.length) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Mindst ét felt skal være åbent eller en dør, så man kan komme ind.' });
                    return;
                }
                const keys = roomKeys(roomId);
                for (const [cell, state] of Object.entries(nextTiles)) {
                    if (parseApartmentTileState(state)?.kind === 'closed' && await redis.hGet(keys.cells, cell)) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Flyt først brugeren væk fra det felt, du vil lukke.' });
                        return;
                    }
                }
                const apartmentId = roomId.slice('apartment:'.length);
                const databaseClient = await pool.connect();
                let update;
                try {
                    await databaseClient.query('BEGIN');
                    update = await databaseClient.query(
                        'UPDATE chat_apartments SET layout_json = $1::jsonb, apartment_name = $2 WHERE id = $3 AND owner_id = $4',
                        [JSON.stringify(nextTiles), apartmentName || null, apartmentId, socket.data.user.id]
                    );
                    if (!update.rowCount) {
                        await databaseClient.query('ROLLBACK');
                        socket.emit('apartment-layout-result', { success: false, message: 'Lejligheden blev ikke fundet.' });
                        return;
                    }
                    await databaseClient.query(
                        'UPDATE chat_users SET welcome_message = $1 WHERE id = $2',
                        [welcomeMessage, socket.data.user.id]
                    );
                    await databaseClient.query('COMMIT');
                } catch (error) {
                    await databaseClient.query('ROLLBACK').catch(() => {});
                    throw error;
                } finally {
                    databaseClient.release();
                }
                await redis.del(keys.tiles);
                if (Object.keys(nextTiles).length) await redis.hSet(keys.tiles, nextTiles);
                const { rows: [apartment] } = await pool.query(
                    'SELECT a.apartment_name, a.apartment_number, u.username, u.welcome_message FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id WHERE a.id = $1',
                    [apartmentId]
                );
                const roomName = apartment ? getApartmentRoomName(apartment) : '';
                const updatePayload = {
                    roomId,
                    tiles: nextTiles,
                    name: apartmentName,
                    welcomeMessage,
                    roomName,
                    welcomeTitle: roomName ? `Velkommen i ${roomName}` : 'Velkommen i lejligheden',
                    welcomeText: apartment?.welcome_message || `${apartment?.username || 'Ejeren'} har ikke skrevet en velkomst endnu.`
                };
                io.to(roomChannel(roomId)).emit('apartment-layout-updated', updatePayload);
                io.emit('navigator-refresh');
                socket.emit('apartment-layout-result', { success: true, message: 'Lejligheden er gemt.', ...updatePayload });
            } catch (error) {
                console.error('Could not save apartment tiles:', getSafeErrorCode(error));
                socket.emit('apartment-layout-result', { success: false, message: 'Lejligheden kunne ikke gemmes.' });
            }
        });

        socket.on('navigator-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                await cleanupStalePlayers();
                const rooms = [
                    { id: 'common', name: PUBLIC_ROOM_NAMES.common, type: 'public' },
                    { id: 'disco', name: PUBLIC_ROOM_NAMES.disco, type: 'public' }
                ];
                const { rows: apartments } = await pool.query(`
                    SELECT DISTINCT a.id, a.apartment_number, a.apartment_name, u.username
                    FROM chat_apartments a
                    JOIN chat_users u ON u.id = a.owner_id
                    JOIN chat_online_sessions s ON s.user_id = a.owner_id
                    ORDER BY a.apartment_number
                `);
                for (const apartment of apartments) {
                    const id = `apartment:${apartment.id}`;
                    const presentCount = await redis.hLen(roomKeys(id).players);
                    rooms.push({
                        id,
                        name: getApartmentRoomName(apartment),
                        type: 'apartment',
                        count: presentCount,
                        ownerUsername: apartment.username,
                        apartmentNumber: Number(apartment.apartment_number)
                    });
                }
                socket.emit('navigator-rooms', { rooms, activeRoomId: socket.data.roomId || 'common' });
            } catch (error) {
                console.error('Could not list navigator rooms:', getSafeErrorCode(error));
                socket.emit('navigator-rooms', { rooms: [], error: 'Rumlisten kunne ikke hentes.' });
            }
        });

        socket.on('online-users-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                await cleanupStalePlayers();
                const [roomIds, { rows: apartments }] = await Promise.all([
                    getAllRoomIds(),
                    pool.query(`
                        SELECT a.id, a.apartment_number, a.apartment_name, u.username
                        FROM chat_apartments a
                        JOIN chat_users u ON u.id = a.owner_id
                    `)
                ]);
                const roomNames = new Map([
                    ['common', PUBLIC_ROOM_NAMES.common],
                    ['disco', PUBLIC_ROOM_NAMES.disco],
                    ...apartments.map((apartment) => [
                        `apartment:${apartment.id}`,
                        getApartmentRoomName(apartment)
                    ])
                ]);
                const users = [];
                for (const roomId of roomIds) {
                    const players = await redis.hGetAll(roomKeys(roomId).players);
                    for (const [playerId, encodedPlayer] of Object.entries(players)) {
                        const player = JSON.parse(encodedPlayer);
                        users.push({
                            userId: String(activeSocketUsers.get(playerId) || ''),
                            name: player.name,
                            id: playerId,
                            roomId,
                            roomName: roomNames.get(roomId) || 'Ukendt rum',
                            isSelf: playerId === socket.id
                        });
                    }
                }
                users.sort((first, second) => first.name.localeCompare(second.name, 'da'));
                socket.emit('online-users', { users });
            } catch (error) {
                console.error('Could not list online users:', getSafeErrorCode(error));
                socket.emit('online-users', { users: [], error: 'Online-listen kunne ikke hentes.' });
            }
        });

        socket.on('apartment-info-request', async ({ playerId } = {}) => {
            if (!activeSocketIds.has(socket.id) || typeof playerId !== 'string' || playerId.length > 128) return;
            try {
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                const apartment = target ? await getApartmentForUser(target.profile.id) : null;
                socket.emit('apartment-info', {
                    playerId,
                    apartmentId: apartment ? String(apartment.id) : null,
                    apartmentNumber: apartment ? Number(apartment.apartment_number) : null
                });
            } catch (error) {
                console.error('Could not look up avatar apartment:', getSafeErrorCode(error));
            }
        });

        socket.on('apartment-create', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                const [totalOnlineMs, { rows: [progress] }] = await Promise.all([
                    getTotalOnlineMs(socket.data.user.id),
                    pool.query('SELECT accepted_chat_messages FROM chat_users WHERE id = $1', [socket.data.user.id])
                ]);
                const level = getUserLevel(totalOnlineMs, Number(progress?.accepted_chat_messages || 0));
                if (level < 6) {
                    socket.emit('apartment-create-result', { error: 'Du skal nå level 6 for at få din egen lejlighed.' });
                    return;
                }
                const { rows: [apartment] } = await pool.query(`
                    INSERT INTO chat_apartments (owner_id) VALUES ($1)
                    ON CONFLICT (owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
                    RETURNING id, apartment_number
                `, [socket.data.user.id]);
                socket.emit('apartment-create-result', {
                    apartmentId: String(apartment.id), apartmentNumber: Number(apartment.apartment_number)
                });
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not create apartment:', getSafeErrorCode(error));
                socket.emit('apartment-create-result', { error: 'Lejligheden kunne ikke oprettes. Prøv igen.' });
            }
        });

        socket.on('apartment-visit', async (payload = {}) => {
            if (!activeSocketIds.has(socket.id)) return;
            const apartmentId = String(payload.apartmentId || '');
            if (!/^[1-9]\d{0,18}$/.test(apartmentId)) return;
            const targetPlayerId = payload.targetPlayerId;
            const targetSocket = typeof targetPlayerId === 'string' ? io.sockets.sockets.get(targetPlayerId) : null;
            const apartmentRoomId = `apartment:${apartmentId}`;
            if (targetPlayerId && (!targetSocket || !activeSocketIds.has(targetPlayerId)
                || activeSocketRooms.get(targetPlayerId) !== apartmentRoomId)) {
                socket.emit('apartment-visit-result', { message: 'Brugeren er ikke længere i lejligheden.' });
                return;
            }
            try {
                const { rows: [apartment] } = await pool.query(`
                    SELECT a.id, a.apartment_number, a.owner_id, u.username
                    FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id WHERE a.id = $1
                `, [apartmentId]);
                if (!apartment) return;
                if (targetPlayerId && activeSocketRooms.get(targetPlayerId) !== apartmentRoomId) {
                    socket.emit('apartment-visit-result', { message: 'Brugeren har skiftet rum. Prøv igen.' });
                    return;
                }
                if (String(apartment.owner_id) === String(socket.data.user.id)) {
                    if (targetPlayerId) {
                        if (socket.data.switchingRoom) return;
                        socket.data.switchingRoom = true;
                        try {
                            if (activeSocketRooms.get(socket.id) !== apartmentRoomId
                                && !await placeSocketInRoom(socket, apartmentRoomId)) {
                                socket.emit('apartment-visit-result', { message: 'Lejligheden er fuld. Prøv igen senere.' });
                                return;
                            }
                            const arrivedNearTarget = await moveSocketNearTarget(socket, apartmentRoomId, targetPlayerId);
                            socket.emit('apartment-visit-result', {
                                message: arrivedNearTarget
                                    ? `Du er teleporteret hen til ${targetSocket.data.user.username}.`
                                    : 'Du er kommet ind i lejligheden.'
                            });
                        } finally {
                            socket.data.switchingRoom = false;
                        }
                        return;
                    }
                    socket.emit('apartment-enter-approved', { roomId: `apartment:${apartment.id}` });
                    return;
                }
                const ownerSocketIds = [...activeSocketUsers.entries()]
                    .filter(([, userId]) => String(userId) === String(apartment.owner_id))
                    .map(([socketId]) => socketId);
                if (ownerSocketIds.length === 0) {
                    socket.emit('apartment-visit-result', { message: 'Ejeren er ikke hjemme lige nu.' });
                    return;
                }

                const knockId = crypto.randomUUID();
                const ownerPromptKey = `chat:apartment-door-prompt:${apartment.id}`;
                const promptReserved = await redis.set(ownerPromptKey, knockId, { EX: 30, NX: true });
                if (!promptReserved) {
                    socket.emit('apartment-visit-result', {
                        message: 'Ejeren har allerede en forespørgsel. Prøv igen om lidt.'
                    });
                    return;
                }

                const knockCooldownKey = `chat:apartment-knock-cooldown:${socket.data.user.id}`;
                const cooldownStarted = await redis.set(knockCooldownKey, '1', { EX: 20, NX: true });
                if (!cooldownStarted) {
                    await redis.eval(
                        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
                        { keys: [ownerPromptKey], arguments: [knockId] }
                    );
                    const secondsLeft = Math.max(1, await redis.ttl(knockCooldownKey));
                    socket.emit('apartment-visit-result', {
                        message: `Vent ${secondsLeft} sekunder, før du banker på igen.`
                    });
                    return;
                }
                const knock = {
                    guestSocketId: socket.id,
                    guestName: socket.data.user.username,
                    ownerId: String(apartment.owner_id),
                    apartmentId: String(apartment.id),
                    apartmentNumber: Number(apartment.apartment_number),
                    targetPlayerId: targetPlayerId || null,
                    expiresAt: Date.now() + 30_000
                };
                const knockKey = `chat:apartment-knock:${knockId}`;
                await redis.set(knockKey, JSON.stringify(knock), { EX: 30 });
                setTimeout(async () => {
                    if (await redis.getDel(knockKey)) {
                        await redis.eval(
                            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
                            { keys: [ownerPromptKey], arguments: [knockId] }
                        );
                        io.to(socket.id).emit('apartment-visit-result', { message: 'Der blev ikke lukket op.' });
                    }
                }, 30_000);
                const ownerSocketId = ownerSocketIds.find((socketId) =>
                    activeSocketRooms.get(socketId) === `apartment:${apartment.id}`
                ) || ownerSocketIds[0];
                io.to(ownerSocketId).emit('apartment-door-knock', {
                    knockId,
                    guestName: socket.data.user.username,
                    apartmentNumber: Number(apartment.apartment_number)
                });
                socket.emit('apartment-visit-result', { message: 'Du banker på. Venter på svar…' });
            } catch (error) {
                console.error('Could not request apartment access:', getSafeErrorCode(error));
                socket.emit('apartment-visit-result', { message: 'Kunne ikke banke på. Prøv igen.' });
            }
        });

        socket.on('apartment-door-answer', async ({ knockId, accepted } = {}) => {
            try {
                const key = `chat:apartment-knock:${String(knockId || '')}`;
                const encodedPending = await redis.get(key);
                if (!encodedPending) return;
                const pending = JSON.parse(encodedPending);
                if (pending.expiresAt < Date.now() || pending.ownerId !== String(socket.data.user.id)) return;
                if (!await redis.getDel(key)) return;
                await redis.eval(
                    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
                    { keys: [`chat:apartment-door-prompt:${pending.apartmentId}`], arguments: [String(knockId)] }
                );
                if (accepted !== true) {
                    io.to(pending.guestSocketId).emit('apartment-visit-result', { message: 'Der blev ikke lukket op.' });
                    return;
                }

                const guestSocket = io.sockets.sockets.get(pending.guestSocketId);
                if (!guestSocket || !activeSocketIds.has(guestSocket.id)) {
                    io.to(pending.guestSocketId).emit('apartment-visit-result', { message: 'Gæsten er ikke længere online.' });
                    return;
                }
                if (guestSocket.data.switchingRoom) return;

                guestSocket.data.switchingRoom = true;
                try {
                    const moved = await placeSocketInRoom(guestSocket, `apartment:${pending.apartmentId}`);
                    if (!moved) {
                        guestSocket.emit('room-error', { message: 'Lejligheden er fuld. Prøv igen senere.' });
                        return;
                    }
                    const targetStillPresent = pending.targetPlayerId
                        && activeSocketIds.has(pending.targetPlayerId)
                        && activeSocketRooms.get(pending.targetPlayerId) === `apartment:${pending.apartmentId}`;
                    const arrivedNearTarget = targetStillPresent
                        ? await moveSocketNearTarget(guestSocket, `apartment:${pending.apartmentId}`, pending.targetPlayerId)
                        : false;
                    guestSocket.emit('apartment-visit-result', {
                        message: arrivedNearTarget
                            ? 'Du blev lukket ind og teleporteret hen til brugeren.'
                            : 'Du blev lukket ind i lejligheden.'
                    });
                } finally {
                    guestSocket.data.switchingRoom = false;
                }
            } catch (error) {
                console.error('Could not admit apartment guest:', getSafeErrorCode(error));
            }
        });

        socket.on('profile-teleport', async ({ userId, target, mode } = {}) => {
            if (!activeSocketIds.has(socket.id) || socket.data.switchingRoom) return;
            if (mode !== undefined && !['user', 'room'].includes(mode)) return;
            const rawTarget = typeof target === 'string' ? target.trim() : '';
            const roomAlias = rawTarget.normalize('NFKC').toLocaleLowerCase('da-DK').replace(/\s+/g, ' ');
            const roomDestinations = new Map([
                ['common', ['1', '#1', 'common', 'fællesrum', 'fælles rum']],
                ['disco', ['2', '#2', 'disco', 'diskotek', 'diskoteket']]
            ]);
            const destinationRoom = [...roomDestinations.entries()]
                .find(([, aliases]) => mode !== 'user' && aliases.includes(roomAlias))?.[0];
            const now = Date.now();
            if (now - Number(socket.data.lastProfileTeleportAt || 0) < 1000) return;
            socket.data.lastProfileTeleportAt = now;

            if (destinationRoom) {
                socket.data.switchingRoom = true;
                try {
                    if (activeSocketRooms.get(socket.id) === destinationRoom) {
                        socket.emit('profile-teleport-result', {
                            message: `Du er allerede i ${PUBLIC_ROOM_NAMES[destinationRoom]}.`
                        });
                        return;
                    }
                    const joined = await placeSocketInRoom(socket, destinationRoom);
                    socket.emit('profile-teleport-result', {
                        message: joined
                            ? `Du er teleporteret til ${PUBLIC_ROOM_NAMES[destinationRoom]}.`
                            : 'Rummet er fyldt. Teleporteringen mislykkedes.'
                    });
                } catch (error) {
                    console.error('Could not teleport to public room:', getSafeErrorCode(error));
                    socket.emit('profile-teleport-result', { message: 'Teleporteringen mislykkedes. Prøv igen.' });
                } finally {
                    socket.data.switchingRoom = false;
                }
                return;
            }

            let targetUserId = null;
            if (userId !== undefined) {
                if (typeof userId !== 'string' || !/^[1-9]\d{0,18}$/.test(userId)) return;
                targetUserId = userId;
            } else if (!rawTarget && mode === 'user') {
                targetUserId = socket.data.lastProfileTeleportUserId || null;
                if (!targetUserId) {
                    socket.emit('profile-teleport-result', {
                        message: 'Vælg først en profil, eller brug /tb brugernavn. Bruger-ID skrives som /tb id:123.'
                    });
                    return;
                }
            } else {
                try {
                    if (mode === 'room') {
                        if (!/^[1-9]\d{2,18}$/.test(rawTarget)) {
                            socket.emit('profile-teleport-result', {
                                message: 'Brug /tr 1 til Fællesrum, /tr 2 til Diskoteket eller /tr 101 til en lejlighed.'
                            });
                            return;
                        }
                        const { rows: [apartment] } = await pool.query(
                            'SELECT id FROM chat_apartments WHERE apartment_number = $1', [rawTarget]
                        );
                        if (!apartment) {
                            socket.emit('profile-teleport-result', { message: `Lejlighed #${rawTarget} findes ikke.` });
                            return;
                        }
                        const apartmentRoomId = `apartment:${apartment.id}`;
                        if (activeSocketRooms.get(socket.id) === apartmentRoomId) {
                            socket.emit('profile-teleport-result', { message: `Du er allerede i lejlighed #${rawTarget}.` });
                        } else {
                            socket.emit('profile-teleport-knock', { apartmentId: String(apartment.id) });
                        }
                        return;
                    }

                    const explicitId = /^(?:id:|user:)([1-9]\d{0,18})$/i.exec(rawTarget);
                    const account = explicitId ? null : normalizeUsername(rawTarget);
                    let profile = null;
                    if (explicitId) {
                        const { rows: [row] } = await pool.query('SELECT id FROM chat_users WHERE id = $1', [explicitId[1]]);
                        profile = row;
                    } else if (account) {
                        const { rows: [row] } = await pool.query(
                            'SELECT id FROM chat_users WHERE username_normalized = $1', [account.normalized]
                        );
                        profile = row;
                    }
                    if (!profile) {
                        socket.emit('profile-teleport-result', {
                            message: 'Brugeren findes ikke. Brug /tb brugernavn eller /tb id:123.'
                        });
                        return;
                    }
                    targetUserId = String(profile.id);
                } catch (error) {
                    console.error('Could not resolve teleport target:', getSafeErrorCode(error));
                    socket.emit('profile-teleport-result', { message: 'Brugeren kunne ikke findes. Prøv igen.' });
                    return;
                }
            }

            if (String(targetUserId) === String(socket.data.user.id)) {
                socket.emit('profile-teleport-result', { message: 'Du kan ikke teleportere til dig selv.' });
                return;
            }
            socket.data.lastProfileTeleportUserId = String(targetUserId);

            const targetEntry = [...activeSocketUsers.entries()].find(([targetId, onlineUserId]) =>
                String(onlineUserId) === String(targetUserId) && activeSocketIds.has(targetId)
            );
            const targetSocketId = targetEntry?.[0];
            const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
            const targetRoomId = targetSocketId ? activeSocketRooms.get(targetSocketId) : null;
            if (!targetSocket || !targetRoomId || targetSocket.data.switchingRoom) {
                socket.emit('profile-teleport-result', { message: 'Brugeren er ikke længere online.' });
                return;
            }

            try {
                const apartmentMatch = /^apartment:([1-9]\d{0,18})$/.exec(targetRoomId);
                let apartment = null;
                if (apartmentMatch) {
                    const { rows: [row] } = await pool.query(
                        'SELECT owner_id FROM chat_apartments WHERE id = $1', [apartmentMatch[1]]
                    );
                    apartment = row;
                    if (!apartment) {
                        socket.emit('profile-teleport-result', { message: 'Lejligheden findes ikke længere.' });
                        return;
                    }
                    if (activeSocketRooms.get(targetSocketId) !== targetRoomId) {
                        socket.emit('profile-teleport-result', { message: 'Brugeren har skiftet rum. Prøv igen.' });
                        return;
                    }
                    const alreadyInside = activeSocketRooms.get(socket.id) === targetRoomId;
                    const isOwner = String(apartment.owner_id) === String(socket.data.user.id);
                    if (!alreadyInside && !isOwner) {
                        socket.emit('profile-teleport-knock', {
                            apartmentId: apartmentMatch[1],
                            targetPlayerId: targetSocketId
                        });
                        return;
                    }
                }

                if (socket.data.switchingRoom) return;
                socket.data.switchingRoom = true;
                try {
                    if (activeSocketRooms.get(socket.id) !== targetRoomId) {
                        const joined = await placeSocketInRoom(socket, targetRoomId);
                        if (!joined) {
                            socket.emit('profile-teleport-result', { message: 'Rummet er fyldt. Teleporteringen mislykkedes.' });
                            return;
                        }
                    }
                    if (!activeSocketIds.has(targetSocketId) || activeSocketRooms.get(targetSocketId) !== targetRoomId) {
                        socket.emit('profile-teleport-result', { message: 'Brugeren har skiftet rum. Prøv igen.' });
                        return;
                    }
                    const arrivedNearTarget = await moveSocketNearTarget(socket, targetRoomId, targetSocketId);
                    socket.emit('profile-teleport-result', {
                        message: arrivedNearTarget
                            ? `Du er teleporteret hen til ${targetSocket.data.user.username}.`
                            : `Du er kommet ind i rummet, men kunne ikke placeres tæt ved ${targetSocket.data.user.username}.`
                    });
                } finally {
                    socket.data.switchingRoom = false;
                }
            } catch (error) {
                console.error('Could not teleport to profile user:', getSafeErrorCode(error));
                socket.emit('profile-teleport-result', { message: 'Teleporteringen mislykkedes. Prøv igen.' });
            }
        });

        socket.on('profile-request', async (payload) => {
            const playerId = payload && payload.playerId;
            if (!activeSocketIds.has(socket.id) || typeof playerId !== 'string' || playerId.length > 128) return;
            const now = Date.now();
            if (now - Number(socket.data.lastProfileRequestAt || 0) < 750) {
                socket.emit('profile-error', { playerId, message: 'Vent et øjeblik, før du åbner en profil mere.' });
                return;
            }
            socket.data.lastProfileRequestAt = now;
            try {
                await cleanupStalePlayers();
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target) {
                    socket.emit('profile-error', { playerId, message: getMissingTargetMessage(playerId) });
                    return;
                }
                const { player, profile } = target;
                if (String(profile.id) !== String(socket.data.user.id)) {
                    socket.data.lastProfileTeleportUserId = String(profile.id);
                }
                const online = [...activeSocketUsers.entries()].some(([onlineSocketId, onlineUserId]) =>
                    String(onlineUserId) === String(profile.id) && activeSocketIds.has(onlineSocketId)
                );
                const { rows: [relationship] } = await pool.query(
                    'SELECT relationship FROM chat_profile_relationships WHERE user_id = $1 AND target_user_id = $2',
                    [socket.data.user.id, profile.id]
                );
                const [totalOnlineMs, progression, apartment] = await Promise.all([
                    getTotalOnlineMs(profile.id),
                    pool.query('SELECT accepted_chat_messages FROM chat_users WHERE id = $1', [profile.id]),
                    getApartmentForUser(profile.id)
                ]);
                const acceptedChatMessages = Number(progression.rows[0]?.accepted_chat_messages || 0);
                socket.emit('profile-info', {
                    playerId,
                    userId: String(profile.id),
                    avatarName: player ? player.name : profile.username,
                    online,
                    room: 'Fællesrum',
                    realName: profile.real_name || '',
                    profileText: profile.profile_text || '',
                    discordName: profile.discord_name || '',
                    interests: profile.interests || '',
                    steamName: profile.steam_name || '',
                    steamUrl: getSteamUrl(profile.steam_name) || '',
                    age: calculateAge(profile.birth_date),
                    residence: profile.region || '',
                    createdAt: profile.created_at,
                    lastLoginAt: profile.last_login_at,
                    totalOnlineMs,
                    acceptedChatMessages,
                    level: getUserLevel(totalOnlineMs, acceptedChatMessages),
                    levelRequirements: LEVEL_REQUIREMENTS.map(([timeMs, messageCount], index) => ({
                        level: index + 1, timeMs, messageCount
                    })),
                    apartmentNumber: apartment ? Number(apartment.apartment_number) : null,
                    apartmentId: apartment ? String(apartment.id) : null,
                    relationship: relationship ? relationship.relationship : null,
                    isOwnProfile: String(profile.id) === String(socket.data.user.id)
                });
            } catch (error) {
                console.error('Could not load public profile:', getSafeErrorCode(error));
                socket.emit('profile-error', { playerId, message: 'Profilen kunne ikke indlæses. Prøv igen.' });
            }
        });

        socket.on('profile-relationship-toggle', async (payload) => {
            const playerId = payload && payload.playerId;
            const relationship = payload && payload.relationship;
            if (
                !activeSocketIds.has(socket.id) ||
                typeof playerId !== 'string' ||
                playerId.length > 128 ||
                !['friend', 'enemy'].includes(relationship)
            ) return;

            try {
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target) {
                    socket.emit('profile-relationship-result', {
                        playerId,
                        error: getMissingTargetMessage(playerId)
                    });
                    return;
                }
                if (String(target.profile.id) === String(socket.data.user.id)) {
                    socket.emit('profile-relationship-result', {
                        playerId,
                        error: 'Du kan ikke føje dig selv til en liste.'
                    });
                    return;
                }

                const client = await pool.connect();
                let nextRelationship = null;
                try {
                    await client.query('BEGIN');
                    await client.query(
                        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                        [`profile-relationship:${socket.data.user.id}:${target.profile.id}`]
                    );
                    const { rows: [existing] } = await client.query(
                        'SELECT relationship FROM chat_profile_relationships WHERE user_id = $1 AND target_user_id = $2 FOR UPDATE',
                        [socket.data.user.id, target.profile.id]
                    );
                    if (existing && existing.relationship === relationship) {
                        await client.query(
                            'DELETE FROM chat_profile_relationships WHERE user_id = $1 AND target_user_id = $2',
                            [socket.data.user.id, target.profile.id]
                        );
                    } else {
                        await client.query(`
                            INSERT INTO chat_profile_relationships (user_id, target_user_id, relationship)
                            VALUES ($1, $2, $3)
                            ON CONFLICT (user_id, target_user_id)
                            DO UPDATE SET relationship = EXCLUDED.relationship, created_at = NOW()
                        `, [socket.data.user.id, target.profile.id, relationship]);
                        nextRelationship = relationship;
                    }
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
                socket.emit('profile-relationship-result', { playerId, relationship: nextRelationship });
            } catch (error) {
                console.error('Could not update profile relationship:', getSafeErrorCode(error));
                socket.emit('profile-relationship-result', {
                    playerId,
                    error: 'Listen kunne ikke opdateres. Prøv igen.'
                });
            }
        });

        socket.on('profile-management-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                const userId = socket.data.user.id;
                const [{ rows: relations }, { rows: mutes }] = await Promise.all([
                    pool.query(`
                    SELECT relation.target_user_id, target.username, relation.relationship,
                           (mute.target_user_id IS NOT NULL) AS muted
                    FROM chat_profile_relationships relation
                    JOIN chat_users target ON target.id = relation.target_user_id
                    LEFT JOIN chat_profile_mutes mute
                        ON mute.user_id = relation.user_id
                        AND mute.target_user_id = relation.target_user_id
                    WHERE relation.user_id = $1
                    ORDER BY target.username_normalized
                    `, [userId]),
                    pool.query(`
                        SELECT target.username
                        FROM chat_profile_mutes mute
                        JOIN chat_users target ON target.id = mute.target_user_id
                        WHERE mute.user_id = $1
                    `, [userId])
                ]);
                socket.emit('profile-management-info', {
                    relations: relations.map((relation) => ({
                        targetUserId: String(relation.target_user_id),
                        username: relation.username,
                        relationship: relation.relationship,
                        muted: relation.muted
                    })),
                    mutedUsernames: mutes.map((mute) => mute.username)
                });
            } catch (error) {
                console.error('Could not load profile management data:', getSafeErrorCode(error));
                socket.emit('profile-management-error', {
                    message: 'Dine lister kunne ikke indlæses. Prøv igen.'
                });
            }
        });

        socket.on('profile-relationship-remove', async (payload) => {
            const targetUserId = payload && payload.targetUserId;
            if (
                !activeSocketIds.has(socket.id) ||
                !/^[1-9]\d{0,18}$/.test(String(targetUserId || '')) ||
                String(targetUserId) === String(socket.data.user.id)
            ) return;
            try {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query(
                        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                        [`profile-relationship:${socket.data.user.id}:${targetUserId}`]
                    );
                    const { rowCount } = await client.query(
                        'DELETE FROM chat_profile_relationships WHERE user_id = $1 AND target_user_id = $2',
                        [socket.data.user.id, targetUserId]
                    );
                    if (!rowCount) {
                        await client.query('ROLLBACK');
                        socket.emit('profile-management-error', { message: 'Personen er ikke længere på din liste.' });
                        return;
                    }
                    await client.query('COMMIT');
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }
                socket.emit('profile-management-updated', {
                    targetUserId: String(targetUserId),
                    relationshipRemoved: true,
                    message: 'Personen er fjernet fra listen.'
                });
            } catch (error) {
                console.error('Could not remove profile relationship:', getSafeErrorCode(error));
                socket.emit('profile-management-error', { message: 'Personen kunne ikke fjernes. Prøv igen.' });
            }
        });

        socket.on('profile-mute-toggle', async (payload) => {
            const playerId = payload && payload.playerId;
            if (
                !activeSocketIds.has(socket.id) ||
                typeof playerId !== 'string' ||
                playerId.length > 128 ||
                playerId === socket.id
            ) return;

            let target;
            try {
                target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target || String(target.profile.id) === String(socket.data.user.id)) {
                    socket.emit('profile-management-error', { message: 'Du kan ikke mute dig selv eller en bruger, der er gået.' });
                    return;
                }
            } catch (error) {
                console.error('Could not find mute target:', getSafeErrorCode(error));
                socket.emit('profile-management-error', { message: 'Mute kunne ikke ændres. Prøv igen.' });
                return;
            }

            const targetUserId = target.profile.id;
            let client;
            try {
                client = await pool.connect();
                await client.query('BEGIN');
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                    [`profile-relationship:${socket.data.user.id}:${targetUserId}`]
                );
                const { rows: [mute] } = await client.query(
                    'SELECT 1 FROM chat_profile_mutes WHERE user_id = $1 AND target_user_id = $2 FOR UPDATE',
                    [socket.data.user.id, targetUserId]
                );
                if (mute) {
                    await client.query(
                        'DELETE FROM chat_profile_mutes WHERE user_id = $1 AND target_user_id = $2',
                        [socket.data.user.id, targetUserId]
                    );
                } else {
                    await client.query(
                        'INSERT INTO chat_profile_mutes (user_id, target_user_id) VALUES ($1, $2)',
                        [socket.data.user.id, targetUserId]
                    );
                }
                await client.query('COMMIT');
                socket.emit('profile-management-updated', {
                    targetUserId: String(targetUserId),
                    username: target.profile.username,
                    muted: !mute,
                    message: mute ? `Mute er slået fra for ${target.profile.username}.` : `${target.profile.username} er muted.`
                });
            } catch (error) {
                if (client) await client.query('ROLLBACK');
                console.error('Could not update profile mute:', getSafeErrorCode(error));
                socket.emit('profile-management-error', { message: 'Mute kunne ikke ændres. Prøv igen.' });
            } finally {
                if (client) client.release();
            }
        });

        socket.on('guestbook-request', async (payload) => {
            const playerId = payload && payload.playerId;
            if (!activeSocketIds.has(socket.id) || typeof playerId !== 'string' || playerId.length > 128) return;
            try {
                await cleanupStalePlayers();
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target) {
                    socket.emit('guestbook-error', { playerId, message: getMissingTargetMessage(playerId) });
                    return;
                }
                const { rows: entries } = await pool.query(`
                    SELECT entry.id, author.username AS author_name, entry.message, entry.created_at
                    FROM chat_guestbook_entries entry
                    JOIN chat_users author ON author.id = entry.author_user_id
                    WHERE entry.profile_user_id = $1
                    ORDER BY entry.id DESC
                    LIMIT 50
                `, [target.profile.id]);
                socket.emit('guestbook-info', {
                    playerId,
                    ownerUserId: String(target.profile.id),
                    entries: entries.reverse()
                });
            } catch (error) {
                console.error('Could not load guestbook:', getSafeErrorCode(error));
                socket.emit('guestbook-error', { playerId, message: 'Gæstebogen kunne ikke indlæses.' });
            }
        });

        socket.on('private-mail-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                const userId = socket.data.user.id;
                const [conversationsResult, unreadResult] = await Promise.all([
                    pool.query(`
                        WITH visible AS (
                            SELECT mail.id, mail.sender_user_id, mail.recipient_user_id, mail.message, mail.created_at,
                                   CASE WHEN mail.sender_user_id = $1 THEN mail.recipient_user_id ELSE mail.sender_user_id END AS peer_id
                            FROM chat_private_messages mail
                            WHERE (mail.sender_user_id = $1 AND mail.deleted_by_sender_at IS NULL)
                               OR (mail.recipient_user_id = $1 AND mail.deleted_by_recipient_at IS NULL)
                        ), latest AS (
                            SELECT DISTINCT ON (peer_id) peer_id, id, sender_user_id, message, created_at
                            FROM visible ORDER BY peer_id, id DESC
                        ), unread AS (
                            SELECT sender_user_id AS peer_id, COUNT(*)::int AS count
                            FROM chat_private_messages
                            WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL
                            GROUP BY sender_user_id
                        )
                        SELECT latest.peer_id, peer.username, latest.message, latest.created_at,
                               COALESCE(unread.count, 0) AS unread_count
                        FROM latest
                        JOIN chat_users peer ON peer.id = latest.peer_id
                        LEFT JOIN unread ON unread.peer_id = latest.peer_id
                        ORDER BY latest.id DESC
                        LIMIT 100
                    `, [userId]),
                    pool.query('SELECT COUNT(*)::int AS count FROM chat_private_messages WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL', [userId])
                ]);
                socket.emit('private-mail-data', {
                    unreadCount: unreadResult.rows[0]?.count || 0,
                    conversations: conversationsResult.rows.map((row) => ({
                        userId: String(row.peer_id), username: row.username, preview: row.message,
                        updatedAt: row.created_at, unreadCount: row.unread_count
                    }))
                });
            } catch (error) {
                console.error('Could not load private mail:', getSafeErrorCode(error));
                socket.emit('private-mail-error', { message: 'Postkassen kunne ikke indlæses. Prøv igen.' });
            }
        });

        socket.on('private-mail-recipient-check', async (payload) => {
            if (!activeSocketIds.has(socket.id)) return;
            const recipient = normalizeUsername(payload && payload.username);
            if (!recipient) {
                socket.emit('private-mail-recipient-result', { exists: false });
                return;
            }
            try {
                const { rows: [target] } = await pool.query(
                    'SELECT id, username FROM chat_users WHERE username_normalized = $1', [recipient.normalized]
                );
                if (target && String(target.id) === String(socket.data.user.id)) {
                    socket.emit('private-mail-recipient-result', { exists: false, error: 'Du kan ikke starte en samtale med dig selv.' });
                    return;
                }
                socket.emit('private-mail-recipient-result', {
                    exists: Boolean(target),
                    username: target ? target.username : ''
                });
            } catch (error) {
                console.error('Could not check private mail recipient:', getSafeErrorCode(error));
                socket.emit('private-mail-recipient-result', { exists: false, error: 'Modtageren kunne ikke tjekkes. Prøv igen.' });
            }
        });

        socket.on('private-mail-conversation-request', async (payload) => {
            if (!activeSocketIds.has(socket.id)) return;
            const peer = normalizeUsername(payload && payload.username);
            if (!peer) {
                socket.emit('private-mail-conversation-error', { message: 'Brugernavnet er ikke gyldigt.' });
                return;
            }
            try {
                const userId = socket.data.user.id;
                const { rows: [target] } = await pool.query(
                    'SELECT id, username FROM chat_users WHERE username_normalized = $1', [peer.normalized]
                );
                if (!target || String(target.id) === String(userId)) {
                    socket.emit('private-mail-conversation-error', { message: target ? 'Du kan ikke skrive til dig selv.' : 'Brugeren findes ikke.' });
                    return;
                }
                await pool.query(
                    'UPDATE chat_private_messages SET read_at = NOW() WHERE sender_user_id = $1 AND recipient_user_id = $2 AND read_at IS NULL AND deleted_by_recipient_at IS NULL',
                    [target.id, userId]
                );
                const [{ rows: messages }, { rows: [unread] }] = await Promise.all([
                    pool.query(`
                        SELECT id, sender_user_id, message, created_at
                        FROM chat_private_messages
                        WHERE ((sender_user_id = $1 AND recipient_user_id = $2 AND deleted_by_sender_at IS NULL)
                            OR (sender_user_id = $2 AND recipient_user_id = $1 AND deleted_by_recipient_at IS NULL))
                        ORDER BY id ASC
                        LIMIT 200
                    `, [userId, target.id]),
                    pool.query('SELECT COUNT(*)::int AS count FROM chat_private_messages WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL', [userId])
                ]);
                io.to(`private-mail:${userId}`).emit('private-mail-unread-count', { count: unread?.count || 0 });
                socket.emit('private-mail-conversation-data', {
                    username: target.username,
                    messages: messages.map((row) => ({
                        id: String(row.id), message: row.message, createdAt: row.created_at,
                        own: String(row.sender_user_id) === String(userId)
                    }))
                });
            } catch (error) {
                console.error('Could not load private mail conversation:', getSafeErrorCode(error));
                socket.emit('private-mail-conversation-error', { message: 'Samtalen kunne ikke indlæses. Prøv igen.' });
            }
        });

        socket.on('private-mail-send', async (payload) => {
            if (!activeSocketIds.has(socket.id)) return;
            const recipient = normalizeUsername(payload && payload.to);
            const subject = typeof (payload && payload.subject) === 'string'
                ? payload.subject.normalize('NFKC').replace(/\0/g, '').trim().slice(0, PRIVATE_MAIL_SUBJECT_MAX_LENGTH)
                : '';
            const message = typeof (payload && payload.message) === 'string'
                ? payload.message.normalize('NFKC').replace(/\0/g, '').trim().slice(0, PRIVATE_MAIL_MESSAGE_MAX_LENGTH)
                : '';
            if (!recipient || !subject || !message) {
                socket.emit('private-mail-error', { message: 'Udfyld modtager, emne og besked.' });
                return;
            }
            try {
                const { rows: [target] } = await pool.query(
                    'SELECT id, username FROM chat_users WHERE username_normalized = $1', [recipient.normalized]
                );
                if (!target) {
                    socket.emit('private-mail-error', { message: 'Brugeren findes ikke.' });
                    return;
                }
                if (String(target.id) === String(socket.data.user.id)) {
                    socket.emit('private-mail-error', { message: 'Du kan ikke sende en mail til dig selv.' });
                    return;
                }
                const cooldownKey = `chat:private-mail-cooldown:${socket.data.user.id}`;
                if (!await redis.set(cooldownKey, '1', { EX: 1, NX: true })) {
                    socket.emit('private-mail-error', { message: 'Vent et øjeblik, før du sender en mail mere.' });
                    return;
                }
                await pool.query(
                    'INSERT INTO chat_private_messages (sender_user_id, recipient_user_id, subject, message) VALUES ($1, $2, $3, $4)',
                    [socket.data.user.id, target.id, subject, message]
                );
                socket.emit('private-mail-sent', { recipientName: target.username });
                io.to(`private-mail:${target.id}`).emit('private-mail-notification', {
                    username: socket.data.user.username
                });
            } catch (error) {
                console.error('Could not send private mail:', getSafeErrorCode(error));
                socket.emit('private-mail-error', { message: 'Mailen kunne ikke sendes. Prøv igen.' });
            }
        });

        socket.on('private-mail-read', async (payload) => {
            const messageId = String(payload && payload.messageId || '');
            if (!activeSocketIds.has(socket.id) || !/^[1-9]\d{0,18}$/.test(messageId)) return;
            try {
                await pool.query(
                    'UPDATE chat_private_messages SET read_at = NOW() WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL AND deleted_by_recipient_at IS NULL',
                    [messageId, socket.data.user.id]
                );
                const { rows: [row] } = await pool.query(
                    'SELECT COUNT(*)::int AS count FROM chat_private_messages WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL',
                    [socket.data.user.id]
                );
                io.to(`private-mail:${socket.data.user.id}`).emit('private-mail-unread-count', { count: row?.count || 0 });
            } catch (error) {
                console.error('Could not mark private mail read:', getSafeErrorCode(error));
            }
        });

        socket.on('private-mail-delete', async (payload) => {
            const peer = normalizeUsername(payload && payload.username);
            if (!activeSocketIds.has(socket.id) || !peer) return;
            try {
                const { rows: [target] } = await pool.query(
                    'SELECT id, username FROM chat_users WHERE username_normalized = $1', [peer.normalized]
                );
                if (!target || String(target.id) === String(socket.data.user.id)) return;
                await pool.query(`
                    UPDATE chat_private_messages
                    SET deleted_by_sender_at = CASE WHEN sender_user_id = $1 THEN COALESCE(deleted_by_sender_at, NOW()) ELSE deleted_by_sender_at END,
                        deleted_by_recipient_at = CASE WHEN recipient_user_id = $1 THEN COALESCE(deleted_by_recipient_at, NOW()) ELSE deleted_by_recipient_at END
                    WHERE (sender_user_id = $1 AND recipient_user_id = $2)
                       OR (sender_user_id = $2 AND recipient_user_id = $1)
                `, [socket.data.user.id, target.id]);
                const { rows: [row] } = await pool.query(
                    'SELECT COUNT(*)::int AS count FROM chat_private_messages WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL',
                    [socket.data.user.id]
                );
                io.to(`private-mail:${socket.data.user.id}`).emit('private-mail-delete-result', { username: peer.username });
                io.to(`private-mail:${socket.data.user.id}`).emit('private-mail-unread-count', { count: row?.count || 0 });
            } catch (error) {
                console.error('Could not delete private mail:', getSafeErrorCode(error));
                socket.emit('private-mail-error', { message: 'Mailen kunne ikke slettes. Prøv igen.' });
            }
        });

        socket.on('private-mail-unread-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                const { rows: [row] } = await pool.query(
                    'SELECT COUNT(*)::int AS count FROM chat_private_messages WHERE recipient_user_id = $1 AND read_at IS NULL AND deleted_by_recipient_at IS NULL',
                    [socket.data.user.id]
                );
                socket.emit('private-mail-unread-count', { count: row?.count || 0 });
            } catch (error) {
                console.error('Could not load private mail count:', getSafeErrorCode(error));
            }
        });

        socket.on('guestbook-add', async (payload) => {
            const playerId = payload && payload.playerId;
            const message = normalizeGuestbookMessage(payload && payload.message);
            if (!activeSocketIds.has(socket.id) || typeof playerId !== 'string' || playerId.length > 128) return;
            if (!message) {
                socket.emit('guestbook-error', {
                    playerId,
                    message: `Skriv en hilsen på 1-${GUESTBOOK_MESSAGE_MAX_LENGTH} tegn.`
                });
                return;
            }

            try {
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target) {
                    socket.emit('guestbook-error', { playerId, message: getMissingTargetMessage(playerId) });
                    return;
                }
                if (String(target.profile.id) === String(socket.data.user.id)) {
                    socket.emit('guestbook-error', { playerId, message: 'Du kan ikke skrive i din egen gæstebog.' });
                    return;
                }
                const cooldownKey = `chat:guestbook-cooldown:${socket.data.user.id}`;
                const cooldown = await redis.set(cooldownKey, '1', { EX: 10, NX: true });
                if (!cooldown) {
                    socket.emit('guestbook-error', { playerId, message: 'Vent lidt, før du skriver en hilsen mere.' });
                    return;
                }
                try {
                    await pool.query(
                        'INSERT INTO chat_guestbook_entries (profile_user_id, author_user_id, message) VALUES ($1, $2, $3)',
                        [target.profile.id, socket.data.user.id, message]
                    );
                } catch (error) {
                    await redis.del(cooldownKey).catch(() => {});
                    throw error;
                }
                socket.emit('guestbook-added', { playerId });
            } catch (error) {
                console.error('Could not save guestbook entry:', getSafeErrorCode(error));
                socket.emit('guestbook-error', { playerId, message: 'Hilsnen kunne ikke gemmes. Prøv igen.' });
            }
        });

        socket.on('guestbook-delete', async (payload) => {
            const playerId = payload && payload.playerId;
            const entryId = payload && payload.entryId;
            if (
                !activeSocketIds.has(socket.id) ||
                typeof playerId !== 'string' ||
                playerId.length > 128 ||
                !/^[1-9]\d{0,18}$/.test(String(entryId || ''))
            ) return;

            try {
                const target = await getProfileTarget(playerId, socket.data.roomId || 'common');
                if (!target || String(target.profile.id) !== String(socket.data.user.id)) {
                    socket.emit('guestbook-error', { playerId, message: 'Kun gæstebogens ejer kan slette hilsner.' });
                    return;
                }
                const { rowCount } = await pool.query(
                    'DELETE FROM chat_guestbook_entries WHERE id = $1 AND profile_user_id = $2',
                    [entryId, target.profile.id]
                );
                if (!rowCount) {
                    socket.emit('guestbook-error', { playerId, message: 'Hilsnen findes ikke længere.' });
                    return;
                }
                socket.emit('guestbook-deleted', { playerId, entryId: String(entryId) });
            } catch (error) {
                console.error('Could not delete guestbook entry:', getSafeErrorCode(error));
                socket.emit('guestbook-error', { playerId, message: 'Hilsnen kunne ikke slettes. Prøv igen.' });
            }
        });

        socket.on('user-search', async (payload) => {
            const patterns = getUserSearchPatterns(payload && payload.query);
            if (!activeSocketIds.has(socket.id) || !patterns) return;
            const now = Date.now();
            if (now - Number(socket.data.lastUserSearchAt || 0) < 200) return;
            socket.data.lastUserSearchAt = now;
            try {
                const [{ rows }, players] = await Promise.all([
                    pool.query(`
                        SELECT id, username, username_normalized
                        FROM chat_users
                        WHERE username_normalized LIKE $1 ESCAPE '\\'
                        ORDER BY username_normalized ASC
                        LIMIT $2
                    `, [patterns.contains, USER_SEARCH_RESULT_LIMIT]),
                    getPlayers(socket.data.roomId || 'common')
                ]);
                const onlinePlayerIds = new Map();
                for (const [id, player] of Object.entries(players)) {
                    const account = normalizeUsername(player.name);
                    if (account) onlinePlayerIds.set(account.normalized, id);
                }
                socket.emit('user-search-results', {
                    query: patterns.query,
                    results: rows.map((row) => ({
                        userId: String(row.id),
                        username: row.username,
                        playerId: onlinePlayerIds.get(row.username_normalized) || null
                    }))
                });
            } catch (error) {
                console.error('Could not search users:', getSafeErrorCode(error));
                socket.emit('user-search-results', {
                    query: patterns.query,
                    error: 'Søgningen mislykkedes. Prøv igen.'
                });
            }
        });

        socket.on('join', async () => {
            if (activeSocketIds.has(socket.id) || socket.data.joining) return;
            socket.data.joining = true;
            try {
                const apartment = await getApartmentForUser(socket.data.user.id);
                const initialRoomId = apartment ? `apartment:${apartment.id}` : 'common';
                socket.data.roomId = initialRoomId;
                const initialRoomKeys = roomKeys(initialRoomId);
                const apartmentTiles = await loadApartmentTiles(initialRoomId);
                await cleanupStalePlayers();
                const { rows: mutedUsers } = await pool.query(`
                    SELECT target.username
                    FROM chat_profile_mutes mute
                    JOIN chat_users target ON target.id = mute.target_user_id
                    WHERE mute.user_id = $1
                `, [socket.data.user.id]);
                const joinArguments = [
                    socket.id,
                    socket.data.user.username,
                    String(Date.now()),
                    ...GRID_CELLS.map((cell) => `${cell.col}:${cell.row}`)
                ];
                const joinedPlayerJson = await redis.eval(PLAYER_JOIN_SCRIPT, {
                    keys: [initialRoomKeys.players, initialRoomKeys.cells, initialRoomKeys.tiles],
                    arguments: joinArguments
                });
                if (!joinedPlayerJson) {
                    const [playerCount, occupiedCellCount] = await Promise.all([
                        redis.hLen(initialRoomKeys.players),
                        redis.hLen(initialRoomKeys.cells)
                    ]);
                    console.warn('Chat room has no available grid cells:', {
                        players: playerCount,
                        occupiedCells: occupiedCellCount
                    });
                    socket.emit('room-error', { message: 'Rummet er fyldt. Prøv igen senere.' });
                    return;
                }

                try {
                    await startOnlineSession(socket.id, socket.data.user.id, socket.data.ipHash);
                } catch (error) {
                    await redis.eval(REMOVE_PLAYER_SCRIPT, {
                        keys: [initialRoomKeys.players, initialRoomKeys.cells],
                        arguments: [socket.id]
                    });
                    throw error;
                }

                const player = publicPlayer(JSON.parse(joinedPlayerJson));
                activeSocketIds.add(socket.id);
                activeSocketRooms.set(socket.id, initialRoomId);
                activeSocketUsers.set(socket.id, String(socket.data.user.id));
                await socket.join(roomChannel(initialRoomId));
                await socket.join(`private-mail:${socket.data.user.id}`);
                await socket.join(`chat-progress:${socket.data.user.id}`);
                const currentPlayers = await getPlayers(initialRoomId);
                for (const player of Object.values(currentPlayers)) {
                    player.text = '';
                    player.messageTime = 0;
                }
                let roomName = PUBLIC_ROOM_NAMES[initialRoomId] || 'Lejlighed';
                if (initialRoomId.startsWith('apartment:')) {
                    const { rows: [apartment] } = await pool.query(`
                        SELECT u.username, a.apartment_number, a.apartment_name FROM chat_apartments a
                        JOIN chat_users u ON u.id = a.owner_id WHERE a.id = $1
                    `, [initialRoomId.slice('apartment:'.length)]);
                    if (apartment) roomName = getApartmentRoomName(apartment);
                }
                const welcome = await getRoomWelcome(initialRoomId);
                const canEditApartment = await canEditApartmentRoom(socket.data.user.id, initialRoomId);
                socket.emit('join-success', {
                    players: currentPlayers,
                    mutedUsernames: mutedUsers.map((mutedUser) => mutedUser.username),
                    roomId: initialRoomId,
                    roomName: roomName,
                    apartmentTiles,
                    canEditApartment,
                    ...welcome
                });
                const [totalOnlineMs, { rows: [progress] }] = await Promise.all([
                    getTotalOnlineMs(socket.data.user.id),
                    pool.query('SELECT accepted_chat_messages FROM chat_users WHERE id = $1', [socket.data.user.id])
                ]);
                const acceptedChatMessages = Number(progress?.accepted_chat_messages || 0);
                socket.emit('user-progress', {
                    totalOnlineMs,
                    acceptedChatMessages,
                    level: getUserLevel(totalOnlineMs, acceptedChatMessages),
                    levelRequirements: LEVEL_REQUIREMENTS.map(([timeMs, messageCount], index) => ({ level: index + 1, timeMs, messageCount }))
                });
                socket.to(roomChannel(initialRoomId)).emit('newPlayer', player);
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not add chat participant:', getSafeErrorCode(error));
                const message = error.code === 'CHAT_ACCOUNT_ALREADY_ONLINE'
                    ? 'Denne bruger er allerede logget ind et andet sted. Log ud dér først.'
                    : error.code === 'CHAT_IP_ACTIVE_USER_LIMIT'
                        ? 'Der kan højst være 2 forskellige brugere online fra samme IP-adresse.'
                        : 'Kunne ikke komme ind i chatten. Prøv igen.';
                socket.emit('room-error', { code: error.code, message });
            } finally {
                socket.data.joining = false;
            }
        });

        socket.on('player-mood-set', async ({ mood } = {}) => {
            if (!activeSocketIds.has(socket.id) || !['glad', 'mobset', 'ked', 'blappet'].includes(mood)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!roomId) return;
            try {
                const keys = roomKeys(roomId);
                const encodedPlayer = await redis.hGet(keys.players, socket.id);
                if (!encodedPlayer) return;
                const player = JSON.parse(encodedPlayer);
                player.mood = mood;
                await redis.hSet(keys.players, socket.id, JSON.stringify(player));
                io.to(roomChannel(roomId)).emit('playerMoodChanged', { id: socket.id, mood });
            } catch (error) {
                console.error('Could not change chat participant mood:', getSafeErrorCode(error));
            }
        });

        socket.on('move', async (position) => {
            if (!activeSocketIds.has(socket.id)) return;
            if (!position || typeof position !== 'object') return;
            if (!isGridCoordinate(position.col, position.row)) return;

            try {
                const roomId = socket.data.roomId || 'common';
                const keys = roomKeys(roomId);
                const tileStates = await redis.hGetAll(keys.tiles);
                if (parseApartmentTileState(tileStates[`${position.col}:${position.row}`])?.kind === 'closed') {
                    return;
                }
                const movedPlayerJson = await redis.eval(PLAYER_MOVE_SCRIPT, {
                    keys: [keys.players, keys.cells, keys.tiles],
                    arguments: [socket.id, String(position.col), String(position.row), String(Date.now())]
                });
                if (!movedPlayerJson) {
                    return;
                }
                const player = publicPlayer(JSON.parse(movedPlayerJson));
                io.to(roomChannel(roomId)).emit('playerMoved', {
                    id: player.id,
                    col: player.col,
                    row: player.row
                });
            } catch (error) {
                console.error('Could not move chat participant:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Kunne ikke flytte avataren. Prøv igen.' });
            }
        });

        socket.on('private-whisper-send', async (payload) => {
            const targetPlayerId = payload && payload.playerId;
            const message = sanitizeChatMessage(payload && payload.message);
            if (
                !activeSocketIds.has(socket.id) ||
                typeof targetPlayerId !== 'string' || targetPlayerId.length > 128 ||
                targetPlayerId === socket.id || !message
            ) {
                socket.emit('private-whisper-error', { message: 'Vælg en anden avatar, der står tæt på dig, og skriv en besked.' });
                return;
            }

            const burst = registerChatMessage(socket.data.whisperMessageTimestamps, Date.now());
            socket.data.whisperMessageTimestamps = burst.timestamps;
            if (!burst.allowed) {
                socket.emit('private-whisper-error', { message: 'Vent lidt, før du hvisker igen.' });
                return;
            }

            try {
                const keys = roomKeys(socket.data.roomId || 'common');
                const [senderJson, targetJson] = await Promise.all([
                    redis.hGet(keys.players, socket.id),
                    redis.hGet(keys.players, targetPlayerId)
                ]);
                if (!senderJson || !targetJson) {
                    socket.emit('private-whisper-error', { message: 'Avataren er ikke længere i rummet.' });
                    return;
                }
                const sender = JSON.parse(senderJson);
                const target = JSON.parse(targetJson);
                const colDistance = Math.abs(sender.col - target.col);
                const rowDistance = Math.abs(sender.row - target.row);
                if (Math.max(colDistance, rowDistance) > 1 || (colDistance === 0 && rowDistance === 0)) {
                    socket.emit('private-whisper-error', { message: 'I skal stå ved siden af hinanden for at hviske.' });
                    return;
                }

                const sentAt = Date.now();
                socket.emit('private-whisper-message', {
                    playerId: targetPlayerId,
                    playerName: target.name,
                    message,
                    sentAt,
                    own: true
                });
                io.to(targetPlayerId).emit('private-whisper-message', {
                    playerId: socket.id,
                    playerName: sender.name,
                    message,
                    sentAt,
                    own: false
                });
            } catch (error) {
                console.error('Could not send private whisper:', getSafeErrorCode(error));
                socket.emit('private-whisper-error', { message: 'Hvisken kunne ikke sendes. Prøv igen.' });
            }
        });

        socket.on('chat-message', async (text) => {
            if (!activeSocketIds.has(socket.id) || typeof text !== 'string') return;
            const cleanText = sanitizeChatMessage(text);
            if (!cleanText) return;

            const burst = registerChatMessage(socket.data.chatMessageTimestamps, Date.now());
            socket.data.chatMessageTimestamps = burst.timestamps;
            if (!burst.allowed) {
                await kickPlayer(socket.id, 'Du blev fjernet fra chatten for at sende for mange beskeder på kort tid.');
                return;
            }

            try {
                const keys = roomKeys(socket.data.roomId || 'common');
                const currentPlayerJson = await redis.hGet(keys.players, socket.id);
                if (!currentPlayerJson) return;
                const currentPlayer = JSON.parse(currentPlayerJson);
                const messageTime = Math.max(Date.now(), Number(currentPlayer.messageTime || 0) + 1);

                const client = await pool.connect();
                let savedMessage;
                let acceptedChatMessages = null;
                let progressionFilterReason = null;
                try {
                    await client.query('BEGIN');
                    await client.query('SELECT pg_advisory_xact_lock(202602201)');
                    const { rows: recentMessages } = await client.query(`
                        SELECT message, created_at AS "createdAt"
                        FROM chat_messages
                        WHERE user_id = $1
                          AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
                        ORDER BY id DESC
                        LIMIT $3
                    `, [socket.data.user.id, Math.ceil(SPAM_HISTORY_WINDOW_MS / 60_000), SPAM_HISTORY_LIMIT]);
                    const progressionCheck = analyzeProgressionMessage(cleanText, recentMessages);
                    if (!progressionCheck.countsForProgression && progressionCheck.reason !== 'too-short') {
                        progressionFilterReason = progressionCheck.reason;
                    }
                    const insertResult = await client.query(
                        'INSERT INTO chat_messages (user_id, username, message) VALUES ($1, $2, $3) RETURNING id, created_at',
                        [socket.data.user.id, socket.data.user.username, cleanText]
                    );
                    await client.query(
                        'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT $1)',
                        [HISTORY_LIMIT]
                    );
                    if (progressionCheck.countsForProgression) {
                        const { rows: [progress] } = await client.query(`
                            UPDATE chat_users
                            SET accepted_chat_messages = accepted_chat_messages + 1
                            WHERE id = $1
                            RETURNING accepted_chat_messages
                        `, [socket.data.user.id]);
                        if (progress) acceptedChatMessages = Number(progress.accepted_chat_messages);
                    }
                    await client.query('COMMIT');
                    savedMessage = insertResult.rows[0];
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }

                if (acceptedChatMessages !== null) {
                    const totalOnlineMs = await getTotalOnlineMs(socket.data.user.id);
                    io.to(`chat-progress:${socket.data.user.id}`).emit('user-progress', {
                        totalOnlineMs,
                        acceptedChatMessages,
                        level: getUserLevel(totalOnlineMs, acceptedChatMessages),
                        levelRequirements: LEVEL_REQUIREMENTS.map(([timeMs, messageCount], index) => ({ level: index + 1, timeMs, messageCount }))
                    });
                }

                const updatedPlayerJson = await redis.eval(UPDATE_PLAYER_MESSAGE_SCRIPT, {
                    keys: [keys.players],
                    arguments: [socket.id, cleanText, String(messageTime), String(Date.now())]
                });
                if (!updatedPlayerJson) return;

                io.to(roomChannel(socket.data.roomId || 'common')).emit('playerChatMessage', {
                    id: socket.id,
                    text: cleanText,
                    messageTime,
                    messageId: savedMessage.id,
                    createdAt: savedMessage.created_at
                });

                if (progressionFilterReason) {
                    socket.emit('progression-message-filtered', { reason: progressionFilterReason });
                }

                setTimeout(async () => {
                    try {
                        const expired = await redis.eval(EXPIRE_PLAYER_MESSAGE_SCRIPT, {
                            keys: [keys.players],
                            arguments: [socket.id, String(messageTime)]
                        });
                        if (expired) io.to(roomChannel(socket.data.roomId || 'common')).emit('playerChatExpired', { id: socket.id, messageTime });
                    } catch (error) {
                        console.error('Could not expire chat bubble:', getSafeErrorCode(error));
                    }
                }, MESSAGE_DURATION);
            } catch (error) {
                console.error('Could not save chat message:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Beskeden kunne ikke gemmes. Prøv igen.' });
            }
        });

        socket.on('disconnect', async () => {
            activeSocketIds.delete(socket.id);
            activeSocketUsers.delete(socket.id);
            const roomId = activeSocketRooms.get(socket.id) || socket.data.roomId || 'common';
            const keys = roomKeys(roomId);
            activeSocketRooms.delete(socket.id);
            try {
                const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                    keys: [keys.players, keys.cells],
                    arguments: [socket.id]
                });
                if (removed) io.to(roomChannel(roomId)).emit('playerDisconnected', socket.id);
                if (removed) io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not remove chat participant:', getSafeErrorCode(error));
            }
            try {
                await accountOnlineSession(socket.id, true);
            } catch (error) {
                console.error('Could not account for disconnected chat session:', getSafeErrorCode(error));
            }
        });
    });

    let heartbeatRunning = false;
    const heartbeatTimer = setInterval(async () => {
        if (heartbeatRunning || activeSocketIds.size === 0) return;
        heartbeatRunning = true;
        try {
            for (const roomId of await getAllRoomIds()) {
                const roomSocketIds = [...activeSocketIds].filter((id) => activeSocketRooms.get(id) === roomId);
                if (!roomSocketIds.length) continue;
                const missingIds = await redis.eval(HEARTBEAT_SCRIPT, {
                    keys: [roomKeys(roomId).players],
                    arguments: [String(Date.now()), ...roomSocketIds]
                });
                for (const id of missingIds) {
                    if (!activeSocketIds.delete(id)) continue;
                    activeSocketRooms.delete(id);
                    activeSocketUsers.delete(id);
                    io.to(roomChannel(roomId)).emit('playerDisconnected', id);
                    io.emit('navigator-refresh');
                    try { await accountOnlineSession(id, true); }
                    catch (error) { console.error('Could not account for missing chat session:', getSafeErrorCode(error)); }
                    io.in(id).disconnectSockets(true);
                }
            }
        } catch (error) {
            console.error('Could not refresh chat presence:', getSafeErrorCode(error));
        }
        const accountedAt = new Date();
        for (const socketId of [...activeSocketIds]) {
            try {
                await accountOnlineSession(socketId, false, accountedAt);
            } catch (error) {
                console.error('Could not update accumulated online time:', getSafeErrorCode(error));
            }
        }
        heartbeatRunning = false;
    }, PRESENCE_HEARTBEAT_INTERVAL);
    const cleanupTimer = setInterval(() => {
        cleanupStalePlayers().catch((error) => {
            console.error('Could not clean up expired chat presence:', getSafeErrorCode(error));
        });
    }, PRESENCE_CLEANUP_INTERVAL);
    const idleKickTimer = setInterval(() => {
        kickIdlePlayers().catch((error) => {
            console.error('Could not remove inactive chat participants:', getSafeErrorCode(error));
        });
    }, PLAYER_IDLE_CHECK_INTERVAL);
    const progressionTimer = setInterval(async () => {
        const userIds = [...new Set(activeSocketUsers.values())];
        if (!userIds.length) return;
        try {
            const { rows } = await pool.query(`
                SELECT u.id, u.accepted_chat_messages::text AS accepted_chat_messages,
                       (u.total_online_ms + COALESCE(MAX(GREATEST(
                           0, FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_accounted_at)) * 1000)
                       )), 0))::text AS total_online_ms
                FROM chat_users u
                LEFT JOIN chat_online_sessions s ON s.user_id = u.id
                WHERE u.id = ANY($1::bigint[])
                GROUP BY u.id
            `, [userIds]);
            for (const row of rows) {
                const totalOnlineMs = Number(row.total_online_ms) || 0;
                const acceptedChatMessages = Number(row.accepted_chat_messages) || 0;
                io.to(`chat-progress:${row.id}`).emit('user-progress', {
                    totalOnlineMs,
                    acceptedChatMessages,
                    level: getUserLevel(totalOnlineMs, acceptedChatMessages),
                    levelRequirements: LEVEL_REQUIREMENTS.map(([timeMs, messageCount], index) => ({
                        level: index + 1, timeMs, messageCount
                    }))
                });
            }
        } catch (error) {
            console.error('Could not update user level progress:', getSafeErrorCode(error));
        }
    }, PROGRESSION_UPDATE_INTERVAL);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(process.env.PORT || 3000, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    console.log(`Server kører på port ${process.env.PORT || 3000}`);

    const shutdown = async () => {
        clearInterval(heartbeatTimer);
        clearInterval(cleanupTimer);
        clearInterval(idleKickTimer);
        clearInterval(progressionTimer);
        await new Promise((resolve) => io.close(resolve));
        if (redisSubscriber.isOpen) await redisSubscriber.quit();
        if (redisPublisher.isOpen) await redisPublisher.quit();
        await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('not-a-real-account-password', 10);

if (require.main === module) {
    startServer().catch((error) => {
        console.error('Chat server startup failed:', error.message || getSafeErrorCode(error));
        process.exit(1);
    });
}

module.exports = { startServer };
