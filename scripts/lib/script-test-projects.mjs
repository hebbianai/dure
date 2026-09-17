export const DEADLINE_SENSITIVE_PROCESS_TEST_PATHS = Object.freeze([
  "scripts/dure-cli-hmux.test.mjs",
  "scripts/dure-cli-ls.test.mjs",
  "scripts/dure-cli-orchestration-status.test.mjs",
  "scripts/dure-cli-read-latency.test.mjs",
  "scripts/dure-cli-wait.test.mjs",
  "scripts/lib/dev-hmux-tool.test.mjs",
  "scripts/lib/process-identity-relations.test.mjs",
  "scripts/qa/hmux-remote-soak.test.mjs",
  "scripts/qa/lib/bounded-owned-process-group.test.mjs",
  "scripts/qa/lib/owned-process-group.test.mjs",
  "scripts/qa/spawn-prompt-ssh-receipt-loss-smoke.test.mjs",
  "scripts/run-hmux-tests.preparation.test.mjs",
  "scripts/run-hmux-tests.test.mjs",
]);

export const PROCESS_FIXTURE_TEST_PATHS = Object.freeze([
  "scripts/dure-cli-diagnostics.test.mjs",
  "scripts/dure-cli-install.test.mjs",
  "scripts/dure-cli-mutation-lock.test.mjs",
  "scripts/lib/dev-launch-supervisor.test.mjs",
  "scripts/lib/dev-launch-supervisor.retirement-failure.test.mjs",
  "scripts/lib/process-group-witness.test.mjs",
  "scripts/provision-hmux-remote.test.mjs",
  "scripts/queue-dev-app-deploy.test.mjs",
  "scripts/qa/lib/tauri-app-launch.test.mjs",
  "scripts/qa/lib/tauri-app-runner.test.mjs",
  "scripts/qa/pane-app-restart-app.test.mjs",
  "scripts/run-dev-app.frontend-authority.test.mjs",
  "scripts/run-dev-app.test.mjs",
  "scripts/run-dev-frontend.test.mjs",
  "scripts/run-dev-launch-child.test.mjs",
]);

export const NODE_TEST_PATHS = Object.freeze([
  "scripts/qa/managed-gemini-hooks.test.mjs",
  "scripts/qa/managed-qwen-hooks.test.mjs",
  "scripts/qa/mobile-live.test.mjs",
  "scripts/qa/workspace-native-focus-client.test.mjs",
]);

export const SCRIPT_TEST_PROJECTS = Object.freeze([
  Object.freeze({
    name: "scripts-node",
    runner: "node",
    paths: NODE_TEST_PATHS,
    separateInvocations: true,
  }),
  Object.freeze({ name: "scripts", paths: null }),
  Object.freeze({
    name: "scripts-deadline",
    paths: DEADLINE_SENSITIVE_PROCESS_TEST_PATHS,
    separateInvocations: true,
  }),
  Object.freeze({
    name: "scripts-process",
    paths: PROCESS_FIXTURE_TEST_PATHS,
    separateInvocations: true,
  }),
]);

export function scriptTestProjectForPath(path) {
  return (
    SCRIPT_TEST_PROJECTS.find((project) => project.paths?.includes(path))?.name ??
    "scripts"
  );
}
