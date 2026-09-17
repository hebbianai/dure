import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseMacosProcessIdentity, processMemberSnapshots } from "../../lib/process-identity.mjs";
import { armExclusiveNativeInput } from "./exclusive-native-input.mjs";
import { readWorkspacePerformanceDescriptor } from "./workspace-performance-descriptor.mjs";

const execute = promisify(execFile);
const sourceId = "com.apple.inputmethod.Korean.2SetKorean";
const codes = ["KeyG", "KeyK", "KeyS", "KeyR", "KeyM", "KeyF", "Space"];

export function assertBrowserOsImeEvidence({ native, focused, observed, value, pageId, controller }) {
  assert.equal(native.inputSourceId, sourceId);
  assert.equal(native.postedEventCount, 14);
  assert.deepEqual(native.keyCodes, [5, 40, 1, 15, 46, 3, 49]);
  assert.equal(focused.inputFocused, true);
  assert.equal(observed.inputFocused, true);
  assert.equal(focused.nativeIme.page.page_id, pageId);
  assert.deepEqual(observed.nativeIme.page, focused.nativeIme.page);
  assert.deepEqual(observed.nativeIme.controller, controller);
  assert.deepEqual(focused.nativeIme.controller, controller);
  assert.equal(observed.nativeIme.overflow, false);
  const events = observed.nativeIme.events;
  assert.ok(events.length > 0 && events.length < 128);
  assert.ok(events.every((event) => event.trusted === true && event.connected === true), "only OS events on the still-connected receiver prove native IME");
  assert.deepEqual(events.filter((event) => event.type === "keyup").map((event) => event.code), codes);
  const start = events.findIndex((event) => event.type === "compositionstart");
  const end = events.findIndex((event) => event.type === "compositionend");
  assert.ok(start >= 0 && end > start, "trusted native composition must start and commit");
  assert.ok(events.some((event) => event.type === "compositionupdate" && /[ㄱ-ㅎ가-힣]/u.test(event.data ?? "")), "the OS must expose actual Korean preedit");
  assert.ok(events.some((event) => event.type === "compositionend" && /[가-힣]/u.test(event.data ?? "")));
  assert.equal(value, "한글 ", "the canonical CLI must observe exact OS-composed text once");
}

export async function prepareBrowserOsIme(root) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.DURE_QA_LAYER, "exclusive_focus_browser_ime");
  assert.equal(process.env.HEBBIAN_QA_ALLOW_FOCUS_STEAL, "1");
  const binary = join(root, "browser-os-ime-keydown");
  assert.throws(() => lstatSync(binary), { code: "ENOENT" });
  const compiler = process.env.DURE_QA_SWIFTC_BIN ?? "/usr/bin/swiftc";
  accessSync(compiler, constants.X_OK);
  await execute(compiler, [resolve("scripts/qa/browser-os-ime-keydown.swift"), "-o", binary], { timeout: 60_000 });
  const metadata = lstatSync(binary);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o100));
  const inspection = JSON.parse((await execute(binary, ["--inspect"], { timeout: 10_000 })).stdout);
  assert.equal(inspection.koreanEnabled, true, "macOS two-set Korean must already be enabled");
  assert.equal(inspection.accessibilityTrusted, true, "native QA requires existing Accessibility permission");
  const processGroupId = Number(process.env.DURE_QA_ROOT_PID);
  assert.ok(Number.isSafeInteger(processGroupId) && processGroupId > 1);
  const minimumIdleMs = Number(process.env.HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS ?? 15_000);
  assert.ok(Number.isSafeInteger(minimumIdleMs) && minimumIdleMs >= 0 && minimumIdleMs <= 3_600_000);
  const target = () => {
    const descriptor = readWorkspacePerformanceDescriptor({
      descriptorPath: process.env.DURE_QA_SERVER_DESCRIPTOR, home: process.env.HOME, stateRoot: root,
    });
    assert.ok(Number.isSafeInteger(descriptor?.processId) && descriptor.processId > 1);
    const observation = processMemberSnapshots([descriptor.processId]);
    assert.equal(observation.status, "complete");
    const member = observation.members.find((row) => row.pid === descriptor.processId);
    assert.equal(member?.state, "live");
    assert.equal(member.groupId, processGroupId);
    const identity = parseMacosProcessIdentity(member.processIdentity);
    assert.ok(identity);
    return { processId: descriptor.processId, processGroupId, identity: member.processIdentity, uniqueId: identity.uniqueId };
  };
  return async ({ action, command, resourceId, pageId, controller }) => {
    const before = target();
    const focused = await action("native-ime-focus");
    assert.equal(focused.inputFocused, true);
    assert.ok(focused.inputLabel);
    assert.deepEqual(target(), before);
    await armExclusiveNativeInput({ stateRoot: root, requestPath: process.env.DURE_QA_EXCLUSIVE_INPUT_REQUEST, acknowledgementPath: process.env.DURE_QA_EXCLUSIVE_INPUT_ACK });
    assert.deepEqual(target(), before);
    const native = JSON.parse((await execute(binary, [String(before.processId), String(processGroupId), before.uniqueId,
      "Dure Browser Panel QA", focused.inputLabel, String(minimumIdleMs)], { timeout: 10_000 })).stdout);
    writeFileSync(join(root, "evidence/browser-os-ime-post.json"), JSON.stringify({ app: before, inspection, native }, null, 2), { flag: "wx", mode: 0o600 });
    assert.equal(native.schemaVersion, 1);
    assert.equal(native.processId, before.processId);
    assert.equal(native.processGroupId, processGroupId);
    assert.equal(native.processUniqueId, before.uniqueId);
    assert.ok(Number.isSafeInteger(native.idleMillisecondsAtPost) && native.idleMillisecondsAtPost >= minimumIdleMs);
    const observed = await action("native-ime-observe");
    assert.deepEqual(target(), before);
    const shown = await command(["show", resourceId]);
    assert.deepEqual(shown.result.control.controller, controller);
    assert.deepEqual(shown.result.pages.find((row) => row.page.page_id === pageId)?.page, focused.nativeIme.page);
    const value = (await command(["get", resourceId, "value", "input", "--page", pageId])).result.data.value;
    const evidence = { native, focused, observed, value, pageId, controller };
    assertBrowserOsImeEvidence(evidence);
    return { ...evidence, app: before, inspection };
  };
}
