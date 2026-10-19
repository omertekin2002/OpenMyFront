import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEnv } from "../../src/client/ClientEnv";

vi.mock("../../src/client/LobbySocket", () => ({
  PublicLobbySocket: class {
    start(): void {}
    stop(): void {}
  },
}));

const lastBroadcast = vi.hoisted(() => ({
  current: null as { response: UserMeResponse | false } | null,
}));

vi.mock("../../src/client/UserMeBroadcast", () => ({
  lastUserMeResponse: () => lastBroadcast.current,
}));

// Registers <game-mode-selector> as a side effect.
import "../../src/client/GameModeSelector";

type Selector = HTMLElement & { updateComplete: Promise<unknown> };

function me(trustTier: "trusted" | "untrusted"): UserMeResponse {
  return {
    user: { email: "player@example.com" },
    player: { trustTier },
  } as unknown as UserMeResponse;
}

async function mount(): Promise<Selector> {
  const selector = document.createElement("game-mode-selector") as Selector;
  document.body.appendChild(selector);
  await selector.updateComplete;
  return selector;
}

async function broadcast(
  selector: Selector,
  response: UserMeResponse | false,
): Promise<void> {
  document.dispatchEvent(
    new CustomEvent("userMeResponse", { detail: response }),
  );
  await selector.updateComplete;
}

// No lobbies are pushed, so any lock on the page would be a Ranked button's.
function trustLock(selector: Selector): HTMLElement | null {
  return selector.querySelector("[data-trust]");
}

function buttonLabelled(
  selector: Selector,
  key: string,
): HTMLButtonElement | undefined {
  return [...selector.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(key),
  );
}

beforeEach(() => {
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "dev",
    numWorkers: 1,
    turnstileSiteKey: "",
    jwtAudience: "test",
    instanceId: "test",
    gitCommit: "test",
  };
  ClientEnv.reset();
  lastBroadcast.current = null;
});

afterEach(() => {
  document.body.innerHTML = "";
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
});

// Ranked matchmaking needs the central API, so this self-host has no Ranked
// card: the multiplayer row is Create and Join, and nobody sees a trust lock.
describe("no Ranked button on a self-host", () => {
  it.each([
    ["before /users/@me has answered", null],
    ["for a trusted viewer", me("trusted")],
    ["for an untrusted viewer", me("untrusted")],
    ["when signed out", false],
  ] as const)(
    "shows no Ranked button or trust lock %s",
    async (_, response) => {
      const selector = await mount();
      if (response !== null) await broadcast(selector, response);
      expect(
        buttonLabelled(selector, "mode_selector.ranked_title"),
      ).toBeUndefined();
      expect(trustLock(selector)).toBeNull();
    },
  );

  it("shows no lock for a trusted broadcast that went out before it mounted", async () => {
    lastBroadcast.current = { response: me("trusted") };
    const selector = await mount();
    expect(trustLock(selector)).toBeNull();
  });

  it("offers only Create and Join in the multiplayer row", async () => {
    const selector = await mount();
    const row = buttonLabelled(selector, "main.create")!.parentElement!;
    expect([...row.children].map((b) => b.textContent?.trim())).toEqual([
      "main.create",
      "main.join",
    ]);
  });
});
