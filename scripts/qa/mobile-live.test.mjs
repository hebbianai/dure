import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { test } from "node:test";
const { input, key } = createRequire(import.meta.url)("../../src-tauri/src/mobile_simulator/live.cjs");

test("all printable ASCII maps to a valid HID key", () => {
  for (let code = 32; code < 127; code++) assert.ok(Number.isInteger(key(String.fromCharCode(code))[0]));
  assert.deepEqual(key("A"), [4, true]);
  assert.deepEqual(key("a"), [4, false]);
  assert.deepEqual(key("%"), [34, true]);
});
test("touch releases even when native movement fails; stale frame cannot start input", async () => {
  const calls = [];
  const hid = { touch: async (...args) => { calls.push(args); if (args[0] === "move") throw Error("injected HID failure"); } };
  const action = { kind: "gesture", start: { x: 0.5, y: 0.7 }, end: { x: 0.5, y: 0.2 }, width: 100, height: 200 };
  await assert.rejects(input(hid, action, { width: 200, height: 100 }), /orientation/);
  assert.deepEqual(calls, []);
  await assert.rejects(input(hid, action, { width: 100, height: 200 }), /injected HID/);
  assert.deepEqual(calls.map(([phase]) => phase), ["begin", "move", "end"]);
  assert.deepEqual(calls[0], ["begin", 0.5, 0.7, 100, 200, 0]);
  assert.deepEqual(calls.at(-1), ["end", 0.5, 0.2, 100, 200, 0]);
});
test("typing releases the modifier after a native failure and rejects Unicode before input", async () => {
  const calls = [];
  const hid = { key: async (phase, usage) => { calls.push([phase, usage]); if (usage === 4) throw Error("key failed"); } };
  await assert.rejects(input(hid, { kind: "type", text: "한글" }), /ASCII/);
  assert.deepEqual(calls, []);
  await assert.rejects(input(hid, { kind: "type", text: "A" }), /key failed/);
  assert.deepEqual(calls.at(-1), ["up", 225]);
});
