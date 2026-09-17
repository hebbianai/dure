import type { HubSessions } from "./allSessions";
import { type RememberedListing, type ServerReport, rememberListings } from "./census";
import { describeError } from "./commandError";
import { hubTitle } from "./hubs";
import { t } from "./i18n";
import { type HubLayout, type HubRow, ipc } from "./ipc";

interface CensusState {
  hubs: HubRow[];
  hubLayouts: Record<string, HubLayout>;
  hubSessions: Record<string, HubSessions>;
  serverListings: Record<string, RememberedListing>;
  reports?: ServerReport[];
  hostChecks: Record<string, { reachable: boolean; checkedAt: number }>;
  censusBusy: boolean;
  banner?: string;
}

/** One census owner for explicit full reads and foreground Home catalog reads. */
export function createSessionCensus(options: {
  root: HTMLElement;
  current: () => CensusState;
  epoch: () => number;
  home: () => boolean;
  detached: () => void;
  publish: (patch: Partial<CensusState>, background: boolean, visible: boolean) => void;
  reconcile: (publish: (patch: Partial<CensusState>) => void) => Promise<void>;
}): { refresh: () => Promise<void>; sync: () => void; dispose: () => void } {
  const page = options.root.ownerDocument;
  const viewport = window;
  let disposed = false;
  let suspended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let fullInFlight = false;
  let fullRequested = false;
  let flightEpoch = 0;

  const active = () => !disposed && !suspended && options.root.isConnected &&
    page.visibilityState !== "hidden" && options.home();
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  function sync(): void {
    if (!active()) {
      clearTimer();
      return;
    }
    if (timer !== undefined || inFlight || options.current().hubs.length === 0) return;
    // ponytail: desktop-local and desktop-SSH sessions share the Hub catalog.
    // Read it 2s after completion while Home is visible. The Hub currently
    // offers snapshots, not a watch; keep one request in flight and leave
    // direct SSH (including failed auth) explicit-only.
    timer = setTimeout(() => {
      timer = undefined;
      if (active()) void request(false);
    }, 2_000);
  }

  async function run(full: boolean): Promise<void> {
    const epoch = options.epoch();
    const startedVisible = active();
    const valid = () => !disposed && options.root.isConnected && epoch === options.epoch();
    const publish = (patch: Partial<CensusState>) => {
      if (valid()) options.publish(patch, !full || (startedVisible && !active()), active());
    };
    const hubs = options.current().hubs;
    let revoked = false;
    const probes = Promise.all(hubs.map(async (hub) => {
      try {
        return { hub, probe: await ipc.hubOpen(hub.id) };
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error &&
          error.code === "hub_refused") revoked = true;
        return { hub, probe: undefined };
      }
    }));
    if (full) {
      try {
        const reports = await ipc.takeSessionCensus();
        publish({
          reports,
          serverListings: rememberListings(options.current().serverListings, reports),
          hostChecks: Object.fromEntries(reports.map((report) => [report.server_id,
            { reachable: report.outcome.state === "listed", checkedAt: Date.now() }])),
        });
      } catch (error) {
        publish({ banner: describeError(error) });
      }
    }
    const answers = await probes;
    if (!valid()) return;
    let sessions = options.current().hubSessions;
    let layouts = options.current().hubLayouts;
    for (const { hub, probe } of answers) {
      if (!probe) {
        const remembered = sessions[hub.id];
        if (remembered) sessions = { ...sessions, [hub.id]: { ...remembered, reachable: false } };
      } else {
        sessions = { ...sessions, [hub.id]: {
          hubId: hub.id, hubLabel: hubTitle(hub), reachable: true, sessions: probe.sessions,
        } };
        if (probe.layout) layouts = { ...layouts, [hub.id]: probe.layout };
      }
    }
    const patch = { hubSessions: sessions, hubLayouts: layouts };
    const current = options.current();
    if (full || JSON.stringify(patch) !== JSON.stringify({
      hubSessions: current.hubSessions, hubLayouts: current.hubLayouts,
    })) publish(patch);
    if (revoked) {
      // The native refusal already revoked its paired records. Read that
      // authority again; hand-entered SSH hosts and preferences stay intact.
      await options.reconcile(publish);
      publish({ hubSessions: {}, banner: t("이 기기가 컴퓨터에서 삭제되어 연결을 정리했습니다") });
    }
    if (full) publish({ censusBusy: false });
  }

  function request(full: boolean): Promise<void> {
    if (disposed) return Promise.resolve();
    clearTimer();
    if (inFlight) {
      // An explicit full refresh must not be reduced to the Hub-only pass
      // already running. Coalesce callers into one following full pass.
      if (full && (!fullInFlight || flightEpoch !== options.epoch())) {
        fullRequested = true;
        options.publish({ censusBusy: true, banner: undefined }, false, active());
      }
      return inFlight;
    }
    fullInFlight = full;
    flightEpoch = options.epoch();
    if (full) options.publish({ censusBusy: true, banner: undefined }, false, active());
    inFlight = (async () => {
      do {
        fullRequested = false;
        await run(fullInFlight);
        fullInFlight = true;
        flightEpoch = options.epoch();
      } while (fullRequested && !disposed);
    })().finally(() => {
      inFlight = undefined;
      sync();
    });
    clearTimer();
    return inFlight;
  }

  const hide = () => { suspended = true; sync(); };
  const visible = () => {
    if (active()) options.publish({}, true, true);
    sync();
  };
  const show = () => { suspended = false; visible(); };
  page.addEventListener("visibilitychange", visible);
  viewport.addEventListener("pagehide", hide);
  viewport.addEventListener("pageshow", show);
  const observer = new MutationObserver(() => {
    if (!options.root.isConnected) options.detached();
  });
  if (options.root.parentNode) observer.observe(options.root.parentNode, { childList: true });
  function dispose(): void {
    disposed = true;
    clearTimer();
    observer.disconnect();
    page.removeEventListener("visibilitychange", visible);
    viewport.removeEventListener("pagehide", hide);
    viewport.removeEventListener("pageshow", show);
  }
  return { refresh: () => request(true), sync, dispose };
}
