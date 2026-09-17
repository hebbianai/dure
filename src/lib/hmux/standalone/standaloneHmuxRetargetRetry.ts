const DEFAULT_DELAYS_MS = [0, 25, 50, 100, 200, 400] as const;
const DEFAULT_MAX_OWNERS = 64;

export interface StandaloneHmuxRetargetRetryOptions {
  delaysMs?: readonly number[];
  maxOwners?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

interface RetryOwner {
  fingerprint: string;
  result: Promise<boolean>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Own one bounded retry sequence per durable retarget operation.
 *
 * Duplicate WebView events share the same promise. Reusing an operation ID
 * with a different canonical payload fails closed instead of allowing an
 * older projection to overwrite a newer durable target.
 */
export class StandaloneHmuxRetargetRetryCoordinator {
  private readonly owners = new Map<string, RetryOwner>();
  private readonly delaysMs: readonly number[];
  private readonly maxOwners: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: StandaloneHmuxRetargetRetryOptions = {}) {
    this.delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
    this.maxOwners = options.maxOwners ?? DEFAULT_MAX_OWNERS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  run(
    operationId: string,
    fingerprint: string,
    attempt: () => Promise<boolean>,
  ): Promise<boolean> {
    const current = this.owners.get(operationId);
    if (current) {
      return current.fingerprint === fingerprint
        ? current.result
        : Promise.resolve(false);
    }
    if (this.owners.size >= this.maxOwners) return Promise.resolve(false);

    let result!: Promise<boolean>;
    result = Promise.resolve()
      .then(async () => {
        for (const delayMs of this.delaysMs) {
          if (delayMs > 0) await this.sleep(delayMs);
          try {
            if (await attempt()) return true;
          } catch {
            // A mounted pane may be between Dockview/WebView instances. The
            // next bounded attempt re-reads the durable layout and live pane.
          }
        }
        return false;
      })
      .finally(() => {
        if (this.owners.get(operationId)?.result === result) {
          this.owners.delete(operationId);
        }
      });
    this.owners.set(operationId, { fingerprint, result });
    return result;
  }

  activeOwnerCount(): number {
    return this.owners.size;
  }
}

export const standaloneHmuxRetargetRetry =
  new StandaloneHmuxRetargetRetryCoordinator();
