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
const { isAuthorizedTabSession, isValidTabId } = require('./lib/tab-session');
const { hashRegistrationIp, MAX_ACCOUNTS_PER_IP } = require('./lib/account-ip-limit');

const GRID_COUNT = 6;
const MESSAGE_DURATION = 10_000;
const HISTORY_LIMIT = 500;
const PRESENCE_HEARTBEAT_INTERVAL = 10_000;
const PRESENCE_EXPIRY = 45_000;
const PRESENCE_CLEANUP_INTERVAL = 15_000;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const GRID_CELLS = [];

for (let row = 0; row < GRID_COUNT; row++) {
    for (let col = 0; col < GRID_COUNT; col++) {
        GRID_CELLS.push({ col, row });
    }
}

GRID_CELLS.sort((first, second) => {
    const firstDistance = Math.abs(first.col - 2.5) + Math.abs(first.row - 2.5);
    const secondDistance = Math.abs(second.col - 2.5) + Math.abs(second.row - 2.5);
    return firstDistance - secondDistance;
});

const PLAYER_JOIN_SCRIPT = `
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
    local player = cjson.decode(existing)
    player.lastSeen = tonumber(ARGV[3])
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
    return cjson.encode(player)
end

for index = 4, #ARGV do
    local cell = ARGV[index]
    if redis.call('HEXISTS', KEYS[2], cell) == 0 then
        local col, row = string.match(cell, '^(%d+):(%d+)$')
        local player = {
            id = ARGV[1],
            name = ARGV[2],
            col = tonumber(col),
            row = tonumber(row),
            text = '',
            messageTime = 0,
            lastSeen = tonumber(ARGV[3])
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
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
return cjson.encode(player)
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
for index = 2, #ARGV do
    local id = ARGV[index]
    local encoded = redis.call('HGET', KEYS[1], id)
    if encoded then
        local player = cjson.decode(encoded)
        player.lastSeen = now
        redis.call('HSET', KEYS[1], id, cjson.encode(player))
    end
end
return #ARGV - 1
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

function isGridCoordinate(value) {
    return Number.isInteger(value) && value >= 0 && value < GRID_COUNT;
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
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS registration_ip_hash TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_users_registration_ip_hash_idx ON chat_users (registration_ip_hash) WHERE registration_ip_hash IS NOT NULL');
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
    app.use(sessionMiddleware);
    io.engine.use(sessionMiddleware);

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
                    'INSERT INTO chat_users (username, username_normalized, password_hash, registration_ip_hash) VALUES ($1, $2, $3, $4) RETURNING id, username',
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
            io.emit('playerDisconnected', id);
        }
    }

    async function getPlayers() {
        await cleanupStalePlayers();
        return getPublicPlayers(await redis.hGetAll(playersKey));
    }

    io.on('connection', (socket) => {
        socket.join(`session:${socket.request.sessionID}`);
        socket.on('join', async () => {
            if (activeSocketIds.has(socket.id)) return;
            try {
                await cleanupStalePlayers();
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

                const player = publicPlayer(JSON.parse(joinedPlayerJson));
                activeSocketIds.add(socket.id);
                const currentPlayers = await getPlayers();
                for (const player of Object.values(currentPlayers)) {
                    player.text = '';
                    player.messageTime = 0;
                }
                socket.emit('join-success', { players: currentPlayers });
                socket.broadcast.emit('newPlayer', player);
            } catch (error) {
                console.error('Could not add chat participant:', getSafeErrorCode(error));
                socket.emit('room-error', { message: 'Kunne ikke komme ind i chatten. Prøv igen.' });
            }
        });

        socket.on('move', async (position) => {
            if (!activeSocketIds.has(socket.id)) return;
            if (!position || typeof position !== 'object') return;
            if (!isGridCoordinate(position.col) || !isGridCoordinate(position.row)) return;

            try {
                const movedPlayerJson = await redis.eval(PLAYER_MOVE_SCRIPT, {
                    keys: [playersKey, cellsKey],
                    arguments: [socket.id, String(position.col), String(position.row), String(Date.now())]
                });
                if (!movedPlayerJson) {
                    socket.emit('move-rejected', { message: 'Den flise er allerede optaget.' });
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

        socket.on('chat-message', async (text) => {
            if (!activeSocketIds.has(socket.id) || typeof text !== 'string') return;
            const cleanText = sanitizeChatMessage(text);
            if (!cleanText) return;

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
        });
    });

    let heartbeatRunning = false;
    const heartbeatTimer = setInterval(async () => {
        if (heartbeatRunning || activeSocketIds.size === 0) return;
        heartbeatRunning = true;
        try {
            await redis.eval(HEARTBEAT_SCRIPT, {
                keys: [playersKey],
                arguments: [String(Date.now()), ...activeSocketIds]
            });
        } catch (error) {
            console.error('Could not refresh chat presence:', getSafeErrorCode(error));
        } finally {
            heartbeatRunning = false;
        }
    }, PRESENCE_HEARTBEAT_INTERVAL);
    const cleanupTimer = setInterval(() => {
        cleanupStalePlayers().catch((error) => {
            console.error('Could not clean up expired chat presence:', getSafeErrorCode(error));
        });
    }, PRESENCE_CLEANUP_INTERVAL);

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
