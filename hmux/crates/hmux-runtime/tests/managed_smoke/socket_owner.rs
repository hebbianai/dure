//! Real listener loss, exact-generation retirement and same-conversation replay.
use super::*;
use hmux_client::local_host_socket_owner_absent;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};

#[test]
fn socket_owner_guard_preserves_live_listener_and_recovers_orphan_once() {
    // Retain failures for the test runner's exact-process guardian.
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let marker = root.join("replacement-conversation");
    let fault = root.join("exit-listener");
    let runtime = root.join("runtime");
    let home = root.join("home");
    let sockets = root.join("s");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&sockets).unwrap();
    let quote =
        |path: &std::path::Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
    fs::write(&runtime, format!(
        "#!/bin/sh\nexport HOME={home} DURE_HOME={home} ZDOTDIR={home}\nexport HMUX_RUNTIME_ROOT={sockets} HMUX_RUNTIME_TEST_LISTENER_EXIT={fault}\nexec {runtime} \"$@\"\n",
        home = quote(&home), sockets = quote(&sockets), fault = quote(&fault),
        runtime = quote(std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"))),
    )).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let created = ManagedSessionCreator::new(&runtime)
        .with_discovery_root(&discovery)
        .create(rehostable_create_request(&home, &marker, "socket-owner"))
        .unwrap();
    let source = created.session().descriptor().clone();
    eprintln!("socket-owner fixture root={root:?} source={source:?}");
    let scenario = catch_unwind(AssertUnwindSafe(|| {
        let request = exact_managed_rehost_request("socket-owner-operation", &source, true)
            .with_expected_conversation_id("conversation-socket-owner")
            .unwrap()
            .requiring_socket_owner_absence()
            .unwrap();
        let rehoster = ManagedSessionRehoster::new(&runtime, &home).with_discovery_root(&discovery);
        assert!(!local_host_socket_owner_absent(&source));
        let refused = rehoster.rehost(request.clone()).unwrap_err();
        assert_eq!(
            refused.code(),
            "managed_rehost_socket_owner_absence_required"
        );
        assert_eq!(
            probe_local_process_generation(&source.host_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        assert_eq!(
            probe_local_process_generation(&source.provider_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        assert!(!marker.exists());

        fs::write(&fault, "exit only this listener").unwrap();
        drop(std::os::unix::net::UnixStream::connect(&source.endpoint.address).unwrap());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !local_host_socket_owner_absent(&source) {
            assert!(
                Instant::now() < deadline,
                "the exact live Host never became socket-free"
            );
            thread::sleep(Duration::from_millis(20));
        }
        // Concurrent readers must use direct exact-generation evidence, not a
        // shared stale numeric-PID snapshot. No reader mutates either process.
        thread::scope(|scope| {
            let readers: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| local_host_socket_owner_absent(&source)))
                .collect();
            for reader in readers {
                assert!(reader.join().unwrap());
            }
        });
        assert_eq!(
            probe_local_process_generation(&source.provider_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        let receipt = rehoster.rehost(request.clone()).unwrap();
        assert_eq!(receipt.conversation_id(), Some("conversation-socket-owner"));
        wait_for_process_absent(&source.provider_process);
        wait_for_process_absent(&source.host_process);
        wait_for_file_content(&marker, b"conversation-socket-owner");
        let replay = rehoster.rehost(request).unwrap();
        assert!(replay.replayed());
        assert_eq!(replay.replacement_receipt(), receipt.replacement_receipt());
        assert_eq!(
            fs::read_to_string(&marker).unwrap(),
            "conversation-socket-owner"
        );
    }));
    stop_ready_managed_test_sessions(&discovery, &home);
    if let Err(error) = scenario {
        resume_unwind(error);
    }
}
