import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getGamesPlayed } = vi.hoisted(() => ({
  getGamesPlayed: vi.fn(() => 0),
}));
vi.mock("../../src/client/Utils", () => ({ getGamesPlayed }));

import {
  NavNotificationsController,
  navNotifications,
} from "../../src/client/components/NavNotificationsController";

// Two components with their own controller — e.g. the desktop bar's and the
// mobile top bar's <nav-utility-icons>, which both carry the help "?". News
// and store dots are gone on this self-host, so help is the only dot.
function host() {
  const requestUpdate = vi.fn();
  const stub = {
    requestUpdate,
    addController: () => {},
    removeController: () => {},
    updateComplete: Promise.resolve(true),
  };
  const controller = new NavNotificationsController(stub as never);
  controller.hostConnected();
  return { controller, requestUpdate };
}

describe("nav notifications", () => {
  beforeEach(() => {
    navNotifications.reset();
    localStorage.clear();
    getGamesPlayed.mockReturnValue(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shares state across components, so dismissing help clears it everywhere", () => {
    const desktop = host();
    const mobile = host();
    expect(desktop.controller.showHelpDot()).toBe(true);
    expect(mobile.controller.showHelpDot()).toBe(true);

    desktop.controller.onHelpClick();

    expect(desktop.controller.showHelpDot()).toBe(false);
    expect(mobile.controller.showHelpDot()).toBe(false);
    // Both components re-render off the shared state.
    expect(mobile.requestUpdate).toHaveBeenCalled();
    expect(localStorage.getItem("helpSeen")).toBe("true");
  });

  it("shows the help dot only to newer players who haven't opened help", () => {
    getGamesPlayed.mockReturnValue(10);
    expect(host().controller.showHelpDot()).toBe(false);

    getGamesPlayed.mockReturnValue(9);
    expect(host().controller.showHelpDot()).toBe(true);

    // A dismissal from an earlier page load is read back from storage.
    navNotifications.reset();
    localStorage.setItem("helpSeen", "true");
    expect(host().controller.showHelpDot()).toBe(false);
  });
});
