const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const AVATAR_RADIUS = 16;
const players = {};

function getValidPosition(socketId, targetX, targetY) {
  let x = targetX;
  let y = targetY;

  x = Math.max(AVATAR_RADIUS, Math.min(408 - AVATAR_RADIUS, x));
  y = Math.max(AVATAR_RADIUS, Math.min(374 - AVATAR_RADIUS, y));

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

  x = Math.max(AVATAR_RADIUS, Math.min(408 - AVATAR_RADIUS, Math.round(x)));
  y = Math.max(AVATAR_RADIUS, Math.min(374 - AVATAR_RADIUS, Math.round(y)));

  return { x, y };
}

io.on('connection', (socket) => {
  console.log('Ny spiller tilsluttet:', socket.id);

  let startX = Math.floor(Math.random() * 300) + 50;
  let startY = Math.floor(Math.random() * 200) + 100;
  const validStart = getValidPosition(socket.id, startX, startY);

  players[socket.id] = {
    id: socket.id,
    x: validStart.x,
    y: validStart.y,
    name: 'Spiller ' + socket.id.slice(0, 4),
    text: '',
    typingText: ''
  };

  socket.emit('currentPlayers', players);
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('move', (pos) => {
    if (players[socket.id]) {
      const validPos = getValidPosition(socket.id, pos.x, pos.y);
      players[socket.id].x = validPos.x;
      players[socket.id].y = validPos.y;
      io.emit('playerMoved', { id: socket.id, x: validPos.x, y: validPos.y });
    }
  });

  socket.on('typing', (data) => {
    if (players[socket.id]) {
      players[socket.id].typingText = data.typingText;
      players[socket.id].text = data.text;
      io.emit('playerTyping', { 
        id: socket.id, 
        typingText: data.typingText, 
        text: data.text 
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('Spiller afbrudt:', socket.id);
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server kører på port ${PORT}`);
});
