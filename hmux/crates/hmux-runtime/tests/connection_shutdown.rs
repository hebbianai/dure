#![cfg(unix)]

use std::time::{Duration, Instant};

use hmux_client::{
    ControllerEvent, LocalProcessGenerationStatus, LocalSessionCatalog, StandaloneCreateRequest,
    StandaloneSessionCreator, probe_local_process_generation,
};

#[test]
fn terminated_host_drains_its_last_client_before_checkout_cleanup_deadline() {
    // Retain the disposable root on assertion failure for the process guardian.
    let root = tempfile::tempdir().unwrap().keep();
    let discovery = root.join("discovery");
    let creator = StandaloneSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery);
    let request = StandaloneCreateRequest::new(
        root.canonicalize().unwrap(),
        Some("connection-shutdown".into()),
        vec!["/bin/sh".into(), "-s".into()],
        24,
        80,
    )
    .unwrap();
    let mut created = creator.create(request).unwrap();
    let descriptor = created.session().descriptor().clone();
    let mut controller = created.connect_controller().unwrap();
    created
        .session()
        .terminate_standalone(
            &LocalSessionCatalog::new(&discovery),
            Duration::from_secs(3),
        )
        .unwrap();

    // Stop acknowledgement is not Host retirement. An attached client must
    // drain and close before the caller's remaining cleanup budget expires.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut saw_exit = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "the final connection did not drain");
        controller.set_read_timeout(Some(remaining)).unwrap();
        match controller.read_event().unwrap() {
            Some(ControllerEvent::Exit(_)) => saw_exit = true,
            Some(_) => {}
            None => break,
        }
    }
    assert!(
        saw_exit,
        "the connection closed before delivering final Exit"
    );
    loop {
        if probe_local_process_generation(&descriptor.host_process).unwrap()
            == LocalProcessGenerationStatus::Absent
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Host stayed alive after its final connection drained"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        probe_local_process_generation(&descriptor.provider_process).unwrap(),
        LocalProcessGenerationStatus::Absent
    );
}
