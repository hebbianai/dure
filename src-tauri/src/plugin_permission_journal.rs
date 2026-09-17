//! Bounded permission-journal codec and validated in-memory projection.
//!
//! Legacy schema-1 files remain append-only JSONL until byte pressure triggers
//! schema 2. Schema 2 starts with a small capability manifest, then one
//! SHA-256-bound checkpoint payload, followed by ordinary schema-1 event tail
//! lines whose sequence continues the lifetime logical count. Compaction never
//! resets the 8,192 global or 4,096 per-key regular-event limits. A legacy
//! disable admitted only because of its byte offset becomes ordinary compacted
//! history; the byte reserve is physical, while logical counts and the proven
//! Enabled-to-Disabled transition remain unchanged.

use super::*;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct JournalEnvelope<T> {
    pub(super) schema_version: u16,
    pub(super) seq: u64,
    pub(super) event: T,
}

#[derive(Debug)]
pub(super) struct ParsedJournalEnvelope<T> {
    pub(super) envelope: JournalEnvelope<T>,
    pub(super) end_offset: usize,
}

pub(super) const COMPACT_JOURNAL_SCHEMA_VERSION: u16 = 2;
pub(super) const COMPACT_JOURNAL_READER_CAPABILITY: &str =
    "dure.plugin-permission-journal.compact-v2.sha256-review-v2";
pub(super) const COMPACT_JOURNAL_WRITER_CAPABILITY: &str =
    "dure.plugin-permission-journal.compact-v2.sha256-review-v2";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct CompactJournalEventReference {
    pub(super) checkpoint_index: u16,
    pub(super) record_revision: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct CompactJournalManifest {
    schema_version: u16,
    required_reader_capability: String,
    required_writer_capability: String,
    generation: u64,
    logical_event_count: u64,
    payload_len: u64,
    payload_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct CompactJournalPayload {
    checkpoints: Vec<PluginPermissionDecisionFoldCheckpointV2>,
    event_order: Vec<CompactJournalEventReference>,
}

pub(super) fn journal_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(super) fn parse_journal<T>(bytes: &[u8]) -> StoreResult<Vec<ParsedJournalEnvelope<T>>>
where
    T: for<'de> Deserialize<'de>,
{
    parse_journal_segment(bytes, 1, 0, 0, MAX_JOURNAL_EVENTS)
}

pub(super) fn parse_journal_segment<T>(
    bytes: &[u8],
    first_sequence: u64,
    line_offset: usize,
    initial_end_offset: usize,
    maximum_events: usize,
) -> StoreResult<Vec<ParsedJournalEnvelope<T>>>
where
    T: for<'de> Deserialize<'de>,
{
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut events = Vec::new();
    let mut end_offset = initial_end_offset;
    for (index, encoded_line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
        let line_number = line_offset
            .checked_add(index)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| invalid_journal("permission journal line number overflow"))?;
        if encoded_line.len() > MAX_JOURNAL_LINE_BYTES {
            return Err(too_large(format!(
                "permission journal line {} exceeds {MAX_JOURNAL_LINE_BYTES} bytes",
                line_number
            )));
        }
        if encoded_line == b"\n" {
            return Err(invalid_journal(format!(
                "permission journal line {} is empty",
                line_number
            )));
        }
        if events.len() == maximum_events {
            return Err(too_large(format!(
                "permission journal exceeds {MAX_JOURNAL_EVENTS} events"
            )));
        }
        let envelope =
            serde_json::from_slice::<JournalEnvelope<T>>(&encoded_line[..encoded_line.len() - 1])
                .map_err(|error| {
                invalid_journal(format!(
                    "permission journal line {} is malformed: {error}",
                    line_number
                ))
            })?;
        if envelope.schema_version != JOURNAL_SCHEMA_VERSION {
            return Err(invalid_journal(format!(
                "permission journal line {} uses unsupported schema {}",
                line_number, envelope.schema_version
            )));
        }
        let expected_seq = u64::try_from(index)
            .ok()
            .and_then(|value| first_sequence.checked_add(value))
            .ok_or_else(|| invalid_journal("permission journal sequence overflow"))?;
        if envelope.seq != expected_seq {
            return Err(invalid_journal(format!(
                "permission journal line {} has sequence {}, expected {expected_seq}",
                line_number, envelope.seq
            )));
        }
        end_offset = end_offset
            .checked_add(encoded_line.len())
            .ok_or_else(|| too_large("permission journal length overflow"))?;
        events.push(ParsedJournalEnvelope {
            envelope,
            end_offset,
        });
    }
    Ok(events)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum JournalAppendAdmission {
    Regular,
    EmergencyDisable,
}

pub(super) fn append_envelope<T>(
    journal: &mut LockedJournal,
    format: PermissionJournalFormat,
    event_count: usize,
    event: &T,
) -> StoreResult<()>
where
    T: Serialize,
{
    append_envelope_with_admission(
        journal,
        format,
        event_count,
        event,
        JournalAppendAdmission::Regular,
    )
}

pub(super) fn append_envelope_with_admission<T>(
    journal: &mut LockedJournal,
    format: PermissionJournalFormat,
    event_count: usize,
    event: &T,
    admission: JournalAppendAdmission,
) -> StoreResult<()>
where
    T: Serialize,
{
    if admission == JournalAppendAdmission::Regular && event_count >= MAX_ACTIVE_JOURNAL_EVENTS {
        return Err(active_capacity_exhausted(
            "permission journal requires compaction before another regular event",
        ));
    }
    if event_count >= MAX_JOURNAL_EVENTS {
        return Err(too_large(format!(
            "permission journal reached {MAX_JOURNAL_EVENTS} events"
        )));
    }
    let encoded = encode_envelope(event_count, event)?;
    let next_len = journal
        .bytes
        .len()
        .checked_add(encoded.len())
        .ok_or_else(|| too_large("permission journal length overflow"))?;
    if admission == JournalAppendAdmission::Regular && next_len as u64 > format.active_byte_limit()
    {
        return Err(active_capacity_exhausted(
            "permission journal requires compaction before another regular event",
        ));
    }
    if next_len as u64 > MAX_JOURNAL_BYTES {
        return Err(too_large("permission journal requires explicit compaction"));
    }
    let mut replacement = Vec::with_capacity(next_len);
    replacement.extend_from_slice(&journal.bytes);
    replacement.extend_from_slice(&encoded);
    journal.replace_bytes(replacement)
}

pub(super) fn encode_envelope<T>(event_count: usize, event: &T) -> StoreResult<Vec<u8>>
where
    T: Serialize,
{
    let seq = u64::try_from(event_count)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| too_large("permission journal sequence overflow"))?;
    let envelope = JournalEnvelope {
        schema_version: JOURNAL_SCHEMA_VERSION,
        seq,
        event,
    };
    let mut encoded = serde_json::to_vec(&envelope).map_err(|error| {
        PluginPermissionStoreError::new("plugin_permission_journal_encode_failed", error)
    })?;
    encoded.push(b'\n');
    if encoded.len() > MAX_JOURNAL_LINE_BYTES {
        return Err(too_large(format!(
            "permission journal event exceeds {MAX_JOURNAL_LINE_BYTES} bytes"
        )));
    }
    Ok(encoded)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum PermissionJournalFormat {
    Legacy,
    Compact { generation: u64 },
}

impl PermissionJournalFormat {
    pub(super) fn generation(self) -> u64 {
        match self {
            Self::Legacy => 0,
            Self::Compact { generation } => generation,
        }
    }

    pub(super) fn active_byte_limit(self) -> u64 {
        let production = match self {
            Self::Legacy => MAX_ACTIVE_JOURNAL_BYTES,
            Self::Compact { .. } => MAX_COMPACT_ACTIVE_JOURNAL_BYTES,
        };
        #[cfg(test)]
        if let Some((legacy, compact)) = TEST_ACTIVE_JOURNAL_BYTE_LIMITS.with(Cell::get) {
            return match self {
                Self::Legacy => legacy,
                Self::Compact { .. } => compact,
            };
        }
        production
    }

    pub(super) fn next_generation(self) -> StoreResult<u64> {
        match self {
            Self::Legacy => Ok(1),
            Self::Compact { generation } => generation
                .checked_add(1)
                .ok_or_else(|| too_large("permission journal compaction generation overflow")),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JournalSchemaProbe {
    schema_version: u16,
}

pub(super) struct LoadedPermissionJournal {
    pub(super) format: PermissionJournalFormat,
    pub(super) event_count: usize,
    pub(super) folds: Vec<PluginPermissionDecisionFoldV2>,
    pub(super) key_event_counts: Vec<usize>,
    pub(super) event_order: Vec<CompactJournalEventReference>,
}

impl LoadedPermissionJournal {
    pub(super) fn empty(format: PermissionJournalFormat) -> Self {
        Self {
            format,
            event_count: 0,
            folds: Vec::new(),
            key_event_counts: Vec::new(),
            event_order: Vec::new(),
        }
    }

    pub(super) fn read(journal: &LockedJournal) -> StoreResult<Self> {
        Self::read_bytes(&journal.bytes)
    }

    pub(super) fn read_bytes(bytes: &[u8]) -> StoreResult<Self> {
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(too_large(
                "permission journal exceeds its physical byte bound",
            ));
        }
        if bytes.is_empty() {
            return Ok(Self::empty(PermissionJournalFormat::Legacy));
        }
        let header_end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .and_then(|index| index.checked_add(1))
            .ok_or_else(|| invalid_journal("permission journal header is incomplete"))?;
        let first_line = &bytes[..header_end - 1];
        let probe = serde_json::from_slice::<JournalSchemaProbe>(first_line).map_err(|error| {
            invalid_journal(format!("permission journal header is malformed: {error}"))
        })?;
        match probe.schema_version {
            JOURNAL_SCHEMA_VERSION => {
                if bytes.len() as u64 > MAX_LEGACY_JOURNAL_BYTES {
                    return Err(too_large(
                        "legacy permission journal exceeds its physical byte bound",
                    ));
                }
                Self::read_legacy(bytes)
            }
            COMPACT_JOURNAL_SCHEMA_VERSION => {
                Self::read_compact(first_line, &bytes[header_end..], header_end)
            }
            version => Err(invalid_journal(format!(
                "permission journal uses unsupported schema {version}"
            ))),
        }
    }

    pub(super) fn read_legacy(bytes: &[u8]) -> StoreResult<Self> {
        let envelopes = parse_journal::<PluginPermissionDecisionEventV2>(bytes)?;
        let mut loaded = Self::empty(PermissionJournalFormat::Legacy);
        for parsed in envelopes {
            loaded.apply_persisted_event(parsed)?;
        }
        Ok(loaded)
    }

    pub(super) fn read_compact(
        manifest_line: &[u8],
        payload_and_tail: &[u8],
        manifest_end: usize,
    ) -> StoreResult<Self> {
        if manifest_end > MAX_JOURNAL_LINE_BYTES {
            return Err(too_large(
                "permission journal compact manifest exceeds its line bound",
            ));
        }
        let manifest =
            serde_json::from_slice::<CompactJournalManifest>(manifest_line).map_err(|error| {
                invalid_journal(format!(
                    "permission journal compact manifest is malformed: {error}"
                ))
            })?;
        if manifest.schema_version != COMPACT_JOURNAL_SCHEMA_VERSION
            || manifest.required_reader_capability != COMPACT_JOURNAL_READER_CAPABILITY
            || manifest.required_writer_capability != COMPACT_JOURNAL_WRITER_CAPABILITY
            || manifest.generation == 0
        {
            return Err(invalid_journal(
                "permission journal compact checkpoint requires an unsupported capability",
            ));
        }
        let payload_end = payload_and_tail
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| invalid_journal("permission journal compact payload is incomplete"))?;
        let payload_line = &payload_and_tail[..payload_end];
        if payload_line.len() as u64 != manifest.payload_len
            || journal_sha256(payload_line) != manifest.payload_sha256
        {
            return Err(invalid_journal(
                "permission journal compact payload does not match its manifest",
            ));
        }
        let compact_prefix_end = manifest_end
            .checked_add(payload_end)
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| too_large("permission journal compact prefix length overflow"))?;
        if compact_prefix_end as u64 > MAX_COMPACT_ACTIVE_JOURNAL_BYTES {
            return Err(too_large(
                "permission journal compact checkpoint exceeds its active byte bound",
            ));
        }
        let payload =
            serde_json::from_slice::<CompactJournalPayload>(payload_line).map_err(|error| {
                invalid_journal(format!(
                    "permission journal compact payload is malformed: {error}"
                ))
            })?;
        if payload.checkpoints.len() > MAX_PERMISSION_KEYS {
            return Err(too_large(format!(
                "permission journal exceeds {MAX_PERMISSION_KEYS} keys"
            )));
        }
        let logical_event_count = usize::try_from(manifest.logical_event_count)
            .map_err(|_| too_large("permission journal logical event count overflow"))?;
        if logical_event_count > MAX_JOURNAL_EVENTS {
            return Err(too_large(format!(
                "permission journal exceeds {MAX_JOURNAL_EVENTS} events"
            )));
        }

        let mut loaded = Self::empty(PermissionJournalFormat::Compact {
            generation: manifest.generation,
        });
        let mut previous_key: Option<&PluginPermissionDecisionKeyV2> = None;
        for checkpoint in &payload.checkpoints {
            if previous_key.is_some_and(|key| key >= checkpoint.key()) {
                return Err(invalid_journal(
                    "permission journal compact checkpoints are not in canonical key order",
                ));
            }
            if loaded
                .folds
                .iter()
                .any(|fold| fold.state().key() == checkpoint.key())
            {
                return Err(invalid_journal(
                    "permission journal compact checkpoint repeats a permission key",
                ));
            }
            let observed = checkpoint.observed_event_count();
            if observed == 0
                || observed > MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
                || observed != checkpoint.replay_receipts().len()
            {
                return Err(invalid_journal(
                    "permission journal compact checkpoint has inconsistent request history",
                ));
            }
            let fold = PluginPermissionDecisionFoldV2::from_checkpoint(checkpoint).map_err(
                |error| {
                    invalid_journal(format!(
                        "permission journal compact checkpoint violates the decision contract: {error}"
                    ))
                },
            )?;
            loaded.folds.push(fold);
            loaded.key_event_counts.push(observed);
            previous_key = Some(checkpoint.key());
        }
        let checkpoint_event_count =
            loaded
                .key_event_counts
                .iter()
                .try_fold(0usize, |total, count| {
                    total
                        .checked_add(*count)
                        .ok_or_else(|| too_large("permission journal logical event count overflow"))
                })?;
        if checkpoint_event_count != logical_event_count
            || payload.event_order.len() != logical_event_count
        {
            return Err(invalid_journal(
                "permission journal compact checkpoint event counts do not agree",
            ));
        }
        Self::validate_compact_event_order(
            &loaded.folds,
            &loaded.key_event_counts,
            &payload.event_order,
        )?;
        loaded.event_count = logical_event_count;
        loaded.event_order = payload.event_order;

        let remaining_events = MAX_JOURNAL_EVENTS
            .checked_sub(logical_event_count)
            .ok_or_else(|| too_large("permission journal logical event count overflow"))?;
        let first_sequence = manifest
            .logical_event_count
            .checked_add(1)
            .ok_or_else(|| too_large("permission journal sequence overflow"))?;
        let envelopes = parse_journal_segment::<PluginPermissionDecisionEventV2>(
            &payload_and_tail[payload_end + 1..],
            first_sequence,
            2,
            compact_prefix_end,
            remaining_events,
        )?;
        for parsed in envelopes {
            loaded.apply_persisted_event(parsed)?;
        }
        Ok(loaded)
    }

    pub(super) fn validate_compact_event_order(
        folds: &[PluginPermissionDecisionFoldV2],
        key_event_counts: &[usize],
        event_order: &[CompactJournalEventReference],
    ) -> StoreResult<()> {
        let mut observed = vec![0usize; folds.len()];
        let mut receipts_by_revision = folds
            .iter()
            .map(|fold| fold.prior_request_metadata().collect::<Vec<_>>())
            .collect::<Vec<_>>();
        for receipts in &mut receipts_by_revision {
            receipts.sort_by_key(|receipt| receipt.record_revision());
        }
        for (global_index, reference) in event_order.iter().enumerate() {
            let fold_index = usize::from(reference.checkpoint_index);
            if folds.get(fold_index).is_none() {
                return Err(invalid_journal(
                    "permission journal compact event order names an unknown checkpoint",
                ));
            }
            let next_key_event = observed[fold_index]
                .checked_add(1)
                .ok_or_else(|| too_large("permission journal key event count overflow"))?;
            let expected_record_revision = u64::try_from(next_key_event)
                .map_err(|_| too_large("permission journal key revision overflow"))?;
            if reference.record_revision != expected_record_revision {
                return Err(invalid_journal(
                    "permission journal compact event order is not contiguous per key",
                ));
            }
            let receipt = receipts_by_revision[fold_index]
                .get(next_key_event - 1)
                .copied()
                .ok_or_else(|| {
                    invalid_journal(
                        "permission journal compact event order names an unknown request",
                    )
                })?;
            if receipt.record_revision() != reference.record_revision {
                return Err(invalid_journal(
                    "permission journal compact event order names an unknown request",
                ));
            }
            if (global_index >= MAX_ACTIVE_JOURNAL_EVENTS
                || observed[fold_index] >= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2)
                && !receipt.explicit_enabled_to_disabled()
            {
                return Err(invalid_journal(format!(
                    "permission journal event {} consumes emergency capacity without disabling an enabled plugin",
                    global_index + 1
                )));
            }
            observed[fold_index] = next_key_event;
        }
        if observed != key_event_counts {
            return Err(invalid_journal(
                "permission journal compact event order does not cover every request",
            ));
        }
        Ok(())
    }

    pub(super) fn compacted_bytes(
        &self,
        required_tail_bytes: usize,
    ) -> StoreResult<(Vec<u8>, u64)> {
        if self.event_count != self.event_order.len()
            || self.folds.len() != self.key_event_counts.len()
        {
            return Err(invalid_journal(
                "permission journal in-memory event counts do not agree",
            ));
        }
        let generation = self.format.next_generation()?;
        let mut sorted_fold_indices = (0..self.folds.len()).collect::<Vec<_>>();
        sorted_fold_indices.sort_by(|left, right| {
            self.folds[*left]
                .state()
                .key()
                .cmp(self.folds[*right].state().key())
        });
        let mut remapped_indices = vec![0_u16; self.folds.len()];
        let mut checkpoints = Vec::with_capacity(self.folds.len());
        for (new_index, old_index) in sorted_fold_indices.into_iter().enumerate() {
            remapped_indices[old_index] = u16::try_from(new_index)
                .map_err(|_| too_large("permission journal key index overflow"))?;
            checkpoints.push(self.folds[old_index].checkpoint().map_err(|error| {
                invalid_journal(format!(
                    "permission journal cannot checkpoint a noncanonical fold: {error}"
                ))
            })?);
        }
        let event_order = self
            .event_order
            .iter()
            .map(|reference| {
                let old_index = usize::from(reference.checkpoint_index);
                let checkpoint_index =
                    remapped_indices.get(old_index).copied().ok_or_else(|| {
                        invalid_journal(
                            "permission journal event order names an unknown in-memory key",
                        )
                    })?;
                Ok(CompactJournalEventReference {
                    checkpoint_index,
                    record_revision: reference.record_revision,
                })
            })
            .collect::<StoreResult<Vec<_>>>()?;
        let payload = serde_json::to_vec(&CompactJournalPayload {
            checkpoints,
            event_order,
        })
        .map_err(|error| {
            PluginPermissionStoreError::new("plugin_permission_journal_encode_failed", error)
        })?;
        let manifest = CompactJournalManifest {
            schema_version: COMPACT_JOURNAL_SCHEMA_VERSION,
            required_reader_capability: COMPACT_JOURNAL_READER_CAPABILITY.to_owned(),
            required_writer_capability: COMPACT_JOURNAL_WRITER_CAPABILITY.to_owned(),
            generation,
            logical_event_count: u64::try_from(self.event_count)
                .map_err(|_| too_large("permission journal logical event count overflow"))?,
            payload_len: u64::try_from(payload.len())
                .map_err(|_| too_large("permission journal compact payload length overflow"))?,
            payload_sha256: journal_sha256(&payload),
        };
        let manifest = serde_json::to_vec(&manifest).map_err(|error| {
            PluginPermissionStoreError::new("plugin_permission_journal_encode_failed", error)
        })?;
        if manifest.len() + 1 > MAX_JOURNAL_LINE_BYTES {
            return Err(too_large(
                "permission journal compact manifest exceeds its line bound",
            ));
        }
        let compact_len = manifest
            .len()
            .checked_add(1)
            .and_then(|length| length.checked_add(payload.len()))
            .and_then(|length| length.checked_add(1))
            .ok_or_else(|| too_large("permission journal compact length overflow"))?;
        let required_len = compact_len
            .checked_add(required_tail_bytes)
            .ok_or_else(|| too_large("permission journal compact length overflow"))?;
        if required_len as u64 > MAX_COMPACT_ACTIVE_JOURNAL_BYTES {
            return Err(active_capacity_exhausted(
                "permission journal compact authority leaves no room for another regular event",
            ));
        }
        let mut encoded = Vec::with_capacity(compact_len);
        encoded.extend_from_slice(&manifest);
        encoded.push(b'\n');
        encoded.extend_from_slice(&payload);
        encoded.push(b'\n');
        let validated = Self::read_bytes(&encoded)?;
        if validated.event_count != self.event_count
            || self.folds.iter().any(|fold| {
                validated.key_event_count(fold.state().key())
                    != self.key_event_count(fold.state().key())
                    || validated.state(fold.state().key()) != fold.state().clone()
            })
        {
            return Err(invalid_journal(
                "permission journal compact target changed logical authority",
            ));
        }
        Ok((encoded, generation))
    }

    /// Re-derives the only canonical compact image that may replace `source`.
    /// Exact byte equality deliberately covers every replay receipt and the
    /// normalized global request order, not only the latest state per key.
    pub(super) fn validate_compaction_transition(
        source: &[u8],
        target: &[u8],
        claimed_generation: u64,
    ) -> StoreResult<()> {
        let source = Self::read_bytes(source)?;
        let (expected, expected_generation) = source.compacted_bytes(0)?;
        if claimed_generation != expected_generation || target != expected {
            return Err(invalid_journal(
                "permission journal compaction target is not the canonical next generation",
            ));
        }
        let target = Self::read_bytes(target)?;
        if target.format
            != (PermissionJournalFormat::Compact {
                generation: claimed_generation,
            })
        {
            return Err(invalid_journal(
                "permission journal compaction target generation is inconsistent",
            ));
        }
        Ok(())
    }

    pub(super) fn apply_persisted_event(
        &mut self,
        parsed: ParsedJournalEnvelope<PluginPermissionDecisionEventV2>,
    ) -> StoreResult<()> {
        let envelope = parsed.envelope;
        let key = envelope.event.key().clone();
        let fold_index = match self
            .folds
            .iter()
            .position(|fold| fold.state().key() == &key)
        {
            Some(index) => index,
            None => {
                if self.folds.len() >= MAX_PERMISSION_KEYS {
                    return Err(too_large(format!(
                        "permission journal exceeds {MAX_PERMISSION_KEYS} keys"
                    )));
                }
                self.folds.push(PluginPermissionDecisionFoldV2::new(key));
                self.key_event_counts.push(0);
                self.folds.len() - 1
            }
        };
        let consumes_emergency_reserve = self.event_count >= MAX_ACTIVE_JOURNAL_EVENTS
            || parsed.end_offset as u64 > self.format.active_byte_limit()
            || self.key_event_counts[fold_index] >= MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2;
        if consumes_emergency_reserve
            && (self.folds[fold_index].state().enablement()
                != PluginPermissionEnablementV2::Enabled
                || !matches!(
                    envelope.event.body(),
                    PluginPermissionDecisionEventBodyV2::Disabled
                ))
        {
            return Err(invalid_journal(format!(
                "permission journal event {} consumes emergency capacity without disabling an enabled plugin",
                self.event_count + 1
            )));
        }
        let application =
            apply_plugin_permission_decision_event(&mut self.folds[fold_index], &envelope.event)
                .map_err(|error| {
                    invalid_journal(format!(
                        "permission journal event {} violates the decision contract: {error}",
                        self.event_count + 1
                    ))
                })?;
        if application.disposition() == PluginPermissionDecisionEventDispositionV2::ExactReplay {
            return Err(invalid_journal(format!(
                "permission journal event {} duplicates a request that should not be appended",
                self.event_count + 1
            )));
        }
        self.key_event_counts[fold_index] = self.key_event_counts[fold_index]
            .checked_add(1)
            .ok_or_else(|| too_large("permission journal key event count overflow"))?;
        self.event_count = self
            .event_count
            .checked_add(1)
            .ok_or_else(|| too_large("permission journal event count overflow"))?;
        self.event_order.push(CompactJournalEventReference {
            checkpoint_index: u16::try_from(fold_index)
                .map_err(|_| too_large("permission journal key index overflow"))?,
            record_revision: envelope.event.record_revision(),
        });
        Ok(())
    }

    pub(super) fn state(
        &self,
        key: &PluginPermissionDecisionKeyV2,
    ) -> PluginPermissionDecisionStateV2 {
        self.folds
            .iter()
            .find(|fold| fold.state().key() == key)
            .map(|fold| fold.state().clone())
            .unwrap_or_else(|| PluginPermissionDecisionStateV2::initial(key.clone()))
    }

    pub(super) fn fold_mut(
        &mut self,
        key: &PluginPermissionDecisionKeyV2,
    ) -> StoreResult<&mut PluginPermissionDecisionFoldV2> {
        if let Some(index) = self.folds.iter().position(|fold| fold.state().key() == key) {
            return Ok(&mut self.folds[index]);
        }
        if self.folds.len() >= MAX_PERMISSION_KEYS {
            return Err(too_large(format!(
                "permission journal reached {MAX_PERMISSION_KEYS} keys"
            )));
        }
        self.folds
            .push(PluginPermissionDecisionFoldV2::new(key.clone()));
        self.key_event_counts.push(0);
        Ok(self.folds.last_mut().expect("fold was just inserted"))
    }

    pub(super) fn key_event_count(&self, key: &PluginPermissionDecisionKeyV2) -> usize {
        self.folds
            .iter()
            .position(|fold| fold.state().key() == key)
            .map(|index| self.key_event_counts[index])
            .unwrap_or(0)
    }

    pub(super) fn prior_request(
        &self,
        key: &PluginPermissionDecisionKeyV2,
        request_id: &PluginPermissionDecisionRequestIdV2,
    ) -> Option<&PluginPermissionDecisionReplayReceiptV2> {
        self.folds
            .iter()
            .find(|fold| fold.state().key() == key)
            .and_then(|fold| fold.prior_request_metadata_for(request_id))
    }
}
