use super::*;

/// The report a Claude Code PreToolUse hook sends: the turn is working, under
/// the protocol-maximum lease that only a later hook report ends.
fn turn_working() -> AgentStateReport {
    AgentStateReport {
        progress: None,
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Working,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
        conversation_identity: None,
        expected_observation: None,
        background_work: false,
    }
}

/// A person interrupts a reported working turn with Escape. Claude Code runs
/// no hook for that, so the Host would keep refusing the inbox wake until the
/// lease expired. The Escape admits the wake while the quiescent stop that an
/// idle switch or replacement needs stays refused, and the wake's own submit
/// ends the request.
#[test]
fn escape_during_a_reported_working_turn_admits_the_inbox_wake() {
    // The provider's `read` keeps the Escape byte at the front of the next
    // line; drop it so the consumed marker stays readable on the screen.
    let fixture = UnixAgentPromptFixture::with_provider_script(
        "interrupt-request",
        "stty -echo; while IFS= read -r prompt; do prompt=$(printf '%s' \"$prompt\" | tr -d '\\033'); printf '%s\\n' \"$prompt\" >> \"$1\"; printf 'AGENT_PROMPT_CONSUMED:%s\\r\\n' \"$prompt\"; done",
    );
    let conversation_id = "conversation-interrupt";
    fixture.report_waiting(conversation_id);
    let descriptor = fixture.created.session().descriptor();
    let working = ManagedAgentStateReporter::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .report_agent_state(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
            turn_working(),
        )
        .unwrap();
    assert_eq!(working, AgentStateReportOutcome::Applied);

    let expected = ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap();
    let mut agent = fixture.surface();
    let refused = agent
        .send_existing_idle_agent_prompt_confirmed(
            "inbox wake".into(),
            &expected,
            Duration::from_millis(300),
        )
        .expect_err("a reported working turn refuses the wake");
    assert_eq!(refused.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(refused.delivery_state(), "not_written");
    agent.detach().unwrap();

    let connection = fixture
        .created
        .session()
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .unwrap();
    let mut person = TerminalSurfaceAttachment::from_connection(connection).unwrap();
    let receipt = person
        .send_key_confirmed(
            "Escape".into(),
            "Escape".into(),
            0,
            false,
            Duration::from_secs(3),
        )
        .unwrap();
    assert!(matches!(
        receipt.outcome,
        Some(terminal_state_protocol::input_receipt::Outcome::WrittenToPty(_))
    ));
    person.detach().unwrap();

    // The pane stays busy: the projection is still the provider's working
    // lease, and the quiescent stop an idle switch needs is refused.
    let snapshot = super::background_work::observe(&fixture.discovery_root, descriptor);
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(runtime.activity, hmux_client::AgentRuntimeActivity::Working);
    assert!(!runtime.background_work);
    assert_eq!(snapshot.semantic_idle_ms, None);
    let refused_stop = ManagedSessionStopper::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .stop(
            exact_managed_stop_request("interrupt-request-idle-stop", descriptor)
                .with_expected_quiescence(
                    ManagedStopQuiescenceFence::new(
                        runtime.terminal_epoch.clone(),
                        runtime.revision.parse().unwrap(),
                        snapshot.sequence_through.parse().unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
        )
        .unwrap_err();
    assert_eq!(refused_stop.code(), "hmux_managed_stop_refused");

    let mut agent = fixture.surface();
    let delivered = agent
        .send_existing_idle_agent_prompt_confirmed(
            "inbox wake".into(),
            &expected,
            Duration::from_secs(3),
        )
        .expect("an interrupted turn must admit the wake");
    assert!(delivered.admitted_agent_runtime_revision().is_some());
    agent.detach().unwrap();
    wait_for_screen_text(
        fixture.created.session(),
        &["AGENT_PROMPT_CONSUMED:inbox wake"],
    );
    let received = fs::read_to_string(&fixture.received_prompt).unwrap();
    assert_eq!(received.lines().collect::<Vec<_>>(), ["inbox wake"]);

    // The wake's submit started a turn with its own reports; until one
    // arrives, the next wake waits again.
    let mut agent = fixture.surface();
    let refused = agent
        .send_existing_idle_agent_prompt_confirmed(
            "second wake".into(),
            &expected,
            Duration::from_millis(300),
        )
        .expect_err("the new turn must wait for its provider acknowledgement");
    assert_eq!(refused.code(), "hmux_agent_prompt_runtime_changed");
    assert_eq!(refused.delivery_state(), "not_written");
    agent.detach().unwrap();

    fixture.stop("interrupt-request");
}
