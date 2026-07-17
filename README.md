# Couple Games

Real-time games for couples, playable from any two phones. One partner creates a room and shares a 4-letter code; the other joins, and everything syncs live over WebSockets.

## Games

- **Would You Rather** — 10 rounds of secret answers with a simultaneous reveal and a match score.
- **This or That** — 15 rapid-fire picks, ending in a compatibility percentage.
- **Who Knows Me Better?** — newlywed-game style: one partner answers about themselves, the other guesses. Alternates each round; final score shows who knows who better.

## Running locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in two browser tabs (or two phones on the same Wi-Fi via `http://<your-ip>:3000`).

## Tech

- Node.js + Express + Socket.IO backend — rooms and all game state live on the server, so answers stay secret until both players lock in.
- Vanilla JavaScript frontend, no build step.
- Respects the `PORT` environment variable, so it deploys as-is to Render, Railway, Fly.io, etc. (start command: `npm start`).

## Adding questions

All question banks live in [questions.js](questions.js) — add entries to `WYR`, `TOT`, or `WKM` and restart the server.
