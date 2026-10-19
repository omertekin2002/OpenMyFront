/**
 * First harness that imports src/client/Main.ts for real. Main bootstraps at
 * module scope (`new Client().initialize()`), so the DOM (built from the real
 * index.html body) and every global it dereferences must exist BEFORE the
 * dynamic import in beforeAll. All tests share that one boot: custom elements
 * cannot be re-defined in the file's single jsdom, so a second import of Main
 * (after vi.resetModules) would throw on the first `customElements.define`.
 */
import { EventBus } from "@openfront/shared/EventBus";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadModal } from "../../src/client/LazyModals";
import { SendKickPlayerIntentEvent } from "../../src/client/LobbyEvents";
import { capturePagePin } from "../../src/client/PagePin";
import { lastUserMeResponse } from "../../src/client/UserMeBroadcast";
import { translateText } from "../../src/client/Utils";

const mocks = vi.hoisted(() => ({
  userAuth: vi.fn(async (): Promise<unknown> => false),
  retrySteamSignIn: vi.fn(async (): Promise<unknown> => false),
  reauthAfterPortalChange: vi.fn(async (): Promise<unknown> => false),
  getDesktopSessionState: vi.fn(() => ({ status: "unknown" })),
  getUserMe: vi.fn(async (): Promise<unknown> => false),
  invalidateUserMe: vi.fn(),
  joinLobby: vi.fn(),
  turnstileRender: vi.fn(() => "widget-1"),
}));

// Auth is imported by half the component tree; keep the real module and only
// take over the four functions Main's auth flow calls.
vi.mock("../../src/client/Auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    userAuth: mocks.userAuth,
    retrySteamSignIn: mocks.retrySteamSignIn,
    reauthAfterPortalChange: mocks.reauthAfterPortalChange,
    getDesktopSessionState: mocks.getDesktopSessionState,
  };
});

// Same story for Api: <username-input> calls getUserMe from
// connectedCallback, which runs while Main's import is still executing.
vi.mock("../../src/client/Api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getUserMe: mocks.getUserMe,
    invalidateUserMe: mocks.invalidateUserMe,
  };
});

// Cuts the whole Pixi/WebGL/worker/audio in-game graph out of the import.
// Transport/LocalServer only take the LobbyConfig *type* from this module,
// so a value-only stub is safe.
vi.mock("../../src/client/ClientGameRunner", () => ({
  joinLobby: mocks.joinLobby,
}));

// The viewer pulls in the WebGL renderer. A bare element is enough to see
// that Main opened it, and for which game.
vi.mock("../../src/client/replay/ReplayViewer", () => {
  class ReplayViewer extends HTMLElement {
    gameID = "";
  }
  customElements.define("replay-viewer", ReplayViewer);
  return { ReplayViewer };
});

function userMeFixture(): unknown {
  return {
    user: { email: "player@example.com" },
    player: {
      publicId: "public-id-1",
      usernameStatus: "claimed",
      usernameBase: "RyanTheGreat",
      username: "RyanTheGreat",
      usernameClaimExpiresAt: null,
      nextUsernameChangeAt: null,
      rewards: [],
      // SinglePlayerModal's userMeResponse listener dereferences this.
      achievements: { singleplayerMap: [] },
    },
  };
}

describe("Client.initialize() booted from Main.ts module scope", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // ClientEnv.get() throws without the four environment values. Nothing
    // here names a server beyond the worker count, and no instanceId at all:
    // a static page carries none (multi-server v2), and initialize() must
    // boot from one that does not.
    (window as any).BOOTSTRAP_CONFIG = {
      gameEnv: "dev",
      numWorkers: 2,
      turnstileSiteKey: "test-site-key",
      jwtAudience: "localhost",
      gitCommit: "DEV",
    };

    // Loaded, so the only thing that can keep the prefetch from rendering a
    // widget is the dev check (see "skips the Turnstile prefetch in dev").
    (window as any).turnstile = {
      render: mocks.turnstileRender,
      execute: (
        _widgetId: string,
        opts: { callback: (token: string) => void },
      ) => opts.callback("turnstile-test-token"),
      remove: () => {},
    };

    // jsdom has neither FontFace nor document.fonts.
    vi.stubGlobal(
      "FontFace",
      class {
        load() {
          return Promise.resolve(this);
        }
      },
    );
    Object.defineProperty(document, "fonts", {
      value: { add: () => {} },
      configurable: true,
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    // Components in Main's graph fire fetches from connectedCallback; answer
    // them all with a failure they already handle instead of real sockets.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Server Error",
        headers: new Map<string, string>(),
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );

    // Real markup, so every unguarded getElementById/querySelector in
    // initialize() (help modal, turnstile container, ...) finds the element
    // it dereferences. Scripts hold EJS placeholders — drop them.
    const html = fs.readFileSync(
      path.resolve(__dirname, "../../index.html"),
      "utf8",
    );
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script").forEach((s) => s.remove());
    const bodyInner = parsed.body.innerHTML;
    // A guaranteed-first <username-input> so Client.initialize() captures an
    // element we can stub canPlay() on (play-page renders its own copy async,
    // maybe, later — document order keeps ours the querySelector result).
    document.body.innerHTML = `<username-input></username-input>${bodyInner}`;

    localStorage.setItem(
      "achievements.pushed",
      JSON.stringify({ playerId: "p1", names: ["win_ffa"] }),
    );

    // The import runs bootstrap: component registration, element upgrades,
    // then `new Client().initialize()`.
    await import("../../src/client/Main");

    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded", { bubbles: true }));
    }

    // After `await userAuth()` resolves, the remainder of initialize() is
    // synchronous — one flush after the call is observed means the hashchange
    // listener, join-lobby listener and slider wiring are all in place.
    await vi.waitFor(() => expect(mocks.userAuth).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }, 20_000);

  // Let any timer the boot scheduled run before jsdom is torn down, or it
  // throws "customElements is not defined" as an unhandled error that fails
  // the whole run.
  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("runs the signed-out boot: onUserMe(false), with ads off", () => {
    // userAuth() === false → onUserMe(false), which broadcasts the signed-out
    // profile to the components listening for it.
    expect(lastUserMeResponse()).toEqual({ response: false });
    // No ads on this self-host, signed in or not.
    expect(window.adsEnabled).toBe(false);
  });

  it("skips the Turnstile prefetch in dev, which never sends a token", () => {
    expect(mocks.turnstileRender).not.toHaveBeenCalled();
  });

  it("clears the stale achievements.pushed record", () => {
    expect(localStorage.getItem("achievements.pushed")).toBeNull();
  });

  it("starts the menu audio once its chunk loads", async () => {
    // Its own chunk, so the page doesn't wait on howler.
    const { audioMixer } = await import("../../src/client/sound/AudioMixer");
    await vi.waitFor(() => expect(audioMixer()).not.toBeNull());
  });

  it("hands the lobby modals the event bus before a loader can open them", async () => {
    const seen: unknown[] = [];
    for (const tag of ["host-lobby-modal", "join-lobby-modal"]) {
      await loadModal(tag);
      // Read as soon as loadModal settles: what an opener would find.
      seen.push(
        (document.querySelector(tag) as unknown as { eventBus: unknown })
          .eventBus,
      );
    }
    expect(seen.every((bus) => bus instanceof EventBus)).toBe(true);
  });

  it("routes a hashchange through onHashUpdate", async () => {
    // It loads on demand; until it has, there's nothing to close.
    await loadModal("join-lobby-modal");
    const joinModal = document.querySelector("join-lobby-modal") as unknown as {
      close: () => void;
    };
    const closeSpy = vi.spyOn(joinModal, "close").mockImplementation(() => {});
    window.dispatchEvent(new Event("hashchange"));
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    closeSpy.mockRestore();
  });

  it("reads the join-lobby detail and stops at the username gate", async () => {
    const input = document.querySelector("username-input") as unknown as {
      canPlay: () => boolean;
    };
    const canPlay = vi.fn(() => false);
    input.canPlay = canPlay;
    logSpy.mockClear();
    document.dispatchEvent(
      new CustomEvent("join-lobby", {
        detail: { gameID: "AbCd1234" },
        bubbles: true,
      }),
    );
    await vi.waitFor(() => expect(canPlay).toHaveBeenCalled());
    // Early return before the "joining lobby" log — nothing joined.
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("joining lobby"),
    );
    expect(mocks.joinLobby).not.toHaveBeenCalled();
  });

  it("forwards a kick-player DOM event to the game event bus", () => {
    const emitSpy = vi.spyOn(EventBus.prototype, "emit");
    document.dispatchEvent(
      new CustomEvent("kick-player", {
        detail: { target: "c0000002" },
        bubbles: true,
      }),
    );
    expect(
      emitSpy.mock.calls.some(
        ([e]) =>
          e instanceof SendKickPlayerIntentEvent && e.target === "c0000002",
      ),
    ).toBe(true);
    emitSpy.mockRestore();
  });

  // Multi-server v2, and the two halves of the rule in one test. The in-game
  // `?live` entry is this tab's OWN URL, so on a page pinned under
  // /v/<commit>/ it carries that prefix: an F5 must reload the bundle this
  // page is running, not hand a mid-game player `latest`. The share rewrite
  // is the opposite -- it is what people copy out of the address bar, so it
  // stays version-free and the recipient is routed by the game's own server.
  //
  // Driven end-to-end through the real join path: the share rewrite
  // (updateJoinUrlForShare) runs before userAuth(), the `?live` entry when
  // the join handle resolves.
  it("pins the in-game URL but not the share URL on a /v/<commit>/ page", async () => {
    const realLocation = window.location;
    Object.defineProperty(window, "location", {
      value: {
        href: "http://localhost:3000/v/5ccc50a7/",
        origin: "http://localhost:3000",
        host: "localhost:3000",
        hostname: "localhost",
        pathname: "/v/5ccc50a7/",
        search: "",
        hash: "",
      },
      writable: true,
      configurable: true,
    });
    // Client.initialize() takes the pin as its very first act (PagePin.ts),
    // and this suite boots Main once in beforeAll, before the stub above.
    // Re-taking it here is what a genuinely pinned document would have done
    // -- and it is the whole point: from here on the answer no longer moves
    // when the share rewrite takes the prefix out of the address bar.
    capturePagePin();
    const replaceSpy = vi
      .spyOn(history, "replaceState")
      .mockImplementation(() => {});
    const pushSpy = vi.spyOn(history, "pushState").mockImplementation(() => {});
    let resolveJoin: () => void = () => {};
    mocks.joinLobby.mockReturnValueOnce({
      // Never resolves: the prestart branch is a different story, and this
      // test is about the two URL writes.
      prestart: new Promise<void>(() => {}),
      join: new Promise<void>((resolve) => {
        resolveJoin = resolve;
      }),
      stop: () => true,
    });
    const input = document.querySelector("username-input") as unknown as {
      canPlay: () => boolean;
    };
    input.canPlay = () => true;

    try {
      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: { gameID: "dAbCd12345", source: "private" },
          bubbles: true,
        }),
      );

      // The share-URL rewrite is deliberately NOT pinned: it is the URL
      // people copy out of the address bar, and a recipient must be routed
      // to the game's own version when they open it, not to this page's.
      await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());
      const calls = replaceSpy.mock.calls;
      const rewritten = calls[calls.length - 1][2] as string;
      // Shape-matched rather than just "not pinned", so this cannot pass by
      // catching some other replaceState.
      expect(rewritten).toMatch(
        /^(\/streamer-mode|\/(w\d+\/)?game\/dAbCd12345)$/,
      );

      // And the in-game entry once the join lands.
      await vi.waitFor(() => expect(mocks.joinLobby).toHaveBeenCalled());
      resolveJoin();
      await vi.waitFor(() =>
        expect(
          pushSpy.mock.calls.some((c) =>
            (c[2] as string)?.startsWith("/v/5ccc50a7/"),
          ),
        ).toBe(true),
      );
    } finally {
      replaceSpy.mockRestore();
      pushSpy.mockRestore();
      Object.defineProperty(window, "location", {
        value: realLocation,
        writable: true,
        configurable: true,
      });
    }
  }, 15_000);

  it("broadcasts the signed-in userMe a session retry lands", async () => {
    mocks.retrySteamSignIn.mockResolvedValueOnce({
      jwt: "jwt",
      claims: {},
    });
    mocks.getUserMe.mockResolvedValueOnce(userMeFixture());
    document.dispatchEvent(new CustomEvent("desktop-session-retry"));
    await vi.waitFor(() =>
      expect(lastUserMeResponse()).toEqual({ response: userMeFixture() }),
    );
    expect(window.adsEnabled).toBe(false);
  });

  /**
   * OPE-439. The entry-point components dim their own buttons, but every join
   * -- a deep link, the host/join modals -- funnels through handleJoinLobby
   * without passing one, so the funnel gate is the only thing that covers
   * them. This is a WEB boot (no openfrontDesktop).
   *
   * Driven through the real ServerList module. A self-host has no
   * server-list API (serverListSite() is undefined), so nothing is ever
   * fetched, no outage can be confirmed, and joins go through even with the
   * network down.
   */
  describe("the join funnel lets joins through without a server-list API", () => {
    let ServerList: typeof import("../../src/client/ServerList");
    let messages: string[];
    let onMessage: EventListener;
    let fetchMock: ReturnType<typeof vi.fn>;

    async function settleWithNetworkDown(): Promise<void> {
      fetchMock = vi.fn(async () => {
        throw new TypeError("network down");
      });
      vi.stubGlobal("fetch", fetchMock);
      ServerList.resetServerList();
      await ServerList.ensureServerList();
      await ServerList.retryServerList();
    }

    beforeAll(async () => {
      ServerList = await import("../../src/client/ServerList");
      // The pinned-page test above joins once and leaves the call on the
      // mock; every join-count claim below counts from zero.
      mocks.joinLobby.mockClear();
      // Test 3 above left the username gate closed; every join below has to
      // get past it to reach the gate under test.
      const input = document.querySelector("username-input") as unknown as {
        canPlay: () => boolean;
      };
      input.canPlay = () => true;
      messages = [];
      onMessage = (e: Event) => {
        messages.push((e as CustomEvent).detail?.message);
      };
      window.addEventListener("show-message", onMessage);
    });

    afterAll(() => {
      window.removeEventListener("show-message", onMessage);
      ServerList.resetServerList();
    });

    /** The shape handleJoinLobby expects back; neither promise settles. */
    function stubJoinLobbyReturn(): void {
      mocks.joinLobby.mockReturnValue({
        prestart: new Promise(() => {}),
        join: new Promise(() => {}),
        stop: vi.fn(),
      });
    }

    it("never asks for a server list, so no outage is ever confirmed", async () => {
      await settleWithNetworkDown();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ServerList.backendReachable()).toBeNull();
      expect(ServerList.backendUnreachableConfirmed()).toBe(false);
    });

    it("joins a private game with the network down", async () => {
      await settleWithNetworkDown();
      messages.length = 0;
      mocks.joinLobby.mockClear();
      stubJoinLobbyReturn();

      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: { gameID: "AbCd1234", source: "private" },
          bubbles: true,
        }),
      );

      // The far edge of the funnel, not the "joining lobby" log: that log
      // is written BEFORE handleJoinLobby awaits userAuth, the username
      // seed and the cosmetics refs, so a regression in that tail would
      // leave a log assertion passing over a join that never happened.
      await vi.waitFor(() => expect(mocks.joinLobby).toHaveBeenCalledTimes(1));
      // ...and with the lobby that was dispatched, not some other one.
      expect(mocks.joinLobby.mock.calls[0][1].gameID).toBe("AbCd1234");
      expect(messages).not.toContain(
        translateText("common.backend_unreachable"),
      );
    });
  });

  it("ignores the replay viewer hash while a game is running", async () => {
    mocks.joinLobby.mockClear();
    let resolveJoin: () => void = () => {};
    mocks.joinLobby.mockReturnValueOnce({
      prestart: new Promise<void>(() => {}),
      join: new Promise<void>((resolve) => {
        resolveJoin = resolve;
      }),
      stop: () => true,
    });
    const input = document.querySelector("username-input") as unknown as {
      canPlay: () => boolean;
    };
    input.canPlay = () => true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      document.dispatchEvent(
        new CustomEvent("join-lobby", {
          detail: { gameID: "AbCd5678", source: "private" },
          bubbles: true,
        }),
      );
      await vi.waitFor(() => expect(mocks.joinLobby).toHaveBeenCalled());
      resolveJoin();
      // The in-game entry, which Main keeps as the game's URL.
      await vi.waitFor(() =>
        expect(window.location.href).toMatch(/game\/AbCd5678/),
      );
      const gameUrl = window.location.href;
      const replaceSpy = vi.spyOn(history, "replaceState");

      window.location.hash = "#replay-viewer=dqKzit4cWu";
      window.dispatchEvent(new Event("hashchange"));
      await new Promise((r) => setTimeout(r, 50));
      expect(document.querySelector("replay-viewer")).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "replay viewer: ignored, a game is running",
      );
      // The game's URL is put back.
      expect(replaceSpy).toHaveBeenCalledWith(null, "", gameUrl);
      replaceSpy.mockRestore();
    } finally {
      // Leave, so the viewer can open in the next test.
      document.dispatchEvent(new CustomEvent("leave-lobby"));
      warn.mockRestore();
    }
  });

  // Last: the viewer replaces the menu, and any later hash change would
  // then leave the page.
  it("opens the replay viewer when the hash changes to one, tearing the menu down like a game start", async () => {
    await loadModal("join-lobby-modal");
    const joinModal = document.querySelector("join-lobby-modal") as unknown as {
      close: () => void;
      disarmLeaveOnClose: () => void;
      closeWithoutLeaving: () => void;
    };
    const disarmSpy = vi.spyOn(joinModal, "disarmLeaveOnClose");
    const closeWithoutLeavingSpy = vi.spyOn(joinModal, "closeWithoutLeaving");
    // What JoinLobbyModal.onClose does when there's no lobby to keep.
    const closeSpy = vi
      .spyOn(joinModal, "close")
      .mockImplementation(() => history.replaceState(null, "", "/"));
    // The viewer tears the menu down like a game start. A modal the router
    // opened clears the hash when it closes (ModalRouter.syncClosed).
    const gameStarting = vi.fn();
    document.addEventListener("game-starting", gameStarting);
    // Loaded on demand: the router loads a modal before opening it.
    await loadModal("help-modal");
    const help = document.querySelector("help-modal") as unknown as {
      close: () => void;
    };
    const helpClose = vi
      .spyOn(help, "close")
      .mockImplementation(() =>
        history.replaceState(null, "", window.location.pathname),
      );
    window.location.hash = "#replay-viewer=dqKzit4cWu";
    window.dispatchEvent(new Event("hashchange"));
    await vi.waitFor(() =>
      expect(
        (document.querySelector("replay-viewer") as { gameID?: string } | null)
          ?.gameID,
      ).toBe("dqKzit4cWu"),
    );
    expect(gameStarting).toHaveBeenCalledOnce();
    expect(helpClose).toHaveBeenCalled();
    // A lobby modal is closed like at a game start: disarmed, so closing it
    // doesn't leave a lobby it never joined.
    expect(disarmSpy).toHaveBeenCalled();
    expect(closeWithoutLeavingSpy).toHaveBeenCalled();
    // Kept, so a reload opens the replay again.
    expect(window.location.hash).toBe("#replay-viewer=dqKzit4cWu");
    document.removeEventListener("game-starting", gameStarting);
    helpClose.mockRestore();
    closeSpy.mockRestore();
    disarmSpy.mockRestore();
    closeWithoutLeavingSpy.mockRestore();
  });
});
