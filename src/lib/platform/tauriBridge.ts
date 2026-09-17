/**
 * Waiting for Tauri's IPC bridge before using native events.
 *
 * `listen()` reaches straight into `window.__TAURI_INTERNALS__.transformCallback`.
 * Tauri normally injects that before page scripts run, so a subscription at
 * mount is fine — until the page reloads faster than the injection lands. A
 * dev session re-optimizing Vite dependencies forces exactly that: repeated
 * full reloads, and on the unlucky ones every startup subscription throws
 *
 *     TypeError: Cannot read properties of undefined (reading 'transformCallback')
 *
 * as an unhandled rejection nobody sees, leaving the window blank.
 *
 * So subscriptions wait for the bridge instead of assuming it. There is no
 * event to wait on — Tauri does not announce injection — so this polls, which
 * is why the helper exists once here rather than at each call site.
 */
import {
  emit,
  listen,
  type EventCallback,
  type EventName,
  type Options,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { TauriWebviewEventAuthority } from "./tauriWebviewEventAuthority";

/** Long enough to cover a slow reload, short enough to fail visibly. */
const BRIDGE_TIMEOUT_MS = 10_000;
const BRIDGE_POLL_MS = 25;

function bridgeIsInjected(): boolean {
  // `globalThis`, not `window`: identical in the webview, and it keeps this
  // testable outside a DOM environment.
  const internals = (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  return typeof internals === "object" && internals !== null;
}

/**
 * Resolves once Tauri's IPC bridge is usable.
 *
 * Rejects rather than hanging if it never arrives: a caller that silently
 * waits forever is indistinguishable from the blank window this exists to
 * prevent.
 */
export async function whenTauriBridgeReady(
  timeoutMs: number = BRIDGE_TIMEOUT_MS,
): Promise<void> {
  if (bridgeIsInjected()) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_POLL_MS));
    if (bridgeIsInjected()) return;
  }
  throw new Error("Tauri IPC bridge was not injected before the deadline");
}

/** Emits optimistically and retries only the known late-bridge startup race. */
export async function emitWhenReady<T>(
  event: EventName,
  payload?: T,
): Promise<void> {
  try {
    await emit(event, payload);
  } catch (error) {
    if (bridgeIsInjected()) throw error;
    await whenTauriBridgeReady();
    await emit(event, payload);
  }
}

/**
 * `listen`, retried once the bridge arrives.
 *
 * Optimistic on purpose: it subscribes immediately, because that is what
 * happens in every healthy startup and it keeps this a drop-in replacement.
 * Only when the call throws *and* the bridge is genuinely absent does it wait
 * — that combination is the race, and nothing else is.
 *
 * Deliberately not keyed on the error text. Matching
 * "reading 'transformCallback'" would bind us to a message Tauri is free to
 * reword, and would quietly stop retrying the day it does. Asking whether the
 * bridge exists answers the same question from a fact rather than a string.
 */
async function listenAfterBridgeReady<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  try {
    return await listen<T>(event, handler, options);
  } catch (error) {
    // The bridge is up, so this failure is something else entirely — a bad
    // event name, a plugin refusal. Surface it unchanged.
    if (bridgeIsInjected()) throw error;
    await whenTauriBridgeReady();
    return listen<T>(event, handler, options);
  }
}

const REALM_EVENT_AUTHORITY_KEY = "__dureTauriWebviewEventAuthorityV1";

type TauriEventAuthorityGlobal = typeof globalThis & {
  [REALM_EVENT_AUTHORITY_KEY]?: TauriWebviewEventAuthority;
};

function realmEventAuthority(): TauriWebviewEventAuthority {
  const owner = globalThis as TauriEventAuthorityGlobal;
  owner[REALM_EVENT_AUTHORITY_KEY] ??= new TauriWebviewEventAuthority(
    (event, handler, options) =>
      listenAfterBridgeReady(event, handler, options),
  );
  return owner[REALM_EVENT_AUTHORITY_KEY];
}

/**
 * Registers one local client on the realm-retained native event subscription.
 * The returned cleanup removes only that client; native teardown belongs to
 * WebView realm destruction.
 */
export function listenWhenReady<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  return realmEventAuthority().subscribe(event, handler, options);
}
