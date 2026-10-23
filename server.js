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
const PLAY_AREA_WIDTH = 408;
const PLAY_AREA_HEIGHT = 374;
const players = {};

function getValidPosition(socketId, targetX, targetY) {
  let x = Math.max(AVATAR_RADIUS, Math.min(PLAY_AREA_WIDTH - AVATAR_RADIUS, targetX));
  let y = Math.max(AVATAR_RADIUS, Math.min(PLAY_AREA_HEIGHT - AVATAR_RADIUS, targetY));

  // Kollisionslogik: Forhindrer at spillere kan stå oven på hinanden
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
    const cleanName = typeof username === 'string' ? username.trim().slice(0, 15) : 'Anonym';
    if (!cleanName) {
      socket.emit('error-msg', 'Indtast et gyldigt brugernavn.');
      return;
    }

    let startX = Math.floor(Math.random() * 200) + 100;
    let startY = Math.floor(Math.random() * 150) + 100;
    const validStart = getValidPosition(socket.id, startX, startY);

    players[socket.id] = {
      id: socket.id,
      x: validStart.x,
      y: validStart.y,
      name: cleanName,
      text: '',
      typingText: '',
      messageTime: null
    };

    socket.emit('join-success', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  // Server-side validering mod teleportation / snyd
  socket.on('move', (pos) => {
    if (players[socket.id] && pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      let p = players[socket.id];
      let dx = pos.x - p.x;
      let dy = pos.y - p.y;
      let distance = Math.sqrt(dx * dx + dy * dy);
      const maxAllowedStep = 80; // Tilladt maks skridtlængde

      if (distance <= maxAllowedStep) {
        const validPos = getValidPosition(socket.id, pos.x, pos.y);
        players[socket.id].x = validPos.x;
        players[socket.id].y = validPos.y;
        io.emit('playerMoved', { id: socket.id, x: validPos.x, y: validPos.y });
      }
    }
  });

  // Server-side validering af chat og tekst
  socket.on('typing', (data) => {
    if (players[socket.id] && data) {
      let cleanTyping = typeof data.typingText === 'string' ? data.typingText.slice(0, 100) : '';
      let cleanText = typeof data.text === 'string' ? data.text.slice(0, 100) : '';

      players[socket.id].typingText = cleanTyping;
      players[socket.id].text = cleanText;
      
      if (cleanText) {
        players[socket.id].messageTime = Date.now();
      } else if (!cleanTyping) {
        players[socket.id].messageTime = null;
      }

      io.emit('playerTyping', { 
        id: socket.id, 
        typingText: cleanTyping, 
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
