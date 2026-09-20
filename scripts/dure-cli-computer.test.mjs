import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { devTreeEnvironment } from "./qa/lib/dev-tree-environment.mjs";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Run the real CLI, but never let a regression type into or capture the desktop.
function run(args, fixture = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-computer-"));
  roots.push(root);
  const callsPath = join(root, "calls.jsonl");
  const inputPath = join(root, "input.jsonl");
  const preload = join(root, "desktop-stub.cjs");
  writeFileSync(preload, `
const cp = require("node:child_process");
const fs = require("node:fs");
const fixture = ${JSON.stringify(fixture)};
Object.defineProperty(process, "platform", { value: "darwin" });
cp.spawnSync = (command, args) => {
  if (command !== "osascript" && command !== "screencapture") {
    throw new Error("Unexpected child process: " + command);
  }
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, args }) + "\\n");
  if (args[0] === "-l") {
    let activePid = 42;
    let postedCount = 0;
    const record = (kind, value) => fs.appendFileSync(${JSON.stringify(inputPath)}, JSON.stringify({ kind, ...value }) + "\\n");
    const events = {
      applicationProcesses: { whose: (selector) => ({ unixId: () => { record("resolve", selector); return [42]; } }) },
      keystroke: () => { throw new Error("Global input is forbidden"); },
      keyCode: () => { throw new Error("Global input is forbidden"); },
    };
    const native = Object.assign((text) => ({ dataUsingEncoding: () => ({ bytes: text }) }), {
      NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid) => ({
        isNil: () => false, terminated: false,
        activateWithOptions: () => { record("activate", { pid }); return true; },
      }) },
      NSMutableData: { dataWithLength: () => {
        const data = { subdataWithRange: () => ({ base64EncodedStringWithOptions: () => "fixture-generation" }) };
        data.mutableBytes = data;
        return data;
      } },
      proc_pidinfo: () => 56, NSMakeRange: () => null,
      NSWorkspace: { sharedWorkspace: { frontmostApplication: { get processIdentifier() { return activePid; } } } },
      NSProcessInfo: { processInfo: { systemUptime: 0 } },
      NSRunLoop: { currentRunLoop: { runUntilDate() {} } },
      NSDate: { dateWithTimeIntervalSinceNow() {} },
      TISCopyCurrentASCIICapableKeyboardLayoutInputSource: () => ({}),
      TISGetInputSourceProperty: () => ({}),
      CFDataGetBytePtr: (value) => value,
      LMGetKbdType: () => 46,
      UCKeyTranslate: (layout, code, action, shifts, keyboard, options, dead, max, length, output) => {
        const plain = { 0: "a", 1: "s", 24: "=", 27: "-", 39: "'", 42: String.fromCharCode(92) };
        if (fixture.alternateLayout) { delete plain[0]; plain[12] = "a"; }
        const shifted = { 24: "+", 39: '"' };
        output.text = (shifts === 0 ? plain : shifts === 2 ? shifted : {})[code] ?? "";
        return 0;
      },
      NSString: { alloc: { initWithDataEncoding: (data) => data.text } },
      CGPreflightPostEventAccess: () => fixture.postAccess !== false,
      CGEventSourceCreate: () => ({}),
      CGEventCreateKeyboardEvent: (source, code, down) => ({ code, down }),
      CGEventSetFlags: (event, flags) => { event.flags = flags; },
      CGEventKeyboardSetUnicodeString: (event, length, text) => { event.text = text; },
      CGEventPostToPid: (pid, event) => {
        record("posted", { pid, ...event });
        if (++postedCount === fixture.loseFocusAfterEvents) activePid = 7;
        if (event.text !== undefined) record("unicode", { pid, ...event });
        else if (event.down) record("keyCode", { code: event.code, modifiers:
          [[1048576, "command down"], [262144, "control down"], [524288, "option down"], [131072, "shift down"]]
            .filter(([flag]) => event.flags & flag).map(([, name]) => name) });
      },
    });
    const stdout = require("node:vm").runInNewContext(args[3], {
      Application: () => events, $: native,
      ObjC: { import() {}, bindFunction() {}, unwrap: (value) => value },
    });
    return { status: 0, stdout, stderr: "" };
  }
  return { status: 0, stdout: "", stderr: "" };
};
require("node:module").syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ["--require", preload, cli, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: devTreeEnvironment(root, "computer-test"),
  });
  expect(result.error).toBeUndefined();
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  const inputs = existsSync(inputPath)
    ? readFileSync(inputPath, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { ...result, calls, inputs };
}

function expectInput(args, input) {
  const result = run(["computer", ...args]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.calls).toHaveLength(1);
  if (input.kind === "unicode") {
    const posted = result.inputs.filter(({ kind }) => kind === "unicode");
    expect(posted.filter(({ down }) => down).map(({ text }) => text).join("")).toBe(input.text);
    expect(posted.filter(({ down }) => !down).map(({ text }) => text).join("")).toBe(input.text);
    expect(posted.every(({ pid }) => pid === 42)).toBe(true);
    expect(result.inputs.some(({ kind }) => kind === "keystroke")).toBe(false);
  } else expect(result.inputs).toContainEqual(input);
  if (args[0] !== "activate") {
    const posted = result.inputs.filter(({ kind }) => kind === "posted");
    expect(posted.length).toBeGreaterThanOrEqual(2);
    expect(posted.every(({ pid }, index) => pid === 42 && posted[index].down === (index % 2 === 0))).toBe(true);
  }
  return result;
}

function expectScript(args, fragment) {
  const result = run(["computer", ...args]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].command).toBe("osascript");
  expect(result.calls[0].args[1]).toContain(fragment);
  return result.calls[0].args[1];
}

describe("dure computer input", () => {
  it.each([
    ["type", "Notes", "hello", "world"],
    ["type", "--app", "Notes", "hello", "world"],
    ["type", "Notes", "--text", "hello world"],
    ["type", "--app", "Notes", "--text", "hello world"],
  ])("preserves all text: %j", (...args) => {
    const result = expectInput(args, { kind: "unicode", text: "hello world" });
    expect(result.inputs).toContainEqual({ kind: "resolve", name: "Notes" });
  });

  it("preserves Unicode, whitespace, quotes and backslashes in text", () => {
    expectInput(
      ["type", "--app", "Notes", "--text", '  한글 😀 "QA" \\ path\nnext  '],
      { kind: "unicode", text: '  한글 😀 "QA" \\ path\nnext  ' },
    );
  });

  it.each([
    ["type", "Notes", "--", "--help", "--json"],
    ["type", "--app", "Notes", "--", "--help", "--json"],
  ])("preserves literal flags after --: %j", (...args) => {
    expectInput(args, { kind: "unicode", text: "--help --json" });
  });

  it.each([
    ["key", "Notes", "cmd+s"],
    ["key", "--app", "Notes", "cmd+s"],
    ["key", "Notes", "--key", "cmd+s"],
    ["key", "--app", "Notes", "--key", "cmd+s"],
  ])("accepts positional and explicit key arguments: %j", (...args) => {
    expectInput(args, { kind: "keyCode", code: 1, modifiers: ["command down"] });
  });

  it.each([
    ["ctrl+shift+return", { kind: "keyCode", code: 36, modifiers: ["control down", "shift down"] }],
    ["COMMAND+OPT+LEFT", { kind: "keyCode", code: 123, modifiers: ["command down", "option down"] }],
    ["alt+tab", { kind: "keyCode", code: 48, modifiers: ["option down"] }],
    ["backspace", { kind: "keyCode", code: 51, modifiers: [] }],
    ["+", { kind: "keyCode", code: 24, modifiers: ["shift down"] }],
    ["cmd+plus", { kind: "keyCode", code: 24, modifiers: ["command down", "shift down"] }],
    ["-", { kind: "keyCode", code: 27, modifiers: [] }],
    ['"', { kind: "keyCode", code: 39, modifiers: ["shift down"] }],
    ["\\", { kind: "keyCode", code: 42, modifiers: [] }],
  ])("encodes supported key %s", (key, action) => {
    expectInput(["key", "Notes", key], action);
  });

  it.each([
    ["menu", "Notes", "File", "New Note"],
    ["menu", "--app", "Notes", "File", "New Note"],
  ])("accepts menu arguments: %j", (...args) => {
    expectScript(args, 'click menu item "New Note" of menu "File"');
  });

  it.each([
    ["activate", "Notes"],
    ["activate", "--app", "Notes"],
  ])("preserves app activation syntax: %j", (...args) => {
    expectInput(args, { kind: "activate", pid: 42 });
  });

  it("selects a PID without resolving or launching an app by name", () => {
    const result = expectInput(["type", "--pid", "42", "hello"], { kind: "unicode", text: "hello" });
    expect(result.inputs).not.toContainEqual(expect.objectContaining({ kind: "resolve" }));
    expect(result.inputs).toContainEqual({ kind: "activate", pid: 42 });
  });

  it("uses the selected layout instead of assuming US letter positions", () => {
    const result = run(["computer", "key", "--pid", "42", "cmd+a"], { alternateLayout: true });
    expect(result.status).toBe(0);
    expect(result.inputs).toContainEqual({ kind: "keyCode", code: 12, modifiers: ["command down"] });
  });

  it("stops between Unicode characters when focus changes, without retrying", () => {
    const result = run(["computer", "type", "--pid", "42", "한글"], { loseFocusAfterEvents: 2 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("computer_input_unconfirmed");
    expect(result.inputs.filter(({ kind }) => kind === "posted")).toEqual([
      { kind: "posted", pid: 42, code: 0, down: true, flags: 0, text: "한" },
      { kind: "posted", pid: 42, code: 0, down: false, flags: 0, text: "한" },
    ]);
  });

  it("does not post events when native input permission is denied", () => {
    const result = run(["computer", "type", "--pid", "42", "blocked"], { postAccess: false });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Accessibility permission");
    expect(result.inputs.some(({ kind }) => kind === "posted")).toBe(false);
  });

  it("rejects a character unavailable in the keyboard layout without input", () => {
    const result = run(["computer", "key", "--pid", "42", "한"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use type for Unicode text");
    expect(result.inputs.some(({ kind }) => kind === "posted")).toBe(false);
  });

  it.each(["capture.png", "--help"])("keeps screenshot path %j out of OS options", (path) => {
    const result = run(["computer", "screenshot", "--", path]);
    expect(result).toMatchObject({
      status: 0,
      stderr: "",
      stdout: `${path}\n`,
      calls: [{ command: "screencapture", args: ["-x", resolve(path)] }],
    });
  });

  it("keeps apps and state available without a registry", () => {
    expectScript(["apps"], "every process whose background only is false");
    const result = run(["computer", "state", "--app", "Notes"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.calls).toHaveLength(2);
    expect(result.calls[1].args[1]).toContain('tell process "Notes" to get name of every window');
  });
});

describe("dure computer validation before OS effects", () => {
  it.each([
    ["computer"],
    ["computer", "help"],
    ["computer", "--help"],
    ["help", "computer"],
    ["computer", "type", "Notes", "hello", "--help"],
    ["computer", "key", "Notes", "-h"],
    ["computer", "activate", "--app", "Notes", "--help"],
    ["computer", "menu", "Notes", "File", "New Note", "--help"],
    ["computer", "screenshot", "--help"],
    ["computer", "state", "--help"],
    ["computer", "apps", "-h"],
    ["computer", "type", "--app", "Notes", "--text", "--help"],
  ])("help has no OS effects: %j", (...args) => {
    const result = run(args);
    expect(result).toMatchObject({ status: 0, stderr: "", calls: [] });
    expect(result.stdout).toContain("dure computer");
    expect(result.stdout).toContain("--text");
    expect(result.stdout).toContain("--key");
  });

  it.each([
    ["staet"],
    ["apps", "extra"],
    ["apps", "--app", "Notes"],
    ["apps", "--json"],
    ["state", "Notes", "extra"],
    ["activate", "Notes", "extra"],
    ["activate", "Notes", "--app", "Safari"],
    ["activate", "--app"],
    ["activate", "--app", ""],
    ["activate", "--app", "Notes", "--app", "Safari"],
    ["type", "Notes"],
    ["type", "Notes", "hello", "--dry-run"],
    ["type", "Notes", "--json", "hello"],
    ["type", "Notes", "--text"],
    ["type", "Notes", "--text", ""],
    ["type", "Notes", "hello", "--text", "world"],
    ["type", "Notes", "--text", "hello", "--text", "world"],
    ["type", "--app", "--text", "hello"],
    ["type", "Notes", "--key", "s"],
    ["key", "Notes"],
    ["key", "Notes", "cmd+s", "extra"],
    ["key", "Notes", "cmd+s", "--key", "cmd+q"],
    ["key", "Notes", "--key", "s", "--key", "q"],
    ["menu", "Notes", "File"],
    ["menu", "Notes", "File", "New Note", "extra"],
    ["screenshot", "first.png", "second.png"],
    ["screenshot", ""],
    ["type", "--pid", "0", "hello"],
    ["type", "--pid", "1", "hello"],
    ["type", "--pid", "-1", "hello"],
    ["type", "--pid", "1.5", "hello"],
    ["type", "--pid", "1e3", "hello"],
    ["type", "--pid", "2147483648", "hello"],
    ["type", "--pid", "42", "--app", "Notes", "hello"],
    ["type", "--pid", "42", "--pid", "43", "hello"],
    ["activate", "--pid", "42", "Notes"],
    ["menu", "--pid", "42", "File", "New Note"],
  ])("rejects invalid arguments without OS effects: %j", (...args) => {
    const result = run(["computer", ...args]);
    expect(result).toMatchObject({ status: 1, stdout: "", calls: [] });
    expect(result.stderr.trim()).not.toBe("");
  });

  it.each([
    "cmdd+s", "cmd+F5", "F1", "pagedown", "hello", "cmd+", "cmd++s",
    "cmd++", "cmd+command+s", "ctrl+control+s", "constructor+s", "__proto__+s",
    "constructor", "__proto__", "", "\n", "\u0001", " ",
  ])("rejects unsupported or malformed key %j before activation", (key) => {
    const result = run(["computer", "key", "Notes", key]);
    expect(result).toMatchObject({ status: 1, stdout: "", calls: [] });
    expect(result.stderr).toMatch(/key|modifier/i);
  });
});
