import fs from "node:fs";
import path from "node:path";
import { cargoArtifact } from "./managed-provider-fixture.mjs";

const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!stateRoot) throw new Error("Run through webview-storage-smoke.sh");
const executable = await cargoArtifact([
  "build", "--locked", "--offline", "--manifest-path", "src-tauri/Cargo.toml",
  "--example", "webview_storage_qa",
], "webview_storage_qa", { kind: "qa" });
fs.writeFileSync(
  path.join(stateRoot, "evidence", "webview-storage-binary.json"),
  JSON.stringify({ executable }),
  { flag: "wx", mode: 0o600 },
);
