const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const AVATAR_RADIUS = 16;
const GRID_SIZE = 48;
const PLAY_AREA_WIDTH = 288; // 6 * 48 for et præcist 6x6 gitter
const PLAY_AREA_HEIGHT = 288;
const players = {};

function snapToDiagonalGrid(x, y) {
    let cx = PLAY_AREA_WIDTH / 2;
    let cy = PLAY_AREA_HEIGHT / 2;
    let dx = x - cx;
    let dy = y - cy;
    let angle = -Math.PI / 4;
    let cos = Math.cos(angle);
    let sin = Math.sin(angle);
    let rx = dx * cos - dy * sin;
    let ry = dx * sin + dy * cos;
    
    let snappedRx = Math.floor(rx / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2;
    let snappedRy = Math.floor(ry / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2;
    
    let backAngle = Math.PI / 4;
    let bCos = Math.cos(backAngle);
    let bSin = Math.sin(backAngle);
    let finalDx = snappedRx * bCos - snappedRy * bSin;
    let finalDy = snappedRx * bSin + snappedRy * bCos;
    return {
        x: Math.round(cx + finalDx),
        y: Math.round(cy + finalDy)
    };
}

function getValidPosition(socketId, targetX, targetY) {
    const snapped = snapToDiagonalGrid(targetX, targetY);
    let x = Math.max(AVATAR_RADIUS, Math.min(PLAY_AREA_WIDTH - AVATAR_RADIUS, snapped.x));
    let y = Math.max(AVATAR_RADIUS, Math.min(PLAY_AREA_HEIGHT - AVATAR_RADIUS, snapped.y));

    for (const id in players) {
        if (id === socketId) continue;
        const other = players[id];
        const dx = x - other.x;
        const dy = y - other.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = AVATAR_RADIUS * 2;

        if (distance < minDistance) {
            if (distance === 0) {
                x += minDistance;
            } else {
                const overlap = minDistance - distance;
                x += (dx / distance) * overlap;
                y += (dy / distance) * overlap;
            }
        }
    }
    return { x: Math.round(x), y: Math.round(y) };
}

io.on('connection', (socket) => {
    console.log('Ny forbindelse:', socket.id);

    socket.on('join', (username) => {
        if (typeof username !== 'string') return;
        const cleanName = username.trim().slice(0, 15);
        if (!cleanName) {
            socket.emit('error-msg', 'Indtast et gyldigt brugernavn.');
            return;
        }
        let startX = 144;
        let startY = 144;
        const validStart = getValidPosition(socket.id, startX, startY);

        players[socket.id] = {
            id: socket.id,
            x: validStart.x,
            y: validStart.y,
            name: cleanName,
            text: '',
            messageTime: null
        };

        socket.emit('join-success', players);
        socket.broadcast.emit('newPlayer', players[socket.id]);
    });

    socket.on('move', (pos) => {
        if (players[socket.id] && pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
            const validPos = getValidPosition(socket.id, pos.x, pos.y);
            players[socket.id].x = validPos.x;
            players[socket.id].y = validPos.y;
            io.emit('playerMoved', { id: socket.id, x: validPos.x, y: validPos.y });
        }
    });

    socket.on('chat-message', (text) => {
        if (players[socket.id] && typeof text === 'string' && text.trim().length > 0) {
            let cleanText = text.trim().slice(0, 100);
            players[socket.id].text = cleanText;
            players[socket.id].messageTime = Date.now();

            io.emit('playerChatMessage', {
                id: socket.id,
                text: cleanText,
                messageTime: players[socket.id].messageTime
            });
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            delete players[socket.id];
            io.emit('playerDisconnected', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server kører på port ${PORT}`);
});
