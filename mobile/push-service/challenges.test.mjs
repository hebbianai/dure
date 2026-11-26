import assert from "node:assert/strict";
import { test } from "node:test";
import { createChallenges, createRefusedTokens } from "./challenges.mjs";

const clock = () => {
  let at = 1_000_000;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
};
const key = "B".repeat(87);
const sameIdOtherKey = "C".repeat(87);

test("a challenge is answered only by its own key's nonce, until it expires", () => {
  const now = clock();
  const challenges = createChallenges({ now });
  assert.equal(challenges.get("token", key), undefined);
  const entry = challenges.open("token", key);
  assert.match(entry.nonce, /^[0-9a-f]{32}$/);
  assert.equal(entry.pushedAt, now());
  assert.equal(challenges.get("token", key), entry);
  assert.equal(challenges.answers("token", key, entry.nonce), true);
  assert.equal(challenges.answers("token", sameIdOtherKey, entry.nonce), false, "the whole key, not its short id");
  assert.equal(challenges.answers("other token", key, entry.nonce), false);
  assert.equal(challenges.answers("token", key, "0".repeat(32)), false);
  now.advance(10 * 60_000);
  assert.equal(challenges.answers("token", key, entry.nonce), false, "ten minutes");
  assert.equal(challenges.get("token", key), undefined);
});

test("a full table refuses new challenges and makes room only as entries expire", () => {
  const now = clock();
  const challenges = createChallenges({ now, max: 2 });
  challenges.open("a", key);
  now.advance(60_000);
  challenges.open("b", key);
  assert.equal(challenges.full(), true);
  now.advance(9 * 60_000);
  assert.equal(challenges.full(), false, "the first expired");
  assert.equal(challenges.size, 1);
});

test("a refused token stays refused for a day, and a full cache forgets the oldest", () => {
  const now = clock();
  const refused = createRefusedTokens({ now, max: 2 });
  refused.add("a");
  refused.add("b");
  refused.add("c");
  assert.deepEqual(["a", "b", "c"].map((id) => refused.has(id)), [false, true, true]);
  now.advance(24 * 3600_000);
  assert.equal(refused.has("b"), false);
});
