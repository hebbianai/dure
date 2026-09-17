import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handoff: vi.fn(),
}));


vi.mock("@/lib/hmux/remote/remoteHmuxShellHandoff", () => ({
  handleRemoteHmuxShellHandoff: mocks.handoff,
}));

import { handleRemoteHmuxShellCliRequest } from "@/lib/hmux/remote/remoteHmuxShellCliRequest";
import { RemoteHmuxShellRequestError } from "@/lib/hmux/remote/remoteHmuxShellRequest";

describe("remote Hmux shell CLI request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims a fallback exactly once before completing it", async () => {
    mocks.handoff.mockResolvedValue({ ok: false, fallback: true });
    const claim = vi.fn(async () => true);
    const complete = vi.fn(async () => undefined);

    await handleRemoteHmuxShellCliRequest("request-1", {}, claim, complete);

    expect(claim).toHaveBeenCalledExactlyOnceWith("request-1");
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      "request-1",
      { ok: false, fallback: true },
      "hmux.remote-shell",
    );
  });

  it("returns a typed invalid-request receipt after claiming", async () => {
    mocks.handoff.mockRejectedValue(
      new RemoteHmuxShellRequestError("malformed request"),
    );
    const claim = vi.fn(async () => true);
    const complete = vi.fn(async () => undefined);

    await handleRemoteHmuxShellCliRequest("request-2", {}, claim, complete);

    expect(complete).toHaveBeenCalledWith(
      "request-2",
      {
        ok: false,
        error: {
          code: "invalid_request",
          message: "malformed request",
        },
      },
      "hmux.remote-shell",
    );
  });

  it("does not let a duplicate or expired decision delivery claim the original request", async () => {
    mocks.handoff.mockResolvedValue({ ok: false, unavailable: true });
    const claim = vi.fn(async () => true);
    const complete = vi.fn();
    await handleRemoteHmuxShellCliRequest("request-1", {}, claim, complete);
    expect(claim).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("reuses the accepted execution claim while the handoff crosses durable save and trust", async () => {
    mocks.handoff.mockImplementation(async (_params, claim) => {
      expect(await claim()).toBe(true);
      expect(await claim()).toBe(true);
      return { ok: true };
    });
    const claim = vi.fn(async () => true);
    const complete = vi.fn();
    await handleRemoteHmuxShellCliRequest("request-1", {}, claim, complete);
    expect(claim).toHaveBeenCalledExactlyOnceWith("request-1");
    expect(complete).toHaveBeenCalledExactlyOnceWith("request-1", { ok: true }, "hmux.remote-shell");
  });
});
