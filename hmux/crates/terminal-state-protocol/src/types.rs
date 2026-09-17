use std::fmt;

use super::TerminalStateRecord;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RecordKind {
    Snapshot = 1,
    Mutation = 2,
    HistoryPage = 3,
    Event = 4,
    InputIntent = 5,
    SnapshotPart = 6,
    HistoryRequest = 7,
    ViewportFrame = 8,
    ViewportIntent = 9,
    InputReceipt = 10,
    ResizeReceipt = 11,
    ViewportFramePart = 12,
    WheelReceipt = 13,
}

impl TryFrom<u8> for RecordKind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Snapshot),
            2 => Ok(Self::Mutation),
            3 => Ok(Self::HistoryPage),
            4 => Ok(Self::Event),
            5 => Ok(Self::InputIntent),
            6 => Ok(Self::SnapshotPart),
            7 => Ok(Self::HistoryRequest),
            8 => Ok(Self::ViewportFrame),
            9 => Ok(Self::ViewportIntent),
            10 => Ok(Self::InputReceipt),
            11 => Ok(Self::ResizeReceipt),
            12 => Ok(Self::ViewportFramePart),
            13 => Ok(Self::WheelReceipt),
            _ => Err(ProtocolError::InvalidEnvelope("unknown record kind")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnvelopeMetadata {
    pub protocol_minor: u8,
    pub record_id: u64,
    pub kind: RecordKind,
}

#[derive(Clone, PartialEq)]
pub struct DecodedRecord {
    pub metadata: EnvelopeMetadata,
    pub record: TerminalStateRecord,
}

impl fmt::Debug for TerminalStateRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalStateRecord")
            .field("schema_minor", &self.schema_minor)
            .field("through_output_seq", &self.through_output_seq)
            .field("state_revision", &self.state_revision)
            .field("body", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    FrameTooLarge { actual: usize, maximum: usize },
    InvalidEnvelope(&'static str),
    Decode(prost::DecodeError),
    InvalidRecord(&'static str),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrameTooLarge { actual, maximum } => {
                write!(
                    formatter,
                    "terminal state frame is {actual} bytes; maximum is {maximum}"
                )
            }
            Self::InvalidEnvelope(reason) => {
                write!(formatter, "invalid terminal state envelope: {reason}")
            }
            Self::Decode(error) => write!(formatter, "invalid terminal state protobuf: {error}"),
            Self::InvalidRecord(reason) => {
                write!(formatter, "invalid terminal state record: {reason}")
            }
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<prost::DecodeError> for ProtocolError {
    fn from(value: prost::DecodeError) -> Self {
        Self::Decode(value)
    }
}
