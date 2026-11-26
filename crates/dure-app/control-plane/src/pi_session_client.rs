use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use dure_app::{AgentInteractionBindingV1, AgentSpawnModelSelectionV1};
use dure_provider_profile::transcript::bounded_suffix_records;
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

/// How much of a session's newest history an attach reads. These are the
/// bounds one answer of the whole history had, so a session that opened in
/// Chat opens with the same history, and a longer one with its newest
/// history instead of not at all.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HistoryWindowBounds {
    pub(crate) entries: usize,
    pub(crate) bytes: u64,
}

impl HistoryWindowBounds {
    pub(crate) const ATTACH: Self = Self {
        entries: 16_384,
        bytes: 64 * 1024 * 1024,
    };
}

/// Entries of the selected session, in the order Pi appended them.
pub(crate) struct Entries {
    pub(crate) entries: Vec<Value>,
    pub(crate) leaf_id: Option<String>,
    /// Whether the session holds entries older than `entries`, which a
    /// window leaves out.
    pub(crate) omits_older: bool,
    /// Where the entries read from the session's transcript start in it, by
    /// entry id. The entries Pi answered after them have none.
    pub(crate) offsets: BTreeMap<String, u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntriesAnswer {
    entries: Vec<Value>,
    leaf_id: Option<String>,
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

    /// The session's newest entries: the newest window of its transcript
    /// within `bounds`, then what Pi appended after it. Pi writes every entry
    /// to its transcript as it records it, so the window and Pi's answer meet
    /// at the window's newest entry. Pi writes a transcript only once the
    /// session holds an answer; before that, Pi's answer holds all of it.
    pub(crate) async fn history(
        &self,
        state: &SessionState,
        bounds: HistoryWindowBounds,
    ) -> Result<Entries, Error> {
        let mut entries = match self.transcript(state)? {
            Some((mut file, header_end)) => newest_entries(&mut file, header_end, bounds)?,
            None => Entries {
                entries: Vec::new(),
                leaf_id: None,
                omits_older: false,
                offsets: BTreeMap::new(),
            },
        };
        self.read_newer(&mut entries).await?;
        Ok(entries)
    }

    /// Adds the entries Pi appended after the newest of `entries`, or all of
    /// them when it holds none, and Pi's current leaf.
    pub(crate) async fn read_newer(&self, entries: &mut Entries) -> Result<(), Error> {
        let params = match entries.entries.last() {
            Some(newest) => json!({"since": field(newest, "id")?}),
            None => json!({}),
        };
        let answer: EntriesAnswer = serde_json::from_value(
            self.rpc
                .request("get_entries", params)
                .await
                .map_err(store_error)?,
        )
        .map_err(store_error)?;
        if answer.entries.len() > HistoryWindowBounds::ATTACH.entries {
            return Err(protocol_error("Pi history entry limit exceeded"));
        }
        entries.entries.extend(answer.entries);
        entries.leaf_id = answer.leaf_id;
        Ok(())
    }

    /// Pi creates its transcript only after the first assistant message. An
    /// empty, fresh runtime may remain unmaterialized; exact resume may not.
    pub(crate) fn is_materialized(&self, state: &SessionState) -> Result<bool, Error> {
        Ok(self.transcript(state)?.is_some())
    }

    /// The session's own transcript, once Pi has written it, and where its
    /// entries start after the session header.
    fn transcript(&self, state: &SessionState) -> Result<Option<(std::fs::File, u64)>, Error> {
        let mut file = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&state.session_file)
        {
            Ok(file) => file,
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && !self.requires_persisted_session =>
            {
                return Ok(None);
            }
            Err(error) => return Err(store_error(error)),
        };
        let metadata = file.metadata().map_err(store_error)?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(protocol_error("Pi transcript ownership is invalid"));
        }
        let mut header = Vec::new();
        std::io::BufReader::new((&mut file).take(65537))
            .read_until(b'\n', &mut header)
            .map_err(store_error)?;
        if header.len() > 65536 {
            return Err(protocol_error("Pi session header limit exceeded"));
        }
        let header_end = header.len() as u64;
        let header: Value = serde_json::from_slice(&header).map_err(store_error)?;
        if header.get("type").and_then(Value::as_str) != Some("session")
            || header.get("id").and_then(Value::as_str) != Some(self.session.as_str())
            || header.get("cwd").and_then(Value::as_str).map(Path::new) != Some(self.cwd.as_path())
        {
            return Err(protocol_error(
                "Pi transcript does not belong to this session and workspace",
            ));
        }
        Ok(Some((file, header_end)))
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

/// The newest whole entries of a transcript whose entries start at
/// `header_end`, within `bounds`. Pi may still be appending, so an
/// unfinished last record is left for Pi's answer after the window. Lines Pi
/// skips when it loads a transcript are skipped too.
fn newest_entries(
    file: &mut std::fs::File,
    header_end: u64,
    bounds: HistoryWindowBounds,
) -> Result<Entries, Error> {
    let len = file.metadata().map_err(store_error)?.len();
    let (start, bytes) = bounded_suffix_records(file, len, bounds.bytes).map_err(store_error)?;
    let mut omits_older = start > header_end;
    let mut entries = VecDeque::new();
    let mut offset = start;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let line_offset = offset;
        offset += line.len() as u64;
        let Some(line) = line.strip_suffix(b"\n") else {
            break;
        };
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        entries.push_back((line_offset, entry));
        if entries.len() > bounds.entries {
            entries.pop_front();
            omits_older = true;
        }
    }
    let offsets = entries
        .iter()
        .filter_map(|(offset, entry)| Some((entry.get("id")?.as_str()?.to_owned(), *offset)))
        .collect();
    Ok(Entries {
        entries: entries.into_iter().map(|(_, entry)| entry).collect(),
        leaf_id: None,
        omits_older,
        offsets,
    })
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

    fn ids(entries: &Entries) -> Vec<&str> {
        entries
            .entries
            .iter()
            .map(|entry| entry["id"].as_str().unwrap())
            .collect()
    }

    /// The newest window holds whole entries within its bounds, in the order
    /// Pi appended them, and says whether it left older ones out.
    #[test]
    fn a_window_reads_the_newest_whole_entries_within_its_bounds() {
        use std::io::Write;
        let records = (0..4)
            .map(|index| {
                format!(
                    "{}\n",
                    json!({"type":"message","id":format!("e{index}"),"parentId":null})
                )
            })
            .collect::<Vec<_>>();
        let header = format!("{}\n", json!({"type":"session","id":"s","cwd":"/w"}));
        // Pi skips a malformed line when it loads a transcript, and a record
        // it is still writing reaches Dure through its answer instead.
        let (malformed, writing) = ("{\"type\":\n", "{\"type\":\"message\",\"id\":\"e4\"");
        let mut file = tempfile::NamedTempFile::new().unwrap();
        write!(
            file,
            "{header}{}{}{malformed}{}{}{writing}",
            records[0], records[1], records[2], records[3]
        )
        .unwrap();
        let header_end = header.len() as u64;
        let len = file.as_file().metadata().unwrap().len();
        let read = |entries, bytes| {
            newest_entries(
                &mut file.reopen().unwrap(),
                header_end,
                HistoryWindowBounds { entries, bytes },
            )
            .unwrap()
        };

        let whole = read(16, len);
        assert_eq!(ids(&whole), ["e0", "e1", "e2", "e3"]);
        assert!(!whole.omits_older, "a window from the first entry is whole");
        let from_first = read(16, len - header_end);
        assert_eq!(ids(&from_first), ["e0", "e1", "e2", "e3"]);
        assert!(!from_first.omits_older);

        let last_two = (records[2].len() + records[3].len() + writing.len()) as u64;
        let newest = read(16, last_two);
        assert_eq!(ids(&newest), ["e2", "e3"]);
        assert!(newest.omits_older);
        // Each entry read keeps where its record starts in the transcript.
        let e2 = (header.len() + records[0].len() + records[1].len() + malformed.len()) as u64;
        assert_eq!(
            newest.offsets,
            BTreeMap::from([
                ("e2".to_string(), e2),
                ("e3".to_string(), e2 + records[2].len() as u64),
            ])
        );
        let inside = read(16, last_two - 1);
        assert_eq!(ids(&inside), ["e3"], "only whole records are read");

        let counted = read(3, len);
        assert_eq!(ids(&counted), ["e1", "e2", "e3"]);
        assert!(counted.omits_older);
    }
}
