# Rundt om bordet

A real-time 6x6 canvas chat with registered accounts, persistent chat history, and shared presence across Render instances.

## Run locally

Requires Node.js 20 or later, PostgreSQL (for example, Supabase), and Redis-compatible Render Key Value (or another Redis server).

Set these environment variables before starting the server:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; Supabase Session pooler is suitable for the persistent Render server |
| `REDIS_URL` | Redis connection string for Render Key Value |
| `SESSION_SECRET` | A private random value of at least 32 bytes |
| `PORT` | Optional HTTP port; defaults to `3000` |
| `PGSSLMODE` | Set to `require` when PostgreSQL requires TLS, including Supabase |
| `PGSSLROOTCERT` | Optional path to a trusted PostgreSQL root CA certificate |

Generate a session secret locally with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Install dependencies and start the server:

```sh
npm install
npm start
```

The server creates its account, message-history, and session tables automatically. New accounts use unique, case-insensitive usernames and passwords of 8–72 UTF-8 bytes, with a maximum of two accounts created per IP address. The registration IP is stored only as a keyed hash using `SESSION_SECRET`; existing accounts can still sign in. Passwords are stored as bcrypt hashes. The server retains the 500 most recent messages, but does not replay earlier messages or speech bubbles to users when they join; the visible chat log starts fresh on each room entry. Live player presence and occupied grid cells are stored in Redis, which also distributes Socket.IO events between instances.

Users can optionally add a real name, Discord name (up to 64 characters), interests (up to 160 characters), and profile text (up to 500 characters); filled profile fields are public to other users in the room. Right-click an avatar to view that player's profile in the side panel.

Login is bound to the browser tab: refreshing the page keeps the session, but opening the chat in a new tab requires logging in again. The authentication cookie is a browser-session cookie, and a per-tab identifier in `sessionStorage` is checked by both HTTP and WebSocket requests.

## Deploy to Render

Use Supabase PostgreSQL for account, session, and chat-message storage, and Render Key Value for live presence and Socket.IO event sharing. For a persistent Render server, use the Supabase **Session pooler** connection string as `DATABASE_URL`. Set `PGSSLMODE=require` to require TLS. To verify Supabase's database certificate, add its root certificate as a Render Secret File named `supabase-root.crt` and set `PGSSLROOTCERT=/etc/secrets/supabase-root.crt`. Create the Supabase project in a region close to the Render service where possible.

Add the Supabase connection string to the Render web service as `DATABASE_URL`, and the Render Key Value connection string as `REDIS_URL`. Also set `PGSSLMODE=require`, `PGSSLROOTCERT=/etc/secrets/supabase-root.crt`, `NODE_ENV=production`, and a newly generated `SESSION_SECRET` using the command above. Keep connection strings and secrets in Render's settings; never commit or paste them into chat. Choose plans that fit the project's cost and data-retention needs.

Deploy the web service from the repository root with:

- **Build command:** `npm install`
- **Start command:** `npm start`

Set `NODE_ENV=production` in the Render web service so session cookies are sent securely over HTTPS. Render automatically provides `PORT`.

## Tests

```sh
npm test
```
