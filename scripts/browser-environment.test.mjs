import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

test("invalid environment input cannot resolve or dispatch a backend mutation", async () => {
  for (const args of [
    ["viewport", "r", "0", "480"], ["viewport", "r", "", "480"],
    ["viewport", "r", "640.5", "480"], ["viewport", "r", "640", "480", "--scale", "NaN"],
    ["viewport", "r", "4000", "4000", "--scale", "2"],
    ["viewport", "r", "reset", "--mobile"], ["viewport", "r", "640", "480", "--color-scheme", "dark"],
    ["media", "r"], ["media", "r", "--color-scheme", "constructor"],
    ["media", "r", "--reduced-motion", "reduce", "--mobile"],
    ["media", "r", "print", "--color-scheme", "constructor"],
    ["media", "r", "reset", "--reduced-motion", "reduce"],
    ["set", "r", "media", "screen", "--mobile"], ["set", "r", "arbitrary", "{}"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({
      args,
      resolveBackend: async () => { contacts++; return { profile: { id: "environment-test" } }; },
      requestBackend: async () => { contacts++; throw new Error("unexpected dispatch"); },
    });
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^browser_(environment|viewport)_invalid$/);
  }
});

test("malformed device input cannot reach a backend", async () => {
  for (const args of [
    ["device", "r"], ["device", "r", ""], ["device", "r", "x".repeat(129)],
    ["device", "r", "iPhone\n15"], ["device", "r", "iPhone 15", "extra"],
    ["device", "r", "iPhone 15", "--mobile"], ["set", "r", "device", "reset", "--scale", "2"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({args, resolveBackend: async () => { contacts++; throw new Error("unexpected backend contact"); }});
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^browser_(device|environment|command)_invalid$/);
  }
});

test("invalid location, header and permission input cannot reach a backend", async () => {
  for (const args of [
    ["geo", "r", "91", "0"], ["geo", "r", "0", "181"],
    ["geo", "r", "0", "0", "--accuracy", "-1"], ["geo", "r", "reset", "--accuracy", "1"],
    ["geo", "r", "0", "0", "--mobile"], ["offline", "r", "yes"],
    ["headers", "r", "null"], ["headers", "r", "[]"], ["headers", "r", "bad-json"],
    ["headers", "r", '{"x":3}'], ["headers", "r", '{"X":"one","x":"two"}'],
    ["headers", "r", JSON.stringify({"x-bad":"first\r\nx-injected: second"})],
    ["headers", "r", JSON.stringify({"bad name":"value"})],
    ["headers", "r", JSON.stringify({"x":"x".repeat(65536)})],
    ["permission", "r", "geolocation", "granted", "https://example.com/path"],
    ["permission", "r", "geolocation", "granted", "https://user@example.com"],
    ["permission", "r", "geolocation", "granted", "file:///"],
    ["permission", "r", "geolocation", "constructor", "https://example.com"],
    ["permission", "r", "camera", "granted", "https://example.com"],
    ["set", "r", "offline", "on", "--accuracy", "2"],
  ]) {
    let contacts = 0;
    const result = await collectBrowserCommand({
      args,
      resolveBackend: async () => { contacts++; throw new Error("unexpected backend contact"); },
    });
    assert.equal(contacts, 0, JSON.stringify(args));
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^browser_(environment|geolocation|headers|offline|permission|permission_origin)_invalid$/);
  }
});
