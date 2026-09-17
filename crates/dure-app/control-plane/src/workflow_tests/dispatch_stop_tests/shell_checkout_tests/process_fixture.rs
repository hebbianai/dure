use std::path::{Path, PathBuf};
use std::process::Stdio;

use hmux_client::{
    ManagedCreateIdentityResolution, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedSessionCreator,
};
use tokio::process::{Child, Command};

const ROOT_ENV: &str = "DURE_SHELL_CHECKOUT_PROCESS_FIXTURE_ROOT";
const REQUEST_ENV: &str = "DURE_SHELL_CHECKOUT_PROCESS_FIXTURE_REQUEST";

pub(super) fn create(root: &Path, request: &ManagedCreateRequest) -> Child {
    let (_, fixture) = concat!(module_path!(), "::create_child")
        .split_once("::")
        .unwrap();
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", fixture, "--ignored", "--nocapture"])
        .current_dir(root)
        .env(ROOT_ENV, root)
        .env(REQUEST_ENV, serde_json::to_string(request).unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

pub(super) async fn reconcile_abandoned(
    runtime: &Path,
    discovery: &Path,
    identity: &ManagedCreateReconcileRequest,
) {
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(discovery);
    // Reconnect uses the runtime's reconciliation API. Reading its journal does
    // not itself perform process-absence observation or finish a lost creator's
    // transition. This test observer never manufactures a terminal checkpoint.
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        loop {
            let creator = creator.clone();
            let identity = identity.clone();
            let resolution =
                tokio::task::spawn_blocking(move || creator.reconcile_identity(identity))
                    .await
                    .unwrap()
                    .unwrap();
            match resolution {
                ManagedCreateIdentityResolution::AbandonedBeforeCompletion => return,
                ManagedCreateIdentityResolution::Pending => {}
                other => panic!("failed launch changed to an unexpected lifetime: {other:?}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("runtime reconciliation must resolve the failed orphaned launch");
}

#[tokio::test]
#[ignore = "launched only by the isolated shell process-loss fixture"]
async fn create_child() {
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(&guardian) && root != guardian);
    let request: ManagedCreateRequest =
        serde_json::from_str(&std::env::var(REQUEST_ENV).unwrap()).unwrap();
    request.validate().unwrap();
    assert!(
        request
            .provider_cwd()
            .canonicalize()
            .unwrap()
            .starts_with(&root)
    );
    let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap());
    let lifecycle =
        super::reopen_shell_lifecycle(&root, &runtime, &root.join("real-runtime-discovery")).await;
    let result = lifecycle.create(request).await;
    panic!("parent must interrupt the admitted creation before it returns: {result:?}");
}
