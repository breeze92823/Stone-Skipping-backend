import assert from "assert";
import type { Collection } from "mongodb";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { LobbyState } from "../src/rooms/schema/LobbyState.js";
import { sanitizeProgress, resolveTutorialStep, type LobbyRoom } from "../src/rooms/LobbyRoom.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";

// Hand-rolled fake `players` collection implementing only the subset
// LobbyRoom.ts calls: find().sort().limit().toArray(), updateOne() (upsert),
// findOne(). No MongoDB runs in the test process.
function fakePlayersCollection(seed: PlayerDoc[] = []) {
  const docs = new Map<string, PlayerDoc>(seed.map((d) => [d._id, d]));
  const fake = {
    docs,
    async findOne(filter: { _id: string }) {
      return docs.get(filter._id) ?? null;
    },
    async updateOne(filter: { _id: string }, update: any, options: any) {
      const existing = docs.get(filter._id);
      if (!existing && !options?.upsert) return;
      const base = existing ?? ({ _id: filter._id, ...(update.$setOnInsert ?? {}) } as PlayerDoc);
      docs.set(filter._id, { ...base, ...(update.$set ?? {}) } as PlayerDoc);
    },
    find(_filter: any) {
      let sortField: string | null = null;
      let limitN = Infinity;
      const cursor = {
        sort(spec: Record<string, number>) {
          sortField = Object.keys(spec)[0];
          return cursor;
        },
        limit(n: number) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          let arr = Array.from(docs.values());
          if (sortField) {
            const field = sortField;
            arr = arr.slice().sort((a: any, b: any) => (b[field] ?? 0) - (a[field] ?? 0));
          }
          return arr.slice(0, limitN);
        },
      };
      return cursor;
    },
  };
  return fake as unknown as Collection<PlayerDoc> & { docs: Map<string, PlayerDoc> };
}

function baseDoc(overrides: Partial<PlayerDoc> = {}): PlayerDoc {
  return {
    _id: "test",
    skill: 0,
    rebirths: 0,
    wins: 0,
    bestSkips: 0,
    ownedStones: ["pebble"],
    equippedStone: "pebble",
    version: 1,
    updatedAt: new Date(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LobbyRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  // Tests that swap in a fake collection reset it so the others keep
  // exercising the real "no MONGODB_URI" no-op path.
  afterEach(() => __setPlayersForTest(null));

  it("relays move, avatar and stats between two clients", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room);
    const client2 = await colyseus.connectTo(room);

    client1.send("move", { x: 1, y: 2, z: 3, yaw: 0.5, moveBlend: 0.75 });
    await room.waitForNextPatch();
    const p1 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(p1.x, 1);
    assert.strictEqual(p1.moveBlend, 0.75);

    const avatar = JSON.stringify({ e: { headId: "42" }, p: { height: 1.2 } });
    client1.send("setAvatar", { avatar });
    await room.waitForNextPatch();
    assert.strictEqual(client2.state.players.get(client1.sessionId).avatar, avatar);

    client1.send("stats", { skill: 2480, wins: 30, rebirths: 3, bestSkips: 9, equippedStone: "shell" });
    await room.waitForNextPatch();
    const s = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s.skill, 2480);
    assert.strictEqual(s.wins, 30);
    assert.strictEqual(s.rebirths, 3);
    assert.strictEqual(s.bestSkips, 9);
    assert.strictEqual(s.equippedStone, "shell");

    // Negatives clamp to 0; an unknown stone id is ignored.
    client1.send("stats", { skill: -5, equippedStone: "nonsense" });
    await room.waitForNextPatch();
    const s2 = client2.state.players.get(client1.sessionId);
    assert.strictEqual(s2.skill, 0);
    assert.strictEqual(s2.equippedStone, "shell");
  });

  it("degrades to no-op persistence when Mongo is unreachable", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "bloxity-user-1" });
    client1.send("saveProgress", { skill: 42, rebirths: 1, wins: 7, ownedStones: ["pebble"], equippedStone: "pebble" });
    await room.waitForNextPatch();
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "");
  });

  it("registers/clears the userId mapping via identify, independent of join", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { username: "Guest" });
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);

    client1.send("identify", { username: "RealName", userId: "u1" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(client1.sessionId), "u1");
    assert.strictEqual(client1.state.players.get(client1.sessionId).username, "RealName");

    client1.send("identify", { username: "Guest", userId: "" });
    await room.waitForNextPatch();
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(client1.sessionId), false);
  });

  it("evicts a stale session that already claims the same userId", async () => {
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const first = await colyseus.connectTo(room, { userId: "dup" });
    const second = await colyseus.connectTo(room, { userId: "dup" });
    await sleep(50);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.has(first.sessionId), false);
    assert.strictEqual((room as unknown as LobbyRoom).userIds.get(second.sessionId), "dup");
    assert.strictEqual(room.state.players.has(first.sessionId), false);
  });

  it("saves progress, then sends it back as `progress` on the next sign-in", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Skipper" });

    client1.send("saveProgress", {
      skill: 500,
      rebirths: 2,
      wins: 12,
      bestSkips: 7,
      ownedStones: ["scallop", "shell", "bogus"],
      equippedStone: "shell",
    });
    await sleep(100);

    const saved = fake.docs.get("u1")!;
    assert.strictEqual(saved.skill, 500);
    assert.strictEqual(saved.username, "Skipper");
    // Starter stone is always kept, unknown ids dropped.
    assert.deepStrictEqual(saved.ownedStones.sort(), ["pebble", "scallop", "shell"]);
    assert.strictEqual(saved.equippedStone, "shell");

    // A fresh session for the same account is handed the saved doc.
    // Same account joining again evicts client1 (see the eviction test). The
    // `progress` reply can land before a client-side handler is registered, so
    // capture it on the server side.
    let progress: any = null;
    const r = room as any;
    const origLoad = r.loadProgress.bind(r);
    r.loadProgress = (c: any, ...rest: any[]) => {
      const origSend = c.send.bind(c);
      c.send = (type: string, msg: any) => {
        if (type === "progress") progress = msg;
        origSend(type, msg);
      };
      return origLoad(c, ...rest);
    };
    const client2 = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    assert.ok(progress, "progress message was sent");
    assert.strictEqual(progress.wins, 12);
    assert.strictEqual(progress.equippedStone, "shell");
    assert.ok(progress.ownedStones.includes("scallop"));
    assert.strictEqual(client2.state.players.get(client2.sessionId).wins, 12);
  });

  it("claimed guest saves are ignored", async () => {
    const fake = fakePlayersCollection();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const guest = await colyseus.connectTo(room);
    guest.send("saveProgress", { skill: 999 });
    await sleep(50);
    assert.strictEqual(fake.docs.size, 0);
  });

  it("broadcasts a leaderboard merging online players with saved offline ones", async () => {
    const fake = fakePlayersCollection([
      baseDoc({ _id: "off1", username: "OfflineAce", skill: 9000, level: 40, playTime: 7200, wins: 100 }),
      baseDoc({ _id: "u1", username: "Me", skill: 1 }), // online below -- must not duplicate
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const client1 = await colyseus.connectTo(room, { userId: "u1", username: "Me" });
    client1.send("stats", { skill: 500, wins: 3 });
    await room.waitForNextPatch();

    const board: any = await new Promise((resolve) => {
      client1.onMessage("leaderboard", resolve);
      void (room as any).refreshLeaderboard();
    });
    assert.deepStrictEqual(
      board.skill.map((r: any) => [r.name, r.value]),
      [["OfflineAce", 9000], ["Me", 500]],
    );
    assert.strictEqual(board.skill.filter((r: any) => r.name === "Me").length, 1);
    assert.strictEqual(board.wins[0].name, "OfflineAce");
    // Level board: derived from skill server-side (500 skill -> level > 1), offline row first.
    assert.strictEqual(board.level[0].name, "OfflineAce");
    assert.ok(board.level.find((r: any) => r.name === "Me").value > 1);
    assert.strictEqual(board.playTime[0].value, 7200);
    assert.ok(board.skill[1].id === client1.sessionId, "own row keeps the session id");
    assert.ok(board.skill[0].id.startsWith("offline:"), "offline rows never expose the real id");
    assert.deepStrictEqual(Object.keys(board).sort(), ["level", "playTime", "skill", "wins"]);
  });

  it("counts server-measured playtime for signed-in players and persists it with $inc", async () => {
    const fake = fakePlayersCollection([baseDoc({ _id: "u1", playTime: 100 })]);
    // The fake has no $inc; emulate it so the flush is observable.
    const origUpdate = fake.updateOne.bind(fake);
    (fake as any).updateOne = async (f: any, u: any, o: any) => {
      if (u.$inc) {
        const d = fake.docs.get(f._id)!;
        d.playTime = (d.playTime ?? 0) + u.$inc.playTime;
        return;
      }
      return origUpdate(f, u, o);
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<LobbyState>("lobby", {});
    const c = await colyseus.connectTo(room, { userId: "u1" });
    await sleep(100);
    const r = room as any;
    assert.strictEqual(c.state.players.get(c.sessionId).playTime, 100);
    // Pretend 90s have passed, then flush.
    r.playTimeMark.set(c.sessionId, Date.now() - 90_000);
    r.flushAllPlaytime();
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(room.state.players.get(c.sessionId).playTime, 190);
    // A client cannot forge it through saveProgress.
    c.send("saveProgress", { skill: 10, playTime: 999999 });
    await sleep(50);
    assert.strictEqual(fake.docs.get("u1")!.playTime, 190);
    assert.strictEqual(fake.docs.get("u1")!.level, 2);
  });

  describe("tutorialStep", () => {
    it("clamps a saved step to 0..5 and ignores junk", () => {
      assert.strictEqual(sanitizeProgress({ tutorialStep: 3.9 })!.tutorialStep, 3);
      assert.strictEqual(sanitizeProgress({ tutorialStep: 99 })!.tutorialStep, 5);
      assert.strictEqual(sanitizeProgress({ tutorialStep: -2 })!.tutorialStep, 0);
      assert.strictEqual(sanitizeProgress({ tutorialStep: "4" })!.tutorialStep, undefined);
    });

    it("resolves legacy docs as finished and raises an undercounted step", () => {
      // No stored step (predates the field) -> finished.
      assert.strictEqual(resolveTutorialStep(baseDoc()), 5);
      // Stored step is kept when stats don't prove more.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 1 })), 1);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0 })), 0);
      // ...but raised when stats prove the player is further along.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, skill: 30 })), 1);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, wins: 2 })), 2);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, equippedStone: "scallop", ownedStones: ["pebble", "scallop"] })), 3);
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 0, rebirths: 1 })), 5);
      // Never lowered.
      assert.strictEqual(resolveTutorialStep(baseDoc({ tutorialStep: 4 })), 4);
    });

    it("persists it via saveProgress and sends it (or noProgress) on join", async () => {
      const fake = fakePlayersCollection();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<LobbyState>("lobby", {});
      const r = room as any;
      const sent: any[] = [];
      const origLoad = r.loadProgress.bind(r);
      r.loadProgress = (c: any, ...rest: any[]) => {
        const origSend = c.send.bind(c);
        c.send = (type: string, msg: any) => {
          sent.push([type, msg]);
          origSend(type, msg);
        };
        return origLoad(c, ...rest);
      };
      const first = await colyseus.connectTo(room, { userId: "tut1" });
      await sleep(100);
      assert.deepStrictEqual(sent[0], ["noProgress", {}]); // brand-new account

      first.send("saveProgress", { skill: 10, tutorialStep: 2 });
      await sleep(80);
      assert.strictEqual(fake.docs.get("tut1")!.tutorialStep, 2);

      sent.length = 0;
      await colyseus.connectTo(room, { userId: "tut1" }); // evicts `first`, reloads
      await sleep(100);
      const progress = sent.find(([t]) => t === "progress");
      assert.strictEqual(progress[1].tutorialStep, 2);
    });
  });

  describe("sanitizeProgress", () => {
    it("rejects non-objects and clamps values", () => {
      assert.strictEqual(sanitizeProgress(null), null);
      assert.strictEqual(sanitizeProgress("x"), null);
      const out = sanitizeProgress({ skill: 1e30, rebirths: 99999.7, wins: -4, bestSkips: NaN })!;
      assert.strictEqual(out.skill, 1_000_000_000_000);
      assert.strictEqual(out.rebirths, 5000);
      assert.strictEqual(out.wins, 0);
      assert.strictEqual(out.bestSkips, undefined);
    });
  });
});
