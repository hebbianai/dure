import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computeBackendRuntimeFingerprint } from "./backend-runtime-fingerprint.mjs";
import { canReuseDevFrontend, probeDevFrontend } from "./dev-frontend-authority.mjs";
import { requireCurrentNodeDependencyInstall } from "../node-dependency-preflight.mjs";

vi.mock("./backend-runtime-fingerprint.mjs", () => ({
  computeBackendRuntimeFingerprint: vi.fn(),
}));
vi.mock("../node-dependency-preflight.mjs", () => ({
  requireCurrentNodeDependencyInstall: vi.fn(),
}));

const fingerprint = `git-object-v1:${"a".repeat(40)}`;
const dependencyFingerprint = `pnpm-lock-v1:${"e".repeat(64)}`;
const identity = { generation: "b".repeat(64) };
const target = { origin: "http://localhost:12345", channel: "dev-test", worktreeRoot: "/fixture" };
const ready = {
  schemaVersion: 1, protocolVersion: 1, type: "frontend_ready",
  channel: target.channel, generation: identity.generation,
  backendRuntimeFingerprint: fingerprint,
  nodeDependencyFingerprint: dependencyFingerprint,
};
const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(computeBackendRuntimeFingerprint).mockReturnValue(fingerprint);
  vi.mocked(requireCurrentNodeDependencyInstall).mockReturnValue({ fingerprint: dependencyFingerprint });
  fetchMock.mockResolvedValue(new Response(JSON.stringify(ready)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it("reuses the same immutable runtime observation after preparation", async () => {
  expect(await canReuseDevFrontend(target, identity)).toBe(true);
  expect(computeBackendRuntimeFingerprint).toHaveBeenCalledExactlyOnceWith(target.worktreeRoot);
});

it.each([undefined, null, "malformed", `git-object-v1:${"c".repeat(40)}`])(
  "keeps health available without hashing when reuse observation is %s",
  async (backendRuntimeFingerprint) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...ready, backendRuntimeFingerprint })));
    expect(await probeDevFrontend(target, identity)).toBe(true);
    expect(computeBackendRuntimeFingerprint).not.toHaveBeenCalled();
    expect(await canReuseDevFrontend(target, identity)).toBe(false);
  },
);

it.each([{ generation: "d".repeat(64) }, { channel: "other" }, { protocolVersion: 0 }])(
  "never reuses a matching fingerprint with mismatched identity %j",
  async (mismatch) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...ready, ...mismatch })));
    expect(await probeDevFrontend(target, identity)).toBe(false);
    expect(await canReuseDevFrontend(target, identity)).toBe(false);
  },
);

it("propagates unreadable prepared inputs instead of authorizing retirement", async () => {
  vi.mocked(computeBackendRuntimeFingerprint).mockImplementation(() => { throw new Error("unreadable artifact"); });
  await expect(canReuseDevFrontend(target, identity)).rejects.toThrow("unreadable artifact");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([undefined, null, "malformed", `pnpm-lock-v1:${"f".repeat(64)}`])(
  "does not reuse an old dependency graph with the same backend (%s)",
  async (nodeDependencyFingerprint) => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...ready, nodeDependencyFingerprint })));
    expect(await probeDevFrontend(target, identity)).toBe(true);
    expect(requireCurrentNodeDependencyInstall).not.toHaveBeenCalled();
    expect(await canReuseDevFrontend(target, identity)).toBe(false);
  },
);

it("refuses unprepared dependencies before observing retirement eligibility", async () => {
  vi.mocked(requireCurrentNodeDependencyInstall).mockImplementation(() => { throw new Error("installed_lock_mismatch"); });
  await expect(canReuseDevFrontend(target, identity)).rejects.toThrow("installed_lock_mismatch");
  expect(fetchMock).not.toHaveBeenCalled();
});
