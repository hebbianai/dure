use super::*;
mod native;
use dure_app::{
    SessionCheckoutAdmissionV1, SessionCheckoutBindingV1, SessionCheckoutIdentityV1,
    SessionCheckoutOwnerV1,
};

fn checkout() -> SessionCheckoutBindingV1 {
    SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: "/runtime/one".into(),
            owner: SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace-1".into(),
                session_id: "session-1".into(),
                idempotency_key: "create-worker".into(),
            },
        },
        "/workspace/project".into(),
        None,
    )
}

#[tokio::test]
async fn agent_retains_checkout_without_a_runtime_selection() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let agent_id = native_selection().agent_id;
    sqlx::query("DELETE FROM session_bindings WHERE agent_id = ?1")
        .bind(agent_id.as_str())
        .execute(&store.pool)
        .await
        .unwrap();
    assert!(
        store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    let source = checkout();
    store.prepare_session_checkout(&source).await.unwrap();
    let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    crate::agent_runtime_checkout::adopt_on(&mut transaction, &agent_id, &source)
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let retained = store.agent_runtime_checkout(&agent_id).await.unwrap();
    assert_eq!(
        retained.as_ref().map(|record| &record.binding),
        Some(&source.retained_by_agent(&agent_id)),
        "Agent resource ownership must not require a fabricated runtime selection"
    );
    assert!(
        store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    let mut agent = store.agent(&agent_id).await.unwrap().unwrap();
    agent.display_name = "Renamed before launch".into();
    agent.updated_at_ms += 1;
    store.upsert_agent(&agent).await.unwrap();
    assert_eq!(
        store.agent_runtime_checkout(&agent_id).await.unwrap(),
        retained
    );
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.agent_runtime_checkout(&agent_id).await.unwrap(),
        retained
    );
}

#[tokio::test]
async fn missing_agent_cannot_take_a_checkout_without_publishing_ownership() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let result = crate::agent_runtime_checkout::adopt_on(
        &mut transaction,
        &AgentIdV1::new("absent-agent").unwrap(),
        &source,
    )
    .await;
    transaction.rollback().await.unwrap();
    assert!(matches!(
        result,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
}

#[tokio::test]
async fn native_origin_selects_only_its_exact_transition_target() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let source = native_selection();
    store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let mut plan = intent("native-origin", "native-origin-create");
    plan.target_interaction_profile = AgentInteractionProfileV1::NativeCli;
    plan.target_launch_selection = Some(dure_app::AgentRuntimeLaunchSelectionV1 {
        model: None,
        effort: Some(dure_app::AgentSpawnEffortSelectionV1::parse("high").unwrap()),
        permission_mode: None,
    });
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let AgentRuntimeBindingAuthorityV1::NativeCli { mut authority } = native_authority() else {
        unreachable!()
    };
    authority.binding.session_id = "native-target".into();
    authority.binding.binding_generation = 2;
    authority.binding.bound_at_ms = 130;
    authority.terminal_epoch = "terminal-target".into();
    authority.updated_at_ms = 130;
    let target = AgentRuntimeBindingAuthorityV1::NativeCli { authority };
    publish_runtime_authority(&store, &target).await;
    let started = store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                authority: Box::new(target),
                launch_idempotency_key: Some("native-target-create".into()),
            },
            130,
        ))
        .await
        .unwrap();
    let origin = SessionCheckoutIdentityV1 {
        runtime_namespace: "/runtime/one".into(),
        owner: SessionCheckoutOwnerV1::Managed {
            workspace_id: "workspace-1".into(),
            session_id: "native-target".into(),
            idempotency_key: "native-target-create".into(),
        },
    };
    assert_eq!(
        store
            .agent_runtime_transition_for_native_origin(&source.agent_id, &origin)
            .await
            .unwrap(),
        Some(started)
    );
    assert!(
        store
            .agent_runtime_transition_for_native_origin(
                &AgentIdV1::new("other-agent").unwrap(),
                &origin
            )
            .await
            .unwrap()
            .is_none()
    );
    for owner in [
        SessionCheckoutOwnerV1::Managed {
            workspace_id: "other-workspace".into(),
            session_id: "native-target".into(),
            idempotency_key: "native-target-create".into(),
        },
        SessionCheckoutOwnerV1::Managed {
            workspace_id: "workspace-1".into(),
            session_id: "other-session".into(),
            idempotency_key: "native-target-create".into(),
        },
        SessionCheckoutOwnerV1::Managed {
            workspace_id: "workspace-1".into(),
            session_id: "native-target".into(),
            idempotency_key: "other-create".into(),
        },
    ] {
        let unrelated = SessionCheckoutIdentityV1 {
            owner,
            ..origin.clone()
        };
        assert!(
            store
                .agent_runtime_transition_for_native_origin(&source.agent_id, &unrelated)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn legacy_adoption_is_atomic_and_compares_the_selected_runtime() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selected = native_selection();
    let authority = native_authority();
    store
        .initialize_agent_runtime_selection(&selected)
        .await
        .unwrap();
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let mut stale = selected.clone();
    stale.updated_at_ms += 1;
    assert!(matches!(
        store
            .adopt_agent_runtime_checkout(&stale, &authority, &source)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    let mut stale_authority = authority.clone();
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority: native } = &mut stale_authority
    else {
        unreachable!()
    };
    native.binding.binding_generation += 1;
    assert!(matches!(
        store
            .adopt_agent_runtime_checkout(&selected, &stale_authority, &source)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    sqlx::query(
        "CREATE TRIGGER fail_legacy_adoption BEFORE UPDATE OF checkout_owner_id ON agents \
        BEGIN SELECT RAISE(ABORT, 'fault-injected legacy owner publication'); END",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(
        store
            .adopt_agent_runtime_checkout(&selected, &authority, &source)
            .await
            .is_err()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert!(
        store
            .agent_runtime_checkout(&selected.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_legacy_adoption")
        .execute(&store.pool)
        .await
        .unwrap();
    let adopted = store
        .adopt_agent_runtime_checkout(&selected, &authority, &source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(adopted.binding.claim_id, source.claim_id);
    assert_eq!(
        store
            .adopt_agent_runtime_checkout(&selected, &authority, &source)
            .await
            .unwrap(),
        Some(adopted.clone())
    );
    let other = SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            runtime_namespace: source.identity.runtime_namespace.clone(),
            owner: SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace-1".into(),
                session_id: "different-incarnation".into(),
                idempotency_key: "new-create".into(),
            },
        },
        source.working_directory.clone(),
        None,
    );
    store.prepare_session_checkout(&other).await.unwrap();
    assert!(matches!(
        store
            .adopt_agent_runtime_checkout(&selected, &authority, &other)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. })
    ));
    store
        .begin_session_checkout_close(&adopted.binding.identity)
        .await
        .unwrap();
    store
        .finish_session_checkout_close(&adopted.binding.identity)
        .await
        .unwrap();
    assert_eq!(
        store
            .adopt_agent_runtime_checkout(&selected, &authority, &source)
            .await
            .unwrap()
            .unwrap()
            .admission,
        SessionCheckoutAdmissionV1::Closed
    );
}

async fn adopt(
    store: &SqliteDomainStore,
    checkout: &SessionCheckoutBindingV1,
) -> Result<AgentRuntimeSelectionV1, DomainStoreErrorV1> {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = native_authority() else {
        unreachable!()
    };
    store
        .commit_initial_agent_runtime_native_adoption(
            Some(&authority),
            &authority,
            &native_selection(),
            None,
            "create-worker",
            Some(checkout),
        )
        .await
}

#[tokio::test]
async fn adoption_and_resource_transfer_commit_together_and_reopen() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_checkout_adoption BEFORE UPDATE OF checkout_owner_id ON agents \
         BEGIN SELECT RAISE(ABORT, 'fault-injected owner publication'); END",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    assert!(adopt(&store, &source).await.is_err());
    let agent_id = native_selection().agent_id;
    assert!(
        store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    sqlx::query("DROP TRIGGER fail_checkout_adoption")
        .execute(&store.pool)
        .await
        .unwrap();
    adopt(&store, &source).await.unwrap();
    let adopted = store
        .agent_runtime_checkout(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(adopted.binding.claim_id, source.claim_id);
    assert_eq!(adopted.binding.registration, source.registration);
    assert_eq!(
        adopted.binding.identity.owner,
        SessionCheckoutOwnerV1::Agent {
            agent_id: agent_id.clone(),
            registration_id: source.claim_id.clone(),
        }
    );
    assert_eq!(
        adopted.close_payload,
        Some(serde_json::to_value(&source.identity).unwrap())
    );
    assert!(
        store
            .session_checkout(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(adopt(&store, &source).await.unwrap(), native_selection());
    // Closing the old native owner cannot release the Agent's transferred use.
    assert!(
        store
            .begin_session_checkout_close(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    store
        .finish_session_checkout_close(&source.identity)
        .await
        .unwrap();
    assert_eq!(
        store.agent_runtime_checkout(&agent_id).await.unwrap(),
        Some(adopted.clone())
    );
    store.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened.agent_runtime_checkout(&agent_id).await.unwrap(),
        Some(adopted)
    );
}

#[tokio::test]
async fn structured_transition_preserves_the_adopted_resource_lifetime() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let source = checkout();
    store.prepare_session_checkout(&source).await.unwrap();
    adopt(&store, &source).await.unwrap();
    let selected = store
        .agent_runtime_checkout(&native_selection().agent_id)
        .await
        .unwrap();
    let plan = intent("adopted-to-chat", "switch-adopted-to-chat");
    store.admit_agent_runtime_transition(&plan).await.unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            1,
            AgentRuntimeTransitionAdvanceV1::SourceStopped,
            120,
        ))
        .await
        .unwrap();
    let target = structured_authority();
    publish_runtime_authority(&store, &target).await;
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            2,
            AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(target),
            },
            130,
        ))
        .await
        .unwrap();
    store
        .advance_agent_runtime_transition(&advance(
            &plan.operation_id,
            3,
            AgentRuntimeTransitionAdvanceV1::Committed,
            140,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .agent_runtime_selection(&plan.source.agent_id)
            .await
            .unwrap()
            .unwrap()
            .interaction_profile,
        AgentInteractionProfileV1::StructuredProtocol
    );
    let retained = store
        .agent_runtime_checkout(&plan.source.agent_id)
        .await
        .unwrap();
    assert_eq!(retained, selected);
    assert_eq!(
        retained.unwrap().admission,
        SessionCheckoutAdmissionV1::Open
    );
}

#[tokio::test]
async fn schema_44_preserves_unassociated_selections_without_guessing_claims() {
    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let original = native_selection();
    store
        .initialize_agent_runtime_selection(&original)
        .await
        .unwrap();
    let source = checkout();
    store.prepare_session_checkout(&source).await.unwrap();
    sqlx::query("ALTER TABLE agents DROP COLUMN checkout_owner_id")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 44 WHERE singleton = 1")
        .execute(&store.pool)
        .await
        .unwrap();
    store.close().await;
    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    assert_eq!(
        migrated
            .agent_runtime_selection(&original.agent_id)
            .await
            .unwrap(),
        Some(original.clone())
    );
    assert!(
        migrated
            .agent_runtime_checkout(&original.agent_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        migrated
            .session_checkout(&source.identity)
            .await
            .unwrap()
            .unwrap()
            .binding,
        source
    );
}

async fn downgrade_checkout_owner_to_v45(store: &SqliteDomainStore) {
    // Reconstruct the actual v45 association, not only its version number.
    sqlx::query(crate::agent_runtime_checkout::ADD_CHECKOUT_OWNER)
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_runtime_selections SET checkout_owner_id = \
         (SELECT checkout_owner_id FROM agents WHERE agents.agent_id = agent_runtime_selections.agent_id)",
    ).execute(&store.pool).await.unwrap();
    sqlx::query("ALTER TABLE agents DROP COLUMN checkout_owner_id")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 45 WHERE singleton = 1")
        .execute(&store.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn schema_45_moves_retained_agent_ownership_without_changing_the_resource() {
    for admission in [
        SessionCheckoutAdmissionV1::Open,
        SessionCheckoutAdmissionV1::Closing,
        SessionCheckoutAdmissionV1::Closed,
    ] {
        let root = TempDir::new().unwrap();
        let path = database_path(&root);
        let store = initialized_store(&path).await;
        let source = checkout();
        store.prepare_session_checkout(&source).await.unwrap();
        adopt(&store, &source).await.unwrap();
        let agent_id = native_selection().agent_id;
        let identity = source.retained_by_agent(&agent_id).identity;
        if admission != SessionCheckoutAdmissionV1::Open {
            store.begin_session_checkout_close(&identity).await.unwrap();
        }
        if admission == SessionCheckoutAdmissionV1::Closed {
            store
                .finish_session_checkout_close(&identity)
                .await
                .unwrap();
        }
        let retained = store
            .agent_runtime_checkout(&agent_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retained.admission, admission);
        let binding_json: String = sqlx::query_scalar(
            "SELECT binding_json FROM session_checkout_bindings WHERE owner_id = ?1",
        )
        .bind(identity.owner_id().as_str())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        downgrade_checkout_owner_to_v45(&store).await;
        store.close().await;

        let migrated = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            migrated.schema_info().schema_version,
            CURRENT_STORE_SCHEMA_VERSION
        );
        assert_eq!(
            migrated.agent_runtime_checkout(&agent_id).await.unwrap(),
            Some(retained.clone())
        );
        assert_eq!(
            migrated.agent_runtime_selection(&agent_id).await.unwrap(),
            Some(native_selection())
        );
        let migrated_json: String = sqlx::query_scalar(
            "SELECT binding_json FROM session_checkout_bindings WHERE owner_id = ?1",
        )
        .bind(identity.owner_id().as_str())
        .fetch_one(&migrated.pool)
        .await
        .unwrap();
        assert_eq!(migrated_json, binding_json);
        let old_writer_columns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('agent_runtime_selections') WHERE name = 'checkout_owner_id'",
        ).fetch_one(&migrated.pool).await.unwrap();
        assert_eq!(
            old_writer_columns, 0,
            "the old association must not remain a second authority"
        );
        let violations = sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&migrated.pool)
            .await
            .unwrap();
        assert!(violations.is_empty());
        migrated.close().await;
        let reopened = SqliteDomainStore::open(&path).await.unwrap();
        assert_eq!(
            reopened.agent_runtime_checkout(&agent_id).await.unwrap(),
            Some(retained)
        );
    }
}

#[tokio::test]
async fn schema_45_owner_transfer_rolls_back_and_resumes_after_publication_failure() {
    use sqlx::{Connection, Row, SqliteConnection};

    let root = TempDir::new().unwrap();
    let path = database_path(&root);
    let store = initialized_store(&path).await;
    let source = checkout();
    store.prepare_session_checkout(&source).await.unwrap();
    adopt(&store, &source).await.unwrap();
    let agent_id = native_selection().agent_id;
    let retained = store
        .agent_runtime_checkout(&agent_id)
        .await
        .unwrap()
        .unwrap();
    downgrade_checkout_owner_to_v45(&store).await;
    // SQLite permits UPDATE OF a future column; the migration's owner copy
    // then fails after ADD COLUMN, before it can discard the original link.
    sqlx::query(
        "CREATE TRIGGER fail_migration_owner BEFORE UPDATE OF checkout_owner_id ON agents \
         BEGIN SELECT RAISE(ABORT, 'fault-injected migration owner publication'); END",
    )
    .execute(&store.pool)
    .await
    .unwrap();
    store.close().await;
    assert!(SqliteDomainStore::open(&path).await.is_err());
    let mut connection =
        SqliteConnection::connect_with(&crate::schema::writable_connect_options(&path))
            .await
            .unwrap();
    let metadata = sqlx::query(
        "SELECT schema_version, migration_to_version, migration_backup_path FROM store_metadata",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(metadata.get::<i64, _>("schema_version"), 45);
    assert_eq!(metadata.get::<i64, _>("migration_to_version"), 46);
    let backup: String = metadata.get("migration_backup_path");
    assert!(std::path::Path::new(&backup).is_file());
    let new_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('agents') WHERE name = 'checkout_owner_id'",
    )
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(new_columns, 0, "partial owner schema must roll back");
    let old_owner: String = sqlx::query_scalar(
        "SELECT checkout_owner_id FROM agent_runtime_selections WHERE agent_id = ?1",
    )
    .bind(agent_id.as_str())
    .fetch_one(&mut connection)
    .await
    .unwrap();
    assert_eq!(old_owner, retained.binding.identity.owner_id().as_str());
    sqlx::query("DROP TRIGGER fail_migration_owner")
        .execute(&mut connection)
        .await
        .unwrap();
    connection.close().await.unwrap();
    let recovered = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        recovered.agent_runtime_checkout(&agent_id).await.unwrap(),
        Some(retained)
    );
    assert_eq!(
        recovered.agent_runtime_selection(&agent_id).await.unwrap(),
        Some(native_selection())
    );
}
