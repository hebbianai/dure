use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};

use hmux_runtime_contract::{
    TERMINAL_VIEWPORT_MULTIPART_CAPABILITY, TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION,
    TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION,
};
use terminal_state_protocol::{
    ENVELOPE_HEADER_BYTES, ENVELOPE_MAGIC, MAX_PAYLOAD_BYTES, MAX_VIEWPORT_FRAME_PARTS,
    ProtocolError, TerminalStateRecord, ViewportFrameBatch, encode_record_for_minor,
    encode_viewport_frame_parts, terminal_state_record,
};

#[derive(Debug)]
pub(crate) enum StructuredRecordEncodingError {
    RecordIdentityExhausted,
    ViewportMultipartRequired { actual: usize, maximum: usize },
    Protocol(ProtocolError),
}

impl StructuredRecordEncodingError {
    pub(crate) fn viewport_multipart_bounds(&self) -> Option<(usize, usize)> {
        match self {
            Self::ViewportMultipartRequired { actual, maximum } => Some((*actual, *maximum)),
            Self::RecordIdentityExhausted | Self::Protocol(_) => None,
        }
    }

    pub(crate) fn resource_limit_bounds(&self) -> Option<(usize, usize)> {
        match self {
            Self::Protocol(ProtocolError::FrameTooLarge { actual, maximum }) => {
                Some((*actual, *maximum))
            }
            Self::RecordIdentityExhausted
            | Self::ViewportMultipartRequired { .. }
            | Self::Protocol(_) => None,
        }
    }
}

impl fmt::Display for StructuredRecordEncodingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RecordIdentityExhausted => {
                formatter.write_str("structured terminal record identity is exhausted")
            }
            Self::ViewportMultipartRequired { .. } => write!(
                formatter,
                "complete viewport requires {TERMINAL_VIEWPORT_MULTIPART_CAPABILITY} capability"
            ),
            Self::Protocol(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for StructuredRecordEncodingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::RecordIdentityExhausted => None,
            Self::ViewportMultipartRequired { .. } => None,
            Self::Protocol(error) => Some(error),
        }
    }
}

impl From<ProtocolError> for StructuredRecordEncodingError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

#[cfg(all(test, not(windows)))]
pub(crate) fn encode_structured_record(
    next_record_id: &AtomicU64,
    record: TerminalStateRecord,
    base_protocol_minor: u8,
    viewport_multipart: bool,
) -> Result<Vec<Vec<u8>>, StructuredRecordEncodingError> {
    let record_id_start = reserve_record_identities(next_record_id)?;
    encode_structured_record_at(
        record_id_start,
        record,
        base_protocol_minor,
        viewport_multipart,
    )
}

pub(crate) fn prepare_structured_record(
    record: TerminalStateRecord,
    base_protocol_minor: u8,
    viewport_multipart: bool,
) -> Result<Vec<Vec<u8>>, StructuredRecordEncodingError> {
    encode_structured_record_at(1, record, base_protocol_minor, viewport_multipart)
}

pub(crate) fn sequence_prepared_structured_record(
    next_record_id: &AtomicU64,
    records: &mut [Vec<u8>],
) -> Result<(), StructuredRecordEncodingError> {
    if records.is_empty() || records.len() > MAX_VIEWPORT_FRAME_PARTS {
        return Err(StructuredRecordEncodingError::RecordIdentityExhausted);
    }
    let record_id_start = reserve_record_identities(next_record_id)?;
    for (index, record) in records.iter_mut().enumerate() {
        if record.len() < ENVELOPE_HEADER_BYTES || record[..4] != ENVELOPE_MAGIC {
            return Err(
                ProtocolError::InvalidEnvelope("prepared record envelope is invalid").into(),
            );
        }
        let record_id = record_id_start
            .checked_add(
                u64::try_from(index)
                    .map_err(|_| StructuredRecordEncodingError::RecordIdentityExhausted)?,
            )
            .ok_or(StructuredRecordEncodingError::RecordIdentityExhausted)?;
        record[12..20].copy_from_slice(&record_id.to_le_bytes());
    }
    Ok(())
}

fn reserve_record_identities(
    next_record_id: &AtomicU64,
) -> Result<u64, StructuredRecordEncodingError> {
    let reserved = u64::try_from(MAX_VIEWPORT_FRAME_PARTS)
        .map_err(|_| StructuredRecordEncodingError::RecordIdentityExhausted)?;
    next_record_id
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(reserved)
        })
        .map_err(|_| StructuredRecordEncodingError::RecordIdentityExhausted)
}

fn encode_structured_record_at(
    record_id_start: u64,
    mut record: TerminalStateRecord,
    base_protocol_minor: u8,
    viewport_multipart: bool,
) -> Result<Vec<Vec<u8>>, StructuredRecordEncodingError> {
    let record_protocol_minor = if matches!(
        record.body.as_ref(),
        Some(terminal_state_record::Body::WheelReceipt(_))
    ) {
        TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor
    } else {
        base_protocol_minor
    };
    record.schema_minor = u32::from(record_protocol_minor);
    match encode_record_for_minor(record_protocol_minor, record_id_start, &record) {
        Ok(encoded) => Ok(vec![encoded]),
        Err(error @ ProtocolError::FrameTooLarge { actual, maximum }) => {
            let batch_discriminator = match record.body.as_ref() {
                Some(terminal_state_record::Body::ViewportFrame(frame)) => {
                    frame.projection_revision
                }
                _ => record_id_start,
            };
            let batch_id = format!("{:016x}{:016x}", record.state_revision, batch_discriminator);
            match record.body.as_ref() {
                Some(terminal_state_record::Body::ViewportFrame(_)) if !viewport_multipart => {
                    Err(StructuredRecordEncodingError::ViewportMultipartRequired {
                        actual,
                        maximum,
                    })
                }
                Some(terminal_state_record::Body::ViewportFrame(frame)) => {
                    Ok(encode_viewport_frame_parts(ViewportFrameBatch {
                        record_id_start,
                        schema_minor: u32::from(
                            TERMINAL_VIEWPORT_MULTIPART_PROTOCOL_VERSION.envelope_minor,
                        ),
                        terminal_epoch: &record.terminal_epoch,
                        through_output_seq: record.through_output_seq,
                        state_revision: record.state_revision,
                        batch_id: batch_id.as_bytes(),
                        frame,
                        max_chunk_bytes: MAX_PAYLOAD_BYTES - 1024,
                    })?)
                }
                _ => Err(error.into()),
            }
        }
        Err(error) => Err(error.into()),
    }
}
