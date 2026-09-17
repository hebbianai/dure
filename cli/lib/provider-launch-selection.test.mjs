import assert from "node:assert/strict";
import test from "node:test";
import { isProviderEffortSelection, isProviderModelSelection } from "./contracts/provider-launch-selection.mjs";

test("provider model qualifiers pass unchanged without allowing shell syntax", () => {
  for (const value of ["gpt-next", "opus[1m]", "claude-fable-5-1[1m]", "fixture/model", "openrouter/provider/model:free", "x".repeat(256)]) assert.equal(isProviderModelSelection(value), true);
  for (const value of ["", "-flag", "x y", "x;cmd", "$(cmd)", "x\n", "x".repeat(257)]) assert.equal(isProviderModelSelection(value), false);
  assert.equal(isProviderEffortSelection("ultra"), true);
  assert.equal(isProviderEffortSelection("high[1m]"), false);
  assert.equal(isProviderEffortSelection("provider/high"), false);
  assert.equal(isProviderEffortSelection("x".repeat(65)), false);
});
