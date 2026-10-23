const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const GRID_COUNT = 6;
const MESSAGE_DURATION = 10_000;
const MAX_MESSAGE_LENGTH = 100;
const players = {};

function getOpenCell() {
    const cells = [];
    for (let row = 0; row < GRID_COUNT; row++) {
        for (let col = 0; col < GRID_COUNT; col++) {
            cells.push({ col, row });
        }
    }

    cells.sort((first, second) => {
        const firstDistance = Math.abs(first.col - 2.5) + Math.abs(first.row - 2.5);
        const secondDistance = Math.abs(second.col - 2.5) + Math.abs(second.row - 2.5);
        return firstDistance - secondDistance;
    });

    return cells.find((cell) =>
        !Object.values(players).some((player) => player.col === cell.col && player.row === cell.row)
    );
}

function isGridCoordinate(value) {
    return Number.isInteger(value) && value >= 0 && value < GRID_COUNT;
}

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        if (players[socket.id]) {
            socket.emit('join-success', players);
            return;
        }

        if (typeof username !== 'string') {
            socket.emit('error-msg', 'Indtast et gyldigt brugernavn.');
            return;
        }

        const cleanName = username.trim().slice(0, 18);
        if (!cleanName) {
            socket.emit('error-msg', 'Indtast et gyldigt brugernavn.');
            return;
        }

        const cell = getOpenCell();
        if (!cell) {
            socket.emit('error-msg', 'Rummet er fyldt. Prøv igen senere.');
            return;
        }

        const player = {
            id: socket.id,
            name: cleanName,
            col: cell.col,
            row: cell.row,
            text: '',
            messageTime: null
        };
        players[socket.id] = player;

        socket.emit('join-success', players);
        socket.broadcast.emit('newPlayer', player);
    });

    socket.on('move', (position) => {
        const player = players[socket.id];
        if (!player || !position || typeof position !== 'object') return;
        if (!isGridCoordinate(position.col) || !isGridCoordinate(position.row)) return;

        player.col = position.col;
        player.row = position.row;
        io.emit('playerMoved', { id: socket.id, col: player.col, row: player.row });
    });

    socket.on('chat-message', (text) => {
        const player = players[socket.id];
        if (!player || typeof text !== 'string') return;

        const cleanText = text.trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!cleanText) return;

        const messageTime = Math.max(Date.now(), (player.messageTime || 0) + 1);
        player.text = cleanText;
        player.messageTime = messageTime;
        io.emit('playerChatMessage', {
            id: socket.id,
            text: cleanText,
            messageTime
        });

        setTimeout(() => {
            const currentPlayer = players[socket.id];
            if (!currentPlayer || currentPlayer.messageTime !== messageTime) return;

            currentPlayer.text = '';
            currentPlayer.messageTime = null;
            io.emit('playerChatExpired', { id: socket.id, messageTime });
        }, MESSAGE_DURATION);
    });

    socket.on('disconnect', () => {
        if (!players[socket.id]) return;
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server kører på port ${PORT}`);
});
