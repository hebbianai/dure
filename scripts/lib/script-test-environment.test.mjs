import { describe, expect, it } from "vitest";
import { scriptTestEnvironment } from "./script-test-environment.mjs";

describe("script test child environment", () => {
  it("passes through only portable process-launch variables", () => {
    expect(
      scriptTestEnvironment(
        {},
        {
          DURE_APP_CHANNEL: "live-channel",
          DURE_HOME: "/live/dure",
          COREPACK_ROOT: "/tooling/corepack",
          HEBBIAN_HMUX_BIN: "/live/hmux",
          HOME: "/live/home",
          PATH: "/fixture/bin",
          SHELL: "/bin/zsh",
          SystemRoot: "C:\\Windows",
          TERM: "xterm-256color",
          TMPDIR: "/fixture/tmp",
          UNRELATED_SECRET: "do-not-copy",
          USER: "live-user",
        },
      ),
    ).toEqual({
      PATH: "/fixture/bin",
      COREPACK_ROOT: "/tooling/corepack",
      SystemRoot: "C:\\Windows",
      TMPDIR: "/fixture/tmp",
    });
  });

  it("adds only explicit fixture state and lets undefined remove a value", () => {
    expect(
      scriptTestEnvironment(
        {
          DURE_APP_CHANNEL: "stable",
          HOME: "/fixture/home",
          PATH: undefined,
        },
        { PATH: "/host/bin" },
      ),
    ).toEqual({
      DURE_APP_CHANNEL: "stable",
      HOME: "/fixture/home",
    });
  });
});
