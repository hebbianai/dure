use serde_json::Value;

pub(super) const HOST_REPORT_CAPABILITY: &str = "managed_claude_host_report_v1";
pub(super) const CAUSAL_HOST_REPORT_CAPABILITY: &str = "managed_claude_host_report_causality_v1";

#[derive(Debug)]
pub(super) struct ClaudeHookReport {
    pub(super) presentation: Value,
    pub(super) host_request: crate::hmux::AgentStateReportRequest,
    pub(super) transcript_path: Option<std::path::PathBuf>,
    /// The conversation Claude started in place with `/clear`. Only an
    /// interactive `/clear` reports `SessionStart` with source `clear`; a
    /// child Claude process that inherits the hook environment starts with
    /// `startup`, so it can never claim the pane's conversation this way.
    pub(super) cleared_conversation_id: Option<String>,
}

/// What a `PermissionRequest` asks: its attention, and the request a chat
/// can answer when the prompt is a plain approval. The prompt is read by the
/// provider adapter, which owns every Claude spelling.
fn permission_request(
    object: &serde_json::Map<String, Value>,
) -> (
    crate::hmux::ReportedAgentAttention,
    Option<hmux_client::AgentApprovalRequest>,
) {
    use dure_provider_adapter::native_approval::{
        claude_permission_prompt, ClaudePermissionPrompt,
    };
    use hmux_client::AgentApprovalChoice;
    let prompt = match claude_permission_prompt(
        object,
        hmux_session_protocol::AGENT_APPROVAL_REQUEST_MAX_SUMMARY_BYTES,
    ) {
        ClaudePermissionPrompt::Question => {
            return (crate::hmux::ReportedAgentAttention::InputRequired, None)
        }
        ClaudePermissionPrompt::Approval(prompt) => prompt,
    };
    let request = prompt
        .map(|prompt| hmux_client::AgentApprovalRequest {
            tool_name: prompt.tool_name,
            summary: prompt.summary,
            choices: [
                Some(AgentApprovalChoice::Approve),
                prompt
                    .approve_always
                    .then_some(AgentApprovalChoice::ApproveAlways),
                Some(AgentApprovalChoice::Deny),
            ]
            .into_iter()
            .flatten()
            .collect(),
        })
        .filter(hmux_client::AgentApprovalRequest::is_valid);
    (
        crate::hmux::ReportedAgentAttention::ApprovalRequired,
        request,
    )
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
    let registries_empty = ["background_tasks", "session_crons"].iter().all(|field| {
        object
            .get(*field)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
    });
    // Claude names the subagent whose work fired a hook.
    let subagent = object
        .get("agent_id")
        .and_then(Value::as_str)
        .is_some_and(|agent| !agent.is_empty());
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
        "Stop" if (source_sequence.is_none() || work_id.is_some()) && registries_empty => "done",
        "Stop" => "working",
        "Notification"
            if object.get("notification_type").and_then(Value::as_str)
                == Some("permission_prompt") =>
        {
            "blocked"
        }
        "Notification" => "informational",
        // A turn that failed on an API error ends in StopFailure, never Stop,
        // and Claude does not retry it: nothing runs until someone sends input
        // again. A missing or expired login asks a person to sign in; any
        // other failure (the API unreachable, rate limits, server errors, ...)
        // is the turn's error. A subagent's failure ends only its own work.
        "StopFailure" if subagent => "informational",
        "StopFailure"
            if object.get("error").and_then(Value::as_str) == Some("authentication_failed") =>
        {
            "sign_in_required"
        }
        "StopFailure" => "failed",
        // The prompt itself, with what it asks. The person still answers it,
        // in the terminal or from a chat that shows the request.
        "PermissionRequest" => "blocked",
        _ => return Err("Claude hook event is unsupported".to_string()),
    };
    let (blocked_attention, approval_request) = if event == "PermissionRequest" {
        permission_request(object)
    } else {
        (crate::hmux::ReportedAgentAttention::ApprovalRequired, None)
    };
    // Background work keeps the session busy, but a Stop still ends the
    // parent's turn, so its prompt accepts input. Claude names the subagent
    // whose tool call fires a hook; that call is background work too.
    let background_work = match event {
        "Stop" => state == "working" && !registries_empty,
        "PreToolUse" => subagent,
        _ => false,
    };
    // Why a failed turn failed, in the provider-neutral vocabulary of the
    // structured drivers. A capacity refusal Claude reports as `rate_limit`
    // counts as one; any other class, or none, is a provider error.
    let turn_failure = (state == "failed").then(|| {
        match object.get("error").and_then(Value::as_str) {
            Some("rate_limit") => hmux_client::AgentTurnFailure::RateLimit,
            Some("billing_error") => hmux_client::AgentTurnFailure::UsageLimit,
            _ => hmux_client::AgentTurnFailure::ProviderError,
        }
    });
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
        "working" if background_work && event == "Stop" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::None,
            false,
            Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
        ),
        "working" => (
            crate::hmux::ReportedAgentActivity::Working,
            crate::hmux::ReportedAgentAttention::None,
            false,
            Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
        ),
        "blocked" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            blocked_attention,
            false,
            None,
        ),
        "sign_in_required" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::InputRequired,
            false,
            None,
        ),
        "failed" => (
            crate::hmux::ReportedAgentActivity::Waiting,
            crate::hmux::ReportedAgentAttention::Error,
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
    let cleared_conversation_id = (event == "SessionStart"
        && object.get("source").and_then(Value::as_str) == Some("clear"))
    .then(|| conversation_id.to_string());
    Ok(Some(ClaudeHookReport {
        presentation,
        cleared_conversation_id,
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
            background_work,
            approval_request,
            turn_failure,
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

    /// Claude ends a turn that failed on an API error with StopFailure and no
    /// Stop (Claude Code 2.1.331 with the API unreachable reports
    /// `server_error`). The turn is over and its prompt is idle, so the
    /// session must leave `working`: a failed sign-in asks a person to sign
    /// in, any other failure is the turn's error.
    #[test]
    fn a_failed_turn_ends_with_sign_in_or_its_error() {
        let header = |name: &str| {
            Some(if name == "X-Hebbian-Hmux-Source-Sequence" {
                "42".to_string()
            } else {
                "fixture-id".to_string()
            })
        };
        let failure = |error: Option<&str>| {
            let mut input = serde_json::json!({
                "hook_event_name": "StopFailure", "session_id": "fixture-conversation",
                "prompt_id": "fixture-parent-turn",
                "last_assistant_message": "API Error: Can't reach the API server",
            });
            if let Some(error) = error {
                input["error"] = error.into();
            }
            input
        };
        use crate::hmux::ReportedAgentAttention::{Error, InputRequired};
        use hmux_client::AgentTurnFailure::{ProviderError, RateLimit, UsageLimit};
        for (error, attention, turn_failure) in [
            (Some("authentication_failed"), InputRequired, None),
            (Some("server_error"), Error, Some(ProviderError)),
            (Some("rate_limit"), Error, Some(RateLimit)),
            (Some("billing_error"), Error, Some(UsageLimit)),
            (Some("unknown"), Error, Some(ProviderError)),
            (None, Error, Some(ProviderError)),
        ] {
            let report = normalize_hook_report(failure(error), header)
                .unwrap()
                .expect("a failed turn is reported")
                .host_request;
            assert_eq!(
                report.activity,
                crate::hmux::ReportedAgentActivity::Waiting,
                "{error:?}"
            );
            assert_eq!(report.attention, attention, "{error:?}");
            assert_eq!(report.turn_failure, turn_failure, "{error:?}");
            assert!(!report.turn_completed);
            assert_eq!(report.turn_completion_id, None);
            assert_eq!(report.working_ttl_ms, None);
            assert!(!report.background_work);
            assert_eq!(
                report.causality,
                Some(hmux_client::AgentStateReportCausality {
                    sequence: 42,
                    work_id: Some("fixture-parent-turn".into()),
                })
            );
        }
        let mut subagent = failure(Some("server_error"));
        subagent["agent_id"] = "fixture-subagent".into();
        assert!(normalize_hook_report(subagent, header).unwrap().is_none());
    }

    #[test]
    fn only_an_interactive_clear_names_a_successor_conversation() {
        let header = |name: &str| {
            (name != "X-Hebbian-Hmux-Source-Sequence").then(|| "fixture-id".to_string())
        };
        for (source, expected) in [
            (Some("clear"), Some("fixture-cleared")),
            (Some("startup"), None),
            (Some("resume"), None),
            (Some("compact"), None),
            (None, None),
        ] {
            let mut input = serde_json::json!({
                "hook_event_name": "SessionStart", "session_id": "fixture-cleared",
            });
            if let Some(source) = source {
                input["source"] = source.into();
            }
            let report = normalize_hook_report(input, header).unwrap().unwrap();
            assert_eq!(report.cleared_conversation_id.as_deref(), expected, "{source:?}");
        }
        let prompt = serde_json::json!({
            "hook_event_name": "UserPromptSubmit", "session_id": "fixture-cleared",
            "source": "clear",
        });
        let report = normalize_hook_report(prompt, header).unwrap().unwrap();
        assert_eq!(report.cleared_conversation_id, None);
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
            let background = case["background"].as_bool().unwrap_or(false);
            assert_eq!(
                report.activity == crate::hmux::ReportedAgentActivity::Working,
                case["activity"] == "working",
                "{label}",
            );
            assert_eq!(report.background_work, background, "{label}");
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
                (case["activity"] == "working" || background)
                    .then_some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
                "{label}",
            );
        }
    }

    fn permission_report(input: Value) -> crate::hmux::AgentStateReportRequest {
        let mut input = input;
        input["hook_event_name"] = "PermissionRequest".into();
        input["session_id"] = "fixture-conversation".into();
        normalize_hook_report(input, |name| {
            (name != "X-Hebbian-Hmux-Source-Sequence").then(|| "fixture-id".into())
        })
        .unwrap()
        .expect("a permission prompt is reported")
        .host_request
    }

    #[test]
    fn a_permission_prompt_carries_its_command_and_offered_answers() {
        use hmux_client::AgentApprovalChoice::{Approve, ApproveAlways, Deny};
        let report = permission_report(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "cargo test -p dure", "description": "Run tests" },
            "permission_suggestions": [{ "type": "addRules" }],
        }));
        assert_eq!(report.activity, crate::hmux::ReportedAgentActivity::Waiting);
        assert_eq!(
            report.attention,
            crate::hmux::ReportedAgentAttention::ApprovalRequired
        );
        let request = report.approval_request.expect("the prompt's content");
        assert_eq!(request.tool_name, "Bash");
        assert_eq!(request.summary, "cargo test -p dure");
        assert_eq!(request.choices, vec![Approve, ApproveAlways, Deny]);

        // Without suggestions Claude offers no "don't ask again".
        let request = permission_report(serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/tmp/fixture.txt", "content": "secret body" },
        }))
        .approval_request
        .unwrap();
        assert_eq!(request.summary, "/tmp/fixture.txt");
        assert_eq!(request.choices, vec![Approve, Deny]);
    }

    #[test]
    fn prompts_that_are_not_plain_approvals_carry_no_request() {
        let question = permission_report(serde_json::json!({ "tool_name": "AskUserQuestion" }));
        assert_eq!(
            question.attention,
            crate::hmux::ReportedAgentAttention::InputRequired
        );
        assert_eq!(question.approval_request, None);
        for input in [
            serde_json::json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": "p" } }),
            serde_json::json!({ "tool_input": { "command": "ls" } }),
        ] {
            let report = permission_report(input);
            assert_eq!(
                report.attention,
                crate::hmux::ReportedAgentAttention::ApprovalRequired
            );
            assert_eq!(report.approval_request, None);
        }
    }
}
