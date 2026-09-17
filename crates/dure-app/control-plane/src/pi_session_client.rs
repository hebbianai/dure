use std::io::{BufRead, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use dure_app::{AgentInteractionBindingV1, AgentSpawnModelSelectionV1};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agent_conversation::AgentProviderCommandErrorV1 as Error;
use crate::json_rpc_socket_client::{JsonRpcSocketClient, JsonRpcSocketIncoming};
use crate::provider_timeline_journal::{digest, protocol_error, store_error};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionId(String);

impl SessionId {
    pub(crate) fn parse(value: &str) -> Result<Self, Error> {
        if value.len() != 36
            || !value.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                }
            })
        {
            return Err(protocol_error(
                "Pi requires an exact canonical session UUID",
            ));
        }
        Ok(Self(value.into()))
    }

    pub(crate) fn for_binding(binding: &AgentInteractionBindingV1) -> Result<Self, Error> {
        if let Some(id) = &binding.provider_conversation_ref {
            return Self::parse(id);
        }
        let hash = digest(&format!(
            "dure.pi.session/v1\0{}",
            binding.interaction_session_id
        ));
        Self::parse(&format!(
            "{}-{}-4{}-8{}-{}",
            &hash[..8],
            &hash[8..12],
            &hash[13..16],
            &hash[17..20],
            &hash[20..32]
        ))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionState {
    pub(crate) session_id: String,
    pub(crate) session_file: PathBuf,
    pub(crate) is_streaming: bool,
    pub(crate) is_compacting: bool,
    pub(crate) pending_message_count: usize,
    pub(crate) pending_prompt: bool,
    pub(crate) pending_ui: Vec<Value>,
    pub(crate) thinking_level: String,
    pub(crate) model: Value,
}

impl SessionState {
    pub(crate) fn busy(&self) -> bool {
        self.is_streaming
            || self.is_compacting
            || self.pending_message_count != 0
            || self.pending_prompt
            || !self.pending_ui.is_empty()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entries {
    pub(crate) entries: Vec<Value>,
    pub(crate) leaf_id: Option<String>,
}

pub(crate) struct PiSessionClient {
    pub(crate) rpc: JsonRpcSocketClient,
    pub(crate) session: SessionId,
    cwd: PathBuf,
    requires_persisted_session: bool,
}

impl PiSessionClient {
    pub(crate) async fn connect(
        endpoint: &Path,
        cwd: &Path,
        binding: &AgentInteractionBindingV1,
    ) -> Result<(Self, JsonRpcSocketIncoming), Error> {
        let (rpc, events) = JsonRpcSocketClient::connect(endpoint)
            .await
            .map_err(store_error)?;
        Ok((
            Self {
                rpc,
                session: SessionId::for_binding(binding)?,
                cwd: cwd.into(),
                requires_persisted_session: binding.provider_conversation_ref.is_some(),
            },
            events,
        ))
    }

    pub(crate) async fn state(&self) -> Result<SessionState, Error> {
        let state: SessionState = serde_json::from_value(
            self.rpc
                .request("get_state", json!({}))
                .await
                .map_err(store_error)?,
        )
        .map_err(store_error)?;
        if state.session_id != self.session.as_str() || !state.session_file.is_absolute() {
            return Err(protocol_error("Pi changed the selected conversation"));
        }
        Ok(state)
    }

    pub(crate) async fn entries(&self) -> Result<Entries, Error> {
        let entries: Entries = serde_json::from_value(
            self.rpc
                .request("get_entries", json!({}))
                .await
                .map_err(store_error)?,
        )
        .map_err(store_error)?;
        if entries.entries.len() > 16384 {
            return Err(protocol_error("Pi history entry limit exceeded"));
        }
        Ok(entries)
    }

    /// Pi creates its transcript only after the first assistant message. An
    /// empty, fresh runtime may remain unmaterialized; exact resume may not.
    pub(crate) fn is_materialized(&self, state: &SessionState) -> Result<bool, Error> {
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&state.session_file)
        {
            Ok(file) => file,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && !self.requires_persisted_session =>
            {
                return Ok(false);
            }
            Err(error) => return Err(store_error(error)),
        };
        let metadata = file.metadata().map_err(store_error)?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(protocol_error("Pi transcript ownership is invalid"));
        }
        let mut header = Vec::new();
        std::io::BufReader::new(file.take(65537))
            .read_until(b'\n', &mut header)
            .map_err(store_error)?;
        if header.len() > 65536 {
            return Err(protocol_error("Pi session header limit exceeded"));
        }
        let header: Value = serde_json::from_slice(&header).map_err(store_error)?;
        if header.get("type").and_then(Value::as_str) != Some("session")
            || header.get("id").and_then(Value::as_str) != Some(self.session.as_str())
            || header.get("cwd").and_then(Value::as_str).map(Path::new) != Some(self.cwd.as_path())
        {
            return Err(protocol_error(
                "Pi transcript does not belong to this session and workspace",
            ));
        }
        Ok(true)
    }

    pub(crate) async fn catalog(&self, state: &SessionState) -> Result<Value, Error> {
        let response = self
            .rpc
            .request("get_available_models", json!({}))
            .await
            .map_err(store_error)?;
        let levels = self
            .rpc
            .request("get_available_thinking_levels", json!({}))
            .await
            .map_err(store_error)?;
        let levels = levels
            .get("levels")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol_error("Pi thinking catalog missing"))?;
        let models = response
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| protocol_error("Pi model catalog missing"))?;
        let mut catalog = Vec::new();
        for model in models {
            let provider = field(model, "provider")?;
            let id = field(model, "id")?;
            let value = format!("{provider}/{id}");
            AgentSpawnModelSelectionV1::parse(&value).map_err(store_error)?;
            let current = model.get("provider") == state.model.get("provider")
                && model.get("id") == state.model.get("id");
            let supported = if current { levels.clone() } else { Vec::new() };
            catalog.push(json!({"value":value,"displayName":model.get("name").and_then(Value::as_str).unwrap_or(id),"supportsEffort":current && supported.len() > 1,"supportedEffortLevels":supported}));
        }
        Ok(json!({"schemaVersion":1,"models":catalog}))
    }
}

pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| protocol_error(format!("Pi record lacks {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_partial_ids_and_path_lookup() {
        for id in [
            "abc123",
            "latest",
            "../session.jsonl",
            "f4be7e67-9d77-492b-9f6e-a0bc4bf968aZ",
        ] {
            assert!(SessionId::parse(id).is_err());
        }
        assert!(SessionId::parse("f4be7e67-9d77-492b-9f6e-a0bc4bf968a1").is_ok());
    }
}
