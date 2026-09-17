use super::{DiscoveryError, DiscoveryKey, ReadyManifest};
use crate::local_protocol::{RecoveredPresentation, ScreenSnapshot, SessionFence};
use crate::terminal_replay::{
    TerminalCheckpoint, TerminalCheckpointEncoding, TerminalColdHistoryCheckpoint,
};
use serde::{Deserialize, Serialize};
use std::fmt;

const PRESENTATION_CHECKPOINT_SCHEMA_VERSION: u16 = 3;
const LEGACY_PRESENTATION_CHECKPOINT_SCHEMA_VERSION: u16 = 1;
const ENGINE_NATIVE_PRESENTATION_CHECKPOINT_SCHEMA_VERSION: u16 = 2;
pub const PRESENTATION_CHECKPOINT_MAX_BYTES: usize = 8 * 1024 * 1024;
const PRESENTATION_STATE_MAX_BYTES: usize = 7 * 1024 * 1024;
const IDENTIFIER_MAX_BYTES: usize = 256;
const MAX_ROWS: u16 = 512;
const MAX_COLUMNS: u16 = 1024;
const MAX_CELLS: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationCheckpointHandoff {
    file_id: String,
    checkpoint_digest: [u8; 32],
}

impl PresentationCheckpointHandoff {
    pub(super) fn new(file_id: String, checkpoint_digest: [u8; 32]) -> Self {
        Self {
            file_id,
            checkpoint_digest,
        }
    }

    pub fn validate(&self) -> Result<(), DiscoveryError> {
        let valid_component = |component: &str| {
            component.len() == 64
                && component
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        };
        let digest_matches = |encoded: &str| {
            encoded
                .as_bytes()
                .chunks_exact(2)
                .zip(self.checkpoint_digest)
                .all(|(pair, expected)| {
                    let nibble = |byte| match byte {
                        b'0'..=b'9' => Some(byte - b'0'),
                        b'a'..=b'f' => Some(byte - b'a' + 10),
                        _ => None,
                    };
                    nibble(pair[0])
                        .zip(nibble(pair[1]))
                        .is_some_and(|(high, low)| (high << 4) | low == expected)
                })
        };
        let Some((source_identity, checkpoint_digest)) = self.file_id.split_once('-') else {
            return Err(invalid("presentation handoff id"));
        };
        if !valid_component(source_identity)
            || !valid_component(checkpoint_digest)
            || !digest_matches(checkpoint_digest)
        {
            return Err(invalid("presentation handoff id"));
        }
        Ok(())
    }

    #[must_use]
    pub fn file_id(&self) -> &str {
        &self.file_id
    }

    #[must_use]
    pub fn checkpoint_digest(&self) -> [u8; 32] {
        self.checkpoint_digest
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationCheckpointSource {
    workspace_id: String,
    session_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
}

impl PresentationCheckpointSource {
    pub fn from_ready(manifest: &ReadyManifest) -> Self {
        Self {
            workspace_id: manifest.common.lifetime.workspace_id.clone(),
            session_id: manifest.common.lifetime.session_id.clone(),
            runner_principal: manifest.common.lifetime.runner_principal.clone(),
            runner_instance: manifest.common.lifetime.runner_instance.clone(),
            channel_epoch: manifest.common.lifetime.channel_epoch,
            host_instance_id: manifest.common.host_instance_id.clone(),
            terminal_epoch: manifest.terminal_epoch.clone(),
        }
    }

    pub fn new(
        workspace_id: impl Into<String>,
        session_id: impl Into<String>,
        runner_principal: impl Into<String>,
        runner_instance: impl Into<String>,
        channel_epoch: u64,
        host_instance_id: impl Into<String>,
        terminal_epoch: impl Into<String>,
    ) -> Result<Self, DiscoveryError> {
        let source = Self {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            runner_principal: runner_principal.into(),
            runner_instance: runner_instance.into(),
            channel_epoch,
            host_instance_id: host_instance_id.into(),
            terminal_epoch: terminal_epoch.into(),
        };
        source.validate()?;
        Ok(source)
    }

    pub fn validate(&self) -> Result<(), DiscoveryError> {
        for (field, value) in [
            ("workspace id", self.workspace_id.as_str()),
            ("session id", self.session_id.as_str()),
            ("runner principal", self.runner_principal.as_str()),
            ("runner instance", self.runner_instance.as_str()),
            ("host instance id", self.host_instance_id.as_str()),
            ("terminal epoch", self.terminal_epoch.as_str()),
        ] {
            if value.is_empty() || value.len() > IDENTIFIER_MAX_BYTES {
                return Err(invalid(field));
            }
        }
        if self.channel_epoch == 0 {
            return Err(invalid("channel epoch"));
        }
        Ok(())
    }

    pub fn discovery_key(&self) -> Result<DiscoveryKey, DiscoveryError> {
        Ok(DiscoveryKey::new(
            self.workspace_id.clone(),
            self.session_id.clone(),
            self.runner_instance.clone(),
            self.channel_epoch,
        )?)
    }

    #[must_use]
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn runner_principal(&self) -> &str {
        &self.runner_principal
    }

    #[must_use]
    pub fn runner_instance(&self) -> &str {
        &self.runner_instance
    }

    #[must_use]
    pub fn channel_epoch(&self) -> u64 {
        self.channel_epoch
    }

    #[must_use]
    pub fn host_instance_id(&self) -> &str {
        &self.host_instance_id
    }

    #[must_use]
    pub fn terminal_epoch(&self) -> &str {
        &self.terminal_epoch
    }

    #[must_use]
    pub fn fence(&self) -> SessionFence {
        SessionFence {
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
            runner_principal: self.runner_principal.clone(),
            runner_instance: self.runner_instance.clone(),
            channel_epoch: self.channel_epoch,
            host_instance_id: self.host_instance_id.clone(),
            terminal_epoch: self.terminal_epoch.clone(),
        }
    }

    #[must_use]
    pub fn matches_fence(&self, fence: &SessionFence) -> bool {
        self.fence() == *fence
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PresentationCheckpointEncoding {
    AnsiRedrawV1,
    EngineNativeV1,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationCheckpoint {
    schema_version: u16,
    source: PresentationCheckpointSource,
    sequence_through: u64,
    rows: u16,
    columns: u16,
    encoding: PresentationCheckpointEncoding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state_revision: Option<u64>,
    #[serde(
        rename = "stateBytes",
        alias = "repaintBytes",
        with = "crate::local_protocol::json_bytes"
    )]
    state_bytes: Vec<u8>,
    alternate_screen: bool,
    cursor_visible: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cold_history: Option<TerminalColdHistoryCheckpoint>,
    truncated: bool,
    captured_unix_ms: u64,
}

impl fmt::Debug for PresentationCheckpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PresentationCheckpoint")
            .field("schema_version", &self.schema_version)
            .field("source", &self.source)
            .field("sequence_through", &self.sequence_through)
            .field("rows", &self.rows)
            .field("columns", &self.columns)
            .field("encoding", &self.encoding)
            .field("engine_fingerprint", &self.engine_fingerprint)
            .field("state_revision", &self.state_revision)
            .field("state_bytes_len", &self.state_bytes.len())
            .field("alternate_screen", &self.alternate_screen)
            .field("cursor_visible", &self.cursor_visible)
            .field("cold_history", &self.cold_history)
            .field("truncated", &self.truncated)
            .field("captured_unix_ms", &self.captured_unix_ms)
            .finish()
    }
}

impl PresentationCheckpoint {
    pub fn capture(
        snapshot: &ScreenSnapshot,
        captured_unix_ms: u64,
    ) -> Result<Self, DiscoveryError> {
        let checkpoint = Self {
            schema_version: PRESENTATION_CHECKPOINT_SCHEMA_VERSION,
            source: PresentationCheckpointSource {
                workspace_id: snapshot.fence.workspace_id.clone(),
                session_id: snapshot.fence.session_id.clone(),
                runner_principal: snapshot.fence.runner_principal.clone(),
                runner_instance: snapshot.fence.runner_instance.clone(),
                channel_epoch: snapshot.fence.channel_epoch,
                host_instance_id: snapshot.fence.host_instance_id.clone(),
                terminal_epoch: snapshot.fence.terminal_epoch.clone(),
            },
            sequence_through: snapshot.sequence_through,
            rows: snapshot.rows,
            columns: snapshot.columns,
            encoding: PresentationCheckpointEncoding::AnsiRedrawV1,
            engine_fingerprint: None,
            state_revision: None,
            state_bytes: snapshot.repaint_bytes.clone(),
            alternate_screen: snapshot.alternate_screen,
            cursor_visible: snapshot.cursor_visible,
            cold_history: None,
            truncated: snapshot.truncated,
            captured_unix_ms,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    pub fn capture_terminal(
        checkpoint: &TerminalCheckpoint,
        captured_unix_ms: u64,
    ) -> Result<Self, DiscoveryError> {
        let (encoding, engine_fingerprint) = match &checkpoint.encoding {
            TerminalCheckpointEncoding::LegacyAnsiRedrawV1 => {
                (PresentationCheckpointEncoding::AnsiRedrawV1, None)
            }
            TerminalCheckpointEncoding::EngineNativeV1 { engine_fingerprint } => (
                PresentationCheckpointEncoding::EngineNativeV1,
                Some(engine_fingerprint.clone()),
            ),
        };
        let checkpoint = Self {
            schema_version: PRESENTATION_CHECKPOINT_SCHEMA_VERSION,
            source: PresentationCheckpointSource {
                workspace_id: checkpoint.fence.workspace_id.clone(),
                session_id: checkpoint.fence.session_id.clone(),
                runner_principal: checkpoint.fence.runner_principal.clone(),
                runner_instance: checkpoint.fence.runner_instance.clone(),
                channel_epoch: checkpoint.fence.channel_epoch,
                host_instance_id: checkpoint.fence.host_instance_id.clone(),
                terminal_epoch: checkpoint.fence.terminal_epoch.clone(),
            },
            sequence_through: checkpoint.sequence_through,
            rows: checkpoint.rows,
            columns: checkpoint.columns,
            encoding,
            engine_fingerprint,
            state_revision: Some(checkpoint.state_revision),
            state_bytes: checkpoint.payload.clone(),
            alternate_screen: checkpoint.alternate_screen,
            cursor_visible: checkpoint.cursor_visible,
            cold_history: checkpoint.cold_history.clone(),
            truncated: false,
            captured_unix_ms,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    pub fn validate(&self) -> Result<(), DiscoveryError> {
        if !matches!(
            self.schema_version,
            LEGACY_PRESENTATION_CHECKPOINT_SCHEMA_VERSION
                | ENGINE_NATIVE_PRESENTATION_CHECKPOINT_SCHEMA_VERSION
                | PRESENTATION_CHECKPOINT_SCHEMA_VERSION
        ) {
            return Err(invalid("schema version"));
        }
        self.source.validate()?;
        if self.rows == 0
            || self.columns == 0
            || self.rows > MAX_ROWS
            || self.columns > MAX_COLUMNS
            || usize::from(self.rows) * usize::from(self.columns) > MAX_CELLS
        {
            return Err(invalid("terminal dimensions"));
        }
        if self.state_bytes.is_empty() || self.state_bytes.len() > PRESENTATION_STATE_MAX_BYTES {
            return Err(invalid("terminal state bytes"));
        }
        match self.encoding {
            PresentationCheckpointEncoding::AnsiRedrawV1 => {
                if self.engine_fingerprint.is_some() || self.cold_history.is_some() {
                    return Err(invalid("legacy engine fingerprint"));
                }
            }
            PresentationCheckpointEncoding::EngineNativeV1 => {
                if self.schema_version < ENGINE_NATIVE_PRESENTATION_CHECKPOINT_SCHEMA_VERSION
                    || self.engine_fingerprint.as_deref().is_none_or(str::is_empty)
                    || self.state_revision.is_none_or(|revision| revision == 0)
                {
                    return Err(invalid("native terminal state authority"));
                }
                if self.cold_history.as_ref().is_some_and(|checkpoint| {
                    self.schema_version != PRESENTATION_CHECKPOINT_SCHEMA_VERSION
                        || checkpoint.validate().is_err()
                }) {
                    return Err(invalid("cold terminal history authority"));
                }
            }
        }
        if self.captured_unix_ms == 0 {
            return Err(invalid("capture time"));
        }
        Ok(())
    }

    #[must_use]
    pub fn source(&self) -> &PresentationCheckpointSource {
        &self.source
    }

    #[must_use]
    pub fn cold_history_identity(&self) -> Option<(&str, &str)> {
        self.cold_history.as_ref().map(|checkpoint| {
            (
                checkpoint.history_namespace.as_str(),
                checkpoint.store_id.as_str(),
            )
        })
    }

    #[must_use]
    pub fn sequence_through(&self) -> u64 {
        self.sequence_through
    }

    #[must_use]
    pub fn state_revision(&self) -> Option<u64> {
        self.state_revision
    }

    #[must_use]
    pub fn rows(&self) -> u16 {
        self.rows
    }

    #[must_use]
    pub fn columns(&self) -> u16 {
        self.columns
    }

    #[must_use]
    pub fn terminal_checkpoint(&self) -> TerminalCheckpoint {
        let encoding = match &self.encoding {
            PresentationCheckpointEncoding::AnsiRedrawV1 => {
                TerminalCheckpointEncoding::LegacyAnsiRedrawV1
            }
            PresentationCheckpointEncoding::EngineNativeV1 => {
                TerminalCheckpointEncoding::EngineNativeV1 {
                    engine_fingerprint: self.engine_fingerprint.clone().unwrap_or_default(),
                }
            }
        };
        TerminalCheckpoint {
            fence: self.source.fence(),
            sequence_through: self.sequence_through,
            state_revision: self.state_revision.unwrap_or(1),
            rows: self.rows,
            columns: self.columns,
            encoding,
            payload: self.state_bytes.clone(),
            alternate_screen: self.alternate_screen,
            cursor_visible: self.cursor_visible,
            cold_history: self.cold_history.clone(),
        }
    }

    #[must_use]
    pub fn recovered_presentation(&self) -> RecoveredPresentation {
        RecoveredPresentation {
            source_fence: self.source.fence(),
            sequence_through: self.sequence_through,
            captured_unix_ms: self.captured_unix_ms,
            truncated: self.truncated,
        }
    }

    #[cfg(feature = "ghostty-core-proof")]
    pub(crate) fn with_cold_history(
        mut self,
        cold_history: Option<TerminalColdHistoryCheckpoint>,
    ) -> Result<Self, DiscoveryError> {
        self.cold_history = cold_history;
        self.validate()?;
        Ok(self)
    }
}

fn invalid(reason: &'static str) -> DiscoveryError {
    DiscoveryError::PresentationCheckpointInvalid { reason }
}
