import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Use the same optimizer as the installed Vite, without building/staging an app.
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = {
  "@/store": `export function useStore() { throw new Error("unexpected workspace access"); }`,
  "@/lib/ipc": `
    let record;
    export const feed = (value) => { record = value; };
    export const hmux = {
      attachStructuredTerminal: async () => ({
        terminalEpoch: "terminal-a", throughOutputSeq: "0", stateRevision: "0",
        initialDeliveryRecordCount: 0, selectedCapabilities: [],
      }),
      nextStructuredTerminalRecord: async () => record,
    };
  `,
  "@/lib/hmux/remote/remoteHmuxControllerResolution": `
    export function resolveRemoteHmuxStandaloneController() { throw new Error("unexpected remote attach"); }
  `,
};

async function compile(mode) {
  return build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `
        export { attachStructuredTerminalRecords } from "./src/lib/terminal/structuredTerminalRecordAdapter";
        export { terminalInputLatency } from "./src/lib/terminal/interaction/terminalInputLatency";
        export { viewportFrameRecord } from "./src/test/terminalRecordFixtures";
        export { feed } from "@/lib/ipc";
      `,
    },
    bundle: true,
    write: false,
    minify: true,
    metafile: true,
    format: "esm",
    platform: "browser",
    alias: { "@": `${root}src` },
    define: {
      "import.meta.env.MODE": JSON.stringify(mode),
      "import.meta.env.DEV": "false",
      "import.meta.env.PROD": "true",
    },
    plugins: [{
      name: "isolated-native-boundary",
      setup(builder) {
        builder.onResolve({ filter: /^@\/(store|lib\/(ipc|hmux\/remote\/remoteHmuxControllerResolution))$/ }, ({ path }) => ({ path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: fixtures[path], loader: "js" }));
      },
    }],
  });
}

afterEach(() => vi.restoreAllMocks());

describe("terminal timing build isolation", () => {
  it.each(["production", "perf"])("runs the compiled %s carrier", async (mode) => {
    const built = await compile(mode);
    const code = built.outputFiles[0].text;
    const api = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    const adapter = await api.attachStructuredTerminalRecords({
      observerId: "observer-a", surfaceId: "surface-a", access: "writer", sshHosts: [],
      binding: { schemaVersion: 1, runtime: "hmux_standalone_v1", source: "local", hostId: "local", sessionId: "session-a", workspaceId: "workspace-a" },
    });
    adapter.startDelivery();
    api.terminalInputLatency.noteInput("surface-a");
    api.terminalInputLatency.beginInput({ terminalId: "surface-a" });
    api.feed(api.viewportFrameRecord().buffer);
    const clock = vi.spyOn(performance, "now");
    const frame = await adapter.readRecord();
    expect(frame.kind).toBe("terminal");
    const diagnosticBytes = Object.values(built.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs).filter(([path]) => path.endsWith("/qa/terminalDeliveryTiming.ts")),
    ).reduce((total, [, input]) => total + input.bytesInOutput, 0);
    if (mode === "production") {
      expect(clock).not.toHaveBeenCalled();
      expect(frame).not.toHaveProperty("deliveryTiming");
      expect(diagnosticBytes).toBe(0);
      expect(code).not.toContain("carrierFirstResolvedMs");
      expect(code).not.toContain("replicaAppliedMs");
    } else {
      expect(clock).toHaveBeenCalled();
      expect(frame.deliveryTiming.partCount).toBe(1);
      expect(diagnosticBytes).toBeGreaterThan(0);
      expect(code).toContain("carrierFirstResolvedMs");
    }
  });
});
