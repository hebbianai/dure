import { setTimeout as delay } from "node:timers/promises";

const intervalMs = 1500;
const concurrency = 16;

/** Own transport work, not task state. The journal supplies each current poll;
 * one slow poll cannot hold the next cycle of unrelated threads or shares. */
export class SlackPoller {
  constructor({ signal, polls, onError }) {
    Object.assign(this, { signal, polls, onError });
    this.jobs = new Map();
    this.failure = Promise.withResolvers();
  }

  run() {
    this.loop = this.drain();
    return Promise.race([this.loop, this.failure.promise]);
  }

  async drain() {
    while (!this.signal.aborted) {
      const polls = new Map(this.polls());
      for (const [key, job] of this.jobs) {
        if (!job.running && !polls.has(key)) this.jobs.delete(key);
      }
      for (const key of polls.keys()) {
        if (!this.jobs.has(key)) this.jobs.set(key, { nextAt: Date.now() });
      }
      let slots = concurrency - [...this.jobs.values()].filter((job) => job.running).length;
      // Oldest-due work goes first. New threads cannot continually jump ahead
      // of existing conversations. Never overlap polls of the same key.
      for (const [key, job] of [...this.jobs].sort((a, b) => a[1].nextAt - b[1].nextAt)) {
        if (slots <= 0 || this.signal.aborted) break;
        if (job.running || job.nextAt > Date.now() || !polls.has(key)) continue;
        slots--;
        job.nextAt = Date.now() + intervalMs;
        job.running = Promise.resolve().then(() => {
          this.signal.throwIfAborted();
          return polls.get(key)((error, messageId) => {
            job.nextAt = Math.max(job.nextAt, Date.now() + (error.retryAfterMs ?? 3000));
            this.onError(error, messageId);
          });
        }).catch((error) => this.failure.reject(error)).finally(() => {
          job.running = undefined;
        });
      }
      await delay(intervalMs, undefined, { signal: this.signal });
    }
  }

  // The connector aborts transports before settling, then releases the journal.
  async settle() {
    await Promise.allSettled([this.loop, ...[...this.jobs.values()].map((job) => job.running)]);
  }
}
