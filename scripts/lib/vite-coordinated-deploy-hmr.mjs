import {
  createDevDeployLockProbe,
  DEV_DEPLOY_HMR_STATUS_PATH,
  devDeployLockAuthorizes,
} from "./dev-deploy-lock.mjs";

/** Suppress per-file Vite updates while the exact live-worktree deploy lease is
 * active. A suppressed module is still invalidated so the coordinated reload
 * reads its new transform after the event burst becomes quiet. */
export function createCoordinatedDeployHmrPlugin({
  pathname,
  worktreeRoot,
  channel,
  now = Date.now,
}) {
  const probe = createDevDeployLockProbe({
    pathname,
    worktreeRoot,
    channel,
  });
  let activeGeneration = null;
  let suppressedCount = 0;
  let lastSuppressedAtUnixMs = null;

  const bindGeneration = (record) => {
    if (activeGeneration === record.generation) return;
    activeGeneration = record.generation;
    suppressedCount = 0;
    lastSuppressedAtUnixMs = null;
  };

  return {
    name: "dure-coordinated-deploy-hmr",
    apply: "serve",
    enforce: "post",
    hotUpdate({ modules, timestamp }) {
      const record = probe();
      if (!record) return;
      bindGeneration(record);
      suppressedCount += 1;
      lastSuppressedAtUnixMs = now();
      const invalidatedModules = new Set();
      for (const module of modules) {
        this.environment.moduleGraph.invalidateModule(
          module,
          invalidatedModules,
          timestamp,
          true,
        );
      }
      return [];
    },
    configureServer(server) {
      server.middlewares.use(DEV_DEPLOY_HMR_STATUS_PATH, (req, res) => {
        const record = probe({ force: true });
        if (!record || !devDeployLockAuthorizes(record, req.headers.authorization)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        bindGeneration(record);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            schemaVersion: 1,
            fenced: true,
            generation: record.generation,
            suppressedCount,
            lastSuppressedAtUnixMs,
            observedAtUnixMs: now(),
          }),
        );
      });
    },
  };
}
