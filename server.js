const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'Tomutubee@gmail.com',
    pass: 'aqygvpvdnmefiyag'
  }
});

const AVATAR_RADIUS = 16;
const players = {};
const verificationCodes = {};
const registeredUsers = {}; // Gemmer oprettede brugere: brugernavn -> { password, email }

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
  console.log('Ny forbindelse:', socket.id);

  // 1. Anmod om verifikationskode ved oprettelse
  socket.on('request-code', async ({ username, email, birthdate }) => {
    if (!username || !email || !birthdate) {
      socket.emit('error-msg', 'Udfyld venligst alle felter.');
      return;
    }

    const cleanName = username.trim().slice(0, 15);

    // Tjek om brugernavnet allerede findes
    if (registeredUsers[cleanName]) {
      socket.emit('error-msg', 'Brugernavnet er allerede optaget. Vælg et andet eller log ind.');
      return;
    }

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

    const cleanEmail = email.trim().toLowerCase();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    verificationCodes[socket.id] = { code, username: cleanName, email: cleanEmail };

    const mailOptions = {
      from: 'Tomutubee@gmail.com',
      to: cleanEmail,
      subject: 'Din verifikationskode til 2D Chat',
      text: `Hej ${cleanName},\n\nDin verifikationskode til 2D Chat er: ${code}\n\nIndtast koden på skærmen for at fortsætte.`
    };

    try {
      await transporter.sendMail(mailOptions);
      socket.emit('code-sent', 'Verifikationskode er sendt til din e-mail!');
    } catch (err) {
      console.error('Gmail fejl:', err.message);
      console.log(`>>> [FALLBACK KODE TIL ${cleanEmail}]: ${code} <<<`);
      socket.emit('code-sent', 'Kode genereret! (Tjek Render Logs hvis mail blokeres)');
    }
  });

  // 2. Tjek koden
  socket.on('verify-code', (submittedCode) => {
    const record = verificationCodes[socket.id];
    if (!record) {
      socket.emit('error-msg', 'Anmod om en kode først.');
      return;
    }

    if (record.code === submittedCode.trim()) {
      socket.emit('code-verified', 'Koden er godkendt! Opret nu dit kodeord.');
    } else {
      socket.emit('error-msg', 'Forkert verifikationskode. Prøv igen.');
    }
  });

  // 3. Gem kodeord og opret bruger permanent i sessionen
  socket.on('set-password', (password) => {
    const record = verificationCodes[socket.id];
    if (!record) {
      socket.emit('error-msg', 'Session udløbet. Start forfra.');
      return;
    }

    if (!password || password.trim().length < 4) {
      socket.emit('error-msg', 'Kodeordet skal være mindst 4 tegn.');
      return;
    }

    // Gem brugeren i vores "database" (hukommelse)
    registeredUsers[record.username] = {
      password: password.trim(),
      email: record.email
    };

    delete verificationCodes[socket.id];

    let startX = Math.floor(Math.random() * 300) + 50;
    let startY = Math.floor(Math.random() * 200) + 100;
    const validStart = getValidPosition(socket.id, startX, startY);

    players[socket.id] = {
      id: socket.id,
      x: validStart.x,
      y: validStart.y,
      name: record.username,
      text: '',
      typingText: ''
    };

    socket.emit('login-success', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  // 4. Direkte Login for eksisterende brugere
  socket.on('login', ({ username, password }) => {
    const cleanName = username ? username.trim() : '';
    const cleanPass = password ? password.trim() : '';

    if (!cleanName || !cleanPass) {
      socket.emit('error-msg', 'Udfyld venligst brugernavn og kodeord.');
      return;
    }

    const user = registeredUsers[cleanName];
    if (!user || user.password !== cleanPass) {
      socket.emit('error-msg', 'Forkert brugernavn eller kodeord.');
      return;
    }

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
  });

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
    delete verificationCodes[socket.id];
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
