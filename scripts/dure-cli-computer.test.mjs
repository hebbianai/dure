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
function run(args) {
  const root = mkdtempSync(join(tmpdir(), "dure-computer-"));
  roots.push(root);
  const callsPath = join(root, "calls.jsonl");
  const preload = join(root, "desktop-stub.cjs");
  writeFileSync(preload, `
const cp = require("node:child_process");
const fs = require("node:fs");
cp.spawnSync = (command, args) => {
  if (command !== "osascript" && command !== "screencapture") {
    throw new Error("Unexpected child process: " + command);
  }
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, args }) + "\\n");
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
  return { ...result, calls };
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
    const script = expectScript(args, 'keystroke "hello world"');
    expect(script).toContain('tell application "Notes" to activate');
  });

  it("preserves Unicode, whitespace, quotes and backslashes in text", () => {
    expectScript(
      ["type", "--app", "Notes", "--text", '  한글 "QA" \\ path\nnext  '],
      'keystroke "  한글 \\"QA\\" \\\\ path\nnext  "',
    );
  });

  it.each([
    ["type", "Notes", "--", "--help", "--json"],
    ["type", "--app", "Notes", "--", "--help", "--json"],
  ])("preserves literal flags after --: %j", (...args) => {
    expectScript(args, 'keystroke "--help --json"');
  });

  it.each([
    ["key", "Notes", "cmd+s"],
    ["key", "--app", "Notes", "cmd+s"],
    ["key", "Notes", "--key", "cmd+s"],
    ["key", "--app", "Notes", "--key", "cmd+s"],
  ])("accepts positional and explicit key arguments: %j", (...args) => {
    expectScript(args, 'keystroke "s" using {command down}');
  });

  it.each([
    ["ctrl+shift+return", "key code 36 using {control down, shift down}"],
    ["COMMAND+OPT+LEFT", "key code 123 using {command down, option down}"],
    ["alt+tab", "key code 48 using {option down}"],
    ["backspace", "key code 51"],
    ["+", 'keystroke "+"'],
    ["cmd+plus", 'keystroke "+" using {command down}'],
    ["-", 'keystroke "-"'],
    ['"', 'keystroke "\\""'],
    ["\\", 'keystroke "\\\\"'],
  ])("encodes supported key %s", (key, action) => {
    expectScript(["key", "Notes", key], action);
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
    expectScript(args, 'tell application "Notes" to activate');
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
