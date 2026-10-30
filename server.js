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
// The fallback living-room illustration has fixed furniture. Keep avatars on the
// open floor by default; admins can change these cells in the room editor.
const TEST_ROOM_FURNITURE_CELL_KEYS = new Set([
    '-2:2', '-1:1', '-1:2', '0:2',
    '2:-2', '3:-3', '2:-1', '3:-2', '3:-1', '4:-2', '4:-1',
    '4:0', '5:0', '5:-1',
    '0:4', '1:3', '1:4', '1:5', '2:4',
    '5:1', '6:0'
]);

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
    const door = /^door:(common|disco|public:[1-9]\d{0,18}|apartment:[1-9]\d{0,18})$/.exec(base);
    if (door) return { kind: 'door', destination: door[1], color: color ? color.toLowerCase() : '' };
    return null;
}

function isPublicChatRoomId(roomId) {
    return roomId === 'common' || roomId === 'disco' || /^public:[1-9]\d{0,18}$/.test(String(roomId || ''));
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
    local shouldBeInvisible = ARGV[6] == '1'
    local previousCell = player.col .. ':' .. player.row
    if shouldBeInvisible then
        if redis.call('HGET', KEYS[2], previousCell) == ARGV[1] then
            redis.call('HDEL', KEYS[2], previousCell)
        end
    else
        local occupant = redis.call('HGET', KEYS[2], previousCell)
        if not occupant or occupant == ARGV[1] then redis.call('HSET', KEYS[2], previousCell, ARGV[1]) end
    end
    player.lastSeen = tonumber(ARGV[3])
    player.joinedAt = tonumber(player.joinedAt or ARGV[3])
    player.lastActivityAt = tonumber(player.lastActivityAt or ARGV[3])
    player.clothing = cjson.decode(ARGV[5])
    player.avatarType = ARGV[7] == 'girl' and 'girl' or 'boy'
    player.invisible = shouldBeInvisible
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
    return cjson.encode(player)
end

local function tryJoin(cell)
    local tileState = redis.call('HGET', KEYS[3], cell)
    local isClosed = tileState == 'closed' or (tileState and string.sub(tileState, 1, 7) == 'closed|')
    local isInvisible = ARGV[6] == '1'
    local occupant = redis.call('HGET', KEYS[2], cell)
    if (isInvisible or not occupant) and not isClosed then
        local col, row = string.match(cell, '^([%-]?%d+):([%-]?%d+)$')
        local player = {
            id = ARGV[1],
            name = ARGV[2],
            col = tonumber(col),
            row = tonumber(row),
            mood = ARGV[4],
            avatarType = ARGV[7] == 'girl' and 'girl' or 'boy',
            invisible = isInvisible,
            clothing = cjson.decode(ARGV[5]),
            text = '',
            messageTime = 0,
            lastSeen = tonumber(ARGV[3]),
            joinedAt = tonumber(ARGV[3]),
            lastActivityAt = tonumber(ARGV[3])
        }
        redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
        if not isInvisible then redis.call('HSET', KEYS[2], cell, ARGV[1]) end
        return cjson.encode(player)
    end
    return false
end

-- In an apartment, prefer a designated door as the spawn point when available.
for index = 8, #ARGV do
    local cell = ARGV[index]
    local tileState = redis.call('HGET', KEYS[3], cell)
    if tileState == 'door' or (tileState and string.sub(tileState, 1, 5) == 'door:') then
        local player = tryJoin(cell)
        if player then return player end
    end
end
for index = 8, #ARGV do
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
if ARGV[5] ~= '1' and (tileState == 'closed' or (tileState and string.sub(tileState, 1, 7) == 'closed|')) then return false end
local occupant = redis.call('HGET', KEYS[2], nextCell)
local invisible = player.invisible == true
if not invisible and occupant and occupant ~= ARGV[1] then return false end

local previousCell = player.col .. ':' .. player.row
if previousCell ~= nextCell and redis.call('HGET', KEYS[2], previousCell) == ARGV[1] then
    redis.call('HDEL', KEYS[2], previousCell)
end

player.col = tonumber(ARGV[2])
player.row = tonumber(ARGV[3])
player.lastSeen = tonumber(ARGV[4])
player.lastActivityAt = tonumber(ARGV[4])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
if not invisible then redis.call('HSET', KEYS[2], nextCell, ARGV[1]) end
return cjson.encode(player)
`;

const SWAP_PLAYER_POSITIONS_SCRIPT = `
local firstEncoded = redis.call('HGET', KEYS[1], ARGV[1])
local secondEncoded = redis.call('HGET', KEYS[1], ARGV[2])
if not firstEncoded or not secondEncoded then return false end

local first = cjson.decode(firstEncoded)
local second = cjson.decode(secondEncoded)
local firstCell = first.col .. ':' .. first.row
local secondCell = second.col .. ':' .. second.row
if firstCell == secondCell then return false end

local firstOccupant = redis.call('HGET', KEYS[2], secondCell)
local secondOccupant = redis.call('HGET', KEYS[2], firstCell)
if (firstOccupant and firstOccupant ~= ARGV[1] and firstOccupant ~= ARGV[2])
    or (secondOccupant and secondOccupant ~= ARGV[1] and secondOccupant ~= ARGV[2]) then
    return false
end

if firstOccupant == ARGV[1] or firstOccupant == ARGV[2] then redis.call('HDEL', KEYS[2], secondCell) end
if secondOccupant == ARGV[1] or secondOccupant == ARGV[2] then redis.call('HDEL', KEYS[2], firstCell) end

local firstCol, firstRow = first.col, first.row
first.col, first.row = second.col, second.row
second.col, second.row = firstCol, firstRow
local now = tonumber(ARGV[3])
first.lastSeen, first.lastActivityAt = now, now
second.lastSeen, second.lastActivityAt = now, now
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(first))
redis.call('HSET', KEYS[1], ARGV[2], cjson.encode(second))
if first.invisible ~= true then redis.call('HSET', KEYS[2], secondCell, ARGV[1]) end
if second.invisible ~= true then redis.call('HSET', KEYS[2], firstCell, ARGV[2]) end
return cjson.encode({ first = first, second = second })
`;

const PLAYER_VISIBILITY_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end
local player = cjson.decode(encoded)
local previousCell = player.col .. ':' .. player.row

if ARGV[2] == 'hide' then
    if redis.call('HGET', KEYS[2], previousCell) == ARGV[1] then
        redis.call('HDEL', KEYS[2], previousCell)
    end
    player.invisible = true
    player.lastActivityAt = tonumber(ARGV[3])
    player.lastSeen = tonumber(ARGV[3])
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
    return cjson.encode(player)
end

for index = 4, #ARGV, 2 do
    local col = tonumber(ARGV[index])
    local row = tonumber(ARGV[index + 1])
    local cell = ARGV[index] .. ':' .. ARGV[index + 1]
    local tileState = redis.call('HGET', KEYS[3], cell)
    local isClosed = tileState == 'closed' or (tileState and string.sub(tileState, 1, 7) == 'closed|')
    local occupant = redis.call('HGET', KEYS[2], cell)
    if not isClosed and (not occupant or occupant == ARGV[1]) then
        if redis.call('HGET', KEYS[2], previousCell) == ARGV[1] then
            redis.call('HDEL', KEYS[2], previousCell)
        end
        player.invisible = false
        player.col = col
        player.row = row
        player.lastActivityAt = tonumber(ARGV[3])
        player.lastSeen = tonumber(ARGV[3])
        redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
        redis.call('HSET', KEYS[2], cell, ARGV[1])
        return cjson.encode(player)
    end
end

return false
`;

const UPDATE_PLAYER_CLOTHING_SCRIPT = `
local encoded = redis.call('HGET', KEYS[1], ARGV[1])
if not encoded then return false end
local player = cjson.decode(encoded)
player.clothing = cjson.decode(ARGV[2])
local now = tonumber(ARGV[3])
if not player.lastSeen then player.lastSeen = now end
if not player.lastActivityAt then player.lastActivityAt = now end
if not player.joinedAt then player.joinedAt = now end
if player.invisible == nil then player.invisible = ARGV[4] == '1' end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(player))
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
local now = tonumber(ARGV[2])
for index = 1, #entries, 2 do
    local id = entries[index]
    local player = cjson.decode(entries[index + 1])
    if not player.lastSeen then player.lastSeen = now end
    if not player.lastActivityAt then player.lastActivityAt = now end
    if not player.joinedAt then player.joinedAt = now end
    if player.invisible == nil then player.invisible = false end
    local lastActivityAt = tonumber(player.lastActivityAt or player.joinedAt or player.lastSeen or 0)
    if lastActivityAt < cutoff then
        local cell = player.col .. ':' .. player.row
        if redis.call('HGET', KEYS[2], cell) == id then
            redis.call('HDEL', KEYS[2], cell)
        end
        redis.call('HDEL', KEYS[1], id)
        table.insert(removed, id)
    else
        redis.call('HSET', KEYS[1], id, cjson.encode(player))
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
local now = tonumber(ARGV[2])
for index = 1, #entries, 2 do
    local id = entries[index]
    local player = cjson.decode(entries[index + 1])
    if not player.lastSeen then player.lastSeen = now end
    if not player.lastActivityAt then player.lastActivityAt = now end
    if not player.joinedAt then player.joinedAt = now end
    if player.invisible == nil then player.invisible = false end
    if tonumber(player.lastSeen or 0) < cutoff then
        local cell = player.col .. ':' .. player.row
        if redis.call('HGET', KEYS[2], cell) == id then
            redis.call('HDEL', KEYS[2], cell)
        end
        redis.call('HDEL', KEYS[1], id)
        table.insert(removed, id)
    else
        redis.call('HSET', KEYS[1], id, cjson.encode(player))
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

function normalizeClothingAnimation(value = {}) {
    const columns = Number.isInteger(Number(value?.columns)) ? Number(value.columns) : 1;
    const rows = Number.isInteger(Number(value?.rows)) ? Number(value.rows) : 1;
    const safeColumns = Math.min(16, Math.max(1, columns));
    const safeRows = Math.min(256, Math.max(1, rows));
    const frames = Number.isInteger(Number(value?.frames)) ? Number(value.frames) : 1;
    const fps = Number.isInteger(Number(value?.fps)) ? Number(value.fps) : 8;
    return {
        columns: safeColumns,
        rows: safeRows,
        frames: Math.min(safeColumns * safeRows, 256, Math.max(1, frames)),
        fps: Math.min(24, Math.max(1, fps))
    };
}

function publicPlayer(player) {
    return {
        id: player.id,
        name: player.name,
        avatarType: player.avatarType === 'girl' ? 'girl' : 'boy',
        col: player.col,
        row: player.row,
        mood: ['glad', 'mobset', 'ked', 'blappet', 'boevet'].includes(player.mood) ? player.mood : 'glad',
        text: player.text,
        messageTime: player.messageTime,
        clothing: Array.isArray(player.clothing) ? player.clothing.map((item) => ({
            id: String(item.id),
            name: item.name,
            category: item.category,
            imageVersion: Number(item.imageVersion || 1),
            imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${Number(item.imageVersion || 1)}`,
            // Preserve animation settings when room joins rebuild player objects.
            animation: normalizeClothingAnimation(item.animation),
            x: item.x,
            y: item.y,
            rotation: item.rotation,
            scale: item.scale,
            scaleX: item.scaleX,
            scaleY: item.scaleY,
            skewX: item.skewX,
            skewY: item.skewY,
            layerPosition: item.layerPosition,
            layerOrder: Number.isFinite(Number(item.layerOrder)) ? Number(item.layerOrder) : undefined
        })) : []
    };
}

const WARDROBE_CATEGORIES = ['headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory'];
function normalizeWardrobeCategoryOrder(value) {
    let order = value;
    if (typeof order === 'string') {
        try { order = JSON.parse(order); } catch { return null; }
    }
    return Array.isArray(order) && order.length === WARDROBE_CATEGORIES.length
        && new Set(order).size === WARDROBE_CATEGORIES.length
        && WARDROBE_CATEGORIES.every((category) => order.includes(category))
        ? order
        : null;
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
    const adminUsernames = new Set(String(process.env.ADMIN_USERNAMES || '')
        .split(',')
        .map((username) => normalizeUsername(username)?.normalized)
        .filter(Boolean));
    const limitedAdminUsernames = new Set(String(process.env.LIMITED_ADMIN_USERNAMES || '')
        .split(',')
        .map((username) => normalizeUsername(username)?.normalized)
        .filter(Boolean));
    const ipEncryptionKey = crypto.createHash('sha256').update('chat-ip-ban:').update(SESSION_SECRET).digest();
    const encryptIpAddress = (address) => {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', ipEncryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
        return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
    };
    const decryptIpAddress = (value) => {
        try {
            const [ivValue, tagValue, encryptedValue] = String(value).split('.');
            const decipher = crypto.createDecipheriv('aes-256-gcm', ipEncryptionKey, Buffer.from(ivValue, 'base64url'));
            decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
            return Buffer.concat([
                decipher.update(Buffer.from(encryptedValue, 'base64url')),
                decipher.final()
            ]).toString('utf8');
        } catch {
            return 'Ukendt';
        }
    };
    const getAdminRole = (user) => {
        const normalized = normalizeUsername(user?.username)?.normalized;
        if (!normalized) return 'none';
        if (adminUsernames.has(normalized)) return 'full';
        if (limitedAdminUsernames.has(normalized)) return 'rooms-clothing';
        return 'none';
    };
    const getRequestIpAddress = (request) => String(request.ip || request.socket.remoteAddress || '').trim();
    const recordUserLastIp = async (userId, ipAddress, ipHash) => {
        if (!userId || !ipAddress || !ipHash) return;
        await pool.query(`
            INSERT INTO chat_user_last_ips (user_id, ip_hash, ip_address_encrypted, last_seen_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                ip_hash = EXCLUDED.ip_hash,
                ip_address_encrypted = EXCLUDED.ip_address_encrypted,
                last_seen_at = NOW()
        `, [userId, ipHash, encryptIpAddress(ipAddress)]);
    };
    const getActiveIpBan = async (ipHash) => {
        if (!ipHash) return null;
        const { rows: [ban] } = await pool.query(`
            SELECT reason, admin_initials, created_at, expires_at
            FROM chat_ip_bans WHERE ip_hash = $1 AND (expires_at IS NULL OR expires_at > NOW())
        `, [ipHash]);
        return ban || null;
    };
    const formatIpBanMessage = (ban) => {
        const expiresAt = ban.expires_at
            ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Copenhagen' }).format(new Date(ban.expires_at))
            : 'permanent';
        return `Adgang blokeret. Grund: ${ban.reason}. Admin: ${ban.admin_initials}. Udløber: ${expiresAt}.`;
    };

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
    const io = new Server(server, { maxHttpBufferSize: 1_100_000 });
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
    const invisibleSocketIds = new Set();
    const canSeeInvisibleUser = (socket) => Boolean(socket?.data?.isAdmin
        || socket?.data?.canManagePublicRooms || socket?.data?.canManageClothing);
    const roomChannel = (roomId) => `chatroom:${roomId}`;
    const roomKeys = (roomId) => ({
        players: `chat:${roomId}:players`,
        cells: `chat:${roomId}:cells`,
        tiles: `chat:${roomId}:tiles`
    });
    async function getAllRoomIds() {
        const [{ rows: publicRooms }, { rows: apartments }] = await Promise.all([
            pool.query('SELECT id FROM chat_public_rooms ORDER BY room_number'),
            pool.query('SELECT id FROM chat_apartments')
        ]);
        return [...publicRooms.map((row) => row.id), ...apartments.map((row) => `apartment:${row.id}`)];
    }
    async function getPublicRooms() {
        const { rows } = await pool.query(`
            SELECT id, room_number, floor_number, name, is_system, welcome_title, welcome_text,
                   background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                   overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform,
                   is_locked, is_hidden, is_shop, shop_is_open
            FROM chat_public_rooms ORDER BY floor_number, room_number
        `);
        return rows;
    }
    function formatPublicRoomName(room) {
        return `#${room.room_number} ${room.name}`;
    }
    function getPublicRoomBackgroundUrl(room) {
        if (!room?.has_background) return null;
        const version = room.background_version || 0;
        return `/api/public-room-background/${encodeURIComponent(room.id)}?v=${version}`;
    }
    function getPublicRoomOverlayUrl(room) {
        if (!room?.has_overlay) return null;
        const version = room.overlay_version || 0;
        return `/api/public-room-overlay/${encodeURIComponent(room.id)}?v=${version}`;
    }
    function normalizePublicRoomOverlayTransform(value = {}) {
        const finite = (input, fallback) => Number.isFinite(Number(input)) ? Number(input) : fallback;
        const clamp = (input, min, max, fallback) => Math.min(max, Math.max(min, finite(input, fallback)));
        return {
            x: clamp(value?.x, -270, 270, 0),
            y: clamp(value?.y, -180, 180, 0),
            rotation: clamp(value?.rotation, -180, 180, 0),
            scale: clamp(value?.scale, 0.25, 3, 1)
        };
    }
    function normalizeClothingTransform(value = {}, category = '') {
        const finite = (input, fallback) => Number.isFinite(Number(input)) ? Number(input) : fallback;
        const clamp = (input, min, max, fallback) => Math.min(max, Math.max(min, finite(input, fallback)));
        return {
            ...normalizePublicRoomOverlayTransform(value),
            scaleX: clamp(value?.scaleX, 0.25, 3, 1),
            scaleY: clamp(value?.scaleY, 0.25, 3, 1),
            skewX: clamp(value?.skewX, -45, 45, 0),
            skewY: clamp(value?.skewY, -45, 45, 0),
            layerPosition: ['front', 'normal', 'back'].includes(value?.layerPosition)
                ? value.layerPosition
                : ['left_hand', 'right_hand'].includes(category) ? 'front' : 'normal'
        };
    }
    function isValidClothingAnimation(value = {}) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Number.isInteger(value.columns) && value.columns >= 1 && value.columns <= 16
            && Number.isInteger(value.rows) && value.rows >= 1 && value.rows <= 256
            && Number.isInteger(value.frames) && value.frames >= 1 && value.frames <= 256
            && value.frames <= value.columns * value.rows
            && Number.isInteger(value.fps) && value.fps >= 1 && value.fps <= 24;
    }
    async function getChatOnlineCount() {
        const { rows: [result] } = await pool.query('SELECT COUNT(*)::int AS count FROM chat_online_sessions');
        return Number(result?.count || 0);
    }
    async function broadcastChatOnlineCount() {
        try {
            const count = await getChatOnlineCount();
            const { rows: clothingOwnerRows } = await pool.query(`
                SELECT assignment.clothing_item_id::text AS item_id,
                       COUNT(DISTINCT assignment.target_user_id)::int AS owner_count
                FROM chat_clothing_assignments assignment
                GROUP BY assignment.clothing_item_id
            `);
            const clothingOwnerCounts = Object.fromEntries(clothingOwnerRows.map((row) => [row.item_id, Number(row.owner_count || 0)]));
            for (const socketId of activeSocketIds) {
                const recipient = io.sockets.sockets.get(socketId);
                if (!recipient) continue;
                recipient.emit('chat-online-count', {
                    count: Math.max(0, count - invisibleSocketIds.size)
                });
                recipient.emit('clothing-ownership-counts', clothingOwnerCounts);
            }
            return count;
        } catch (error) {
            console.error('Could not count online chat participants:', getSafeErrorCode(error));
            return null;
        }
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
    await pool.query("ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS avatar_type VARCHAR(8) NOT NULL DEFAULT 'boy'");
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS total_online_ms BIGINT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS steam_name VARCHAR(256)');
    await pool.query('ALTER TABLE chat_users ALTER COLUMN steam_name TYPE VARCHAR(256)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS birth_date DATE');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS postal_code VARCHAR(4)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS region VARCHAR(32)');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS accepted_chat_messages BIGINT NOT NULL DEFAULT 0');
    await pool.query("ALTER TABLE chat_users ADD COLUMN IF NOT EXISTS wardrobe_category_order JSONB NOT NULL DEFAULT '[]'::jsonb");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_avatar_assets (
            avatar_type VARCHAR(8) PRIMARY KEY CHECK (avatar_type = 'girl'),
            image_data BYTEA NOT NULL,
            mime_type VARCHAR(24) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            version BIGINT NOT NULL DEFAULT 1
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_app_migrations (
            migration_key VARCHAR(120) PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    const avatarMigration = await pool.connect();
    try {
        await avatarMigration.query('BEGIN');
        const { rows: [newMigration] } = await avatarMigration.query(`
            INSERT INTO chat_app_migrations (migration_key)
            VALUES ('default-girl-avatar-dame-v1')
            ON CONFLICT DO NOTHING
            RETURNING migration_key
        `);
        if (newMigration) {
            const defaultGirlAvatar = fs.readFileSync(path.join(__dirname, 'public', 'images', 'dame.png'));
            const isPng = defaultGirlAvatar.length >= 8
                && defaultGirlAvatar.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            if (!isPng) throw new Error('Bundled default girl avatar is not a valid PNG.');
            await avatarMigration.query(`
                INSERT INTO chat_avatar_assets (avatar_type, image_data, mime_type)
                VALUES ('girl', $1, 'image/png')
                ON CONFLICT (avatar_type) DO UPDATE SET
                    image_data = EXCLUDED.image_data,
                    mime_type = EXCLUDED.mime_type,
                    updated_at = NOW(),
                    version = chat_avatar_assets.version + 1
            `, [defaultGirlAvatar]);
        }
        await avatarMigration.query('COMMIT');
    } catch (error) {
        try { await avatarMigration.query('ROLLBACK'); } catch {}
        throw error;
    } finally {
        avatarMigration.release();
    }
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
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS chat_public_room_number_seq START WITH 3`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_public_rooms (
            id TEXT PRIMARY KEY,
            room_number BIGINT NOT NULL UNIQUE,
            floor_number INTEGER NOT NULL DEFAULT 1 CHECK (floor_number BETWEEN 1 AND 100),
            name VARCHAR(60) NOT NULL,
            is_system BOOLEAN NOT NULL DEFAULT FALSE,
            is_locked BOOLEAN NOT NULL DEFAULT FALSE,
            is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
            is_shop BOOLEAN NOT NULL DEFAULT FALSE,
            shop_is_open BOOLEAN NOT NULL DEFAULT FALSE,
            welcome_title VARCHAR(100),
            welcome_text VARCHAR(500),
            layout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
            background_image BYTEA,
            background_mime_type VARCHAR(24),
            background_updated_at TIMESTAMPTZ,
            background_version BIGINT NOT NULL DEFAULT 0,
            background_animation_json JSONB NOT NULL DEFAULT '{"columns":1,"rows":1,"frames":1,"fps":8}'::jsonb,
            overlay_image BYTEA,
            overlay_mime_type VARCHAR(24),
            overlay_updated_at TIMESTAMPTZ,
            overlay_version BIGINT NOT NULL DEFAULT 0,
            overlay_transform JSONB NOT NULL DEFAULT '{"x":0,"y":0,"rotation":0,"scale":1}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS background_image BYTEA');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS background_mime_type VARCHAR(24)');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS background_updated_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS background_version BIGINT NOT NULL DEFAULT 0');
    await pool.query("ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS background_animation_json JSONB NOT NULL DEFAULT '{\"columns\":1,\"rows\":1,\"frames\":1,\"fps\":8}'::jsonb");
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS overlay_image BYTEA');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS overlay_mime_type VARCHAR(24)');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS overlay_updated_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS overlay_version BIGINT NOT NULL DEFAULT 0');
    await pool.query("ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS overlay_transform JSONB NOT NULL DEFAULT '{\"x\":0,\"y\":0,\"rotation\":0,\"scale\":1}'::jsonb");
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS is_shop BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS shop_is_open BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query("ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS shop_content JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS welcome_title VARCHAR(100)');
    await pool.query('ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS welcome_text VARCHAR(500)');
    await pool.query("ALTER TABLE chat_public_rooms ADD COLUMN IF NOT EXISTS layout_json JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query(`
        INSERT INTO chat_public_rooms (id, room_number, floor_number, name, is_system)
        VALUES ('common', 1, 1, 'Fællesrum', TRUE), ('disco', 2, 1, 'Diskoteket', TRUE)
        ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_clothing_items (
            id BIGSERIAL PRIMARY KEY,
            target_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            name VARCHAR(60) NOT NULL,
            description VARCHAR(300) NOT NULL DEFAULT '',
            category VARCHAR(20) NOT NULL CHECK (category IN ('headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory')),
            image BYTEA NOT NULL,
            mime_type VARCHAR(24) NOT NULL CHECK (mime_type IN ('image/png', 'image/webp')),
            required_level INTEGER NOT NULL DEFAULT 1 CHECK (required_level BETWEEN 1 AND 20),
            price INTEGER NOT NULL DEFAULT 0 CHECK (price BETWEEN 0 AND 100000000),
            transform_json JSONB NOT NULL DEFAULT '{"x":0,"y":0,"rotation":0,"scale":1}'::jsonb,
            is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_clothing_items DROP CONSTRAINT IF EXISTS chat_clothing_items_category_check');
    await pool.query("ALTER TABLE chat_clothing_items ADD CONSTRAINT chat_clothing_items_category_check CHECK (category IN ('headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory'))");
    await pool.query('ALTER TABLE chat_clothing_items ADD COLUMN IF NOT EXISTS is_equipped BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_clothing_items_user_idx ON chat_clothing_items (target_user_id, id)');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_clothing_catalog (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(60) NOT NULL,
            description VARCHAR(300) NOT NULL DEFAULT '',
            category VARCHAR(20) NOT NULL CHECK (category IN ('headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory')),
            image BYTEA NOT NULL,
            mime_type VARCHAR(24) NOT NULL CHECK (mime_type IN ('image/png', 'image/webp')),
            required_level INTEGER NOT NULL DEFAULT 1 CHECK (required_level BETWEEN 1 AND 20),
            price INTEGER NOT NULL DEFAULT 0 CHECK (price BETWEEN 0 AND 100000000),
            transform_json JSONB NOT NULL DEFAULT '{"x":0,"y":0,"rotation":0,"scale":1}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_clothing_catalog DROP CONSTRAINT IF EXISTS chat_clothing_catalog_category_check');
    await pool.query("ALTER TABLE chat_clothing_catalog ADD CONSTRAINT chat_clothing_catalog_category_check CHECK (category IN ('headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory'))");
    await pool.query('ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS image_version BIGINT NOT NULL DEFAULT 1');
    await pool.query("ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS animation_json JSONB NOT NULL DEFAULT '{\"columns\":1,\"rows\":1,\"frames\":1,\"fps\":8}'::jsonb");
    await pool.query('ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS is_shop_listed BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query("ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS variant_group VARCHAR(60) NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS variant_label VARCHAR(30) NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE chat_clothing_catalog ADD COLUMN IF NOT EXISTS target_avatar_type VARCHAR(8) NOT NULL DEFAULT 'boy'");
    await pool.query('ALTER TABLE chat_clothing_catalog DROP CONSTRAINT IF EXISTS chat_clothing_catalog_target_avatar_type_check');
    await pool.query("ALTER TABLE chat_clothing_catalog ADD CONSTRAINT chat_clothing_catalog_target_avatar_type_check CHECK (target_avatar_type IN ('boy', 'girl'))");
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_shop_settings (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
            is_open BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('INSERT INTO chat_shop_settings (singleton, is_open) VALUES (TRUE, FALSE) ON CONFLICT (singleton) DO NOTHING');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_shop_room_items (
            room_id TEXT NOT NULL REFERENCES chat_public_rooms(id) ON DELETE CASCADE,
            clothing_item_id BIGINT NOT NULL REFERENCES chat_clothing_catalog(id) ON DELETE CASCADE,
            variant_group VARCHAR(60) NOT NULL DEFAULT '',
            variant_label VARCHAR(30) NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (room_id, clothing_item_id)
        )
    `);
    await pool.query("ALTER TABLE chat_shop_room_items ADD COLUMN IF NOT EXISTS variant_group VARCHAR(60) NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE chat_shop_room_items ADD COLUMN IF NOT EXISTS variant_label VARCHAR(30) NOT NULL DEFAULT ''");
    await pool.query("ALTER TABLE chat_shop_room_items ADD COLUMN IF NOT EXISTS shop_section_key VARCHAR(20) NOT NULL DEFAULT ''");
    await pool.query(`
        UPDATE chat_shop_room_items listed
        SET shop_section_key = CASE
            WHEN item.required_level <= 8 THEN 'level_1_8'
            WHEN item.required_level <= 16 THEN 'level_9_16'
            ELSE 'level_17_20'
        END
        FROM chat_clothing_catalog item
        WHERE listed.clothing_item_id = item.id AND listed.shop_section_key = ''
    `);
    await pool.query(`
        UPDATE chat_shop_room_items listed
        SET shop_section_key = CASE
            WHEN item.required_level <= 8 THEN 'level_1_8'
            WHEN item.required_level <= 16 THEN 'level_9_16'
            ELSE 'level_17_20'
        END
        FROM chat_clothing_catalog item
        WHERE listed.clothing_item_id = item.id
          AND listed.shop_section_key IN ('level_1_8', 'level_9_16', 'level_17_20')
          AND listed.shop_section_key <> CASE
              WHEN item.required_level <= 8 THEN 'level_1_8'
              WHEN item.required_level <= 16 THEN 'level_9_16'
              ELSE 'level_17_20'
          END
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_app_migrations (
            migration_key TEXT PRIMARY KEY,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    const { rows: [shopMigration] } = await pool.query(
        "SELECT migration_key FROM chat_app_migrations WHERE migration_key = 'room-based-shops-v1'"
    );
    const { rows: [shopVariantMigration] } = await pool.query(
        "SELECT migration_key FROM chat_app_migrations WHERE migration_key = 'shop-variants-per-room-v1'"
    );
    if (!shopVariantMigration) {
        await pool.query(`
            UPDATE chat_shop_room_items listed
            SET variant_group = item.variant_group, variant_label = item.variant_label
            FROM chat_clothing_catalog item
            WHERE listed.clothing_item_id = item.id AND item.variant_group <> ''
        `);
        await pool.query("INSERT INTO chat_app_migrations (migration_key) VALUES ('shop-variants-per-room-v1') ON CONFLICT DO NOTHING");
    }
    if (!shopMigration) {
        // Carry the old single-shop setup into its first matching public room once.
        await pool.query(`
            UPDATE chat_public_rooms
            SET is_shop = TRUE,
                shop_is_open = COALESCE((SELECT is_open FROM chat_shop_settings WHERE singleton = TRUE), FALSE)
            WHERE id = 'public:4' OR lower(name) LIKE '%tøjbutik%' OR lower(name) LIKE '%toejbutik%' OR lower(name) LIKE '%tojbutik%'
        `);
        await pool.query(`
            INSERT INTO chat_shop_room_items (room_id, clothing_item_id)
            SELECT room.id, item.id
            FROM chat_public_rooms room CROSS JOIN chat_clothing_catalog item
            WHERE room.is_shop
              AND (room.id = 'public:4' OR lower(room.name) LIKE '%tøjbutik%' OR lower(room.name) LIKE '%toejbutik%' OR lower(room.name) LIKE '%tojbutik%')
              AND item.is_shop_listed = TRUE
            ON CONFLICT DO NOTHING
        `);
        await pool.query('UPDATE chat_clothing_catalog SET is_shop_listed = FALSE WHERE is_shop_listed = TRUE');
        await pool.query("INSERT INTO chat_app_migrations (migration_key) VALUES ('room-based-shops-v1') ON CONFLICT DO NOTHING");
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_clothing_assignments (
            id BIGSERIAL PRIMARY KEY,
            target_user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            clothing_item_id BIGINT NOT NULL REFERENCES chat_clothing_catalog(id) ON DELETE CASCADE,
            is_equipped BOOLEAN NOT NULL DEFAULT FALSE,
            assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (target_user_id, clothing_item_id)
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_clothing_assignments_user_idx ON chat_clothing_assignments (target_user_id, clothing_item_id)');
    // Migrate the legacy per-user copies into reusable catalog entries and assignments.
    await pool.query(`
        INSERT INTO chat_clothing_catalog
            (id, name, description, category, image, mime_type, required_level, price, transform_json, created_at)
        SELECT id, name, description, category, image, mime_type, required_level, price, transform_json, created_at
        FROM chat_clothing_items
        ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
        INSERT INTO chat_clothing_assignments (target_user_id, clothing_item_id, is_equipped, assigned_at)
        SELECT target_user_id, id, is_equipped, created_at FROM chat_clothing_items
        ON CONFLICT (target_user_id, clothing_item_id) DO NOTHING
    `);
    await pool.query('DELETE FROM chat_clothing_items');
    await pool.query(`
        SELECT setval(pg_get_serial_sequence('chat_clothing_catalog', 'id'),
            GREATEST(COALESCE((SELECT MAX(id) FROM chat_clothing_catalog), 1), 1),
            EXISTS (SELECT 1 FROM chat_clothing_catalog))
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_users_registration_ip_hash_idx ON chat_users (registration_ip_hash) WHERE registration_ip_hash IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_online_sessions (
            socket_id TEXT PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES chat_users(id) ON DELETE CASCADE,
            ip_hash TEXT,
            tab_id TEXT,
            last_accounted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('ALTER TABLE chat_online_sessions ADD COLUMN IF NOT EXISTS ip_hash TEXT');
    await pool.query('ALTER TABLE chat_online_sessions ADD COLUMN IF NOT EXISTS tab_id TEXT');
    await pool.query('ALTER TABLE chat_online_sessions ADD COLUMN IF NOT EXISTS room_id TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_online_sessions_user_id_idx ON chat_online_sessions (user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS chat_online_sessions_ip_hash_idx ON chat_online_sessions (ip_hash) WHERE ip_hash IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_ip_bans (
            id BIGSERIAL PRIMARY KEY,
            ip_hash TEXT NOT NULL UNIQUE,
            ip_address_encrypted TEXT NOT NULL,
            username VARCHAR(18) NOT NULL,
            reason VARCHAR(240) NOT NULL,
            admin_initials VARCHAR(8) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_ip_bans_expires_at_idx ON chat_ip_bans (expires_at) WHERE expires_at IS NOT NULL');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_user_last_ips (
            user_id BIGINT PRIMARY KEY REFERENCES chat_users(id) ON DELETE CASCADE,
            ip_hash TEXT NOT NULL,
            ip_address_encrypted TEXT NOT NULL,
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS chat_user_last_ips_ip_hash_idx ON chat_user_last_ips (ip_hash)');
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
    app.get('/api/avatar/girl', async (_request, response) => {
        try {
            const { rows: [avatar] } = await pool.query(
                "SELECT image_data, mime_type, version FROM chat_avatar_assets WHERE avatar_type = 'girl'"
            );
            if (!avatar) {
                response.sendStatus(404);
                return;
            }
            response.set({
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            response.type(avatar.mime_type).send(avatar.image_data);
        } catch (error) {
            console.error('Could not load girl avatar:', getSafeErrorCode(error));
            response.sendStatus(500);
        }
    });
    app.get('/api/public-room-background/:roomId', async (request, response) => {
        const roomId = String(request.params.roomId || '');
        if (!/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)) {
            response.sendStatus(404);
            return;
        }
        try {
            const { rows: [room] } = await pool.query(
                'SELECT background_image, background_mime_type FROM chat_public_rooms WHERE id = $1', [roomId]
            );
            if (!room?.background_image) {
                response.sendStatus(404);
                return;
            }
            response.set({
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff'
            });
            response.type(room.background_mime_type || 'image/jpeg').send(room.background_image);
        } catch (error) {
            console.error('Could not load public room background:', getSafeErrorCode(error));
            response.sendStatus(500);
        }
    });
    app.get('/api/public-room-overlay/:roomId', async (request, response) => {
        const roomId = String(request.params.roomId || '');
        if (!/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)) {
            response.sendStatus(404);
            return;
        }
        try {
            const { rows: [room] } = await pool.query(
                'SELECT overlay_image, overlay_mime_type FROM chat_public_rooms WHERE id = $1', [roomId]
            );
            if (!room?.overlay_image) {
                response.sendStatus(404);
                return;
            }
            response.set({
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff'
            });
            response.type(room.overlay_mime_type || 'image/webp').send(room.overlay_image);
        } catch (error) {
            console.error('Could not load public room overlay:', getSafeErrorCode(error));
            response.sendStatus(500);
        }
    });
    app.get('/api/clothing-items/:itemId/image', async (request, response) => {
        const itemId = String(request.params.itemId || '');
        if (!/^[1-9]\d{0,18}$/.test(itemId)) {
            response.sendStatus(404);
            return;
        }
        try {
            const { rows: [item] } = await pool.query(
                'SELECT image, mime_type FROM chat_clothing_catalog WHERE id = $1', [itemId]
            );
            if (!item?.image) {
                response.sendStatus(404);
                return;
            }
            response.set({
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff'
            });
            response.type(item.mime_type).send(item.image);
        } catch (error) {
            console.error('Could not load clothing image:', getSafeErrorCode(error));
            response.sendStatus(500);
        }
    });
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

    async function replaceSameTabOnlineSession(socket) {
        const { rows: [existingSession] } = await pool.query(
            'SELECT socket_id, tab_id FROM chat_online_sessions WHERE user_id = $1 LIMIT 1',
            [socket.data.user.id]
        );
        if (!existingSession || existingSession.socket_id === socket.id) return;

        const [existingSocket] = await io.in(existingSession.socket_id).fetchSockets();
        const sameTab = existingSession.tab_id === socket.data.tabId
            || (existingSocket?.data.tabId === socket.data.tabId
                && existingSocket?.data.sessionId === socket.data.sessionId)
            // Older sessions created before tab IDs were stored can be reclaimed
            // only after their socket has disappeared.
            || (!existingSocket && !existingSession.tab_id);
        if (!sameTab) return;

        const oldSocketId = existingSession.socket_id;
        const roomIds = await getAllRoomIds();
        let roomId = existingSocket?.data.roomId || activeSocketRooms.get(oldSocketId) || null;
        if (!roomId) {
            for (const candidateRoomId of roomIds) {
                if (await redis.hExists(roomKeys(candidateRoomId).players, oldSocketId)) {
                    roomId = candidateRoomId;
                    break;
                }
            }
        }

        if (roomId) {
            const keys = roomKeys(roomId);
            const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [oldSocketId]
            });
            if (removed) io.to(roomChannel(roomId)).emit('playerDisconnected', oldSocketId);
        }
        activeSocketIds.delete(oldSocketId);
        activeSocketRooms.delete(oldSocketId);
        activeSocketUsers.delete(oldSocketId);
        invisibleSocketIds.delete(oldSocketId);
        await accountOnlineSession(oldSocketId, true);
        io.in(oldSocketId).disconnectSockets(true);
    }

    async function startOnlineSession(socketId, userId, ipHash, tabId, roomId) {
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
                INSERT INTO chat_online_sessions (socket_id, user_id, ip_hash, tab_id, room_id, last_accounted_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
            `, [socketId, userId, ipHash, tabId, roomId]);
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
        request.session.user = { id: user.id, username: user.username, avatarType: user.avatarType === 'girl' ? 'girl' : 'boy' };
        request.session.tabId = tabId;
        request.session.clientIp = getRequestIpAddress(request);
        request.session.ipHash = hashRegistrationIp(
            request.session.clientIp,
            SESSION_SECRET
        );
        request.session.ipRecorded = true;
        await recordUserLastIp(user.id, request.session.clientIp, request.session.ipHash);
        await new Promise((resolve, reject) => {
            request.session.save((error) => error ? reject(error) : resolve());
        });
    };

    app.get('/api/auth/me', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        try {
            const clientIp = getRequestIpAddress(request);
            const ipHash = hashRegistrationIp(clientIp, SESSION_SECRET);
            const ban = await getActiveIpBan(ipHash);
            if (ban) {
                response.status(403).json({ code: 'CHAT_IP_BANNED', error: formatIpBanMessage(ban) });
                return;
            }
            if (!request.session.ipRecorded || request.session.ipHash !== ipHash) {
                request.session.clientIp = clientIp;
                request.session.ipHash = ipHash;
                request.session.ipRecorded = true;
                await recordUserLastIp(request.session.user.id, clientIp, ipHash);
                await new Promise((resolve, reject) => {
                    request.session.save((error) => error ? reject(error) : resolve());
                });
            }
            const { rows: [account] } = await pool.query(
                'SELECT avatar_type FROM chat_users WHERE id = $1', [request.session.user.id]
            );
            if (!account) {
                response.status(401).json({ error: 'Brugeren findes ikke l\u00e6ngere.' });
                return;
            }
            request.session.user.avatarType = account.avatar_type === 'girl' ? 'girl' : 'boy';
            response.json({ user: request.session.user });
        } catch (error) {
            next(error);
        }
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

    app.delete('/api/profile/account', async (request, response, next) => {
        if (!isAuthorizedTabSession(request.session, getRequestTabId(request))) {
            response.status(401).json({ error: 'Log ind for at fortsætte.' });
            return;
        }
        const currentPassword = request.body && request.body.currentPassword;
        const confirmationUsername = request.body && request.body.confirmationUsername;
        if (!isValidPassword(currentPassword) || typeof confirmationUsername !== 'string') {
            response.status(400).json({ error: 'Udfyld adgangskode og bekræft dit brugernavn.' });
            return;
        }
        const userId = String(request.session.user.id);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [account] } = await client.query(
                'SELECT username, password_hash FROM chat_users WHERE id = $1 FOR UPDATE', [userId]
            );
            if (!account || !(await bcrypt.compare(currentPassword, account.password_hash))) {
                await client.query('ROLLBACK');
                response.status(400).json({ error: 'Den nuværende adgangskode er forkert.' });
                return;
            }
            if (confirmationUsername.trim().toLocaleLowerCase('en-US') !== account.username.toLocaleLowerCase('en-US')) {
                await client.query('ROLLBACK');
                response.status(400).json({ error: 'Skriv dit brugernavn præcis for at bekræfte sletningen.' });
                return;
            }
            const { rows: onlineSockets } = await client.query(
                'SELECT socket_id FROM chat_online_sessions WHERE user_id = $1', [userId]
            );
            const { rows: userSessions } = await client.query(
                `SELECT sid FROM "session" WHERE sess->'user'->>'id' = $1`, [userId]
            );
            await client.query(`DELETE FROM "session" WHERE sess->'user'->>'id' = $1`, [userId]);
            await client.query('DELETE FROM chat_users WHERE id = $1', [userId]);
            await client.query('COMMIT');

            for (const { socket_id: socketId } of onlineSockets) {
                activeSocketIds.delete(socketId);
                invisibleSocketIds.delete(socketId);
                activeSocketRooms.delete(socketId);
                activeSocketUsers.delete(socketId);
                try {
                    for (const roomId of await getAllRoomIds()) {
                        const keys = roomKeys(roomId);
                        const removed = await redis.eval(REMOVE_PLAYER_SCRIPT, {
                            keys: [keys.players, keys.cells], arguments: [socketId]
                        });
                        if (removed) io.to(roomChannel(roomId)).emit('playerDisconnected', socketId);
                    }
                } catch (cleanupError) {
                    console.error('Could not fully clean up deleted account presence:', getSafeErrorCode(cleanupError));
                }
                io.in(socketId).disconnectSockets(true);
            }
            for (const { sid } of userSessions) io.in(`session:${sid}`).disconnectSockets(true);
            io.emit('navigator-refresh');
            response.clearCookie('chat.sid', {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax'
            });
            response.json({ success: true });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            next(error);
        } finally {
            client.release();
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
        try {
            const ban = await getActiveIpBan(hashRegistrationIp(getRequestIpAddress(request), SESSION_SECRET));
            if (ban) {
                response.status(403).json({ code: 'CHAT_IP_BANNED', error: formatIpBanMessage(ban) });
                return;
            }
        } catch (error) {
            next(error);
            return;
        }
        const account = normalizeUsername(request.body && request.body.username);
        const password = request.body && request.body.password;
        const avatarType = request.body && request.body.avatarType;
        if (!['boy', 'girl'].includes(avatarType)) {
            response.status(400).json({ error: 'Vælg en avatar til din konto.' });
            return;
        }
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
            if (avatarType === 'girl') {
                const { rowCount } = await pool.query(
                    "SELECT 1 FROM chat_avatar_assets WHERE avatar_type = 'girl'"
                );
                if (!rowCount) {
                    response.status(400).json({ error: 'Pigeavataren er ikke tilgængelig endnu.' });
                    return;
                }
            }
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
                    'INSERT INTO chat_users (username, username_normalized, password_hash, registration_ip_hash, avatar_type, last_login_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, username, avatar_type',
                    [account.username, account.normalized, passwordHash, registrationIpHash, avatarType]
                );
                await client.query('COMMIT');
                user = { id: result.rows[0].id, username: result.rows[0].username, avatarType: result.rows[0].avatar_type };
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
        try {
            const ban = await getActiveIpBan(hashRegistrationIp(getRequestIpAddress(request), SESSION_SECRET));
            if (ban) {
                response.status(403).json({ code: 'CHAT_IP_BANNED', error: formatIpBanMessage(ban) });
                return;
            }
        } catch (error) {
            next(error);
            return;
        }
        const account = normalizeUsername(request.body && request.body.username);
        const password = request.body && request.body.password;
        if (!account || !isValidPassword(password)) {
            response.status(401).json({ error: 'Forkert brugernavn eller adgangskode.' });
            return;
        }

        try {
            const result = await pool.query(
                'SELECT id, username, password_hash, avatar_type FROM chat_users WHERE username_normalized = $1',
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
            const user = { id: userRecord.id, username: userRecord.username, avatarType: userRecord.avatar_type === 'girl' ? 'girl' : 'boy' };
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

    io.use(async (socket, next) => {
        const session = socket.request.session;
        const tabId = socket.handshake.auth && socket.handshake.auth.tabId;
        if (!isAuthorizedTabSession(session, tabId)) {
            next(new Error('Log ind for at fortsætte.'));
            return;
        }
        socket.data.user = session.user;
        socket.data.tabId = tabId;
        socket.data.sessionId = socket.request.sessionID;
        socket.data.mood = ['glad', 'mobset', 'ked', 'blappet', 'boevet'].includes(session.mood) ? session.mood : 'glad';
        const forwardedAddresses = String(socket.request.headers['x-forwarded-for'] || '')
            .split(',').map((address) => address.trim()).filter(Boolean);
        socket.data.clientIp = session.clientIp
            || forwardedAddresses.at(-1)
            || socket.handshake.address
            || socket.request.socket.remoteAddress;
        socket.data.ipHash = session.ipHash || hashRegistrationIp(
            socket.data.clientIp,
            SESSION_SECRET
        );
        socket.data.adminRole = getAdminRole(socket.data.user);
        socket.data.isAdmin = socket.data.adminRole === 'full';
        socket.data.canManagePublicRooms = socket.data.isAdmin || socket.data.adminRole === 'rooms-clothing';
        socket.data.canManageClothing = socket.data.isAdmin || socket.data.adminRole === 'rooms-clothing';
        try {
            const ban = await getActiveIpBan(socket.data.ipHash);
            if (ban) {
                next(new Error(`CHAT_IP_BANNED:${formatIpBanMessage(ban)}`));
                return;
            }
            next();
        } catch (error) {
            next(error);
        }
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
        let removedAnyPlayers = false;
        for (const currentRoomId of roomIds) {
            const keys = roomKeys(currentRoomId);
            const now = Date.now();
            const removedIds = await redis.eval(CLEAN_STALE_PLAYERS_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [String(now - PRESENCE_EXPIRY), String(now)]
            });
            for (const id of removedIds) {
                removedAnyPlayers = true;
                activeSocketIds.delete(id);
                invisibleSocketIds.delete(id);
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
        if (removedAnyPlayers) await broadcastChatOnlineCount();
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
        let removedAnyPlayers = false;
        for (const roomId of await getAllRoomIds()) {
            const keys = roomKeys(roomId);
            const now = Date.now();
            const removedIds = await redis.eval(KICK_IDLE_PLAYERS_SCRIPT, {
                keys: [keys.players, keys.cells],
                arguments: [String(now - PLAYER_IDLE_TIMEOUT), String(now)]
            });
            for (const id of removedIds) {
                removedAnyPlayers = true;
                activeSocketIds.delete(id);
                invisibleSocketIds.delete(id);
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
        if (removedAnyPlayers) await broadcastChatOnlineCount();
    }

    async function kickPlayer(socketId, message) {
        let roomId = activeSocketRooms.get(socketId) || null;
        if (!roomId) {
            for (const candidateRoomId of await getAllRoomIds()) {
                if (await redis.hExists(roomKeys(candidateRoomId).players, socketId)) {
                    roomId = candidateRoomId;
                    break;
                }
            }
        }
        roomId ||= 'common';
        const keys = roomKeys(roomId);
        activeSocketIds.delete(socketId);
        activeSocketRooms.delete(socketId);
        activeSocketUsers.delete(socketId);
        invisibleSocketIds.delete(socketId);
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
        await broadcastChatOnlineCount();
        try {
            await invalidateSocketSession(socketId);
        } catch (error) {
            console.error('Could not invalidate kicked participant session:', getSafeErrorCode(error));
        }
        io.to(socketId).emit('session-kicked', { message });
        setTimeout(() => io.in(socketId).disconnectSockets(true), 100);
    }

    async function refreshRoomPlayersClothing(roomId, players) {
        const playerNames = [...new Set(Object.values(players)
            .map((player) => normalizeUsername(player.name)?.normalized)
            .filter(Boolean))];
        if (!playerNames.length) return players;

        const { rows } = await pool.query(`
            SELECT target.username_normalized, target.wardrobe_category_order,
                   item.id, item.name, item.category, item.image_version, item.transform_json, item.animation_json
            FROM chat_users target
            JOIN chat_clothing_assignments assignment
              ON assignment.target_user_id = target.id AND assignment.is_equipped = TRUE
            JOIN chat_clothing_catalog item
              ON item.id = assignment.clothing_item_id AND item.target_avatar_type = target.avatar_type
            WHERE target.username_normalized = ANY($1::text[])
            ORDER BY target.username_normalized, item.id
        `, [playerNames]);

        const clothingByName = new Map();
        for (const row of rows) {
            const clothing = clothingByName.get(row.username_normalized) || [];
            const transform = normalizeClothingTransform(row.transform_json, row.category);
            const categoryOrder = normalizeWardrobeCategoryOrder(row.wardrobe_category_order);
            clothing.push({
                id: String(row.id),
                name: row.name,
                category: row.category,
                imageVersion: Number(row.image_version || 1),
                imageUrl: `/api/clothing-items/${encodeURIComponent(row.id)}/image?v=${row.image_version || 1}`,
                animation: normalizeClothingAnimation(row.animation_json),
                x: transform.x,
                y: transform.y,
                rotation: transform.rotation,
                scale: transform.scale,
                scaleX: transform.scaleX,
                scaleY: transform.scaleY,
                skewX: transform.skewX,
                skewY: transform.skewY,
                layerPosition: transform.layerPosition,
                ...(categoryOrder ? { layerOrder: WARDROBE_CATEGORIES.length - categoryOrder.indexOf(row.category) } : {})
            });
            clothingByName.set(row.username_normalized, clothing);
        }

        await Promise.all(Object.entries(players).map(async ([playerId, player]) => {
            const username = normalizeUsername(player.name)?.normalized;
            const clothing = username ? (clothingByName.get(username) || []) : [];
            player.clothing = clothing;
            const repairedPlayer = await redis.eval(UPDATE_PLAYER_CLOTHING_SCRIPT, {
                keys: [roomKeys(roomId).players],
                arguments: [playerId, JSON.stringify(clothing), String(Date.now()), invisibleSocketIds.has(playerId) ? '1' : '0']
            });
            if (repairedPlayer) Object.assign(player, publicPlayer(JSON.parse(repairedPlayer)));
        }));
        return players;
    }

    async function getPlayers(roomId = 'common', viewerSocket = null, refreshClothing = false) {
        if (refreshClothing) {
            const playersBeforeRefresh = getPublicPlayers(await redis.hGetAll(roomKeys(roomId).players));
            await refreshRoomPlayersClothing(roomId, playersBeforeRefresh);
        }
        await cleanupStalePlayers(roomId);
        const allPlayers = getPublicPlayers(await redis.hGetAll(roomKeys(roomId).players));
        if (!viewerSocket || canSeeInvisibleUser(viewerSocket)) return allPlayers;
        for (const socketId of invisibleSocketIds) delete allPlayers[socketId];
        return allPlayers;
    }

    async function emitPlayerPresence(roomId, eventName, player) {
        if (!invisibleSocketIds.has(player.id)) {
            io.to(roomChannel(roomId)).emit(eventName, player);
            return;
        }
        const recipients = await io.in(roomChannel(roomId)).fetchSockets();
        for (const recipient of recipients) {
            if (recipient.id === player.id || canSeeInvisibleUser(recipient)) recipient.emit(eventName, player);
        }
    }

    async function emitRoomEventForVisibleSender(roomId, eventName, payload, senderSocketId) {
        if (!invisibleSocketIds.has(senderSocketId)) {
            io.to(roomChannel(roomId)).emit(eventName, payload);
            return;
        }
        const recipients = await io.in(roomChannel(roomId)).fetchSockets();
        for (const recipient of recipients) {
            if (recipient.id === senderSocketId || canSeeInvisibleUser(recipient)) recipient.emit(eventName, payload);
        }
    }

    async function getUserClothing(userId) {
        const { rows } = await pool.query(`
            SELECT item.id, item.name, item.category, item.image_version, item.transform_json, item.animation_json,
                   target.wardrobe_category_order
            FROM chat_clothing_assignments assignment
            JOIN chat_clothing_catalog item ON item.id = assignment.clothing_item_id
            JOIN chat_users target ON target.id = assignment.target_user_id
            WHERE assignment.target_user_id = $1 AND assignment.is_equipped = TRUE
              AND item.target_avatar_type = target.avatar_type
            ORDER BY item.id
        `, [userId]);
        const categoryOrder = normalizeWardrobeCategoryOrder(rows[0]?.wardrobe_category_order);
        return rows.map((item) => {
            const transform = normalizeClothingTransform(item.transform_json, item.category);
            return {
                id: String(item.id),
                name: item.name,
                category: item.category,
                imageVersion: Number(item.image_version || 1),
                imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${item.image_version || 1}`,
                animation: normalizeClothingAnimation(item.animation_json),
                x: transform.x,
                y: transform.y,
                rotation: transform.rotation,
                scale: transform.scale,
                scaleX: transform.scaleX,
                scaleY: transform.scaleY,
                skewX: transform.skewX,
                skewY: transform.skewY,
                layerPosition: transform.layerPosition,
                ...(categoryOrder ? { layerOrder: WARDROBE_CATEGORIES.length - categoryOrder.indexOf(item.category) } : {})
            };
        });
    }

    async function refreshOnlineUserClothing(userId) {
        const clothing = await getUserClothing(userId);
        for (const socketId of activeSocketIds) {
            if (String(activeSocketUsers.get(socketId) || '') !== String(userId)) continue;
            const roomId = activeSocketRooms.get(socketId);
            if (!roomId) continue;
            const keys = roomKeys(roomId);
            const updated = await redis.eval(UPDATE_PLAYER_CLOTHING_SCRIPT, {
                keys: [keys.players],
                arguments: [socketId, JSON.stringify(clothing), String(Date.now()), invisibleSocketIds.has(socketId) ? '1' : '0']
            });
            if (!updated) continue;
            await emitRoomEventForVisibleSender(roomId, 'player-clothing-updated', { id: socketId, clothing }, socketId);
        }
    }

    async function enforceClothingLevelForAssignments(itemId, requiredLevel) {
        const { rows: assignments } = await pool.query(
            'SELECT DISTINCT target_user_id::text AS user_id FROM chat_clothing_assignments WHERE clothing_item_id = $1', [itemId]
        );
        await Promise.all(assignments.map(async ({ user_id: userId }) => {
            const [onlineMs, { rows: [progress] }] = await Promise.all([
                getTotalOnlineMs(userId),
                pool.query('SELECT accepted_chat_messages FROM chat_users WHERE id = $1', [userId])
            ]);
            if (getUserLevel(onlineMs, Number(progress?.accepted_chat_messages || 0)) < requiredLevel) {
                await pool.query(
                    'UPDATE chat_clothing_assignments SET is_equipped = FALSE WHERE target_user_id = $1 AND clothing_item_id = $2',
                    [userId, itemId]
                );
            }
            await refreshOnlineUserClothing(userId);
        }));
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
        const publicMatch = /^public:([1-9]\d{0,18})$/.exec(String(roomId || ''));
        if (publicMatch) {
            const { rowCount } = await pool.query('SELECT 1 FROM chat_public_rooms WHERE id = $1', [roomId]);
            return rowCount > 0;
        }
        if (roomId === 'common' || roomId === 'disco') return true;
        const match = /^apartment:([1-9]\d{0,18})$/.exec(String(roomId || ''));
        if (!match) return false;
        const { rowCount } = await pool.query('SELECT 1 FROM chat_apartments WHERE id = $1', [match[1]]);
        return rowCount > 0;
    }

    async function getPublicRoomPolicy(roomId) {
        if (!isPublicChatRoomId(roomId)) return null;
        const { rows: [room] = [] } = await pool.query(
            'SELECT is_locked, is_hidden FROM chat_public_rooms WHERE id = $1', [roomId]
        );
        return room || null;
    }

    function publicRoomAccessError(policy, isAdmin) {
        if (!policy) return 'Rummet findes ikke.';
        if (policy.is_hidden && !isAdmin) return 'Rummet findes ikke.';
        if (policy.is_locked && !isAdmin) return 'Rummet er låst for deltagere lige nu.';
        return '';
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
        let layout = null;
        if (match) {
            const { rows: [apartment] } = await pool.query(
                'SELECT layout_json FROM chat_apartments WHERE id = $1', [match[1]]
            );
            if (!apartment) return {};
            layout = apartment.layout_json;
        } else if (isPublicChatRoomId(roomId)) {
            const { rows: [room] } = await pool.query(
                'SELECT layout_json, background_image IS NOT NULL AS has_background FROM chat_public_rooms WHERE id = $1', [roomId]
            );
            if (!room) return {};
            layout = room.layout_json;
            const tiles = normalizeApartmentTiles(layout);
            const hasSavedLayout = layout && typeof layout === 'object' && Object.keys(layout).length > 0;
            if (!room.has_background && !hasSavedLayout) {
                for (const cell of TEST_ROOM_FURNITURE_CELL_KEYS) {
                    if (GRID_CELL_KEYS.has(cell)) tiles[cell] = 'closed';
                }
            }
            const tilesKey = roomKeys(roomId).tiles;
            await redis.del(tilesKey);
            if (Object.keys(tiles).length) await redis.hSet(tilesKey, tiles);
            return tiles;
        } else {
            const defaults = Object.fromEntries([...DEFAULT_CLOSED_CELL_KEYS].map((cell) => [cell, 'closed']));
            const tilesKey = roomKeys(roomId).tiles;
            await redis.del(tilesKey);
            if (Object.keys(defaults).length) await redis.hSet(tilesKey, defaults);
            return defaults;
        }
        const tiles = normalizeApartmentTiles(layout);
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
        const { rows: [publicRoom] = [] } = await pool.query(`
            SELECT id, room_number, name, welcome_title, welcome_text,
                   background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                   overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform,
                   is_shop, shop_is_open
            FROM chat_public_rooms WHERE id = $1
        `, [roomId]);
        const roomName = publicRoom ? formatPublicRoomName(publicRoom) : PUBLIC_ROOM_NAMES[roomId] || 'chatten';
        return {
            welcomeTitle: publicRoom?.welcome_title || `Velkommen i ${roomName}`,
            welcomeText: publicRoom?.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
            roomBackgroundUrl: getPublicRoomBackgroundUrl(publicRoom),
            roomBackgroundAnimation: normalizeClothingAnimation(publicRoom?.background_animation_json),
            roomOverlayUrl: getPublicRoomOverlayUrl(publicRoom),
            roomOverlayTransform: normalizePublicRoomOverlayTransform(publicRoom?.overlay_transform),
            isShop: publicRoom?.is_shop === true,
            shopIsOpen: publicRoom?.shop_is_open === true
        };
    }

    async function placeSocketInRoom(socket, roomId, { bypassRoomAccess = false } = {}) {
        if (isPublicChatRoomId(roomId)) {
            const policy = await getPublicRoomPolicy(roomId);
            if (publicRoomAccessError(policy, bypassRoomAccess || Boolean(socket.data.canManagePublicRooms))) return null;
        }
        const keys = roomKeys(roomId);
        const apartmentTiles = await loadApartmentTiles(roomId);
        const clothing = await getUserClothing(socket.data.user.id);
        const joined = await redis.eval(PLAYER_JOIN_SCRIPT, {
            keys: [keys.players, keys.cells, keys.tiles],
            arguments: [socket.id, socket.data.user.username, String(Date.now()),
                socket.data.mood || 'glad',
                JSON.stringify(clothing),
                invisibleSocketIds.has(socket.id) ? '1' : '0',
                socket.data.user.avatarType === 'girl' ? 'girl' : 'boy',
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
        await pool.query('UPDATE chat_online_sessions SET room_id = $2 WHERE socket_id = $1', [socket.id, roomId]);
        await socket.join(roomChannel(roomId));
        const players = await getPlayers(roomId, socket, true);
        for (const player of Object.values(players)) {
            player.text = '';
            player.messageTime = 0;
        }
        let roomName = PUBLIC_ROOM_NAMES[roomId] || 'Lejlighed';
        if (['common', 'disco'].includes(roomId) || /^public:[1-9]\d{0,18}$/.test(roomId)) {
            const { rows: [publicRoom] = [] } = await pool.query('SELECT room_number, name FROM chat_public_rooms WHERE id = $1', [roomId]);
            if (!publicRoom) {
                await redis.eval(REMOVE_PLAYER_SCRIPT, { keys: [keys.players, keys.cells], arguments: [socket.id] });
                return null;
            }
            roomName = formatPublicRoomName(publicRoom);
        } else if (roomId.startsWith('apartment:')) {
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
        const canEditPublicRoom = Boolean(socket.data.canManagePublicRooms && isPublicChatRoomId(roomId));
        socket.emit('room-changed', { roomId, roomName, players, apartmentTiles, canEditApartment, canEditPublicRoom, ...welcome });
        // getPlayers(refreshClothing: true) above refreshes the Redis record from
        // the database. Emit that authoritative player snapshot so other clients
        // receive the same equipped spritesheets as the player entering the room.
        await emitPlayerPresence(roomId, 'newPlayer', players[socket.id] || publicPlayer(JSON.parse(joined)));
        io.emit('navigator-refresh');
        await broadcastChatOnlineCount();
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
            await emitRoomEventForVisibleSender(roomId, 'playerMoved', { id: player.id, col: player.col, row: player.row }, player.id);
            return true;
        }
        return false;
    }

    io.on('connection', (socket) => {
        socket.join(`session:${socket.request.sessionID}`);
        socket.emit('admin-status', {
            isAdmin: Boolean(socket.data.isAdmin || socket.data.canManagePublicRooms || socket.data.canManageClothing),
            role: socket.data.adminRole || 'none',
            canManageUsers: Boolean(socket.data.isAdmin),
            canManagePublicRooms: Boolean(socket.data.canManagePublicRooms),
            canManageClothing: Boolean(socket.data.canManageClothing)
        });
        socket.emit('admin-invisibility-state', { invisible: invisibleSocketIds.has(socket.id) });

        socket.on('admin-invisibility-toggle', async () => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!roomId) return;
            try {
                const keys = roomKeys(roomId);
                const encodedPlayer = await redis.hGet(keys.players, socket.id);
                if (!encodedPlayer) return;
                const invisible = !invisibleSocketIds.has(socket.id);
                if (invisible) {
                    const hiddenPlayer = await redis.eval(PLAYER_VISIBILITY_SCRIPT, {
                        keys: [keys.players, keys.cells, keys.tiles],
                        arguments: [socket.id, 'hide', String(Date.now())]
                    });
                    if (!hiddenPlayer) return;
                    invisibleSocketIds.add(socket.id);
                    const recipients = await io.in(roomChannel(roomId)).fetchSockets();
                    for (const recipient of recipients) {
                        if (recipient.id !== socket.id && !canSeeInvisibleUser(recipient)) {
                            recipient.emit('playerDisconnected', socket.id);
                        }
                    }
                } else {
                    const currentPlayer = JSON.parse(encodedPlayer);
                    const candidates = GRID_CELLS.slice().sort((first, second) => {
                        const firstDistance = Math.max(Math.abs(first.col - currentPlayer.col), Math.abs(first.row - currentPlayer.row));
                        const secondDistance = Math.max(Math.abs(second.col - currentPlayer.col), Math.abs(second.row - currentPlayer.row));
                        return firstDistance - secondDistance
                            || Math.abs(first.col - currentPlayer.col) + Math.abs(first.row - currentPlayer.row)
                            - Math.abs(second.col - currentPlayer.col) - Math.abs(second.row - currentPlayer.row);
                    });
                    const visiblePlayerJson = await redis.eval(PLAYER_VISIBILITY_SCRIPT, {
                        keys: [keys.players, keys.cells, keys.tiles],
                        arguments: [socket.id, 'show', String(Date.now()), ...candidates.flatMap((cell) => [String(cell.col), String(cell.row)])]
                    });
                    if (!visiblePlayerJson) {
                        socket.emit('admin-invisibility-result', {
                            invisible: true,
                            message: 'Der er ikke plads til at blive synlig. Prøv igen, når et felt er ledigt.'
                        });
                        return;
                    }
                    invisibleSocketIds.delete(socket.id);
                    const player = publicPlayer(JSON.parse(visiblePlayerJson));
                    socket.to(roomChannel(roomId)).emit('newPlayer', { ...player, text: '', messageTime: 0 });
                    socket.emit('admin-invisibility-state', { invisible: false });
                    socket.emit('admin-invisibility-result', { invisible: false, message: 'Du er synlig for andre igen.' });
                }
                if (invisible) {
                    socket.emit('admin-invisibility-state', { invisible: true });
                    socket.emit('admin-invisibility-result', { invisible: true, message: 'Du er nu usynlig for almindelige brugere.' });
                }
                io.emit('navigator-refresh');
                await broadcastChatOnlineCount();
            } catch (error) {
                console.error('Could not toggle administrator invisibility:', getSafeErrorCode(error));
                socket.emit('admin-invisibility-result', { invisible: invisibleSocketIds.has(socket.id), message: 'Usynlighed kunne ikke ændres. Prøv igen.' });
            }
        });

        async function sendAdminPublicRooms() {
            const rooms = await getPublicRooms();
            const result = await Promise.all(rooms.map(async (room) => ({
                id: room.id,
                roomNumber: Number(room.room_number),
                floorNumber: Number(room.floor_number),
                name: room.name,
                welcomeTitle: room.welcome_title || `Velkommen i ${formatPublicRoomName(room)}`,
                welcomeText: room.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
                isSystem: room.is_system,
                isLocked: room.is_locked,
                isHidden: room.is_hidden,
                isShop: room.is_shop === true,
                shopIsOpen: room.shop_is_open === true,
                hasBackground: room.has_background,
                backgroundUrl: getPublicRoomBackgroundUrl(room),
                backgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                hasOverlay: room.has_overlay,
                overlayUrl: getPublicRoomOverlayUrl(room),
                overlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform),
                count: await redis.hLen(roomKeys(room.id).players)
            })));
            socket.emit('admin-public-rooms', { rooms: result });
        }

        async function sendAdminClothingItems() {
            const { rows } = await pool.query(`
                SELECT item.id, item.name, item.description, item.category, item.target_avatar_type, item.required_level, item.price,
                       item.variant_group, item.variant_label,
                       item.is_shop_listed,
                       item.transform_json, item.animation_json, item.image_version, item.created_at,
                       COUNT(assignment.id)::integer AS assignment_count
                FROM chat_clothing_catalog item
                LEFT JOIN chat_clothing_assignments assignment ON assignment.clothing_item_id = item.id
                GROUP BY item.id ORDER BY item.created_at DESC, item.id DESC LIMIT 200
            `);
            const mapItem = (item) => ({
                id: String(item.id), name: item.name, description: item.description, category: item.category,
                avatarType: item.target_avatar_type,
                variantGroup: item.variant_group || '', variantLabel: item.variant_label || '',
                requiredLevel: Number(item.required_level), price: Number(item.price),
                shopListed: Boolean(item.is_shop_listed),
                imageVersion: Number(item.image_version || 1),
                imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${item.image_version || 1}`,
                animation: normalizeClothingAnimation(item.animation_json),
                transform: normalizeClothingTransform(item.transform_json, item.category)
            });
            socket.emit('admin-clothing-items', {
                catalog: rows.map((item) => ({ ...mapItem(item), assignmentCount: Number(item.assignment_count) }))
            });
        }

        socket.on('admin-clothing-items-request', async () => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            try { await sendAdminClothingItems(); }
            catch (error) {
                console.error('Could not list admin clothing items:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjlisten kunne ikke hentes.' });
            }
        });

        socket.on('admin-shop-item-set', async ({ id, listed } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || typeof listed !== 'boolean') return;
            try {
                const { rows: [item] } = await pool.query(
                    'UPDATE chat_clothing_catalog SET is_shop_listed = $2 WHERE id = $1 RETURNING name',
                    [id, listed]
                );
                if (!item) {
                    socket.emit('admin-shop-action-result', { success: false, message: 'Tøjdelen findes ikke længere.' });
                    return;
                }
                socket.emit('admin-shop-action-result', {
                    success: true,
                    message: listed ? `${item.name} er nu synlig i butikken.` : `${item.name} er fjernet fra butikken.`
                });
                await sendAdminClothingItems();
            } catch (error) {
                console.error('Could not update shop listing:', getSafeErrorCode(error));
                socket.emit('admin-shop-action-result', { success: false, message: 'Butikken kunne ikke opdateres.' });
            }
        });

        socket.on('shop-status-request', async () => {
            if (!socket.data.user) return;
            try {
                const { rows: [status] } = await pool.query('SELECT is_open FROM chat_shop_settings WHERE singleton = TRUE');
                socket.emit('shop-status', { isOpen: status?.is_open === true });
            } catch (error) {
                console.error('Could not read shop status:', getSafeErrorCode(error));
                socket.emit('shop-status', { isOpen: false });
            }
        });

        socket.on('admin-shop-status-request', async () => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            try {
                const { rows: [status] } = await pool.query('SELECT is_open FROM chat_shop_settings WHERE singleton = TRUE');
                socket.emit('admin-shop-status', { isOpen: status?.is_open === true });
            } catch (error) {
                console.error('Could not read admin shop status:', getSafeErrorCode(error));
                socket.emit('admin-shop-status', { isOpen: false });
            }
        });

        socket.on('admin-shop-status-set', async ({ isOpen } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id) || typeof isOpen !== 'boolean') return;
            try {
                await pool.query(`
                    INSERT INTO chat_shop_settings (singleton, is_open, updated_at)
                    VALUES (TRUE, $1, NOW())
                    ON CONFLICT (singleton) DO UPDATE SET is_open = EXCLUDED.is_open, updated_at = NOW()
                `, [isOpen]);
                io.emit('shop-status', { isOpen });
                socket.emit('admin-shop-status-result', {
                    success: true,
                    message: isOpen ? 'Butikken er nu åben for brugerne.' : 'Butikken er lukket for brugerne.'
                });
            } catch (error) {
                console.error('Could not update shop status:', getSafeErrorCode(error));
                socket.emit('admin-shop-status-result', { success: false, message: 'Butikkens status kunne ikke gemmes.' });
            }
        });

        socket.on('admin-shop-rooms-request', async () => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            try {
                const { rows } = await pool.query(`
                    SELECT id, room_number, name, shop_is_open
                    FROM chat_public_rooms WHERE is_shop = TRUE ORDER BY floor_number, room_number
                `);
                socket.emit('admin-shop-rooms', { rooms: rows.map((room) => ({
                    id: room.id, name: formatPublicRoomName(room), isOpen: room.shop_is_open === true
                })) });
            } catch (error) {
                console.error('Could not list shop rooms:', getSafeErrorCode(error));
                socket.emit('admin-shop-rooms', { rooms: [], error: 'Butiksrummene kunne ikke hentes.' });
            }
        });

        socket.on('admin-shop-room-data-request', async ({ roomId } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)) return;
            try {
                const { rows: [room] } = await pool.query(
                    'SELECT id, shop_is_open, shop_content FROM chat_public_rooms WHERE id = $1 AND is_shop = TRUE', [roomId]
                );
                if (!room) {
                    socket.emit('admin-shop-room-data', { roomId, error: 'Vælg et rum, der er markeret som butik.' });
                    return;
                }
                const { rows } = await pool.query(`
                    SELECT item.id, item.name, item.description, item.category, item.target_avatar_type,
                           COALESCE((SELECT listed.variant_group FROM chat_shop_room_items listed WHERE listed.room_id = $1 AND listed.clothing_item_id = item.id), '') AS variant_group,
                           COALESCE((SELECT listed.variant_label FROM chat_shop_room_items listed WHERE listed.room_id = $1 AND listed.clothing_item_id = item.id), '') AS variant_label,
                           COALESCE((SELECT listed.shop_section_key FROM chat_shop_room_items listed WHERE listed.room_id = $1 AND listed.clothing_item_id = item.id), '') AS shop_section_key,
                           item.required_level, item.price, item.transform_json, item.animation_json, item.image_version,
                           EXISTS (SELECT 1 FROM chat_shop_room_items listed
                                   WHERE listed.room_id = $1 AND listed.clothing_item_id = item.id) AS is_shop_listed,
                           COUNT(assignment.id)::integer AS assignment_count
                    FROM chat_clothing_catalog item
                    LEFT JOIN chat_clothing_assignments assignment ON assignment.clothing_item_id = item.id
                    GROUP BY item.id ORDER BY item.created_at DESC, item.id DESC LIMIT 200
                `, [roomId]);
                socket.emit('admin-shop-room-data', { roomId, isOpen: room.shop_is_open === true, shopContent: room.shop_content || {}, items: rows.map((item) => ({
                    id: String(item.id), name: item.name, description: item.description, category: item.category,
                    variantGroup: item.variant_group || '', variantLabel: item.variant_label || '',
                    shopSectionKey: item.shop_section_key === 'custom'
                        ? 'custom'
                        : Number(item.required_level) <= 8 ? 'level_1_8' : Number(item.required_level) <= 16 ? 'level_9_16' : 'level_17_20',
                    avatarType: item.target_avatar_type, requiredLevel: Number(item.required_level), price: Number(item.price),
                    imageVersion: Number(item.image_version || 1), imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${item.image_version || 1}`,
                    animation: normalizeClothingAnimation(item.animation_json),
                    shopListed: item.is_shop_listed === true
                })) });
            } catch (error) {
                console.error('Could not load shop room data:', getSafeErrorCode(error));
                socket.emit('admin-shop-room-data', { roomId, error: 'Butikkens varer kunne ikke hentes.' });
            }
        });

        socket.on('admin-shop-item-level-set', async ({ roomId, id, requiredLevel, sectionKey = '' } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)
                || !Number.isInteger(requiredLevel) || requiredLevel < 1 || requiredLevel > 20
                || !['level_1_8', 'level_9_16', 'level_17_20', 'custom'].includes(sectionKey)) return;
            const expectedSection = requiredLevel <= 8 ? 'level_1_8' : requiredLevel <= 16 ? 'level_9_16' : 'level_17_20';
            if (sectionKey !== 'custom' && sectionKey !== expectedSection) {
                socket.emit('admin-shop-action-result', { success: false, message: 'Niveauet skal passe til den valgte varegruppe.' });
                return;
            }

            const client = await pool.connect();
            let transactionStarted = false;
            let affectedItemIds = [id];
            try {
                await client.query('BEGIN');
                transactionStarted = true;
                const { rowCount: shopExists } = await client.query(
                    'SELECT 1 FROM chat_public_rooms WHERE id = $1 AND is_shop = TRUE FOR UPDATE', [roomId]
                );
                if (!shopExists) throw new Error('NOT_A_SHOP');
                const { rows: variantRows } = await client.query(`
                    SELECT sibling.clothing_item_id::text AS id
                    FROM chat_shop_room_items selected
                    JOIN chat_shop_room_items sibling
                      ON sibling.room_id = selected.room_id
                     AND sibling.variant_group = selected.variant_group
                    WHERE selected.clothing_item_id = $1
                      AND selected.variant_group <> ''
                `, [id]);
                if (variantRows.length) affectedItemIds = [...new Set(variantRows.map((row) => row.id))];
                const { rowCount: itemUpdated } = await client.query(
                    'UPDATE chat_clothing_catalog SET required_level = $2 WHERE id = ANY($1::bigint[])',
                    [affectedItemIds, requiredLevel]
                );
                if (!itemUpdated) throw new Error('ITEM_MISSING');
                // Level groups are shared across shops and follow the item's actual unlock level.
                // A custom fourth group remains where the shop owner placed it.
                await client.query(`
                    UPDATE chat_shop_room_items
                    SET shop_section_key = CASE
                        WHEN $2 <= 8 THEN 'level_1_8'
                        WHEN $2 <= 16 THEN 'level_9_16'
                        ELSE 'level_17_20'
                    END
                    WHERE clothing_item_id = ANY($1::bigint[])
                      AND shop_section_key IN ('level_1_8', 'level_9_16', 'level_17_20')
                `, [affectedItemIds, requiredLevel]);
                await client.query(
                    'UPDATE chat_shop_room_items SET shop_section_key = $3 WHERE room_id = $1 AND clothing_item_id = ANY($2::bigint[])',
                    [roomId, affectedItemIds, sectionKey]
                );
                const { rows: shopRows } = await client.query(
                    'SELECT DISTINCT room_id FROM chat_shop_room_items WHERE clothing_item_id = ANY($1::bigint[])', [affectedItemIds]
                );
                await client.query('COMMIT');
                transactionStarted = false;
                socket.emit('admin-shop-action-result', {
                    success: true,
                    message: `Niveaukravet er gemt: Level ${requiredLevel}. Varegruppen følger niveauet${affectedItemIds.length > 1 ? ` for alle ${affectedItemIds.length} farver` : ''}.`
                });
                socket.emit('admin-shop-room-data-refresh', { roomId });
                for (const row of shopRows) {
                    if (row.room_id !== roomId) socket.emit('admin-shop-room-data-refresh', { roomId: row.room_id });
                    io.to(roomChannel(row.room_id)).emit('shop-items-refresh', { roomId: row.room_id });
                }
                try {
                    for (const affectedItemId of affectedItemIds) {
                        await enforceClothingLevelForAssignments(affectedItemId, requiredLevel);
                    }
                } catch (error) {
                    console.error('Could not refresh clothing assignments after level change:', getSafeErrorCode(error));
                }
            } catch (error) {
                if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
                const messages = {
                    NOT_A_SHOP: 'Vælg et rum, der er markeret som butik.',
                    ITEM_MISSING: 'Tøjdelen findes ikke længere.'
                };
                socket.emit('admin-shop-action-result', {
                    success: false,
                    message: messages[error.message] || 'Niveaukravet kunne ikke gemmes.'
                });
                if (!messages[error.message]) console.error('Could not update clothing level:', getSafeErrorCode(error));
            } finally {
                client.release();
            }
        });

        socket.on('admin-shop-room-item-set', async ({ roomId, id, listed, sectionKey = '' } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || typeof listed !== 'boolean') return;
            try {
                const { rows: [room] } = await pool.query('SELECT id FROM chat_public_rooms WHERE id = $1 AND is_shop = TRUE', [roomId]);
                if (!room) {
                    socket.emit('admin-shop-action-result', { success: false, message: 'Rummet er ikke markeret som butik.' });
                    return;
                }
                if (listed && sectionKey && !['level_1_8', 'level_9_16', 'level_17_20', 'custom'].includes(sectionKey)) {
                    socket.emit('admin-shop-action-result', { success: false, message: 'Vælg en af butikkens fire varegrupper.' });
                    return;
                }
                if (listed && sectionKey && sectionKey !== 'custom') {
                    const { rows: [item] } = await pool.query('SELECT required_level FROM chat_clothing_catalog WHERE id = $1', [id]);
                    const expectedSection = Number(item?.required_level) <= 8 ? 'level_1_8'
                        : Number(item?.required_level) <= 16 ? 'level_9_16' : 'level_17_20';
                    if (!item || sectionKey !== expectedSection) {
                        socket.emit('admin-shop-action-result', { success: false, message: 'Varegruppen følger tøjets niveaukrav. Justér niveauet først.' });
                        return;
                    }
                }
                const result = listed
                    ? await pool.query(`
                        INSERT INTO chat_shop_room_items (room_id, clothing_item_id, shop_section_key)
                        SELECT $1, item.id, COALESCE(NULLIF($3, ''), CASE
                            WHEN item.required_level <= 8 THEN 'level_1_8'
                            WHEN item.required_level <= 16 THEN 'level_9_16'
                            ELSE 'level_17_20'
                        END)
                        FROM chat_clothing_catalog item WHERE item.id = $2
                        ON CONFLICT (room_id, clothing_item_id) DO UPDATE
                        SET shop_section_key = EXCLUDED.shop_section_key
                        RETURNING clothing_item_id
                    `, [roomId, id, sectionKey])
                    : await pool.query('DELETE FROM chat_shop_room_items WHERE room_id = $1 AND clothing_item_id = $2 RETURNING clothing_item_id', [roomId, id]);
                if (listed && !result.rowCount) {
                    const { rowCount } = await pool.query('SELECT 1 FROM chat_clothing_catalog WHERE id = $1', [id]);
                    if (!rowCount) {
                        socket.emit('admin-shop-action-result', { success: false, message: 'Tøjdelen findes ikke længere.' });
                        return;
                    }
                }
                socket.emit('admin-shop-action-result', { success: true, message: listed ? 'Tøjdelen er lagt i denne butik.' : 'Tøjdelen er fjernet fra denne butik.' });
                socket.emit('admin-shop-room-data-refresh', { roomId });
                io.to(roomChannel(roomId)).emit('shop-items-refresh', { roomId });
            } catch (error) {
                console.error('Could not update room shop item:', getSafeErrorCode(error));
                socket.emit('admin-shop-action-result', { success: false, message: 'Butikken kunne ikke opdateres.' });
            }
        });

        socket.on('admin-shop-room-variant-set', async ({ roomId, id, variantGroup = '', variantLabel = '' } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)
                || typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) return;
            const group = typeof variantGroup === 'string' ? variantGroup.normalize('NFKC').trim() : '';
            const label = typeof variantLabel === 'string' ? variantLabel.normalize('NFKC').trim() : '';
            if (group.length > 60 || /[\u0000-\u001f\u007f]/.test(group)
                || label.length > 30 || /[\u0000-\u001f\u007f]/.test(label)
                || Boolean(group) !== Boolean(label)) {
                socket.emit('admin-shop-action-result', { success: false, message: 'Udfyld både variantgruppe og farve, eller tøm begge felter.' });
                return;
            }
            try {
                const { rowCount } = await pool.query(`
                    UPDATE chat_shop_room_items listed
                    SET variant_group = $3, variant_label = $4
                    FROM chat_public_rooms room
                    WHERE listed.room_id = $1 AND listed.clothing_item_id = $2
                      AND room.id = listed.room_id AND room.is_shop = TRUE
                `, [roomId, id, group, label]);
                if (!rowCount) {
                    socket.emit('admin-shop-action-result', { success: false, message: 'Læg tøjdelen i butikken, før du redigerer dens farvegruppe.' });
                    return;
                }
                socket.emit('admin-shop-action-result', { success: true, message: group ? 'Varevarianten er gemt i butikken.' : 'Varen er fjernet fra en variantgruppe.' });
                socket.emit('admin-shop-room-data-refresh', { roomId });
                io.to(roomChannel(roomId)).emit('shop-items-refresh', { roomId });
            } catch (error) {
                console.error('Could not update shop item variant:', getSafeErrorCode(error));
                socket.emit('admin-shop-action-result', { success: false, message: 'Varevarianten kunne ikke gemmes.' });
            }
        });

        socket.on('admin-shop-variant-group-save', async ({ roomId, groupName = '', items = [] } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)
                || typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || !Array.isArray(items) || items.length < 2 || items.length > 30) return;
            const group = typeof groupName === 'string' ? groupName.normalize('NFKC').trim() : '';
            const normalizedItems = items.map((item) => ({
                id: typeof item?.id === 'string' ? item.id : '',
                label: typeof item?.label === 'string' ? item.label.normalize('NFKC').trim() : '',
                sectionKey: ['level_1_8', 'level_9_16', 'level_17_20', 'custom'].includes(item?.sectionKey) ? item.sectionKey : ''
            }));
            const ids = normalizedItems.map((item) => item.id);
            if (!group || group.length > 60 || /[\u0000-\u001f\u007f]/.test(group)
                || normalizedItems.some((item) => !/^[1-9]\d{0,18}$/.test(item.id)
                    || !item.label || item.label.length > 30 || /[\u0000-\u001f\u007f]/.test(item.label))
                || new Set(ids).size !== ids.length) {
                socket.emit('admin-shop-action-result', { success: false, action: 'variant-group', message: 'Tjek gruppenavn og farver. Vælg mindst to forskellige varer, og angiv en farve på hver.' });
                return;
            }

            const client = await pool.connect();
            let transactionStarted = false;
            try {
                await client.query('BEGIN');
                transactionStarted = true;
                const { rowCount: shopExists } = await client.query(
                    'SELECT 1 FROM chat_public_rooms WHERE id = $1 AND is_shop = TRUE FOR UPDATE', [roomId]
                );
                if (!shopExists) throw new Error('NOT_A_SHOP');
                const { rows: catalogItems } = await client.query(
                    'SELECT id, category, target_avatar_type, required_level FROM chat_clothing_catalog WHERE id = ANY($1::bigint[])', [ids]
                );
                if (catalogItems.length !== ids.length) throw new Error('ITEM_MISSING');
                const firstItem = catalogItems[0];
                if (catalogItems.some((item) => item.category !== firstItem.category || item.target_avatar_type !== firstItem.target_avatar_type)) {
                    throw new Error('INCOMPATIBLE_ITEMS');
                }
                if (catalogItems.some((item) => Number(item.required_level) !== Number(firstItem.required_level))) {
                    throw new Error('INCOMPATIBLE_LEVELS');
                }
                const groupSections = normalizedItems.map((item) => {
                    const catalogItem = catalogItems.find((entry) => String(entry.id) === item.id);
                    if (item.sectionKey === 'custom') return 'custom';
                    return Number(catalogItem.required_level) <= 8 ? 'level_1_8'
                        : Number(catalogItem.required_level) <= 16 ? 'level_9_16' : 'level_17_20';
                });
                if (new Set(groupSections).size > 1) throw new Error('INCOMPATIBLE_SECTIONS');
                for (const item of normalizedItems) {
                    const catalogItem = catalogItems.find((entry) => String(entry.id) === item.id);
                    const levelSection = Number(catalogItem.required_level) <= 8
                        ? 'level_1_8' : Number(catalogItem.required_level) <= 16 ? 'level_9_16' : 'level_17_20';
                    const sectionKey = item.sectionKey === 'custom' ? 'custom' : levelSection;
                    const { rowCount } = await client.query(`
                        INSERT INTO chat_shop_room_items (room_id, clothing_item_id, variant_group, variant_label, shop_section_key)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (room_id, clothing_item_id) DO UPDATE
                        SET variant_group = EXCLUDED.variant_group, variant_label = EXCLUDED.variant_label,
                            shop_section_key = EXCLUDED.shop_section_key
                    `, [roomId, item.id, group, item.label, sectionKey]);
                    if (!rowCount) throw new Error('SAVE_FAILED');
                }
                await client.query('COMMIT');
                transactionStarted = false;
                socket.emit('admin-shop-action-result', { success: true, action: 'variant-group', message: `Farvegruppen “${group}” er gemt, og ${normalizedItems.length} varer er lagt i butikken.` });
                socket.emit('admin-shop-room-data-refresh', { roomId });
                io.to(roomChannel(roomId)).emit('shop-items-refresh', { roomId });
            } catch (error) {
                if (transactionStarted) await client.query('ROLLBACK').catch(() => {});
                const messages = {
                    NOT_A_SHOP: 'Vælg et rum, der er markeret som butik.',
                    ITEM_MISSING: 'En eller flere varer findes ikke længere i kataloget.',
                    INCOMPATIBLE_ITEMS: 'Varerne i en farvegruppe skal være samme kategori og avatar-type.',
                    INCOMPATIBLE_LEVELS: 'Varer i samme farvegruppe skal have samme niveaukrav.',
                    INCOMPATIBLE_SECTIONS: 'Farver i samme gruppe skal ligge i samme varegruppe.',
                    SAVE_FAILED: 'Farvegruppen kunne ikke gemmes.'
                };
                const message = messages[error.message] || 'Farvegruppen kunne ikke gemmes.';
                if (!messages[error.message]) console.error('Could not save shop variant group:', getSafeErrorCode(error));
                socket.emit('admin-shop-action-result', { success: false, action: 'variant-group', message });
            } finally {
                client.release();
            }
        });

        socket.on('admin-shop-room-status-set', async ({ roomId, isOpen } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)
                || typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || typeof isOpen !== 'boolean') return;
            try {
                const { rowCount } = await pool.query('UPDATE chat_public_rooms SET shop_is_open = $2 WHERE id = $1 AND is_shop = TRUE', [roomId, isOpen]);
                if (!rowCount) {
                    socket.emit('admin-shop-status-result', { success: false, message: 'Rummet er ikke markeret som butik.' });
                    return;
                }
                io.to(roomChannel(roomId)).emit('shop-status', { roomId, isOpen });
                socket.emit('admin-shop-status-result', { success: true, message: isOpen ? 'Butikken er åben for gæster.' : 'Butikken er lukket for gæster.' });
                socket.emit('admin-shop-room-data-refresh', { roomId });
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not update room shop status:', getSafeErrorCode(error));
                socket.emit('admin-shop-status-result', { success: false, message: 'Butikkens status kunne ikke gemmes.' });
            }
        });

        socket.on('admin-shop-content-set', async ({ roomId, content = {} } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)
                || typeof roomId !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(roomId)
                || !content || typeof content !== 'object' || Array.isArray(content)) return;
            const categoryKeys = ['level_1_8', 'level_9_16', 'level_17_20', 'custom'];
            const cleanText = (value, max) => typeof value === 'string'
                ? value.normalize('NFKC').trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max)
                : '';
            const normalized = {
                title: cleanText(content.title, 60),
                intro: cleanText(content.intro, 240),
                welcome: cleanText(content.welcome, 240),
                categories: {}
            };
            for (const key of categoryKeys) {
                const category = content.categories?.[key];
                normalized.categories[key] = {
                    title: cleanText(category?.title, 40),
                    description: cleanText(category?.description, 180)
                };
            }
            try {
                const { rowCount } = await pool.query(
                    'UPDATE chat_public_rooms SET shop_content = $2::jsonb WHERE id = $1 AND is_shop = TRUE',
                    [roomId, JSON.stringify(normalized)]
                );
                if (!rowCount) {
                    socket.emit('admin-shop-content-result', { success: false, message: 'Rummet er ikke markeret som butik.' });
                    return;
                }
                io.to(roomChannel(roomId)).emit('shop-content', { roomId, content: normalized });
                socket.emit('admin-shop-content-result', { success: true, roomId, message: 'Butikkens tekster er gemt.' });
                socket.emit('admin-shop-room-data-refresh', { roomId });
            } catch (error) {
                console.error('Could not update shop content:', getSafeErrorCode(error));
                socket.emit('admin-shop-content-result', { success: false, message: 'Butikkens tekster kunne ikke gemmes.' });
            }
        });

        socket.on('shop-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try {
                const roomId = socket.data.roomId;
                const { rows: [status] } = await pool.query('SELECT is_shop, shop_is_open, shop_content FROM chat_public_rooms WHERE id = $1', [roomId]);
                if (status?.is_shop !== true || status.shop_is_open !== true) {
                    socket.emit('shop-items', { items: [], closed: true, content: status?.shop_content || {} });
                    return;
                }
                const { rows } = await pool.query(`
                    SELECT item.id, item.name, item.description, item.category, item.target_avatar_type,
                           item.required_level, item.price, item.image_version, item.animation_json,
                           listed.variant_group, listed.variant_label, listed.shop_section_key
                    FROM chat_clothing_catalog item
                    JOIN chat_shop_room_items listed ON listed.clothing_item_id = item.id AND listed.room_id = $2
                    WHERE item.target_avatar_type = (SELECT avatar_type FROM chat_users WHERE id = $1)
                    ORDER BY category, required_level, name, id
                    LIMIT 300
                `, [socket.data.user.id, roomId]);
                socket.emit('shop-items', { content: status.shop_content || {}, items: rows.map((item) => ({
                    id: String(item.id), name: item.name, description: item.description,
                    variantGroup: item.variant_group || '', variantLabel: item.variant_label || '',
                    shopSectionKey: item.shop_section_key === 'custom'
                        ? 'custom'
                        : Number(item.required_level) <= 8 ? 'level_1_8' : Number(item.required_level) <= 16 ? 'level_9_16' : 'level_17_20',
                    category: item.category, avatarType: item.target_avatar_type, requiredLevel: Number(item.required_level),
                    price: Number(item.price), imageVersion: Number(item.image_version || 1),
                    imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${item.image_version || 1}`,
                    animation: normalizeClothingAnimation(item.animation_json)
                })) });
            } catch (error) {
                console.error('Could not load shop listings:', getSafeErrorCode(error));
                socket.emit('shop-items', { items: [], error: 'Butikken kunne ikke hentes lige nu.' });
            }
        });

        socket.on('admin-clothing-owners-request', async ({ id } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) return;
            try {
                const { rows } = await pool.query(`
                    SELECT item.name AS item_name, assignment.id::text AS assignment_id,
                           target.username, assignment.assigned_at
                    FROM chat_clothing_catalog item
                    LEFT JOIN chat_clothing_assignments assignment ON assignment.clothing_item_id = item.id
                    LEFT JOIN chat_users target ON target.id = assignment.target_user_id
                    WHERE item.id = $1
                    ORDER BY assignment.assigned_at DESC, assignment.id DESC
                `, [id]);
                socket.emit('admin-clothing-owners', {
                    itemId: id,
                    itemName: rows[0]?.item_name || '',
                    assignments: rows.filter((row) => row.assignment_id).map((row) => ({
                        id: row.assignment_id,
                        username: row.username,
                        assignedAt: row.assigned_at
                    }))
                });
            } catch (error) {
                console.error('Could not load clothing owners:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tildelingerne kunne ikke hentes.' });
            }
        });

        socket.on('admin-clothing-item-create', async (payload = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            const username = typeof payload.username === 'string' && payload.username.trim() ? normalizeUsername(payload.username) : null;
            const name = typeof payload.name === 'string' ? payload.name.normalize('NFKC').trim() : '';
            const description = typeof payload.description === 'string' ? payload.description.normalize('NFKC').trim() : '';
            const variantGroup = typeof payload.variantGroup === 'string' ? payload.variantGroup.normalize('NFKC').trim() : '';
            const variantLabel = typeof payload.variantLabel === 'string' ? payload.variantLabel.normalize('NFKC').trim() : '';
            const category = payload.category, targetAvatarType = payload.targetAvatarType;
            const layerPosition = ['front', 'normal', 'back'].includes(payload.layerPosition)
                ? payload.layerPosition
                : ['left_hand', 'right_hand'].includes(category) ? 'front' : 'normal';
            const animation = payload.animation;
            const requiredLevel=Number(payload.requiredLevel), price=Number(payload.price);
            const x=Number(payload.x), y=Number(payload.y), rotation=Number(payload.rotation), scale=Number(payload.scale);
            const scaleX=Number(payload.scaleX ?? 1), scaleY=Number(payload.scaleY ?? 1);
            const skewX=Number(payload.skewX ?? 0), skewY=Number(payload.skewY ?? 0);
            const image=Buffer.isBuffer(payload.image)?payload.image:payload.image instanceof Uint8Array?Buffer.from(payload.image):null;
            const isPng=image&&image.length>=8&&image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
            const isWebp=image&&image.length>=12&&image.toString('ascii',0,4)==='RIFF'&&image.toString('ascii',8,12)==='WEBP';
            const validTransform=Number.isFinite(x)&&x>=-270&&x<=270&&Number.isFinite(y)&&y>=-180&&y<=180&&Number.isFinite(rotation)&&rotation>=-180&&rotation<=180&&Number.isFinite(scale)&&scale>=0.25&&scale<=3&&Number.isFinite(scaleX)&&scaleX>=0.25&&scaleX<=3&&Number.isFinite(scaleY)&&scaleY>=0.25&&scaleY<=3&&Number.isFinite(skewX)&&skewX>=-45&&skewX<=45&&Number.isFinite(skewY)&&skewY>=-45&&skewY<=45;
            if((payload.username!=null&&typeof payload.username!=='string')||(payload.username?.trim()&&!username)||!name||name.length>60||/[\u0000-\u001f\u007f]/.test(name)||description.length>300||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)||variantGroup.length>60||/[\u0000-\u001f\u007f]/.test(variantGroup)||variantLabel.length>30||/[\u0000-\u001f\u007f]/.test(variantLabel)||Boolean(variantGroup)!==Boolean(variantLabel)||!['boy','girl'].includes(targetAvatarType)||!['headwear','hair','beard','glasses','clothing','left_hand','right_hand','accessory'].includes(category)||!Number.isInteger(requiredLevel)||requiredLevel<1||requiredLevel>20||!Number.isInteger(price)||price<0||price>100000000||!validTransform||!isValidClothingAnimation(animation)||!image||image.length>950000||(!isPng&&!isWebp)){
                socket.emit('admin-clothing-action-result',{success:false,message:'Kontroll?r brugernavn (valgfrit), navn, kategori, level, pris og placering. Billedet skal v?re PNG/WebP p? h?jst 950 KB.'});return;
            }
            try{
                const targetResult=username?await pool.query('SELECT id, username, avatar_type FROM chat_users WHERE username_normalized = $1',[username.normalized]):null;
                const target=targetResult?.rows[0]||null;
                if(username&&!target){socket.emit('admin-clothing-action-result',{success:false,message:'Brugeren findes ikke.'});return;}
                if(target && target.avatar_type !== targetAvatarType){socket.emit('admin-clothing-action-result',{success:false,message:'Tøjdelen passer ikke til avatarvalget på den bruger.'});return;}
                const client=await pool.connect();
                try{
                    await client.query('BEGIN');
                    const {rows:[item]}=await client.query(`
                        INSERT INTO chat_clothing_catalog (name,description,category,target_avatar_type,image,mime_type,required_level,price,transform_json,animation_json,variant_group,variant_label)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12) RETURNING id
                    `,[name,description,category,targetAvatarType,image,isPng?'image/png':'image/webp',requiredLevel,price,JSON.stringify({x,y,rotation,scale,scaleX,scaleY,skewX,skewY,layerPosition}),JSON.stringify(animation),variantGroup,variantLabel]);
                    if(target)await client.query('INSERT INTO chat_clothing_assignments (target_user_id,clothing_item_id) VALUES ($1,$2)',[target.id,item.id]);
                    await client.query('COMMIT');
                }catch(error){try{await client.query('ROLLBACK')}catch{}throw error;}finally{client.release();}
                if(target)await refreshOnlineUserClothing(target.id);
                if(target)await broadcastChatOnlineCount();
                socket.emit('admin-clothing-action-result',{success:true,action:'create',message:target?(name+' blev gemt og lagt i '+target.username+'s tojskab.'):name+' blev gemt i tojkataloget.'});
                await sendAdminClothingItems();
            }catch(error){console.error('Could not create clothing item:',getSafeErrorCode(error));socket.emit('admin-clothing-action-result',{success:false,message:'T?jdelen kunne ikke gemmes.'});}
        });

        socket.on('admin-clothing-item-update', async (payload = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            const id = typeof payload.id === 'string' && /^[1-9]\d{0,18}$/.test(payload.id) ? payload.id : '';
            const name = typeof payload.name === 'string' ? payload.name.normalize('NFKC').trim() : '';
            const description = typeof payload.description === 'string' ? payload.description.normalize('NFKC').trim() : '';
            const variantGroup = typeof payload.variantGroup === 'string' ? payload.variantGroup.normalize('NFKC').trim() : '';
            const variantLabel = typeof payload.variantLabel === 'string' ? payload.variantLabel.normalize('NFKC').trim() : '';
            const category = payload.category;
            const targetAvatarType = payload.targetAvatarType;
            const layerPosition = ['front', 'normal', 'back'].includes(payload.layerPosition)
                ? payload.layerPosition
                : ['left_hand', 'right_hand'].includes(category) ? 'front' : 'normal';
            const animation = payload.animation;
            const requiredLevel = Number(payload.requiredLevel), price = Number(payload.price);
            const x = Number(payload.x), y = Number(payload.y), rotation = Number(payload.rotation), scale = Number(payload.scale);
            const scaleX = Number(payload.scaleX ?? 1), scaleY = Number(payload.scaleY ?? 1);
            const skewX = Number(payload.skewX ?? 0), skewY = Number(payload.skewY ?? 0);
            const image = Buffer.isBuffer(payload.image) ? payload.image
                : payload.image instanceof Uint8Array ? Buffer.from(payload.image) : null;
            const hasImage = payload.image != null;
            const isPng = image && image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const isWebp = image && image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
            const validTransform = Number.isFinite(x) && x >= -270 && x <= 270
                && Number.isFinite(y) && y >= -180 && y <= 180
                && Number.isFinite(rotation) && rotation >= -180 && rotation <= 180
                && Number.isFinite(scale) && scale >= 0.25 && scale <= 3
                && Number.isFinite(scaleX) && scaleX >= 0.25 && scaleX <= 3
                && Number.isFinite(scaleY) && scaleY >= 0.25 && scaleY <= 3
                && Number.isFinite(skewX) && skewX >= -45 && skewX <= 45
                && Number.isFinite(skewY) && skewY >= -45 && skewY <= 45;
            if (!id || !name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)
                || description.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)
                || variantGroup.length > 60 || /[\u0000-\u001f\u007f]/.test(variantGroup)
                || variantLabel.length > 30 || /[\u0000-\u001f\u007f]/.test(variantLabel)
                || Boolean(variantGroup) !== Boolean(variantLabel)
                || !['boy', 'girl'].includes(targetAvatarType)
                || !['headwear', 'hair', 'beard', 'glasses', 'clothing', 'left_hand', 'right_hand', 'accessory'].includes(category)
                || !Number.isInteger(requiredLevel) || requiredLevel < 1 || requiredLevel > 20
                || !Number.isInteger(price) || price < 0 || price > 100000000 || !validTransform
                || !isValidClothingAnimation(animation)
                || (hasImage && (!image || image.length > 950000 || (!isPng && !isWebp)))) {
                socket.emit('admin-clothing-action-result', { success: false, message: 'Kontrollér oplysninger, placering og eventuelt PNG/WebP-billede (maks. 950 KB).' });
                return;
            }
            try {
                const { rowCount: incompatibleAssignments } = await pool.query(`
                    SELECT 1
                    FROM chat_clothing_assignments assignment
                    JOIN chat_users target ON target.id = assignment.target_user_id
                    WHERE assignment.clothing_item_id = $1 AND target.avatar_type <> $2
                    LIMIT 1
                `, [id, targetAvatarType]);
                if (incompatibleAssignments) {
                    socket.emit('admin-clothing-action-result', {
                        success: false,
                        message: 'Fjern tøjdelen fra brugere med det andet avatarvalg, før du ændrer køn.'
                    });
                    return;
                }
                const { rows: [item] } = await pool.query(`
                    UPDATE chat_clothing_catalog
                    SET name = $2, description = $3, category = $4, target_avatar_type = $5,
                        required_level = $6, price = $7, transform_json = $8::jsonb,
                        animation_json = $9::jsonb, variant_group = $10, variant_label = $11,
                        image = COALESCE($12, image), mime_type = COALESCE($13, mime_type),
                        image_version = image_version + CASE WHEN $12::bytea IS NULL THEN 0 ELSE 1 END
                    WHERE id = $1
                    RETURNING id
                `, [id, name, description, category, targetAvatarType, requiredLevel, price,
                    JSON.stringify({ x, y, rotation, scale, scaleX, scaleY, skewX, skewY, layerPosition }),
                    JSON.stringify(animation), variantGroup, variantLabel, image, isPng ? 'image/png' : isWebp ? 'image/webp' : null]);
                if (!item) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen findes ikke længere.' });
                    return;
                }
                const { rows: variantRows } = await pool.query(`
                    SELECT DISTINCT sibling.clothing_item_id::text AS id
                    FROM chat_shop_room_items selected
                    JOIN chat_shop_room_items sibling
                      ON sibling.room_id = selected.room_id
                     AND sibling.variant_group = selected.variant_group
                    WHERE selected.clothing_item_id = $1
                      AND selected.variant_group <> ''
                `, [id]);
                const affectedItemIds = [...new Set([id, ...variantRows.map((row) => row.id)])];
                if (affectedItemIds.length > 1) {
                    await pool.query(
                        'UPDATE chat_clothing_catalog SET required_level = $2 WHERE id = ANY($1::bigint[])',
                        [affectedItemIds, requiredLevel]
                    );
                }
                await pool.query(`
                    UPDATE chat_shop_room_items listed
                    SET shop_section_key = CASE
                        WHEN $2 <= 8 THEN 'level_1_8'
                        WHEN $2 <= 16 THEN 'level_9_16'
                        ELSE 'level_17_20'
                    END
                    WHERE listed.clothing_item_id = ANY($1::bigint[])
                      AND listed.shop_section_key IN ('level_1_8', 'level_9_16', 'level_17_20')
                `, [affectedItemIds, requiredLevel]);
                const { rows: shopRooms } = await pool.query(
                    'SELECT DISTINCT room_id FROM chat_shop_room_items WHERE clothing_item_id = ANY($1::bigint[])', [affectedItemIds]
                );
                for (const shopRoom of shopRooms) {
                    io.to(roomChannel(shopRoom.room_id)).emit('shop-items-refresh', { roomId: shopRoom.room_id });
                    socket.emit('admin-shop-room-data-refresh', { roomId: shopRoom.room_id });
                }
                try {
                    for (const affectedItemId of affectedItemIds) {
                        await enforceClothingLevelForAssignments(affectedItemId, requiredLevel);
                    }
                } catch (error) {
                    console.error('Could not refresh clothing assignments after item edit:', getSafeErrorCode(error));
                }
                socket.emit('admin-clothing-action-result', { success: true, action: 'update', message: `${name} blev opdateret.` });
                await sendAdminClothingItems();
            } catch (error) {
                console.error('Could not update clothing item:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen kunne ikke opdateres.' });
            }
        });

        socket.on('admin-clothing-item-delete', async ({ id } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) return;
            try {
                const { rows: [item] } = await pool.query(
                    'DELETE FROM chat_clothing_assignments WHERE id = $1 RETURNING target_user_id::text AS target_user_id', [id]
                );
                if (!item) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen findes ikke længere.' });
                    return;
                }
                await refreshOnlineUserClothing(item.target_user_id);
                await broadcastChatOnlineCount();
                socket.emit('admin-clothing-action-result', { success: true, action: 'assignment-delete', message: 'Tojdelen blev fjernet fra brugerens skab.' });
                await sendAdminClothingItems();
            } catch (error) {
                console.error('Could not delete clothing item:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen kunne ikke fjernes.' });
            }
        });

        socket.on('admin-clothing-template-assign', async ({ id, username: rawUsername } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) return;
            const username = normalizeUsername(rawUsername);
            if (!username) {
                socket.emit('admin-clothing-action-result', { success: false, message: 'Skriv et gyldigt brugernavn.' });
                return;
            }
            try {
                const { rows: [target] } = await pool.query(
                    'SELECT id, username, avatar_type FROM chat_users WHERE username_normalized = $1', [username.normalized]
                );
                if (!target) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Brugeren findes ikke.' });
                    return;
                }
                const { rows: [template] } = await pool.query('SELECT name, target_avatar_type FROM chat_clothing_catalog WHERE id = $1', [id]);
                if (!template) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjskabelonen findes ikke længere.' });
                    return;
                }
                if (target.avatar_type !== template.target_avatar_type) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen passer ikke til avatarvalget på den bruger.' });
                    return;
                }
                const { rows: [item] } = await pool.query(`
                    INSERT INTO chat_clothing_assignments (target_user_id, clothing_item_id)
                    SELECT $1, id FROM chat_clothing_catalog WHERE id = $2 AND target_avatar_type = $3
                    ON CONFLICT (target_user_id, clothing_item_id) DO NOTHING
                    RETURNING clothing_item_id
                `, [target.id, id, target.avatar_type]);
                if (item) await refreshOnlineUserClothing(target.id);
                if (item) await broadcastChatOnlineCount();
                socket.emit('admin-clothing-action-result', {
                    success: true,
                    message: item ? `${template.name} blev lagt i ${target.username}s tøjskab.` : `${target.username} har allerede ${template.name}.`
                });
                await sendAdminClothingItems();
            } catch (error) {
                console.error('Could not assign clothing template:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjdelen kunne ikke tildeles.' });
            }
        });

        socket.on('admin-clothing-template-delete', async ({ id } = {}) => {
            if (!socket.data.canManageClothing || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id)) return;
            try {
                const { rows: assignments } = await pool.query(
                    'SELECT target_user_id::text AS target_user_id FROM chat_clothing_assignments WHERE clothing_item_id = $1', [id]
                );
                const { rows: [item] } = await pool.query(
                    'DELETE FROM chat_clothing_catalog WHERE id = $1 RETURNING name', [id]
                );
                if (!item) {
                    socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjskabelonen findes ikke længere.' });
                    return;
                }
                await Promise.all([...new Set(assignments.map((assignment) => assignment.target_user_id))].map(refreshOnlineUserClothing));
                await broadcastChatOnlineCount();
                socket.emit('admin-clothing-action-result', { success: true, action: 'template-delete', message: `${item.name} og dens tildelinger blev slettet.` });
                await sendAdminClothingItems();
            } catch (error) {
                console.error('Could not delete clothing template:', getSafeErrorCode(error));
                socket.emit('admin-clothing-action-result', { success: false, message: 'Tøjskabelonen kunne ikke slettes.' });
            }
        });

        async function sendUserWardrobe() {
            const [{ rows }, totalOnlineMs, { rows: [progress] }] = await Promise.all([
                pool.query(`
                    SELECT item.id, item.name, item.description, item.category, item.required_level, item.price,
                           assignment.is_equipped, item.image_version, item.transform_json, item.animation_json,
                           (SELECT COUNT(DISTINCT owned_assignment.target_user_id)::int
                            FROM chat_clothing_assignments owned_assignment
                            WHERE owned_assignment.clothing_item_id = item.id) AS owner_count
                    FROM chat_clothing_assignments assignment
                    JOIN chat_clothing_catalog item ON item.id = assignment.clothing_item_id
                    JOIN chat_users target ON target.id = assignment.target_user_id
                    WHERE assignment.target_user_id = $1 AND item.target_avatar_type = target.avatar_type
                    ORDER BY item.category, item.id
                `, [socket.data.user.id]),
                getTotalOnlineMs(socket.data.user.id),
                pool.query('SELECT accepted_chat_messages, wardrobe_category_order FROM chat_users WHERE id = $1', [socket.data.user.id])
            ]);
            socket.emit('wardrobe-items', {
                level: getUserLevel(totalOnlineMs, Number(progress?.accepted_chat_messages || 0)),
                categoryOrder: normalizeWardrobeCategoryOrder(progress?.wardrobe_category_order),
                items: rows.map((item) => ({
                    id: String(item.id),
                    name: item.name,
                    description: item.description,
                    category: item.category,
                    requiredLevel: Number(item.required_level),
                    price: Number(item.price),
                    equipped: item.is_equipped,
                    wardrobeCount: Number(item.owner_count || 0),
                    imageVersion: Number(item.image_version || 1),
                    imageUrl: `/api/clothing-items/${encodeURIComponent(item.id)}/image?v=${item.image_version || 1}`,
                    animation: normalizeClothingAnimation(item.animation_json),
                    ...normalizeClothingTransform(item.transform_json, item.category)
                }))
            });
        }

        socket.on('wardrobe-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            try { await sendUserWardrobe(); }
            catch (error) {
                console.error('Could not load user wardrobe:', getSafeErrorCode(error));
                socket.emit('wardrobe-action-result', { success: false, message: 'Tøjskabet kunne ikke hentes.' });
            }
        });

        socket.on('wardrobe-save', async ({ equippedItemIds, categoryOrder } = {}) => {
            if (!activeSocketIds.has(socket.id) || !Array.isArray(equippedItemIds) || equippedItemIds.length > 200
                || equippedItemIds.some((id) => typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id))) return;
            const normalizedCategoryOrder = normalizeWardrobeCategoryOrder(categoryOrder);
            if (categoryOrder !== undefined && !normalizedCategoryOrder) {
                socket.emit('wardrobe-action-result', { success: false, message: 'Rækkefølgen på kategorierne er ugyldig.' });
                return;
            }
            const selectedIds = [...new Set(equippedItemIds)];
            if (selectedIds.length !== equippedItemIds.length) {
                socket.emit('wardrobe-action-result', { success: false, message: 'Outfittet indeholder dubletter.' });
                return;
            }
            let client;
            try {
                const [totalOnlineMs, { rows: [progress] }] = await Promise.all([
                    getTotalOnlineMs(socket.data.user.id),
                    pool.query('SELECT accepted_chat_messages FROM chat_users WHERE id = $1', [socket.data.user.id])
                ]);
                const level = getUserLevel(totalOnlineMs, Number(progress?.accepted_chat_messages || 0));
                client = await pool.connect();
                await client.query('BEGIN');
                await client.query('SELECT id FROM chat_users WHERE id = $1 FOR UPDATE', [socket.data.user.id]);
                const { rows: ownedItems } = await client.query(`
                    SELECT item.id::text AS id, item.name, item.category, item.required_level
                    FROM chat_clothing_assignments assignment
                    JOIN chat_clothing_catalog item ON item.id = assignment.clothing_item_id
                    JOIN chat_users target ON target.id = assignment.target_user_id
                    WHERE assignment.target_user_id = $1 AND item.target_avatar_type = target.avatar_type
                    FOR UPDATE OF assignment
                `, [socket.data.user.id]);
                const ownedById = new Map(ownedItems.map((item) => [item.id, item]));
                const missing = selectedIds.find((id) => !ownedById.has(id));
                if (missing) {
                    await client.query('ROLLBACK');
                    socket.emit('wardrobe-action-result', { success: false, message: 'En t\u00f8jdel findes ikke l\u00e6ngere i dit skab. Opdater og pr\u00f8v igen.' });
                    return;
                }
                const selectedItems = selectedIds.map((id) => ownedById.get(id));
                const lockedItem = selectedItems.find((item) => Number(item.required_level) > level);
                if (lockedItem) {
                    await client.query('ROLLBACK');
                    socket.emit('wardrobe-action-result', {
                        success: false,
                        message: 'Du skal v\u00e6re level ' + lockedItem.required_level + ' for at tage ' + lockedItem.name + ' p\u00e5.'
                    });
                    return;
                }
                const exclusiveCategories = new Set();
                const duplicateCategory = selectedItems.find((item) => {
                    if (item.category === 'accessory') return false;
                    if (exclusiveCategories.has(item.category)) return true;
                    exclusiveCategories.add(item.category);
                    return false;
                });
                if (duplicateCategory) {
                    await client.query('ROLLBACK');
                    socket.emit('wardrobe-action-result', { success: false, message: 'V\u00e6lg kun en del per kategori.' });
                    return;
                }
                await client.query(`
                    UPDATE chat_clothing_assignments
                    SET is_equipped = clothing_item_id = ANY($2::bigint[])
                    WHERE target_user_id = $1
                `, [socket.data.user.id, selectedIds]);
                if (normalizedCategoryOrder) {
                    await client.query('UPDATE chat_users SET wardrobe_category_order = $2::jsonb WHERE id = $1', [
                        socket.data.user.id, JSON.stringify(normalizedCategoryOrder)
                    ]);
                }
                await client.query('COMMIT');
                await refreshOnlineUserClothing(socket.data.user.id);
                await broadcastChatOnlineCount();
                await sendUserWardrobe();
                socket.emit('wardrobe-action-result', { success: true, message: 'Outfittet er gemt og vises nu i chatten.' });
            } catch (error) {
                if (client) {
                    try { await client.query('ROLLBACK'); } catch {}
                }
                console.error('Could not save wardrobe outfit:', getSafeErrorCode(error));
                socket.emit('wardrobe-action-result', { success: false, message: 'Outfittet kunne ikke gemmes.' });
            } finally {
                client?.release();
            }
        });

        socket.on('wardrobe-item-equip', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            socket.emit('wardrobe-action-result', { success: false, message: 'Opdater siden for at bruge den gemte outfitfunktion.' });
            await sendUserWardrobe();
        });

        socket.on('admin-avatar-upload', async ({ image } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            const bytes = Buffer.isBuffer(image) ? image : image instanceof Uint8Array ? Buffer.from(image) : null;
            const isPng = bytes && bytes.length >= 8
                && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            const isWebp = bytes && bytes.length >= 12
                && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
            if (!bytes || (!isPng && !isWebp) || bytes.length > 950_000) {
                socket.emit('admin-avatar-upload-result', {
                    success: false,
                    message: 'Vælg et PNG- eller WebP-billede på højst 950 KB.'
                });
                return;
            }
            try {
                const mimeType = isPng ? 'image/png' : 'image/webp';
                const { rows: [avatar] } = await pool.query(`
                    INSERT INTO chat_avatar_assets (avatar_type, image_data, mime_type)
                    VALUES ('girl', $1, $2)
                    ON CONFLICT (avatar_type) DO UPDATE SET
                        image_data = EXCLUDED.image_data,
                        mime_type = EXCLUDED.mime_type,
                        updated_at = NOW(),
                        version = chat_avatar_assets.version + 1
                    RETURNING version
                `, [bytes, mimeType]);
                const version = Number(avatar.version);
                io.emit('avatar-assets-updated', { girlVersion: version });
                socket.emit('admin-avatar-upload-result', {
                    success: true,
                    girlVersion: version,
                    message: 'Pigeavataren er gemt og kan nu vælges ved oprettelse.'
                });
            } catch (error) {
                console.error('Could not save girl avatar:', getSafeErrorCode(error));
                socket.emit('admin-avatar-upload-result', { success: false, message: 'Pigeavataren kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-rooms-request', async () => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            try { await sendAdminPublicRooms(); }
            catch (error) {
                console.error('Could not list public rooms for admin:', getSafeErrorCode(error));
                socket.emit('admin-room-action-result', { success: false, message: 'Rumlisten kunne ikke hentes.' });
            }
        });

        socket.on('admin-public-room-background-upload', async ({ id, image, animation } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const bytes = Buffer.isBuffer(image) ? image : image instanceof Uint8Array ? Buffer.from(image) : null;
            const isJpeg = bytes && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const isPng = bytes && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            const isWebp = bytes && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
            const normalizedAnimation = normalizeClothingAnimation(animation);
            if (typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)
                || !bytes || (!isJpeg && !isPng && !isWebp) || bytes.length > 950_000
                || !animation || Number(animation.columns) !== normalizedAnimation.columns
                || Number(animation.rows) !== normalizedAnimation.rows || Number(animation.frames) !== normalizedAnimation.frames
                || Number(animation.fps) !== normalizedAnimation.fps) {
                socket.emit('admin-room-background-result', {
                    success: false,
                    message: 'Vælg et gyldigt PNG-, JPG- eller WebP-billede under 950 KB, og kontrollér frame-indstillingerne.'
                });
                return;
            }
            try {
                const { rowCount } = await pool.query(`
                    UPDATE chat_public_rooms
                    SET background_image = $2, background_mime_type = $3, background_animation_json = $4::jsonb,
                        background_updated_at = NOW(), background_version = background_version + 1
                    WHERE id = $1
                `, [id, bytes, isJpeg ? 'image/jpeg' : isPng ? 'image/png' : 'image/webp', JSON.stringify(normalizedAnimation)]);
                if (!rowCount) {
                    socket.emit('admin-room-background-result', { success: false, message: 'Rummet findes ikke længere.' });
                    return;
                }
                const { rows: [room] } = await pool.query(`
                    SELECT id, room_number, name, welcome_title, welcome_text, TRUE AS has_background, background_version, background_animation_json,
                           overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform
                    FROM chat_public_rooms WHERE id = $1
                `, [id]);
                const roomName = formatPublicRoomName(room);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: room.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
                    roomBackgroundUrl: getPublicRoomBackgroundUrl(room),
                    roomBackgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                    roomOverlayUrl: getPublicRoomOverlayUrl(room),
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform)
                });
                socket.emit('admin-room-background-result', { success: true, message: `Baggrunden for ${roomName} er opdateret.` });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not save public room background:', getSafeErrorCode(error));
                socket.emit('admin-room-background-result', { success: false, message: 'Baggrunden kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-room-background-reset', async ({ id } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)
                || typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)) return;
            try {
                const { rowCount } = await pool.query(`
                    UPDATE chat_public_rooms
                    SET background_image = NULL, background_mime_type = NULL,
                        background_updated_at = NULL, background_animation_json = '{"columns":1,"rows":1,"frames":1,"fps":8}'::jsonb,
                        background_version = background_version + 1
                    WHERE id = $1
                `, [id]);
                if (!rowCount) {
                    socket.emit('admin-room-background-result', { success: false, message: 'Rummet findes ikke længere.' });
                    return;
                }
                const { rows: [room] } = await pool.query('SELECT id, room_number, name, welcome_title, welcome_text, background_animation_json, overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform FROM chat_public_rooms WHERE id = $1', [id]);
                const roomName = formatPublicRoomName({ ...room, id });
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: room.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
                    roomBackgroundUrl: null,
                    roomBackgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                    roomOverlayUrl: getPublicRoomOverlayUrl(room),
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform)
                });
                socket.emit('admin-room-background-result', { success: true, message: `${roomName} bruger nu testbaggrunden igen.` });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not reset public room background:', getSafeErrorCode(error));
                socket.emit('admin-room-background-result', { success: false, message: 'Baggrunden kunne ikke nulstilles.' });
            }
        });

        socket.on('admin-public-room-overlay-upload', async ({ id, image } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const bytes = Buffer.isBuffer(image) ? image : image instanceof Uint8Array ? Buffer.from(image) : null;
            const isPng = bytes && bytes.length >= 8
                && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
            const isWebp = bytes && bytes.length >= 12
                && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
            if (typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)
                || !bytes || (!isPng && !isWebp) || bytes.length > 850_000) {
                socket.emit('admin-room-overlay-result', { id, success: false, message: 'Vaelg et gyldigt PNG- eller WebP-overlay paa hoejst 850 KB.' });
                return;
            }
            try {
                const mimeType = isPng ? 'image/png' : 'image/webp';
                const { rowCount } = await pool.query(`
                    UPDATE chat_public_rooms
                    SET overlay_image = $2, overlay_mime_type = $3,
                        overlay_updated_at = NOW(), overlay_version = overlay_version + 1
                    WHERE id = $1
                `, [id, bytes, mimeType]);
                if (!rowCount) {
                    socket.emit('admin-room-overlay-result', { id, success: false, message: 'Rummet findes ikke laengere.' });
                    return;
                }
                const { rows: [room] } = await pool.query(`
                    SELECT id, room_number, name, welcome_title, welcome_text, is_shop, shop_is_open,
                           background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                           TRUE AS has_overlay, overlay_version, overlay_transform
                    FROM chat_public_rooms WHERE id = $1
                `, [id]);
                const roomName = formatPublicRoomName(room);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: room.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room.welcome_text || 'Her kan du moede andre og chatte sammen. God fornoejelse!',
                    roomBackgroundUrl: getPublicRoomBackgroundUrl(room),
                    roomBackgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                    roomOverlayUrl: getPublicRoomOverlayUrl(room),
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform)
                });
                socket.emit('admin-room-overlay-result', { id, success: true, message: `Overlayet til ${roomName} er gemt.` });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not save public room overlay:', getSafeErrorCode(error));
                socket.emit('admin-room-overlay-result', { id, success: false, message: 'Overlayet kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-room-overlay-reset', async ({ id } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)
                || typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)) return;
            try {
                const { rowCount } = await pool.query(`
                    UPDATE chat_public_rooms
                    SET overlay_image = NULL, overlay_mime_type = NULL,
                        overlay_updated_at = NULL, overlay_version = overlay_version + 1
                    WHERE id = $1
                `, [id]);
                if (!rowCount) {
                    socket.emit('admin-room-overlay-result', { id, success: false, message: 'Rummet findes ikke laengere.' });
                    return;
                }
                const { rows: [room] } = await pool.query(`
                    SELECT id, room_number, name, welcome_title, welcome_text,
                           background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                           overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform
                    FROM chat_public_rooms WHERE id = $1
                `, [id]);
                const roomName = formatPublicRoomName(room);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: room.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room.welcome_text || 'Her kan du moede andre og chatte sammen. God fornoejelse!',
                    roomBackgroundUrl: getPublicRoomBackgroundUrl(room),
                    roomBackgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                    roomOverlayUrl: null,
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform)
                });
                socket.emit('admin-room-overlay-result', { id, success: true, message: `Overlayet til ${roomName} er fjernet.` });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not remove public room overlay:', getSafeErrorCode(error));
                socket.emit('admin-room-overlay-result', { id, success: false, message: 'Overlayet kunne ikke fjernes.' });
            }
        });

        socket.on('admin-public-room-overlay-transform-set', async ({ id, x, y, rotation, scale } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const values = [x, y, rotation, scale].map(Number);
            if (typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)
                || !values.every(Number.isFinite)
                || values[0] < -270 || values[0] > 270
                || values[1] < -180 || values[1] > 180
                || values[2] < -180 || values[2] > 180
                || values[3] < 0.25 || values[3] > 3) {
                socket.emit('admin-room-overlay-result', { id, success: false, message: 'Kontrollér X/Y, rotation og skalering.' });
                return;
            }
            const transform = { x: values[0], y: values[1], rotation: values[2], scale: values[3] };
            try {
                const { rowCount } = await pool.query(
                    'UPDATE chat_public_rooms SET overlay_transform = $2::jsonb WHERE id = $1',
                    [id, JSON.stringify(transform)]
                );
                if (!rowCount) {
                    socket.emit('admin-room-overlay-result', { id, success: false, message: 'Rummet findes ikke længere.' });
                    return;
                }
                const { rows: [room] } = await pool.query(`
                    SELECT id, room_number, name, welcome_title, welcome_text,
                           background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                           overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform
                    FROM chat_public_rooms WHERE id = $1
                `, [id]);
                const roomName = formatPublicRoomName(room);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: room.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
                    roomBackgroundUrl: getPublicRoomBackgroundUrl(room),
                    roomBackgroundAnimation: normalizeClothingAnimation(room.background_animation_json),
                    roomOverlayUrl: getPublicRoomOverlayUrl(room),
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(room.overlay_transform)
                });
                socket.emit('admin-room-overlay-result', { id, success: true, message: `Placeringen af overlayet til ${roomName} er gemt.` });
                await sendAdminPublicRooms();
            } catch (error) {
                console.error('Could not update public room overlay transform:', getSafeErrorCode(error));
                socket.emit('admin-room-overlay-result', { id, success: false, message: 'Overlayets placering kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-room-create', async ({ name, roomNumber, floorNumber, isLocked = false, isHidden = false, isShop = false } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const cleanName = typeof name === 'string' ? name.normalize('NFKC').trim() : '';
            const requestedRoomNumber = roomNumber === null || roomNumber === undefined || roomNumber === '' ? null : Number(roomNumber);
            const floor = Number(floorNumber);
            if (!cleanName || cleanName.length > 60 || /[\u0000-\u001f\u007f]/.test(cleanName)
                || !Number.isInteger(floor) || floor < 1 || floor > 100
                || requestedRoomNumber !== null && (!Number.isInteger(requestedRoomNumber) || requestedRoomNumber < 3 || requestedRoomNumber > 100)
                || typeof isLocked !== 'boolean' || typeof isHidden !== 'boolean' || typeof isShop !== 'boolean') {
                socket.emit('admin-room-action-result', { success: false, message: 'Angiv et rumnavn, en etage og eventuelt et ledigt rumnummer fra 3 til 100.' });
                return;
            }
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(743920118)');
                if (requestedRoomNumber !== null) {
                    const { rowCount } = await client.query(
                        'SELECT 1 FROM chat_public_rooms WHERE room_number = $1', [requestedRoomNumber]
                    );
                    if (rowCount) {
                        await client.query('ROLLBACK');
                        socket.emit('admin-room-action-result', { success: false, message: `Rumnummer #${requestedRoomNumber} er allerede i brug.` });
                        return;
                    }
                }
                const { rows: [numberRow] } = await client.query(`
                    SELECT CASE WHEN $1::bigint IS NOT NULL THEN $1::bigint ELSE (
                        SELECT MIN(available.room_number)::bigint
                        FROM generate_series(3, 100) AS available(room_number)
                        WHERE NOT EXISTS (
                            SELECT 1 FROM chat_public_rooms room WHERE room.room_number = available.room_number
                        )
                    ) END AS room_number
                `, [requestedRoomNumber]);
                if (!numberRow?.room_number) {
                    await client.query('ROLLBACK');
                    socket.emit('admin-room-action-result', { success: false, message: 'Alle offentlige rumnumre fra 3 til 100 er i brug.' });
                    return;
                }
                const selectedRoomNumber = Number(numberRow.room_number);
                const id = `public:${selectedRoomNumber}`;
                await client.query(`
                    INSERT INTO chat_public_rooms (id, room_number, floor_number, name, is_locked, is_hidden, is_shop)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [id, selectedRoomNumber, floor, cleanName, isLocked, isHidden, isShop]);
                await client.query('COMMIT');
                socket.emit('admin-room-action-result', { success: true, message: `Rum #${selectedRoomNumber} blev oprettet på etage ${floor}.` });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch { }
                console.error('Could not create public room:', getSafeErrorCode(error));
                socket.emit('admin-room-action-result', { success: false, message: 'Rummet kunne ikke oprettes.' });
            } finally {
                client.release();
            }
        });

        socket.on('admin-public-room-update', async ({ id, name, floorNumber, isLocked, isHidden, isShop } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const cleanName = typeof name === 'string' ? name.normalize('NFKC').trim() : '';
            const floor = Number(floorNumber);
            if (typeof id !== 'string' || cleanName.length < 1 || cleanName.length > 60
                || /[\u0000-\u001f\u007f]/.test(cleanName) || !Number.isInteger(floor) || floor < 1 || floor > 100
                || typeof isLocked !== 'boolean' || typeof isHidden !== 'boolean' || typeof isShop !== 'boolean') {
                socket.emit('admin-room-action-result', { success: false, message: 'Kontrollér rumnavn og etagenummer (1–100).' });
                return;
            }
            try {
                const { rowCount } = await pool.query(
                    'UPDATE chat_public_rooms SET name = $2, floor_number = $3, is_locked = $4, is_hidden = $5, is_shop = $6, shop_is_open = CASE WHEN $6 THEN shop_is_open ELSE FALSE END WHERE id = $1',
                    [id, cleanName, floor, isLocked, isHidden, isShop]
                );
                if (!rowCount) {
                    socket.emit('admin-room-action-result', { success: false, message: 'Rummet findes ikke længere.' });
                    return;
                }
                const { rows: [updatedRoom] } = await pool.query(`
                    SELECT id, room_number, name, welcome_title, welcome_text, is_shop, shop_is_open,
                           background_image IS NOT NULL AS has_background, background_version, background_animation_json,
                           overlay_image IS NOT NULL AS has_overlay, overlay_version, overlay_transform
                    FROM chat_public_rooms WHERE id = $1
                `, [id]);
                const roomName = formatPublicRoomName(updatedRoom);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    welcomeTitle: updatedRoom.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: updatedRoom.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!',
                    roomBackgroundUrl: getPublicRoomBackgroundUrl(updatedRoom),
                    roomBackgroundAnimation: normalizeClothingAnimation(updatedRoom.background_animation_json),
                    roomOverlayUrl: getPublicRoomOverlayUrl(updatedRoom),
                    roomOverlayTransform: normalizePublicRoomOverlayTransform(updatedRoom.overlay_transform),
                    isShop: updatedRoom.is_shop === true,
                    shopIsOpen: updatedRoom.shop_is_open === true
                });
                socket.emit('admin-room-action-result', { success: true, message: 'Rummets navn og etage er gemt.' });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not update public room:', getSafeErrorCode(error));
                socket.emit('admin-room-action-result', { success: false, message: 'Rummets oplysninger kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-room-welcome-update', async ({ id, welcomeTitle, welcomeText } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            const cleanTitle = typeof welcomeTitle === 'string' ? welcomeTitle.normalize('NFKC').trim() : '';
            const cleanText = typeof welcomeText === 'string'
                ? welcomeText.normalize('NFKC').replace(/\r\n?/g, '\n').trim()
                : '';
            if (typeof id !== 'string' || !/^(common|disco|public:[1-9]\d{0,18})$/.test(id)
                || cleanTitle.length > 100 || cleanText.length > 500
                || /[\u0000-\u001f\u007f]/.test(cleanTitle)
                || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleanText)) {
                socket.emit('admin-room-welcome-result', { id, success: false, message: 'Kontrollér overskriften (maks. 100 tegn) og velkomstteksten (maks. 500 tegn).' });
                return;
            }
            try {
                const { rowCount } = await pool.query(
                    'UPDATE chat_public_rooms SET welcome_title = $2, welcome_text = $3 WHERE id = $1',
                    [id, cleanTitle || null, cleanText || null]
                );
                if (!rowCount) {
                    socket.emit('admin-room-welcome-result', { id, success: false, message: 'Rummet findes ikke længere.' });
                    return;
                }
                const [roomResponse, welcome] = await Promise.all([
                    pool.query('SELECT id, room_number, name, background_image IS NOT NULL AS has_background, background_version FROM chat_public_rooms WHERE id = $1', [id]),
                    getRoomWelcome(id)
                ]);
                const room = roomResponse.rows[0];
                const roomName = formatPublicRoomName(room);
                io.to(roomChannel(id)).emit('public-room-metadata', {
                    roomId: id,
                    roomName,
                    ...welcome
                });
                socket.emit('admin-room-welcome-result', { id, success: true, message: `Velkomsten til ${roomName} er gemt.` });
            } catch (error) {
                console.error('Could not update public room welcome:', getSafeErrorCode(error));
                socket.emit('admin-room-welcome-result', { id, success: false, message: 'Velkomsten kunne ikke gemmes.' });
            }
        });

        socket.on('admin-public-room-delete', async ({ id } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)) return;
            if (typeof id !== 'string' || !/^public:[1-9]\d{0,18}$/.test(id)) {
                socket.emit('admin-room-action-result', { success: false, message: 'Fællesrum og Diskoteket er faste systemrum og kan ikke slettes.' });
                return;
            }
            try {
                await cleanupStalePlayers();
                const occupantCount = await redis.hLen(roomKeys(id).players);
                if (occupantCount > 0) {
                    socket.emit('admin-room-action-result', { success: false, message: 'Rummet kan ikke slettes, mens der er brugere i det.' });
                    return;
                }
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const { rowCount } = await client.query('DELETE FROM chat_public_rooms WHERE id = $1', [id]);
                    if (!rowCount) {
                        await client.query('ROLLBACK');
                        socket.emit('admin-room-action-result', { success: false, message: 'Rummet findes ikke længere.' });
                        return;
                    }
                    const { rows: apartments } = await client.query(`
                        SELECT a.id, a.layout_json, a.apartment_name, a.apartment_number, u.username, u.welcome_message
                        FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id
                    `);
                    const apartmentUpdates = [];
                    for (const apartment of apartments) {
                        const layout = apartment.layout_json && typeof apartment.layout_json === 'object' ? apartment.layout_json : {};
                        let changed = false;
                        for (const [cell, value] of Object.entries(layout)) {
                            if (typeof value !== 'string') continue;
                            const [base, color] = value.split('|', 2);
                            if (base === `door:${id}`) {
                                layout[cell] = `door:common${color ? `|${color}` : ''}`;
                                changed = true;
                            }
                        }
                        if (changed) {
                            await client.query('UPDATE chat_apartments SET layout_json = $2::jsonb WHERE id = $1', [apartment.id, JSON.stringify(layout)]);
                            const apartmentRoomId = `apartment:${apartment.id}`;
                            await redis.del(roomKeys(apartmentRoomId).tiles);
                            if (Object.keys(layout).length) await redis.hSet(roomKeys(apartmentRoomId).tiles, layout);
                            apartmentUpdates.push({ apartmentRoomId, apartment, tiles: normalizeApartmentTiles(layout) });
                        }
                    }
                    await client.query('COMMIT');
                    for (const { apartmentRoomId, apartment, tiles } of apartmentUpdates) {
                        const roomName = getApartmentRoomName(apartment);
                        io.to(roomChannel(apartmentRoomId)).emit('apartment-layout-updated', {
                            roomId: apartmentRoomId,
                            tiles,
                            name: apartment.apartment_name || '',
                            welcomeMessage: apartment.welcome_message || '',
                            roomName,
                            welcomeTitle: `Velkommen i ${roomName}`,
                            welcomeText: apartment.welcome_message || `${apartment.username} har ikke skrevet en velkomst endnu.`
                        });
                    }
                } catch (error) {
                    await client.query('ROLLBACK');
                    throw error;
                } finally { client.release(); }
                await redis.del(...Object.values(roomKeys(id)));
                socket.emit('admin-room-action-result', { success: true, message: 'Rummet er slettet. Eventuelle døre fører nu til Fællesrummet.' });
                await sendAdminPublicRooms();
                io.emit('navigator-refresh');
            } catch (error) {
                console.error('Could not delete public room:', getSafeErrorCode(error));
                socket.emit('admin-room-action-result', { success: false, message: 'Rummet kunne ikke slettes.' });
            }
        });

        socket.on('admin-online-users-request', async (payload = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            try {
                const query = payload && typeof payload === 'object' ? payload.query : '';
                const searchQuery = typeof query === 'string' ? query.normalize('NFKC').trim().slice(0, 18) : '';
                await cleanupStalePlayers();
                const { rows: apartments } = await pool.query(`
                    SELECT a.id, a.apartment_number, a.apartment_name, u.username
                    FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id
                `);
                const publicRooms = await getPublicRooms();
                const hiddenPublicRoomIds = new Set(publicRooms.filter((room) => room.is_hidden).map((room) => room.id));
                const roomNames = new Map([
                    ...publicRooms.map((room) => [room.id, formatPublicRoomName(room)]),
                    ...apartments.map((apartment) => [
                        `apartment:${apartment.id}`,
                        getApartmentRoomName(apartment)
                    ])
                ]);
                const { rows: onlineSessions } = await pool.query(`
                    SELECT s.socket_id, s.user_id::text AS user_id, s.ip_hash, u.username
                    FROM chat_online_sessions s JOIN chat_users u ON u.id = s.user_id
                `);
                const onlineBySocket = new Map(onlineSessions.map((session) => [session.socket_id, session]));
                if (searchQuery) {
                    const onlineByUserId = new Map(onlineSessions.map((session) => [session.user_id, session]));
                    const { rows: accounts } = await pool.query(`
                        SELECT id::text AS user_id, username,
                               (registration_ip_hash IS NOT NULL OR EXISTS (
                                   SELECT 1 FROM chat_user_last_ips last_ip WHERE last_ip.user_id = chat_users.id
                               )) AS has_known_ip,
                               EXISTS (
                                   SELECT 1 FROM chat_user_last_ips last_ip WHERE last_ip.user_id = chat_users.id
                               ) AS has_last_login_ip,
                               (registration_ip_hash IS NOT NULL) AS has_registration_ip,
                               COUNT(*) OVER()::int AS match_count
                        FROM chat_users
                        WHERE username ILIKE '%' || $1 || '%'
                        ORDER BY username
                        LIMIT 100
                    `, [searchQuery]);
                    const users = accounts.map((account) => {
                        const session = onlineByUserId.get(account.user_id);
                        return {
                            socketId: session?.socket_id || null,
                            userId: account.user_id,
                            username: account.username,
                            roomName: session && invisibleSocketIds.has(session.socket_id) ? 'Offline · usynlig' : session ? 'Online' : 'Offline',
                            isOnline: Boolean(session && !invisibleSocketIds.has(session.socket_id)),
                            isConnected: Boolean(session),
                            isInvisible: Boolean(session && invisibleSocketIds.has(session.socket_id)),
                            hasKnownIp: Boolean(session?.ip_hash || account.has_known_ip),
                            ipSource: session?.ip_hash ? 'aktuel IP' : account.has_last_login_ip ? 'seneste login' : account.has_registration_ip ? 'oprettelses-IP' : '',
                            isSelf: account.user_id === String(socket.data.user.id)
                        };
                    });
                    socket.emit('admin-online-users', {
                        users,
                        query: searchQuery,
                        totalCount: accounts[0]?.match_count || 0
                    });
                    return;
                }
                const users = [];
                for (const roomId of await getAllRoomIds()) {
                    const players = await redis.hGetAll(roomKeys(roomId).players);
                    for (const [socketId, encodedPlayer] of Object.entries(players)) {
                        const player = JSON.parse(encodedPlayer);
                        const onlineSession = onlineBySocket.get(socketId);
                        users.push({
                            socketId,
                            userId: onlineSession?.user_id || String(activeSocketUsers.get(socketId) || ''),
                            username: onlineSession?.username || player.name,
                            roomId,
                            roomName: invisibleSocketIds.has(socketId) ? 'Offline · usynlig' : roomNames.get(roomId) || 'Ukendt rum',
                            isOnline: !invisibleSocketIds.has(socketId),
                            isConnected: true,
                            isInvisible: invisibleSocketIds.has(socketId),
                            hasKnownIp: Boolean(onlineSession?.ip_hash),
                            isSelf: String(onlineSession?.user_id || activeSocketUsers.get(socketId) || '') === String(socket.data.user.id)
                        });
                    }
                }
                users.sort((first, second) => first.username.localeCompare(second.username, 'da'));
                socket.emit('admin-online-users', { users, query: '' });
            } catch (error) {
                console.error('Could not load admin online users:', getSafeErrorCode(error));
                socket.emit('admin-error', { message: 'Brugerlisten kunne ikke hentes.' });
            }
        });

        socket.on('admin-ip-bans-request', async () => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            try {
                await pool.query('DELETE FROM chat_ip_bans WHERE expires_at IS NOT NULL AND expires_at <= NOW()');
                const { rows } = await pool.query(`
                    SELECT id::text AS id, ip_address_encrypted, username, reason,
                           admin_initials, created_at, expires_at
                    FROM chat_ip_bans ORDER BY created_at DESC
                `);
                socket.emit('admin-ip-bans', {
                    bans: rows.map((ban) => ({
                        id: ban.id,
                        ipAddress: decryptIpAddress(ban.ip_address_encrypted),
                        username: ban.username,
                        reason: ban.reason,
                        adminInitials: ban.admin_initials,
                        createdAt: ban.created_at,
                        expiresAt: ban.expires_at
                    }))
                });
            } catch (error) {
                console.error('Could not load admin IP bans:', getSafeErrorCode(error));
                socket.emit('admin-error', { message: 'Banlisten kunne ikke hentes.' });
            }
        });

        socket.on('admin-context-ban-target-request', async ({ targetSocketId } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            const fail = (message) => socket.emit('admin-context-ban-target', { targetSocketId, error: message });
            if (typeof targetSocketId !== 'string' || targetSocketId.length > 128
                || targetSocketId === socket.id || !activeSocketIds.has(targetSocketId)) {
                fail('Brugeren er ikke længere online.');
                return;
            }
            try {
                const { rows: [target] } = await pool.query(`
                    SELECT s.user_id::text AS user_id, u.username
                    FROM chat_online_sessions s
                    JOIN chat_users u ON u.id = s.user_id
                    WHERE s.socket_id = $1
                `, [targetSocketId]);
                if (!target) {
                    fail('Brugeren er ikke længere online.');
                    return;
                }
                if (target.user_id === String(socket.data.user.id)) {
                    fail('Du kan ikke banne din egen bruger.');
                    return;
                }
                socket.emit('admin-context-ban-target', {
                    targetSocketId,
                    userId: target.user_id,
                    username: target.username
                });
            } catch (error) {
                console.error('Could not resolve context ban target:', getSafeErrorCode(error));
                fail('Brugerens banoplysninger kunne ikke hentes.');
            }
        });

        socket.on('admin-user-kick', async ({ targetSocketId } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            if (typeof targetSocketId !== 'string' || targetSocketId.length > 128) {
                socket.emit('admin-action-result', { success: false, message: 'Brugeren er ikke længere online.' });
                return;
            }
            try {
                const { rows: [targetSession] } = await pool.query(`
                    SELECT s.user_id::text AS user_id, u.username
                    FROM chat_online_sessions s JOIN chat_users u ON u.id = s.user_id
                    WHERE s.socket_id = $1
                `, [targetSocketId]);
                if (!targetSession) {
                    socket.emit('admin-action-result', { success: false, message: 'Brugeren er ikke længere online.' });
                    return;
                }
                if (String(targetSession.user_id) === String(socket.data.user.id)) {
                    socket.emit('admin-action-result', { success: false, message: 'Du kan ikke kicke din egen bruger.' });
                    return;
                }
                await kickPlayer(targetSocketId, 'Du blev fjernet fra chatten af en administrator. Du kan logge ind igen.');
                socket.emit('admin-action-result', { success: true, message: `${targetSession.username} blev kicket.` });
            } catch (error) {
                console.error('Could not kick chat participant:', getSafeErrorCode(error));
                socket.emit('admin-action-result', { success: false, message: 'Brugeren kunne ikke kicket. Prøv igen.' });
            }
        });

        socket.on('admin-user-bring', async ({ targetSocketId } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id) || socket.data.switchingRoom) return;
            if (typeof targetSocketId !== 'string' || targetSocketId.length > 128 || targetSocketId === socket.id) {
                socket.emit('admin-action-result', { success: false, message: 'Vælg en anden bruger, der er online.' });
                return;
            }
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            const roomId = activeSocketRooms.get(socket.id);
            if (!targetSocket || !activeSocketIds.has(targetSocketId) || !roomId || targetSocket.data.switchingRoom) {
                socket.emit('admin-action-result', { success: false, message: 'Brugeren eller dit rum er ikke længere tilgængeligt.' });
                return;
            }
            if (String(activeSocketUsers.get(targetSocketId)) === String(socket.data.user.id)) {
                socket.emit('admin-action-result', { success: false, message: 'Du kan ikke hente din egen bruger.' });
                return;
            }
            targetSocket.data.switchingRoom = true;
            try {
                if (activeSocketRooms.get(targetSocketId) !== roomId) {
                    const joined = await placeSocketInRoom(targetSocket, roomId, { bypassRoomAccess: true });
                    if (!joined) {
                        socket.emit('admin-action-result', { success: false, message: 'Brugeren kunne ikke flyttes. Rummet kan være fuldt.' });
                        return;
                    }
                }
                const arrivedNearAdmin = await moveSocketNearTarget(targetSocket, roomId, socket.id);
                if (!arrivedNearAdmin && activeSocketRooms.get(targetSocketId) !== roomId) {
                    socket.emit('admin-action-result', { success: false, message: 'Brugeren kunne ikke flyttes. Rummet kan være fuldt.' });
                    return;
                }
                socket.emit('admin-action-result', { success: true, message: `${targetSocket.data.user.username} blev hentet hen til dig.` });
                targetSocket.emit('profile-teleport-result', { message: `En administrator hentede dig til ${socket.data.user.username}.` });
            } catch (error) {
                console.error('Could not bring chat participant:', getSafeErrorCode(error));
                socket.emit('admin-action-result', { success: false, message: 'Brugeren kunne ikke hentes. Prøv igen.' });
            } finally {
                targetSocket.data.switchingRoom = false;
            }
        });

        socket.on('admin-user-swap-position', async ({ targetSocketId } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id) || socket.data.switchingRoom) return;
            const actorRoomId = activeSocketRooms.get(socket.id);
            const targetSocket = typeof targetSocketId === 'string' ? io.sockets.sockets.get(targetSocketId) : null;
            if (!targetSocketId || targetSocketId === socket.id || !targetSocket
                || !activeSocketIds.has(targetSocketId) || targetSocket.data.switchingRoom
                || !actorRoomId || activeSocketRooms.get(targetSocketId) !== actorRoomId) {
                socket.emit('admin-action-result', { success: false, message: 'Brugeren er ikke længere i samme rum.' });
                return;
            }
            if (String(activeSocketUsers.get(targetSocketId)) === String(socket.data.user.id)) {
                socket.emit('admin-action-result', { success: false, message: 'Du kan ikke skifte plads med din egen bruger.' });
                return;
            }
            try {
                const keys = roomKeys(actorRoomId);
                const swappedJson = await redis.eval(SWAP_PLAYER_POSITIONS_SCRIPT, {
                    keys: [keys.players, keys.cells],
                    arguments: [socket.id, targetSocketId, String(Date.now())]
                });
                if (!swappedJson) {
                    socket.emit('admin-action-result', { success: false, message: 'Pladserne kunne ikke byttes. Kontrollér, at begge avatarer stadig er i rummet.' });
                    return;
                }
                const swapped = JSON.parse(swappedJson);
                const first = publicPlayer(swapped.first);
                const second = publicPlayer(swapped.second);
                await Promise.all([
                    emitRoomEventForVisibleSender(actorRoomId, 'playerMoved', { id: first.id, col: first.col, row: first.row }, first.id),
                    emitRoomEventForVisibleSender(actorRoomId, 'playerMoved', { id: second.id, col: second.col, row: second.row }, second.id)
                ]);
                socket.emit('admin-action-result', { success: true, message: `Du har byttet plads med ${second.name}.` });
            } catch (error) {
                console.error('Could not swap chat participant positions:', getSafeErrorCode(error));
                socket.emit('admin-action-result', { success: false, message: 'Pladserne kunne ikke byttes. Prøv igen.' });
            }
        });

        socket.on('admin-user-ban', async (payload = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            const data = payload && typeof payload === 'object' ? payload : {};
            const { targetSocketId, targetUserId, durationMinutes, permanent, reason, initials } = data;
            if (typeof targetUserId !== 'string' || !/^[1-9]\d{0,18}$/.test(targetUserId)) {
                socket.emit('admin-action-result', { success: false, message: 'Brugeren kunne ikke findes.' });
                return;
            }
            try {
                const [{ rows: [targetAccount] }, { rows: targetSessions }, { rows: [lastKnownIp] }] = await Promise.all([
                    pool.query(`
                        SELECT id::text AS user_id, username, registration_ip_hash
                        FROM chat_users WHERE id = $1
                    `, [targetUserId]),
                    pool.query(`
                        SELECT socket_id, ip_hash FROM chat_online_sessions WHERE user_id = $1
                    `, [targetUserId]),
                    pool.query(`
                        SELECT ip_hash, ip_address_encrypted
                        FROM chat_user_last_ips WHERE user_id = $1
                    `, [targetUserId])
                ]);
                if (!targetAccount) {
                    socket.emit('admin-action-result', { success: false, message: 'Brugeren findes ikke længere.' });
                    return;
                }
                if (targetAccount.user_id === String(socket.data.user.id)) {
                    socket.emit('admin-action-result', { success: false, message: 'Du kan ikke banne din egen bruger.' });
                    return;
                }
                const matchedSession = targetSessions.find((session) => session.socket_id === targetSocketId)
                    || targetSessions[0]
                    || null;
                let targetSocket = null;
                if (matchedSession && typeof matchedSession.socket_id === 'string') {
                    const targetSockets = await io.in(matchedSession.socket_id).fetchSockets();
                    targetSocket = targetSockets[0] || null;
                }
                const cleanReason = typeof reason === 'string' ? redactSecrets(reason.trim()).slice(0, 240) : '';
                const cleanInitials = typeof initials === 'string' ? initials.trim().toLocaleUpperCase('da-DK') : '';
                const minutes = Number(durationMinutes);
                if (typeof permanent !== 'boolean') {
                    socket.emit('admin-action-result', { success: false, message: 'Vælg en gyldig banvarighed.' });
                    return;
                }
                if (!cleanReason || !/^[A-ZÆØÅ]{1,8}$/.test(cleanInitials)) {
                    socket.emit('admin-action-result', { success: false, message: 'Angiv en grund og gyldige admin-initialer.' });
                    return;
                }
                if (!permanent && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600)) {
                    socket.emit('admin-action-result', { success: false, message: 'Vælg en gyldig banvarighed på 1 minut til 1 år.' });
                    return;
                }
                const targetIpHash = targetSocket?.data.ipHash
                    || matchedSession?.ip_hash
                    || lastKnownIp?.ip_hash
                    || targetAccount.registration_ip_hash;
                const targetIpAddress = targetSocket?.data.clientIp
                    || (lastKnownIp ? decryptIpAddress(lastKnownIp.ip_address_encrypted) : null)
                    || (targetAccount.registration_ip_hash ? 'Ukendt (oprettelses-IP)' : null);
                if (!targetIpHash || !targetIpAddress) {
                    socket.emit('admin-action-result', {
                        success: false,
                        message: 'Brugeren har ingen kendt IP-adresse endnu og kan derfor ikke IP-bannes.'
                    });
                    return;
                }
                if (targetIpHash === socket.data.ipHash) {
                    socket.emit('admin-action-result', { success: false, message: 'Banen ville også blokere din egen IP-adresse.' });
                    return;
                }
                const expiresAt = permanent ? null : new Date(Date.now() + minutes * 60_000);
                await pool.query(`
                    INSERT INTO chat_ip_bans
                        (ip_hash, ip_address_encrypted, username, reason, admin_initials, created_at, expires_at)
                    VALUES ($1, $2, $3, $4, $5, NOW(), $6)
                    ON CONFLICT (ip_hash) DO UPDATE SET
                        ip_address_encrypted = EXCLUDED.ip_address_encrypted,
                        username = EXCLUDED.username,
                        reason = EXCLUDED.reason,
                        admin_initials = EXCLUDED.admin_initials,
                        created_at = NOW(),
                        expires_at = EXCLUDED.expires_at
                `, [targetIpHash, encryptIpAddress(targetIpAddress), targetAccount.username,
                    cleanReason, cleanInitials, expiresAt]);
                const banMessage = formatIpBanMessage({ reason: cleanReason, admin_initials: cleanInitials, expires_at: expiresAt });
                const { rows: affectedSessions } = await pool.query(
                    'SELECT socket_id FROM chat_online_sessions WHERE ip_hash = $1', [targetIpHash]
                );
                const affectedSockets = affectedSessions.map((session) => session.socket_id);
                for (const id of affectedSockets) await kickPlayer(id, banMessage);
                socket.emit('admin-action-result', {
                    success: true,
                    message: `${targetAccount.username} blev IP-bannet${affectedSockets.length ? `, og ${affectedSockets.length} aktive forbindelse(r) blev afbrudt` : ''}.`
                });
            } catch (error) {
                console.error('Could not ban chat IP:', getSafeErrorCode(error));
                socket.emit('admin-action-result', { success: false, message: 'Ban kunne ikke gemmes. Prøv igen.' });
            }
        });

        socket.on('admin-ip-unban', async ({ banId } = {}) => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            if (typeof banId !== 'string' || !/^[1-9]\d{0,18}$/.test(banId)) return;
            try {
                const { rowCount } = await pool.query('DELETE FROM chat_ip_bans WHERE id = $1', [banId]);
                socket.emit('admin-action-result', {
                    success: rowCount > 0,
                    message: rowCount > 0 ? 'Banlysningen er fjernet.' : 'Banlysningen findes ikke længere.'
                });
                socket.emit('admin-ip-bans-request');
            } catch (error) {
                console.error('Could not remove chat IP ban:', getSafeErrorCode(error));
                socket.emit('admin-action-result', { success: false, message: 'Banlysningen kunne ikke fjernes.' });
            }
        });

        socket.on('room-switch', async (payload = {}) => {
            if (!activeSocketIds.has(socket.id) || socket.data.switchingRoom) return;
            const roomId = String(payload.roomId || '');
            if (!await isValidRoomId(roomId)) return;
            if (activeSocketRooms.get(socket.id) === roomId) return;
            if (isPublicChatRoomId(roomId)) {
                const accessError = publicRoomAccessError(await getPublicRoomPolicy(roomId), Boolean(socket.data.canManagePublicRooms));
                if (accessError) {
                    socket.emit('room-error', { message: accessError });
                    return;
                }
            }
            socket.data.switchingRoom = true;
            try {
                const apartmentMatch = /^apartment:([1-9]\d{0,18})$/.exec(roomId);
                if (apartmentMatch) {
                    const { rows: [apartment] } = await pool.query('SELECT owner_id FROM chat_apartments WHERE id = $1', [apartmentMatch[1]]);
                    if (!apartment) return;
                    if (!socket.data.isAdmin && String(apartment.owner_id) !== String(socket.data.user.id)) {
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
                    const publicRooms = await getPublicRooms();
                    let destination = '';
                    const startIndex = publicRooms.length ? crypto.randomInt(publicRooms.length) : 0;
                    for (let offset = 0; offset < publicRooms.length; offset += 1) {
                        const publicRoom = publicRooms[(startIndex + offset) % publicRooms.length];
                        if (await placeSocketInRoom(targetSocket, publicRoom.id)) {
                            destination = formatPublicRoomName(publicRoom);
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

        socket.on('public-room-layout-request', async () => {
            if (!socket.data.isAdmin || !activeSocketIds.has(socket.id)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!isPublicChatRoomId(roomId)) return;
            try {
                const [tiles, { rows: [room] }] = await Promise.all([
                    loadApartmentTiles(roomId),
                    pool.query('SELECT room_number, name FROM chat_public_rooms WHERE id = $1', [roomId])
                ]);
                if (!room) return;
                socket.emit('apartment-layout-data', {
                    roomId,
                    tiles,
                    name: '',
                    welcomeMessage: '',
                    roomName: formatPublicRoomName(room),
                    editorKind: 'public'
                });
            } catch (error) {
                console.error('Could not load public room layout:', getSafeErrorCode(error));
                socket.emit('apartment-layout-result', { success: false, message: 'Rummets felter kunne ikke indlæses.' });
            }
        });

        socket.on('apartment-door-options-request', async () => {
            if (!activeSocketIds.has(socket.id)) return;
            const roomId = activeSocketRooms.get(socket.id);
            const canEditApartment = await canEditApartmentRoom(socket.data.user.id, roomId);
            if (!canEditApartment && !(socket.data.canManagePublicRooms && isPublicChatRoomId(roomId))) return;
            const [publicRooms, { rows: apartments }] = await Promise.all([
                getPublicRooms(),
                pool.query(`SELECT a.id, a.apartment_number, a.apartment_name, u.username
                    FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id ORDER BY a.apartment_number`)
            ]);
            socket.emit('apartment-door-options', {
                roomId,
                rooms: [
                    ...publicRooms.map((room) => ({ id: room.id, name: formatPublicRoomName(room) })),
                    ...apartments.map((apartment) => ({ id: `apartment:${apartment.id}`, name: getApartmentRoomName(apartment) }))
                ]
            });
        });

        socket.on('apartment-door-use', async ({ col, row } = {}) => {
            if (!activeSocketIds.has(socket.id) || !Number.isInteger(col) || !Number.isInteger(row)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if ((!String(roomId || '').startsWith('apartment:') && !isPublicChatRoomId(roomId))
                || !GRID_CELL_KEYS.has(`${col}:${row}`)) return;
            try {
                const state = await redis.hGet(roomKeys(roomId).tiles, `${col}:${row}`);
                const tile = parseApartmentTileState(state);
                const destination = tile?.kind === 'door' ? tile.destination : '';
                if (!/^(common|disco|public:[1-9]\d{0,18}|apartment:[1-9]\d{0,18})$/.test(destination)) {
                    socket.emit('room-error', { message: 'Der er ingen dør på det felt.' });
                    return;
                }
                if (destination.startsWith('public:') || ['common', 'disco'].includes(destination)) {
                    if (!await isValidRoomId(destination)) {
                        socket.emit('room-error', { message: 'Døren fører ikke længere til et eksisterende rum.' });
                        return;
                    }
                } else if (destination.startsWith('apartment:')) {
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

        socket.on('public-room-layout-save', async ({ tiles: requestedTiles } = {}) => {
            if (!socket.data.canManagePublicRooms || !activeSocketIds.has(socket.id)
                || !Array.isArray(requestedTiles) || requestedTiles.length > GRID_CELLS.length) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!isPublicChatRoomId(roomId)) return;
            try {
                const nextTiles = {};
                const seenTiles = new Set();
                for (const tile of requestedTiles) {
                    const parsedState = tile && parseApartmentTileState(tile.state);
                    if (!tile || !Number.isInteger(tile.col) || !Number.isInteger(tile.row) || !parsedState) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Rumplanen indeholder ugyldige felter.' });
                        return;
                    }
                    const key = `${tile.col}:${tile.row}`;
                    if (!GRID_CELL_KEYS.has(key) || seenTiles.has(key)) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Rumplanen indeholder ugyldige eller gentagne felter.' });
                        return;
                    }
                    seenTiles.add(key);
                    const normalized = serializeApartmentTileState(parsedState);
                    if ((DEFAULT_CLOSED_CELL_KEYS.has(key) || TEST_ROOM_FURNITURE_CELL_KEYS.has(key)) && parsedState.kind === 'floor') {
                        nextTiles[key] = parsedState.color ? `open|${parsedState.color}` : 'open';
                    } else if (normalized) nextTiles[key] = normalized;
                }
                if (seenTiles.size !== GRID_CELLS.length) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Rumplanen mangler felter.' });
                    return;
                }
                if (Object.values(nextTiles).filter((state) => parseApartmentTileState(state)?.kind === 'closed').length >= GRID_CELLS.length) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Mindst ét felt skal være åbent eller en dør, så man kan komme ind.' });
                    return;
                }
                const doorPublicIds = [...new Set(Object.values(nextTiles)
                    .map(parseApartmentTileState)
                    .filter((tile) => tile?.kind === 'door' && isPublicChatRoomId(tile.destination))
                    .map((tile) => tile.destination))];
                if (doorPublicIds.length) {
                    const { rows } = await pool.query('SELECT id FROM chat_public_rooms WHERE id = ANY($1::text[])', [doorPublicIds]);
                    if (rows.length !== doorPublicIds.length) {
                        socket.emit('apartment-layout-result', { success: false, message: 'En dør peger på et offentligt rum, der ikke findes.' });
                        return;
                    }
                }
                const doorApartmentIds = [...new Set(Object.values(nextTiles)
                    .map(parseApartmentTileState)
                    .filter((tile) => tile?.kind === 'door' && tile.destination.startsWith('apartment:'))
                    .map((tile) => tile.destination.slice('apartment:'.length)))];
                if (doorApartmentIds.length) {
                    const { rows } = await pool.query('SELECT id FROM chat_apartments WHERE id = ANY($1::bigint[])', [doorApartmentIds]);
                    if (rows.length !== doorApartmentIds.length) {
                        socket.emit('apartment-layout-result', { success: false, message: 'En dør peger på en lejlighed, der ikke findes.' });
                        return;
                    }
                }
                const keys = roomKeys(roomId);
                for (const [cell, state] of Object.entries(nextTiles)) {
                    if (parseApartmentTileState(state)?.kind === 'closed' && await redis.hGet(keys.cells, cell)) {
                        socket.emit('apartment-layout-result', { success: false, message: 'Flyt først brugeren væk fra feltet, du vil låse.' });
                        return;
                    }
                }
                const { rowCount } = await pool.query('UPDATE chat_public_rooms SET layout_json = $1::jsonb WHERE id = $2', [JSON.stringify(nextTiles), roomId]);
                if (!rowCount) {
                    socket.emit('apartment-layout-result', { success: false, message: 'Det offentlige rum findes ikke længere.' });
                    return;
                }
                await redis.del(keys.tiles);
                if (Object.keys(nextTiles).length) await redis.hSet(keys.tiles, nextTiles);
                const { rows: [room] } = await pool.query('SELECT id, room_number, name, welcome_title, welcome_text FROM chat_public_rooms WHERE id = $1', [roomId]);
                const roomName = room ? formatPublicRoomName(room) : '';
                io.to(roomChannel(roomId)).emit('public-room-layout-updated', { roomId, tiles: nextTiles });
                io.emit('navigator-refresh');
                socket.emit('apartment-layout-result', {
                    success: true,
                    message: `Felter og døre i ${roomName} er gemt.`,
                    roomId,
                    tiles: nextTiles,
                    name: '',
                    welcomeMessage: '',
                    roomName,
                    welcomeTitle: room?.welcome_title || `Velkommen i ${roomName}`,
                    welcomeText: room?.welcome_text || 'Her kan du møde andre og chatte sammen. God fornøjelse!'
                });
            } catch (error) {
                console.error('Could not save public room layout:', getSafeErrorCode(error));
                socket.emit('apartment-layout-result', { success: false, message: 'Rummets felter kunne ikke gemmes.' });
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
                const doorPublicRoomIds = [...new Set(Object.values(nextTiles)
                    .map(parseApartmentTileState)
                    .filter((tile) => tile?.kind === 'door' && (tile.destination === 'common' || tile.destination === 'disco' || tile.destination.startsWith('public:')))
                    .map((tile) => tile.destination))];
                if (doorPublicRoomIds.length) {
                    const { rows: destinations } = await pool.query(
                        'SELECT id FROM chat_public_rooms WHERE id = ANY($1::text[])',
                        [doorPublicRoomIds]
                    );
                    if (destinations.length !== doorPublicRoomIds.length) {
                        socket.emit('apartment-layout-result', { success: false, message: 'En dør peger på et offentligt rum, der ikke findes.' });
                        return;
                    }
                }
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
                const publicRooms = (await getPublicRooms()).filter((room) => socket.data.canManagePublicRooms || !room.is_hidden);
                const rooms = publicRooms.map((room) => ({
                    id: room.id,
                    name: formatPublicRoomName(room),
                    type: 'public',
                    roomNumber: Number(room.room_number),
                    floorNumber: Number(room.floor_number),
                    isLocked: room.is_locked,
                    isShop: room.is_shop === true
                }));
                const { rows: apartmentRows } = await pool.query(`
                    SELECT DISTINCT a.id, a.apartment_number, a.apartment_name, a.owner_id::text AS owner_id, u.username
                    FROM chat_apartments a
                    JOIN chat_users u ON u.id = a.owner_id
                    ${socket.data.isAdmin ? '' : 'JOIN chat_online_sessions s ON s.user_id = a.owner_id'}
                    ORDER BY a.apartment_number
                `);
                const visibleOnlineOwners = new Set([...activeSocketUsers.entries()]
                    .filter(([socketId]) => !invisibleSocketIds.has(socketId))
                    .map(([, userId]) => String(userId)));
                const apartments = socket.data.isAdmin
                    ? apartmentRows
                    : apartmentRows.filter((apartment) => visibleOnlineOwners.has(apartment.owner_id));
                for (const apartment of apartments) {
                    const id = `apartment:${apartment.id}`;
                    const roomPlayers = await redis.hGetAll(roomKeys(id).players);
                    const presentCount = Object.keys(roomPlayers)
                        .filter((playerId) => !invisibleSocketIds.has(playerId)).length;
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
                const [roomIds, { rows: apartments }, publicRooms, { rows: sessions }] = await Promise.all([
                    getAllRoomIds(),
                    pool.query('SELECT a.id, a.apartment_number, a.apartment_name, u.username FROM chat_apartments a JOIN chat_users u ON u.id = a.owner_id'),
                    getPublicRooms(),
                    pool.query('SELECT s.socket_id, s.user_id::text AS user_id, s.room_id, u.username FROM chat_online_sessions s JOIN chat_users u ON u.id = s.user_id ORDER BY u.username')
                ]);
                const roomNames = new Map([
                    ...publicRooms.map((room) => [room.id, formatPublicRoomName(room)]),
                    ...apartments.map((apartment) => ['apartment:' + apartment.id, getApartmentRoomName(apartment)])
                ]);
                const hiddenRoomIds = new Set(publicRooms.filter((room) => room.is_hidden).map((room) => room.id));
                const roomBySocketId = new Map(sessions.filter((row) => row.room_id).map((row) => [row.socket_id, row.room_id]));
                const unresolved = new Set(sessions.filter((row) => !row.room_id).map((row) => row.socket_id));
                for (const roomId of roomIds) {
                    if (!unresolved.size) break;
                    const players = await redis.hGetAll(roomKeys(roomId).players);
                    for (const playerId of Object.keys(players)) {
                        if (!unresolved.has(playerId)) continue;
                        roomBySocketId.set(playerId, roomId);
                        unresolved.delete(playerId);
                    }
                }
                const users = sessions
                    .filter((session) => !invisibleSocketIds.has(session.socket_id))
                    .map((session) => {
                    const roomId = roomBySocketId.get(session.socket_id) || null;
                    const isPrivate = Boolean(roomId && hiddenRoomIds.has(roomId) && !socket.data.isAdmin);
                    return {
                        userId: session.user_id,
                        name: session.username,
                        id: session.socket_id,
                        roomId: isPrivate ? null : roomId,
                        roomName: isPrivate ? 'Privat omraade' : roomNames.get(roomId) || 'Ukendt rum',
                        isSelf: session.socket_id === socket.id
                    };
                });
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
                if (!targetPlayerId && activeSocketRooms.get(socket.id) === apartmentRoomId) {
                    socket.emit('apartment-visit-result', { message: `Du er allerede i ${getApartmentRoomName(apartment)}.` });
                    return;
                }
                if (targetPlayerId && activeSocketRooms.get(targetPlayerId) !== apartmentRoomId) {
                    socket.emit('apartment-visit-result', { message: 'Brugeren har skiftet rum. Prøv igen.' });
                    return;
                }
                if (socket.data.isAdmin) {
                    if (socket.data.switchingRoom) return;
                    socket.data.switchingRoom = true;
                    try {
                        if (activeSocketRooms.get(socket.id) === apartmentRoomId) {
                            socket.emit('apartment-visit-result', { message: `Du er allerede i ${getApartmentRoomName(apartment)}.` });
                            return;
                        }
                        const moved = await placeSocketInRoom(socket, apartmentRoomId);
                        socket.emit('apartment-visit-result', {
                            message: moved
                                ? `Du er gået direkte ind i ${getApartmentRoomName(apartment)} som administrator.`
                                : 'Lejligheden er fuld. Prøv igen senere.'
                        });
                    } finally {
                        socket.data.switchingRoom = false;
                    }
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
                    .filter(([socketId, userId]) => !invisibleSocketIds.has(socketId)
                        && String(userId) === String(apartment.owner_id))
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
                        if (!/^[1-9]\d{0,18}$/.test(rawTarget)) {
                            socket.emit('profile-teleport-result', {
                                message: 'Brug /tr [rumnummer] eller /tr [lejlighedsnummer]. Offentlige rum er #1–100; lejligheder starter ved #101.'
                            });
                            return;
                        }
                        if (BigInt(rawTarget) <= 100n) {
                            const { rows: [publicRoom] = [] } = await pool.query(
                                'SELECT id, name FROM chat_public_rooms WHERE room_number = $1', [rawTarget]
                            );
                            if (!publicRoom) {
                                socket.emit('profile-teleport-result', { message: `Offentligt rum #${rawTarget} findes ikke.` });
                                return;
                            }
                            if (activeSocketRooms.get(socket.id) === publicRoom.id) {
                                socket.emit('profile-teleport-result', { message: `Du er allerede i #${rawTarget} ${publicRoom.name}.` });
                                return;
                            }
                            const accessError = publicRoomAccessError(
                                await getPublicRoomPolicy(publicRoom.id), Boolean(socket.data.canManagePublicRooms)
                            );
                            if (accessError) {
                                socket.emit('profile-teleport-result', { message: accessError });
                                return;
                            }
                            socket.data.switchingRoom = true;
                            try {
                                const joined = await placeSocketInRoom(socket, publicRoom.id);
                                socket.emit('profile-teleport-result', {
                                    message: joined
                                        ? `Du er teleporteret til #${rawTarget} ${publicRoom.name}.`
                                        : 'Rummet er fuldt. Teleporteringen mislykkedes.'
                                });
                            } finally {
                                socket.data.switchingRoom = false;
                            }
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
                        } else if (socket.data.isAdmin) {
                            socket.data.switchingRoom = true;
                            try {
                                const joined = await placeSocketInRoom(socket, apartmentRoomId);
                                socket.emit('profile-teleport-result', {
                                    message: joined
                                        ? `Du er gået direkte ind i lejlighed #${rawTarget} som administrator.`
                                        : 'Lejligheden er fuld. Prøv igen senere.'
                                });
                            } finally {
                                socket.data.switchingRoom = false;
                            }
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
                    && !invisibleSocketIds.has(targetId)
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
                        && !invisibleSocketIds.has(onlineSocketId)
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
                    getPlayers(socket.data.roomId || 'common', socket)
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
                const clothing = await getUserClothing(socket.data.user.id);
                await cleanupStalePlayers();
                await replaceSameTabOnlineSession(socket);
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
                    socket.data.mood || 'glad',
                    JSON.stringify(clothing),
                    '0',
                    socket.data.user.avatarType === 'girl' ? 'girl' : 'boy',
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
                    await startOnlineSession(socket.id, socket.data.user.id, socket.data.ipHash, socket.data.tabId, initialRoomId);
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
                const currentPlayers = await getPlayers(initialRoomId, socket, true);
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
                const canEditPublicRoom = Boolean(socket.data.canManagePublicRooms && isPublicChatRoomId(initialRoomId));
                socket.emit('join-success', {
                    players: currentPlayers,
                    mutedUsernames: mutedUsers.map((mutedUser) => mutedUser.username),
                    roomId: initialRoomId,
                    roomName: roomName,
                    ownApartmentId: apartment ? String(apartment.id) : null,
                    ownApartmentNumber: apartment ? Number(apartment.apartment_number) : null,
                    apartmentTiles,
                    canEditApartment,
                    canEditPublicRoom,
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
                // currentPlayers was refreshed from the saved wardrobe above.
                // The original `player` came from before that refresh and could
                // make other clients see an outdated outfit after a room join.
                socket.to(roomChannel(initialRoomId)).emit('newPlayer', currentPlayers[socket.id] || player);
                io.emit('navigator-refresh');
                await broadcastChatOnlineCount();
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
            if (!activeSocketIds.has(socket.id) || !['glad', 'mobset', 'ked', 'blappet', 'boevet'].includes(mood)) return;
            const roomId = activeSocketRooms.get(socket.id);
            if (!roomId) return;
            socket.data.mood = mood;
            try {
                await new Promise((resolve, reject) => {
                    socket.request.session.mood = mood;
                    socket.request.session.save((error) => error ? reject(error) : resolve());
                });
                const keys = roomKeys(roomId);
                const encodedPlayer = await redis.hGet(keys.players, socket.id);
                if (!encodedPlayer) return;
                const player = JSON.parse(encodedPlayer);
                player.mood = mood;
                await redis.hSet(keys.players, socket.id, JSON.stringify(player));
                await emitRoomEventForVisibleSender(roomId, 'playerMoodChanged', { id: socket.id, mood }, socket.id);
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
                const movedPlayerJson = await redis.eval(PLAYER_MOVE_SCRIPT, {
                    keys: [keys.players, keys.cells, keys.tiles],
                    arguments: [socket.id, String(position.col), String(position.row), String(Date.now()), socket.data.isAdmin ? '1' : '0']
                });
                if (!movedPlayerJson) {
                    return;
                }
                const player = publicPlayer(JSON.parse(movedPlayerJson));
                await emitRoomEventForVisibleSender(roomId, 'playerMoved', {
                    id: player.id,
                    col: player.col,
                    row: player.row
                }, player.id);
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
                const targetSocket = io.sockets.sockets.get(targetPlayerId);
                if ((invisibleSocketIds.has(socket.id) && !canSeeInvisibleUser(targetSocket))
                    || (invisibleSocketIds.has(targetPlayerId) && !canSeeInvisibleUser(socket))) {
                    socket.emit('private-whisper-error', { message: 'Hvisk er ikke tilgængelig, mens en deltager er usynlig.' });
                    return;
                }
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

                await emitRoomEventForVisibleSender(socket.data.roomId || 'common', 'playerChatMessage', {
                    id: socket.id,
                    text: cleanText,
                    messageTime,
                    messageId: savedMessage.id,
                    createdAt: savedMessage.created_at
                }, socket.id);

                if (progressionFilterReason) {
                    socket.emit('progression-message-filtered', { reason: progressionFilterReason });
                }

                setTimeout(async () => {
                    try {
                        const expired = await redis.eval(EXPIRE_PLAYER_MESSAGE_SCRIPT, {
                            keys: [keys.players],
                            arguments: [socket.id, String(messageTime)]
                        });
                        if (expired) await emitRoomEventForVisibleSender(socket.data.roomId || 'common', 'playerChatExpired', { id: socket.id, messageTime }, socket.id);
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
            invisibleSocketIds.delete(socket.id);
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
            await broadcastChatOnlineCount();
        });
    });

    let heartbeatRunning = false;
    const heartbeatTimer = setInterval(async () => {
        if (heartbeatRunning || activeSocketIds.size === 0) return;
        heartbeatRunning = true;
        try {
            let removedAnyPlayers = false;
            for (const roomId of await getAllRoomIds()) {
                const roomSocketIds = [...activeSocketIds].filter((id) => activeSocketRooms.get(id) === roomId);
                if (!roomSocketIds.length) continue;
                const missingIds = await redis.eval(HEARTBEAT_SCRIPT, {
                    keys: [roomKeys(roomId).players],
                    arguments: [String(Date.now()), ...roomSocketIds]
                });
                for (const id of missingIds) {
                    if (!activeSocketIds.delete(id)) continue;
                    removedAnyPlayers = true;
                    activeSocketRooms.delete(id);
                    activeSocketUsers.delete(id);
                    invisibleSocketIds.delete(id);
                    io.to(roomChannel(roomId)).emit('playerDisconnected', id);
                    io.emit('navigator-refresh');
                    try { await accountOnlineSession(id, true); }
                    catch (error) { console.error('Could not account for missing chat session:', getSafeErrorCode(error)); }
                    io.in(id).disconnectSockets(true);
                }
            }
            if (removedAnyPlayers) await broadcastChatOnlineCount();
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
    const ipBanCleanupTimer = setInterval(() => {
        pool.query('DELETE FROM chat_ip_bans WHERE expires_at IS NOT NULL AND expires_at <= NOW()')
            .catch((error) => console.error('Could not clean up expired IP bans:', getSafeErrorCode(error)));
    }, 60_000);
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
        clearInterval(ipBanCleanupTimer);
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
