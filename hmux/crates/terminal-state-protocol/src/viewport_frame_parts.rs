use std::fmt;

use prost::Message;

use super::{
    DecodedRecord, EnvelopeMetadata, MAX_BATCH_ID_BYTES, MAX_PAYLOAD_BYTES,
    MAX_VIEWPORT_FRAME_BYTES, MAX_VIEWPORT_FRAME_PARTS, PROTOCOL_MINOR, ProtocolError, RecordKind,
    TerminalStateRecord, ViewportFrame, ViewportFramePart, encode_record, terminal_state_record,
    validate_bytes, validate_record, validate_viewport_frame,
};

const VIEWPORT_FRAME_PART_SCHEMA_MINOR: u32 = 5;
const VIEWPORT_FRAME_PROTOCOL_MINOR: u8 = 4;

pub struct ViewportFrameBatch<'a> {
    pub record_id_start: u64,
    pub schema_minor: u32,
    pub terminal_epoch: &'a str,
    pub through_output_seq: u64,
    pub state_revision: u64,
    pub batch_id: &'a [u8],
    pub frame: &'a ViewportFrame,
    pub max_chunk_bytes: usize,
}

pub fn encode_viewport_frame_parts(
    batch: ViewportFrameBatch<'_>,
) -> Result<Vec<Vec<u8>>, ProtocolError> {
    if batch.schema_minor < VIEWPORT_FRAME_PART_SCHEMA_MINOR {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame parts require schema minor 5",
        ));
    }
    validate_viewport_frame(batch.schema_minor, batch.frame)?;
    validate_bytes(
        batch.batch_id,
        1,
        MAX_BATCH_ID_BYTES,
        "viewport frame batch id is empty or oversized",
    )?;
    if batch.record_id_start == 0 {
        return Err(ProtocolError::InvalidEnvelope("record id must be nonzero"));
    }
    if batch.max_chunk_bytes == 0 || batch.max_chunk_bytes > MAX_PAYLOAD_BYTES - 1024 {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame chunk limit is outside envelope caps",
        ));
    }

    let frame_bytes = batch.frame.encode_to_vec();
    if frame_bytes.is_empty() || frame_bytes.len() > MAX_VIEWPORT_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: frame_bytes.len(),
            maximum: MAX_VIEWPORT_FRAME_BYTES,
        });
    }
    let part_count = frame_bytes.len().div_ceil(batch.max_chunk_bytes);
    if part_count > MAX_VIEWPORT_FRAME_PARTS {
        return Err(ProtocolError::InvalidRecord(
            "viewport frame requires too many parts",
        ));
    }
    batch
        .record_id_start
        .checked_add(part_count.saturating_sub(1) as u64)
        .ok_or(ProtocolError::InvalidEnvelope("record id overflow"))?;

    frame_bytes
        .chunks(batch.max_chunk_bytes)
        .enumerate()
        .map(|(index, chunk)| {
            let record_id = batch
                .record_id_start
                .checked_add(index as u64)
                .ok_or(ProtocolError::InvalidEnvelope("record id overflow"))?;
            encode_record(
                record_id,
                &TerminalStateRecord {
                    schema_minor: batch.schema_minor,
                    terminal_epoch: batch.terminal_epoch.to_string(),
                    through_output_seq: batch.through_output_seq,
                    state_revision: batch.state_revision,
                    body: Some(terminal_state_record::Body::ViewportFramePart(
                        ViewportFramePart {
                            batch_id: batch.batch_id.to_vec(),
                            part_index: index as u32,
                            part_count: part_count as u32,
                            total_frame_bytes: frame_bytes.len() as u32,
                            frame_chunk: chunk.to_vec(),
                            projection_revision: batch.frame.projection_revision,
                            applied_intent_seq: batch.frame.applied_intent_seq,
                        },
                    )),
                },
            )
        })
        .collect()
}

#[derive(Clone, PartialEq)]
pub enum ViewportFrameAssembly {
    Downstream(DecodedRecord),
    Pending,
    Complete(DecodedRecord),
    ResyncRequired(&'static str),
}

impl fmt::Debug for ViewportFrameAssembly {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Downstream(_) => "ViewportFrameAssembly::Downstream(<redacted>)",
            Self::Pending => "ViewportFrameAssembly::Pending",
            Self::Complete(_) => "ViewportFrameAssembly::Complete(<redacted>)",
            Self::ResyncRequired(_) => "ViewportFrameAssembly::ResyncRequired(<redacted>)",
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ViewportFrameProgress {
    pub terminal_epoch: String,
    pub through_output_seq: u64,
    pub state_revision: u64,
    pub projection_revision: u64,
    pub applied_intent_seq: u64,
}

#[derive(Default)]
pub struct ViewportFrameAssembler {
    pending: Option<PendingViewportFrame>,
    installed: Option<ViewportFrameProgress>,
}

struct PendingViewportFrame {
    protocol_minor: u8,
    schema_minor: u32,
    terminal_epoch: String,
    through_output_seq: u64,
    state_revision: u64,
    batch_id: Vec<u8>,
    part_count: u32,
    total_frame_bytes: usize,
    projection_revision: u64,
    applied_intent_seq: u64,
    next_part_index: u32,
    next_record_id: u64,
    last_record_id: u64,
    bytes: Vec<u8>,
}

impl ViewportFrameAssembler {
    #[must_use]
    pub fn with_installed(installed: ViewportFrameProgress) -> Self {
        Self {
            pending: None,
            installed: Some(installed),
        }
    }

    pub fn set_installed(&mut self, installed: ViewportFrameProgress) {
        self.pending = None;
        self.installed = Some(installed);
    }

    /// Accepts one ordered downstream record. No frame escapes this assembler
    /// until every part and every fence has been validated.
    pub fn push_downstream(&mut self, decoded: DecodedRecord) -> ViewportFrameAssembly {
        if matches!(
            decoded.record.body.as_ref(),
            Some(terminal_state_record::Body::InputIntent(_))
                | Some(terminal_state_record::Body::HistoryRequest(_))
                | Some(terminal_state_record::Body::ViewportIntent(_))
        ) {
            self.pending = None;
            return ViewportFrameAssembly::ResyncRequired("upstream input is invalid downstream");
        }
        let Some(terminal_state_record::Body::ViewportFramePart(part)) =
            decoded.record.body.as_ref()
        else {
            if self.pending.take().is_some() {
                return ViewportFrameAssembly::ResyncRequired(
                    "viewport frame batch interrupted by another record",
                );
            }
            return ViewportFrameAssembly::Downstream(decoded);
        };
        if decoded.metadata.record_id == 0
            || decoded.metadata.protocol_minor > PROTOCOL_MINOR
            || decoded.record.schema_minor > u32::from(decoded.metadata.protocol_minor)
            || decoded.metadata.kind != RecordKind::ViewportFramePart
            || validate_record(&decoded.record).is_err()
        {
            self.pending = None;
            return ViewportFrameAssembly::ResyncRequired("viewport frame part is invalid");
        }

        if self.pending.is_none() {
            if part.part_index != 0 {
                return ViewportFrameAssembly::ResyncRequired(
                    "viewport frame first part is missing",
                );
            }
            if let Some(installed) = self.installed.as_ref() {
                if installed.terminal_epoch != decoded.record.terminal_epoch {
                    return ViewportFrameAssembly::ResyncRequired(
                        "viewport frame terminal epoch changed",
                    );
                }
                if part.projection_revision <= installed.projection_revision
                    || decoded.record.state_revision < installed.state_revision
                    || decoded.record.through_output_seq < installed.through_output_seq
                    || part.applied_intent_seq < installed.applied_intent_seq
                {
                    return ViewportFrameAssembly::ResyncRequired(
                        "viewport frame part is duplicate or stale",
                    );
                }
            }
            self.pending = Some(PendingViewportFrame {
                protocol_minor: decoded.metadata.protocol_minor,
                schema_minor: decoded.record.schema_minor,
                terminal_epoch: decoded.record.terminal_epoch.clone(),
                through_output_seq: decoded.record.through_output_seq,
                state_revision: decoded.record.state_revision,
                batch_id: part.batch_id.clone(),
                part_count: part.part_count,
                total_frame_bytes: part.total_frame_bytes as usize,
                projection_revision: part.projection_revision,
                applied_intent_seq: part.applied_intent_seq,
                next_part_index: 0,
                next_record_id: decoded.metadata.record_id,
                last_record_id: decoded.metadata.record_id,
                bytes: Vec::with_capacity(part.total_frame_bytes as usize),
            });
        }

        let pending = self.pending.as_mut().expect("pending batch was created");
        if pending.protocol_minor != decoded.metadata.protocol_minor
            || pending.schema_minor != decoded.record.schema_minor
            || pending.terminal_epoch != decoded.record.terminal_epoch
            || pending.through_output_seq != decoded.record.through_output_seq
            || pending.state_revision != decoded.record.state_revision
            || pending.batch_id != part.batch_id
            || pending.part_count != part.part_count
            || pending.total_frame_bytes != part.total_frame_bytes as usize
            || pending.projection_revision != part.projection_revision
            || pending.applied_intent_seq != part.applied_intent_seq
            || pending.next_part_index != part.part_index
            || pending.next_record_id != decoded.metadata.record_id
        {
            self.pending = None;
            return ViewportFrameAssembly::ResyncRequired(
                "viewport frame part is duplicate, reordered, or replaced",
            );
        }
        if pending.bytes.len() + part.frame_chunk.len() > pending.total_frame_bytes {
            self.pending = None;
            return ViewportFrameAssembly::ResyncRequired(
                "viewport frame parts exceed declared total",
            );
        }
        pending.bytes.extend_from_slice(&part.frame_chunk);
        pending.next_part_index += 1;
        pending.last_record_id = decoded.metadata.record_id;
        if pending.next_part_index < pending.part_count {
            let Some(next_record_id) = pending.next_record_id.checked_add(1) else {
                self.pending = None;
                return ViewportFrameAssembly::ResyncRequired(
                    "viewport frame record id sequence is exhausted",
                );
            };
            pending.next_record_id = next_record_id;
            return ViewportFrameAssembly::Pending;
        }

        let pending = self.pending.take().expect("complete batch is pending");
        if pending.bytes.len() != pending.total_frame_bytes {
            return ViewportFrameAssembly::ResyncRequired(
                "viewport frame parts do not match declared total",
            );
        }
        let Ok(frame) = ViewportFrame::decode(pending.bytes.as_slice()) else {
            return ViewportFrameAssembly::ResyncRequired(
                "reassembled viewport frame protobuf is invalid",
            );
        };
        if validate_viewport_frame(u32::from(VIEWPORT_FRAME_PROTOCOL_MINOR), &frame).is_err() {
            return ViewportFrameAssembly::ResyncRequired(
                "reassembled viewport frame is semantically invalid",
            );
        }
        if frame.projection_revision != pending.projection_revision
            || frame.applied_intent_seq != pending.applied_intent_seq
        {
            return ViewportFrameAssembly::ResyncRequired(
                "reassembled viewport frame disagrees with part fences",
            );
        }
        let record = TerminalStateRecord {
            schema_minor: u32::from(VIEWPORT_FRAME_PROTOCOL_MINOR),
            terminal_epoch: pending.terminal_epoch,
            through_output_seq: pending.through_output_seq,
            state_revision: pending.state_revision,
            body: Some(terminal_state_record::Body::ViewportFrame(frame)),
        };
        ViewportFrameAssembly::Complete(DecodedRecord {
            metadata: EnvelopeMetadata {
                protocol_minor: VIEWPORT_FRAME_PROTOCOL_MINOR,
                record_id: pending.last_record_id,
                kind: RecordKind::ViewportFrame,
            },
            record,
        })
    }

    #[must_use]
    pub fn has_incomplete(&self) -> bool {
        self.pending.is_some()
    }

    /// Returns true when disconnect or cancellation discarded an incomplete
    /// frame. The caller must reject that attachment state rather than retry.
    pub fn discard_incomplete(&mut self) -> bool {
        self.pending.take().is_some()
    }
}
