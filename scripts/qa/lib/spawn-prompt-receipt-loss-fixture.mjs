import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const REMOTE_INPUT_READER = `
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]) / "provider-inputs" / sys.argv[2]
inputs = [] if not root.is_dir() else [
    entry.read_text(encoding="utf-8")
    for entry in sorted(root.iterdir())
    if entry.name.endswith(".input") and entry.is_file()
]
print(json.dumps(inputs, separators=(",", ":")))
`;

function requireSafeId(value, label) {
  if (!value || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function localProviderInputs(captureRoot, sessionId) {
  const root = path.join(
    captureRoot,
    "provider-inputs",
    requireSafeId(sessionId, "provider session id"),
  );
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".input"))
    .sort()
    .map((name) => fs.readFileSync(path.join(root, name), "utf8"));
}

function parsedInputs(value) {
  const inputs = JSON.parse(value);
  if (
    !Array.isArray(inputs) ||
    inputs.some((input) => typeof input !== "string")
  ) {
    throw new Error("provider input observer returned an invalid payload");
  }
  return inputs;
}

function qaProjectReadyEvent(kind) {
  if (kind === "local") return "qa-local-project";
  if (kind === "ssh") return "qa-ssh-project";
  throw new Error(`DURE_QA_PROJECT_KIND is invalid: ${kind}`);
}

/** Select the project and input observer from one receipt-loss fixture mode. */
export function createReceiptLossFixture({
  captureRoot,
  environment = process.env,
  execute = execFileSync,
}) {
  const kind = environment.DURE_QA_PROJECT_KIND?.trim() || "local";
  const projectReadyEvent = qaProjectReadyEvent(kind);
  if (kind === "local") {
    return {
      projectReadyEvent,
      providerInputs: (sessionId) =>
        localProviderInputs(captureRoot, sessionId),
    };
  }

  const vm = environment.DURE_QA_PROVIDER_INPUTS_LIMA_VM?.trim();
  requireSafeId(vm, "Lima VM name");
  const remoteRoot = environment.DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT?.trim();
  if (!remoteRoot || !path.posix.isAbsolute(remoteRoot)) {
    throw new Error(
      "DURE_QA_PROVIDER_INPUTS_REMOTE_ROOT must be an absolute path",
    );
  }
  const limaHome = environment.DURE_QA_PROVIDER_INPUTS_LIMA_HOME?.trim();
  if (!limaHome || !path.isAbsolute(limaHome)) {
    throw new Error(
      "DURE_QA_PROVIDER_INPUTS_LIMA_HOME must be an absolute path",
    );
  }
  return {
    projectReadyEvent,
    providerInputs: (sessionId) =>
      parsedInputs(
        execute(
          "limactl",
          [
            "shell",
            "--tty=false",
            vm,
            "python3",
            "-c",
            REMOTE_INPUT_READER,
            remoteRoot,
            requireSafeId(sessionId, "provider session id"),
          ],
          {
            encoding: "utf8",
            env: { ...environment, LIMA_HOME: limaHome },
            timeout: 10_000,
          },
        ),
      ),
  };
}
