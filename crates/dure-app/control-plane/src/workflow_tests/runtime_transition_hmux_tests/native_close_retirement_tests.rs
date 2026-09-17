use super::*;
use hmux_client::recovery_journal::managed_create_ledger::ManagedSessionRetirementObservation;
use hmux_client::{
    ExitedSessionRetirementMode, ExitedSessionRetirementOutcome, ExitedSessionRetirementReason,
    ExitedSessionRetirementTarget, LocalSessionCatalog, SessionSelector,
};

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn native_removal_reuses_retirement_after_discovery_cleanup() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    fs::write(
        root.path().join("codex-fixture"),
        "#!/bin/sh\nexec sleep 120\n",
    )
    .unwrap();
    let hmux = RealHmux::install(root, &mut state);
    let agent_id = AgentIdV1::new("retired-before-remove-agent").unwrap();
    let source = launch_conversation(&state, &hmux, "retired-before-remove-source", None).await;
    bind_source_conversation(&state, &agent_id, &source, None).await;
    hmux.stop(&source);

    let catalog = LocalSessionCatalog::new(&hmux.discovery);
    let retirement = catalog
        .read_managed_session_retirement(&source.session_id, &source.workspace_id)
        .unwrap();
    let ManagedSessionRetirementObservation::Finalized { receipt } = &retirement else {
        panic!("the earlier real stop must finalize retirement: {retirement:?}");
    };
    assert_eq!(receipt.stop_id(), format!("qa-stop-{}", source.session_id));

    // Wait for the exact stopped Host to release its lifetime fence, then use
    // the product retirement owner to archive this disposable generation.
    let target = ExitedSessionRetirementTarget::new(
        &source.workspace_id,
        &source.session_id,
        Some(source.terminal_epoch.clone()),
    );
    let preview = catalog
        .retire_exited_sessions(vec![target.clone()], ExitedSessionRetirementMode::Preview)
        .unwrap();
    assert_eq!(preview.retirable, 1, "{preview:?}");
    let target = target.with_generation(preview.results[0].generation.clone().unwrap());
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let retired = catalog
                .retire_exited_sessions(vec![target.clone()], ExitedSessionRetirementMode::Apply)
                .unwrap();
            if retired.retired == 1 {
                break;
            }
            let result = &retired.results[0];
            assert_eq!(
                result.outcome,
                ExitedSessionRetirementOutcome::Skipped,
                "{retired:?}"
            );
            assert_eq!(
                result.reason,
                Some(ExitedSessionRetirementReason::LifetimeBusy),
                "{retired:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the exact stopped fixture Host must become retirable");
    let missing = catalog
        .find(&SessionSelector::new(
            &source.session_id,
            Some(source.workspace_id.clone()),
        ))
        .unwrap_err();
    assert_eq!(missing.code(), "hmux_session_not_found");
    assert_eq!(
        catalog
            .read_managed_session_retirement(&source.session_id, &source.workspace_id)
            .unwrap(),
        retirement
    );

    // Retirement needs no second provider stop, but logical-chain closure
    // still requires its broker. A transport failure must retain that final
    // cleanup for same-operation retry, not fabricate completed removal.
    let runtime = std::mem::replace(
        &mut state.hmux_identity.runtime_executable_path,
        hmux.root.join("unavailable-old-runtime"),
    );
    let body = agent_runtime_close_apply::AgentRuntimeStopBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
    };
    let unavailable =
        agent_runtime_remove_apply::apply(&state, "remove-retired-generation", body.clone())
            .await
            .unwrap_err();
    assert_eq!(unavailable.code, "agent_runtime_remove_failed");
    assert_eq!(
        unavailable.disposition,
        BackendFailureDispositionV1::RetrySame
    );
    let stopped = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopped.state, AgentRuntimeCloseStateV1::Stopped);
    assert!(
        state
            .store
            .agent_runtime_removal(&stopped.intent.operation_id)
            .await
            .unwrap()
            .unwrap()
            .completed_at_ms
            .is_none()
    );

    state.hmux_identity.runtime_executable_path = runtime;
    let removed =
        agent_runtime_remove_apply::apply(&state, "remove-retired-generation", body.clone()).await;
    assert!(
        removed.is_ok(),
        "removal must reuse exact permanent exit evidence: {removed:?}"
    );
    assert_eq!(
        agent_runtime_remove_apply::apply(&state, "remove-retired-generation", body)
            .await
            .unwrap(),
        removed.unwrap()
    );
    let close = state
        .store
        .effective_agent_runtime_close(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(close.state, AgentRuntimeCloseStateV1::Stopped);
    assert!(
        state
            .store
            .agent_runtime_removal(&close.intent.operation_id)
            .await
            .unwrap()
            .unwrap()
            .completed_at_ms
            .is_some()
    );
    assert_eq!(
        hmux.requests().len(),
        1,
        "removal replay must not launch a successor"
    );
}
