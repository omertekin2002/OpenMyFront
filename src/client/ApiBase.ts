import { ClientEnv } from "./ClientEnv";

// The account/shop API origin (api.<audience>). Lives apart from Api.ts so
// modules that Api.ts itself depends on (ServerList) can reach it without an
// import cycle; Api.ts re-exports both for its existing importers.

export function getApiBase() {
  // OpenMyFront: there is no central account/shop API. Point every call at a
  // same-origin endpoint that always answers 404 (see Master.ts), so a public
  // page never probes a local-network address like localhost:8787 (which
  // makes Chrome ask players for local-network access).
  return `${window.location.origin}/api/noapi`;
}

export function getAudience() {
  // Sourced from BOOTSTRAP_CONFIG (server/desktop-injected) rather than
  // window.location, so the desktop app (app://openfront) targets real infra.
  return ClientEnv.jwtAudience();
}
