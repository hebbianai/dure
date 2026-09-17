use super::tests::publish_ready;
use super::*;
use tempfile::TempDir;

#[cfg(feature = "local-runtime")]
#[test]
fn bounded_query_censuses_each_configured_discovery_root() {
    let temp = TempDir::new().unwrap();
    let canonical_path = temp.path().join("canonical");
    let legacy_path = temp.path().join("legacy");
    let canonical = DiscoveryRoot::create(&canonical_path).unwrap();
    let legacy = DiscoveryRoot::create(&legacy_path).unwrap();
    let canonical_sessions = (MAX_DISCOVERED_SESSIONS / 2) + 1;
    let legacy_sessions = MAX_DISCOVERED_SESSIONS + 1 - canonical_sessions;
    for index in 0..canonical_sessions {
        publish_ready(
            &canonical,
            "canonical-workspace",
            &format!("canonical-{index:04}"),
            "token",
        );
    }
    for index in 0..legacy_sessions {
        publish_ready(
            &legacy,
            "legacy-workspace",
            &format!("legacy-{index:04}"),
            "token",
        );
    }
    let catalog =
        LocalSessionCatalog::with_read_only_discovery_roots(canonical_path, vec![legacy_path])
            .unwrap();
    let query = SessionCatalogQuery::new(8, 1024 * 1024, Vec::new()).unwrap();

    let snapshot = catalog.query(&query).unwrap();

    assert!(snapshot.complete);
    assert_eq!(snapshot.sessions.len(), 8);
    assert_eq!(
        snapshot.truncation.omitted_count,
        MAX_DISCOVERED_SESSIONS - 7
    );
}

#[test]
fn census_identity_memory_stops_at_its_fixed_budget() {
    let temporary = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temporary.path().join("discovery")).unwrap();
    let query = SessionCatalogQuery::new(
        8,
        64 * 1024,
        vec![SessionCatalogIdentity::new("workspace", "session-031").unwrap()],
    )
    .unwrap();
    let census_budget = 32;
    let mut accumulator = SessionCatalogAccumulator::new(&query, census_budget);
    for index in 0..64 {
        let session_id = format!("session-{index:03}");
        publish_ready(&root, "workspace", &session_id, "synthetic-token");
        accumulator.observe(
            root.find_manifest_by_session("workspace", &session_id)
                .unwrap(),
        );
        assert!(accumulator.seen.len() <= census_budget);
        assert!(accumulator.prioritized.len() <= query.prioritized().len());
        assert!(accumulator.remaining.len() <= query.max_items());
    }
    assert_eq!(accumulator.seen.len(), census_budget);
    assert_eq!(accumulator.prioritized.len(), 1);
    assert!(matches!(
        accumulator.finish(),
        Err(ClientError::Discovery(
            DiscoveryError::LookupLimitExceeded { maximum: 32 }
        ))
    ));
}

#[test]
fn insufficient_byte_budget_never_silently_drops_a_requested_priority() {
    let temporary = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temporary.path().join("discovery")).unwrap();
    publish_ready(&root, "workspace", "session", "synthetic-token");
    let query = SessionCatalogQuery::new(
        1,
        1,
        vec![SessionCatalogIdentity::new("workspace", "session").unwrap()],
    )
    .unwrap();
    let error = LocalSessionCatalog::new(root.path())
        .query(&query)
        .unwrap_err();
    assert_eq!(error.code(), "hmux_session_catalog_priority_output_limit");
}
