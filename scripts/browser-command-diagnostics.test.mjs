import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";
import { parseBrowserArguments } from "../cli/lib/browser-arguments.mjs";

async function rejected(args, code, option) {
  let contacts = 0;
  const result = await collectBrowserCommand({
    args, sourceEnvironment: {},
    resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.equal(result.error.option, option);
  assert.ok(result.error.message);
  assert.ok(result.error.hint);
  assert.equal(contacts, 0);
  return result;
}

test("missing values identify the option before a following flag can become input", async () => {
  for (const option of ["--page", "--resource", "--value", "--pass", "--enable", "--init-script"]) {
    for (const suffix of [[], ["--json"], ["--resource=other"], ["--"], ["-h"]]) {
      await rejected(["fill", "resource", "input", option, ...suffix], "browser_command_invalid", option);
    }
  }
});

test("unknown and duplicate flags identify the problem without echoing values", async () => {
  for (const [args, option] of [
    [["get", "resource", "title", "--paeg=secret"], "--paeg"],
    [["get", "resource", "title", "--page", "secret", "--page=secret"], "--page"],
    [["cookie", "set", "--sameSite=secret", "--same-site=secret"], "--same-site"],
    [["cookie", "set", "--httpOnly", "--http-only"], "--http-only"],
    [["snapshot", "resource", "--compact", "--compact"], "--compact"],
  ]) {
    const result = await rejected(args, "browser_command_invalid", option);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("literal option text, empty values, negative numbers and repeatable options remain usable", () => {
  for (const value of ["--json", "--help", "--", "", "한글 값"]) {
    const parsed = parseBrowserArguments(["fill", "--resource=r", "--element=input", `--value=${value}`]);
    assert.deepEqual(parsed.positional, ["fill", "input", value]);
  }
  assert.deepEqual(parseBrowserArguments(["fill", "r", "input", "--", "--json"]).positional, ["fill", "r", "input", "--json"]);
  assert.equal(parseBrowserArguments(["network", "r", "--filter", "--backend peer"]).networkFilter, "--backend peer");
  assert.equal(parseBrowserArguments(["clipboard", "r", "write", "--text", "--help"]).text, "--help");
  assert.equal(parseBrowserArguments(["mouse", "wheel", "--dy", "-3"]).positional.at(-1), "-3");
  const scripts = parseBrowserArguments(["create", "--init-script", "a.js", "--init-script=b.js", "--enable", "react-devtools"]);
  assert.deepEqual(scripts.initScriptFiles, ["a.js", "b.js"]);
  assert.deepEqual(scripts.enabledFeatures, ["react-devtools"]);
});

test("invalid wait states and deadlines are rejected before backend selection", async () => {
  for (const state of ["typo", "", "VISIBLE"]) {
    await rejected(["wait", "r", "selector", "body", "--state", state], "browser_wait_state_invalid", "--state");
    await rejected(["wait", "r", "--selector", "body", "--state", state], "browser_wait_state_invalid", "--state");
    await rejected(["wait", "r", "load", state], "browser_wait_load_invalid");
    await rejected(["wait", "r", "--load", state], "browser_wait_load_invalid");
  }
  for (const timeout of ["-1", "120001", "1.5", "forever"]) {
    await rejected(["wait", "r", "text", "Ready", "--timeout", timeout], "browser_wait_timeout_invalid");
    await rejected(["wait", "r", "duration", timeout], "browser_wait_timeout_invalid");
  }
});
