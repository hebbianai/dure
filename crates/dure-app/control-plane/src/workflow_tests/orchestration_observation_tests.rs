use super::*;

#[derive(Clone, Copy, Debug)]
enum ObservationFault {
    Timeout,
    Unavailable,
    RuntimeChanged,
    Malformed,
    StaleSession,
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
async fn orchestration_observation_stale_session_remains_fenced() {
    assert_context_observation(ObservationFault::StaleSession).await;
}
