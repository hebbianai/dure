//! Bounded, private transport evidence, never an input to lifecycle decisions.
use hmux_client::{AgentStateReport, SessionFence};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::File,
    io::{Seek, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

pub(super) struct Diagnostics {
    file: File,
    recent: VecDeque<Value>,
    sequence: u64,
}

impl Diagnostics {
    pub(super) fn open(directory: &Path) -> std::io::Result<Self> {
        Ok(Self {
            file: File::options()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(directory.join("lifecycle.json"))?,
            recent: VecDeque::new(),
            sequence: 0,
        })
    }

    pub(super) fn record(
        &mut self,
        message: &Value,
        report: Option<&AgentStateReport>,
        fence: &SessionFence,
        outcome: &str,
    ) -> std::io::Result<()> {
        let method = message.get("method").and_then(Value::as_str);
        if report.is_none()
            && !matches!(
                method,
                Some(
                    "turn/started"
                        | "turn/completed"
                        | "thread/goal/updated"
                        | "thread/goal/cleared"
                        | "thread/reconciled"
                        | "thread/started"
                        | "thread/status/changed"
                        | "thread/closed"
                )
            )
        {
            return Ok(());
        }
        let identity = report.and_then(|report| report.conversation_identity.as_ref());
        self.sequence += 1;
        self.recent.push_back(json!({
            "sequence": self.sequence,
            "event": method.unwrap_or(if identity.is_some() { "thread/selected" } else { "server/initialized" }),
            "turnId": message.pointer("/params/turn/id").and_then(Value::as_str).filter(|id| id.len() <= 256),
            "conversationId": identity.map(|identity| identity.conversation_id.as_str())
                .or_else(|| message.pointer("/params/threadId").and_then(super::lifecycle::identifier)),
            "sourceThreadId": message.pointer("/params/threadId")
                .or_else(|| message.pointer("/params/thread/id")).and_then(super::lifecycle::identifier),
            "parentThreadId": message.pointer("/params/thread/parentThreadId")
                .and_then(super::lifecycle::identifier),
            "hostInstanceId": fence.host_instance_id, "terminalEpoch": fence.terminal_epoch,
            "activity": report.map(|report| report.activity), "identityOnly": report.map(|report| report.identity_only),
            "attention": report.map(|report| report.attention),
            "outcome": outcome,
            "threadStatus": message.pointer("/params/threadStatus")
                .or_else(|| message.pointer("/params/status/type"))
                .or_else(|| message.pointer("/params/thread/status/type")).and_then(Value::as_str)
                .filter(|status| matches!(*status, "idle" | "active" | "notLoaded" | "systemError")),
            "requestErrorCode": message.pointer("/params/requestErrorCode").and_then(Value::as_i64),
        }));
        if self.recent.len() > 128 {
            self.recent.pop_front();
        }
        self.file.rewind()?;
        serde_json::to_writer(&mut self.file, &self.recent)?;
        let length = self.file.stream_position()?;
        self.file.set_len(length)?;
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn retains_only_bounded_lifecycle_metadata_not_provider_payloads() {
        let root = tempfile::tempdir().unwrap();
        let mut diagnostics = Diagnostics::open(root.path()).unwrap();
        let fence = SessionFence {
            session_id: "session".into(),
            workspace_id: "workspace".into(),
            runner_principal: "user".into(),
            runner_instance: "runner".into(),
            channel_epoch: 1,
            host_instance_id: "host".into(),
            terminal_epoch: "epoch".into(),
        };
        let payload = json!({"method": "turn/completed", "params": {"threadId": "thread", "turn": {"id": "turn", "items": ["PRIVATE BODY"], "error": "PRIVATE TOKEN"}}});
        for _ in 0..140 {
            diagnostics
                .record(&payload, None, &fence, "ignored")
                .unwrap();
        }
        diagnostics
            .record(
                &json!({"method": "item/agentMessage/delta", "params": {"delta": "PRIVATE BODY"}}),
                None,
                &fence,
                "ignored",
            )
            .unwrap();
        let path = root.path().join("lifecycle.json");
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains("PRIVATE"));
        let entries: Vec<Value> = serde_json::from_str(&bytes).unwrap();
        assert_eq!(entries.len(), 128);
        assert_eq!(entries[127]["sequence"], 140);
        assert_eq!(entries[127]["conversationId"], "thread");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
