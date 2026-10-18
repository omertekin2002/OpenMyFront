import { whenPageIdle } from "./WhenPageIdle";

/**
 * The modals the homepage opens only on request are their own chunks, so the
 * homepage loads without them. Their elements are in index.html from the
 * start and upgrade once their module arrives: showPage and the modal router
 * load it before opening one, and prefetchModals loads them all in the
 * background once the page has loaded, so a click rarely waits on one.
 */
const modules: Record<string, () => Promise<unknown>> = {
  "detailed-view-modal": () => import("./components/DetailedGameViewModal"),
  "help-modal": () => import("./HelpModal"),
  "host-lobby-modal": () => import("./HostLobbyModal"),
  "inventory-modal": () => import("./InventoryModal"),
  "join-lobby-modal": () => import("./JoinLobbyModal"),
  "single-player-modal": () => import("./SinglePlayerModal"),
  "troubleshooting-modal": () => import("./TroubleshootingModal"),
  "user-setting": () => import("./UserSettingModal"),
};

/** Loads the module that defines `tag`, if it's one loaded on demand. */
export async function loadModal(tag: string): Promise<void> {
  await modules[tag]?.();
}

/**
 * Calls `open` once `tag`'s module has loaded, for code that opens one of
 * these modals directly rather than through showPage or the modal router.
 */
export function whenModalLoaded(tag: string, open: () => void): void {
  loadModal(tag).then(open, (err) =>
    console.error(`${tag} failed to load:`, err),
  );
}

export function prefetchModals(): void {
  // A failed prefetch is left to the open that needs the chunk.
  whenPageIdle(() => {
    for (const load of Object.values(modules)) void load().catch(() => {});
  });
}
