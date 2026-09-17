use super::*;

fn identity(owner: SessionCheckoutOwnerV1) -> SessionCheckoutIdentityV1 {
    SessionCheckoutIdentityV1 {
        runtime_namespace: "/runtime/one".into(),
        owner,
    }
}

#[test]
fn session_owner_hashes_retain_their_existing_claim_identity() {
    for (owner, expected) in [
        (
            SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace".into(),
                session_id: "shell".into(),
                idempotency_key: "create-shell".into(),
            },
            "session-checkout-bfb82e634122f1bfd85ffdc2b0ff5309aa4f54b968b7a0fc320567a584c5d4a7",
        ),
        (
            SessionCheckoutOwnerV1::Standalone {
                workspace_id: "workspace".into(),
                session_id: "standalone-shell".into(),
                recovery_id: "standalone-recovery".into(),
            },
            "session-checkout-2b23508b12262ed83d5d47abdc87c946307e387f7d28367793c1ddf41c55ae02",
        ),
    ] {
        let binding = SessionCheckoutBindingV1::new(identity(owner), "/checkout".into(), None);
        assert_eq!(binding.claim_id.as_str(), expected);
        let persisted = serde_json::to_string(&binding).unwrap();
        let replay: SessionCheckoutBindingV1 = serde_json::from_str(&persisted).unwrap();
        assert_eq!(replay, binding);
        assert_eq!(replay.identity.owner_id(), binding.claim_id);
    }
}

#[test]
fn recovery_retention_round_trips_without_a_runtime_session() {
    let owner: SessionCheckoutIdentityV1 = serde_json::from_value(serde_json::json!({
        "runtimeNamespace": "/runtime/one",
        "owner": { "kind": "recovery", "recoveryId": "convert-one" }
    }))
    .unwrap();
    assert_eq!(
        owner,
        identity(SessionCheckoutOwnerV1::Recovery {
            recovery_id: "convert-one".into()
        })
    );
    let binding = SessionCheckoutBindingV1::new(owner, "/checkout".into(), None);
    let persisted = serde_json::to_string(&binding).unwrap();
    let replay: SessionCheckoutBindingV1 = serde_json::from_str(&persisted).unwrap();
    assert_eq!(replay, binding);
    assert_eq!(replay.identity.owner_id(), binding.claim_id);
}

#[test]
fn owner_keys_separate_namespaces_kinds_and_field_boundaries() {
    let recovery = identity(SessionCheckoutOwnerV1::Recovery {
        recovery_id: "convert-one".into(),
    });
    let changed_namespace = SessionCheckoutIdentityV1 {
        runtime_namespace: "/runtime/two".into(),
        ..recovery.clone()
    };
    let changed_operation = identity(SessionCheckoutOwnerV1::Recovery {
        recovery_id: "convert-two".into(),
    });
    let moved_boundary = SessionCheckoutIdentityV1 {
        runtime_namespace: "/runtime/onec".into(),
        owner: SessionCheckoutOwnerV1::Recovery {
            recovery_id: "onvert-one".into(),
        },
    };
    let standalone = identity(SessionCheckoutOwnerV1::Standalone {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        recovery_id: "convert-one".into(),
    });
    let managed = identity(SessionCheckoutOwnerV1::Managed {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        idempotency_key: "convert-one".into(),
    });
    let keys: std::collections::HashSet<_> = [
        recovery,
        changed_namespace,
        changed_operation,
        moved_boundary,
        standalone,
        managed,
    ]
    .into_iter()
    .map(|owner| owner.owner_id())
    .collect();
    assert_eq!(keys.len(), 6);
}

#[test]
fn agent_lifetime_keeps_the_claim_but_distinguishes_new_incarnations() {
    let source = SessionCheckoutBindingV1::new(
        identity(SessionCheckoutOwnerV1::Managed {
            workspace_id: "workspace".into(),
            session_id: "worker".into(),
            idempotency_key: "create-worker".into(),
        }),
        "/checkout".into(),
        None,
    );
    let agent_id = AgentIdV1::new("worker-agent").unwrap();
    let adopted = source.retained_by_agent(&agent_id);
    assert_eq!(adopted.retained_by_agent(&agent_id), adopted);
    assert_eq!(adopted.claim_id, source.claim_id);
    assert_ne!(adopted.identity.owner_id(), source.identity.owner_id());
    let newcomer = identity(SessionCheckoutOwnerV1::Agent {
        agent_id: AgentIdV1::new("worker-agent").unwrap(),
        registration_id: OperationIdV1::new("another-registration").unwrap(),
    });
    assert_ne!(adopted.identity.owner_id(), newcomer.owner_id());
    let persisted = serde_json::to_string(&adopted).unwrap();
    assert_eq!(
        serde_json::from_str::<SessionCheckoutBindingV1>(&persisted).unwrap(),
        adopted
    );
}

#[test]
fn retaining_an_already_registered_agent_preserves_its_opaque_incarnation() {
    let agent_id = AgentIdV1::new("registered-agent").unwrap();
    let registered = SessionCheckoutBindingV1::new(
        identity(SessionCheckoutOwnerV1::Agent {
            agent_id: agent_id.clone(),
            registration_id: OperationIdV1::new("opaque-registration").unwrap(),
        }),
        "/checkout".into(),
        None,
    );
    assert_eq!(registered.retained_by_agent(&agent_id), registered);
}
