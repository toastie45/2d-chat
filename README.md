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

Users can optionally add a real name, Discord name (up to 64 characters), interests (up to 160 characters), and profile text (up to 500 characters); filled profile fields are public to other signed-in users. Right-click an avatar to view that player's profile in the side panel. The search icon in the bottom toolbar opens a search field. With an empty field it lists the users currently in the room; typing searches all registered accounts by name (online and offline, up to 20 results). Selecting a result opens that user's profile, also when they are offline. Profiles also show the account creation date and total accumulated time spent in the room across sessions. Accumulation starts when this feature is deployed; time from before deployment cannot be reconstructed.

Profiles include private friend/enemy lists and a guestbook. The top-bar friend menu shows the user's friends. Right-clicking any other avatar lets the user mute or unmute that player, independently of the friend/enemy lists. Muted players' chat messages and speech bubbles are hidden only for the current user, while their avatars remain visible with a red cross. Profile settings let users manage both lists, and owners can delete entries directly in their guestbook. Signed-in users can leave a 1–300 character greeting in another user's guestbook (online or offline), with a ten-second cooldown between posts.

Chat messages are highlighted when they contain an online user's name as a whole word. To limit rapid repeated messages, sending more than eight messages within ten seconds removes the user from the room and invalidates their tab session; they must log in again with their password to re-enter. The same applies to users removed after 20 minutes without an accepted move or sent message. Heartbeats only keep the connection's presence alive; they are not user activity and do not reset the inactivity timer. Re-entering starts a new 20-minute inactivity period, so a user who stays idle again is kicked again.

Login is bound to the browser tab: refreshing the page keeps the session, but opening the chat in a new tab requires logging in again. Each tab uses a separate browser-session cookie, selected using its per-tab identifier from `sessionStorage`, for both HTTP and WebSocket requests. This lets separate tabs use different accounts without overwriting each other's login.

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
