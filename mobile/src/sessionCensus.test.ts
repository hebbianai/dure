import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerReport } from "./census";
import type { HubProbe, HubProbeSession } from "./ipc";
import { createSessionCensus } from "./sessionCensus";

const native = vi.hoisted(() => ({ hubOpen: vi.fn(), takeSessionCensus: vi.fn() }));
vi.mock("./ipc", () => ({ ipc: native }));

type Options = Parameters<typeof createSessionCensus>[0];
type State = ReturnType<Options["current"]>;
const hubs = ["fast", "slow"].map((id) => ({
  id, box_label: id, endpoint: "qa", relay_offered: true,
}));
const session: HubProbeSession = {
  session_id: "qa-session", session_name: "QA agent", workspace_id: "qa", session_class: "standalone",
  lifecycle: "ready", provider_id: "codex", runner_principal: "qa", runner_instance: "qa",
  channel_epoch: "1", host_instance_id: "qa", terminal_epoch: "1", capabilities: [], ready: true,
  box_id: "local", box_label: "QA", launch_program: null,
};
const probe: HubProbe = {
  ...hubs[0], device_label: "QA phone", sessions: [session], layout_note: null,
  direct_pairing: null, direct_pairing_error: null, unreachable: [],
  layout: { desktop_order: ["QA"], placements: { [session.session_id]: { desktop: "QA", project: "QA", order: 0 } } },
};
const reports: ServerReport[] = [{
  server_id: "ssh", server_label: "SSH", outcome: { state: "listed", sessions: [session] },
}];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

let root: HTMLElement;
let state: State;
let epoch: number;
let census: ReturnType<typeof createSessionCensus>;
let publish: ReturnType<typeof vi.fn<Options["publish"]>>;
let reconcile: ReturnType<typeof vi.fn<Options["reconcile"]>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  root = document.createElement("div");
  document.body.replaceChildren(root);
  epoch = 0;
  state = { hubs, hubSessions: {}, hubLayouts: {}, serverListings: {}, hostChecks: {}, censusBusy: false };
  publish = vi.fn((patch) => { state = { ...state, ...patch }; });
  reconcile = vi.fn(async () => {});
  census = createSessionCensus({
    root, current: () => state, epoch: () => epoch, home: () => true,
    detached: () => census.dispose(), publish, reconcile,
  });
  native.hubOpen.mockResolvedValue(probe);
  native.takeSessionCensus.mockResolvedValue(reports);
});
afterEach(() => {
  census.dispose();
  root.remove();
  vi.useRealTimers();
});

it("publishes direct SSH before pending Hubs and merges each later Hub's sessions and layout", async () => {
  const slow = deferred<HubProbe>();
  native.hubOpen.mockImplementation((id) => id === "slow" ? slow.promise : Promise.resolve(probe));
  const flight = census.refresh();
  await settle();
  expect(state.reports).toEqual(reports);
  expect(state.hostChecks.ssh.reachable).toBe(true);
  expect(state.serverListings.ssh.sessions).toEqual([session]);
  expect(Object.keys(state.hubSessions)).toEqual(["fast"]);
  expect(state.censusBusy).toBe(true);
  expect(census.refresh()).toBe(flight);
  slow.resolve(probe);
  await flight;
  expect(Object.keys(state.hubSessions)).toEqual(["fast", "slow"]);
  expect(state.hubLayouts).toEqual({ fast: probe.layout, slow: probe.layout });
  expect(state.reports).toEqual(reports);
  expect(state.censusBusy).toBe(false);
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(1);
});

it.each(["reset", "dispose", "detach"])("fences every remaining source after %s during a partially published flight", async (action) => {
  const ssh = deferred<ServerReport[]>();
  const slow = deferred<HubProbe>();
  native.takeSessionCensus.mockReturnValueOnce(ssh.promise);
  native.hubOpen.mockImplementation((id) => id === "slow" ? slow.promise : Promise.resolve(probe));
  const flight = census.refresh();
  await settle();
  expect(state.hubSessions.fast.sessions).toEqual([session]);
  if (action === "reset") epoch += 1;
  else if (action === "dispose") census.dispose();
  else root.remove();
  state = { ...state, hubs: [], hubSessions: {}, hubLayouts: {}, censusBusy: false };
  const count = publish.mock.calls.length;
  slow.reject({ code: "hub_refused" });
  ssh.resolve(reports);
  await flight;
  expect(publish).toHaveBeenCalledTimes(count);
  expect(reconcile).not.toHaveBeenCalled();
  expect(state.hubSessions).toEqual({});
  expect(state.reports).toBeUndefined();
});

it("coalesces a new epoch's refresh behind all old sources without publishing their late results", async () => {
  const ssh = deferred<ServerReport[]>();
  const slow = deferred<HubProbe>();
  native.takeSessionCensus.mockReturnValueOnce(ssh.promise);
  native.hubOpen.mockImplementationOnce(() => Promise.resolve(probe)).mockReturnValueOnce(slow.promise);
  const flight = census.refresh();
  await settle();
  epoch += 1;
  state = { ...state, hubSessions: {}, hubLayouts: {}, censusBusy: false };
  const count = publish.mock.calls.length;
  expect(census.refresh()).toBe(flight);
  expect(census.refresh()).toBe(flight);
  slow.resolve({ ...probe, sessions: [{ ...session, session_id: "retired" }] });
  ssh.resolve([]);
  await flight;
  expect(native.takeSessionCensus).toHaveBeenCalledTimes(2);
  expect(native.hubOpen).toHaveBeenCalledTimes(4);
  expect(JSON.stringify(publish.mock.calls.slice(count))).not.toContain("retired");
  expect(state.hubSessions.slow.sessions).toEqual([session]);
  expect(state.censusBusy).toBe(false);
});

it("reconciles a revoked pairing after all sources so late catalogs cannot restore cleared sessions", async () => {
  const ssh = deferred<ServerReport[]>();
  const slow = deferred<HubProbe>();
  native.takeSessionCensus.mockReturnValueOnce(ssh.promise);
  native.hubOpen.mockRejectedValueOnce({ code: "hub_refused" }).mockReturnValueOnce(slow.promise);
  reconcile.mockImplementation(async (accept) => { accept({ hubs: [hubs[1]], hubLayouts: {} }); });
  const flight = census.refresh();
  await settle();
  slow.resolve(probe);
  await settle();
  expect(state.hubSessions.slow.sessions).toEqual([session]);
  expect(state.censusBusy).toBe(true);
  ssh.resolve(reports);
  await flight;
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(state.hubs).toEqual([hubs[1]]);
  expect(state.hubSessions).toEqual({});
  expect(state.hubLayouts).toEqual({});
  expect(state.banner).toBeTruthy();
  expect(state.censusBusy).toBe(false);
});

it("keeps a completed Hub visible when direct SSH fails and finishes the busy state", async () => {
  const ssh = deferred<ServerReport[]>();
  native.takeSessionCensus.mockReturnValueOnce(ssh.promise);
  const flight = census.refresh();
  await settle();
  expect(state.hubSessions.fast.reachable).toBe(true);
  expect(state.censusBusy).toBe(true);
  ssh.reject(new Error("SSH catalog failed"));
  await flight;
  expect(state.hubSessions.fast.reachable).toBe(true);
  expect(state.banner).toContain("SSH catalog failed");
  expect(state.censusBusy).toBe(false);
});
