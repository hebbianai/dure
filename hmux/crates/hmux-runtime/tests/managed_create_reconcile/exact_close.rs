use super::*;
use hmux_client::{CreatedManagedSession, ManagedStopRequest, SessionDescriptor};
use std::path::{Path, PathBuf};

#[path = "exact_close/namespaces.rs"]
mod namespaces;

struct Fixture {
    catalog: LocalSessionCatalog,
    request: ManagedCreateRequest,
    creator: ManagedSessionCreator,
    stopper: ManagedSessionStopper,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = isolated_root();
        let discovery = root.join("discovery");
        Self::at(label, &root, &discovery)
    }

    fn at(label: &str, root: &Path, discovery: &Path) -> Self {
        fs::write(root.join("hold-open"), b"1").unwrap();
        let request = ManagedCreateRequest::new(
            format!("{label}-create"),
            format!("{label}-session"),
            format!("{label}-workspace"),
            "fixture",
            PermissionMode::Default,
            root,
            fixture_provider_command(),
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                root.to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        let runtime = Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
        Self {
            catalog: LocalSessionCatalog::new(discovery),
            request,
            creator: ManagedSessionCreator::new(runtime).with_discovery_root(discovery),
            stopper: ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
                .with_discovery_root(discovery),
        }
    }

    fn create(&self) -> CreatedManagedSession {
        self.creator.create(self.request.clone()).unwrap()
    }

    fn assert_closed(&self) {
        assert!(matches!(
            self.creator
                .create_or_reconcile_and_advance(self.request.clone())
                .unwrap(),
            ManagedCreateAdvanceResolution::AuthorityUnavailable(_)
        ));
    }
}

fn isolated_root() -> PathBuf {
    // Keep failed fixtures until the outer guardian proves process cleanup.
    let root = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(&guardian) && root != guardian);
    root
}

fn stop_request(label: &str, descriptor: &SessionDescriptor) -> ManagedStopRequest {
    ManagedStopRequest::new(label, &descriptor.session_id, &descriptor.workspace_id)
        .unwrap()
        .with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            descriptor.channel_epoch.parse::<u64>().unwrap(),
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
        .unwrap()
}

#[test]
fn exact_close_replays_and_prevents_another_successor() {
    let fixture = Fixture::new("exact-close-replay");
    let created = fixture.create();
    let descriptor = created.session().descriptor().clone();
    let reopened =
        CreatedManagedSession::from_completed_receipt(created.receipt().clone()).unwrap();
    assert!(reopened.session().descriptor().same_generation(&descriptor));
    drop(reopened);
    drop(created);
    let request = stop_request("exact-close-replay-stop", &descriptor);
    let receipt = fixture
        .stopper
        .stop_and_close_creation(request.clone())
        .unwrap();
    assert_eq!(
        fixture.stopper.stop_and_close_creation(request).unwrap(),
        receipt
    );
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
    fixture.assert_closed();
}

#[test]
fn obsolete_exact_close_preserves_a_live_successor() {
    let fixture = Fixture::new("exact-close-successor");
    let created = fixture.create();
    let source = created.session().descriptor().clone();
    drop(created);
    let source_stop = stop_request("exact-close-source-stop", &source);
    // A normal generation stop permits recovery to advance. Only explicit
    // logical close may close the vacant successor slot.
    fixture.stopper.stop(source_stop.clone()).unwrap();
    let ManagedCreateAdvanceResolution::Advanced(successor) = fixture
        .creator
        .create_or_reconcile_and_advance(fixture.request.clone())
        .unwrap()
    else {
        panic!("stopped but open source must admit a successor");
    };
    let target = successor.session().descriptor().clone();
    let expected_receipt = successor.receipt().clone();
    assert!(!target.same_generation(&source));
    drop(successor);
    assert_eq!(
        fixture
            .stopper
            .stop_and_close_creation(source_stop)
            .unwrap_err()
            .code(),
        "hmux_managed_stop_create_close_unavailable"
    );
    let identity = ManagedCreateReconcileRequest::new(
        fixture.request.idempotency_key(),
        fixture.request.session_id(),
        fixture.request.workspace_id(),
    )
    .unwrap();
    let ManagedCreateChainResolution::Existing(resolved) =
        fixture.creator.resolve_successor_chain(identity).unwrap()
    else {
        panic!("the root must still resolve to its live successor");
    };
    assert_eq!(resolved.receipt(), &expected_receipt);
    drop(resolved);
    let current = fixture
        .catalog
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .unwrap();
    assert!(current.same_generation(&target));
    assert_eq!(
        probe_local_process_generation(&target.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    fixture
        .stopper
        .stop_and_close_creation(stop_request("exact-close-target-stop", &target))
        .unwrap();
    fixture.assert_closed();
}
