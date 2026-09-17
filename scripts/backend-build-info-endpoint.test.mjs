import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import { tryBackendRuntimeFingerprint } from "./lib/backend-runtime-fingerprint.mjs";
import {
  normalizeFrontendRuntimeObservation,
} from "../src/contracts/frontendRuntimeObservation.mjs";

let server;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("frontend runtime observation endpoint", () => {
  it("serves the current runtime fingerprint without HTTP caching", async () => {
    const repositoryRoot = process.cwd();
    server = await createServer({
      configFile: path.join(repositoryRoot, "vite.config.ts"),
      server: {
        hmr: false,
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        watch: null,
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite test server did not expose a TCP address");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/__app_build_info`,
      { headers: { Connection: "close" } },
    );
    const buildInfo = await response.json();

    expect(response.ok).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(normalizeFrontendRuntimeObservation(buildInfo)).toEqual(buildInfo);
    expect(buildInfo).toEqual({
      schemaVersion: 1,
      buildId: expect.stringMatching(/^\d+\.\d+\.\d+\+[A-Za-z0-9._+-]+$/),
      sourceRevision: expect.stringMatching(/^[0-9a-f]{12}$/),
      worktreeOverlay: expect.stringMatching(/^(clean|present)$/),
      backendRuntimeFingerprint:
        tryBackendRuntimeFingerprint(repositoryRoot),
    });

    const legacyResponse = await fetch(
      `http://127.0.0.1:${address.port}/__app_build_id`,
      { headers: { Connection: "close" } },
    );
    expect((await legacyResponse.text()).trim()).not.toBe(buildInfo.buildId);
  });
});
