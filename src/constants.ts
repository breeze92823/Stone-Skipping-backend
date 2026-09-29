// LobbyRoom.ts's refreshLeaderboard(): how often it re-queries Mongo for the
// all-time top players per stat, and how many rows it fetches per stat before
// merging with the live online roster.
export const LEADERBOARD_REFRESH_MS = 15_000;
export const LEADERBOARD_QUERY_LIMIT = 20;

// Playtime: how often each connected player's elapsed time is added to their
// total (in memory for everyone, $inc'd to Mongo for signed-in players).
export const PLAYTIME_FLUSH_MS = 30_000;

// Client data/progression.js's SKILL_MAX / REBIRTH_MAX. Saved values are
// clamped to these so a forged payload can't push a bogus number onto the
// leaderboards.
export const SKILL_MAX = 1_000_000_000_000;
export const REBIRTH_MAX = 5000;

// Stone ids the client's data/world.js SKILL_STONES ships (its `model` field),
// kept in sync by comment cross-reference, not a shared import. The first is
// the free starter stone every player owns.
export const STONE_IDS = [
  "pebble",
  "scallop",
  "shell",
  "starfish",
  "wood",
  "arrowhead",
  "disc",
  "ring",
  "obsidian",
  "coral",
] as const;
export const DEFAULT_STONE = STONE_IDS[0];
