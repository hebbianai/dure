use super::*;
use agent_runtime_transition_apply::deferred::idle::IdleRuntime;

#[test]
fn idle_observation_record_limit_does_not_expand_descriptor_or_policy_reads() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("observation.json");
    private_record::write(&path, &"a".repeat(17 * 1024)).unwrap();
    assert!(private_record::read(&path).is_err());
    assert!(
        private_record::read_bounded(&path, 32 * 1024)
            .unwrap()
            .is_some()
    );
    assert!(private_record::read_bounded(&path, 10).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(private_record::read_bounded(&path, 32 * 1024).is_err());
    let link = root.path().join("link.json");
    symlink(&path, &link).unwrap();
    assert!(private_record::read_bounded(&link, 32 * 1024).is_err());
}

#[tokio::test]
async fn idle_checkpoint_disarms_before_observation_and_fences_retired_writers() {
    use agent_runtime_transition_apply::deferred::{HibernateBodyV1, idle_checkpoint::Windows};
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    configure(&state, 0, json!({"mode": "enabled", "afterMs": 60_000}))
        .await
        .unwrap();
    let body: HibernateBodyV1 = serde_json::from_value(json!({
        "schemaVersion": 1, "agentId": "checkpoint-agent", "expectedSourceRevision": 1,
    }))
    .unwrap();
    let path = root.path().join("runtime-idle-observations-v1.json");
    let mut windows = Windows::load(&state, 1, 60_000).unwrap();
    windows
        .observe("checkpoint-agent", "source-a".into(), body.clone())
        .unwrap();
    windows.save(&state).unwrap();
    let mut record: Value =
        serde_json::from_slice(&private_record::read(&path).unwrap().unwrap()).unwrap();
    // Inject only a disposable observation record, never a live idle clock.
    record["observations"]["checkpoint-agent"]["measuredMs"] = json!(15_000);
    private_record::write(&path, &record).unwrap();
    let mut restored = Windows::load(&state, 1, 60_000).unwrap();
    restored.disarm(&state).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&private_record::read(&path).unwrap().unwrap()).unwrap()["observations"],
        json!({})
    );
    let mut after_crash = Windows::load(&state, 1, 60_000).unwrap();
    let (elapsed, reused, ready) = after_crash
        .observe("checkpoint-agent", "source-a".into(), body.clone())
        .unwrap();
    assert_eq!(elapsed, std::time::Duration::ZERO);
    assert!(
        !reused && ready.is_none(),
        "a crash before a successful scan cannot restore old credit"
    );
    let (elapsed, reused, ready) = restored
        .observe("checkpoint-agent", "source-a".into(), body.clone())
        .unwrap();
    assert_eq!(elapsed, std::time::Duration::from_secs(15));
    assert!(reused && ready.is_none());
    restored.save(&state).unwrap();
    let before = private_record::read(&path).unwrap().unwrap();
    let mut successor = state.descriptor.clone();
    successor.generation = random_generation().unwrap();
    successor.socket_path = generation_socket_path(root.path(), &successor.generation);
    write_descriptor(&state.canonical_descriptor_path, &successor).unwrap();
    assert!(restored.save(&state).is_err());
    assert!(restored.disarm(&state).is_err());
    assert_eq!(private_record::read(&path).unwrap().unwrap(), before);
    // A changed policy also prevents the previous observer from publishing.
    make_fixture_mutation_authority(&mut state);
    configure(&state, 1, json!({"mode": "enabled", "afterMs": 60_000}))
        .await
        .unwrap();
    assert!(restored.save(&state).is_err());
    let mut new_policy = Windows::load(&state, 2, 60_000).unwrap();
    let (elapsed, reused, ready) = new_policy
        .observe("checkpoint-agent", "source-a".into(), body)
        .unwrap();
    assert_eq!(elapsed, std::time::Duration::ZERO);
    assert!(!reused && ready.is_none());
}

async fn configure(
    state: &ServiceState,
    revision: u64,
    policy: Value,
) -> Result<Value, BackendDispatchError> {
    let body = serde_json::from_value(json!({
        "schemaVersion": 1, "expectedRevision": revision, "policy": policy,
    }))
    .unwrap();
    state
        .runtime_idle
        .configure(state, body)
        .await
        .map(|status| serde_json::to_value(status).unwrap())
}

async fn observe(state: &ServiceState) -> Value {
    serde_json::to_value(state.runtime_idle.observe(state).await).unwrap()
}

#[tokio::test]
async fn runtime_idle_policy_persists_across_runtime_and_generation_replacement() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    state.runtime_idle = IdleRuntime::from_value(Some("1800000"));
    let seeded = observe(&state).await;
    assert_eq!(seeded["configuration"], "enabled");
    assert_eq!(seeded["policyRevision"], 1);
    state.runtime_idle = IdleRuntime::default();
    state.descriptor.generation = random_generation().unwrap();
    make_fixture_mutation_authority(&mut state);
    assert_eq!(observe(&state).await, seeded);
    let disabled = configure(&state, 1, json!({"mode": "disabled"}))
        .await
        .unwrap();
    assert_eq!(disabled["policyRevision"], 2);
    state.runtime_idle = IdleRuntime::from_value(Some("1000"));
    assert_eq!(
        observe(&state).await,
        disabled,
        "stored opt-out overrides new launch environment"
    );
}

#[tokio::test]
async fn runtime_idle_policy_cas_and_generation_authority_protect_writes() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    assert_eq!(observe(&state).await["policyRevision"], 0);
    let enabled = configure(&state, 0, json!({"mode": "enabled", "afterMs": 1000}))
        .await
        .unwrap();
    assert_eq!(enabled["policyRevision"], 1);
    assert_eq!(
        configure(&state, 0, json!({"mode": "disabled"}))
            .await
            .unwrap_err()
            .code,
        "runtime_idle_policy_revision_conflict"
    );
    assert_eq!(observe(&state).await, enabled);
    let mut successor = state.descriptor.clone();
    successor.generation = random_generation().unwrap();
    successor.socket_path = generation_socket_path(root.path(), &successor.generation);
    write_descriptor(&state.canonical_descriptor_path, &successor).unwrap();
    assert_eq!(
        configure(&state, 1, json!({"mode": "disabled"}))
            .await
            .unwrap_err()
            .code,
        "runtime_idle_authority_unavailable"
    );
    assert_eq!(observe(&state).await, enabled);
    let policy = root.path().join("runtime-idle-policy-v1.json");
    fs::remove_file(&policy).unwrap();
    state.runtime_idle = IdleRuntime::from_value(Some("1000"));
    assert_eq!(observe(&state).await["configuration"], "disabled");
    assert!(
        !policy.exists(),
        "a retired or staged backend cannot seed a missing policy"
    );
}

#[tokio::test]
async fn runtime_idle_policy_invalid_records_disable_without_breaking_backend() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    state.runtime_idle = IdleRuntime::from_value(Some("1000"));
    let policy = root.path().join("runtime-idle-policy-v1.json");
    for value in [
        json!({"schemaVersion": 2, "revision": 1, "policy": {"mode": "disabled"}}),
        json!({"schemaVersion": 1, "revision": 0, "policy": {"mode": "disabled"}}),
        json!({"schemaVersion": 1, "revision": 1, "policy": {"mode": "enabled", "afterMs": 999}}),
        json!({"schemaVersion": 1, "revision": 1, "policy": {"mode": "disabled", "afterMs": 1000}}),
    ] {
        private_record::write(&policy, &value).unwrap();
        let status = observe(&state).await;
        assert_eq!(status["configuration"], "invalid");
        assert_eq!(status["afterMs"], Value::Null);
        assert_eq!(status["policyRevision"], Value::Null);
        assert!(
            configure(&state, 0, json!({"mode": "disabled"}))
                .await
                .is_err()
        );
        assert!(
            state.is_mutation_authority(),
            "bad admission policy is not backend boot failure"
        );
    }
    fs::set_permissions(&policy, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(observe(&state).await["configuration"], "invalid");
    fs::remove_file(&policy).unwrap();
    symlink(root.path().join("absent-policy"), &policy).unwrap();
    assert_eq!(observe(&state).await["configuration"], "invalid");
    assert!(
        fs::symlink_metadata(&policy)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn runtime_idle_policy_disabled_worker_can_be_enabled_without_restart() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let state = Arc::new(state);
    let worker = tokio::spawn(agent_runtime_transition_apply::deferred::idle::run(
        Arc::clone(&state),
    ));
    tokio::task::yield_now().await;
    assert!(
        !worker.is_finished(),
        "disabled is a policy, not the end of the worker lifetime"
    );
    let first = configure(&state, 0, json!({"mode": "enabled", "afterMs": 1000}))
        .await
        .unwrap();
    assert_eq!(first["observedAtMs"], Value::Null);
    let second = configure(&state, 1, json!({"mode": "enabled", "afterMs": 1000}))
        .await
        .unwrap();
    assert_eq!(
        second["policyRevision"], 2,
        "even the same threshold starts a new policy epoch"
    );
    assert_eq!(second["observedAtMs"], Value::Null);
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
}
