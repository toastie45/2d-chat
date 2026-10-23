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
| `PGSSLMODE` | Set to `require` when the PostgreSQL provider requires TLS, including Supabase |

Generate a session secret locally with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Install dependencies and start the server:

```sh
npm install
npm start
```

The server creates its account, message-history, and session tables automatically. New accounts use unique, case-insensitive usernames and passwords of 8–72 UTF-8 bytes. Passwords are stored as bcrypt hashes. The shared chat history retains the 500 most recent messages. Live player presence and occupied grid cells are stored in Redis, which also distributes Socket.IO events between instances.

## Deploy to Render

Use Supabase PostgreSQL for account, session, and chat-message storage, and Render Key Value for live presence and Socket.IO event sharing. For a persistent Render server, use the Supabase **Session pooler** connection string as `DATABASE_URL`. Set `PGSSLMODE=require` to enable verified TLS connections. Create the Supabase project in a region close to the Render service where possible.

Add the Supabase connection string to the Render web service as `DATABASE_URL`, and the Render Key Value connection string as `REDIS_URL`. Also set `PGSSLMODE=require`, `NODE_ENV=production`, and a newly generated `SESSION_SECRET` using the command above. Keep these values in Render's environment settings; never commit or paste them into chat. Choose plans that fit the project's cost and data-retention needs.

Deploy the web service from the repository root with:

- **Build command:** `npm install`
- **Start command:** `npm start`

Set `NODE_ENV=production` in the Render web service so session cookies are sent securely over HTTPS. Render automatically provides `PORT`.

## Tests

```sh
npm test
```
