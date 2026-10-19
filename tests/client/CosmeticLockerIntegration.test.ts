import type { UserMeResponse } from "@openfront/shared/ApiSchemas";
import type { Cosmetics } from "@openfront/shared/CosmeticSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserMe } from "../../src/client/Api";
import { userAuth } from "../../src/client/Auth";
import { fetchCosmetics } from "../../src/client/Cosmetics";
import "../../src/client/InventoryModal";
import type { InventoryModal } from "../../src/client/InventoryModal";
import { modalRouter } from "../../src/client/ModalRouter";
import {
  PATTERN_KEY,
  USER_SETTINGS_CHANGED_EVENT,
  UserSettings,
} from "../../src/client/UserSettings";
import type { CosmeticCard } from "../../src/client/components/CosmeticCard";

vi.mock("../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Api")>()),
  getUserMe: vi.fn(),
}));

vi.mock("../../src/client/Auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Auth")>()),
  userAuth: vi.fn(),
}));

vi.mock("../../src/client/Cosmetics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Cosmetics")>()),
  fetchCosmetics: vi.fn(),
}));

const catalog = {
  patterns: {
    stripes: {
      name: "stripes",
      pattern: "AAAAAA",
      product: null,
      priceHard: 120,
      rarity: "rare",
      affiliateCode: null,
      colorPalettes: [
        { name: "yellow", isArchived: false },
        { name: "red", isArchived: false },
        { name: "blue", isArchived: false },
        { name: "green", isArchived: false },
      ],
    },
  },
  colorPalettes: {
    yellow: {
      name: "yellow",
      primaryColor: "#eab308",
      secondaryColor: "#713f12",
    },
    red: {
      name: "red",
      primaryColor: "#ef4444",
      secondaryColor: "#7f1d1d",
    },
    blue: {
      name: "blue",
      primaryColor: "#3b82f6",
      secondaryColor: "#1e3a8a",
    },
    green: {
      name: "green",
      primaryColor: "#22c55e",
      secondaryColor: "#14532d",
    },
  },
  flags: {},
  crowns: {},
  skins: {},
  effects: {},
} as unknown as Cosmetics;

const userFixture = {
  user: {},
  player: {
    publicId: "locker-integration-player",
    adfree: false,
    unlimitedRanked: false,
    canCreatePublicLobbies: false,
    achievements: { singleplayerMap: [] },
    friends: [],
    subscription: null,
    currency: { soft: 0, hard: 500 },
    flares: ["pattern:stripes:blue", "pattern:stripes:green"],
  },
} as unknown as UserMeResponse;

const yellowKey = "pattern:stripes:yellow";
const redKey = "pattern:stripes:red";
const blueKey = "pattern:stripes:blue";
const greenKey = "pattern:stripes:green";

function cardFor(root: InventoryModal, key: string): CosmeticCard | undefined {
  return [...root.querySelectorAll<CosmeticCard>("cosmetic-card")].find(
    (candidate) =>
      candidate.resolved.key === key ||
      candidate.variants.some((variant) => variant.key === key),
  );
}

function expectNoNestedInteractiveControls(root: ParentNode): void {
  const interactive = "button, a, input, select, textarea, [role='button']";
  for (const control of root.querySelectorAll(interactive)) {
    expect(control.querySelector(interactive)).toBeNull();
  }
}

describe("Cosmetic locker integration", () => {
  let inventory: InventoryModal;
  let languageFixture: HTMLElement;
  let settingsChangeListener: EventListener | undefined;

  Element.prototype.animate ??= () => ({ cancel: () => {} }) as Animation;

  beforeEach(async () => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    new UserSettings().removeCached(PATTERN_KEY);

    const translations = {
      "common.back": "Back",
      "inventory.equipped": "Equipped",
      "inventory.loadout": "Loadout",
      "inventory.showing_effects": "{count} effects equipped",
      "store.crowns": "Crowns",
      "store.effects": "Effects",
      "store.flags": "Flags",
      "store.patterns": "Skins",
    };
    languageFixture = document.createElement("lang-selector");
    Object.assign(languageFixture, {
      translations,
      defaultTranslations: translations,
      currentLang: "en",
    });
    document.body.appendChild(languageFixture);

    vi.mocked(fetchCosmetics).mockReset();
    vi.mocked(fetchCosmetics).mockResolvedValue(catalog);
    vi.mocked(getUserMe).mockReset();
    vi.mocked(getUserMe).mockResolvedValue(userFixture);
    vi.mocked(userAuth).mockReset();
    vi.mocked(userAuth).mockResolvedValue({ jwt: "test-token" } as never);

    inventory = document.createElement("inventory-modal") as InventoryModal;
    inventory.id = "page-inventory";
    inventory.inline = true;
    document.body.appendChild(inventory);
    Object.assign(inventory as unknown as Record<string, unknown>, {
      cosmetics: catalog,
      userMeResponse: userFixture,
      ownershipState: "loaded",
      isLoading: false,
      loadFailed: false,
    });
    inventory.requestUpdate();
    await inventory.updateComplete;

    modalRouter.register("inventory", {
      tag: "inventory-modal",
      pageId: "page-inventory",
    });
  });

  afterEach(() => {
    if (settingsChangeListener) {
      window.removeEventListener(
        `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`,
        settingsChangeListener,
      );
      settingsChangeListener = undefined;
    }
    inventory.remove();
    languageFixture.remove();
    localStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("equips a colour variant from its swatch, writing settings once", async () => {
    const settingsEvent = `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`;
    let settingsChangeCount = 0;
    settingsChangeListener = () => settingsChangeCount++;
    window.addEventListener(settingsEvent, settingsChangeListener);

    inventory.open({ tab: "skins" });
    await inventory.updateComplete;

    cardFor(inventory, blueKey)!
      .querySelector<HTMLButtonElement>(`[data-variant-key="${blueKey}"]`)!
      .click();
    await inventory.updateComplete;

    expect(settingsChangeCount).toBe(1);
    expect(
      new UserSettings().getSelectedPatternName(catalog)?.colorPalette?.name,
    ).toBe("blue");
    expect(cardFor(inventory, blueKey)?.state).toBe("equipped");
  });

  it("resynchronizes Inventory to a distinct external settings variant", async () => {
    const settingsEvent = `${USER_SETTINGS_CHANGED_EVENT}:${PATTERN_KEY}`;
    new UserSettings().setSelectedPatternName(blueKey);
    inventory.open({ tab: "skins" });
    await inventory.updateComplete;
    expect(cardFor(inventory, blueKey)?.state).toBe("equipped");

    new UserSettings().setSelectedPatternName(greenKey);
    window.dispatchEvent(new CustomEvent(settingsEvent));
    await inventory.updateComplete;
    expect(cardFor(inventory, greenKey)?.state).toBe("equipped");
  });

  it("keeps accessible controls and phone layout markers", async () => {
    inventory.open({ tab: "skins" });
    await inventory.updateComplete;

    expectNoNestedInteractiveControls(inventory);

    const inventoryCard = cardFor(inventory, blueKey)!;
    const main = inventoryCard.querySelector<HTMLButtonElement>(
      "button[data-cosmetic-main]",
    );
    expect(main?.tagName).toBe("BUTTON");
    expect(main?.type).toBe("button");
    const inventorySwatches = [
      ...inventoryCard.querySelectorAll<HTMLButtonElement>(
        "button[data-variant-key]",
      ),
    ];
    // Self-host: every palette is owned, not just the flared blue and green,
    // and so is the uncoloured pattern.
    expect(
      inventorySwatches.map((swatch) => swatch.dataset.variantKey),
    ).toEqual([yellowKey, redKey, blueKey, greenKey, "pattern:stripes"]);
    for (const swatch of inventorySwatches) {
      expect(swatch.tagName).toBe("BUTTON");
      expect(swatch.type).toBe("button");
    }

    expect(
      inventory
        .querySelector("inventory-loadout-bar")
        ?.querySelector(".overflow-x-auto"),
    ).toBeTruthy();
    expect(
      inventory.querySelector("[data-inventory-grid]")?.classList,
    ).toContain("grid-cols-2");
  });

  it("preserves the Inventory route tab", async () => {
    inventory.open({ tab: "skins" });
    await inventory.updateComplete;
    expect(window.location.hash).toBe("#modal=inventory&tab=skins");

    inventory.setActiveTab("effects");
    await inventory.updateComplete;
    expect(window.location.hash).toBe("#modal=inventory&tab=effects");

    history.replaceState(null, "", "/#modal=inventory&tab=crowns");
    expect(modalRouter.routeFromHash()).toBe(true);
    await vi.waitFor(() =>
      expect((inventory as unknown as { activeTab: string }).activeTab).toBe(
        "crowns",
      ),
    );
    expect(window.location.hash).toBe("#modal=inventory&tab=crowns");
  });
});
