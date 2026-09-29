import { MongoClient, type Collection } from "mongodb";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated
// database with scoped credentials, no provisioning. A local `npm start`
// normally has no Mongo reachable at all, so a missing/unreachable URI must
// degrade this to "no persistence" rather than crash the room -- same stance
// every external dependency in the client takes (systems/bloxity.js).
export interface PlayerDoc {
  _id: string; // Bloxity user id (SDK.auth.getUser()._id) -- see LobbyRoom.ts
  // Display name as of the last save, so an offline leaderboard row still has
  // something to show. Older docs may lack it; readers fall back to "Player".
  username?: string;
  // The durable fields client store/useGameStore.js tracks, mirrored 1:1.
  skill: number; // raw earned total (the client's "Age" equivalent)
  rebirths: number;
  // Derived server-side from `skill` (progression.ts) whenever skill is saved,
  // so the Level leaderboard is indexable. Older docs may lack it.
  level?: number;
  // Total seconds this account has spent connected, measured by the SERVER
  // clock (LobbyRoom.ts flushPlaytime) -- never client-reported, so it can't
  // be forged via saveProgress. Older docs may lack it.
  playTime?: number;
  wins: number;
  bestSkips: number;
  ownedStones: string[];
  equippedStone: string;
  // Client onboarding progress (constants.ts TUTORIAL_*): 0..TUTORIAL_DONE_STEP.
  // Older docs simply lack it -- LobbyRoom.ts's resolveTutorialStep() reads
  // that as "finished", since onboarding had nowhere durable to resume from
  // before this field existed.
  tutorialStep?: number;
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this
    // game+channel's own isolated database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");

    // refreshLeaderboard() sorts by each of these; createIndex is idempotent.
    // A failure only means those queries stay unindexed, never blocks startup.
    try {
      await players.createIndex({ level: -1, skill: -1 });
      await players.createIndex({ playTime: -1 });
      await players.createIndex({ skill: -1 });
      await players.createIndex({ wins: -1 });
      await players.createIndex({ rebirths: -1 });
      await players.createIndex({ bestSkips: -1 });
    } catch (err) {
      console.warn("[db] failed to create leaderboard indexes:", err);
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as
// "skip persistence for this request", never throw.
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: lets tests exercise the leaderboard/save logic against an
// in-memory fake collection instead of a real MongoDB.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
