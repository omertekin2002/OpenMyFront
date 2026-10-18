import { Cosmetics } from "@openfront/shared/CosmeticSchemas";
import { PlayerCosmeticRefs } from "@openfront/shared/WireSchemas";
import fs from "fs/promises";
import { base64url } from "jose";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FailOpenPrivilegeChecker,
  PrivilegeCheckerImpl,
  SelfHostPrivilegeChecker,
} from "../../src/server/Privilege";
import { PrivilegeRefresher } from "../../src/server/PrivilegeRefresher";

// PrivilegeRefresher imports PollingLoop, whose module-level logger would
// otherwise set up winston and OpenTelemetry.
vi.mock("../../src/server/Logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(
  __dirname,
  "../../resources/cosmetics/cosmetics.json",
);

// 2x2, version 0 (DefaultPattern's data).
const PATTERN = "AAAAAA";
const ocean = {
  name: "ocean",
  primaryColor: "#123456",
  secondaryColor: "#abcdef",
};

const catalog: Cosmetics = {
  colorPalettes: { ocean },
  patterns: {
    stripes: {
      name: "stripes",
      pattern: PATTERN,
      product: null,
      rarity: "common",
    },
    // Unknown version byte, so the data fails to decode.
    broken: {
      name: "broken",
      pattern: "AQAAAA",
      product: null,
      rarity: "rare",
    },
  },
  flags: {
    cool_flag: {
      name: "cool_flag",
      url: "https://example.com/cool.png",
      product: null,
      rarity: "common",
    },
  },
  skins: {
    mountain: {
      name: "mountain",
      url: "https://example.com/mountain.png",
      product: null,
      rarity: "common",
    },
  },
  crowns: {
    gold_crown: {
      name: "gold_crown",
      url: "https://example.com/gold.png",
      product: null,
      rarity: "common",
    },
  },
  effects: {
    transportShipTrail: {
      spectrum: {
        name: "spectrum",
        effectType: "transportShipTrail",
        attributes: {
          type: "gradient",
          colors: ["#ff0000", "#0000ff"],
          colorSize: 16,
          movementSpeed: 0.15,
        },
        product: null,
        rarity: "legendary",
      },
    },
    nukeExplosion: {
      atom_boom: {
        name: "atom_boom",
        effectType: "nukeExplosion",
        attributes: {
          type: "shockwave",
          nukeType: "atom",
          colors: ["#ff0000"],
          size: 50,
          speed: 50,
          thickness: 4,
          transitionSpeed: 5,
        },
        product: null,
        rarity: "common",
      },
    },
  },
};

const checker = new SelfHostPrivilegeChecker(catalog, base64url.decode);
const nothing = { type: "allowed", cosmetics: {} };

function mockLog(): any {
  const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  log.child = vi.fn(() => log);
  return log;
}

describe("SelfHostPrivilegeChecker#isAllowed", () => {
  test("resolves a catalog pattern with its data, with and without a palette", () => {
    expect(checker.isAllowed([], { patternName: "stripes" })).toEqual({
      type: "allowed",
      cosmetics: { pattern: { name: "stripes", patternData: PATTERN } },
    });
    expect(
      checker.isAllowed([], {
        patternName: "stripes",
        patternColorPaletteName: "ocean",
      }),
    ).toEqual({
      type: "allowed",
      cosmetics: {
        pattern: { name: "stripes", patternData: PATTERN, colorPalette: ocean },
      },
    });
  });

  test("resolves a country flag and a catalog flag", () => {
    expect(checker.isAllowed([], { flag: "country:us" })).toStrictEqual({
      type: "allowed",
      cosmetics: { flag: "/flags/us.svg" },
    });
    expect(checker.isAllowed([], { flag: "flag:cool_flag" })).toStrictEqual({
      type: "allowed",
      cosmetics: { flag: "https://example.com/cool.png" },
    });
  });

  test("resolves exactly what upstream resolves for an owner of everything", () => {
    const owner = new PrivilegeCheckerImpl(catalog, base64url.decode);
    const flares = ["pattern:*", "flag:*", "skin:*", "crown:*", "effect:*"];
    const refs: PlayerCosmeticRefs[] = [
      {
        patternName: "stripes",
        patternColorPaletteName: "ocean",
        flag: "flag:cool_flag",
        skinName: "mountain",
        crownName: "gold_crown",
        effects: { transportShipTrail: "spectrum", atom: "atom_boom" },
        verified: true,
      },
      // An unknown palette name resolves to no palette upstream too.
      {
        patternName: "stripes",
        patternColorPaletteName: "no_such_palette",
        flag: "country:fr",
      },
    ];
    for (const r of refs) {
      expect(checker.isAllowed([], r)).toStrictEqual(
        owner.isAllowed(flares, r),
      );
    }
  });

  test("drops unknown cosmetics instead of forbidding them", () => {
    const result = checker.isAllowed([], {
      patternName: "ghost",
      flag: "flag:ghost",
      skinName: "ghost",
      crownName: "ghost",
      effects: { transportShipTrail: "ghost" },
    });
    // Strict: no undefined-valued keys are left behind either.
    expect(result).toStrictEqual(nothing);
  });

  test("keeps what resolves and drops the rest", () => {
    const result = checker.isAllowed([], {
      patternName: "broken",
      flag: "country:zzzz",
      skinName: "mountain",
      // A mismatched nukeType slot and the stale bare effectType slot.
      effects: {
        transportShipTrail: "spectrum",
        hydro: "atom_boom",
        nukeExplosion: "atom_boom",
      },
    });
    expect(result).toStrictEqual({
      type: "allowed",
      cosmetics: {
        skin: { name: "mountain", url: "https://example.com/mountain.png" },
        effects: {
          transportShipTrail: {
            name: "spectrum",
            effectType: "transportShipTrail",
          },
        },
      },
    });
    expect(checker.isAllowed([], { flag: "us" })).toStrictEqual(nothing);
  });

  test("drops inherited names like constructor rather than resolving Object members", () => {
    for (const name of ["constructor", "__proto__"]) {
      expect(
        checker.isAllowed([], {
          patternName: name,
          flag: `flag:${name}`,
          skinName: name,
          crownName: name,
          effects: { transportShipTrail: name },
        }),
      ).toStrictEqual(nothing);
      expect(
        checker.isAllowed([], {
          patternName: "stripes",
          patternColorPaletteName: name,
        }),
      ).toEqual({
        type: "allowed",
        cosmetics: { pattern: { name: "stripes", patternData: PATTERN } },
      });
    }
  });

  test("accepts a well-formed #rrggbb colour and drops anything else", () => {
    expect(checker.isAllowed([], { color: "#1a2B3c" })).toStrictEqual({
      type: "allowed",
      cosmetics: { color: { color: "#1a2B3c" } },
    });
    for (const color of [
      "",
      "red",
      "#fff",
      "#12345g",
      "#1234567",
      "rgb(1, 2, 3)",
      "#123456; background: red",
    ]) {
      expect(checker.isAllowed([], { color })).toStrictEqual(nothing);
    }
  });

  test("passes the verified intent through", () => {
    expect(checker.isAllowed([], { verified: true })).toStrictEqual({
      type: "allowed",
      cosmetics: { verified: true },
    });
    expect(checker.isAllowed([], { verified: false })).toStrictEqual(nothing);
  });
});

describe("SelfHostPrivilegeChecker#resolveClanTag", () => {
  test("fails open: there is no reserved-tag list on a self-host", () => {
    expect(checker.resolveClanTag("ABC", [])).toEqual({
      tag: "ABC",
      dropped: false,
    });
    expect(checker.resolveClanTag("ABC", ["other"])).toEqual({
      tag: "ABC",
      dropped: false,
    });
    expect(checker.resolveClanTag(null, [])).toEqual({
      tag: null,
      dropped: false,
    });
  });
});

describe("PrivilegeRefresher#loadBundledCosmetics", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function load(catalogPath?: string) {
    const log = mockLog();
    const refresher = new PrivilegeRefresher("", "", "", log);
    refresher.loadBundledCosmetics(catalogPath);
    return { log, checker: refresher.get() };
  }

  test("loads the bundled resources/cosmetics/cosmetics.json", async () => {
    const { log, checker } = load();
    expect(log.warn).not.toHaveBeenCalled();
    expect(checker).toBeInstanceOf(SelfHostPrivilegeChecker);

    const bundled = JSON.parse(await fs.readFile(BUNDLED, "utf8"));
    const [patternKey, pattern] = Object.entries<{
      name: string;
      pattern: string;
    }>(bundled.patterns)[0];
    const [flagKey, flag] = Object.entries<{ url: string }>(bundled.flags)[0];
    expect(
      checker.isAllowed([], {
        patternName: patternKey,
        flag: `flag:${flagKey}`,
      }),
    ).toEqual({
      type: "allowed",
      cosmetics: {
        pattern: { name: pattern.name, patternData: pattern.pattern },
        flag: flag.url,
      },
    });
  });

  test.each([
    ["missing", null],
    ["not JSON", "{ not json"],
    ["not a catalog", JSON.stringify({ patterns: 42, flags: {} })],
  ])(
    "fails open with one warning when the catalog is %s",
    async (_, content) => {
      tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "self-host-cosmetics-"),
      );
      const catalogPath = path.join(tempDir, "cosmetics.json");
      if (content !== null) await fs.writeFile(catalogPath, content, "utf8");

      const { log, checker } = load(catalogPath);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(checker).toBeInstanceOf(FailOpenPrivilegeChecker);
      // Catalog cosmetics are dropped; the verified intent still passes.
      expect(
        checker.isAllowed([], { flag: "country:us", verified: true }),
      ).toStrictEqual({ type: "allowed", cosmetics: { verified: true } });
    },
  );
});
