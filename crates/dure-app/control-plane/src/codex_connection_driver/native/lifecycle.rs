//! A projection of the selected native client's ordered provider events.

use super::CodexConnectionDriverError;
use hmux_client::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentStateReport, ProviderConversationIdentity,
    SessionFence,
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct Lifecycle {
    descendants: super::descendants::Descendants,
    own_report: Option<AgentStateReport>,
    pending: HashMap<(u64, String), Pending>,
    selection: Option<(u64, String)>,
    connection: Option<u64>,
    initialized: bool,
    thread: Option<String>,
    thread_path: Option<PathBuf>,
    turn: Option<Turn>,
    goal: Option<String>,
    goal_revision: u64,
    event_revision: u64,
    reconciliation_sequence: u64,
}

struct Pending {
    method: String,
    thread: Option<String>,
    goal_revision: u64,
    event_revision: u64,
}

enum Turn {
    Active(String),
    Successful {
        id: String,
        completion: CompletionDelivery,
    },
    Ended(String),
}

#[derive(PartialEq)]
enum CompletionDelivery {
    Pending,
    Admitted,
    Superseded,
}

impl Turn {
    fn id(&self) -> &str {
        match self {
            Self::Active(id) | Self::Successful { id, .. } | Self::Ended(id) => id,
        }
    }
}

pub(super) fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.is_empty()
            && value.len() <= 256
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
    })
}

impl Lifecycle {
    pub(super) fn admitted(&mut self, report: &AgentStateReport) {
        let Some(Turn::Successful { id, completion }) = &mut self.turn else {
            return;
        };
        if report.turn_completion_id.as_deref() == Some(id) {
            *completion = CompletionDelivery::Admitted;
        } else if !report.identity_only
            && report.turn_completion_id.is_none()
            && *completion == CompletionDelivery::Admitted
        {
            // The Host retires an admitted completion when later activity
            // supersedes it. Replaying that ID would deduplicate the entire
            // report, including a resource's subsequent return to waiting.
            *completion = CompletionDelivery::Superseded;
            if let Some(previous) = &mut self.own_report
                && previous.turn_completion_id.as_deref() == Some(id)
            {
                previous.turn_completed = false;
                previous.turn_completion_id = None;
            }
        }
    }

    pub(super) fn client(
        &mut self,
        connection: u64,
        message: &Value,
    ) -> Result<(), CodexConnectionDriverError> {
        let Some(
            method @ ("initialize"
            | "thread/start"
            | "thread/resume"
            | "thread/goal/get"
            | "thread/read"
            | "turn/start"
            | "mcpServer/tool/call"),
        ) = message.get("method").and_then(Value::as_str)
        else {
            return Ok(());
        };
        if method == "thread/read" && !Self::owns_request_id(message) {
            return Ok(());
        }
        // Native clients also start ephemeral threads for title generation.
        // Those requests are not a selection of the pane's conversation.
        if method == "thread/start"
            && (message
                .pointer("/params/ephemeral")
                .and_then(Value::as_bool)
                == Some(true)
                || message
                    .pointer("/params/threadSource")
                    .and_then(Value::as_str)
                    == Some("system"))
        {
            return Ok(());
        }
        let id = message
            .get("id")
            .ok_or_else(|| CodexConnectionDriverError::new("request_id_invalid"))?;
        if self.pending.len() >= 32 {
            return Err(CodexConnectionDriverError::new("native_request_capacity"));
        }
        // Native helper clients independently allocate the same JSON-RPC IDs.
        // Scope observation only; the wire payload remains untouched.
        let key = (connection, id.to_string());
        if self.pending.contains_key(&key) {
            return Err(CodexConnectionDriverError::new("native_request_id_in_use"));
        }
        if matches!(method, "thread/start" | "thread/resume") {
            self.selection = Some(key.clone());
            self.event_revision += 1;
        }
        if matches!(method, "turn/start" | "mcpServer/tool/call") {
            self.event_revision += 1;
        }
        self.pending.insert(
            key,
            Pending {
                method: method.into(),
                thread: message
                    .pointer("/params/threadId")
                    .and_then(identifier)
                    .map(str::to_owned),
                goal_revision: self.goal_revision,
                event_revision: self.event_revision,
            },
        );
        Ok(())
    }

    pub(super) fn owns_request_id(message: &Value) -> bool {
        message
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("dure/native-state/"))
    }

    pub(super) fn is_selected_connection(&self, connection: u64) -> bool {
        self.connection == Some(connection)
    }

    pub(super) fn disconnected(&mut self, connection: u64) {
        // A helper disappearing does not prove that its tool stopped. The
        // relay drains the owned upstream response before releasing this work.
        self.pending.retain(|(owner, _), pending| {
            *owner != connection || pending.method == "mcpServer/tool/call"
        });
        if self
            .selection
            .as_ref()
            .is_some_and(|(owner, _)| *owner == connection)
        {
            self.selection = None;
        }
        if self.is_selected_connection(connection) {
            self.connection = None;
        }
    }

    pub(super) fn has_pending_tools(&self, connection: u64) -> bool {
        self.pending.iter().any(|((owner, _), pending)| {
            *owner == connection && pending.method == "mcpServer/tool/call"
        })
    }

    pub(super) fn tool_call_report(
        &self,
        connection: u64,
        message: &Value,
        fence: &SessionFence,
    ) -> Option<AgentStateReport> {
        if message.get("method").and_then(Value::as_str) != Some("mcpServer/tool/call") {
            return None;
        }
        let key = (connection, message.get("id")?.to_string());
        (self.pending.get(&key)?.method == "mcpServer/tool/call").then(|| {
            self.protect_report(
                self.own_report.clone().unwrap_or_else(|| {
                    self.report(fence, AgentRuntimeActivity::Working, None, false)
                }),
            )
        })
    }

    pub(super) fn reject_unforwarded_tool(&mut self, connection: u64, message: &Value) {
        if let Some(id) = message.get("id") {
            let key = (connection, id.to_string());
            if self
                .pending
                .get(&key)
                .is_some_and(|pending| pending.method == "mcpServer/tool/call")
            {
                self.pending.remove(&key);
                self.event_revision += 1;
            }
        }
    }

    pub(super) fn reconciliation_request(&mut self, connection: u64) -> Option<Value> {
        if !self.is_selected_connection(connection) {
            return None;
        }
        let thread = self.thread.as_ref()?;
        // One metadata read may be outstanding. Retired replies stay private
        // by their reserved namespace, but can never consume a newer request.
        self.pending
            .retain(|_, pending| pending.method != "thread/read");
        if self.pending.len() >= 32 {
            return None;
        }
        self.reconciliation_sequence += 1;
        let request = json!({
            "id": format!("dure/native-state/{}", self.reconciliation_sequence),
            "method": "thread/read", "params": {"threadId": thread, "includeTurns": false}
        });
        self.client(connection, &request).ok()?;
        Some(request)
    }

    pub(super) fn provider(
        &mut self,
        connection: u64,
        message: &Value,
        fence: &SessionFence,
    ) -> Result<Option<AgentStateReport>, CodexConnectionDriverError> {
        // Token/output deltas are not lifecycle evidence. Keep the ancestry
        // walk off the high-volume native transport path.
        if let Some(method) = message.get("method").and_then(Value::as_str)
            && !matches!(
                method,
                "thread/started"
                    | "thread/status/changed"
                    | "thread/closed"
                    | "turn/started"
                    | "turn/completed"
                    | "thread/goal/updated"
                    | "thread/goal/cleared"
            )
        {
            return Ok(None);
        }
        let previous_thread = self.thread.clone();
        let previously_working = self.resource_working();
        if self.is_selected_connection(connection) {
            self.descendants.observe(message);
        }
        let own_report = self.selected_provider(connection, message, fence)?;
        if self.thread != previous_thread {
            self.own_report = None;
        }
        if let Some(report) = &own_report {
            match &mut self.own_report {
                Some(previous) if report.identity_only => {
                    // A picker refresh updates identity, not the ordered turn state.
                    previous.conversation_identity = report.conversation_identity.clone();
                }
                _ => self.own_report = Some(report.clone()),
            }
        }
        let working = self.resource_working();
        let report = match own_report {
            Some(report) => report,
            None if working != previously_working => match &self.own_report {
                Some(report) => {
                    let mut report = report.clone();
                    // This is an ordered resource transition, not a picker
                    // refresh. It must settle the activity we previously held.
                    report.identity_only = false;
                    report
                }
                None => return Ok(None),
            },
            None => return Ok(None),
        };
        Ok(Some(self.protect_report(report)))
    }

    fn protect_report(&self, mut report: AgentStateReport) -> AgentStateReport {
        if self.resource_working() || self.pending_turn_start() {
            // Completion belongs to the whole selected subtree. Preserve the
            // parent's ordered result until its last working descendant settles.
            report.activity = AgentRuntimeActivity::Working;
            report.identity_only = false;
            report.turn_completed = false;
            report.turn_completion_id = None;
            report.working_ttl_ms = Some(86_400_000);
        }
        report
    }

    fn resource_working(&self) -> bool {
        self.descendants_working()
            || self
                .pending
                .values()
                .any(|pending| pending.method == "mcpServer/tool/call")
    }

    fn descendants_working(&self) -> bool {
        self.thread
            .as_deref()
            .is_some_and(|thread| self.descendants.working(thread))
    }

    fn pending_turn_start(&self) -> bool {
        self.pending
            .values()
            .any(|pending| pending.method == "turn/start" && pending.thread == self.thread)
    }

    fn selected_provider(
        &mut self,
        connection: u64,
        message: &Value,
        fence: &SessionFence,
    ) -> Result<Option<AgentStateReport>, CodexConnectionDriverError> {
        if message.get("method").is_none()
            && message
                .get("id")
                .and_then(|id| self.pending.get(&(connection, id.to_string())))
                .is_some_and(|pending| pending.method == "mcpServer/tool/call")
            && !((message.get("result").is_some() && message.get("error").is_none())
                || (message.get("result").is_none()
                    && message.get("error").is_some_and(Value::is_object)))
        {
            // An ID alone is not an observed tool completion.
            return Ok(None);
        }
        if message.get("method").is_none()
            && let Some(pending) = message
                .get("id")
                .and_then(|id| self.pending.remove(&(connection, id.to_string())))
        {
            if message.get("error").is_some() {
                return Ok(None);
            }
            if matches!(
                pending.method.as_str(),
                "turn/start" | "mcpServer/tool/call"
            ) {
                return Ok(None);
            }
            if pending.method == "thread/read" {
                return Ok(self.reconciled_report(message, &pending, fence));
            }
            if pending.method == "initialize" {
                // This driver owns a fresh app-server with no loaded thread.
                // Admit its ready boundary before the TUI can accept input;
                // otherwise the first Enter cannot clear Host draft tracking.
                if self.initialized || self.thread.is_some() || message.get("result").is_none() {
                    return Ok(None);
                }
                self.initialized = true;
                return Ok(Some(self.report(
                    fence,
                    AgentRuntimeActivity::Waiting,
                    None,
                    false,
                )));
            }
            if pending.method == "thread/goal/get" {
                if !self.is_selected_connection(connection)
                    || pending.thread != self.thread
                    || pending.goal_revision != self.goal_revision
                {
                    return Ok(None);
                }
                let goal = message.pointer("/result/goal");
                if goal == Some(&Value::Null) {
                    self.goal = Some("none".into());
                } else if let Some(goal) = goal {
                    self.adopt_goal(goal);
                }
                self.event_revision += 1;
                return Ok(self.completion_report(fence));
            }
            if message.get("id").map(|id| (connection, id.to_string())) != self.selection {
                return Ok(None);
            }
            if message
                .pointer("/result/thread/ephemeral")
                .and_then(Value::as_bool)
                == Some(true)
                || message
                    .pointer("/result/thread/parentThreadId")
                    .is_some_and(|value| !value.is_null())
            {
                return Ok(None);
            }
            let thread = message
                .pointer("/result/thread/id")
                .and_then(identifier)
                .ok_or_else(|| CodexConnectionDriverError::new("native_thread_invalid"))?;
            let thread_path = Self::resumable_thread_path(message);
            self.connection = Some(connection);
            if self.thread.as_deref() != Some(thread) {
                self.event_revision += 1;
                self.thread = Some(thread.into());
                self.thread_path = thread_path;
                self.turn = message
                    .pointer("/result/thread/turns")
                    .and_then(Value::as_array)
                    .and_then(|turns| turns.last())
                    .and_then(|turn| {
                        Some((
                            turn.get("id").and_then(identifier)?,
                            turn.get("status")?.as_str()?,
                        ))
                    })
                    .map(|(id, status)| {
                        if status == "inProgress" {
                            Turn::Active(id.into())
                        } else {
                            Turn::Ended(id.into())
                        }
                    });
                self.goal = (pending.method == "thread/start").then(|| "none".into());
                self.goal_revision += 1;
            } else if thread_path.is_some() {
                self.thread_path = thread_path;
            }
            let active = message
                .pointer("/result/thread/status/type")
                .and_then(Value::as_str)
                == Some("active");
            let report = if active {
                self.active_report(fence, &message["result"]["thread"]["status"])
            } else {
                self.report(fence, AgentRuntimeActivity::Waiting, None, true)
            };
            if report.identity_only && report.conversation_identity.is_none() {
                return Ok(None);
            }
            return Ok(Some(report));
        }
        let Some(params) = message.get("params") else {
            return Ok(None);
        };
        if !self.is_selected_connection(connection)
            || params.get("threadId").and_then(Value::as_str) != self.thread.as_deref()
            || self.thread.is_none()
        {
            return Ok(None);
        }
        let report = match message.get("method").and_then(Value::as_str) {
            Some("thread/status/changed")
                if params.pointer("/status/type").and_then(Value::as_str) == Some("active") =>
            {
                self.event_revision += 1;
                Some(self.active_report(fence, &params["status"]))
            }
            Some("thread/goal/updated") => {
                self.event_revision += 1;
                self.goal_revision += 1;
                if let Some(goal) = params.get("goal") {
                    self.adopt_goal(goal);
                }
                self.completion_report(fence)
            }
            Some("thread/goal/cleared") => {
                self.event_revision += 1;
                self.goal_revision += 1;
                self.goal = Some("none".into());
                self.completion_report(fence)
            }
            Some("turn/started") => {
                let turn_id = params
                    .pointer("/turn/id")
                    .and_then(identifier)
                    .ok_or_else(|| CodexConnectionDriverError::new("native_turn_invalid"))?;
                if self.turn.as_ref().is_some_and(|turn| turn.id() == turn_id) {
                    return Ok(None);
                }
                self.turn = Some(Turn::Active(turn_id.into()));
                self.event_revision += 1;
                Some(self.report(fence, AgentRuntimeActivity::Working, None, false))
            }
            Some("turn/completed") => {
                let turn = params
                    .get("turn")
                    .ok_or_else(|| CodexConnectionDriverError::new("native_turn_invalid"))?;
                let turn_id = turn
                    .get("id")
                    .and_then(identifier)
                    .ok_or_else(|| CodexConnectionDriverError::new("native_turn_invalid"))?;
                if !matches!(&self.turn, Some(Turn::Active(id)) if id == turn_id) {
                    return Ok(None);
                }
                match turn.get("status").and_then(Value::as_str) {
                    Some("failed" | "interrupted") => {
                        self.event_revision += 1;
                        self.turn = Some(Turn::Ended(turn_id.into()));
                        Some(self.report(fence, AgentRuntimeActivity::Waiting, None, false))
                    }
                    Some("completed") => {
                        self.event_revision += 1;
                        self.turn = Some(Turn::Successful {
                            id: turn_id.into(),
                            completion: CompletionDelivery::Pending,
                        });
                        self.completion_report(fence)
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        Ok(report)
    }

    fn reconciled_report(
        &self,
        message: &Value,
        pending: &Pending,
        fence: &SessionFence,
    ) -> Option<AgentStateReport> {
        if pending.thread != self.thread
            || pending.event_revision != self.event_revision
            || message.pointer("/result/thread/id").and_then(identifier) != self.thread.as_deref()
        {
            return None;
        }
        match message
            .pointer("/result/thread/status/type")
            .and_then(Value::as_str)
        {
            Some("active") => {
                Some(self.active_report(fence, &message["result"]["thread"]["status"]))
            }
            Some("idle" | "systemError") if self.pending_turn_start() => None,
            // Codex retains systemError after a failed native turn. That is
            // not an end proof by itself; the exact ordered terminal event is.
            Some("systemError") if matches!(self.turn, Some(Turn::Ended(_))) => {
                Some(self.report(fence, AgentRuntimeActivity::Waiting, None, false))
            }
            Some("idle") => match &self.turn {
                Some(Turn::Ended(_)) => {
                    Some(self.report(fence, AgentRuntimeActivity::Waiting, None, false))
                }
                Some(Turn::Successful { .. }) => self.completion_report(fence),
                // The stream has not confirmed termination. A metadata read
                // alone must not manufacture an end or clear a protected draft.
                Some(Turn::Active(_)) => None,
                None => Some(self.report(fence, AgentRuntimeActivity::Waiting, None, false)),
            },
            _ => None,
        }
    }

    fn completion_report(&self, fence: &SessionFence) -> Option<AgentStateReport> {
        let Some(Turn::Successful {
            id: turn,
            completion,
        }) = &self.turn
        else {
            return None;
        };
        // A resume whose goal has not arrived is not an idle proof. Goal reads
        // and updates share this ordered connection and settle this boundary.
        let working = !matches!(
            self.goal.as_deref(),
            Some("none" | "complete" | "paused" | "blocked" | "usageLimited" | "budgetLimited")
        );
        Some(
            self.report(
                fence,
                if working {
                    AgentRuntimeActivity::Working
                } else {
                    AgentRuntimeActivity::Waiting
                },
                (*completion != CompletionDelivery::Superseded
                    && matches!(self.goal.as_deref(), Some("none" | "complete")))
                .then(|| turn.clone()),
                false,
            ),
        )
    }

    /// Codex owns the complete active flags, including concurrent approvals.
    /// A waiting active turn is not a completed turn or an idle stop boundary.
    fn active_report(&self, fence: &SessionFence, status: &Value) -> AgentStateReport {
        let flags = status.get("activeFlags").and_then(Value::as_array);
        let has_flag = |flag: &str| {
            flags.is_some_and(|flags| flags.iter().any(|value| value.as_str() == Some(flag)))
        };
        let attention = if has_flag("waitingOnApproval") {
            AgentRuntimeAttention::ApprovalRequired
        } else if has_flag("waitingOnUserInput") {
            AgentRuntimeAttention::InputRequired
        } else {
            AgentRuntimeAttention::None
        };
        let activity = if attention == AgentRuntimeAttention::None {
            AgentRuntimeActivity::Working
        } else {
            AgentRuntimeActivity::Waiting
        };
        AgentStateReport {
            attention,
            ..self.report(fence, activity, None, false)
        }
    }

    fn adopt_goal(&mut self, goal: &Value) {
        if goal.get("threadId").and_then(Value::as_str) == self.thread.as_deref() {
            self.goal = goal
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
    }

    fn resumable_thread_path(message: &Value) -> Option<PathBuf> {
        let path = PathBuf::from(message.pointer("/result/thread/path")?.as_str()?);
        path.is_absolute().then_some(path)
    }

    fn conversation_identity(&self, fence: &SessionFence) -> Option<ProviderConversationIdentity> {
        let thread = self.thread.as_ref()?;
        let path = self.thread_path.as_ref()?;
        path.is_file().then(|| ProviderConversationIdentity {
            provider_id: "codex".into(),
            conversation_id: thread.clone(),
            expected_fence: Some(fence.clone()),
        })
    }

    fn report(
        &self,
        fence: &SessionFence,
        activity: AgentRuntimeActivity,
        completion: Option<String>,
        identity_only: bool,
    ) -> AgentStateReport {
        AgentStateReport {
            identity_only,
            activity,
            attention: AgentRuntimeAttention::None,
            turn_completed: completion.is_some(),
            turn_completion_id: completion,
            causality: None,
            working_ttl_ms: (activity == AgentRuntimeActivity::Working).then_some(86_400_000),
            conversation_identity: self.conversation_identity(fence),
            expected_observation: None,
        }
    }
}
