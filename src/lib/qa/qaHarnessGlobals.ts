interface QaHarnessGlobals {
  __DURE_STORE__?: unknown;
  __DURE_DOCK__?: unknown;
  __DURE_DIFF_BADGES__?: unknown;
}

/** Expose the dev-only harness through canonical Dure names without making the
 * harness module depend on Window. */
export function exposeQaHarnessGlobals(
  target: object,
  store: unknown,
  dock: unknown,
  diffBadges?: unknown,
) {
  const globals = target as QaHarnessGlobals;
  globals.__DURE_STORE__ = store;
  globals.__DURE_DOCK__ = dock;
  if (diffBadges !== undefined) globals.__DURE_DIFF_BADGES__ = diffBadges;
}
