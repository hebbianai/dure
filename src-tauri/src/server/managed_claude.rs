use serde_json::Value;

pub(super) const HOST_REPORT_CAPABILITY: &str = "managed_claude_host_report_v1";
pub(super) const CAUSAL_HOST_REPORT_CAPABILITY: &str = "managed_claude_host_report_causality_v1";

#[derive(Debug)]
pub(super) struct ClaudeHookReport {
    pub(super) presentation: Value,
    pub(super) host_request: crate::hmux::AgentStateReportRequest,
    pub(super) transcript_path: Option<std::path::PathBuf>,
}

fn claude_transcript_exists(transcript_path: Option<&Value>) -> bool {
    transcript_path
        .and_then(Value::as_str)
        .map(std::path::Path::new)
        .is_some_and(|path| path.is_absolute() && path.is_file())
}

/// Normalize native evidence once at the provider boundary. Informational
/// notifications carry no activity authority; the Host retains its last fact.
pub(super) fn normalize_hook_report(
    input: Value,
    mut header: impl FnMut(&str) -> Option<String>,
) -> Result<Option<ClaudeHookReport>, String> {
    let object = input
        .as_object()
        .ok_or_else(|| "Claude hook body must be a JSON object".to_string())?;
    let event = object
        .get("hook_event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Claude hook event is missing".to_string())?;
    let conversation_id = object
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "Claude hook session identity is missing".to_string())?;
    // A conversation identity is a promise that `claude --resume <id>` works.
    // Claude hands out the session id at SessionStart but writes the transcript
    // only once a prompt lands, so an untouched pane has an id and no
    // conversation; resuming it exits with "No conversation found". The
    // transcript on disk is the fact the promise rests on, exactly as the
    // direct Hmux hook path already decides it. Until it exists the report
    // carries activity only and a replacement launch starts fresh.
    let transcript_exists = claude_transcript_exists(object.get("transcript_path"));
    let source_sequence = header("X-Hebbian-Hmux-Source-Sequence")
        .map(|value| {
            value
                .parse::<u64>()
                .ok()
                .filter(|sequence| *sequence > 0 && value.bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or_else(|| "Claude hook source sequence is invalid".to_string())
        })
        .transpose()?;
    let work_id = object
        .get("prompt_id")
        .and_then(Value::as_str)
        .filter(|value| {
            (8..=256).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
        })
        .map(str::to_string);
    let state = match event {
        "SessionStart" => "waiting",
        // UserPromptSubmit opens the turn and PreToolUse re-reports it so the
        // Host keeps one fresh working lease per tool call. Both hold the
        // lease for the protocol maximum, like the Codex and Pi reporters:
        // a turn ends at a complete semantic boundary, never at a timer,
        // so a single long tool call or a long
        // think between tool calls keeps the session visibly busy.
        "UserPromptSubmit" | "PreToolUse" => "working",
        // Parent Stop can precede background child, shell or MCP completion.
        // Only the provider's complete empty registry proves whole-session
        // quiescence. Missing fields are unknown, never an empty snapshot.
        "Stop"
            if (source_sequence.is_none() || work_id.is_some())
                && ["background_tasks", "session_crons"].iter().all(|field| {
                    object
                        .get(*field)
                        .and_then(Value::as_array)
                        .is_some_and(Vec::is_empty)
                }) =>
        {
            "done"
        }
        "Stop" => "working",
        "Notification"
            if object.get("notification_type").and_then(Value::as_str)
                == Some("permission_prompt") =>
        {
            "blocked"
        }
        "Notification" => "informational",
        _ => return Err("Claude hook event is unsupported".to_string()),
    };
    let turn_completion_id = if state == "done" {
        work_id.clone()
    } else {
        None
    };
    let mut required_header = |name: &str| {
        header(name).ok_or_else(|| format!("managed Claude hook header is missing: {name}"))
    };
    let session_id = required_header("X-Hebbian-Hmux-Session-Id")?;
    let workspace_id = required_header("X-Hebbian-Hmux-Workspace-Id")?;
    let runner_principal = required_header("X-Hebbian-Hmux-Runner-Principal")?;
    let runner_instance = required_header("X-Hebbian-Hmux-Runner-Instance")?;
    let channel_epoch = required_header("X-Hebbian-Hmux-Channel-Epoch")?;
    let host_instance_id = required_header("X-Hebbian-Hmux-Host-Instance-Id")?;
    let terminal_epoch = required_header("X-Hebbian-Hmux-Terminal-Epoch")?;
    if state == "informational" {
        return Ok(None);
    }
    let expected_session_fence = crate::hmux::ReportedSessionFence {
        session_id: session_id.clone(),
        workspace_id: workspace_id.clone(),
        runner_principal: runner_principal.clone(),
        runner_instance: runner_instance.clone(),
        channel_epoch: channel_epoch.clone(),
        host_instance_id: host_instance_id.clone(),
        terminal_epoch: terminal_epoch.clone(),
    };
    let mut presentation = serde_json::json!({
        "sessionId": session_id.clone(),
        "state": state,
        "provider": "claude",
        "event": event,
        "terminalEvents": true,
        "sessionFence": {
            "sessionId": session_id.clone(),
            "workspaceId": workspace_id.clone(),
            "runnerPrincipal": runner_principal.clone(),
            "runnerInstance": runner_instance.clone(),
            "channelEpoch": channel_epoch.clone(),
            "hostInstanceId": host_instance_id.clone(),
            "terminalEpoch": terminal_epoch.clone(),
        },
    });
    if transcript_exists {
        presentation["conversationId"] = Value::String(conversation_id.to_string());
    }
    if event == "UserPromptSubmit" {
        if let Some(prompt) = object.get("prompt").and_then(Value::as_str) {
            presentation["text"] = Value::String(prompt.chars().take(4096).collect());
        }
    }
    let (activity, attention, turn_completed, working_ttl_ms) = match state {
        "working" => (
            crate::hmux::ReportedAgentActivity::Working,
            crate::hmux::ReportedAgentAttention::None,
            false,
            Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
        ),
        "blocked" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::ApprovalRequired,
            false,
            None,
        ),
        "done" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::None,
            true,
            None,
        ),
        _ => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::None,
            false,
            None,
        ),
    };
    Ok(Some(ClaudeHookReport {
        presentation,
        transcript_path: object
            .get("transcript_path")
            .and_then(Value::as_str)
            .map(Into::into),
        host_request: crate::hmux::AgentStateReportRequest {
            session_id: session_id.clone(),
            workspace_id: Some(workspace_id.clone()),
            expected_session_fence: Some(expected_session_fence.clone()),
            activity,
            attention,
            turn_completed,
            turn_completion_id,
            causality: source_sequence
                .map(|sequence| hmux_client::AgentStateReportCausality { sequence, work_id }),
            working_ttl_ms,
            conversation_identity: transcript_exists.then(|| {
                crate::hmux::ReportedProviderConversationIdentity {
                    provider_id: "claude".to_string(),
                    conversation_id: conversation_id.to_string(),
                    previous_conversation_id: None,
                    expected_fence: Some(expected_session_fence),
                }
            }),
            expected_observation: None,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn causal_source_order_and_native_work_identity_survive_normalization() {
        for event in ["UserPromptSubmit", "PreToolUse", "Stop"] {
            let input = serde_json::json!({
                "hook_event_name": event, "session_id": "fixture-conversation",
                "prompt_id": "fixture-parent-turn", "background_tasks": [], "session_crons": [],
            });
            let report = normalize_hook_report(input, |name| {
                Some(if name == "X-Hebbian-Hmux-Source-Sequence" {
                    "123456789".into()
                } else {
                    "fixture-id".into()
                })
            })
            .unwrap()
            .unwrap()
            .host_request;
            assert_eq!(
                report.causality,
                Some(hmux_client::AgentStateReportCausality {
                    sequence: 123456789,
                    work_id: Some("fixture-parent-turn".into()),
                })
            );
            assert_eq!(report.turn_completed, event == "Stop");
        }
    }

    #[test]
    fn missing_work_identity_stays_protected_and_bad_order_is_rejected() {
        let input = serde_json::json!({
            "hook_event_name": "Stop", "session_id": "fixture-conversation",
            "background_tasks": [], "session_crons": [],
        });
        for sequence in ["0", "+1", "-1", "invalid", "18446744073709551616"] {
            assert!(
                normalize_hook_report(input.clone(), |name| {
                    Some(if name == "X-Hebbian-Hmux-Source-Sequence" {
                        sequence.into()
                    } else {
                        "fixture-id".into()
                    })
                })
                .is_err()
            );
        }
        let report = normalize_hook_report(input, |name| {
            Some(if name == "X-Hebbian-Hmux-Source-Sequence" {
                "123".into()
            } else {
                "fixture-id".into()
            })
        })
        .unwrap()
        .unwrap()
        .host_request;
        assert_eq!(report.activity, crate::hmux::ReportedAgentActivity::Working);
        assert!(!report.turn_completed);
        assert_eq!(report.causality.unwrap().work_id, None);
    }

    #[test]
    fn background_work_snapshot_controls_completion() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../scripts/qa/fixtures/claude-background-work.json"
        ))
        .unwrap();
        for case in cases {
            let mut input = case["input"].clone();
            input["session_id"] = "fixture-conversation".into();
            input["prompt_id"] = "fixture-parent-turn".into();
            let normalized = normalize_hook_report(input, |name| {
                (name != "X-Hebbian-Hmux-Source-Sequence").then(|| "fixture-id".into())
            })
            .unwrap();
            let label = case["name"].as_str().unwrap();
            if case["activity"].is_null() {
                assert!(normalized.is_none(), "{label}");
                continue;
            }
            let report = normalized.expect("activity report").host_request;
            assert_eq!(
                report.activity == crate::hmux::ReportedAgentActivity::Working,
                case["activity"] == "working",
                "{label}",
            );
            assert_eq!(
                report.attention == crate::hmux::ReportedAgentAttention::ApprovalRequired,
                case["attention"] == "approval_required",
                "{label}",
            );
            let completed = case["completed"].as_bool().unwrap();
            assert_eq!(report.turn_completed, completed, "{label}");
            assert_eq!(
                report.turn_completion_id.as_deref(),
                completed.then_some("fixture-parent-turn"),
                "{label}",
            );
            assert_eq!(
                report.working_ttl_ms,
                (case["activity"] == "working")
                    .then_some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
                "{label}",
            );
        }
    }
}
