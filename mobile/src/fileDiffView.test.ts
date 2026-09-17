/**
 * The patch screen's four answers.
 *
 * jsdom reports `navigator.language` as `en-US`, so `t()` resolves through
 * `locales/en.ts` here — these assertions read the English catalogue's values,
 * which is also what checks that a new Korean string was actually translated.
 *
 * Every test here is about a distinction that is invisible once it is wrong:
 * a binary file drawn as unchanged, a truncated body drawn as a whole file, a
 * rename drawn as a failed load. The rendering itself is unremarkable.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { renderFileDiff } from "./fileDiffView";
import { patchFromOutcome } from "./fileDiffView";
import type { FileDiffOutcome } from "./ipc";

const outcome = (over: Partial<FileDiffOutcome>): FileDiffOutcome => ({
  read: true,
  path: "src/app.ts",
  patch: "",
  truncated: false,
  binary: false,
  added: null,
  deleted: null,
  code: null,
  detail: null,
  ...over,
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("patchFromOutcome", () => {
  it("keeps a binary file apart from a file with an empty patch", () => {
    expect(patchFromOutcome(outcome({ binary: true, patch: null }))).toEqual({ kind: "binary" });
    // An empty body is "nothing in this file changed" — a different sentence,
    // and the one a person would act on differently.
    expect(patchFromOutcome(outcome({ patch: "" }))).toEqual({
      kind: "read",
      patch: "",
      truncated: false,
    });
  });

  it("drops absent counts rather than printing them as zero", () => {
    const read = patchFromOutcome(outcome({ patch: "@@ -1 +1 @@\n+a\n", added: 1, deleted: null }));

    expect(read).toEqual({ kind: "read", patch: "@@ -1 +1 @@\n+a\n", truncated: false, added: 1 });
  });

  it("names an old box rather than repeating its refusal", () => {
    const failed = patchFromOutcome(
      outcome({ read: false, code: "unsupported_protocol_version", detail: "malformed" }),
    );

    // "malformed" sends somebody to file a bug. The fix is to update that box,
    // and the code — not the sentence — is what this branches on.
    expect(failed).toEqual({
      kind: "failed",
      detail: "This box's hmux is too old to read a file's changes",
    });
  });

  it("falls back for a refusal with no reason at all", () => {
    // `??` here would leave a blank line in exactly this case.
    expect(patchFromOutcome(outcome({ read: false, detail: "" }))).toEqual({
      kind: "failed",
      detail: "The laptop did not say why",
    });
  });
});

describe("renderFileDiff", () => {
  const actions = { back: () => {} };

  it("shows the file's name and its counts, not the whole path", () => {
    const screen = renderFileDiff(
      {
        path: "src/lib/payments/retry.ts",
        patch: { kind: "read", patch: "@@ -1 +1 @@\n+a\n", truncated: false, added: 6 },
      },
      actions,
    );
    document.body.append(screen);

    expect(screen.querySelector(".session__title")?.textContent).toBe("retry.ts");
    expect(screen.querySelector(".diff__added")?.textContent).toBe("+6");
    // Nobody counted deletions, so nothing is drawn for them.
    expect(screen.querySelector(".diff__deleted")).toBeNull();
  });

  it("draws a sign beside every added and removed line", () => {
    const screen = renderFileDiff(
      {
        path: "a.ts",
        patch: {
          kind: "read",
          patch: "@@ -1,2 +1,2 @@\n keep\n-gone\n+fresh\n",
          truncated: false,
        },
      },
      actions,
    );

    // Colour alone would leave the two indistinguishable for a person with a
    // colour vision deficiency, and they are the whole point of the screen.
    const added = screen.querySelector(".diff__row--added");
    const removed = screen.querySelector(".diff__row--removed");
    expect(added?.querySelector(".diff__sign")?.textContent).toBe("+");
    expect(removed?.querySelector(".diff__sign")?.textContent).toBe("−");
  });

  it("says the body was cut rather than ending silently", () => {
    const screen = renderFileDiff(
      { path: "big.ts", patch: { kind: "read", patch: "@@ -1 +1 @@\n+a\n", truncated: true } },
      actions,
    );

    // Without this line the screen claims the file ends here.
    expect(screen.querySelector(".diff__truncated")).not.toBeNull();
  });

  it("explains a rename instead of drawing an empty screen", () => {
    const screen = renderFileDiff(
      {
        path: "new.ts",
        // git prints a header and no hunks for a pure rename.
        patch: { kind: "read", patch: "diff --git a/old.ts b/new.ts\nrename to new.ts\n", truncated: false },
      },
      actions,
    );

    expect(screen.querySelector(".scm__pending-title")?.textContent).toBe(
      "The file's contents are unchanged",
    );
  });

  it("says a binary file has nothing to show rather than nothing changed", () => {
    const screen = renderFileDiff({ path: "logo.png", patch: { kind: "binary" } }, actions);

    expect(screen.querySelector(".scm__pending-title")?.textContent).toBe("This is a binary file");
  });

  it("prints the answering side's own reason for a failure", () => {
    const screen = renderFileDiff(
      { path: "a.ts", patch: { kind: "failed", detail: "그 상자에 git 이 없습니다" } },
      actions,
    );

    // Rewriting it here would erase the difference between "install git" and
    // "that session is gone".
    expect(screen.querySelector(".scm__pending-note")?.textContent).toBe("그 상자에 git 이 없습니다");
  });
});
