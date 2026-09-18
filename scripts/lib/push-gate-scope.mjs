// Exact pushed paths -> the union of code gates that consume those paths.
//
// Keep this module deterministic and side-effect free. Both the local pre-push
// hook and CI import it, while their respective callers remain responsible for
// executing Git. Unknown or shared inputs expand to every scope (fail closed);
// documentation and tracker metadata have no code-gate scope.

import { isHmuxTestOnlyPath } from "./hmux-test-only-path.mjs";
import { packageManifestScriptImpactPaths } from "./package-manifest-script-impact.mjs";
import { isScriptTestOpaqueResourcePath } from "./script-test-graph-paths.mjs";

export const PUSH_GATE_SCOPES = Object.freeze([
  "app-core",
  "design-coverage",
  "desktop",
  "feedback",
  "frontend",
  "hmux-core",
  "hmux-mobile-compat",
  "hub-protocol",
  "mobile-rust",
  "mobile-web",
  "process",
  "qa-tooling",
  "relay",
  "sampler",
  "script-tests",
  "terminal-state-protocol",
  "tooling",
]);

const FULL_SCOPE_SET = PUSH_GATE_SCOPES;

const DOCUMENT_PREFIXES = ["docs/", "hmux/docs/"];
const DOCUMENT_EXTENSION = /\.(?:jsonl|md|mdx|txt)$/;
const PUBLIC_DOCUMENT_PREFIXES = ["docs/public/"];
// Internal Marketing Labs records are intentionally outside docs/ so they can
// never enter the reviewed public publication tree by directory copy. Only
// Markdown is documentation-only: future executables, machine data, media, or
// unknown artifacts under this lab remain fail-closed.
const MARKETING_LAB_PREFIX = "marketing-labs/";
const MARKETING_LAB_DOCUMENT_EXTENSION = /\.md$/;

// Generated product media is documentation output and selects no code gate.
// Its executable capture tooling has a dedicated gate below; other tools/
// paths remain unknown/shared inputs and therefore fail closed.
const NON_PRODUCT_MEDIA_PREFIXES = ["public/readme/"];

const FRONTEND_PREFIXES = ["public/", "src/"];
// The checked-in Rust protocol is a direct dependency of the shipped Hmux
// clients, desktop adapter, and mobile SSH carrier. The TypeScript projection
// is consumed by the frontend. Generator/tests remain a deterministic leaf:
// their gate rejects drift before any generated product file can change alone.
const TERMINAL_STATE_PROTOCOL_FRONTEND_PATHS = new Set([
  "src/contracts/terminalStateProtocol.ts",
]);
const TERMINAL_STATE_PROTOCOL_FRONTEND_PREFIXES = [
  "src/contracts/generated/terminalState/",
  "src/lib/terminal/state/",
];
const TERMINAL_STATE_PROTOCOL_RUST_PATHS = new Set([
  "hmux/crates/terminal-state-protocol/Cargo.toml",
]);
const TERMINAL_STATE_PROTOCOL_RUST_PREFIXES = [
  "hmux/crates/terminal-state-protocol/schema/",
  "hmux/crates/terminal-state-protocol/src/",
];
const TERMINAL_STATE_PROTOCOL_TOOLING_PREFIXES = [
  "hmux/crates/terminal-state-protocol/",
  "hmux/xtask/terminal-state-protocol-codegen/",
];

const TOOLING_PREFIXES = ["tools/media-capture/"];
const TOOLING_PATHS = new Set(["scripts/media-capture-contract.test.mjs"]);
const TOOLING_FRONTEND_CONSUMER_PATHS = new Set([
  "src/lib/qa/qaHarnessGlobals.ts",
  "src/qa.ts",
]);
const QA_TOOLING_PREFIXES = ["scripts/qa/", "src/qa/"];
const QA_TOOLING_PATHS = new Set([
  "src/lib/qa/qaHarnessGlobals.ts",
  "src/qa.ts",
]);
const CLI_SCRIPT_PATHS = new Set(["cli/dure.mjs"]);
const CLI_SCRIPT_PREFIXES = ["cli/lib/"];
const SCRIPT_TEST_PREFIX = "scripts/";
const SCRIPT_NATIVE_PREFIX = "scripts/native/";
const SCRIPT_TEST_SUFFIX = ".test.mjs";
const SCRIPT_MODULE_SUFFIXES = [".mjs", ".js"];
// The deploy executor consumes this manifest as source for its staged script
// closure. Its behavioral and content-address contracts live in script tests.
const SCRIPT_TEST_RESOURCE_PATHS = new Set([
  "scripts/dev-deploy-executor-files.json",
]);
const FRONTEND_ARCHITECTURE_PATHS = new Set([
  "scripts/architecture-fitness-baseline.json",
]);
// This generated surface is produced and conformance-checked by dure-app,
// imported by the frontend, and compiled through the src-tauri dure-app
// dependency. Keep unknown generated contracts fail-closed below instead of
// granting the whole directory this bounded consumer set.
const DURE_APP_GENERATED_CONTRACT_PATHS = new Set([
  "src/contracts/generated/extensionContracts.ts",
]);
// The control-plane capability manifest: read by the CLI promotion/contract
// modules (script-tests) and compiled into the Rust control plane (app-core,
// desktop, frontend). hmux never reads it.
const CONTROL_PLANE_BUILD_IDENTITY_PATH =
  "cli/lib/control-plane-build-identity.json";
const RUNTIME_FREE_SCOPES = new Set([
  "design-coverage",
  "frontend",
  "mobile-web",
  "qa-tooling",
  "script-tests",
  "tooling",
]);
const ROOT_NODE_DEPENDENCY_SCOPES = new Set([
  "design-coverage",
  "desktop",
  "frontend",
  "qa-tooling",
  "script-tests",
  "terminal-state-protocol",
  "tooling",
]);

// Design checks consume source inventory, optional mockups and token contracts.
// Unknown design/ inputs stay fail-closed; DESIGN.md remains a checked token input.
const DESIGN_COVERAGE_PREFIXES = [
  "design/engine/",
  "design/glass-mockups/",
  "design/mockups/",
];
const DESIGN_COVERAGE_PATHS = new Set([
  "DESIGN.md",
  "design/CLAUDE.mobile.md",
  "design/GLASS.md",
  "design/SOUL.md",
  "design/SOUL.web.md",
  "design/WRITING.md",
  "design/design-coverage-baseline.json",
  "design/inventory.overrides.yaml",
  "design/raw-color-allowlist.json",
]);
// Declared scan roots / token sources: pushes that move the denominator run
// the design checks alongside their product gate. Adding a scan
// root or token source must extend this list in the same change.
// src/lib/theme/oklch.ts is here because the engine's colour contract asserts
// numeric parity against it; a push that changes it must run the gate that
// would break. push-gate-scope.test.mjs derives the engine's src import
// closure and fails when a new one is missing from this list.
const DESIGN_DENOMINATOR_PREFIXES = ["src/components/"];
const DESIGN_DENOMINATOR_PATHS = new Set([
  "src/index.css",
  "src/lib/theme/oklch.ts",
  "src/lib/theme/themeStyle.ts",
]);

const SHARED_OR_GATE_PREFIXES = [
  ".cargo/",
  ".github/",
  ".githooks/",
  "src/contracts/generated/",
];

// These modules decide what evidence is sufficient. They must prove a full
// gate after changing their own authority, even though ordinary tested Node
// tooling below uses the runtime-free script-tests scope.
const VERIFICATION_AUTHORITY_PATHS = new Set([
  "scripts/ci-verification-receipt.mjs",
  "scripts/lib/ci-verification-receipt.mjs",
  "scripts/lib/hmux-artifact-impact.mjs",
  "scripts/lib/hmux-background-smoke-scope.mjs",
  "scripts/lib/package-manifest-script-impact.mjs",
  "scripts/lib/push-gate-contract.mjs",
  "scripts/lib/push-gate-scope.mjs",
  "scripts/lib/script-test-graph-paths.mjs",
  "scripts/lib/script-test-projects.mjs",
  "scripts/node-dependency-preflight.mjs",
  "scripts/public-ci.mjs",
  "scripts/run-changed-script-tests.mjs",
  "scripts/run-push-gates.mjs",
]);

const ROOT_DOCUMENTS = new Set([
  "CLAUDE.md",
  "README.ko.md",
  "README.md",
  "README.zh.md",
]);

// A repository-root markdown file is documentation. Markdown that product code
// compiles in (cli/skills/**, plugins/**) lives in a subdirectory and stays
// fail-closed below, and DESIGN.md is classified as a coverage input before
// this rule is reached. Without it, adding a stray root note selected every
// gate, which made the cheapest possible change the most expensive to land.
const ROOT_DOCUMENT_EXTENSION = /^[^/]+\.(?:md|mdx|txt)$/;

const ROOT_SHARED_INPUTS = new Set([
  "biome.json",
  "components.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
]);

const HMUX_MOBILE_COMPAT_PREFIXES = [
  "hmux/crates/hmux-client/",
  "hmux/crates/hmux-host/",
  "hmux/crates/hmux-runtime-contract/",
  "hmux/crates/hmux-ssh-transport/",
];

const HMUX_DESKTOP_CONSUMER_PREFIXES = [
  "hmux/crates/hmux-client/",
  "hmux/crates/hmux-host/",
  "hmux/crates/hmux-runtime-contract/",
  "hmux/crates/hmux-ssh-transport/",
];

const HMUX_LOCAL_RUNTIME_ONLY_PATHS = new Set([
  "hmux/crates/hmux-client/src/legacy_terminate.rs",
  "hmux/crates/hmux-client/src/managed_attach.rs",
  "hmux/crates/hmux-client/src/managed_authorization.rs",
  "hmux/crates/hmux-client/src/managed_create.rs",
  "hmux/crates/hmux-client/src/managed_stop.rs",
  "hmux/crates/hmux-client/src/runtime_broker.rs",
  "hmux/crates/hmux-client/src/standalone_create.rs",
  "hmux/crates/hmux-client/src/state_gc.rs",
  "hmux/crates/hmux-host/src/session_host.rs",
]);

const HMUX_LOCAL_RUNTIME_ONLY_PREFIXES = [
  "hmux/crates/hmux-client/src/legacy_terminate/",
  "hmux/crates/hmux-client/src/transport/unix_socket.rs",
  "hmux/crates/hmux-host/src/terminal_replay/",
];

function isHmuxLocalRuntimeOnlyPath(path) {
  return (
    HMUX_LOCAL_RUNTIME_ONLY_PATHS.has(path) ||
    HMUX_LOCAL_RUNTIME_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function canonicalScopeSet(scopes) {
  const selected = new Set(scopes);
  return PUSH_GATE_SCOPES.filter((scope) => selected.has(scope));
}

function fullScopeSet() {
  return [...FULL_SCOPE_SET];
}

function isEmptyScopePath(path) {
  if (
    path.startsWith(MARKETING_LAB_PREFIX) &&
    MARKETING_LAB_DOCUMENT_EXTENSION.test(path)
  ) {
    return true;
  }
  if (PUBLIC_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (NON_PRODUCT_MEDIA_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (path === ".beads") return true;
  if (path.startsWith(".beads/")) return true;
  if (path === "AGENTS.md" || path.endsWith("/AGENTS.md")) return true;
  if (ROOT_DOCUMENTS.has(path)) return true;
  if (
    DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    DOCUMENT_EXTENSION.test(path)
  ) {
    return true;
  }
  return (
    path === "hmux/LICENSE" ||
    path === "hmux/README.md" ||
    path === "hmux/SOURCE_PROVENANCE.md" ||
    path === "cli/README.md" ||
    path === "mobile/README.md"
  );
}

function scopesForKnownPath(path) {
  if (isEmptyScopePath(path)) return [];
  if (path.startsWith(MARKETING_LAB_PREFIX)) return null;
  if (DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;

  if (VERIFICATION_AUTHORITY_PATHS.has(path)) return fullScopeSet();

  if (
    TERMINAL_STATE_PROTOCOL_RUST_PATHS.has(path) ||
    TERMINAL_STATE_PROTOCOL_RUST_PREFIXES.some((prefix) =>
      path.startsWith(prefix),
    )
  ) {
    return [
      "terminal-state-protocol",
      "hmux-core",
      "hmux-mobile-compat",
      "desktop",
      "mobile-rust",
    ];
  }
  if (
    TERMINAL_STATE_PROTOCOL_FRONTEND_PATHS.has(path) ||
    TERMINAL_STATE_PROTOCOL_FRONTEND_PREFIXES.some((prefix) =>
      path.startsWith(prefix),
    )
  ) {
    return ["terminal-state-protocol", "frontend"];
  }
  if (
    TERMINAL_STATE_PROTOCOL_TOOLING_PREFIXES.some((prefix) =>
      path.startsWith(prefix),
    )
  ) {
    return ["terminal-state-protocol"];
  }

  if (
    DESIGN_COVERAGE_PATHS.has(path) ||
    DESIGN_COVERAGE_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return ["design-coverage"];
  }
  // Any other design/ path is an unknown input to the coverage judgment.
  if (path.startsWith("design/")) return null;

  if (TOOLING_PATHS.has(path)) return ["tooling"];
  if (TOOLING_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return ["tooling"];
  }
  if (TOOLING_FRONTEND_CONSUMER_PATHS.has(path)) {
    return ["qa-tooling", "tooling"];
  }
  if (
    path.startsWith(SCRIPT_TEST_PREFIX) &&
    path.endsWith(SCRIPT_TEST_SUFFIX)
  ) {
    return ["script-tests"];
  }
  if (SCRIPT_TEST_RESOURCE_PATHS.has(path)) return ["script-tests"];
  if (QA_TOOLING_PATHS.has(path)) return ["qa-tooling"];
  if (QA_TOOLING_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return isScriptTestOpaqueResourcePath(path)
      ? ["qa-tooling", "script-tests"]
      : ["qa-tooling"];
  }
  if (
    path.startsWith(SCRIPT_NATIVE_PREFIX) &&
    isScriptTestOpaqueResourcePath(path)
  ) {
    return ["script-tests"];
  }
  if (FRONTEND_ARCHITECTURE_PATHS.has(path)) return ["frontend"];
  if (DURE_APP_GENERATED_CONTRACT_PATHS.has(path)) {
    return ["app-core", "desktop", "frontend"];
  }
  if (path === CONTROL_PLANE_BUILD_IDENTITY_PATH) {
    return ["app-core", "desktop", "frontend", "script-tests"];
  }
  if (
    (CLI_SCRIPT_PATHS.has(path) ||
      CLI_SCRIPT_PREFIXES.some((prefix) => path.startsWith(prefix))) &&
    SCRIPT_MODULE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  ) {
    return ["script-tests"];
  }
  if (
    path.startsWith(SCRIPT_TEST_PREFIX) &&
    SCRIPT_MODULE_SUFFIXES.some((suffix) => path.endsWith(suffix))
  ) {
    return ["script-tests"];
  }

  if (
    ROOT_SHARED_INPUTS.has(path) ||
    SHARED_OR_GATE_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return fullScopeSet();
  }

  if (
    DESIGN_DENOMINATOR_PATHS.has(path) ||
    DESIGN_DENOMINATOR_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    return ["design-coverage", "frontend"];
  }

  if (path === "index.html" || FRONTEND_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return ["frontend"];
  }

  if (path.startsWith("crates/dure-app/")) {
    return ["app-core", "desktop", "frontend"];
  }
  if (path.startsWith("crates/hebbian-bounded-process/")) {
    return [
      "desktop",
      "hmux-core",
          "process",
      "sampler",
    ];
  }
  if (path.startsWith("crates/hebbian-process-sampler/")) {
    return ["desktop", "hmux-core", "sampler"];
  }
  // The phone and the hub both link this, and it is the only definition of the
  // bytes between them — so a change here has to gate both consumers, not just
  // its own tests. It does not reach hmux: the crate deliberately depends on
  // nothing from that workspace.
  if (path.startsWith("crates/dure-hub-protocol/")) {
    return ["desktop", "hub-protocol", "mobile-rust", "relay"];
  }
  // The relay is a separately deployed service and no shipped product code
  // links it. The desktop crate does take it as a *dev*-dependency: the hub's
  // relay dialer is tested against a real relay rather than a stand-in, so a
  // change here can break that suite without touching src-tauri at all.
  if (path.startsWith("crates/dure-relay/")) {
    return ["desktop", "relay"];
  }
  // The feedback intake is a separately deployed service too, and unlike the
  // relay no crate takes it even as a dev-dependency — nothing in this
  // repository links it at all — so its own verification is the entire
  // consumer set. Without this branch it matched nothing and expanded to
  // every scope: fail-closed, but `feedback` was not among them, so the one
  // suite that covers this crate was in no gate's plan.
  if (path.startsWith("crates/dure-feedback-intake/")) {
    return ["feedback"];
  }

  if (path.startsWith("src-tauri/")) return ["desktop"];

  if (path.startsWith("mobile/src-tauri/")) return ["mobile-rust"];
  // The service's Node suite runs with mobile tests. The desktop also sends
  // real signed requests through it in the native paired-device contract.
  if (path.startsWith("mobile/push-service/")) return ["desktop", "mobile-web"];
  if (path.startsWith("mobile/")) return ["mobile-web"];

  if (path.startsWith("hmux/")) {
    const scopes = ["hmux-core"];
    if (isHmuxTestOnlyPath(path)) {
      return scopes;
    }
    if (isHmuxLocalRuntimeOnlyPath(path)) {
      scopes.push("desktop");
    } else if (HMUX_MOBILE_COMPAT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      scopes.push("hmux-mobile-compat", "mobile-rust");
      if (HMUX_DESKTOP_CONSUMER_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        scopes.push("desktop");
      }
    } else if (path === "hmux/Cargo.toml" || path === "hmux/Cargo.lock") {
      // The mobile negative build shares the Hmux workspace dependency graph.
      scopes.push("desktop", "hmux-mobile-compat", "mobile-rust");
    }
    return scopes;
  }

  if (ROOT_DOCUMENT_EXTENSION.test(path)) return [];

  return null;
}

/**
 * Return a canonical, sorted union of code-gate scopes for changed Git paths.
 *
 * A null/invalid/unknown path is a classifier failure and therefore expands
 * to every scope. An empty path list is a valid empty diff and returns [].
 * Root manifest narrowing additionally requires a trusted before/after pair;
 * path-only callers retain the same fail-closed result as before.
 */
export function classifyChangedPaths(paths, evidence = {}) {
  if (!Array.isArray(paths)) return fullScopeSet();

  const scopes = new Set();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      return fullScopeSet();
    }

    if (path === "package.json") {
      let packageManifest;
      try {
        packageManifest = evidence?.packageManifest;
      } catch {
        return fullScopeSet();
      }
      const commandPaths = packageManifestScriptImpactPaths(packageManifest);
      if (commandPaths === null) return fullScopeSet();
      for (const commandPath of commandPaths) {
        const commandScopes = scopesForKnownPath(commandPath);
        if (commandScopes === null || commandScopes.length === 0) {
          return fullScopeSet();
        }
        for (const scope of commandScopes) scopes.add(scope);
      }
      continue;
    }

    const pathScopes = scopesForKnownPath(path);
    if (pathScopes === null) return fullScopeSet();
    for (const scope of pathScopes) scopes.add(scope);
  }
  return canonicalScopeSet(scopes);
}

/**
 * Whether a verified scope union needs Rust/Cargo runner setup.
 *
 * Invalid scope input fails closed. Hmux behavior smoke is a separate
 * capability and may independently require the heavy runtime.
 */
export function verificationScopesRequireHeavyRuntime(scopes) {
  if (!Array.isArray(scopes)) return true;
  return scopes.some(
    (scope) =>
      typeof scope !== "string" ||
      !PUSH_GATE_SCOPES.includes(scope) ||
      !RUNTIME_FREE_SCOPES.has(scope),
  );
}

/** Whether a scope union executes tools from the root node_modules install. */
export function verificationScopesRequireRootNodeDependencies(scopes) {
  if (!Array.isArray(scopes)) return true;
  return scopes.some(
    (scope) =>
      typeof scope !== "string" ||
      !PUSH_GATE_SCOPES.includes(scope) ||
      ROOT_NODE_DEPENDENCY_SCOPES.has(scope),
  );
}

/**
 * Arguments callers must use to obtain unquoted, NUL-delimited path bytes.
 *
 * --no-renames deliberately represents a rename as its deleted and added
 * endpoints, so scope classification sees both affected consumers.
 */
export function gitDiffNameOnlyArgs(base, head) {
  if (typeof base !== "string" || base.length === 0 || base.includes("\0")) {
    throw new TypeError("base revision must be a non-empty string");
  }
  if (typeof head !== "string" || head.length === 0 || head.includes("\0")) {
    throw new TypeError("head revision must be a non-empty string");
  }
  return ["diff", "--no-renames", "--name-only", "-z", `${base}..${head}`, "--"];
}

/**
 * Parse `git diff --name-only -z` output without interpreting newlines,
 * quotes, backslashes, or other legal filename characters as separators.
 */
export function parseNullDelimitedGitPaths(output) {
  if (!(typeof output === "string" || output instanceof Uint8Array)) {
    throw new TypeError("git diff output must be a string or byte array");
  }

  const bytes =
    typeof output === "string" ? new TextEncoder().encode(output) : new Uint8Array(output);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error("git diff -z output is not NUL-terminated");

  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
  const paths = decoded.split("\0");
  if (paths.some((path) => path.length === 0)) {
    throw new Error("git diff -z output contains an empty path");
  }
  return paths;
}

/**
 * Classify raw `git diff -z` output. Malformed bytes fail closed.
 */
export function classifyNullDelimitedGitDiff(output) {
  try {
    return classifyChangedPaths(parseNullDelimitedGitPaths(output));
  } catch {
    return fullScopeSet();
  }
}
