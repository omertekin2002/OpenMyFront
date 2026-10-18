import { ReactiveController, ReactiveControllerHost } from "lit";
import { getGamesPlayed } from "../Utils";

const HELP_SEEN_KEY = "helpSeen";

/**
 * Shared dot state for the nav.
 *
 * One store, not one per component: the help "?" lives in
 * <nav-utility-icons>, and per-component state would leave other components'
 * copies stale until a reload. News and store dots are gone on this self-host
 * (no news feed, no store), so only the help dot remains.
 */
class NavNotificationsStore {
  private hosts = new Set<ReactiveControllerHost>();
  private loaded = false;

  private _helpSeen = false;

  subscribe(host: ReactiveControllerHost): void {
    this.hosts.add(host);
    this.load();
  }

  unsubscribe(host: ReactiveControllerHost): void {
    this.hosts.delete(host);
  }

  private notify(): void {
    for (const host of this.hosts) host.requestUpdate();
  }

  // Read once per page load; every later subscriber reuses the result.
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;

    this._helpSeen = localStorage.getItem(HELP_SEEN_KEY) === "true";
  }

  showHelpDot(): boolean {
    return getGamesPlayed() < 10 && !this._helpSeen;
  }

  onHelpClick = (): void => {
    localStorage.setItem(HELP_SEEN_KEY, "true");
    this._helpSeen = true;
    this.notify();
  };

  /** Test seam: drop all state so a fresh load re-reads localStorage. */
  reset(): void {
    this.hosts.clear();
    this.loaded = false;
    this._helpSeen = false;
  }
}

export const navNotifications = new NavNotificationsStore();

/**
 * Host-facing view of {@link navNotifications}: keeps the component subscribed
 * for its lifetime and forwards the dot queries and click handlers.
 */
export class NavNotificationsController implements ReactiveController {
  private host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {
    navNotifications.subscribe(this.host);
  }

  hostDisconnected(): void {
    navNotifications.unsubscribe(this.host);
  }

  showHelpDot(): boolean {
    return navNotifications.showHelpDot();
  }

  onHelpClick = (): void => navNotifications.onHelpClick();
}
