import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";
import { resetPagePinForTests } from "../../src/client/PagePin";
import {
  attemptInFlight,
  backendReachable,
  backendUnreachableConfirmed,
  ensureServerList,
  MANUAL_RETRY_COOLDOWN_MS,
  manualRetryAvailable,
  redirectToGameVersion,
  refreshServerList,
  reloadWouldRescue,
  resetServerList,
  retryDelayMs,
  retryServerList,
  serverListSite,
  startServerListPolling,
  stopServerListPolling,
  versionedPathForMismatchedGame,
} from "../../src/client/ServerList";

// Priority 1 of the multi-server v2 handoff: the client fetches the server
// list from the API at page load and keeps it warm with a heartbeat, filters
// it by its own version, and falls back to BOOTSTRAP_CONFIG whenever the
// list is missing or unreachable so that production behaves exactly as today
// until the API serves it. A click never waits on a fetch once a list is
// known, and a failed refresh never throws the last good list away.

const REFRESH_MS = 30_000;
// The FIRST retry delay. Later ones double (retryDelayMs), so anywhere a test
// needs a second or third failed attempt it spells the wait out.
const RETRY_MS = 10_000;
const RETRY_MAX_MS = 60_000;

const OWN = "bfd5563a11111111111111111111111111111111";
const OLD = "5ccc50a722222222222222222222222222222222";
// What `/v/<commit>/` carries: the bucket layout and the static Worker both
// key on the first 7 characters (see shortCommit).
const SHORT_OLD = "5ccc50a";

const API_LIST = {
  latest: OWN,
  servers: {
    c: {
      host: "falk2-a.openfront.io",
      numWorkers: 16,
      version: OLD,
      state: "draining",
    },
    d: {
      host: "falk2-b.openfront.io",
      numWorkers: 16,
      version: OWN,
      state: "open",
    },
  },
};

function setBootstrap(overrides: Record<string, unknown> = {}) {
  (window as any).BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    cluster: {
      a: { host: "blue.openfront.io", numWorkers: 2 },
      b: { host: "green.openfront.io", numWorkers: 2 },
    },
    instanceLetter: "a",
    turnstileSiteKey: "x",
    jwtAudience: "openfront.io",
    instanceId: "test",
    gitCommit: OWN,
    serverHost: "blue.openfront.io",
    siteHost: "openfront.io",
    ...overrides,
  };
  ClientEnv.reset();
  resetServerList();
}

function stubLocation(host: string, pathname = "/", search = "") {
  const loc: any = {
    protocol: "https:",
    host,
    hostname: host,
    pathname,
    search,
    href: `https://${host}${pathname}${search}`,
  };
  Object.defineProperty(window, "location", {
    value: loc,
    writable: true,
    configurable: true,
  });
  // isPinnedToAVersion answers from the pin captured at boot (PagePin.ts),
  // so a restubbed location only counts once the captured value is dropped.
  resetPagePinForTests();
  return loc;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse(API_LIST));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stubLocation("openfront.io");
  delete (window as any).openfrontDesktop;
  setBootstrap();
});

afterEach(() => {
  stopServerListPolling();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as any).BOOTSTRAP_CONFIG;
  delete (window as any).openfrontDesktop;
  ClientEnv.reset();
  resetServerList();
});

describe("ensureServerList", () => {
  it("does not fetch at module load or on ClientEnv reads", () => {
    ClientEnv.serverWsBase();
    ClientEnv.numWorkers();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to BOOTSTRAP_CONFIG when the API is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    expect(await ensureServerList()).toBe("fallback");
    expect(ClientEnv.serverWsBase()).toBe("wss://blue.openfront.io");
    expect(ClientEnv.numWorkers()).toBe(2);
    expect(ClientEnv.resolveGame("bAbCd12345")).toEqual({
      kind: "cross",
      host: "green.openfront.io",
      numWorkers: 2,
    });
    expect(ClientEnv.serverListLoaded()).toBe(false);
  });

  it.each([
    ["a 404", () => jsonResponse({ error: "unknown site" }, 404)],
    ["a malformed body", () => jsonResponse({ servers: { d: { host: 1 } } })],
    ["an empty list", () => jsonResponse({ servers: {} })],
  ])("falls back to BOOTSTRAP_CONFIG on %s", async (_name, make) => {
    fetchMock.mockImplementation(async () => make());
    expect(await ensureServerList()).toBe("fallback");
    expect(ClientEnv.serverWsBase()).toBe("wss://blue.openfront.io");
  });

  it("keeps the picked server across refreshes while it stays open", async () => {
    const list = {
      latest: OWN,
      servers: {
        d: {
          host: "d.openfront.io",
          numWorkers: 1,
          version: OWN,
          state: "open",
        },
        e: {
          host: "e.openfront.io",
          numWorkers: 1,
          version: OWN,
          state: "open",
        },
      },
    };
    fetchMock.mockImplementation(async () => jsonResponse(list));
    vi.useFakeTimers();
    await ensureServerList();
    const first = ClientEnv.serverHttpBase();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      await ensureServerList();
      expect(ClientEnv.serverHttpBase()).toBe(first);
    }
    vi.useRealTimers();
  });
});

// The retry schedule on its own, with no clock and no fetch: a failing API
// must not be asked every 10s forever (a lid-closed laptop would keep firing
// a 4s request all night), but the first retry has to stay quick because the
// common case is a blip the very next request clears.
describe("retryDelayMs", () => {
  it("waits the base interval after the first failure", () => {
    expect(retryDelayMs(1)).toBe(RETRY_MS);
  });

  it("doubles on each further consecutive failure", () => {
    expect(retryDelayMs(2)).toBe(2 * RETRY_MS);
    expect(retryDelayMs(3)).toBe(4 * RETRY_MS);
  });

  it("caps the wait rather than doubling forever", () => {
    // 4 failures is already 80s uncapped, so the cap bites here and stays.
    expect(retryDelayMs(4)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(10)).toBe(RETRY_MAX_MS);
    expect(retryDelayMs(1_000)).toBe(RETRY_MAX_MS);
    expect(Number.isFinite(retryDelayMs(1_000))).toBe(true);
  });

  it("is back at the base with no failures behind it", () => {
    // What an ANSWER leaves the counter at. The next beat's schedule must
    // not inherit the outage's -- a recovered backend that then misses once
    // should be retried in 10s, not in a minute.
    expect(retryDelayMs(0)).toBe(RETRY_MS);
    expect(retryDelayMs(-1)).toBe(RETRY_MS);
  });
});

describe("startServerListPolling", () => {
  it("does not poll on a replay shell host", async () => {
    // Replay shells talk to the archive, not to a live server list.
    stubLocation("replay.openfront.io");
    vi.useFakeTimers();
    startServerListPolling();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a confirmed outage, as opposed to one missed beat", () => {
  it("is never confirmed before the first attempt settles", async () => {
    expect(backendReachable()).toBe(null);
    expect(backendUnreachableConfirmed()).toBe(false);
  });
});

/**
 * The policy above retryServerList's own floor, shared by both shells'
 * player-initiated retries so they cannot drift: the desktop status bar's
 * Retry button (which renders its disabled state from the same two
 * conditions) and, on the web where there is no such button, a refused
 * multiplayer click (GameModeSelector.reportMultiplayerRefusal). The web
 * caller has nothing to disable, so it asks this instead.
 */
describe("manualRetryAvailable", () => {
  it("is available before anyone has asked", () => {
    expect(manualRetryAvailable()).toBe(true);
  });

  it("is unavailable for the cooldown after a player-initiated attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("network down"));

    await retryServerList();
    // Settled in milliseconds, which is exactly the case the cooldown exists
    // for: without it a stubbed or fast failure hands the affordance straight
    // back to someone clicking at an outage.
    expect(attemptInFlight()).toBe(false);
    expect(manualRetryAvailable()).toBe(false);

    await vi.advanceTimersByTimeAsync(MANUAL_RETRY_COOLDOWN_MS - 1);
    expect(manualRetryAvailable()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(manualRetryAvailable()).toBe(true);
  });
});

// Today's rollover feel, kept: a player on build X keeps playing on X's
// server after Y is released, until they refresh. So the pick prefers an
// `open` server on this build, falls back to a `draining` one on this
// build, and never takes a `fenced` one. When neither state runs this
// build the page is told a newer version exists ("outdated") and the
// update prompt handles it — nothing here ever navigates the page.
describe("picking between open, draining and fenced", () => {
  // `latest: null` is a list with no latest flagged at all (a preview
  // whose server expired), which is not the same as leaving it out here.
  function listOf(
    servers: Record<string, unknown>,
    latest: string | null = OWN,
  ) {
    return latest === null ? { servers } : { latest, servers };
  }
  const server = (
    version: string,
    state: string,
    host = "falk2-a.openfront.io",
  ) => ({
    host,
    numWorkers: 16,
    version,
    state,
  });

  // The desktop shell updates itself (download, stage, its own reload
  // button): a web-style update prompt there would re-run the same overlay.
  // It also injects a serverHost of its own, so it is answered by the
  // page-server rule first — "fallback", the shell's own values, never
  // "outdated". The isDesktopShell() exemption still covers a shell that
  // injects no host at all.
  it("leaves the desktop shell to its updater", async () => {
    (window as any).openfrontDesktop = {};
    setBootstrap({ gitCommit: OLD, serverHost: "openfront.io" });
    const loc = stubLocation("openfront");
    fetchMock.mockImplementation(async () =>
      jsonResponse(listOf({ c: server(OLD, "fenced") })),
    );
    expect(await ensureServerList()).toBe("fallback");
    expect(loc.href).toBe("https://openfront/");
    expect(ClientEnv.serverWsBase()).toBe("wss://openfront.io");
  });

  // OPE-430. Live on main.openfront.dev: the page was still rendered by a
  // game server (the static Worker is not routed yet), a deploy failed to
  // register the new build in the API's registry, so the list carried no
  // server on the page's build and a `latest` that was a different commit.
  // The page was told "outdated", the prompt reloaded it, the same server
  // served the same page, and it prompted again — forever.
  //
  // The rule: a page that names a server came FROM a server running this
  // build, and a reload re-fetches the page from that same host, so the
  // list can never make it outdated — whatever it says about that host.
  // The answer is always "fallback": the page's own server and its own
  // values, exactly as when the API is unreachable.
  describe("a page a game server rendered", () => {
    // No server on the page's build, and a latest that is a different
    // commit: exactly the list that used to say "outdated".
    const nothingOnMyBuild = () =>
      listOf({
        c: server(OLD, "fenced"),
        d: server(OWN, "open", "falk2-b.openfront.io"),
      });

    beforeEach(() => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(nothingOnMyBuild()),
      );
    });

    // Review round 6's scenario. The list DOES carry this page's host, on a
    // different build. Right after a deploy that is registration lag — the
    // page came from the NEW build while the registry still names the old
    // one — and on a tab left open across a deploy the host really has
    // moved on. The list cannot tell the two apart, and a reload re-serves
    // this same page in the first case, so neither is "outdated" here. The
    // stale tab is told by the server itself: the lobby feed's commit
    // compare fires as soon as the socket connects to that very host.
    it("is not outdated when the list puts its own host on another build", async () => {
      setBootstrap({ gitCommit: OLD, serverHost: "blue.openfront.io" });
      fetchMock.mockImplementation(async () =>
        jsonResponse(listOf({ a: server(OWN, "open", "blue.openfront.io") })),
      );

      expect(await ensureServerList()).toBe("fallback");
      expect(ClientEnv.serverHttpBase()).toBe("https://blue.openfront.io");
    });

    // The same list shape on a standalone deployment with GAME_DOMAIN set:
    // its page host (main.openfront.dev) and game host
    // (main.server.openfront.dev) differ, but both reach the one container.
    it("is not outdated on a standalone page whose page and game hosts differ", async () => {
      setBootstrap({
        gitCommit: OLD,
        siteHost: "main.openfront.dev",
        serverHost: "main.server.openfront.dev",
        instanceLetter: "a",
        cluster: {
          a: {
            host: "main.server.openfront.dev",
            numWorkers: 2,
          },
        },
      });
      fetchMock.mockImplementation(async () =>
        jsonResponse(
          listOf({ a: server(OWN, "open", "main.server.openfront.dev") }),
        ),
      );

      expect(await ensureServerList()).toBe("fallback");
      expect(ClientEnv.serverHttpBase()).toBe(
        "https://main.server.openfront.dev",
      );
    });

    // Review round 7's scenario: registration lag on an apex page. The
    // registry still names a stale version for this page's own host while
    // `latest` already IS this page's build, so nothing in the list serves
    // it and the page is not behind either. Under the per-standing rules
    // this fell through to "no-server" and Create was refused on a server
    // that was alive, correctly built, and had just rendered the page.
    // There is no such fall-through now: a page that names a server answers
    // "fallback", so Create goes to its own host (GameServerApiCallers) and
    // nothing prompts, at page load or after a socket failure.
    it("creates on its own server when the registry lags and this build is latest", async () => {
      setBootstrap({ gitCommit: OWN, serverHost: "blue.openfront.io" });
      fetchMock.mockImplementation(async () =>
        jsonResponse(listOf({ a: server(OLD, "open", "blue.openfront.io") })),
      );

      expect(await ensureServerList()).toBe("fallback");
      expect(ClientEnv.serverHttpBase()).toBe("https://blue.openfront.io");
      // Nor is there anything a reload could rescue: this page IS latest.
      expect(reloadWouldRescue("fallback")).toBe(false);
    });

    // Review round 5's fenced case. The page's own server, on its own
    // build, deliberately out of rotation: it takes nothing new, but a
    // reload would come back identical, so there is nothing to prompt for.
    // Create goes to that host as it did before the list existed
    // (Api.createLobby), and the deployment tells its own tabs it is on its
    // way out over the feed it is already serving them — active:false, once
    // the API stops calling it open (ClusterCheckin.applyCheckinState).
    it("is not outdated when its own entry is fenced on this build", async () => {
      setBootstrap({ gitCommit: OLD, serverHost: "blue.openfront.io" });
      fetchMock.mockImplementation(async () =>
        jsonResponse(
          listOf({
            a: server(OLD, "fenced", "blue.openfront.io"),
            d: server(OWN, "open", "falk2-b.openfront.io"),
          }),
        ),
      );

      expect(await ensureServerList()).toBe("fallback");
      expect(ClientEnv.serverHttpBase()).toBe("https://blue.openfront.io");
    });
  });

  // Whatever the answer, and whoever asked: joining an existing game and
  // every in-game request run through here too, and a navigation would take
  // a live match off the page.
  it("never navigates the page, on any path", async () => {
    const cases: unknown[] = [
      listOf({ c: server(OLD, "fenced") }),
      listOf({ c: server(OLD, "draining") }),
      listOf({ c: server(OWN, "open") }),
      listOf({}, null),
    ];
    for (const body of cases) {
      for (const commit of [OWN, OLD, "DEV"]) {
        setBootstrap({ gitCommit: commit });
        const loc = stubLocation("openfront.io", `/v/${OWN}/game/cAbCd12345`);
        fetchMock.mockImplementation(async () => jsonResponse(body));
        await ensureServerList();
        expect(loc.href).toBe(`https://openfront.io/v/${OWN}/game/cAbCd12345`);
      }
    }
  });
});

// The POST-FAILURE question (ServerList.reloadWouldRescue), asked by
// PublicLobbySocket.promptIfOutdated once reconnecting has given up: would
// reloading actually rescue this tab? Its three conditions are the three
// ways this could go wrong, and each of these cases is a scenario a review
// round raised against an earlier draft of this PR.
describe("reloadWouldRescue", () => {
  // A newer build exists, and nothing serves this page's build.
  const NEWER = {
    latest: OWN,
    servers: {
      d: {
        host: "falk2-b.openfront.io",
        numWorkers: 16,
        version: OWN,
        state: "open",
      },
    },
  };
  // The same, plus a draining server this page's build can still use.
  const STILL_SERVED = {
    latest: OWN,
    servers: {
      ...NEWER.servers,
      c: {
        host: "falk2-a.openfront.io",
        numWorkers: 16,
        version: OLD,
        state: "draining",
      },
    },
  };

  beforeEach(() => {
    fetchMock.mockImplementation(async () => jsonResponse(NEWER));
  });

  it("never rescues a standalone page, whose reload comes back from the same server", async () => {
    // dev's main.openfront.dev today, previews, beta. If that server is
    // gone the reload fails with it; if it is alive with a WebSocket-only
    // problem (a proxy passing HTTP while blocking upgrades) the prompt
    // would reload, come back to the same container and prompt again —
    // OPE-430, paced by maxWsAttempts.
    setBootstrap({
      gitCommit: OLD,
      siteHost: undefined,
      serverHost: "main.openfront.dev",
      instanceLetter: "a",
      cluster: { a: { host: "main.openfront.dev", numWorkers: 2 } },
    });
    stubLocation("main.openfront.dev");
    expect(await ensureServerList()).toBe("fallback");
    expect(reloadWouldRescue("fallback")).toBe(false);
  });

  it("never rescues a single-server deployment whose page and game hosts differ", async () => {
    // With GAME_DOMAIN set even a standalone deployment gets a siteHost
    // that differs from its game host, while Traefik routes both names to
    // the one container. The site's list having no siblings is what tells
    // this apart from prod's apex: main.openfront.dev is its own site, and
    // its list names its one server.
    setBootstrap({
      gitCommit: OLD,
      siteHost: "main.openfront.dev",
      serverHost: "main.server.openfront.dev",
      instanceLetter: "a",
      cluster: { a: { host: "main.server.openfront.dev", numWorkers: 2 } },
    });
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        latest: OWN,
        servers: {
          a: {
            host: "main.server.openfront.dev",
            numWorkers: 2,
            version: OWN,
            state: "open",
          },
        },
      }),
    );
    expect(await ensureServerList()).toBe("fallback");
    expect(reloadWouldRescue("fallback")).toBe(false);
  });

  it("is false before any list has loaded", () => {
    // Nothing is known to update to, so nothing can be promised.
    expect(reloadWouldRescue("fallback")).toBe(false);
  });

  it("is false when this page already runs latest", async () => {
    setBootstrap({ gitCommit: OWN });
    await ensureServerList();
    expect(reloadWouldRescue("fallback")).toBe(false);
  });

  it("is false when the list names no latest", async () => {
    setBootstrap({ gitCommit: OLD });
    fetchMock.mockImplementation(async () =>
      jsonResponse({ servers: NEWER.servers }),
    );
    await ensureServerList();
    expect(reloadWouldRescue("fallback")).toBe(false);
  });

  it("keeps the exemptions of the shells that must never reload", async () => {
    // A pinned page is behind on purpose, and the desktop shell's updater
    // owns its version: a dead socket is no reason to tell either to
    // reload.
    setBootstrap({ gitCommit: OLD });
    stubLocation("openfront.io", `/v/${OLD}/game/dAbCd12345`);
    await ensureServerList();
    expect(reloadWouldRescue("fallback")).toBe(false);

    (window as any).openfrontDesktop = {};
    setBootstrap({ gitCommit: OLD, serverHost: "openfront.io" });
    stubLocation("openfront");
    await ensureServerList();
    expect(reloadWouldRescue("fallback")).toBe(false);
  });
});

// Opening a game whose server runs another build. One exported decision for
// both call sites (Main.handleUrl, JoinLobbyModal.checkActiveLobby) so the
// shells that must not be navigated cannot be remembered in one and
// forgotten in the other.
describe("redirectToGameVersion", () => {
  // Letter c runs OLD in API_LIST; the page is built from OWN.
  async function withList() {
    expect(await ensureServerList()).toBe("api");
  }

  it("stays put with no list loaded", async () => {
    const loc = stubLocation("openfront.io", "/game/cAbCd12345");
    expect(redirectToGameVersion("cAbCd12345")).toBe(false);
    expect(loc.href).toBe("https://openfront.io/game/cAbCd12345");
  });
});

// OpenMyFront: there is no central API serving server lists, so
// serverListSite() is undefined and nothing above ever has a list to work
// from. The page's own server answers every question, nothing is fetched, and
// no outage is ever confirmed (so Create and Join are never refused for one).
describe("on a self-host, with no server-list API", () => {
  it("asks for no list, on the web or in the desktop shell", () => {
    expect(serverListSite()).toBeUndefined();
    (window as any).openfrontDesktop = {};
    setBootstrap({ serverHost: "nightly.openfront.dev", siteHost: undefined });
    stubLocation("openfront");
    expect(serverListSite()).toBeUndefined();
  });

  it("routes by BOOTSTRAP_CONFIG without fetching, however it is asked", async () => {
    expect(await ensureServerList()).toBe("fallback");
    expect(await retryServerList()).toBe("fallback");
    expect(await refreshServerList()).toBe("fallback");
    startServerListPolling();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attemptInFlight()).toBe(false);
    expect(ClientEnv.serverListLoaded()).toBe(false);
    expect(ClientEnv.serverWsBase()).toBe("wss://blue.openfront.io");
    expect(ClientEnv.numWorkers()).toBe(2);
  });

  it("never reports the backend unreachable, even with the network down", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await ensureServerList();
    await retryServerList();
    expect(backendReachable()).toBeNull();
    expect(backendUnreachableConfirmed()).toBe(false);
  });

  it("still opens a mismatched game at the commit its server refused us with", () => {
    stubLocation("openfront.io", "/game/cAbCd12345");
    expect(versionedPathForMismatchedGame("cAbCd12345", OLD)).toBe(
      `/v/${SHORT_OLD}/game/cAbCd12345`,
    );
    // With no commit from the server there is no list to fall back on.
    expect(versionedPathForMismatchedGame("cAbCd12345", undefined)).toBeNull();
  });
});
