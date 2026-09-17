use super::*;

#[test]
fn compatibility_retirement_preserves_pending_intent_and_busy_source_in_each_root() {
    for compatibility_operation in [false, true] {
        for busy_source in [false, true] {
            for stale in [false, true] {
                let temp = tempfile::tempdir().unwrap();
                let catalog = compatibility_catalog(
                    &temp,
                    "pending",
                    if stale { publish_ready } else { publish_exited },
                );
                let target = exact_target(&catalog, "pending");
                let operation_root = if compatibility_operation {
                    temp.path().join("compatibility")
                } else {
                    catalog.discovery_root().to_path_buf()
                };
                let pending = if busy_source {
                    None
                } else {
                    Some(
                        recovery_journal::reserve(
                            &operation_root,
                            RecoveryIdentity {
                                recovery_id: "pending-upgrade".into(),
                                source_session_id: "pending".into(),
                                source_workspace_id: "workspace".into(),
                                request_fingerprint: request_fingerprint(&["pending-upgrade"]),
                                action: "test",
                            },
                        )
                        .unwrap(),
                    )
                };
                let source_lock = busy_source.then(|| {
                    recovery_journal::lock_source(&operation_root, "workspace", "pending").unwrap()
                });
                let apply = |mode| {
                    if stale {
                        catalog
                            .cleanup_stale_sessions(vec![target.clone()], mode)
                            .unwrap()
                    } else {
                        catalog
                            .retire_exited_sessions(vec![target.clone()], mode)
                            .unwrap()
                    }
                };
                if !busy_source {
                    let preview = apply(ExitedSessionRetirementMode::Preview);
                    assert_eq!(
                        preview.results[0].reason,
                        Some(ExitedSessionRetirementReason::RecoveryPending)
                    );
                }
                let report = apply(ExitedSessionRetirementMode::Apply);
                let still_present = catalog
                    .open(&SessionSelector::new("pending", Some("workspace".into())))
                    .is_ok();
                drop(source_lock);
                drop(pending);
                assert_eq!(
                    report.retired, 0,
                    "compatibility operation: {compatibility_operation}, busy source: {busy_source}"
                );
                assert_eq!(
                    report.results[0].reason,
                    Some(ExitedSessionRetirementReason::RecoveryPending)
                );
                assert!(still_present);
            }
        }
    }
}
