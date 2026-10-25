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
const { GUESTBOOK_MESSAGE_MAX_LENGTH, normalizeGuestbookMessage } = require('./lib/guestbook');
const { USER_SEARCH_RESULT_LIMIT, getUserSearchPatterns } = require('./lib/user-search');
const GRID_LAYOUT = require('./public/grid-layout');
const PRIVATE_MAIL_SUBJECT_MAX_LENGTH = 100;
const PRIVATE_MAIL_MESSAGE_MAX_LENGTH = 2000;

const MESSAGE_DURATION = 10_000;
const OFFLINE_PROFILE_PREFIX = 'user:';
const HISTORY_LIMIT = 500;
const PRESENCE_HEARTBEAT_INTERVAL = 10_000;
const PRESENCE_EXPIRY = 45_000;
const PRESENCE_CLEANUP_INTERVAL = 15_000;
const ONLINE_TIME_ACCOUNTING_INTERVAL = 10_000;
const PLAYER_IDLE_TIMEOUT = 20 * 60 * 1000;
const PLAYER_IDLE_CHECK_INTERVAL = 10_000;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GRID_CELLS = [...GRID_LAYOUT.cells];
GRID_CELLS.sort((first, second) => {
    const firstDistance = Math.abs(first.col - 2.5) + Math.abs(first.row - 1.5);
    const secondDistance = Math.abs(second.col - 2.5) + Math.abs(second.row - 1.5);
    return firstDistance - secondDistance;
});
const GRID_CELL_KEYS = new Set(GRID_CELLS.map(({ col, row }) => `${col}:${row}`));

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

for index = 4, #ARGV do
    local cell = ARGV[index]
    if redis.call('HEXISTS', KEYS[2], cell) == 0 then
        local col, row = string.match(cell, '^([%-]?%d+):([%-]?%d+)$')
        local player = {
            id = ARGV[1],
            name = ARGV[2],
            col = tonumber(col),
            row = tonumber(row),
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
end
return false
`;

const PLAYER_MOVE_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end

local player = cjson.decode(encoded)
local nextCell = ARGV[2] .. ':' .. ARGV[3]
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
    const playersKey = 'chat:players';
    const cellsKey = 'chat:cells';

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
    await pool.query('CREATE INDEX IF NOT EXISTS chat_users_registration_ip_hash_idx ON chat_users (registration_ip_hash) WHERE registration_ip_hash IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_online_sessions (
            socket_id TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            last_accounted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_online_sessions_user_id_idx ON chat_online_sessions (user_id)');
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

    await redisPublisher.connect();
    await redisSubscriber.connect();
    io.adapter(createAdapter(redisPublisher, redisSubscriber));
    app.set('trust proxy', 1);
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
                COALESCE(SUM(GREATEST(
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

    async function accountOnlineSession(socketId, finish = false, accountedUntil = new Date()) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [onlineSession] } = await client.query(
                'SELECT user_id, last_accounted_at FROM chat_online_sessions WHERE socket_id = $1 FOR UPDATE',
                [socketId]
            );
            if (onlineSession) {
                await client.query(`
                    UPDATE chat_users
                    SET total_online_ms = total_online_ms + GREATEST(
                        0,
                        FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - $3::timestamptz)) * 1000)::bigint
                    )
                    WHERE id = $1
                `, [onlineSession.user_id, accountedUntil, onlineSession.last_accounted_at]);
                if (finish) {
                    await client.query('DELETE FROM chat_online_sessions WHERE socket_id = $1', [socketId]);
                } else {
                    await client.query(
                        'UPDATE chat_online_sessions SET last_accounted_at = $2 WHERE socket_id = $1',
                        [socketId, accountedUntil]
                    );
                }
            }
            await client.query('COMMIT');
            return Boolean(onlineSession);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async function startOnlineSession(socketId, userId) {
        await pool.query(`
            INSERT INTO chat_online_sessions (socket_id, user_id, last_accounted_at)
            VALUES ($1, $2, NOW())
        `, [socketId, userId]);
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

    const OWN_PROFILE_COLUMNS = 'real_name, profile_text, discord_name, interests, steam_name, birth_date::text AS birth_date, region';

    function serializeOwnProfile(row) {
        return {
            realName: row.real_name || '',
            profileText: row.profile_text || '',
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
                `SELECT ${OWN_PROFILE_COLUMNS}, created_at, last_login_at FROM chat_users WHERE id = $1`,
                [request.session.user.id]
            );
            if (!profile) {
                response.status(404).json({ error: 'Profilen blev ikke fundet.' });
                return;
            }
            response.json({
                ...serializeOwnProfile(profile),
                createdAt: profile.created_at,
                lastLoginAt: profile.last_login_at
            });
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

    async function cleanupStalePlayers() {
        const removedIds = await redis.eval(CLEAN_STALE_PLAYERS_SCRIPT, {
            keys: [playersKey, cellsKey],
            arguments: [String(Date.now() - PRESENCE_EXPIRY)]
        });
        for (const id of removedIds) {
            activeSocketIds.delete(id);
            try {
                await accountOnlineSession(id, true, new Date(Date.now() - PRESENCE_EXPIRY));
            } catch (error) {
                console.error('Could not account for expired chat session:', getSafeErrorCode(error));
            }
            io.emit('playerDisconnected', id);
        }
        await cleanupOrphanedOnlineSessions();
    }

    async function cleanupOrphanedOnlineSessions() {
        const [players, { rows: onlineSessions }] = await Promise.all([
            redis.hGetAll(playersKey),
            pool.query('SELECT socket_id, last_accounted_at FROM chat_online_sessions')
        ]);
        const playerIds = new Set(Object.keys(players));
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
        const removedIds = await redis.eval(KICK_IDLE_PLAYERS_SCRIPT, {
            keys: [playersKey, cellsKey],
            arguments: [String(Date.now() - PLAYER_IDLE_TIMEOUT)]
        });
        for (const id of removedIds) {
            activeSocketIds.delete(id);
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
            io.emit('playerDisconnected', id);
            setTimeout(() => io.in(id).disconnectSockets(true), 100);
        }
    }

    async function kickPlayer(socketId, message) {
        activeSocketIds.delete(socketId);
        try {
            const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                keys: [playersKey, cellsKey],
                arguments: [socketId]
            });
            if (removed) io.emit('playerDisconnected', socketId);
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

    async function getPlayers() {
        await cleanupStalePlayers();
        return getPublicPlayers(await redis.hGetAll(playersKey));
    }

    function getMissingTargetMessage(targetId) {
        return targetId.startsWith(OFFLINE_PROFILE_PREFIX)
            ? 'Brugeren findes ikke længere.'
            : 'Brugeren er ikke længere i rummet.';
    }

    async function getProfileTarget(playerId) {
        if (typeof playerId !== 'string' || playerId.length > 128) return null;
        const accountMatch = /^user:([1-9]\d{0,18})$/.exec(playerId);
        if (accountMatch) {
            const { rows: [profile] } = await pool.query(
                'SELECT id, username, real_name, profile_text, discord_name, interests, steam_name, birth_date::text AS birth_date, region, created_at, last_login_at FROM chat_users WHERE id = $1',
                [accountMatch[1]]
            );
            return profile ? { player: null, profile } : null;
        }
        const playerJson = await redis.hGet(playersKey, playerId);
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

    io.on('connection', (socket) => {
        socket.join(`session:${socket.request.sessionID}`);
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
                const target = await getProfileTarget(playerId);
                if (!target) {
                    socket.emit('profile-error', { playerId, message: getMissingTargetMessage(playerId) });
                    return;
                }
                const { player, profile } = target;
                const { rows: [relationship] } = await pool.query(
                    'SELECT relationship FROM chat_profile_relationships WHERE user_id = $1 AND target_user_id = $2',
                    [socket.data.user.id, profile.id]
                );
                socket.emit('profile-info', {
                    playerId,
                    userId: String(profile.id),
                    avatarName: player ? player.name : profile.username,
                    online: Boolean(player),
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
                    totalOnlineMs: await getTotalOnlineMs(profile.id),
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
                const target = await getProfileTarget(playerId);
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
                target = await getProfileTarget(playerId);
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
                const target = await getProfileTarget(playerId);
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
                io.to(`private-mail:${target.id}`).emit('private-mail-notification');
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
                const target = await getProfileTarget(playerId);
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
                const target = await getProfileTarget(playerId);
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
            const patterns = getUserSearchPatterns(payload && payload.query, payload && payload.matchMode);
            if (!activeSocketIds.has(socket.id) || !patterns) return;
            const now = Date.now();
            if (now - Number(socket.data.lastUserSearchAt || 0) < 200) return;
            socket.data.lastUserSearchAt = now;
            try {
                const [{ rows }, players] = await Promise.all([
                    pool.query(`
                        SELECT u.id, u.username, u.username_normalized,
                               (u.total_online_ms + COALESCE(SUM(GREATEST(
                                   0, FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_accounted_at)) * 1000)
                               )), 0))::text AS total_online_ms
                        FROM chat_users u
                        LEFT JOIN chat_online_sessions s ON s.user_id = u.id
                        WHERE u.username_normalized LIKE $1 ESCAPE '\\'
                        GROUP BY u.id
                        ORDER BY
                            CASE WHEN $2 = 'onlineTime' THEN
                                (u.total_online_ms + COALESCE(SUM(GREATEST(
                                    0, FLOOR(EXTRACT(EPOCH FROM (NOW() - s.last_accounted_at)) * 1000)
                                )), 0))
                            END DESC NULLS LAST,
                            u.username_normalized ASC
                        LIMIT $3
                    `, [patterns.mode === 'prefix' ? patterns.prefix : patterns.contains, payload && payload.sortBy === 'onlineTime' ? 'onlineTime' : 'name', USER_SEARCH_RESULT_LIMIT]),
                    getPlayers()
                ]);
                const onlinePlayerIds = new Map();
                for (const [id, player] of Object.entries(players)) {
                    const account = normalizeUsername(player.name);
                    if (account) onlinePlayerIds.set(account.normalized, id);
                }
                socket.emit('user-search-results', {
                    query: patterns.query,
                    matchMode: patterns.mode,
                    sortBy: payload && payload.sortBy === 'onlineTime' ? 'onlineTime' : 'name',
                    results: rows.map((row) => ({
                        userId: String(row.id),
                        username: row.username,
                        playerId: onlinePlayerIds.get(row.username_normalized) || null,
                        totalOnlineMs: Number(row.total_online_ms) || 0
                    }))
                });
            } catch (error) {
                console.error('Could not search users:', getSafeErrorCode(error));
                socket.emit('user-search-results', {
                    query: patterns.query,
                    matchMode: patterns.mode,
                    sortBy: payload && payload.sortBy === 'onlineTime' ? 'onlineTime' : 'name',
                    error: 'Søgningen mislykkedes. Prøv igen.'
                });
            }
        });

        socket.on('join', async () => {
            if (activeSocketIds.has(socket.id) || socket.data.joining) return;
            socket.data.joining = true;
            try {
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
                    keys: [playersKey, cellsKey],
                    arguments: joinArguments
                });
                if (!joinedPlayerJson) {
                    const [playerCount, occupiedCellCount] = await Promise.all([
                        redis.hLen(playersKey),
                        redis.hLen(cellsKey)
                    ]);
                    console.warn('Chat room has no available grid cells:', {
                        players: playerCount,
                        occupiedCells: occupiedCellCount
                    });
                    socket.emit('room-error', { message: 'Rummet er fyldt. Prøv igen senere.' });
                    return;
                }

                try {
                    await startOnlineSession(socket.id, socket.data.user.id);
                } catch (error) {
                    await redis.eval(REMOVE_PLAYER_SCRIPT, {
                        keys: [playersKey, cellsKey],
                        arguments: [socket.id]
                    });
                    throw error;
                }

                const player = publicPlayer(JSON.parse(joinedPlayerJson));
                activeSocketIds.add(socket.id);
                await socket.join(`private-mail:${socket.data.user.id}`);
                const currentPlayers = await getPlayers();
                for (const player of Object.values(currentPlayers)) {
                    player.text = '';
                    player.messageTime = 0;
                }
                socket.emit('join-success', {
                    players: currentPlayers,
                    mutedUsernames: mutedUsers.map((mutedUser) => mutedUser.username)
                });
                socket.broadcast.emit('newPlayer', player);
            } catch (error) {
                console.error('Could not add chat participant:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Kunne ikke komme ind i chatten. Prøv igen.' });
            } finally {
                socket.data.joining = false;
            }
        });

        socket.on('move', async (position) => {
            if (!activeSocketIds.has(socket.id)) return;
            if (!position || typeof position !== 'object') return;
            if (!isGridCoordinate(position.col, position.row)) return;

            try {
                const movedPlayerJson = await redis.eval(PLAYER_MOVE_SCRIPT, {
                    keys: [playersKey, cellsKey],
                    arguments: [socket.id, String(position.col), String(position.row), String(Date.now())]
                });
                if (!movedPlayerJson) {
                    return;
                }
                const player = publicPlayer(JSON.parse(movedPlayerJson));
                io.emit('playerMoved', {
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
                const [senderJson, targetJson] = await Promise.all([
                    redis.hGet(playersKey, socket.id),
                    redis.hGet(playersKey, targetPlayerId)
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
                const currentPlayerJson = await redis.hGet(playersKey, socket.id);
                if (!currentPlayerJson) return;
                const currentPlayer = JSON.parse(currentPlayerJson);
                const messageTime = Math.max(Date.now(), Number(currentPlayer.messageTime || 0) + 1);

                const client = await pool.connect();
                let savedMessage;
                try {
                    await client.query('BEGIN');
                    await client.query('SELECT pg_advisory_xact_lock(202602201)');
                    const insertResult = await client.query(
                        'INSERT INTO chat_messages (user_id, username, message) VALUES ($1, $2, $3) RETURNING id, created_at',
                        [socket.data.user.id, socket.data.user.username, cleanText]
                    );
                    await client.query(
                        'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT $1)',
                        [HISTORY_LIMIT]
                    );
                    await client.query('COMMIT');
                    savedMessage = insertResult.rows[0];
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally {
                    client.release();
                }

                const updatedPlayerJson = await redis.eval(UPDATE_PLAYER_MESSAGE_SCRIPT, {
                    keys: [playersKey],
                    arguments: [socket.id, cleanText, String(messageTime), String(Date.now())]
                });
                if (!updatedPlayerJson) return;

                io.emit('playerChatMessage', {
                    id: socket.id,
                    text: cleanText,
                    messageTime,
                    messageId: savedMessage.id,
                    createdAt: savedMessage.created_at
                });

                setTimeout(async () => {
                    try {
                        const expired = await redis.eval(EXPIRE_PLAYER_MESSAGE_SCRIPT, {
                            keys: [playersKey],
                            arguments: [socket.id, String(messageTime)]
                        });
                        if (expired) io.emit('playerChatExpired', { id: socket.id, messageTime });
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
            try {
                const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                    keys: [playersKey, cellsKey],
                    arguments: [socket.id]
                });
                if (removed) io.emit('playerDisconnected', socket.id);
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
            const missingIds = await redis.eval(HEARTBEAT_SCRIPT, {
                keys: [playersKey],
                arguments: [String(Date.now()), ...activeSocketIds]
            });
            for (const id of missingIds) {
                if (!activeSocketIds.delete(id)) continue;
                io.emit('playerDisconnected', id);
                try {
                    await accountOnlineSession(id, true);
                } catch (error) {
                    console.error('Could not account for missing chat session:', getSafeErrorCode(error));
                }
                io.in(id).disconnectSockets(true);
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
