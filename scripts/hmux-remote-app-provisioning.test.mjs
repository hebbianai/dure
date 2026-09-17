import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("Dure remote Hmux provisioning bundle", () => {
  test("provisions the pinned Rust targets required by local dev staging", () => {
    const toolchain = read("rust-toolchain.toml");
    expect(toolchain).toContain('"x86_64-unknown-linux-musl"');
    expect(toolchain).toContain('"aarch64-unknown-linux-musl"');
  });

  test("keeps Linux staging explicit and outside local dev startup", () => {
    const stage = read("scripts/stage-hmux-remote-resources.sh");
    const checkoutHelperStage = read(
      "scripts/build-remote-git-checkout-helper.sh",
    );
    expect(stage).toContain(
      "for hmux_remote_triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl",
    );
    expect(stage).toContain("scripts/package-hmux-prebuilt.sh");
    expect(stage).toContain("RUSTUP_TOOLCHAIN=1.97.1");
    expect(checkoutHelperStage).toContain(
      "for checkout_helper_triple in x86_64-unknown-linux-musl aarch64-unknown-linux-musl",
    );
    expect(checkoutHelperStage).toContain("--bin dure-git-checkout-helper");
    expect(checkoutHelperStage).toContain("verify-static-linux-binary.sh");
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["preapp:dev"]).toBeUndefined();
    expect(scripts["app:dev"]).toBe(
      "node scripts/run-dev-app.mjs",
    );
    const appRunner = read("scripts/run-dev-app.mjs");
    const launchPrerequisites = read(
      "scripts/lib/dev-launch-prerequisites.mjs",
    );
    expect(appRunner).toContain("devLaunchPrerequisites");
    expect(launchPrerequisites).toContain(
      "scripts/node-dependency-preflight.mjs",
    );
    expect(launchPrerequisites).not.toContain('"remote-tools:stage:dev"');
    expect(scripts["remote-tools:stage:dev"]).toContain(
      "pnpm git-checkout:remote:stage",
    );
    expect(read("package.json")).toContain("hmux:remote:stage:release");
  });

  test("bundles the existing immutable installer and generated trees", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.bundle.resources).toMatchObject({
      "../scripts/install-hmux.sh": "resources/install-hmux.sh",
      "resources/hmux-remote/": "resources/hmux-remote/",
      "resources/remote-git-checkout-helper/":
        "resources/remote-git-checkout-helper/",
    });
    expect(read("src-tauri/src/remote_hmux.rs")).toContain(
      "crate::remote_hmux_install::ensure(app, &account_ssh)?;",
    );
    expect(read("src-tauri/src/remote_git_checkout_helper.rs")).toContain(
      'join("resources/remote-git-checkout-helper")',
    );
    expect(read("src-tauri/src/lib.rs")).toContain(
      "remote_git_checkout_helper::prepare_remote_git_checkout_helper",
    );
  });
});
