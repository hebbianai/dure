import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const provider = path.join(root, "scripts/qa/fake-provider");
const result = spawnSync("sh", [path.join(root, "scripts/qa/lib/tauri-app-runner.sh")], {
  cwd: root, stdio: "inherit", env: { ...process.env,
    PATH: `${provider}:${process.env.PATH}`, DURE_QA_PROVIDER_BIN: provider, HEBBIAN_QA_PROVIDER_BIN: provider,
    DURE_QA_CLIENT: "scripts/qa/durable-runs-client.mjs", DURE_QA_NAME: "Durable Runs and multi-window presentation",
    DURE_QA_ARTIFACT_NAME: "durable-runs", DURE_QA_LAYER: "control_plane", DURE_QA_UNIQUE_APP_CHANNEL: "1",
    DURE_QA_WINDOW_PLAN_JSON: JSON.stringify(["main", "win-run-peer"].map((label) => ({ label,
      title: "Dure durable Run QA", url: "index.html", width: 1000, height: 700,
      x: -4000, y: -2000, visible: true, focus: false, focusable: false }))),
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
