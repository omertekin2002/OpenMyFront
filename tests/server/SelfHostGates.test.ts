import { GameType } from "@openfront/engine-api/game/GameTypes";
import {
  GameRecordSchema,
  PartialGameRecord,
} from "@openfront/shared/WireSchemas";
import EventEmitter from "events";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archive, finalizeGameRecord } from "../../src/server/Archive";
import type { GameManager } from "../../src/server/GameManager";
import { registerGamePreviewRoute } from "../../src/server/GamePreviewRoute";
import { MasterLobbyService } from "../../src/server/MasterLobbyService";
import { startPolling } from "../../src/server/PollingLoop";
import { ServerEnv } from "../../src/server/ServerEnv";
import {
  cid,
  makeClient,
  makeGame,
  mockLogger,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

// The fork's self-host patches: with SELF_HOST=true the server skips the work
// that needs the central OpenFront API (archiving, game lookups, the
// winner-verification replay, auto-scheduled public lobbies) and the join
// gates that need its accounts (allowlists, trust). Each gate is run with and
// without SELF_HOST, so dropping one in an upstream merge fails here.

// Archive's module-level logger would otherwise set up winston and
// OpenTelemetry.
vi.mock("../../src/server/Logger", () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock("../../src/server/PollingLoop", () => ({
  startPolling: vi.fn(),
}));

// Captured before any test stubs it, to talk to the routes under test.
const realFetch = globalThis.fetch;
let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  // Hosted unless a test turns self-host on, whatever the shell exported.
  vi.stubEnv("SELF_HOST", "false");
  vi.stubEnv("DOMAIN", "example.com");
  vi.stubEnv("API_KEY", "test-api-key");
  // Nothing here may reach the network: every outbound call lands on this.
  fetchStub = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 404 }),
  );
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const selfHost = (on: boolean) => {
  if (on) vi.stubEnv("SELF_HOST", "true");
};

describe.each([
  ["self-host", true],
  ["hosted", false],
])("join gates (%s)", (_, on) => {
  // A lobby that admits someone starts broadcasting its info on a timer.
  beforeEach(() => {
    selfHost(on);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it(
    on
      ? "admits a client the allowlist does not name"
      : "turns away a client the allowlist does not name",
    () => {
      const game = makeGame({
        config: { gameType: GameType.Private, allowedPublicIds: ["pub-ok"] },
      });
      const listed = makeClient({ clientID: cid("a1"), publicId: "pub-no" });
      const anonymous = makeClient({
        clientID: cid("a2"),
        publicId: undefined,
      });
      const expected = on ? "joined" : "not_allowlisted";
      expect(game.joinClient(listed)).toBe(expected);
      expect(game.joinClient(anonymous)).toBe(expected);
    },
  );

  it(
    on
      ? "admits an untrusted client to a trusted lobby"
      : "turns away an untrusted client from a trusted lobby",
    () => {
      const game = makeGame({
        config: { gameType: GameType.Private, trusted: true },
      });
      const untrusted = makeClient({ clientID: cid("t1"), trusted: false });
      expect(game.joinClient(untrusted)).toBe(on ? "joined" : "not_trusted");
    },
  );
});

describe.each([
  ["self-host", true],
  ["hosted", false],
])("winner verification replay (%s)", (_, on) => {
  const A = cid("alice");
  const B = cid("bob");
  const C = cid("carol");

  beforeEach(() => {
    selfHost(on);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function play(ids: string[]) {
    const archived = vi.fn(async (_r: PartialGameRecord) => {});
    // Never settles: a game that replays waits on it and archives nothing.
    const replayWinner = vi.fn(() => new Promise<null>(() => {}));
    const game = makeGame({
      config: { gameType: GameType.Public },
      deps: { archive: archived, replayWinner, replayPending: () => 0 },
    });
    const clients = ids.map((clientID, i) =>
      makeClient({ clientID, ip: `1.1.1.${i + 1}`, publicId: `pub-${i}` }),
    );
    clients.forEach((c) => game.joinClient(c));
    startGame(game);
    const vote = (i: number, winner: string) =>
      mockWsOf(clients[i]).emit({
        type: "winner",
        winner: ["player", winner],
        allPlayersStats: {},
      });
    return { clients, archived, replayWinner, vote };
  }

  it(
    on
      ? "archives a disputed vote straight from the vote"
      : "replays a disputed vote before archiving",
    async () => {
      const { archived, replayWinner, vote } = play([A, B, C]);
      await vote(2, C);
      await vote(0, A);
      await vote(1, A);

      if (on) {
        expect(replayWinner).not.toHaveBeenCalled();
        expect(archived).toHaveBeenCalledTimes(1);
        expect(archived.mock.calls[0][0].info.winner).toEqual(["player", A]);
      } else {
        expect(replayWinner).toHaveBeenCalledTimes(1);
        expect(archived).not.toHaveBeenCalled();
      }
    },
  );

  it(
    on
      ? "archives a lone voter's result without replaying"
      : "replays a vote decided by a lone IP",
    async () => {
      const { clients, archived, replayWinner, vote } = play([A, B]);
      await vote(0, A);
      // The loser leaves without voting: A's vote decides alone.
      await mockWsOf(clients[1]).trigger("close");

      if (on) {
        expect(replayWinner).not.toHaveBeenCalled();
        expect(archived).toHaveBeenCalledTimes(1);
        expect(archived.mock.calls[0][0].info.winner).toEqual(["player", A]);
        expect(archived.mock.calls[0][0].info.statsAgreed).toBe(false);
      } else {
        expect(replayWinner).toHaveBeenCalledTimes(1);
        expect(archived).not.toHaveBeenCalled();
      }
    },
  );
});

describe("archive upload", () => {
  // A record as a real game hands it over, with the deployment stamps added.
  async function gameRecord() {
    vi.useFakeTimers();
    try {
      const archived = vi.fn(async (_r: PartialGameRecord) => {});
      const game = makeGame({
        config: { gameType: GameType.Public },
        deps: { archive: archived },
      });
      // The record schema wants a UUID persistent ID; the harness's isn't.
      game.joinClient(
        makeClient({
          clientID: cid("solo"),
          persistentID: "22222222-2222-4222-8222-222222222222",
        }),
      );
      startGame(game);
      await game.end();
      expect(archived).toHaveBeenCalledTimes(1);
      return finalizeGameRecord(archived.mock.calls[0][0]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }

  it("does not POST the record on a self-host", async () => {
    const record = await gameRecord();
    // A record the hosted path would upload, so only the gate stops it.
    expect(GameRecordSchema.safeParse(record).success).toBe(true);
    selfHost(true);
    await archive(record);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("POSTs the record to the API otherwise", async () => {
    const record = await gameRecord();
    await archive(record);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`https://api.example.com/game/${record.info.gameID}`);
    expect(init?.method).toBe("POST");
  });
});

describe("game preview lookup", () => {
  // A well-formed id no live game on this worker has.
  const GAME_ID = "AbCdEfGh";
  let server: http.Server;
  let base: string;
  let gameLookups: string[];

  beforeEach(async () => {
    gameLookups = [];
    const gm = {
      game: (id: string) => {
        gameLookups.push(id);
        return null;
      },
    } as unknown as GameManager;
    const app = express();
    registerGamePreviewRoute({
      app,
      gm,
      workerId: 0,
      log: mockLogger(),
      baseDir: "/nonexistent/dist/server",
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const preview = () =>
    realFetch(`${base}/game/${GAME_ID}`, { redirect: "manual" });

  it("redirects home without asking the API on a self-host", async () => {
    selfHost(true);
    const res = await preview();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(gameLookups).toEqual([GAME_ID]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("asks the API for the archived game otherwise", async () => {
    const res = await preview();
    // The stub answers 404: no archived game either, so it still goes home.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe(
      `https://api.example.com/game/${GAME_ID}`,
    );
  });
});

describe.each([
  ["self-host", true],
  ["hosted", false],
])("public lobby scheduling (%s)", (_, on) => {
  beforeEach(() => selfHost(on));

  it(
    on
      ? "only broadcasts lobbies once every worker is ready"
      : "broadcasts and schedules lobbies once every worker is ready",
    async () => {
      vi.spyOn(ServerEnv, "numWorkers").mockReturnValue(2);
      const broadcast = vi
        .spyOn(MasterLobbyService.prototype as any, "broadcastLobbies")
        .mockImplementation(() => {});
      const schedule = vi
        .spyOn(MasterLobbyService.prototype as any, "maybeScheduleLobby")
        .mockImplementation(async () => {});
      const service = new MasterLobbyService({} as any, mockLogger());
      for (const id of [1, 2]) {
        const worker = new EventEmitter();
        (worker as any).send = vi.fn();
        service.registerWorker(id, worker as any);
        worker.emit("message", { type: "workerReady", workerId: id });
      }

      // Run every loop the service started once, to see what each one does.
      const loops = vi.mocked(startPolling).mock.calls;
      expect(loops).toHaveLength(on ? 1 : 2);
      for (const [poll] of loops) await poll();
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledTimes(on ? 0 : 1);
    },
  );
});
