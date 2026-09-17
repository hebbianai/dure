import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_EXCLUDED_ROOTS = new Set(["binaries", "gen", "icons", "target"]);
const DEPENDENCY_ENTRY = fileURLToPath(import.meta.resolve("dependency-cruiser"));
const NODE_MODULES_MARKER = `${path.sep}node_modules${path.sep}`;
const NODE_MODULES_ROOT = DEPENDENCY_ENTRY.slice(
  0,
  DEPENDENCY_ENTRY.indexOf(NODE_MODULES_MARKER) + NODE_MODULES_MARKER.length - 1,
);

/**
 * Build an isolated repository facade for fingerprint tests. The staged
 * runtime witness lives below the temporary root, so a killed test worker can
 * never leave an ignored file that satisfies the production checkout's
 * fail-closed prerequisite.
 */
export function createHmuxSmokeTestRepository(repoRoot, entryScripts = []) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hmux-smoke-test-repo-")),
  );
  try {
    for (const directory of ["crates", "hmux"]) {
      symlinkSync(path.join(repoRoot, directory), path.join(root, directory), "dir");
    }
    // Launch authority imports shared frontend contracts. Resolve them inside
    // this fixture rather than through a symlink into the working checkout.
    cpSync(path.join(repoRoot, "src"), path.join(root, "src"), {
      recursive: true,
    });
    symlinkSync(NODE_MODULES_ROOT, path.join(root, "node_modules"), "dir");
    cpSync(path.join(repoRoot, "cli"), path.join(root, "cli"), {
      recursive: true,
    });
    for (const file of ["package.json", "tsconfig.json"]) {
      symlinkSync(path.join(repoRoot, file), path.join(root, file), "file");
    }

    const adapterRoot = path.join(repoRoot, "src-tauri");
    cpSync(adapterRoot, path.join(root, "src-tauri"), {
      recursive: true,
      filter(source) {
        const relative = path.relative(adapterRoot, source);
        if (!relative) return true;
        return !ADAPTER_EXCLUDED_ROOTS.has(relative.split(path.sep)[0]);
      },
    });
    const binaries = path.join(root, "src-tauri", "binaries");
    mkdirSync(binaries, { recursive: true });
    writeFileSync(
      path.join(binaries, "hmux-runtime-fixture-target"),
      "test-only staged runtime witness\n",
    );

    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true });
    // dependency-cruiser resolves directory symlinks to their host checkout.
    // Copy these small script trees so the fixture exercises the same
    // repository-relative closure instead of appearing to escape its root.
    cpSync(path.join(repoRoot, "scripts", "lib"), path.join(scripts, "lib"), {
      recursive: true,
    });
    cpSync(path.join(repoRoot, "scripts", "qa"), path.join(scripts, "qa"), {
      recursive: true,
    });
    cpSync(
      path.join(repoRoot, "scripts", "native"),
      path.join(scripts, "native"),
      { recursive: true },
    );
    for (const entry of [
      "guard-hmux-app-stage.mjs",
      "hmux-dev-build-id.mjs",
      "install-dure-cli.mjs",
      "node-dependency-preflight.mjs",
      "stage-mobile-runtime.mjs",
      "run-dev-launch-child.mjs",
      "run-process-group-witness.mjs",
      "stage-hmux-runtime.sh",
      "verify-hmux-dev-activation.mjs",
    ]) {
      cpSync(path.join(repoRoot, "scripts", entry), path.join(scripts, entry));
    }
    for (const entry of entryScripts) {
      cpSync(path.join(repoRoot, "scripts", entry), path.join(scripts, entry));
    }
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
  return {
    root,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}
