# Glass Mahjong

Online Washizu-style riichi mahjong, two against two, for exactly four human players. No bots.

Three of the four copies of every tile are glass and visible to the whole table,
wherever they are. The fourth copy is solid and shows only its back in a hand.
Tiles are drawn at random from a bag. Everything else is standard riichi mahjong.

This version runs on Vercel. It also still runs on your own machine with one command.

## Deploy to Vercel

1. Put this folder in a Git repository and import it at vercel.com/new, or run `vercel` in it.
   Leave the build command and output directory empty. Vercel finds `server.mjs` at the
   project root (named in `package.json` as `main`) and runs it as the backend.
2. In the project, open **Storage**, create a **Redis** database from the Marketplace and
   connect it to the project.
3. Open **Settings → Environment Variables** and check that `REDIS_URL` (or `KV_URL`) exists
   and starts with `redis://` or `rediss://`. Some Redis integrations only add REST
   variables (`KV_REST_API_URL`, `KV_REST_API_TOKEN`); those are not enough. In that case
   copy the database's TCP connection string from its console and add it yourself as `REDIS_URL`.
4. Redeploy so the function picks the variable up.

Nothing else needs configuring. Fluid compute must be on, which is the default for
projects created since April 2025.

If the database is missing, the login form says so instead of failing silently.

### What Vercel changes about how the game runs

- **Connections are cut every five minutes.** A WebSocket closes when the function reaches
  its maximum duration (300 seconds by default). The browser reconnects within a fraction
  of a second and anything clicked in the gap is sent once it is back. Players do not
  see this. On Pro you can raise the limit under Settings → Functions.
- **Any instance can serve any player.** Nothing important is kept in memory. Each action
  loads the table from Redis, applies the move under a lock, saves it, and publishes the
  result; every instance forwards it to the sockets it holds.
- **Turn clocks need someone at the table.** The instances holding the players' sockets
  watch the deadline. If all four players are gone, the clock stops and resumes when the
  first one returns. A table nobody has been connected to for 15 minutes is deleted.
- **A dropped player is not rushed straight away.** A player counts as present until
  their check-ins have stopped for 30 seconds, so the five-minute reconnect never costs
  anyone a turn. After that they are played on a short clock until they return.

### Redis usage

An East-only game used about 3,400 Redis commands in testing, plus roughly 25 a minute
per table for check-ins. Check that against the limits of the database plan you choose.

## Run it on your own machine

    npm install
    npm start            # http://localhost:3000

Without `REDIS_URL` everything is kept in memory and is lost when you stop the server.
To keep accounts between runs, or to try the multi-instance behaviour, start a Redis
server and run `REDIS_URL=redis://localhost:6379 npm start`.

To play alone for testing, open the page in four separate browser profiles (or a mix of
normal and private windows in two browsers) and make one account in each.

## What is in the box

| Path | What it does |
| --- | --- |
| `server.mjs` | Vercel entry point: exports the server for the platform to drive |
| `dev.js` | Local entry point: the same server, listening on a port |
| `lib/app.js` | HTTP API, accounts and sessions, lobby, tables, chat, WebSocket handling |
| `lib/store.js` | Shared state: Redis when `REDIS_URL` is set, in-memory otherwise |
| `lib/game.js` | Game state machine: dealing, turns, calls, riichi, furiten, round flow, deadlines |
| `lib/mahjong.js` | Hand shapes, waits, yaku, fu and point calculation |
| `public/` | The browser client (plain HTML, CSS and JavaScript, no build step) |
| `test/` | Scoring tests, a full-game simulation, an entry-point check, and an end-to-end test |

`npm test` runs everything against the in-memory store. With a Redis server running,
`REDIS_URL=redis://localhost:6379 npm run test:redis` plays a full game across two server
instances that share only that Redis, including a player switching instance mid-game.

## Teams

- A table has two teams of two. In the waiting room each player picks a side by
  taking an open seat under Team 1 or Team 2.
- Partners sit opposite each other. Which pair gets the first deal, and the order
  within each pair, is drawn at random.
- Every player scores as in ordinary riichi mahjong, starting on 25,000. A team's
  total is the sum of its two players, and the higher total wins. Equal totals are a drawn game.
- Partners cannot see each other's solid tiles. Winning off your partner's discard
  is allowed, which moves points inside the team and ends the hand.
- A win moves rating from the losing pair to the winning pair, more for a bigger margin.
- After a game, "Play again" keeps the teams and "Change teams" returns everyone to seating.

## How hidden information is kept hidden

The server holds every tile. Each player is sent only their own view: their full
hand, the glass tiles in the other three hands, and a count of the solid ones. That
includes their partner's hand. The bag, the ura dora and other players' solid tiles
never reach a browser until the rules reveal them. Every action is validated on the server.

## Accounts

- Passwords are hashed with scrypt and a per-user salt.
- Sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie, valid for 30 days.
  The cookie is marked `Secure` on Vercel, or anywhere you set `SECURE_COOKIE=1`.
- WebSocket connections require a valid session and a same-origin page.
- Login attempts are limited to 30 per address every ten minutes.
- An account can be connected in one place at a time; opening it elsewhere closes the older one.

## Configuration

| Variable | Meaning |
| --- | --- |
| `REDIS_URL` or `KV_URL` | Redis connection string. Required on Vercel, optional locally |
| `PORT` | Local only. Port to listen on, default 3000 |
| `SECURE_COOKIE` | Local only. Set to `1` when serving over HTTPS |

All keys in Redis start with `gm:`, so the database can be shared with other apps.

## Rules implemented

- 136 tiles, no red fives. 25,000 starting points. East-only or East plus South games.
- 70 draws per hand from the bag; kan replacement draws count against the 70.
- Chi, pon, open kan, closed kan, added kan (with chankan), riichi, double riichi, ippatsu.
- Dora, kan dora (revealed immediately), ura dora.
- Furiten: discard, temporary and riichi furiten. No swap-calling (kuikae).
- Multiple ron is allowed; repeat counters and riichi sticks go to the winner nearest the discarder.
- All standard yaku and yakuman, open tanyao allowed. Counted yakuman at 13 han.
- Exhaustive draw with tenpai payments. Dealer repeats on a win or when tenpai at a draw.
- The game ends after the last round, when any player drops below zero, or when the
  last dealer wins while their team is ahead.
- When a call is possible, glass tiles are used for the meld first, so your solid tiles stay in hand.

Not implemented: abortive draws, nagashi mangan, liability payments (pao),
robbing a closed kan for thirteen orphans, and the West-round extension.
