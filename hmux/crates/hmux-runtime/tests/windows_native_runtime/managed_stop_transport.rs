use hmux_client::{
    LocalProcessGenerationStatus, LocalSessionCatalog, ManagedSessionCreator,
    ManagedSessionStopper, SessionLifecycle, probe_local_process_generation,
};
use hmux_runtime_contract::{ManagedCreateRequest, ManagedStopRequest, PermissionMode};
use std::time::{Duration, Instant};

#[test]
fn native_stop_preserves_the_transport_result_before_broker_convergence() {
    // Exercise the original fast Ready -> Exited transition repeatedly. The
    // broker's AlreadyExited convergence otherwise hides the first client error.
    for attempt in 0..16 {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
        let created = ManagedSessionCreator::new(runtime)
            .with_discovery_root(&root)
            .create(
                ManagedCreateRequest::new(
                    "stop-transport-create",
                    "stop-transport-session",
                    "stop-transport-workspace",
                    "local-shell",
                    PermissionMode::Default,
                    state.path().canonicalize().unwrap(),
                    super::windows_shell_command(),
                    24,
                    80,
                )
                .unwrap(),
            )
            .unwrap();
        let session = created.session();
        let target = session.descriptor();
        let proof = session.managed_attach_authorization_proof().unwrap();
        let result = session.stop_managed_with_proof(
            &LocalSessionCatalog::new(&root),
            proof,
            Duration::from_secs(5),
        );

        // Finish the durable stop and exact process retirement even when the
        // observation above failed; never delete discovery beneath a live Host.
        let request = ManagedStopRequest::new(
            "stop-transport-cleanup",
            &target.session_id,
            &target.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            &target.runner_principal,
            &target.runner_instance,
            target.channel_epoch.parse().unwrap(),
            &target.host_instance_id,
            &target.terminal_epoch,
        )
        .unwrap();
        let cleanup = ManagedSessionStopper::new(runtime, state.path())
            .with_discovery_root(&root)
            .stop(request);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let retired = [&target.host_process, &target.provider_process]
                .into_iter()
                .all(|process| {
                    probe_local_process_generation(process)
                        .is_ok_and(|status| status != LocalProcessGenerationStatus::Live)
                });
            if retired {
                break;
            }
            if Instant::now() >= deadline {
                let retained = state.keep();
                panic!(
                    "stop transport fixture remains live; retained {retained:?}; cleanup={cleanup:?}; first result={result:?}"
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cleanup.unwrap_or_else(|error| {
            panic!("native stop cleanup failed: {error:?}; first result={result:?}")
        });
        let stopped = result.unwrap_or_else(|error| {
            panic!("native stop attempt {attempt} lost its result: {error:?}")
        });
        assert_eq!(stopped.lifecycle, SessionLifecycle::Exited);
        assert_eq!(stopped.host_instance_id, target.host_instance_id);
        assert_eq!(stopped.terminal_epoch, target.terminal_epoch);
    }
}
