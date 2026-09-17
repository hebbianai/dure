use prost::Message;

use super::{
    DecodedRecord, ENVELOPE_HEADER_BYTES, ENVELOPE_MAGIC, EnvelopeMetadata, MAX_ENVELOPE_BYTES,
    MAX_PAYLOAD_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR, ProtocolError, RecordKind,
    TerminalStateRecord, terminal_state_record, validate_record,
};

pub fn encode_record(
    record_id: u64,
    record: &TerminalStateRecord,
) -> Result<Vec<u8>, ProtocolError> {
    let negotiated_minor = u8::try_from(record.schema_minor)
        .map_err(|_| ProtocolError::InvalidEnvelope("schema minor is out of range"))?;
    encode_record_for_minor(negotiated_minor, record_id, record)
}

pub fn encode_record_for_minor(
    negotiated_minor: u8,
    record_id: u64,
    record: &TerminalStateRecord,
) -> Result<Vec<u8>, ProtocolError> {
    if record_id == 0 {
        return Err(ProtocolError::InvalidEnvelope("record id must be nonzero"));
    }
    if negotiated_minor > PROTOCOL_MINOR {
        return Err(ProtocolError::InvalidEnvelope(
            "negotiated minor is unsupported",
        ));
    }
    if record.schema_minor > u32::from(negotiated_minor) {
        return Err(ProtocolError::InvalidEnvelope(
            "schema minor exceeds negotiated minor",
        ));
    }
    validate_record(record)?;
    let kind = record_kind(record)?;
    let payload_length = record.encoded_len();
    if payload_length > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: payload_length,
            maximum: MAX_PAYLOAD_BYTES,
        });
    }

    let mut output = Vec::with_capacity(ENVELOPE_HEADER_BYTES + payload_length);
    output.extend_from_slice(&ENVELOPE_MAGIC);
    output.push(PROTOCOL_MAJOR);
    output.push(negotiated_minor);
    output.push(kind as u8);
    output.push(0);
    output.extend_from_slice(&(payload_length as u32).to_le_bytes());
    output.extend_from_slice(&record_id.to_le_bytes());
    record
        .encode(&mut output)
        .map_err(|_| ProtocolError::InvalidRecord("protobuf encode failed"))?;
    Ok(output)
}

pub fn decode_record(bytes: &[u8]) -> Result<DecodedRecord, ProtocolError> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: bytes.len(),
            maximum: MAX_ENVELOPE_BYTES,
        });
    }
    if bytes.len() < ENVELOPE_HEADER_BYTES {
        return Err(ProtocolError::InvalidEnvelope("truncated header"));
    }
    if bytes[..4] != ENVELOPE_MAGIC {
        return Err(ProtocolError::InvalidEnvelope("wrong magic"));
    }
    if bytes[4] != PROTOCOL_MAJOR {
        return Err(ProtocolError::InvalidEnvelope("unsupported major version"));
    }
    let protocol_minor = bytes[5];
    if protocol_minor > PROTOCOL_MINOR {
        return Err(ProtocolError::InvalidEnvelope("unsupported minor version"));
    }
    if bytes[7] != 0 {
        return Err(ProtocolError::InvalidEnvelope("nonzero reserved flags"));
    }
    let kind = RecordKind::try_from(bytes[6])?;
    let payload_length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if payload_length > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: payload_length,
            maximum: MAX_PAYLOAD_BYTES,
        });
    }
    if bytes.len() != ENVELOPE_HEADER_BYTES + payload_length {
        return Err(ProtocolError::InvalidEnvelope("payload length mismatch"));
    }
    let record_id = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
    if record_id == 0 {
        return Err(ProtocolError::InvalidEnvelope("record id must be nonzero"));
    }

    let record = TerminalStateRecord::decode(&bytes[ENVELOPE_HEADER_BYTES..])?;
    validate_record(&record)?;
    if record_kind(&record)? != kind {
        return Err(ProtocolError::InvalidEnvelope(
            "record kind does not match payload",
        ));
    }
    if record.schema_minor > u32::from(protocol_minor) {
        return Err(ProtocolError::InvalidEnvelope(
            "schema minor exceeds envelope minor",
        ));
    }

    Ok(DecodedRecord {
        metadata: EnvelopeMetadata {
            protocol_minor,
            record_id,
            kind,
        },
        record,
    })
}

fn record_kind(record: &TerminalStateRecord) -> Result<RecordKind, ProtocolError> {
    match record.body.as_ref() {
        Some(terminal_state_record::Body::Snapshot(_)) => Ok(RecordKind::Snapshot),
        Some(terminal_state_record::Body::Mutation(_)) => Ok(RecordKind::Mutation),
        Some(terminal_state_record::Body::HistoryPage(_)) => Ok(RecordKind::HistoryPage),
        Some(terminal_state_record::Body::Event(_)) => Ok(RecordKind::Event),
        Some(terminal_state_record::Body::InputIntent(_)) => Ok(RecordKind::InputIntent),
        Some(terminal_state_record::Body::SnapshotPart(_)) => Ok(RecordKind::SnapshotPart),
        Some(terminal_state_record::Body::HistoryRequest(_)) => Ok(RecordKind::HistoryRequest),
        Some(terminal_state_record::Body::ViewportFrame(_)) => Ok(RecordKind::ViewportFrame),
        Some(terminal_state_record::Body::ViewportIntent(_)) => Ok(RecordKind::ViewportIntent),
        Some(terminal_state_record::Body::InputReceipt(_)) => Ok(RecordKind::InputReceipt),
        Some(terminal_state_record::Body::ResizeReceipt(_)) => Ok(RecordKind::ResizeReceipt),
        Some(terminal_state_record::Body::ViewportFramePart(_)) => {
            Ok(RecordKind::ViewportFramePart)
        }
        Some(terminal_state_record::Body::WheelReceipt(_)) => Ok(RecordKind::WheelReceipt),
        None => Err(ProtocolError::InvalidRecord("record body is required")),
    }
}
