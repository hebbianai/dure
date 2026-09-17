import { describe, expect, it } from "vitest";
import {
  HMUX_STAGE_AUTHORIZATION_ENV,
  admitHmuxAppStage,
} from "./hmux-app-stage-admission.mjs";

describe("Hmux app stage admission", () => {
  it("allows an inactive worktree without deploy authority", () => {
    expect(
      admitHmuxAppStage({
        appRuntime: undefined,
        deployLock: null,
        authorization: undefined,
      }),
    ).toEqual({ admitted: true, authority: "inactive_worktree" });
  });

  it("rejects direct mutation while an app or deploy owns the worktree", () => {
    for (const input of [
      { appRuntime: { pid: 42 }, deployLock: null },
      { appRuntime: undefined, deployLock: { token: "exact-token" } },
      {
        appRuntime: { pid: 42 },
        deployLock: { token: "exact-token" },
        authorization: "Bearer wrong-token",
      },
    ]) {
      expect(admitHmuxAppStage(input)).toMatchObject({
        admitted: false,
        reason: expect.stringMatching(/exact dev deploy transaction/),
      });
    }
  });

  it("admits the exact deploy lock bearer while the app is active", () => {
    const token = "a".repeat(64);
    expect(HMUX_STAGE_AUTHORIZATION_ENV).toBe(
      "DURE_HMUX_STAGE_DEPLOY_AUTHORIZATION",
    );
    expect(
      admitHmuxAppStage({
        appRuntime: { pid: 42 },
        deployLock: { token },
        authorization: `Bearer ${token}`,
      }),
    ).toEqual({ admitted: true, authority: "dev_deploy_lock" });
  });
});
