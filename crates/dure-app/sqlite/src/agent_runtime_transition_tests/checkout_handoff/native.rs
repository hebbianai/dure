use super::*;
use dure_app::{
    AgentRuntimeCloseIntentV1, AgentRuntimeRemovalPlanV1, SessionCheckoutRecordV1,
    WorkflowSessionGenerationV1,
};

impl SqliteDomainStore {
    // SQLite fixtures acknowledge their non-Git claims explicitly. Runtime
    // callers instead keep this admission through the real Git claim operation.
    async fn adopt_agent_native_checkout(
        &self,
        session: &WorkflowSessionGenerationV1,
        kind: &RuntimeKindIdV1,
        source: &SessionCheckoutBindingV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let Some(admission) = self
            .admit_agent_native_checkout(session, kind, source)
            .await?
        else {
            return Ok(None);
        };
        let identity = admission.binding().identity.clone();
        admission.finish().await?;
        self.session_checkout(&identity).await
    }
}

fn session() -> WorkflowSessionGenerationV1 {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = native_authority() else {
        unreachable!()
    };
    WorkflowSessionGenerationV1::from_checkpoint_authority(
        &authority,
        &native_selection().provider_id,
    )
}

fn runtime_kind() -> RuntimeKindIdV1 {
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = native_authority() else {
        unreachable!()
    };
    authority.binding.runtime_kind_id
}

async fn retained_predecessor(store: &SqliteDomainStore) -> SessionCheckoutRecordV1 {
    store
        .initialize_agent_runtime_selection(&native_selection())
        .await
        .unwrap();
    let predecessor = SessionCheckoutBindingV1::new(
        SessionCheckoutIdentityV1 {
            owner: SessionCheckoutOwnerV1::Managed {
                workspace_id: "workspace-1".into(),
                session_id: "old-session".into(),
                idempotency_key: "old-create".into(),
            },
            ..checkout().identity
        },
        checkout().working_directory,
        None,
    );
    store.prepare_session_checkout(&predecessor).await.unwrap();
    store
        .adopt_agent_runtime_checkout(&native_selection(), &native_authority(), &predecessor)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn mixed_version_native_admission_retains_the_existing_agent_incarnation() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let retained = retained_predecessor(&store).await;
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    let result = store
        .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
        .await;
    assert_eq!(result.unwrap(), Some(retained.clone()));
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    assert_eq!(
        store
            .agent_checkout_for_root(&source.identity)
            .await
            .unwrap(),
        Some(retained.binding.clone())
    );
    assert_eq!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .unwrap(),
        Some(retained)
    );
    store.close().await;
}

#[tokio::test]
async fn mixed_version_native_admission_rejects_changed_resources_and_closed_claims() {
    for scenario in 0..6 {
        let root = TempDir::new().unwrap();
        let store = initialized_store(&database_path(&root)).await;
        let retained = retained_predecessor(&store).await;
        let mut source = checkout();
        match scenario {
            0 => source.working_directory.push_str("/other"),
            1 => {
                source.identity.runtime_namespace.push_str("-other");
                source.claim_id = source.identity.owner_id();
            }
            5 => {
                source.registration = Some(dure_app::GitCheckoutRegistrationV1 {
                    repository_path: "/workspace".into(),
                    instance: dure_app::GitCheckoutInstanceV1 {
                        schema_version: 1,
                        canonical_path: source.working_directory.clone(),
                        git_common_dir: "/workspace/.git".into(),
                        git_dir: "/workspace/.git/worktrees/project".into(),
                        instance_token: "different-incarnation".into(),
                    },
                })
            }
            _ => {}
        }
        store.prepare_session_checkout(&source).await.unwrap();
        if scenario == 2 {
            store
                .begin_session_checkout_close(&retained.binding.identity)
                .await
                .unwrap();
        } else if scenario == 3 {
            store
                .begin_session_checkout_close(&source.identity)
                .await
                .unwrap();
        } else if scenario == 4 {
            source.working_directory.push_str("/forged");
        }
        let result = store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await;
        assert!(result.is_err(), "scenario {scenario}: {result:?}");
        assert!(
            store
                .agent_checkout_for_root(&source.identity)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .agent_runtime_checkout(&native_selection().agent_id)
                .await
                .unwrap()
                .unwrap()
                .binding,
            retained.binding
        );
        store.close().await;
    }
}

#[tokio::test]
async fn mixed_version_native_membership_waits_for_claim_acknowledgement_and_removal_admission() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let retained = retained_predecessor(&store).await;
    let source = checkout();
    store.prepare_session_checkout(&source).await.unwrap();
    let admission = store
        .admit_agent_native_checkout(&session(), &runtime_kind(), &source)
        .await
        .unwrap()
        .unwrap();
    assert!(!admission.retained());
    drop(admission);
    assert!(
        store
            .agent_checkout_for_root(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("CREATE TRIGGER fail_native_root BEFORE INSERT ON agent_checkout_roots BEGIN SELECT RAISE(ABORT, 'fault-injected root acknowledgement'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert!(
        store
            .agent_checkout_for_root(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DROP TRIGGER fail_native_root")
        .execute(&store.pool)
        .await
        .unwrap();
    let intent = AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("remove-mixed-version").unwrap(),
        idempotency_key: "remove-mixed-version".into(),
        source: native_selection(),
        source_authority: native_authority(),
        stopped_transition: None,
        requested_at_ms: 200,
    };
    store
        .admit_agent_runtime_removal(
            &intent,
            &AgentRuntimeRemovalPlanV1 {
                checkout: Some(retained.binding.clone()),
                managed_roots: vec![source.identity.clone()],
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .agent_runtime_checkout(&native_selection().agent_id)
            .await
            .unwrap(),
        Some(retained)
    );
    assert!(
        store
            .agent_checkout_for_root(&source.identity)
            .await
            .unwrap()
            .is_none()
    );
    store.close().await;
}

#[tokio::test]
async fn native_adoption_preserves_the_selected_credential_contract() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selected = AgentRuntimeSelectionV1 {
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        ..native_selection()
    };
    store
        .initialize_agent_runtime_selection(&selected)
        .await
        .unwrap();
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    store.close().await;
}

#[tokio::test]
async fn exact_native_adoption_requires_the_full_fence_and_selected_provider() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selected = native_selection();
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .unwrap()
            .is_none()
    );
    store
        .initialize_agent_runtime_selection(&selected)
        .await
        .unwrap();
    for field in 0..7 {
        let mut stale = session();
        let value = match field {
            0 => &mut stale.session_id,
            1 => &mut stale.workspace_id,
            2 => &mut stale.runner_principal,
            3 => &mut stale.runner_instance,
            4 => &mut stale.channel_epoch,
            5 => &mut stale.host_instance_id,
            _ => &mut stale.terminal_epoch,
        };
        value.push_str("-stale");
        assert!(
            store
                .adopt_agent_native_checkout(&stale, &runtime_kind(), &source)
                .await
                .unwrap()
                .is_none()
        );
    }
    let mut foreign = session();
    foreign.provider_id = ProviderIdV1::new("another-provider").unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&foreign, &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    let adopted = store
        .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(adopted.binding.claim_id, source.claim_id);
    assert_eq!(
        adopted.binding,
        source.retained_by_agent(&selected.agent_id)
    );
    assert_eq!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .unwrap(),
        Some(adopted)
    );
    store.close().await;
}

#[tokio::test]
async fn native_adoption_rolls_back_publication_and_cannot_cross_removal() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selected = native_selection();
    store
        .initialize_agent_runtime_selection(&selected)
        .await
        .unwrap();
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_native_adoption BEFORE UPDATE OF checkout_owner_id ON agents BEGIN SELECT RAISE(ABORT, 'fault-injected native owner publication'); END")
        .execute(&store.pool).await.unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
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
    sqlx::query("DROP TRIGGER fail_native_adoption")
        .execute(&store.pool)
        .await
        .unwrap();
    let intent = AgentRuntimeCloseIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("remove-legacy").unwrap(),
        idempotency_key: "remove-legacy".into(),
        source: selected.clone(),
        source_authority: native_authority(),
        stopped_transition: None,
        requested_at_ms: 200,
    };
    store
        .admit_agent_runtime_removal(
            &intent,
            &AgentRuntimeRemovalPlanV1 {
                checkout: Some(source.clone()),
                managed_roots: vec![source.identity.clone()],
            },
        )
        .await
        .unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert_eq!(
        store
            .agent_runtime_checkout(&selected.agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .claim_id,
        source.claim_id
    );
    store.close().await;
}

#[tokio::test]
async fn ambiguous_exact_native_ownership_cannot_adopt_a_claim() {
    let root = TempDir::new().unwrap();
    let store = initialized_store(&database_path(&root)).await;
    let selected = native_selection();
    store
        .initialize_agent_runtime_selection(&selected)
        .await
        .unwrap();
    let source = checkout();
    let original = store.prepare_session_checkout(&source).await.unwrap();
    // Model historical/corrupt storage. The normal binding writer already
    // rejects a second Agent claiming the same exact runtime generation.
    let mut other = store.agent(&selected.agent_id).await.unwrap().unwrap();
    other.agent_id = AgentIdV1::new("ambiguous-agent").unwrap();
    store.upsert_agent(&other).await.unwrap();
    sqlx::query("INSERT INTO session_bindings SELECT ?1, runtime_kind_id, session_id, provider_conversation_id, credential_reference_id, binding_generation, bound_at_ms FROM session_bindings WHERE agent_id = ?2")
        .bind(other.agent_id.as_str()).bind(selected.agent_id.as_str()).execute(&store.pool).await.unwrap();
    sqlx::query("INSERT INTO agent_checkpoint_binding_authorities SELECT ?1, schema_version, session_id, runtime_workspace_id, runner_principal, runner_instance, channel_epoch, host_instance_id, terminal_epoch, binding_generation, updated_at_ms FROM agent_checkpoint_binding_authorities WHERE agent_id = ?2")
        .bind(other.agent_id.as_str()).bind(selected.agent_id.as_str()).execute(&store.pool).await.unwrap();
    assert!(
        store
            .adopt_agent_native_checkout(&session(), &runtime_kind(), &source)
            .await
            .is_err()
    );
    assert_eq!(
        store.session_checkout(&source.identity).await.unwrap(),
        Some(original)
    );
    store.close().await;
}
