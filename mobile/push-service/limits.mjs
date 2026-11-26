// Abuse limits of the push service (#660): token buckets in bounded maps.
//
// A bucket that is full holds nothing a fresh one would not, so only full
// buckets are ever evicted. When a map is full of buckets that are still
// draining, a new key is refused rather than let it erase someone's limit.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `capacity` tokens per key, one more every `refillMs`. `check` and `take`
 * answer 0 when the request may go ahead, otherwise the seconds to wait.
 * `reserve` keeps that many tokens back for requests that pass none.
 */
export function createBuckets({ capacity, refillMs, maxKeys = 100_000, now = Date.now }) {
  const buckets = new Map();
  const level = (bucket, at) => Math.min(capacity, bucket.tokens + (at - bucket.at) / refillMs);
  const wait = (tokens) => Math.max(1, Math.ceil(((1 - tokens) * refillMs) / 1000));
  const room = (at) => {
    if (buckets.size < maxKeys) return true;
    for (const [key, bucket] of buckets) if (level(bucket, at) >= capacity) buckets.delete(key);
    return buckets.size < maxKeys;
  };
  const check = (key, { reserve = 0 } = {}) => {
    const at = now();
    const bucket = buckets.get(key);
    if (!bucket) return room(at) ? (capacity - reserve >= 1 ? 0 : wait(capacity - reserve)) : Math.ceil(refillMs / 1000);
    const tokens = level(bucket, at) - reserve;
    return tokens >= 1 ? 0 : wait(tokens);
  };
  return {
    check,
    take(key, options) {
      const delay = check(key, options);
      if (delay) return delay;
      const at = now();
      const bucket = buckets.get(key);
      buckets.set(key, { tokens: (bucket ? level(bucket, at) : capacity) - 1, at });
      return 0;
    },
    get size() { return buckets.size; },
  };
}

/** Takes one token from every `[buckets, key, options]` or from none. */
export function charge(...claims) {
  const delay = Math.max(0, ...claims.map(([buckets, key, options]) => buckets.check(key, options)));
  if (delay) return delay;
  for (const [buckets, key, options] of claims) buckets.take(key, options);
  return 0;
}

/**
 * The service's limits. Those keyed by a client address apply before
 * anything is verified; the rest are created only for a verified computer,
 * phone key or token, so forged requests cannot fill them.
 */
export function createLimits({ now = Date.now } = {}) {
  const per = (count, period, maxKeys) => createBuckets({ capacity: count, refillMs: period / count, maxKeys, now });
  return {
    /** Per client address. */
    failures: per(30, MINUTE, 20_000),
    registers: per(30, MINUTE, 20_000),
    challengeStarts: per(10, HOUR, 20_000),
    /** One key: every challenge alert the service sends. */
    challenges: per(1200, HOUR, 1),
    /** Per verified computer. */
    hubRegisters: per(10, MINUTE),
    /** Per token: challenge alerts. */
    tokenChallengesHour: per(3, HOUR),
    tokenChallengesDay: per(10, DAY),
    /** Per token: alerts, the last {@link APPROVAL_RESERVE} kept for approvals. */
    tokenSends: per(300, DAY),
    /** Per proven binding and computer: one computer cannot spend another's. */
    hubSends: createBuckets({ capacity: 10, refillMs: MINUTE, now }),
  };
}

/** How many of a token's daily alerts only approvals may use. */
export const APPROVAL_RESERVE = 50;
