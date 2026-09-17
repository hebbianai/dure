use super::*;
use hmux_client::StandaloneSessionCreator;
use hmux_client::recovery_journal::RECOVERY_COMPLETION_ACKNOWLEDGED_CODE;

#[tokio::test]
#[ignore = "requires DURE_QA_HMUX_RUNTIME and the isolated Hmux process guardian"]
async fn terminal_creation_refusal_releases_its_checkout_and_never_launches_on_replay() {
    let fixture = Fixture::new().await;
    let blocker = fixture.blocker();
    let first = fixture.create_result().await.unwrap_err();
    assert!(
        first
            .to_string()
            .contains("hmux_standalone_recovery_name_conflict")
    );
    let after_refusal = (fixture.claims(), fixture.removal("after-refusal"));
    fixture.retire_blocker(blocker);
    fixture.runtime.store.close().await;
    let store = SqliteDomainStore::open(&fixture.database).await.unwrap();
    let reopened = CheckoutSessionRuntime::at_root(
        store.clone(),
        fixture.executable.clone(),
        fixture.discovery.clone(),
    )
    .unwrap();
    let replay = reopened
        .create_standalone(
            OperationIdV1::new("ordinary-create").unwrap(),
            fixture.request(),
        )
        .await;
    let replay_error = match replay {
        Err(error) => Some(error.to_string()),
        Ok(created) => {
            let descriptor = created.session().descriptor();
            crate::close_standalone_session(
                store.clone(),
                LocalSessionCatalog::new(&fixture.discovery),
                descriptor.workspace_id.clone(),
                descriptor.session_id.clone(),
                Some(descriptor.terminal_epoch.clone()),
                Duration::from_secs(3),
            )
            .await
            .unwrap();
            None
        }
    };
    store.close().await;
    assert_eq!(after_refusal, (0, Ok(())));
    assert!(
        replay_error.is_some_and(|error| error.contains(RECOVERY_COMPLETION_ACKNOWLEDGED_CODE)),
        "the same refused creation must not launch when the conflicting session is gone"
    );
}

impl Fixture {
    pub(super) fn blocker(&self) -> CreatedStandaloneSession {
        StandaloneSessionCreator::new(&self.executable)
            .with_discovery_root(&self.discovery)
            .create(
                StandaloneCreateRequest::new(
                    self.checkout.parent().unwrap(),
                    Some("checkout-cleanup".into()),
                    vec![
                        "/bin/sh".into(),
                        "-c".into(),
                        "while IFS= read -r line; do :; done".into(),
                    ],
                    24,
                    80,
                )
                .unwrap()
                .with_recovery_identity(
                    StandaloneRecoveryCreateIdentity::new("standalone_blocker", "blocker-proof")
                        .unwrap()
                        .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound),
                )
                .unwrap(),
            )
            .unwrap()
    }

    pub(super) fn retire_blocker(&self, blocker: CreatedStandaloneSession) {
        let target = CompletedStandaloneTarget::from_created(
            blocker.receipt().clone(),
            blocker.session().descriptor(),
        )
        .unwrap();
        assert_eq!(
            LocalSessionCatalog::new(&self.discovery).retire_completed_standalone_target(
                target.generation(),
                target.provider_process(),
                Duration::from_secs(3),
            ),
            CompletedStandaloneTargetLifecycle::Retired
        );
    }
    async fn create_result(&self) -> Result<CreatedStandaloneSession, SessionCheckoutError> {
        self.runtime
            .create_standalone(
                OperationIdV1::new("ordinary-create").unwrap(),
                self.request(),
            )
            .await
    }
}
