import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

test("invalid pointer proposals cannot resolve or dispatch a backend", async () => {
  for (const values of [[], ["move", "1"], ["move", "NaN", "1"], ["move", "1000001", "0"], ["move", "", "1"], ["down", "none"], ["up", "LEFT"], ["down", "left", "right"], ["wheel"], ["wheel", "Infinity"], ["wheel", "0", "-1000001"], ["wheel", "1", "2", "3"]]) {
    let contacts = 0;
    const result = await collectBrowserCommand({args:["mouse", "resource", ...values], resolveBackend:async () => { contacts++; throw new Error("unexpected backend contact"); }});
    assert.equal(contacts, 0, JSON.stringify(values));
    assert.equal(result.error.code, "browser_mouse_invalid");
  }
});
