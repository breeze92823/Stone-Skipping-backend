# Stone Skipping Server

Colyseus multiplayer server for [Stone-Skipping](../Stone-Skipping), structured
after `Age-every-click-backend` — same stack (`colyseus` + `@colyseus/schema` +
Mongo persistence + Bloxity Legion deploy), adapted to Stone Skipping's game
state: Skill, Rebirths, Wins, best skip streak, and owned/equipped stones.

## Usage

```
npm install
npm start
```

Then open http://localhost:2567 for the playground, or /monitor for the monitor.

## Structure

- `src/index.ts`: entry point (connects Mongo, then listens)
- `src/app.config.ts`: rooms, `/health`, CORS, dev-only monitor/playground
- `src/rooms/LobbyRoom.ts`: the single global room every client joins (`client.joinOrCreate("lobby")`)
- `src/rooms/schema/LobbyState.ts`: state synchronized to every client
- `src/db.ts`: Mongo-backed progress persistence (no-op if `MONGODB_URI` is unset/unreachable)
- `src/constants.ts`: leaderboard timing, value caps, known stone ids
- `test/LobbyRoom.test.ts`: boots the real server against a fake Mongo collection

## Scripts

- `npm start`: watch mode (`tsx watch src/index.ts`)
- `npm test`: mocha suite
- `npm run build`: compile to `build/`
- `npm run loadtest`: N simulated clients

## Wire protocol

Field names match the client's `src/store/useGameStore.js`.

Join with `client.joinOrCreate("lobby", { username, avatar, userId })`.
`userId` is the stable Bloxity user id — omit it for a guest, whose progress
isn't persisted.

### Client → server

| Message | Payload | Cadence |
|---|---|---|
| `move` | `{ x, y, z, yaw, moveBlend }` | throttled |
| `setAvatar` | `{ avatar }` (opaque JSON string, ≤4 KB) | on connect + on change |
| `stats` | `{ skill, wins, rebirths, bestSkips, equippedStone }` (all optional) | debounced on change |
| `saveProgress` | `{ skill, rebirths, wins, bestSkips, ownedStones, equippedStone }` | debounced; no-op for a guest |
| `identify` | `{ username, userId }` | when sign-in state changes after join |

Stone ids are the `model` names in the client's `SKILL_STONES`
(`pebble, scallop, shell, starfish, wood, arrowhead, disc, ring, obsidian,
coral`). Unknown ids are dropped and `pebble` is always owned.

### Server → client

| Message | Payload | When |
|---|---|---|
| `progress` | saved doc: `{ skill, level, playTime, rebirths, wins, bestSkips, ownedStones, equippedStone }` | after a signed-in join/identify, if a saved doc exists |
| `leaderboard` | `{ level, playTime, skill, wins }`, each `Row[]` with `Row = { id, name, value }` | every 15s and on roster changes; live roster merged with all-time Mongo top scorers |

Four separate boards: **level** (derived on the server from `skill` using the
client's level table in `src/progression.ts`; ties break on skill),
**playTime** (total seconds connected, **measured by the server clock** and
`$inc`'d to Mongo every 30s and on leave — never client-reported, so
`saveProgress` can't forge it), **skill** and **wins**. Time spent while
disconnected/reconnecting isn't counted, and guest time before signing in
isn't either.

`LobbyState.players` (keyed by `sessionId`) carries `username`, `x/y/z/yaw`,
`moveBlend`, `avatar`, `equippedStone`, `skill`, `level`, `playTime`, `wins`,
`rebirths`, `bestSkips` for every connected player.

The server trusts the client for gameplay values (as the client is
authoritative locally); it only enforces shape and bounds so a bad payload
can't corrupt the sender's own save.

## Environment

- `MONGODB_URI` — injected by Bloxity Legion; unset locally (persistence off).
- `CLIENT_ORIGIN` — injected when deployed; CORS falls back to `*` locally.
- `PORT` — injected by Legion; falls back to 2567.

## Deploy

`.github/workflows/deploy.yml` builds a Docker image, pushes it to GHCR and
calls the Bloxity Legion deploy API on every push to `dev` (→ `dev`) or `main`
(→ `prod`). Needs repo **variable** `BLOXITY_GAME_ID` and **secret**
`LEGION_DEPLOY_TOKEN`.
