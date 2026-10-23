const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// --- SUPABASE OPSÆTNING ---
// Indsæt din Project URL og din Secret Key herunder:
const SUPABASE_URL = 'https://pgkitxhtgbmqxzgpgqqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'INDSET_DIN_SECRET_KEY_HER'; 

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

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

  return { x: Math.round(x), y: Math.round(y) };
}

io.on('connection', (socket) => {
  console.log('Ny forbindelse:', socket.id);

  // REGISTRERING & E-MAIL VIA SUPABASE
  socket.on('request-code', async ({ username, email, birthdate, password }) => {
    if (!username || !email || !birthdate || !password) {
      socket.emit('error-msg', 'Udfyld venligst alle felter (inkl. kodeord).');
      return;
    }

    const cleanName = username.trim().slice(0, 15);
    const cleanEmail = email.trim().toLowerCase();

    // Tjek alder (mindst 13 år)
    const dob = new Date(birthdate);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }

    if (age < 13) {
      socket.emit('error-msg', 'Du skal være mindst 13 år for at deltage.');
      return;
    }

    try {
      // Opret bruger i Supabase Auth. Supabase sender automatisk en bekræftelses-mail til modtageren!
      const { data, error } = await supabase.auth.admin.createUser({
        email: cleanEmail,
        password: password.trim(),
        email_confirm: false, // Kræver at brugeren klikker på linket i mailen
        user_metadata: { username: cleanName }
      });

      if (error) {
        socket.emit('error-msg', error.message);
        return;
      }

      socket.emit('code-sent', 'Konto oprettet! Tjek din indbakke (og spam-mappe) for at aktivere din e-mail.');
    } catch (err) {
      console.error('Fejl ved oprettelse:', err.message);
      socket.emit('error-msg', 'Der opstod en fejl. Prøv igen.');
    }
  });

  // LOGIN
  socket.on('login', async ({ username, password }) => {
    const cleanName = username ? username.trim() : '';
    const cleanPass = password ? password.trim() : '';

    if (!cleanName || !cleanPass) {
      socket.emit('error-msg', 'Udfyld venligst brugernavn og kodeord.');
      return;
    }

    try {
      // Find brugerens e-mail via deres brugernavn i Supabase metadata
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) {
        socket.emit('error-msg', 'Fejl ved login. Prøv igen.');
        return;
      }

      const foundUser = users.find(u => u.user_metadata && u.user_metadata.username === cleanName);
      if (!foundUser) {
        socket.emit('error-msg', 'Forkert brugernavn eller kodeord.');
        return;
      }

      // Tjek om e-mailen er blevet bekræftet via linket
      if (!foundUser.email_confirmed_at) {
        socket.emit('error-msg', 'Du skal bekræfte din e-mail via linket i din indbakke, før du kan logge ind.');
        return;
      }

      // Valider kodeordet ved at logge ind i Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email: foundUser.email,
        password: cleanPass
      });

      if (authError) {
        socket.emit('error-msg', 'Forkert brugernavn eller kodeord.');
        return;
      }

      // Startspiller-position
      let startX = Math.floor(Math.random() * 300) + 50;
      let startY = Math.floor(Math.random() * 200) + 100;
      const validStart = getValidPosition(socket.id, startX, startY);

      players[socket.id] = {
        id: socket.id,
        x: validStart.x,
        y: validStart.y,
        name: cleanName,
        text: '',
        typingText: ''
      };

      socket.emit('login-success', players);
      socket.broadcast.emit('newPlayer', players[socket.id]);
    } catch (err) {
      console.error('Login fejl:', err.message);
      socket.emit('error-msg', 'Der opstod en systemfejl ved login.');
    }
  });

  // SPILLER BEVÆGELSE
  socket.on('move', (pos) => {
    if (players[socket.id]) {
      const validPos = getValidPosition(socket.id, pos.x, pos.y);
      players[socket.id].x = validPos.x;
      players[socket.id].y = validPos.y;
      io.emit('playerMoved', { id: socket.id, x: validPos.x, y: validPos.y });
    }
  });

  // CHAT / SKRIVER
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

  // AFBRUDT FORBINDELSE
  socket.on('disconnect', () => {
    console.log('Spiller afbrudt:', socket.id);
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
