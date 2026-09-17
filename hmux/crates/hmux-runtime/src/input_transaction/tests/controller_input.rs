use super::*;

#[test]
fn accepted_submit_does_not_invent_provider_activity() {
    for input in [b"/resume\r".as_slice(), b"\r", b"continue\r"] {
        let mut host = ready_host(false);
        let before = host
            .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
            .unwrap();
        let transaction = apply_input_transaction(
            &mut host,
            &fence(),
            &mut SubmitScanner::default(),
            PtyInput::Bytes(input),
            ControllerInputEffect::DraftCapable,
            InputAdmission::Ordinary,
            |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
        )
        .unwrap();
        assert_eq!(transaction.outcome, InputTransactionOutcome::Written);
        let after = host
            .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
            .unwrap();
        assert_eq!(
            after.agent_runtime_state, before.agent_runtime_state,
            "a PTY submit is not evidence that a provider turn started"
        );
        assert_eq!(
            after.provider_conversation_identity,
            before.provider_conversation_identity
        );
        let waiting = before.agent_runtime_state.unwrap();
        assert!(
            !host
                .matches_agent_runtime_quiescence(
                    &fence(),
                    &hmux_host::local_protocol::ManagedProviderStopQuiescenceFence {
                        terminal_epoch: waiting.terminal_epoch,
                        runtime_revision: waiting.revision,
                        observed_through_output_seq: waiting.observed_through_output_seq,
                    },
                )
                .unwrap(),
            "unchanged Waiting does not authorize replacement of pending input"
        );
    }
}

#[test]
fn provider_without_semantic_reports_keeps_its_bounded_input_estimate() {
    let mut host = host(false);
    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle),
    )
    .unwrap();
    let transaction = apply_input_transaction(
        &mut host,
        &fence(),
        &mut SubmitScanner::default(),
        PtyInput::Bytes(b"run\r"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
        |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
    )
    .unwrap();
    let working = transaction.runtime_state.unwrap();
    assert_eq!(working.activity, AgentRuntimeActivity::Working);
    assert_eq!(working.source, AgentRuntimeStateSource::ControllerInput);
    let expired = host
        .expire_agent_runtime_state(
            &fence(),
            std::time::Instant::now() + Duration::from_secs(31),
        )
        .unwrap()
        .unwrap();
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
}

#[test]
fn existing_conversation_written_submit_commits_then_rearms_one_idle_turn() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = existing_prompt(b"continue", "conversation-1");
    let writes = std::cell::Cell::new(0);

    let apply = |host: &mut SessionHost, scanner: &mut SubmitScanner| {
        apply_input_transaction(
            host,
            &fence(),
            scanner,
            PtyInput::Structured(&input),
            ControllerInputEffect::DraftCapable,
            admission(&input),
            |bytes| {
                writes.set(writes.get() + 1);
                PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
            },
        )
        .unwrap()
    };

    let first = apply(&mut host, &mut scanner);
    assert_eq!(first.outcome, InputTransactionOutcome::Written);
    let admitted_revision = first
        .admitted_agent_runtime_revision
        .expect("written prompt keeps its pre-write waiting revision");
    assert!(first.runtime_state.is_none());
    let waiting = host
        .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(waiting.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(waiting.source, AgentRuntimeStateSource::ProviderEvent);
    assert_eq!(waiting.revision, admitted_revision);

    let repeated = apply(&mut host, &mut scanner);
    assert_eq!(
        repeated.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert_eq!(writes.get(), 1);

    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();
    let next_turn = apply(&mut host, &mut scanner);
    assert_eq!(next_turn.outcome, InputTransactionOutcome::Written);
    assert_eq!(writes.get(), 2);
}

#[test]
fn ordinary_partial_write_consumes_fresh_prompt_authority() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let ordinary = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Bytes(b"run\rtrailing"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
        |bytes| {
            PtyWriteOutcome::from_progress(
                bytes.len(),
                4,
                Err(OperationReceiptReason::PtyWriteFailed),
            )
        },
    )
    .unwrap();
    assert_eq!(
        ordinary.outcome,
        InputTransactionOutcome::Failed(OperationReceiptReason::PtyWriteFailed)
    );
    assert!(ordinary.runtime_state.is_none());
    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();

    let initial = fresh_prompt(b"must not write");
    let refused = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&initial),
        ControllerInputEffect::DraftCapable,
        admission(&initial),
        |_| panic!("prior ordinary input must refuse before the writer"),
    )
    .unwrap();
    assert_eq!(
        refused.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
}
