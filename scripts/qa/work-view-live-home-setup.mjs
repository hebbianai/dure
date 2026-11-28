import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

// The project a real Claude Code agent works in, and the Claude state that
// lets it start without first-run questions, written into the disposable
// HOME before the app starts.

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const home = realpathSync(required("HOME"));
if (home !== realpathSync(path.join(required("DURE_QA_STATE_ROOT"), "home"))) {
  throw new Error("Work view live QA HOME escaped its isolated root");
}

const project = path.join(home, "release-tools");
mkdirSync(path.join(project, "scripts"), { recursive: true, mode: 0o700 });
writeFileSync(path.join(project, "README.md"), "# Release tools\n\nReleases run `scripts/release.sh`.\n");
writeFileSync(path.join(project, "scripts", "release.sh"),
  "#!/bin/sh\nset -eu\n./scripts/build.sh\ngit tag \"v$1\"\n./scripts/upload.sh \"v$1\"\n");
writeFileSync(path.join(project, "scripts", "upload.sh"), "#!/bin/sh\nset -eu\ncurl -fsS -T dist.tar.gz \"$UPLOAD_URL/$1\"\n");
writeFileSync(path.join(project, "scripts", "build.sh"), "#!/bin/sh\nset -eu\ntar -czf dist.tar.gz src\n");

const apiKey = required("ANTHROPIC_API_KEY");
const claudeState = JSON.stringify({
  hasCompletedOnboarding: true,
  theme: "light",
  autoUpdates: false,
  customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
  projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
});
writeFileSync(path.join(home, ".claude.json"), claudeState, { mode: 0o600 });
mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
writeFileSync(path.join(home, ".claude", ".claude.json"), claudeState, { mode: 0o600 });

// Two turns of several steps each: what the stand-in API answers, step by
// step, and what the probe looks for in the Work detail while they stream.
const read = (file) => ({ name: "Read", input: { file_path: path.join(project, file) } });
writeFileSync(path.join(home, "work-view-live-fixture.json"), JSON.stringify({
  project,
  turns: [
    {
      prompt: "Walk me through how a release runs here.",
      steps: [
        { text: "Starting with the README to find the entry point.", tool: read("README.md") },
        { text: "The README points at scripts/release.sh. Listing the scripts next to it.",
          tool: { name: "Glob", input: { pattern: "scripts/*.sh", path: project } } },
        { text: "Reading the release script itself.", tool: read("scripts/release.sh") },
        { text: "A release builds `dist.tar.gz`, tags `v<version>` and then uploads the archive. The tag is created before the upload, so the order matters if the upload fails." },
      ],
    },
    {
      prompt: "Where would a failed upload leave the release?",
      steps: [
        { text: "Checking what the upload step does on failure.", tool: read("scripts/upload.sh") },
        { text: "Confirming where the tag is written relative to it.", tool: read("scripts/release.sh") },
        { text: "With `set -eu`, a failed `curl` stops the script after `git tag`: the tag exists locally but no archive was uploaded. Rerunning fails on the existing tag, so delete it or move the tag after the upload." },
      ],
    },
  ],
}), { mode: 0o600 });
