import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { EventBus } from "@openfront/shared/EventBus";
import { html, LitElement, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  getTranslatedPlayerTeamLabel,
  homeHref,
  translateText,
} from "../../../client/Utils";
import { Controller } from "../../Controller";
import { gamePortal } from "../../GamePortal";
import { PlaySoundEffectEvent } from "../../sound/Sounds";
import { SendWinnerEvent } from "../../Transport";
import { GameView } from "../../view";

@customElement("win-modal")
export class WinModal extends LitElement implements Controller {
  public game: GameView;
  public eventBus: EventBus;

  private hasShownDeathModal = false;

  @state()
  isVisible = false;

  @state()
  private isWin = false;

  private _title: string;

  // Override to prevent shadow DOM creation
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
  }

  render() {
    return html`
      <div
        class="${this.isVisible
          ? "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-800/70 p-4 md:p-6 shrink-0 rounded-lg z-[10010] shadow-2xl backdrop-blur-xs text-white w-[min(90vw,700px)] max-w-[90%] max-h-[90dvh] overflow-hidden flex flex-col"
          : "hidden"}"
      >
        <h2 class="m-0 mb-4 text-[26px] text-center text-white shrink-0">
          ${this._title || ""}
        </h2>
        <!-- Leaving is the quieter action, on the left; staying in the game
             is the main one, on the right. -->
        <div class="mt-4 flex flex-wrap justify-between gap-2.5 shrink-0">
          ${this.actionButton(
            "quiet",
            translateText("win_modal.exit"),
            () => this._handleExit(),
            "exit",
          )}
          ${this.actionButton(
            "main",
            this.game?.myPlayer()?.isAlive()
              ? translateText("win_modal.keep")
              : translateText("win_modal.spectate"),
            () => this.hide(),
            "keep",
          )}
        </div>
        ${this.renderActionStyles()}
      </div>
    `;
  }

  // The modal's own buttons: a tinted gradient with a coloured border, and on
  // hover they lift, glow and a light streak sweeps across. "main" is the blue
  // action (keep playing); "quiet" is leaving.
  private actionButton(
    tone: "main" | "quiet",
    label: string,
    onClick: () => void,
    action: string,
  ): TemplateResult {
    return html`<button
      type="button"
      data-win-action=${action}
      class="win-action win-action-${tone} flex-1"
      @click=${onClick}
    >
      <span class="relative">${label}</span>
    </button>`;
  }

  private renderActionStyles(): TemplateResult {
    return html`<style>
      .win-action {
        position: relative;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 3rem;
        padding: 0.75rem 1rem;
        border-radius: 0.75rem;
        border: 1px solid;
        color: #fff;
        font-weight: 700;
        font-size: 1.0625rem;
        line-height: 1.25;
        letter-spacing: 0.02em;
        cursor: pointer;
        transition:
          transform 200ms ease-out,
          box-shadow 200ms ease-out,
          border-color 200ms ease-out,
          background 200ms ease-out;
      }
      /* The light streak, parked off the left edge until hover. */
      .win-action::after {
        content: "";
        position: absolute;
        top: -20%;
        bottom: -20%;
        left: -60%;
        width: 40%;
        transform: skewX(-20deg);
        background: linear-gradient(
          90deg,
          transparent,
          rgba(255, 255, 255, 0.28),
          transparent
        );
        pointer-events: none;
      }
      /* The streak sweeps across on the way in only; leaving, it snaps back
         out of sight rather than sweeping back across the button. */
      .win-action:hover::after,
      .win-action:focus-visible::after {
        left: 130%;
        transition: left 550ms ease-out;
      }
      .win-action:hover,
      .win-action:focus-visible {
        transform: translateY(-2px);
      }
      .win-action:active {
        transform: translateY(0) scale(0.98);
      }
      .win-action:focus-visible {
        outline: 2px solid #3fa9f5;
        outline-offset: 2px;
      }
      .win-action-main {
        background: linear-gradient(
          to top,
          rgba(0, 132, 209, 0.95) 0%,
          rgba(0, 101, 170, 0.8) 100%
        );
        border-color: rgba(63, 169, 245, 0.55);
      }
      .win-action-main:hover,
      .win-action-main:focus-visible {
        background: linear-gradient(
          to top,
          rgba(29, 150, 230, 1) 0%,
          rgba(0, 120, 200, 0.9) 100%
        );
        border-color: rgba(125, 200, 255, 0.9);
        box-shadow: 0 0 20px rgba(63, 169, 245, 0.55);
      }
      .win-action-quiet {
        background: linear-gradient(
          to top,
          rgba(80, 80, 80, 0.55) 0%,
          rgba(15, 15, 20, 0.85) 100%
        );
        border-color: rgba(255, 255, 255, 0.15);
      }
      .win-action-quiet:hover,
      .win-action-quiet:focus-visible {
        background: linear-gradient(
          to top,
          rgba(110, 110, 120, 0.6) 0%,
          rgba(25, 25, 32, 0.9) 100%
        );
        border-color: rgba(255, 255, 255, 0.35);
        box-shadow: 0 0 14px rgba(255, 255, 255, 0.25);
      }
      @media (prefers-reduced-motion: reduce) {
        .win-action,
        .win-action::after {
          transition: none;
        }
        .win-action:hover,
        .win-action:focus-visible,
        .win-action:active {
          transform: none;
        }
      }
    </style>`;
  }

  async show() {
    gamePortal.gameplayStop();
    this.isVisible = true;
    this.requestUpdate();
  }

  hide() {
    this.isVisible = false;
    this.requestUpdate();
  }

  private _handleExit() {
    this.hide();
    window.location.href = homeHref();
  }

  init() {}

  tick() {
    const myPlayer = this.game.myPlayer();
    if (
      !this.hasShownDeathModal &&
      myPlayer &&
      !myPlayer.isAlive() &&
      !this.game.inSpawnPhase() &&
      myPlayer.hasSpawned()
    ) {
      this.hasShownDeathModal = true;
      this._title = translateText("win_modal.died");
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
      this.show();
    }
    const updates = this.game.updatesSinceLastTick();
    const winUpdates = updates?.[GameUpdateType.Win] ?? [];
    winUpdates.forEach((wu) => {
      if (wu.winner === undefined) {
        // Match cancelled (e.g. a ranked 2v2 that didn't fill or fully
        // spawn): the game ends with no winner. Still vote the result to the
        // server so the record is archived winnerless (never ranked).
        this.eventBus.emit(new SendWinnerEvent(undefined, wu.allPlayersStats));
        this._title = translateText("win_modal.match_cancelled");
        this.isWin = false;
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "team") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        if (wu.winner[1] === this.game.myPlayer()?.team()) {
          this._title = translateText("win_modal.your_team");
          this.isWin = true;
          gamePortal.happytime();
        } else {
          this._title = translateText("win_modal.other_team", {
            team: getTranslatedPlayerTeamLabel(wu.winner[1]),
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      } else if (wu.winner[0] === "nation") {
        this.eventBus.emit(new SendWinnerEvent(wu.winner, wu.allPlayersStats));
        this._title = translateText("win_modal.nation_won", {
          nation: wu.winner[1],
        });
        this.isWin = false;
        this.playEndOfGameSound();
        this.show();
      } else {
        const winner = this.game.playerByClientID(wu.winner[1]);
        if (!winner?.isPlayer()) return;
        const winnerClient = winner.clientID();
        if (winnerClient !== null) {
          this.eventBus.emit(
            new SendWinnerEvent(["player", winnerClient], wu.allPlayersStats),
          );
        }
        if (
          winnerClient !== null &&
          winnerClient === this.game.myPlayer()?.clientID()
        ) {
          this._title = translateText("win_modal.you_won");
          this.isWin = true;
          gamePortal.happytime();
        } else {
          this._title = translateText("win_modal.other_won", {
            player: winner.displayName(),
          });
          this.isWin = false;
        }
        this.playEndOfGameSound();
        history.replaceState(null, "", `${window.location.pathname}?replay`);
        this.show();
      }
    });
  }

  private playEndOfGameSound(): void {
    if (this.isWin) {
      this.eventBus.emit(new PlaySoundEffectEvent("victory"));
    } else if (!this.hasShownDeathModal && this.game.myPlayer()?.hasSpawned()) {
      // Spawned check: spectators and replay viewers shouldn't get a
      // personal defeat sting. The cue also already played if the player
      // died earlier (hasShownDeathModal).
      this.eventBus.emit(new PlaySoundEffectEvent("defeat"));
    }
  }
}
