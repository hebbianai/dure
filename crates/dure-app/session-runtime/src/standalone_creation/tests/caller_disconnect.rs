use super::*;
use dure_app::SessionCheckoutOwnerV1;
use std::fs;
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn disconnected_caller_preserves_pending_admission_and_replays_one_native_creation() {
    let fixture = Fixture::new().await;
    let gate = BrokerGate::new(&fixture);
    let marker = fixture.database.with_file_name("provider-started");
    let request = StandaloneCreateRequest::new(
        &fixture.checkout,
        Some("disconnected-create".into()),
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf 'started\n' >> \"$1\"; while IFS= read -r line; do :; done".into(),
            "qa-provider".into(),
            marker.to_str().unwrap().into(),
        ],
        24,
        80,
    )
    .unwrap();
    let operation = OperationIdV1::new("disconnected-create").unwrap();
    let runtime = CheckoutSessionRuntime::at_root(
        fixture.runtime.store.clone(),
        gate.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let caller = tokio::spawn({
        let request = request.clone();
        let operation = operation.clone();
        async move { runtime.create_standalone(operation, request).await }
    });
    wait_until(|| gate.entered.exists()).await;
    // Only the requesting task disappears. The already accepted service task
    // and its real broker stay alive; this is not a broker/Host crash fixture.
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let pending = fixture.record().await;
    assert!(matches!(
        pending.binding.identity.owner,
        SessionCheckoutOwnerV1::Recovery { .. }
    ));
    let catalog = LocalSessionCatalog::new(&fixture.discovery);
    assert!(catalog.list().unwrap().is_empty());
    assert!(!marker.exists());
    fixture.reconcile().await;
    assert_eq!(fixture.record().await, pending);
    assert_eq!(
        fixture.removal("remove-disconnected"),
        Err("checkout_use_in_use")
    );
    let busy = fixture
        .runtime
        .create_standalone(operation.clone(), request.clone())
        .await
        .unwrap_err();
    assert!(busy.to_string().contains("hmux_recovery_busy"));
    assert_eq!(fixture.claims(), 1);
    assert!(!marker.exists());

    gate.release();
    let deadline = Instant::now() + Duration::from_secs(10);
    let published = loop {
        let current = fixture.record().await;
        if matches!(
            current.binding.identity.owner,
            SessionCheckoutOwnerV1::Standalone { .. }
        ) && current.close_payload.is_some()
        {
            break current;
        }
        assert!(
            Instant::now() < deadline,
            "detached creation did not publish"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(published.binding.claim_id, pending.binding.claim_id);
    let original = catalog.list().unwrap().pop().unwrap();
    wait_until(|| marker.exists()).await;
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let missing = fixture.database.with_file_name("unavailable-runtime");
    assert!(!missing.exists());
    let reconnected =
        CheckoutSessionRuntime::at_root(store.clone(), missing, fixture.discovery.clone()).unwrap();
    let replayed = reconnected
        .create_standalone(operation, request)
        .await
        .unwrap();
    assert_eq!(replayed.session().descriptor(), &original);
    assert_eq!(fs::read_to_string(&marker).unwrap(), "started\n");
    assert_eq!(fs::read_to_string(&gate.entered).unwrap(), "entered\n");
    assert_eq!(fixture.claims(), 1);
    super::retention::close(&store, &fixture, &replayed).await;
    store.close().await;
    assert_eq!(
        (
            fixture.claims(),
            fixture.removal("after-disconnected-close")
        ),
        (0, Ok(()))
    );
}

struct BrokerGate {
    executable: PathBuf,
    entered: PathBuf,
    release: PathBuf,
}

impl BrokerGate {
    fn new(fixture: &Fixture) -> Self {
        let gate = Self {
            executable: fixture.database.with_file_name("paused-broker"),
            entered: fixture.database.with_file_name("broker-entered"),
            release: fixture.database.with_file_name("broker-release"),
        };
        let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
        fs::write(&gate.executable, format!(
            "#!/bin/sh\nprintf 'entered\\n' >> {}\nwhile [ ! -e {} ]; do /bin/sleep 0.02; done\nexec {} \"$@\"\n",
            quote(&gate.entered), quote(&gate.release), quote(&fixture.executable),
        )).unwrap();
        fs::set_permissions(&gate.executable, fs::Permissions::from_mode(0o700)).unwrap();
        gate
    }

    fn release(&self) {
        fs::write(&self.release, "release\n").unwrap();
    }
}

impl Drop for BrokerGate {
    fn drop(&mut self) {
        // Even a failed assertion must let the owned broker finish so the
        // outer guardian can reconcile it; never strand a Tokio blocking task.
        let _ = fs::write(&self.release, "release\n");
    }
}

async fn wait_until(ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "native fixture did not reach its barrier"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
