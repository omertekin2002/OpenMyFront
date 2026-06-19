import { ReactiveController, ReactiveControllerHost } from "lit";
import { getGamesPlayed } from "../Utils";

const HELP_SEEN_KEY = "helpSeen";

export class NavNotificationsController implements ReactiveController {
  private host: ReactiveControllerHost;

  private _helpSeen = localStorage.getItem(HELP_SEEN_KEY) === "true";

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }

  hostConnected(): void {}

  hostDisconnected(): void {}

  showHelpDot(): boolean {
    return getGamesPlayed() < 10 && !this._helpSeen;
  }

  onHelpClick = (): void => {
    localStorage.setItem(HELP_SEEN_KEY, "true");
    this._helpSeen = true;
    this.host.requestUpdate();
  };
}
