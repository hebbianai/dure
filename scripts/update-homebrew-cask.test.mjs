import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import YAML from "yaml";
import { caskInputFromRelease, renderCask, updateCask } from "./update-homebrew-cask.mjs";

const sha256 = "a".repeat(64);
const release = (overrides = {}) => ({
  draft: false,
  prerelease: true,
  tag_name: "v0.2.61",
  assets: [
    { name: "Dure.app.tar.gz", digest: `sha256:${"b".repeat(64)}` },
    { name: "Dure_0.2.61_aarch64.dmg", digest: `sha256:${sha256}` },
  ],
  ...overrides,
});

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function temporaryCask() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dure-homebrew-cask-"));
  directories.push(directory);
  return path.join(directory, "Casks", "dure.rb");
}

test("renders the cask from the published DMG digest, including prereleases", () => {
  const cask = renderCask(caskInputFromRelease(release()));

  expect(cask).toContain('cask "dure" do');
  expect(cask).toContain('version "0.2.61"');
  expect(cask).toContain(`sha256 "${sha256}"`);
  expect(cask).toContain(
    'url "https://github.com/hebbianai/dure/releases/download/v#{version}/Dure_#{version}_aarch64.dmg"',
  );
  expect(cask).toContain("depends_on arch: :arm64");
  expect(cask).toContain("depends_on :macos");
  expect(cask).toContain('app "Dure.app"');
});

test.each([
  ["a draft", { draft: true }, "homebrew_cask_release_not_published"],
  ["an invalid tag", { tag_name: "v0.2" }, "release_tag_invalid"],
  ["a missing DMG", { assets: [] }, "homebrew_cask_dmg_missing"],
  ["a missing digest", { assets: [{ name: "Dure_0.2.61_aarch64.dmg", digest: null }] }, "homebrew_cask_digest_missing"],
  ["a non-SHA-256 digest", { assets: [{ name: "Dure_0.2.61_aarch64.dmg", digest: "md5:abc" }] }, "homebrew_cask_digest_missing"],
])("refuses %s", (_label, overrides, code) => {
  expect(() => caskInputFromRelease(release(overrides))).toThrow(code);
});

test("creates the cask, advances it, and never lowers it", () => {
  const cask = temporaryCask();
  expect(updateCask(release(), cask)).toEqual({ written: true, version: "0.2.61" });
  const first = fs.readFileSync(cask, "utf8");

  const older = release({
    tag_name: "v0.2.30",
    assets: [{ name: "Dure_0.2.30_aarch64.dmg", digest: `sha256:${"c".repeat(64)}` }],
  });
  expect(updateCask(older, cask)).toEqual({ written: false, version: "0.2.61" });
  expect(fs.readFileSync(cask, "utf8")).toBe(first);

  const newer = release({
    tag_name: "v0.2.62",
    assets: [{ name: "Dure_0.2.62_aarch64.dmg", digest: `sha256:${"d".repeat(64)}` }],
  });
  expect(updateCask(newer, cask)).toEqual({ written: true, version: "0.2.62" });
  expect(fs.readFileSync(cask, "utf8")).toContain('version "0.2.62"');
});

test("refuses to overwrite a cask whose version cannot be read", () => {
  const cask = temporaryCask();
  fs.mkdirSync(path.dirname(cask));
  fs.writeFileSync(cask, "not a cask\n");

  expect(() => updateCask(release(), cask)).toThrow("homebrew_cask_existing_version_unreadable");
  expect(fs.readFileSync(cask, "utf8")).toBe("not a cask\n");
});

test("the command writes the cask and reports a bad release", () => {
  const cask = temporaryCask();
  const releaseFile = path.join(path.dirname(path.dirname(cask)), "release.json");
  fs.writeFileSync(releaseFile, JSON.stringify(release()));
  const run = () =>
    spawnSync(process.execPath, ["scripts/update-homebrew-cask.mjs", releaseFile, cask], {
      encoding: "utf8",
    });

  const written = run();
  expect(written.status, written.stderr).toBe(0);
  expect(written.stdout).toContain("Cask set to 0.2.61");

  fs.writeFileSync(releaseFile, JSON.stringify(release({ draft: true })));
  const refused = run();
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("homebrew_cask_release_not_published");
});

test("the workflow stays off until enabled and exposes the tap deploy key only to its checkout", () => {
  const source = fs.readFileSync(".github/workflows/homebrew-cask.yml", "utf8");
  const workflow = YAML.parse(source);

  expect(workflow.on.release.types).toEqual(["published"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.update.if).toContain("vars.HOMEBREW_TAP_ENABLED == 'true'");
  expect(source.match(/secrets\.HOMEBREW_TAP_DEPLOY_KEY/g)).toHaveLength(1);
  expect(source).not.toMatch(/secrets\.HOMEBREW_TAP_TOKEN/);

  const steps = workflow.jobs.update.steps;
  const tap = steps.find((step) => step.with?.repository === "hebbianai/homebrew-tap");
  expect(tap.with["ssh-key"]).toBe("${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}");
  expect(tap.with.token).toBeUndefined();
  expect(steps[0].with["persist-credentials"]).toBe(false);
  for (const step of steps.filter((candidate) => candidate.uses)) {
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  }
  expect(steps.at(-1).run).toContain("git push origin HEAD:main");
});
