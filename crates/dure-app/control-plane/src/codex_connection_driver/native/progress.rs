//! Bounded provider evidence, never terminal output or a status-poll heartbeat.
use hmux_client::{AgentMessageTurn, AgentProgressPhase, AgentProgressReport};
use serde_json::Value;
use std::{
    collections::HashSet,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) const WAKE_PREFIX: &str = "Dure inbox message: ";

pub(super) fn wake_message(message: &Value) -> Option<String> {
    let input = message.pointer("/params/input")?.as_array()?;
    // The generated wake is exactly one text input. Never search arbitrary user content.
    if input.len() != 1 || input[0].get("type")?.as_str()? != "text" {
        return None;
    }
    let text = input[0].get("text")?.as_str()?;
    let (first, rest) = text.split_once('\n')?;
    if rest != "Read and acknowledge it with the installed dure-orchestration tools." {
        return None;
    }
    let id = first.strip_prefix(WAKE_PREFIX)?;
    (!id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)))
    .then(|| id.to_owned())
}

pub(super) struct Progress {
    source: String,
    sequence: u64,
    turn: Option<String>,
    phase: AgentProgressPhase,
    tools: HashSet<String>,
    messages: Vec<AgentMessageTurn>,
    published: Option<Instant>,
    dirty: bool,
    published_phase: Option<AgentProgressPhase>,
}
impl Default for Progress {
    fn default() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Self {
            source: format!(
                "codex-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
            sequence: 0,
            turn: None,
            phase: AgentProgressPhase::Waiting,
            tools: HashSet::new(),
            messages: Vec::new(),
            published: None,
            dirty: false,
            published_phase: None,
        }
    }
}
impl Progress {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
    pub(super) fn correlate(&mut self, delivery_receipt_id: String, turn: &str) {
        if self
            .messages
            .iter()
            .any(|m| m.delivery_receipt_id == delivery_receipt_id)
        {
            return;
        }
        if self.messages.len() == 32 {
            self.messages.remove(0);
        }
        self.messages.push(AgentMessageTurn {
            delivery_receipt_id,
            turn_id: turn.into(),
        });
        self.advance();
    }
    fn advance(&mut self) {
        self.sequence = self.sequence.saturating_add(1);
        self.dirty = true;
    }
    pub(super) fn observe(&mut self, message: &Value, thread: &str, now: Instant) -> bool {
        if message.pointer("/params/threadId").and_then(Value::as_str) != Some(thread) {
            return false;
        }
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let turn = message
            .pointer("/params/turn/id")
            .or_else(|| message.pointer("/params/turnId"))
            .and_then(super::lifecycle::identifier);
        if method == "turn/started" {
            let Some(turn) = turn else { return false };
            if self.turn.as_deref() == Some(turn) {
                return false;
            }
            self.turn = Some(turn.into());
            self.tools.clear();
            self.phase = AgentProgressPhase::Thinking;
            self.advance();
            return true;
        }
        if turn != self.turn.as_deref() || self.turn.is_none() {
            return false;
        }
        match method {
            "turn/completed" => {
                if self.phase == AgentProgressPhase::Waiting {
                    return false;
                }
                self.tools.clear();
                self.phase = AgentProgressPhase::Waiting;
                self.advance();
                true
            }
            "item/started" | "item/completed" => {
                let Some(id) = message
                    .pointer("/params/item/id")
                    .and_then(super::lifecycle::identifier)
                else {
                    return false;
                };
                let kind = message.pointer("/params/item/type").and_then(Value::as_str);
                if !matches!(
                    kind,
                    Some(
                        "commandExecution"
                            | "mcpToolCall"
                            | "dynamicToolCall"
                            | "fileChange"
                            | "webSearch"
                            | "imageGeneration"
                    )
                ) {
                    return false;
                }
                if method == "item/started" {
                    if self.tools.len() < 128 {
                        self.tools.insert(id.into());
                    }
                } else {
                    self.tools.remove(id);
                }
                self.phase = if self.tools.is_empty() {
                    AgentProgressPhase::Thinking
                } else {
                    AgentProgressPhase::ToolRunning
                };
                self.advance();
                true
            }
            "item/agentMessage/delta"
            | "item/reasoning/textDelta"
            | "item/reasoning/summaryTextDelta"
            | "item/commandExecution/outputDelta" => {
                // A report at most every two seconds; polls/redraws never enter this path.
                if message
                    .pointer("/params/delta")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                    || self.published.is_some_and(|at| {
                        now.saturating_duration_since(at) < Duration::from_secs(2)
                    })
                {
                    return false;
                }
                self.advance();
                true
            }
            _ => false,
        }
    }
    pub(super) fn take(
        &mut self,
        now: Instant,
        resource_working: bool,
    ) -> Option<AgentProgressReport> {
        if self.sequence == 0 {
            return None;
        }
        let phase = if resource_working {
            AgentProgressPhase::ToolRunning
        } else {
            self.phase
        };
        if self.published_phase != Some(phase) {
            self.advance();
        }
        self.published_phase = Some(phase);
        self.dirty = false;
        self.published = Some(now);
        Some(AgentProgressReport {
            source_id: self.source.clone(),
            sequence: self.sequence,
            phase,
            turn_id: self.turn.clone(),
            message_turns: self.messages.clone(),
        })
    }
    pub(super) fn activity(&mut self, working: bool) {
        if self.sequence == 0 {
            return;
        }
        let phase = if !working {
            AgentProgressPhase::Waiting
        } else if self.tools.is_empty() {
            AgentProgressPhase::Thinking
        } else {
            AgentProgressPhase::ToolRunning
        };
        if self.phase != phase {
            self.phase = phase;
            self.advance();
        }
    }

    pub(super) fn dirty(&self) -> bool {
        self.dirty
    }
}
