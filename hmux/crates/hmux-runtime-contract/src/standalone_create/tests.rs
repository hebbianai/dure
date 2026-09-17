use super::*;

fn request() -> StandaloneCreateRequest {
    StandaloneCreateRequest::new("/tmp", Some("bound".into()), vec![], 24, 80)
        .unwrap()
        .with_recovery_identity(
            StandaloneRecoveryCreateIdentity::new("standalone_bound", "private-proof").unwrap(),
        )
        .unwrap()
}

#[test]
fn operation_binding_requires_an_explicit_schema_and_deterministic_identity() {
    let legacy = request();
    let bound = legacy
        .clone()
        .with_recovery_operation_id("operation")
        .unwrap();
    let wire = serde_json::to_value(&bound).unwrap();
    assert_eq!(wire["schema"], OPERATION_BOUND_SCHEMA);
    let decoded: StandaloneCreateRequest = serde_json::from_value(wire.clone()).unwrap();
    decoded.validate().unwrap();
    assert_eq!(decoded, bound);
    for version in 1..=3 {
        let mut stale = wire.clone();
        stale["schema"] = format!("hmux-standalone-create-v{version}").into();
        stale["schemaVersion"] = version.into();
        let stale: StandaloneCreateRequest = serde_json::from_value(stale).unwrap();
        assert!(stale.validate().is_err());
    }
    assert!(
        StandaloneCreateRequest::shell("/tmp", 24, 80)
            .unwrap()
            .with_recovery_operation_id("operation")
            .is_err()
    );
    assert!(legacy.clone().with_recovery_operation_id("").is_err());
    assert_eq!(
        bound.without_recovery_identity(),
        legacy.without_recovery_identity()
    );
}

#[test]
fn presentation_options_do_not_downgrade_a_bound_request() {
    let bound = request().with_recovery_operation_id("operation").unwrap();
    let refreshed = bound
        .clone()
        .with_retirement_policy_option(None)
        .unwrap()
        .with_terminal_default_colors_option(None)
        .unwrap();
    assert_eq!(refreshed, bound);
}

#[test]
fn located_operation_keeps_its_explicit_namespace_and_cannot_downgrade() {
    let request = request()
        .with_recovery_operation_at("operation", "/source-root")
        .unwrap();
    assert_eq!(
        request.recovery_operation_root(),
        Some(Path::new("/source-root"))
    );
    let wire = serde_json::to_value(&request).unwrap();
    assert_eq!(wire["schema"], LOCATED_OPERATION_SCHEMA);
    let decoded: StandaloneCreateRequest = serde_json::from_value(wire.clone()).unwrap();
    decoded.validate().unwrap();
    assert_eq!(decoded, request);
    for version in 1..=4 {
        let mut downgraded = wire.clone();
        downgraded["schema"] = format!("hmux-standalone-create-v{version}").into();
        downgraded["schemaVersion"] = version.into();
        let decoded: StandaloneCreateRequest = serde_json::from_value(downgraded).unwrap();
        assert!(decoded.validate().is_err());
    }
    assert!(
        request
            .clone()
            .with_recovery_operation_at("operation", "relative-root")
            .is_err()
    );
    let public = request.without_recovery_identity();
    assert!(public.recovery_operation_root().is_none());
    assert!(public.recovery_operation_id().is_none());
}

#[test]
fn negotiation_keeps_legacy_requests_and_binds_only_supported_operation_locations() {
    let original = request();
    let root = Path::new("/source");
    let other = Path::new("/target");
    for (capabilities, same_version, cross_version) in [
        (vec![], 1, 1),
        (vec!["unrelated"], 1, 1),
        (vec![STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY], 4, 1),
        (vec![STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY], 5, 5),
        (
            vec![
                STANDALONE_OPERATION_BOUND_CREATE_CAPABILITY,
                STANDALONE_LOCATED_OPERATION_CREATE_CAPABILITY,
            ],
            4,
            5,
        ),
    ] {
        let capabilities: Vec<_> = capabilities.into_iter().map(str::to_owned).collect();
        for (target, version) in [(root, same_version), (other, cross_version)] {
            let negotiated = original
                .clone()
                .with_negotiated_recovery_operation("operation", root, target, &capabilities)
                .unwrap();
            let wire = serde_json::to_value(&negotiated).unwrap();
            if version == 1 {
                assert_eq!(negotiated, original);
            } else {
                assert_eq!(wire["schemaVersion"], version);
                assert_eq!(negotiated.recovery_operation_id(), Some("operation"));
                assert_eq!(
                    negotiated.recovery_operation_root(),
                    (version == 5).then_some(root)
                );
            }
            let reopened: StandaloneCreateRequest = serde_json::from_value(wire).unwrap();
            reopened.validate().unwrap();
            assert_eq!(reopened, negotiated);
            assert_eq!(
                negotiated.without_recovery_identity(),
                original.clone().without_recovery_identity()
            );
        }
    }
}
