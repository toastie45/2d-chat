const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Gemmer alle tilsluttede spillere: { socketId: { id, x, y, name, text, typingText, bubbleTimer } }
const players = {};

io.on('connection', (socket) => {
  console.log('Ny spiller tilsluttet:', socket.id);

  // Opret ny spiller på tilfældig startposition
  players[socket.id] = {
    id: socket.id,
    x: Math.floor(Math.random() * 300) + 50,
    y: Math.floor(Math.random() * 200) + 100,
    name: 'Spiller ' + socket.id.slice(0, 4),
    text: '',
    typingText: '',
    bubbleTimer: null
  };

  // Send nuværende spillere til den nye spiller
  socket.emit('currentPlayers', players);

  // Informer andre om den nye spiller
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Håndter flytning (klik)
  socket.on('move', (pos) => {
    if (players[socket.id]) {
      players[socket.id].x = pos.x;
      players[socket.id].y = pos.y;
      io.emit('playerMoved', { id: socket.id, x: pos.x, y: pos.y });
    }
  });

  // Håndter live-skrivning i taleboblen
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

  // Når en spiller lukker fanen
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
