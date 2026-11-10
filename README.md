# Washizu Mahjong (와시즈 마작)

Online riichi mahjong under the special rules Washizu Iwao invented in Nobuyuki
Fukumoto's *Akagi: Yami ni Oritatta Tensai* —
[the story and the rules](https://en.namu.wiki/w/%EC%99%80%EC%8B%9C%EC%A6%88%20%EB%A7%88%EC%9E%91) —
played two against two, for exactly four human players. No bots.

In the story the game sits down to be played by four fixed roles — **Akagi** and
**Yasuoka** against **Washizu** and **Suzuki** — and it is riichi mahjong with two
perversions of the ordinary rules:

**Crystal tiles.** Three of the four copies of every tile are made of transparent
glass, visible to the whole table wherever they are — in your hand, in anyone's pond,
in a meld. The fourth copy is solid and shows only its back in a hand. In the prequel
*Washizu: Enma no Tōpa* the set is ground by Washizu himself from melted glass: the
whole table can be read, and "precisely for that reason the opponent is bound so
tightly that not a single move can be made."

**The hole.** There is no wall to track. The 136 tiles are machine-shuffled into a
hole in the middle of a special table and drawn one at a time, with leather gloves so
nobody can feel the tiles; the dora indicator is drawn from the hole before the deal,
and a hand ends in a draw when all players' discards total 70. Here the hole is
simulated as a bag: every draw is uniformly random.

**The stakes.** In the story Washizu puts up **20 million yen** (100,000 yen per 100
points) and his challengers put up **their own blood** — 2,000cc, the "vampire rules" —
which is why playing safe is not an option: shrinking away means bleeding out through
tenpai payments and the score difference. That part is not implemented here: this
version plays for points only, nobody is "out", and the match is decided by the duel
between the two geniuses, as in the story. The story's match is said to have lasted
21 years; the longest game here is about 4½ hours.

Everything else is standard riichi mahjong.

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

## Roles and teams

- Each seat is a fixed role, in play order: 0 Akagi, 1 Yasuoka, 2 Washizu, 3 Suzuki.
  In the waiting room a player picks their role by taking the seat; Akagi deals first.
- Teams are the adjacent pairs: Akagi & Yasuoka against Washizu & Suzuki.
- Every player scores as in ordinary riichi mahjong, starting on 25,000. A team's
  total is the sum of its two players.
- When the game ends, Akagi & Yasuoka win if Akagi has more points than Washizu;
  otherwise Washizu & Suzuki win. A tie goes to Washizu & Suzuki, so there are no
  drawn games.
- Except in East-only games, the places are settled at the end of every hanchan:
  1st to 4th are paid +30,000, +10,000, −10,000, −30,000 (20,000 apart, zero-sum).
- Nobody is out for going negative.
- Partners cannot see each other's solid tiles. Winning off your partner's discard
  is allowed, which moves points inside the team and ends the hand.
- A win moves rating from the losing pair to the winning pair, more for a bigger margin.
- After a game, "Play again" keeps the roles and "Change roles" returns everyone to seating.

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

- 136 tiles, no red fives. 25,000 starting points. Games can be East-only, East plus South,
  or 2, 4 or 6 hanchan. A hanchan is an East round followed by a South round: there are no
  West or North rounds, so a 2-hanchan game plays East, South, East, South.
- 70 draws per hand from the bag; kan replacement draws count against the 70.
- Chi, pon, open kan, closed kan, added kan (with chankan), riichi, double riichi, ippatsu.
- Dora, kan dora (revealed immediately), ura dora.
- Furiten: discard, temporary and riichi furiten. No swap-calling (kuikae).
- If several players ron the same discard, only the one nearest the discarder in turn
  order wins; the others get nothing. Repeat counters and riichi sticks go to the winner.
- After every discard the table pauses as if callers were deciding: the clock is the full
  turn time, and when no call is possible the pause is a short random moment with everyone
  treated as having passed, so the timing never reveals whether the tile was wanted.
- A call stands as soon as nobody still waiting can outrank it: ron beats pon and kan, which
  beat chi, and at equal priority the seat nearer the discarder in turn order wins, so the
  highest available call is processed at once.
- All standard yaku and yakuman, open tanyao allowed. Counted yakuman at 13 han.
- Exhaustive draw with tenpai payments. Dealer repeats on a win or when tenpai at a draw.
- The game ends after the last hanchan of the chosen length. There is no early end for a
  negative score, and the winner is the Akagi-vs-Washizu comparison, never a draw.
- When a call is possible, glass tiles are used for the meld first, so your solid tiles stay in hand.

Not implemented: abortive draws, nagashi mangan, liability payments (pao), and robbing a
closed kan for thirteen orphans.
