// Proof of receipt (#660): before a phone key may bind a token, the service
// sends that token a challenge alert, and only the phone that receives it can
// sign its nonce back in its next grant.
//
// Challenges live in bounded memory only and are never persisted: losing
// them on a restart costs one more challenge alert.
import { randomBytes, timingSafeEqual } from "node:crypto";

const CHALLENGE_TTL_MS = 10 * 60_000;
/** A pending challenge is pushed again at most once a minute. */
export const CHALLENGE_REPEAT_MS = 60_000;
const NEGATIVE_TTL_MS = 24 * 60 * 60_000;

/**
 * Pending challenges by token record and key id. At `max` live entries a new
 * one is refused: a live entry is never evicted, or a flood of forged
 * registers could erase a real phone's challenge before it answers.
 */
export function createChallenges({ now = Date.now, max = 4096 } = {}) {
  const pending = new Map();
  const name = (id, keyId) => `${id}\0${keyId}`;
  const live = (entry) => entry.until > now();
  const sweep = () => {
    for (const [key, entry] of pending) if (!live(entry)) pending.delete(key);
  };
  return {
    /** The pending challenge for this token and key, opened if none; null when full. */
    open(id, keyId) {
      const key = name(id, keyId);
      const entry = pending.get(key);
      if (entry && live(entry)) return entry;
      pending.delete(key);
      if (pending.size >= max) sweep();
      if (pending.size >= max) return null;
      const opened = { nonce: randomBytes(16).toString("hex"), until: now() + CHALLENGE_TTL_MS, pushedAt: undefined };
      pending.set(key, opened);
      return opened;
    },
    /** Whether `nonce` answers this key's live challenge for the token. */
    answers(id, keyId, nonce) {
      const entry = pending.get(name(id, keyId));
      return Boolean(entry && live(entry) && timingSafeEqual(Buffer.from(entry.nonce), Buffer.from(nonce)));
    },
    close(id, keyId) {
      pending.delete(name(id, keyId));
    },
    get size() { return pending.size; },
  };
}

/**
 * Tokens APNs refused for a challenge or an alert, for 24 hours. Full, it
 * forgets the oldest: losing one costs a single repeated APNs call, which
 * the challenge budgets already bound.
 */
export function createRefusedTokens({ now = Date.now, max = 16_384 } = {}) {
  const refused = new Map();
  return {
    has(id) {
      const until = refused.get(id);
      if (until === undefined) return false;
      if (until > now()) return true;
      refused.delete(id);
      return false;
    },
    add(id) {
      refused.delete(id);
      if (refused.size >= max) refused.delete(refused.keys().next().value);
      refused.set(id, now() + NEGATIVE_TTL_MS);
    },
    get size() { return refused.size; },
  };
}
