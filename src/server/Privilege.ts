import countries from "resources/countries.json";

import { isTemporaryUsername } from "@openfront/shared/ApiSchemas";
import {
  Cosmetics,
  findEffectForSlot,
} from "@openfront/shared/CosmeticSchemas";
import { decodePatternData } from "@openfront/shared/PatternDecoder";
import {
  PlayerColor,
  PlayerCosmeticRefs,
  PlayerCosmetics,
  PlayerCrown,
  PlayerEffect,
  PlayerPattern,
  PlayerSkin,
} from "@openfront/shared/WireSchemas";

const countryCodes = countries.filter((c) => !c.restricted).map((c) => c.code);

export type ClanTagResolution = {
  tag: string | null;
  dropped: boolean;
};

/**
 * The clan-tag ownership rule:
 *   - member of the clan             -> keep the tag
 *   - not a member, tag not reserved -> fictional tag, keep it
 *   - otherwise                      -> drop it (impersonation)
 * `reservedTags` is every registered tag (uppercase).
 */
function decideClanTag(
  censoredTag: string | null,
  ownedClanTags: string[],
  reservedTags: Set<string>,
): ClanTagResolution {
  if (censoredTag === null) return { tag: null, dropped: false };
  const tag = censoredTag.toUpperCase();
  const isMember = ownedClanTags.some((t) => t.toUpperCase() === tag);
  if (isMember || !reservedTags.has(tag)) {
    return { tag: censoredTag, dropped: false };
  }
  return { tag: null, dropped: true };
}

type CosmeticResult =
  | { type: "allowed"; cosmetics: PlayerCosmetics }
  | { type: "forbidden"; reason: string };

export interface PrivilegeChecker {
  isAllowed(flares: string[], refs: PlayerCosmeticRefs): CosmeticResult;
  /**
   * Decide whether a player may wear the given clan tag. Members keep their
   * tag; impersonated or unverifiable tags are dropped. `ownedClanTags` are
   * the tags the player belongs to.
   */
  resolveClanTag(
    clanTag: string | null,
    ownedClanTags: string[],
  ): ClanTagResolution;
}

export class PrivilegeCheckerImpl implements PrivilegeChecker {
  constructor(
    private cosmetics: Cosmetics,
    private b64urlDecode: (base64: string) => Uint8Array,
    // Every registered clan tag (uppercase). Polled by PrivilegeRefresher so
    // ownership is resolved in memory — no per-join existence probe.
    private reservedClanTags: Set<string> = new Set(),
  ) {}

  resolveClanTag(
    censoredTag: string | null,
    ownedClanTags: string[],
  ): ClanTagResolution {
    return decideClanTag(censoredTag, ownedClanTags, this.reservedClanTags);
  }

  isAllowed(flares: string[], refs: PlayerCosmeticRefs): CosmeticResult {
    const cosmetics: PlayerCosmetics = {};
    if (refs.patternName) {
      try {
        cosmetics.pattern = this.isPatternAllowed(
          flares,
          refs.patternName,
          refs.patternColorPaletteName ?? null,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { type: "forbidden", reason: "invalid pattern: " + message };
      }
    }
    if (refs.color) {
      try {
        cosmetics.color = this.isColorAllowed(flares, refs.color);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { type: "forbidden", reason: "invalid color: " + message };
      }
    }
    if (refs.flag) {
      try {
        cosmetics.flag = this.isFlagAllowed(flares, refs.flag);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { type: "forbidden", reason: "invalid flag: " + message };
      }
    }
    if (refs.skinName) {
      try {
        cosmetics.skin = this.isSkinAllowed(flares, refs.skinName);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { type: "forbidden", reason: "invalid skin: " + message };
      }
    }
    if (refs.crownName) {
      try {
        cosmetics.crown = this.isCrownAllowed(flares, refs.crownName);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { type: "forbidden", reason: "invalid crown: " + message };
      }
    }
    if (refs.effects) {
      for (const [slot, name] of Object.entries(refs.effects)) {
        try {
          cosmetics.effects ??= {};
          cosmetics.effects[slot] = this.isEffectAllowed(flares, slot, name);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return { type: "forbidden", reason: "invalid effect: " + message };
        }
      }
    }
    // Entitlement-blind pass-through: isAllowed has no user identity. The
    // account decides the check at join in Worker.ts using the /users/@me
    // response (resolveVerifiedJoin below).
    if (refs.verified === true) {
      cosmetics.verified = true;
    }

    return { type: "allowed", cosmetics };
  }

  // slot = effectType (trails) or nukeType (nuke explosions); see effectTypeForSlot.
  isEffectAllowed(flares: string[], slot: string, name: string): PlayerEffect {
    const found = findEffectForSlot(this.cosmetics, slot, name);
    if (!found) {
      throw new Error(`Effect ${name} not found for slot ${slot}`);
    }
    if (
      flares.includes("effect:*") ||
      flares.includes(`effect:${found.name}`)
    ) {
      return {
        name: found.name,
        effectType: found.effectType,
      };
    }
    throw new Error(`No flares for effect ${name}`);
  }

  isSkinAllowed(flares: string[], name: string): PlayerSkin {
    const found = this.cosmetics.skins?.[name];
    if (!found) throw new Error(`Skin ${name} not found`);
    if (flares.includes("skin:*") || flares.includes(`skin:${found.name}`)) {
      return { name: found.name, url: found.url };
    }
    throw new Error(`No flares for skin ${name}`);
  }

  isCrownAllowed(flares: string[], name: string): PlayerCrown {
    const found = this.cosmetics.crowns?.[name];
    if (!found) throw new Error(`Crown ${name} not found`);
    if (flares.includes("crown:*") || flares.includes(`crown:${found.name}`)) {
      return { name: found.name, url: found.url };
    }
    throw new Error(`No flares for crown ${name}`);
  }

  isPatternAllowed(
    flares: readonly string[],
    name: string,
    colorPaletteName: string | null,
  ): PlayerPattern {
    // Look for the pattern in the cosmetics.json config
    const found = this.cosmetics.patterns[name];
    if (!found) throw new Error(`Pattern ${name} not found`);

    try {
      decodePatternData(found.pattern, this.b64urlDecode);
    } catch (e) {
      // can be enabled once we can use {cause: error} in Error constructor starting with ES2022
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Invalid pattern ${name}`);
    }

    const colorPalette = this.cosmetics.colorPalettes?.[colorPaletteName ?? ""];

    if (flares.includes("pattern:*")) {
      return {
        name: found.name,
        patternData: found.pattern,
        colorPalette,
      } satisfies PlayerPattern;
    }

    const flareName =
      `pattern:${found.name}` +
      (colorPaletteName ? `:${colorPaletteName}` : "");

    if (flares.includes(flareName)) {
      // Player has a flare for this pattern
      return {
        name: found.name,
        patternData: found.pattern,
        colorPalette,
      } satisfies PlayerPattern;
    } else {
      throw new Error(`No flares for pattern ${name}`);
    }
  }

  isFlagAllowed(flares: string[], flagRef: string): string {
    if (flagRef.startsWith("flag:")) {
      const key = flagRef.slice("flag:".length);
      const found = this.cosmetics.flags[key];
      if (!found) throw new Error(`Flag ${key} not found`);

      if (flares.includes("flag:*") || flares.includes(`flag:${found.name}`)) {
        return found.url;
      }

      throw new Error(`No flares for flag ${key}`);
    } else if (flagRef.startsWith("country:")) {
      const code = flagRef.slice("country:".length);
      if (!countryCodes.includes(code)) {
        throw new Error(`invalid country code`);
      }
      return `/flags/${code}.svg`;
    } else {
      throw new Error(`invalid flag prefix`);
    }
  }

  isColorAllowed(flares: string[], color: string): PlayerColor {
    const allowedColors = flares
      .filter((flare) => flare.startsWith("color:"))
      .map((flare) => flare.split(":")[1]);
    if (!allowedColors.includes(color)) {
      throw new Error(`Color ${color} not allowed`);
    }
    return { color };
  }
}

export class FailOpenPrivilegeChecker implements PrivilegeChecker {
  isAllowed(flares: string[], refs: PlayerCosmeticRefs): CosmeticResult {
    // Catalog cosmetics can't be resolved without the cosmetics data, but the
    // verified intent isn't a catalog item — pass it through; the Worker's
    // resolveVerifiedJoin decides it against the account at join.
    return {
      type: "allowed",
      cosmetics: refs.verified === true ? { verified: true } : {},
    };
  }

  // No reserved-tag list while cosmetics infra is unavailable (e.g. during
  // development), so ownership can't be verified. Fail open and keep the tag
  // rather than blocking everyone whenever the API service is down.
  resolveClanTag(
    censoredTag: string | null,
    ownedClanTags: string[],
  ): ClanTagResolution {
    return { tag: censoredTag, dropped: false };
  }
}

// Self-host (OpenMyFront): no accounts or store, so every cosmetic is free and
// every player holds every wildcard flare.
const SELF_HOST_FLARES = [
  "pattern:*",
  "flag:*",
  "skin:*",
  "crown:*",
  "effect:*",
];

// Custom colours need a `color:` flare upstream. Everything is free here, so
// any well-formed #rrggbb is accepted (the shape upstream's colour swatches
// sent; today's client sends none). refs.color is an unbounded string that is
// relayed to every client and fed to colord(), so anything else is dropped.
const SELF_HOST_COLOR = /^#[0-9a-f]{6}$/i;

// The resolver's result, or undefined when it throws (the ref doesn't resolve).
function orDrop<T>(resolve: () => T): T | undefined {
  try {
    return resolve();
  } catch {
    return undefined;
  }
}

function ownEntries<T>(section: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), section);
}

/**
 * Resolves refs as an owner of everything in the catalog, through
 * PrivilegeCheckerImpl, so the cosmetics match what upstream sends an owner.
 * Never forbidden (Worker.ts closes the socket on that): a ref that doesn't
 * resolve (unknown name, bad pattern data, bad country code, bad effect slot)
 * is dropped instead.
 */
export class SelfHostPrivilegeChecker implements PrivilegeChecker {
  private owner: PrivilegeCheckerImpl;

  constructor(
    cosmetics: Cosmetics,
    b64urlDecode: (base64: string) => Uint8Array,
  ) {
    // The resolvers index plain objects, so with every wildcard granted a
    // forged name like "constructor" would find an inherited Object member (a
    // skin without a url, a function as palette) and fail the game-start
    // schema for the whole lobby. Effects already check the entry's type.
    this.owner = new PrivilegeCheckerImpl(
      {
        ...cosmetics,
        colorPalettes:
          cosmetics.colorPalettes && ownEntries(cosmetics.colorPalettes),
        patterns: ownEntries(cosmetics.patterns),
        flags: ownEntries(cosmetics.flags),
        skins: cosmetics.skins && ownEntries(cosmetics.skins),
        crowns: cosmetics.crowns && ownEntries(cosmetics.crowns),
      },
      b64urlDecode,
    );
  }

  isAllowed(flares: string[], refs: PlayerCosmeticRefs): CosmeticResult {
    const { patternName, flag, skinName, crownName, color } = refs;
    const palette = refs.patternColorPaletteName ?? null;
    const all = SELF_HOST_FLARES;
    const cosmetics: PlayerCosmetics = {};
    const pattern = patternName
      ? orDrop(() => this.owner.isPatternAllowed(all, patternName, palette))
      : undefined;
    if (pattern) cosmetics.pattern = pattern;
    const flagUrl = flag
      ? orDrop(() => this.owner.isFlagAllowed(all, flag))
      : undefined;
    if (flagUrl) cosmetics.flag = flagUrl;
    const skin = skinName
      ? orDrop(() => this.owner.isSkinAllowed(all, skinName))
      : undefined;
    if (skin) cosmetics.skin = skin;
    const crown = crownName
      ? orDrop(() => this.owner.isCrownAllowed(all, crownName))
      : undefined;
    if (crown) cosmetics.crown = crown;
    for (const [slot, name] of Object.entries(refs.effects ?? {})) {
      const effect = orDrop(() => this.owner.isEffectAllowed(all, slot, name));
      if (effect) {
        cosmetics.effects ??= {};
        cosmetics.effects[slot] = effect;
      }
    }
    if (color && SELF_HOST_COLOR.test(color)) cosmetics.color = { color };
    // Passed through like the other checkers; resolveVerifiedJoin decides it.
    if (refs.verified === true) cosmetics.verified = true;
    return { type: "allowed", cosmetics };
  }

  // No reserved-tag list without the central API: fail open, keep the tag.
  resolveClanTag(
    censoredTag: string | null,
    ownedClanTags: string[],
  ): ClanTagResolution {
    return { tag: censoredTag, dropped: false };
  }
}

/**
 * Decide whether a join keeps the verified check.
 *
 * `cosmetics.verified` on the join message is INTENT ("play under my account
 * name"), never a claim the server takes on trust. The check is kept only
 * when the account vouches for the name the player is actually joining under
 * (spec, 10 Sept 2026):
 *
 *   - the account is entitled (premium or indefinite);
 *   - it renders bare: display name equals base, which is what holding the
 *     bare claim looks like from /users/@me, and the base is not a
 *     TEMPORARY#### placeholder, which is minted with its claim but is not a
 *     name the player chose (the client refuses to offer it for the same
 *     reason, see accountVerifiedName);
 *   - the join name is exactly that bare name.
 *
 * The join name is never replaced. It has already been through censorPlayer
 * and join_verify, and that pipeline is the only thing standing between an
 * account name that was blocklisted after it was set and the lobby; a name
 * substituted here would skip it. So a subscriber whose bare name someone
 * else holds, a hand-crafted join under some other name, and a join whose
 * name the screening rewrote all land the same way: the screened name stands
 * and the check is removed.
 *
 * `account` null is an anonymous persistent-ID join, which only exists in
 * Dev; intent is kept there so the badge stays locally testable.
 */
export function resolveVerifiedJoin(
  cosmetics: PlayerCosmetics,
  joinUsername: string,
  account: {
    username?: string | null;
    usernameBase?: string | null;
    usernameStatus?: string;
  } | null,
): "verified" | "custom" | "dev" {
  if (cosmetics.verified !== true) return "custom";
  if (account === null) return "dev";
  const entitled =
    account.usernameStatus === "premium" ||
    account.usernameStatus === "indefinite";
  const bare =
    typeof account.username === "string" &&
    account.username.length > 0 &&
    account.username === account.usernameBase &&
    !isTemporaryUsername(account.usernameBase);
  if (entitled && bare && joinUsername === account.username) {
    return "verified";
  }
  delete cosmetics.verified;
  return "custom";
}
