use super::*;
use crate::hmux::product_catalog::product_catalog;
use dure_app::{
    GitCheckoutRegistrationV1, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalRequestV1,
    OperationIdV1,
};
use dure_git_checkout::{
    capture_git_checkout_registration, read_git_checkout_claims, GitCheckoutRemovalOperation,
};
use hmux_client::{probe_local_session_exact, SessionProbeStatus, SessionSelector};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

mod upgrade;
mod removal;
mod managed;
mod aliases;
mod finalization;

struct Fixture {
    app: tauri::App<tauri::test::MockRuntime>,
    manager: HmuxManager,
    checkout: PathBuf,
    marker: PathBuf,
    registration: GitCheckoutRegistrationV1,
}

impl Fixture {
    fn new() -> Self {
        let guardian = environment_path("DURE_HMUX_TEST_STATE_ROOT");
        let home = environment_path("HOME");
        let app_home = environment_path("DURE_HOME");
        assert!(home.starts_with(&guardian) && home != guardian);
        assert!(app_home.starts_with(&home) && app_home != home);
        assert_eq!(
            environment_path("HMUX_DISCOVERY_ROOT"),
            home.join("hmux-discovery")
        );
        assert_eq!(std::env::var("SHELL").unwrap(), "/bin/sh");

        // Preserve fixture state until the outer guardian retires its processes.
        let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
        assert!(root.starts_with(&guardian));
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(&root, &["worktree", "add", "-q", "-b", "shell", "checkout"]);
        let checkout = root.join("checkout").canonicalize().unwrap();
        let registration = capture_git_checkout_registration(&checkout)
            .unwrap()
            .unwrap();
        let app = tauri::test::mock_app();
        let build = crate::hmux::runtime::ensure_current_build(app.handle()).unwrap();
        assert!(build.runtime.starts_with(home.join("hmux-install")));
        Self {
            app,
            manager: HmuxManager::default(),
            checkout,
            marker: root.join("provider-started"),
            registration,
        }
    }

    fn create(&self) -> Result<SessionSummary, String> {
        self.create_with_operation(None)
    }

    fn create_with_operation(
        &self,
        operation_id: Option<OperationIdV1>,
    ) -> Result<SessionSummary, String> {
        self.manager.create_app_standalone(
            self.app.handle(),
            AppStandaloneCreateRequest {
                operation_id,
                cwd: self.checkout.to_str().unwrap().into(),
                rows: 24,
                columns: 80,
                terminal_env: None,
                command_line: Some(format!(
                    "printf started >> {}; exec /bin/sh",
                    crate::ssh::shell_quote(self.marker.to_str().unwrap()),
                )),
                terminal_default_colors: TerminalDefaultColors::default(),
            },
        )
    }

    fn removal(&self, operation: &str) -> GitCheckoutRemovalOperation {
        GitCheckoutRemovalOperation::new(
            &GitCheckoutRemovalRequestV1 {
                repository_path: self.registration.repository_path.clone(),
                instance: self.registration.instance.clone(),
                policy: GitCheckoutRemovalPolicyV1::RequireClean,
            },
            &OperationIdV1::new(operation).unwrap(),
        )
        .unwrap()
    }

    fn close(&self, session: &SessionSummary) {
        self.manager
            .terminate_standalone_session(
                &session.session_id,
                &session.workspace_id,
                Duration::from_secs(3),
            )
            .unwrap();
    }

    fn abandon_and_wait_for_retirement(&self, created: SessionSummary) {
        let catalog = product_catalog().unwrap();
        let descriptor = catalog
            .find(&SessionSelector::new(
                &created.session_id,
                Some(created.workspace_id.clone()),
            ))
            .unwrap();
        let generation =
            hmux_client::ExitedSessionRetirementGeneration::from_descriptor(&descriptor).unwrap();
        let receipt = self
            .manager
            .abandon_unpresented_creation(created.session_id, created.workspace_id)
            .unwrap();
        assert_eq!(receipt.state, "retirement_armed", "receipt: {receipt:?}");
        assert_eq!(read_git_checkout_claims(&self.registration).unwrap().len(), 1);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let lifecycle = catalog.resolve_completed_standalone_target(
                &generation,
                &descriptor.provider_process,
            );
            if lifecycle == hmux_client::CompletedStandaloneTargetLifecycle::Retired {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "target did not retire: {lifecycle:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn environment_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap())
        .canonicalize()
        .unwrap()
}

fn git(root: &Path, arguments: &[&str]) {
    let mut command = Command::new("git");
    crate::gitx::scrub_git_environment(&mut command);
    let output = command
        .current_dir(root)
        .args([
            "-c",
            "user.name=QA",
            "-c",
            "user.email=qa@qa",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(arguments)
        .output()
        .unwrap();
    assert!(output.status.success(), "Git fixture failed: {output:?}");
}

#[test]
#[ignore = "requires isolated native app roots and staged Hmux binaries"]
fn native_app_standalone_retains_its_checkout_until_exact_close() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    let catalog = product_catalog().unwrap();
    let descriptor = catalog
        .find(&SessionSelector::new(
            &created.session_id,
            Some(created.workspace_id.clone()),
        ))
        .unwrap();
    let claims = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    let removal = fixture
        .removal("remove-live-app-shell")
        .admit()
        .and_then(|permit| permit.abort())
        .map_err(|error| error.code);
    let health = probe_local_session_exact(&catalog, &descriptor);

    // Collect the claim/removal and live-provider observations before cleanup.
    fixture.close(&created);
    let remaining = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    let after_close = fixture
        .removal("remove-closed-app-shell")
        .admit()
        .and_then(|permit| permit.abort())
        .map_err(|error| error.code);
    assert_eq!(
        (claims, removal, health),
        (1, Err("checkout_use_in_use"), SessionProbeStatus::Healthy)
    );
    assert_eq!((remaining, after_close), (0, Ok(())));
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_prior_removal_refuses_app_standalone_creation() {
    let fixture = Fixture::new();
    let permit = fixture.removal("remove-before-app-shell").admit().unwrap();
    let created = fixture.create();
    let refusal = created
        .as_ref()
        .err()
        .map(|error| error.split(':').next().unwrap().to_string());
    let provider_started = fixture.marker.exists();
    let sessions = product_catalog().unwrap().list().unwrap().len();

    if let Ok(session) = &created {
        fixture.close(session);
    }
    permit.abort().unwrap();
    assert_eq!(
        (refusal.as_deref(), provider_started, sessions),
        (Some("checkout_use_phase_conflict"), false, 0),
    );
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_completed_app_standalone_replay_never_launches_a_second_generation() {
    let mut fixture = Fixture::new();
    let operation = OperationIdV1::new("replayed-native-app-shell").unwrap();
    let first = fixture
        .create_with_operation(Some(operation.clone()))
        .unwrap();
    let catalog = product_catalog().unwrap();
    let selector = SessionSelector::new(&first.session_id, Some(first.workspace_id.clone()));
    let before = catalog.find(&selector).unwrap();
    drop(std::mem::take(&mut fixture.manager));

    // No pending-create handle survives this manager replacement. The next
    // call must recover the exact result from the durable request journal.
    let replayed = fixture
        .create_with_operation(Some(operation.clone()))
        .unwrap();
    let after = catalog.find(&selector).unwrap();
    let claims = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    fixture.close(&replayed);
    let retired_replay = fixture.create_with_operation(Some(operation));
    let remaining = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    let launches = std::fs::read_to_string(&fixture.marker).unwrap();

    assert_eq!(replayed.session_id, first.session_id);
    assert_eq!(before.terminal_epoch, after.terminal_epoch);
    assert_eq!(before.provider_process, after.provider_process);
    assert_eq!(claims, 1);
    assert!(
        retired_replay.is_err(),
        "a retired completion must not create again"
    );
    assert_eq!(remaining, 0);
    assert_eq!(launches, "started");
}

#[test]
#[ignore = "requires its own isolated native app process and staged Hmux binaries"]
fn native_unpresented_app_standalone_releases_its_checkout() {
    let fixture = Fixture::new();
    let created = fixture.create().unwrap();
    let catalog = product_catalog().unwrap();
    // Abandonment arms the Host's grace period; it is not a synchronous close.
    // Keep the claim until exact retirement, then exercise the same durable
    // reconciliation that precedes application-service checkout removal.
    fixture.abandon_and_wait_for_retirement(created);
    tauri::async_runtime::block_on(async {
        let store = dure_app_sqlite::SqliteDomainStore::open(
            environment_path("DURE_HOME").join("backend/application-state.sqlite3"),
        )
        .await
        .unwrap();
        dure_session_runtime::reconcile_checkout_users(
            store.clone(),
            PathBuf::from("/runtime-not-required-for-retired-standalone"),
            catalog.discovery_root().to_path_buf(),
            fixture.registration.clone(),
        )
        .await
        .unwrap();
        store.close().await;
    });
    let remaining = read_git_checkout_claims(&fixture.registration)
        .unwrap()
        .len();
    let removal = fixture
        .removal("remove-unpresented-app-shell")
        .admit()
        .and_then(|permit| permit.abort())
        .map_err(|error| error.code);
    assert_eq!((remaining, removal), (0, Ok(())));
}
