import { RankedType } from "@openfront/engine-api/game/GameTypes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../src/client/hud/layers/WinModal";
import type { WinModal } from "../../../../src/client/hud/layers/WinModal";
import type { GameView } from "../../../../src/client/view";

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      "win_modal.exit": "Exit",
      "win_modal.keep": "Keep Playing",
      "win_modal.spectate": "Spectate",
    };
    return translations[key] || key;
  }),
  getTranslatedPlayerTeamLabel: vi.fn((team: string | null) => team ?? ""),
  homeHref: vi.fn(() => "/"),
}));

vi.mock("../../../../src/client/GamePortal", () => ({
  gamePortal: {
    happytime: vi.fn(),
    gameplayStop: vi.fn(),
  },
}));

function rankedGame(alive: boolean): GameView {
  return {
    myPlayer: () => ({ isAlive: () => alive }),
    config: () => ({
      gameConfig: () => ({ rankedType: RankedType.OneVOne }),
    }),
  } as unknown as GameView;
}

describe("WinModal actions", () => {
  let modal: WinModal | undefined;
  let mockLocationHref = "";

  beforeEach(() => {
    mockLocationHref = "";
    const locationMock = {
      get href() {
        return mockLocationHref;
      },
      set href(value: string) {
        mockLocationHref = value;
      },
    };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    modal?.remove();
    modal = undefined;
    vi.restoreAllMocks();
  });

  async function show(game: GameView): Promise<WinModal> {
    modal = document.createElement("win-modal") as WinModal;
    modal.game = game;
    document.body.appendChild(modal);
    await modal.show();
    await modal.updateComplete;
    return modal;
  }

  function actions(shown: WinModal): HTMLButtonElement[] {
    return [...shown.querySelectorAll<HTMLButtonElement>("[data-win-action]")];
  }

  it("offers only Exit and Keep Playing, with no requeue even after a ranked game", async () => {
    const shown = await show(rankedGame(true));
    expect(actions(shown).map((b) => b.dataset.winAction)).toEqual([
      "exit",
      "keep",
    ]);
    expect(actions(shown).map((b) => b.textContent?.trim())).toEqual([
      "Exit",
      "Keep Playing",
    ]);
  });

  it("offers Spectate in place of Keep Playing once the player is dead", async () => {
    const shown = await show(rankedGame(false));
    expect(actions(shown).map((b) => b.textContent?.trim())).toEqual([
      "Exit",
      "Spectate",
    ]);
  });

  it("leaves for the home page on Exit", async () => {
    const shown = await show(rankedGame(true));
    shown.querySelector<HTMLButtonElement>('[data-win-action="exit"]')!.click();
    await shown.updateComplete;
    expect(window.location.href).toBe("/");
    expect(shown.isVisible).toBe(false);
  });

  it("shows no XP, share, store promotion or wishlist content", async () => {
    const shown = await show(rankedGame(true));
    for (const selector of [
      "game-xp-panel",
      "profile-share",
      "[data-win-cosmetic-promo]",
      "cosmetic-card",
      "purchase-button",
      "steam-wishlist",
      "iframe",
    ]) {
      expect(shown.querySelector(selector)).toBeNull();
    }
    expect(shown.textContent).not.toContain("win_modal.territory_pattern");
    expect(shown.textContent).not.toContain("win_modal.support_openfront");
  });
});
