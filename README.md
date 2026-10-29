# Rundt om bordet

A real-time 2D chat with shared rooms, apartments, profiles, progression, and avatar clothing.

## Run locally

Requires Node.js 20 or later, PostgreSQL, and Redis.

Configure these environment variables before starting the server:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string for live presence and cross-instance events |
| `SESSION_SECRET` | Private random value used to sign sessions and protect stored IP hashes |
| `ADMIN_USERNAMES` | Optional comma-separated list of full admin usernames |
| `LIMITED_ADMIN_USERNAMES` | Optional comma-separated list of admins for public rooms and clothing |
| `PORT` | Optional HTTP port; defaults to `3000` |
| `PGSSLMODE` | Set to `require` when PostgreSQL requires TLS |
| `PGSSLROOTCERT` | Optional path to a trusted PostgreSQL root certificate |

The full admin role takes precedence if a username is listed in both admin variables. Admin access is checked on the server for authenticated connections; hiding the admin button in the browser is not the access control.

Generate a session secret locally:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Install dependencies and start the server:

```sh
npm install
npm start
```

The server initializes and migrates its PostgreSQL tables at startup. Redis stores live player positions and presence. PostgreSQL stores accounts, profiles, room configuration, messages, clothing, and other persistent data. Keep database credentials and secrets in your hosting provider's environment settings; do not commit them.

## Main features

- Public rooms and owner-managed apartments, with navigation and room teleport commands.
- Real-time movement, chat, whispering, profiles, online user lists, and level progression.
- Apartment and public-room editing, including floor colors, locked tiles, doors, backgrounds, and room welcome text.
- Avatar moods and clothing overlays, with a wardrobe for users and management tools for admins.
- Admin controls for users, bans, rooms, and clothing.

Room edits are drafted in the editor and take effect after saving. Admin permissions and sensitive operations are validated by the server.

## Deploy to Render

Use PostgreSQL (Supabase is supported) for persistent data and Render Key Value or another Redis service for live presence and cross-instance Socket.IO events. For a persistent Render server, use a PostgreSQL connection string suitable for long-running services. Set `PGSSLMODE=require` if the database requires TLS; configure `PGSSLROOTCERT` only when you have installed a trusted CA certificate as a Render Secret File.

Build command:

```sh
npm install
```

Start command:

```sh
npm start
```

Render provides the `PORT` environment variable. The server exposes `/health` for health checks. An external monitor can check that endpoint, but monitoring does not prevent every restart or guarantee uptime on a free hosting plan.

## Tests

Run the automated tests with:

```sh
npm test
```
