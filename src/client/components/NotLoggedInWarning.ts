import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { UserMeResponse } from "../../core/ApiSchemas";
import { hasLinkedAccount } from "../Api";

@customElement("not-logged-in-warning")
export class NotLoggedInWarning extends LitElement {
  @state() private linked = false;

  private _onUserMe = (event: CustomEvent<UserMeResponse | false>) => {
    this.linked = hasLinkedAccount(event.detail);
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(
      "userMeResponse",
      this._onUserMe as EventListener,
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(
      "userMeResponse",
      this._onUserMe as EventListener,
    );
  }

  render() {
    // Sign-in removed on this self-host; never show the "not logged in" CTA.
    return html``;
  }
}
