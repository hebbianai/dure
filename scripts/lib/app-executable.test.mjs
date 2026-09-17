import { describe, expect, it } from "vitest";
import {
  APP_EXECUTABLE_NAMES,
  APP_EXECUTABLE_NAME,
  debugAppBinaryPaths,
  debugAppRootFromCommand,
  isAppProcessCommand,
  isBundledAppProcessCommand,
  isDebugAppProcessCommand,
} from "./app-executable.mjs";

describe("Dure app executable identity", () => {
  it("uses dure for new builds and keeps agent-ide as a read-only legacy name", () => {
    expect(APP_EXECUTABLE_NAME).toBe("dure");
    expect(APP_EXECUTABLE_NAMES).toEqual(["dure", "agent-ide"]);
    expect(debugAppBinaryPaths("/repo")).toEqual([
      "/repo/src-tauri/target/debug/dure",
      "/repo/src-tauri/target/debug/agent-ide",
    ]);
  });

  it("recognizes canonical and legacy Tauri debug executables", () => {
    for (const command of [
      "target/debug/dure",
      "/repo/src-tauri/target/debug/dure",
      "target/debug/agent-ide",
      "/repo/src-tauri/target/debug/agent-ide",
      "/Users/me/My Project/src-tauri/target/debug/dure",
    ]) {
      expect(isDebugAppProcessCommand(command)).toBe(true);
      expect(isAppProcessCommand(command)).toBe(true);
    }
  });

  it("does not confuse the public dure CLI with the desktop app", () => {
    for (const command of [
      "dure",
      "/Users/me/.local/bin/dure",
      "dure send agent hello",
      "echo target/debug/dure",
      "echo /tmp/target/debug/dure",
      "sh -c /tmp/target/debug/agent-ide",
      "cargo test dure",
      "/tmp/target/debug/deps/dure-123",
    ]) {
      expect(isDebugAppProcessCommand(command)).toBe(false);
      expect(isAppProcessCommand(command)).toBe(false);
    }
  });

  it("recognizes Dure bundles and the migration-only Hebbian bundle", () => {
    expect(
      isBundledAppProcessCommand(
        "/Applications/Dure.app/Contents/MacOS/dure",
      ),
    ).toBe(true);
    expect(
      isBundledAppProcessCommand(
        "/Applications/Hebbian.app/Contents/MacOS/agent-ide",
      ),
    ).toBe(true);
    expect(
      isBundledAppProcessCommand(
        "/Applications/Orca.app/Contents/MacOS/dure",
      ),
    ).toBe(false);
  });

  it("extracts only absolute debug-app worktree roots", () => {
    expect(
      debugAppRootFromCommand(
        "/repo/.worktrees/uiux/src-tauri/target/debug/dure",
      ),
    ).toBe("/repo/.worktrees/uiux");
    expect(
      debugAppRootFromCommand("/repo/.worktrees/uiux/target/debug/agent-ide"),
    ).toBe("/repo/.worktrees/uiux");
    expect(
      debugAppRootFromCommand(
        "/Users/me/My Project/src-tauri/target/debug/dure",
      ),
    ).toBe("/Users/me/My Project");
    expect(
      debugAppRootFromCommand(
        "/repo/.worktrees/uiux/src-tauri/target/debug/.dure-dev/dev-uiux-a1b2c3d4/Dure.app/Contents/MacOS/dure",
      ),
    ).toBe("/repo/.worktrees/uiux");
    expect(debugAppRootFromCommand("target/debug/dure")).toBeUndefined();
    expect(debugAppRootFromCommand("/Users/me/.local/bin/dure")).toBeUndefined();
    expect(
      debugAppRootFromCommand("echo /tmp/target/debug/dure"),
    ).toBeUndefined();
  });
});
