//! Real CLI/Host/PTY routing through a retired identity after receipt GC.
#![cfg(unix)]

use hmux_client::recovery_journal::{
    ManagedRehostResolutionLookup, RecoveryJournalGcPolicy, garbage_collect_completed_action,
    resolve_managed_rehost_current,
};
use hmux_client::{
    LocalSessionCatalog, MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    ManagedCreateRequest, ManagedRehostRecipe, ManagedRehostRequest, ManagedSessionCreator,
    ManagedSessionRehoster, ManagedSessionStopper, ManagedStopRequest, PermissionMode,
    ProviderConversationIdentitySeed, SessionDescriptor, SessionLifecycle, SessionSelector,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

const WORKSPACE: &str = "retired-routing-workspace";
const SOURCE: &str = "retired-routing-source";

struct Fixture {
    state: PathBuf,
    runtime: PathBuf,
    discovery: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        assert!(
            std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").is_some(),
            "run the smoke wrapper"
        );
        let state = tempfile::Builder::new()
            .prefix("dure-retired-routing-")
            .tempdir()
            .unwrap()
            .keep();
        let runtime = PathBuf::from(env!("CARGO_BIN_EXE_hmux")).with_file_name("hmux-runtime");
        assert!(runtime.is_file(), "build the paired runtime first");
        std::fs::create_dir(state.join("home")).unwrap();
        let discovery = state.join("discovery");
        Self {
            state,
            runtime,
            discovery,
        }
    }

    fn cli(&self, arguments: &[&str]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hmux"))
            .args(["--json", "--discovery-root"])
            .arg(&self.discovery)
            .args(arguments)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.state.join("home"))
            .env("HMUX_DISCOVERY_ROOT", &self.discovery)
            .env("HMUX_RUNTIME", &self.runtime)
            .current_dir(&self.state)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if child.try_wait().unwrap().is_some() {
                return child.wait_with_output().unwrap();
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "owned CLI command timed out: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn query(&self, arguments: &[&str]) -> Value {
        let output = self.cli(arguments);
        assert!(
            output.status.success(),
            "CLI failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn descriptor(&self, session: &str) -> SessionDescriptor {
        LocalSessionCatalog::new(&self.discovery)
            .open(&SessionSelector::new(session, Some(WORKSPACE.into())))
            .unwrap()
            .descriptor()
            .clone()
    }

    fn rehost(&self, source: &SessionDescriptor, operation: &str) -> SessionDescriptor {
        let request = ManagedRehostRequest::new(
            operation,
            &source.session_id,
            WORKSPACE,
            &source.runner_principal,
            &source.runner_instance,
            source.channel_epoch.parse().unwrap(),
            &source.host_instance_id,
            &source.terminal_epoch,
            true,
        )
        .unwrap()
        .with_expected_provider_id("fixture")
        .unwrap()
        .with_expected_conversation_id("qa-conversation")
        .unwrap();
        let receipt = ManagedSessionRehoster::new(&self.runtime, &self.state)
            .with_discovery_root(&self.discovery)
            .rehost(request)
            .unwrap();
        self.descriptor(receipt.replacement_receipt().session_id())
    }

    fn read_until(&self, marker: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let result = self.query(&["read", SOURCE, "--workspace", WORKSPACE]);
            if result["lines"]
                .as_array()
                .unwrap()
                .iter()
                .any(|line| line.as_str().unwrap().contains(marker))
            {
                return result;
            }
            assert!(
                Instant::now() < deadline,
                "retired-source read did not observe {marker}: {result}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn stop_request(descriptor: &SessionDescriptor) -> ManagedStopRequest {
    ManagedStopRequest::new(
        format!("cleanup-{}", descriptor.session_id),
        &descriptor.session_id,
        WORKSPACE,
    )
    .unwrap()
    .with_expected_fence(
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse().unwrap(),
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    )
    .unwrap()
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let stopper = ManagedSessionStopper::new(&self.runtime, &self.state)
            .with_discovery_root(&self.discovery);
        if let Ok(sessions) = LocalSessionCatalog::new(&self.discovery).list() {
            for descriptor in sessions
                .iter()
                .filter(|s| s.lifecycle == SessionLifecycle::Ready)
            {
                let _ = stopper.stop(stop_request(descriptor));
            }
        }
        // The outer Hmux guardian observes and reaps the exact owned processes
        // before it retires this disposable root, including failure paths.
    }
}

fn fence(descriptor: &SessionDescriptor) -> String {
    json!({
        "workspace_id": descriptor.workspace_id,
        "session_id": descriptor.session_id,
        "runner_principal": descriptor.runner_principal,
        "runner_instance": descriptor.runner_instance,
        "channel_epoch": descriptor.channel_epoch,
        "host_instance_id": descriptor.host_instance_id,
        "terminal_epoch": descriptor.terminal_epoch,
    })
    .to_string()
}

fn assert_generation(actual: &Value, expected: &SessionDescriptor) {
    assert_eq!(
        actual,
        &json!({
            "sessionId": expected.session_id,
            "workspaceId": expected.workspace_id,
            "runnerPrincipal": expected.runner_principal,
            "runnerInstance": expected.runner_instance,
            "channelEpoch": expected.channel_epoch,
            "hostInstanceId": expected.host_instance_id,
            "terminalEpoch": expected.terminal_epoch,
        })
    );
}

fn collect_receipts(discovery: &Path) -> usize {
    garbage_collect_completed_action(
        discovery,
        MANAGED_REHOST_RECOVERY_ACTION,
        RecoveryJournalGcPolicy {
            minimum_completed_age: Duration::ZERO,
            maximum_completed_records: 0,
            maximum_completed_bytes: 0,
            ..RecoveryJournalGcPolicy::default()
        },
    )
    .unwrap()
    .removed_completed_records
}

#[test]
#[ignore = "native process fixture; run pnpm test:hmux-retired-routing"]
fn retired_source_routes_read_input_and_current_fenced_stop_after_gc() {
    for repetition in 0..3 {
        let fixture = Fixture::new();
        let request = ManagedCreateRequest::new(
            "routing-create", SOURCE, WORKSPACE, "fixture", PermissionMode::Default,
            &fixture.state, vec!["/bin/sh".into(), "-c".into(), "sleep 60".into()], 24, 80,
        ).unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION).unwrap()
        .with_conversation_identity(ProviderConversationIdentitySeed::new("fixture", "qa-conversation").unwrap()).unwrap()
        .with_managed_rehost_recipe(ManagedRehostRecipe::new(vec![
            "/bin/sh".into(), "-c".into(),
            "printf 'ROUTING_READY\\r\\n'; while IFS= read -r line; do printf 'ROUTING_RESULT:%s\\r\\n' \"$line\"; done".into(),
            "--".into(), MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
        ], None).unwrap()).unwrap();
        let created = ManagedSessionCreator::new(&fixture.runtime)
            .with_discovery_root(&fixture.discovery)
            .create(request)
            .unwrap();
        let source = created.session().descriptor().clone();
        let middle = fixture.rehost(&source, "routing-hop-1");
        let current = fixture.rehost(&middle, "routing-hop-2");
        assert_ne!(source.session_id, current.session_id);
        assert_ne!(middle.session_id, current.session_id);

        let barrier = Arc::new(Barrier::new(2));
        let reader_barrier = Arc::clone(&barrier);
        let discovery = fixture.discovery.clone();
        let expected_current = current.clone();
        let reader = std::thread::spawn(move || {
            reader_barrier.wait();
            for _ in 0..32 {
                let ManagedRehostResolutionLookup::Resolved(resolution) =
                    resolve_managed_rehost_current(&discovery, WORKSPACE, SOURCE).unwrap()
                else {
                    panic!("concurrent GC lost the completed chain")
                };
                assert_generation(
                    &serde_json::to_value(resolution.current_generation()).unwrap(),
                    &expected_current,
                );
                assert_eq!(resolution.operation_ids().len(), 2);
            }
        });
        barrier.wait();
        assert_eq!(collect_receipts(&fixture.discovery), 2);
        reader.join().unwrap();
        assert_eq!(collect_receipts(&fixture.discovery), 0);
        fixture.read_until("ROUTING_READY");

        // Absence of the retained index recreates the addressability failure
        // after the journal is gone. Restore the exact bytes before proceeding;
        // this is a fixture fault, not a claim to have run a historical binary.
        let index = fixture.discovery.join(".managed-rehost-successors-v1");
        let preserved_index = fixture.state.join("preserved-successor-index");
        std::fs::rename(&index, &preserved_index).unwrap();
        let missing_index = fixture.cli(&["read", SOURCE, "--workspace", WORKSPACE]);
        std::fs::rename(&preserved_index, &index).unwrap();
        assert!(
            !missing_index.status.success(),
            "a retired source needs its retained successor authority"
        );
        fixture.read_until("ROUTING_READY");

        let resolved = fixture.query(&[
            "managed-rehost-resolve",
            "--session",
            SOURCE,
            "--workspace",
            WORKSPACE,
        ]);
        assert_generation(&resolved["currentGeneration"], &current);
        assert_generation(&resolved["sourceGeneration"], &source);
        assert_eq!(resolved["operationIds"].as_array().unwrap().len(), 2);

        let stale = fence(&source);
        let current_fence = fence(&current);
        let stale_stop = fixture.cli(&[
            "kill",
            SOURCE,
            "--workspace",
            WORKSPACE,
            "--expected-fence-json",
            &stale,
        ]);
        assert!(!stale_stop.status.success());
        assert!(
            String::from_utf8_lossy(&stale_stop.stderr)
                .contains("hmux_expected_generation_mismatch")
        );
        // The middle fence models a client that observed a current target
        // before the second rehost won. That stale observation cannot write.
        let middle_fence = fence(&middle);
        let stale_input = fixture.cli(&[
            "send-keys",
            "-t",
            SOURCE,
            "--workspace",
            WORKSPACE,
            "--expected-fence-json",
            &middle_fence,
            "must-not-arrive",
            "Enter",
        ]);
        assert!(!stale_input.status.success());
        assert!(
            String::from_utf8_lossy(&stale_input.stderr)
                .contains("expected fence names neither the current generation nor its exact durable rehost source"),
            "stale input stdout={} stderr={}",
            String::from_utf8_lossy(&stale_input.stdout),
            String::from_utf8_lossy(&stale_input.stderr)
        );
        let still_ready = fixture.read_until("ROUTING_READY");
        assert!(!still_ready.to_string().contains("must-not-arrive"));
        let sent = fixture.query(&[
            "send-keys",
            "-t",
            SOURCE,
            "--workspace",
            WORKSPACE,
            "--expected-fence-json",
            &current_fence,
            "qa-routing-input",
            "Enter",
        ]);
        assert_eq!(sent["sessionId"], current.session_id);
        let read = fixture.read_until("ROUTING_RESULT:qa-routing-input");
        let occurrences = read["lines"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|line| {
                line.as_str()
                    .unwrap()
                    .contains("ROUTING_RESULT:qa-routing-input")
            })
            .count();
        assert_eq!(occurrences, 1, "one CLI input must be delivered once");
        let stopped = fixture.query(&[
            "kill",
            SOURCE,
            "--workspace",
            WORKSPACE,
            "--expected-fence-json",
            &current_fence,
        ]);
        assert_eq!(stopped["ok"], true);
        assert_eq!(
            fixture.descriptor(&current.session_id).lifecycle,
            SessionLifecycle::Exited
        );
        assert!(!fixture.state.join("home/.dure/server.json").exists());
        println!(
            "retired-routing repetition={repetition} hops=2 gc=2 observations=32 input_occurrences=1 stale_stop=refused current_stop=exited"
        );
    }
}
