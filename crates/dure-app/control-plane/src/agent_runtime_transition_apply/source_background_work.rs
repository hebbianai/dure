//! What a busy refusal protects, named for the person deciding whether to wait.
//!
//! The Host's own fact refuses an idle-only transition. When that fact is
//! running work, the refusal also lists the background work the provider's
//! records show running in the session, through the reader the chat view uses
//! (`dure_provider_profile::background_work`), so the person can see what
//! stopping the session would interrupt. The list is advisory and never
//! persisted: an unreadable or unfamiliar record lists nothing, and only the
//! model-written descriptions are named, never commands or tool input.

use std::path::Path;

use dure_app::AgentRuntimeSelectionV1;
use dure_provider_profile::background_work::{BackgroundWorkList, read_claude_background_work};
use dure_provider_profile::transcript::{find_claude_conversation, safe_id};

use super::{ServiceState, source_busy};
use crate::hmux_session_inspection::{AgentBusyReason, HmuxSessionInspection};
use crate::provider_credential_profile::provider_state_directory;

/// Items one refusal names; its counts still cover every running item.
pub(super) const MAX_REFUSAL_BACKGROUND_ITEMS: usize = 16;

/// The `agent_runtime_source_busy` refusal for this exact observation.
/// `bound_conversation` is the conversation the Agent's binding names; the
/// Host's own identity for the session takes precedence when it has one.
pub(super) async fn source_busy_refusal(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    inspection: &HmuxSessionInspection,
    bound_conversation: Option<&str>,
) -> crate::BackendDispatchError {
    let reason = inspection.busy_reason();
    let work = match reason {
        AgentBusyReason::BackgroundWork | AgentBusyReason::Working => {
            running_background_work(state, source, inspection, bound_conversation).await
        }
        _ => None,
    };
    source_busy(reason, work.as_ref())
}

async fn running_background_work(
    state: &ServiceState,
    source: &AgentRuntimeSelectionV1,
    inspection: &HmuxSessionInspection,
    bound_conversation: Option<&str>,
) -> Option<BackgroundWorkList> {
    if source.provider_id.as_str() != "claude" || inspection.provider_id != "claude" {
        return None;
    }
    let conversation = inspection
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.as_str())
        .or(bound_conversation)?
        .to_owned();
    // The records of the account this session runs on; another account's
    // copy of the conversation is not this process's work.
    let resolved = state
        .credential_profiles
        .resolve(&source.provider_id, &source.execution_profile)
        .await
        .ok()?;
    let home = provider_state_directory(&source.provider_id, resolved.as_ref())?;
    // Work that an earlier process started cannot still run in this session.
    let since = inspection.created_unix_ms();
    tokio::task::spawn_blocking(move || {
        running_in_projects(&home.join("projects"), &conversation, since)
    })
    .await
    .ok()
    .flatten()
}

/// The running background work of one Claude conversation under `projects`,
/// bounded for a refusal, or `None` when there is nothing to name.
pub(super) fn running_in_projects(
    projects: &Path,
    conversation_id: &str,
    since_unix_ms: Option<u64>,
) -> Option<BackgroundWorkList> {
    if !safe_id(conversation_id) {
        return None;
    }
    let (_, file) = find_claude_conversation(projects, conversation_id)?;
    let mut list = read_claude_background_work(&file, since_unix_ms);
    if list.items.is_empty() {
        return None;
    }
    if list.items.len() > MAX_REFUSAL_BACKGROUND_ITEMS {
        list.items.truncate(MAX_REFUSAL_BACKGROUND_ITEMS);
        list.truncated = true;
    }
    Some(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_provider_profile::background_work::{BackgroundWorkCounts, BackgroundWorkKind};
    use serde_json::json;

    const CONVERSATION: &str = "conversation-1";
    const STARTED: u64 = 1_793_600_000_000; // 2026-11-02T06:13:20Z

    fn iso(ms: u64) -> String {
        // Fixture timestamps sit inside one known day.
        let seconds = (ms - STARTED) / 1_000 + 6 * 3_600 + 13 * 60 + 20;
        format!(
            "2026-11-02T{:02}:{:02}:{:02}.{:03}Z",
            seconds / 3_600,
            (seconds % 3_600) / 60,
            seconds % 60,
            ms % 1_000
        )
    }

    fn background_shell(lines: &mut Vec<String>, at: u64, index: usize, description: &str) {
        let call = format!("tool-{index}");
        lines.push(
            json!({"type": "assistant", "timestamp": iso(at), "message": {
                "id": format!("message-{index}"), "role": "assistant", "content": [{
                    "type": "tool_use", "id": call, "name": "Bash",
                    "input": {"command": "sleep 600 && echo secret", "description": description,
                        "run_in_background": true}}]}})
            .to_string(),
        );
        lines.push(
            json!({"type": "user", "timestamp": iso(at + 10), "message": {"role": "user",
                "content": [{"type": "tool_result", "tool_use_id": call, "content": "ok"}]},
                "toolUseResult": {"backgroundTaskId": format!("shell-{index}"), "stdout": "",
                    "stderr": "", "interrupted": false}})
            .to_string(),
        );
    }

    fn write_conversation(projects: &Path, lines: &[String]) {
        let project = projects.join("-work-project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{CONVERSATION}.jsonl")),
            lines.join("\n") + "\n",
        )
        .unwrap();
    }

    #[test]
    fn a_refusal_names_running_shells_by_their_description_only() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let mut lines = Vec::new();
        background_shell(&mut lines, STARTED, 1, "Run the release checks");
        write_conversation(&projects, &lines);

        let list = running_in_projects(&projects, CONVERSATION, Some(STARTED)).unwrap();

        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].id, "shell-1");
        assert_eq!(list.items[0].kind, BackgroundWorkKind::Shell);
        assert_eq!(
            list.items[0].label.as_deref(),
            Some("Run the release checks")
        );
        assert_eq!(
            list.counts,
            BackgroundWorkCounts {
                shells: 1,
                ..Default::default()
            }
        );
        let encoded = serde_json::to_string(&list).unwrap();
        assert!(!encoded.contains("secret"), "{encoded}");
    }

    #[test]
    fn work_from_before_the_session_and_finished_work_are_not_named() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let mut lines = Vec::new();
        // An earlier process on the old account left this shell without an end.
        background_shell(&mut lines, STARTED, 1, "Left by the previous process");
        background_shell(&mut lines, STARTED + 60_000, 2, "Finished already");
        lines.push(
            json!({"type": "queue-operation", "operation": "enqueue",
                "timestamp": iso(STARTED + 90_000),
                "content": "<task-notification>\n<task-id>shell-2</task-id>\n<tool-use-id>tool-2</tool-use-id>\n<status>completed</status>\n</task-notification>"})
            .to_string(),
        );
        write_conversation(&projects, &lines);

        assert_eq!(
            running_in_projects(&projects, CONVERSATION, Some(STARTED + 30_000)),
            None
        );
    }

    #[test]
    fn a_long_list_is_bounded_and_keeps_complete_counts() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let mut lines = Vec::new();
        let total = MAX_REFUSAL_BACKGROUND_ITEMS + 4;
        for index in 0..total {
            background_shell(
                &mut lines,
                STARTED + index as u64 * 1_000,
                index,
                &format!("Shell {index}"),
            );
        }
        write_conversation(&projects, &lines);

        let list = running_in_projects(&projects, CONVERSATION, None).unwrap();

        assert_eq!(list.items.len(), MAX_REFUSAL_BACKGROUND_ITEMS);
        assert!(list.truncated);
        assert_eq!(list.counts.shells as usize, total);
    }

    #[test]
    fn an_unknown_or_unsafe_conversation_names_nothing() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("projects");
        let mut lines = Vec::new();
        background_shell(&mut lines, STARTED, 1, "Running");
        write_conversation(&projects, &lines);

        assert_eq!(running_in_projects(&projects, "other", None), None);
        assert_eq!(
            running_in_projects(&projects, "../-work-project/conversation-1", None),
            None
        );
        assert_eq!(
            running_in_projects(&home.path().join("absent"), CONVERSATION, None),
            None
        );
    }
}
