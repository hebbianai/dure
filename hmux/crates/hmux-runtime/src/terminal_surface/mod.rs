mod actor;
mod encoding;
mod ingress;
mod publication;

pub(crate) use actor::{
    TerminalSurfaceActor, TerminalSurfaceMutation, TerminalSurfaceProposalError,
};
#[cfg(test)]
pub(crate) use encoding::encode_structured_record;
pub(crate) use encoding::{
    StructuredRecordEncodingError, prepare_structured_record, sequence_prepared_structured_record,
};
pub(crate) use ingress::{
    IngressPermissions, StructuredUpstream, apply_input, apply_viewport, decode_upstream,
};
pub(crate) use publication::{
    ViewportCaptureBudget, ViewportProjectionPublication, ViewportRetirement,
};
