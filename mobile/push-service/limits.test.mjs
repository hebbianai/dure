import assert from "node:assert/strict";
import { test } from "node:test";
import { charge, clientKey, createBuckets, createLimits } from "./limits.mjs";

const clock = (start = 1_000_000) => {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
};

test("a bucket spends its burst, then refills one token per interval and says how long to wait", () => {
  const now = clock();
  const buckets = createBuckets({ capacity: 3, refillMs: 60_000, now });
  assert.deepEqual([buckets.take("a"), buckets.take("a"), buckets.take("a")], [0, 0, 0]);
  assert.equal(buckets.take("a"), 60);
  now.advance(30_000);
  assert.equal(buckets.take("a"), 30);
  now.advance(30_000);
  assert.equal(buckets.take("a"), 0);
  assert.equal(buckets.take("b"), 0, "another key has its own bucket");
  now.advance(10 * 60_000);
  assert.deepEqual([buckets.take("a"), buckets.take("a"), buckets.take("a"), buckets.take("a")], [0, 0, 0, 60], "never more than the burst");
});

test("check does not spend, and a reserve keeps tokens back", () => {
  const now = clock();
  const buckets = createBuckets({ capacity: 5, refillMs: 1000, now });
  assert.equal(buckets.check("a"), 0);
  assert.equal(buckets.size, 0, "checking creates nothing");
  for (let index = 0; index < 3; index++) assert.equal(buckets.take("a", { reserve: 2 }), 0);
  assert.equal(buckets.take("a", { reserve: 2 }), 1, "the last two are reserved");
  assert.equal(buckets.take("a"), 0);
  assert.equal(buckets.take("a"), 0);
  assert.equal(buckets.take("a"), 1);
});

test("only full buckets are evicted; with none, a new key waits instead of erasing a limit", () => {
  const now = clock();
  const buckets = createBuckets({ capacity: 2, refillMs: 1000, maxKeys: 2, now });
  assert.equal(buckets.take("a"), 0);
  assert.equal(buckets.take("b"), 0);
  assert.equal(buckets.take("c"), 1, "both buckets are still draining");
  assert.equal(buckets.size, 2);
  now.advance(1000);
  assert.equal(buckets.take("c"), 0, "refilled buckets are evicted for the new key");
  assert.equal(buckets.size, 1);
  assert.equal(buckets.take("a"), 0, "a was evicted while full, and starts full again");
  assert.equal(buckets.take("a"), 0);
});

test("charge takes from every bucket or from none", () => {
  const now = clock();
  const narrow = createBuckets({ capacity: 1, refillMs: 60_000, now });
  const wide = createBuckets({ capacity: 10, refillMs: 60_000, now });
  assert.equal(charge([wide, "w"], [narrow, "n"]), 0);
  assert.equal(charge([wide, "w"], [narrow, "n"]), 60);
  // The refused charge left the wide bucket at nine.
  for (let index = 0; index < 9; index++) assert.equal(wide.take("w"), 0, `token ${index}`);
  assert.equal(wide.take("w"), 60);
});

test("the service limits match the documented budgets", () => {
  const now = clock();
  const limits = createLimits({ now });
  const burst = (buckets, key, options) => {
    let taken = 0;
    while (buckets.take(key, options) === 0) taken++;
    return taken;
  };
  assert.equal(burst(limits.failures, "ip"), 30);
  assert.equal(burst(limits.registers, "ip"), 30);
  assert.equal(burst(limits.challengeStarts, "ip"), 10);
  assert.equal(burst(limits.challenges, "all"), 1200);
  assert.equal(limits.challenges.take("other"), 3, "one global bucket, and no room for a second");
  assert.equal(burst(limits.hubRegisters, "hub"), 10);
  assert.equal(burst(limits.tokenChallengesHour, "token"), 3);
  assert.equal(burst(limits.tokenChallengesDay, "token"), 10);
  assert.equal(burst(limits.tokenSends, "token", { reserve: 50 }), 250);
  assert.equal(burst(limits.tokenSends, "token"), 50);
  assert.equal(burst(limits.hubSends, "binding+hub"), 10);
  assert.equal(limits.hubSends.take("binding+hub"), 60);
});

test("a client is an IPv4 address, or the /64 of an IPv6 one", () => {
  assert.equal(clientKey("198.51.100.7"), "198.51.100.7");
  assert.equal(clientKey("::ffff:198.51.100.7"), "198.51.100.7", "IPv4 on a dual-stack socket");
  const subnet = "2001:db8:1:2::/64";
  for (const address of ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:DB8:0001:0002:a::b", " 2001:db8:1:2::3 ", "2001:db8:1:2::4%en0"]) {
    assert.equal(clientKey(address), subnet, address);
  }
  assert.equal(clientKey("2001:db8:1:3::1"), "2001:db8:1:3::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("64:ff9b::192.0.2.1"), "64:ff9b:0:0::/64");
  assert.equal(clientKey("x".repeat(100)), "x".repeat(64), "anything else, bounded");
});
