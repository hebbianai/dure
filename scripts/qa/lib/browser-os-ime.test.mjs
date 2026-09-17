import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { assertBrowserOsImeEvidence } from "./browser-os-ime.mjs";

function receipt() {
  const page = { resource_id: "browser:fixture", workspace_id: "workspace-browser", generation: "1", page_id: "page-1", document_revision: "2" };
  const controller = { controller_id: "view:fixture", epoch: "2" };
  const event = (type, fields = {}) => ({ type, trusted: true, connected: true, ...fields });
  const events = [
    event("compositionstart", { data: "" }),
    event("compositionupdate", { data: "ㅎ" }),
    event("compositionend", { data: "한" }),
    event("compositionstart", { data: "" }),
    event("compositionupdate", { data: "글" }),
    event("compositionend", { data: "글" }),
    ...["KeyG", "KeyK", "KeyS", "KeyR", "KeyM", "KeyF", "Space"].map((code) => event("keyup", { code })),
  ];
  return {
    native: { inputSourceId: "com.apple.inputmethod.Korean.2SetKorean", postedEventCount: 14, keyCodes: [5, 40, 1, 15, 46, 3, 49] },
    focused: { inputFocused: true, nativeIme: { page, controller } },
    observed: { inputFocused: true, nativeIme: { page, controller, events, overflow: false } },
    value: "한글 ", pageId: "page-1", controller,
  };
}

describe("Browser OS IME evidence authority", () => {
  it("accepts trusted Korean preedit/commit on the same page and controller with exact CLI value", () => {
    assertBrowserOsImeEvidence(receipt());
  });
  for (const [name, invalidate] of [
    ["synthetic DOM composition", (row) => { row.observed.nativeIme.events[0].trusted = false; }],
    ["detached input receiver", (row) => { row.observed.nativeIme.events[0].connected = false; }],
    ["lost native focus", (row) => { row.observed.inputFocused = false; }],
    ["changed document", (row) => { row.observed.nativeIme.page = { ...row.observed.nativeIme.page, document_revision: "3" }; }],
    ["changed controller epoch", (row) => { row.observed.nativeIme.controller = { ...row.controller, epoch: "3" }; }],
    ["non-Korean input source", (row) => { row.native.inputSourceId = "com.apple.keylayout.ABC"; }],
    ["Unicode-only insertion without preedit", (row) => { row.observed.nativeIme.events = row.observed.nativeIme.events.filter((event) => event.type !== "compositionupdate"); }],
    ["uncommitted composition", (row) => { row.observed.nativeIme.events = row.observed.nativeIme.events.filter((event) => event.type !== "compositionend"); }],
    ["extra or missing key events", (row) => { row.observed.nativeIme.events.pop(); }],
    ["capture overflow", (row) => { row.observed.nativeIme.overflow = true; }],
    ["duplicated committed input", (row) => { row.value = "한글한글 "; }],
  ]) {
    it(`rejects ${name}`, () => {
      const evidence = receipt();
      invalidate(evidence);
      assert.throws(() => assertBrowserOsImeEvidence(evidence));
    });
  }
});
