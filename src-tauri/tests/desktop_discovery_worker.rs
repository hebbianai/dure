#![cfg(unix)]

use hmux_client::{
    inspect_local_sessions_exact_isolated, list_local_sessions_isolated, CatalogCensusWorker,
    ExactDiscoveryWorker, ExactSessionProbeResult, LocalSessionCatalog, SessionSelector,
};
use hmux_host::local_discovery::DiscoveryRoot;
use std::time::Duration;

#[path = "../src/hmux/discovery_worker.rs"]
mod paired_worker;

#[test]
fn desktop_bundled_reader_serves_a_complete_census_without_an_independent_runtime() {
    let root = tempfile::tempdir().unwrap();
    let discovery = root.path().join("discovery");
    DiscoveryRoot::create(&discovery).unwrap();
    let catalog = LocalSessionCatalog::new(discovery);
    let worker = CatalogCensusWorker::new(
        paired_worker::resolve(std::path::Path::new(env!("CARGO_BIN_EXE_dure"))).unwrap(),
    );

    let sessions = list_local_sessions_isolated(&catalog, &worker, Duration::from_millis(1_500))
        .expect("the desktop's reader and worker must implement the same private protocol");

    assert!(sessions.is_empty());
}

#[test]
fn desktop_bundled_reader_serves_exact_lookup_within_the_product_budget() {
    let root = tempfile::tempdir().unwrap();
    let discovery = root.path().join("discovery");
    DiscoveryRoot::create(&discovery).unwrap();
    let catalog = LocalSessionCatalog::new(discovery);
    let worker = ExactDiscoveryWorker::new(
        paired_worker::resolve(std::path::Path::new(env!("CARGO_BIN_EXE_dure"))).unwrap(),
    );
    let selector = SessionSelector::new("absent-agent", Some("owned-workspace".into()));

    let results = inspect_local_sessions_exact_isolated(
        &catalog,
        &worker,
        vec![selector],
        1,
        Duration::from_millis(1_500),
    )
    .unwrap();

    assert_eq!(results.len(), 1);
    assert!(matches!(results[0], ExactSessionProbeResult::NotFound(_)));
}

#[test]
fn missing_or_symlinked_bundled_reader_is_not_replaced_by_an_independent_install() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("dure");
    std::fs::write(&executable, "owned desktop path fixture").unwrap();
    assert!(paired_worker::resolve(&executable)
        .unwrap_err()
        .contains("bundled reader"));
    let real_worker =
        paired_worker::resolve(std::path::Path::new(env!("CARGO_BIN_EXE_dure"))).unwrap();
    symlink(real_worker, root.path().join("hmux-runtime")).unwrap();
    assert!(paired_worker::resolve(&executable)
        .unwrap_err()
        .contains("bundled reader"));
}
