use super::*;

#[derive(Clone, Copy, Debug)]
enum ObservationFault {
    Timeout,
    Unavailable,
    RuntimeChanged,
    Malformed,
    StaleSession,
    Exited,
}

async fn assert_context_observation(fault: ObservationFault) {
    for method in ["dispatch.context.get", "dispatch.context.get.exact-session"] {
        let (_root, mut state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
        let body = existing_session_run_body();
        let session = serde_json::from_value(body["session"].clone()).unwrap();
        verify_exact_orchestration_session(&state, &session)
            .await
            .unwrap();
        let executable = state.hmux_identity.executable_path.clone();
        let original = fs::read_to_string(&executable).unwrap();
        let descriptor = state
            .hmux_identity
            .discovery_root
            .join("current-session.json");
        let (code, reason, disposition) = match fault {
            ObservationFault::Timeout => {
                fs::write(
                    &executable,
                    format!(
                        "#!/bin/sh\nexec /bin/sleep {}\n",
                        HMUX_QUERY_TIMEOUT.as_secs() + 30
                    ),
                )
                .unwrap();
                (
                    "orchestration_session_unavailable",
                    "hmux_descriptor_timeout",
                    BackendFailureDispositionV1::RetrySame,
                )
            }
            ObservationFault::Unavailable => {
                fs::write(&executable, "#!/bin/sh\nexit 1\n").unwrap();
                (
                    "orchestration_session_unavailable",
                    "hmux_descriptor_unavailable",
                    BackendFailureDispositionV1::RetrySame,
                )
            }
            ObservationFault::RuntimeChanged => {
                fs::write(
                    &executable,
                    format!("{original}\n# runtime replaced after backend startup\n"),
                )
                .unwrap();
                (
                    "orchestration_session_unavailable",
                    "hmux_runtime_identity_changed",
                    BackendFailureDispositionV1::RetrySame,
                )
            }
            ObservationFault::Malformed => {
                fs::write(&descriptor, b"{").unwrap();
                (
                    "orchestration_session_unavailable",
                    "hmux_descriptor_malformed",
                    BackendFailureDispositionV1::RetrySame,
                )
            }
            ObservationFault::Exited => {
                // The exact generation's retained tombstone: a process started
                // before a restart or account switch still carries this fence.
                let session = &body["session"];
                fs::write(
                    &descriptor,
                    serde_json::to_vec(&json!({
                        "schema_version": 1,
                        "session_id": session["sessionId"],
                        "workspace_id": session["workspaceId"],
                        "session_class": "managed",
                        "lifecycle": "exited",
                        "provider_id": session["providerId"],
                        "runner_principal": session["runnerPrincipal"],
                        "runner_instance": session["runnerInstance"],
                        "channel_epoch": session["channelEpoch"],
                        "host_instance_id": session["hostInstanceId"],
                        "terminal_epoch": session["terminalEpoch"],
                        "output_seq": "7",
                        "health": "exited",
                    }))
                    .unwrap(),
                )
                .unwrap();
                (
                    "orchestration_generation_conflict",
                    "hmux_session_exited",
                    if method.ends_with("exact-session") {
                        BackendFailureDispositionV1::Terminal
                    } else {
                        BackendFailureDispositionV1::StaleGeneration
                    },
                )
            }
            ObservationFault::StaleSession => {
                let mut stale = body["session"].clone();
                stale["terminalEpoch"] = json!("old-terminal");
                // The live descriptor stays healthy while the caller is stale.
                let error = dispatch(
                    &state,
                    &orchestration_backend_request(
                        &state,
                        "stale-context",
                        method,
                        json!({"schemaVersion": 1, "session": stale}),
                    ),
                )
                .await
                .unwrap_err();
                assert_eq!(error.code, "orchestration_generation_conflict");
                assert_eq!(
                    error.details.as_ref().unwrap()["reasonCode"],
                    "hmux_descriptor_mismatch"
                );
                assert_eq!(
                    error.disposition,
                    if method.ends_with("exact-session") {
                        BackendFailureDispositionV1::Terminal
                    } else {
                        BackendFailureDispositionV1::StaleGeneration
                    }
                );
                continue;
            }
        };
        if !matches!(fault, ObservationFault::RuntimeChanged) {
            state.hmux_identity = resolve_hmux_toolchain_identity(
                &executable,
                &state.hmux_identity.runtime_executable_path,
                &state.hmux_identity.discovery_root,
            )
            .unwrap();
        }
        let request = orchestration_backend_request(
            &state,
            "context-observation",
            method,
            json!({"schemaVersion": 1, "session": session}),
        );
        let error = dispatch(&state, &request).await.unwrap_err();
        assert_eq!(error.code, code, "{fault:?}: {method}");
        assert_eq!(error.disposition, disposition, "{fault:?}: {method}");
        assert_eq!(error.details.as_ref().unwrap()["reasonCode"], reason);
        assert!(!error.message.contains("service rejected"));
        assert!(launcher.requests().is_empty());
        assert!(
            state
                .store
                .inspect_orchestration_dispatch_session(&session)
                .await
                .unwrap()
                .target
                .is_none()
        );

        fs::write(&executable, original).unwrap();
        if descriptor.exists() {
            fs::remove_file(&descriptor).unwrap();
        }
        state.hmux_identity = resolve_hmux_toolchain_identity(
            &executable,
            &state.hmux_identity.runtime_executable_path,
            &state.hmux_identity.discovery_root,
        )
        .unwrap();
        verify_exact_orchestration_session(&state, &session)
            .await
            .unwrap();
        let created = invoke_orchestration(
            &state,
            "enroll-after-observation-recovers",
            "run.create",
            body,
        )
        .await;
        let context = dispatch(&state, &request).await.unwrap();
        assert_eq!(
            context["receipt"]["target"],
            created["receipt"]["context"]["target"]
        );
        assert!(launcher.requests().is_empty());
    }
}

#[tokio::test]
async fn orchestration_observation_timeout_is_retryable() {
    assert_context_observation(ObservationFault::Timeout).await;
}

#[tokio::test]
async fn orchestration_observation_unavailable_is_retryable() {
    assert_context_observation(ObservationFault::Unavailable).await;
}

#[tokio::test]
async fn orchestration_observation_runtime_change_is_not_a_stale_session() {
    assert_context_observation(ObservationFault::RuntimeChanged).await;
}

#[tokio::test]
async fn orchestration_observation_malformed_is_not_a_stale_session() {
    assert_context_observation(ObservationFault::Malformed).await;
}

#[tokio::test]
async fn orchestration_observation_of_an_exited_generation_is_stale_not_retryable() {
    assert_context_observation(ObservationFault::Exited).await;
}

#[tokio::test]
async fn orchestration_observation_stale_session_remains_fenced() {
    assert_context_observation(ObservationFault::StaleSession).await;
}

/// The enrollment body for a Session that Hmux observes live and no Agent
/// binds as its current Session.
async fn live_unbound_session(state: &ServiceState) -> (Value, WorkflowSessionGenerationV1) {
    let mut body = existing_session_run_body();
    body["session"]["sessionId"] = json!("unbound-session");
    body["session"]["runnerInstance"] = json!("unbound-instance");
    body["session"]["terminalEpoch"] = json!("unbound-terminal");
    let session: WorkflowSessionGenerationV1 =
        serde_json::from_value(body["session"].clone()).unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("session-unbound-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": session.session_id,
            "workspace_id": session.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": session.provider_id,
            "runner_principal": session.runner_principal,
            "runner_instance": session.runner_instance,
            "channel_epoch": session.channel_epoch,
            "host_instance_id": session.host_instance_id,
            "terminal_epoch": session.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    verify_exact_orchestration_session(state, &session)
        .await
        .unwrap();
    (body, session)
}

/// Hmux observes this Session generation as live, but no Agent binds it as
/// its current Session: for example the new Session of a restart whose
/// binding is not published yet. Resending the same enrollment cannot help.
#[tokio::test]
async fn enrolling_a_live_session_no_agent_binds_is_stale_not_retryable() {
    let (_root, state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
    let (body, session) = live_unbound_session(&state).await;

    let unassigned = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "unbound-context",
            "dispatch.context.get",
            json!({"schemaVersion": 1, "session": session}),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        unassigned.disposition,
        BackendFailureDispositionV1::Unassigned
    );

    for attempt in 0..2 {
        let error = dispatch(
            &state,
            &orchestration_backend_request(
                &state,
                &format!("unbound-enroll-{attempt}"),
                "run.create",
                body.clone(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_generation_conflict");
        assert_eq!(
            error.details.as_ref().unwrap()["reasonCode"],
            "session_agent_binding_missing"
        );
        assert_eq!(
            error.disposition,
            BackendFailureDispositionV1::StaleGeneration
        );
        let wire = backend_error_body(error);
        assert_eq!(wire["details"]["disposition"], "stale_generation");
    }
    assert!(launcher.requests().is_empty());
    assert!(
        state
            .store
            .inspect_orchestration_dispatch_session(&session)
            .await
            .unwrap()
            .target
            .is_none()
    );
}

/// A Chat runtime that hosts exactly one Hmux Session generation.
struct HostingChatRuntime {
    session: WorkflowSessionGenerationV1,
}

impl structured_provider_runtime::StructuredProviderRuntime for HostingChatRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn hosts_session<'a>(
        &'a self,
        session: &'a WorkflowSessionGenerationV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, bool> {
        Box::pin(async move { Ok(*session == self.session) })
    }
}

/// A Chat (structured) runtime runs its provider inside an Hmux Session that no
/// Agent binds as a terminal Session, so its orchestration tools cannot
/// enroll. The refusal names the Chat runtime and is terminal: resending, a
/// restart or another Run cannot give a Chat runtime an orchestration inbox.
#[tokio::test]
async fn enrolling_a_chat_runtime_session_is_refused_as_terminal() {
    let (_root, mut state, launcher, _) = fixture_with_delivery(Vec::new(), Vec::new()).await;
    let (body, session) = live_unbound_session(&state).await;
    let hosting = |hosted: WorkflowSessionGenerationV1| {
        let mut runtimes =
            structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
        runtimes
            .register(
                hosted.provider_id.clone(),
                Arc::new(HostingChatRuntime { session: hosted }),
            )
            .unwrap();
        Arc::new(runtimes)
    };

    // A Chat runtime that hosts another generation leaves this Session's
    // missing-binding refusal unchanged.
    let mut elsewhere = session.clone();
    elsewhere.runner_instance = "elsewhere-instance".into();
    state.structured_runtimes = hosting(elsewhere);
    let error = dispatch(
        &state,
        &orchestration_backend_request(&state, "chat-enroll-elsewhere", "run.create", body.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.details.as_ref().unwrap()["reasonCode"],
        "session_agent_binding_missing"
    );

    state.structured_runtimes = hosting(session.clone());
    for attempt in 0..2 {
        let error = dispatch(
            &state,
            &orchestration_backend_request(
                &state,
                &format!("chat-enroll-{attempt}"),
                "run.create",
                body.clone(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_interaction_profile_unsupported");
        assert_eq!(
            error.details.as_ref().unwrap()["reasonCode"],
            "structured_protocol"
        );
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
        let wire = backend_error_body(error);
        assert_eq!(wire["details"]["disposition"], "terminal");
    }
    assert!(launcher.requests().is_empty());
    assert!(
        state
            .store
            .inspect_orchestration_dispatch_session(&session)
            .await
            .unwrap()
            .target
            .is_none()
    );
}

/// Hmux observes this Session generation as live, but no Dispatch binds it, so
/// it has no durable inbox yet. A sender's tracked message (`dure send
/// --track`) has nowhere to go; every context path names that reason instead
/// of a bare generation conflict, and only the Session's own lookup may enroll.
#[tokio::test]
async fn a_live_session_without_a_dispatch_names_its_missing_inbox() {
    let (_root, state, launcher, prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let session: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    verify_exact_orchestration_session(&state, &session)
        .await
        .unwrap();
    let context = json!({"schemaVersion": 1, "session": session});
    let message = json!({
        "schemaVersion": 1,
        "session": session,
        "expectedEndpointRef": "endpoint-never-opened",
        "idempotencyKey": "message-to-unassigned-session",
        "interactionId": "message-to-unassigned-session",
        "title": "[dure send · from lead]",
        "descriptionMarkdown": "A tracked message.",
        "openedAtMs": 1_100
    });
    for (label, method, body, disposition) in [
        (
            "unassigned-context",
            "dispatch.context.get",
            context.clone(),
            BackendFailureDispositionV1::Unassigned,
        ),
        (
            "unassigned-exact-context",
            "dispatch.context.get.exact-session",
            context,
            BackendFailureDispositionV1::Terminal,
        ),
        (
            "unassigned-exact-message",
            "interaction.message.open.exact-session",
            message,
            BackendFailureDispositionV1::Terminal,
        ),
    ] {
        let error = dispatch(
            &state,
            &orchestration_backend_request(&state, label, method, body),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_generation_conflict", "{method}");
        assert_eq!(
            error.details.as_ref().unwrap()["reasonCode"],
            "session_dispatch_unassigned",
            "{method}"
        );
        assert_eq!(error.disposition, disposition, "{method}");
    }
    let batch = invoke_orchestration(
        &state,
        "unassigned-batch",
        "dispatch.context.get.batch",
        json!({"schemaVersion": 1, "sessions": [session]}),
    )
    .await;
    let error = &batch["receipt"]["results"][0]["error"];
    assert_eq!(error["code"], "orchestration_generation_conflict");
    assert_eq!(
        error["details"]["reasonCode"],
        "session_dispatch_unassigned"
    );
    assert_eq!(error["details"]["disposition"], "unassigned");
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
    assert!(
        state
            .store
            .inspect_orchestration_dispatch_session(&session)
            .await
            .unwrap()
            .target
            .is_none()
    );
}
