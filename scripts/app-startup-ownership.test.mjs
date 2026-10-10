import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path) => readFileSync(new URL(`../src-tauri/src/${path}`, import.meta.url), "utf8");

describe("native startup ownership wiring", () => {
  it("claims ownership before migration, app services or Tauri window construction", () => {
    const run = source("lib.rs").split("pub fn run() {")[1];
    const claim = run.indexOf("app_instance::claim_startup");
    expect(claim).toBeGreaterThanOrEqual(0);
    for (const boundary of [
      "migrate_legacy_app_identity_data()",
      "DurePluginState::from_app_root",
      "DureBackendCoordinator::new()",
      "tauri::Builder::default()",
    ]) {
      expect(run.indexOf(boundary)).toBeGreaterThan(claim);
    }
    expect(run.slice(claim, run.indexOf("tauri::Builder::default()"))).toContain("return;");
  });

  it("requires the startup capability at CLI, backend and descriptor publication boundaries", () => {
    const server = source("server.rs");
    const startup = server.slice(server.indexOf("pub fn start("), server.indexOf("    let token ="));
    expect(startup).toContain("instance: &'static crate::app_instance::AppInstance");
    expect(startup).toContain("instance.channel()");
    expect(server).toContain("app_instance_lock_version: crate::app_instance::LOCK_VERSION");
    const coordinator = source("dure_backend_coordinator.rs");
    expect(coordinator).toContain("prepare_startup_channel(channel, &resource_dir)");
    expect(coordinator).toContain("instance: &'static crate::app_instance::AppInstance");
    expect(coordinator).toContain("let channel = &instance.channel().name;");
    expect(source("dure_cli_install.rs")).toContain("crate::app_instance::current()?");
    const coordinatorStartup = coordinator.slice(coordinator.indexOf("async fn prepare_and_publish_startup"));
    expect(coordinatorStartup.indexOf("on_ready();")).toBeLessThan(coordinatorStartup.indexOf("handle.publish(Phase::Ready(startup.managed_authority, 0))"));
    const run = source("lib.rs").split("pub fn run() {")[1];
    expect(run).toContain("current_for_bundle(&context.config().identifier)");
    expect(run).toContain(".start(app.path().resource_dir()?, app_instance, move ||");
    expect(run).toContain("server::start(app_handle, cli_request_broker, app_instance)");
  });
});
