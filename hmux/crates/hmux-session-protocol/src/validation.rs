use super::{
    ControlReceiptState, FrameBody, Hello, HelloAck, InputReceiptState,
    ManagedProviderStopReceiptState, OperationReceiptReason, ProcessProof, ProtocolVersion,
    ResizeReceiptState, SessionFence, StandaloneTerminateReceiptState, VersionRange, WireFrame,
};
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrameLimits {
    pub max_frame_bytes: usize,
    pub max_identifier_bytes: usize,
    pub max_capabilities: usize,
    pub max_capability_bytes: usize,
    pub max_capability_token_bytes: usize,
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_snapshot_bytes: usize,
    pub max_message_bytes: usize,
    pub max_reason_bytes: usize,
    pub max_working_directory_bytes: usize,
    pub max_execution_target_bytes: usize,
    pub max_rows: u16,
    pub max_columns: u16,
    pub max_cells: usize,
}

/// The largest frame the protocol will ever move, as a `const` so a caller that
/// must budget time or memory for one can name it without constructing
/// [`FrameLimits`]. `hmux-client` derives its frame-completion deadline from it.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024;

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_identifier_bytes: 256,
            max_capabilities: 64,
            max_capability_bytes: 128,
            max_capability_token_bytes: 512,
            max_input_bytes: 64 * 1024,
            max_output_bytes: 64 * 1024,
            // JSON/base64 expands binary data by one third. Keep enough room
            // inside the 1 MiB frame for a maximally bounded fence and metadata.
            max_snapshot_bytes: 700 * 1024,
            max_message_bytes: 1024,
            max_reason_bytes: 1024,
            max_working_directory_bytes: 4096,
            max_execution_target_bytes: 512,
            max_rows: 512,
            max_columns: 1024,
            max_cells: 256 * 1024,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FrameValidationError {
    Empty {
        field: &'static str,
    },
    TooLong {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    TooMany {
        field: &'static str,
        actual: usize,
        maximum: usize,
    },
    OutOfRange {
        field: &'static str,
    },
    Inconsistent {
        field: &'static str,
    },
}

impl fmt::Display for FrameValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty { field } => write!(formatter, "{field} must not be empty"),
            Self::TooLong {
                field,
                actual,
                maximum,
            } => write!(
                formatter,
                "{field} length {actual} exceeds maximum {maximum}"
            ),
            Self::TooMany {
                field,
                actual,
                maximum,
            } => write!(
                formatter,
                "{field} count {actual} exceeds maximum {maximum}"
            ),
            Self::OutOfRange { field } => write!(formatter, "{field} is out of range"),
            Self::Inconsistent { field } => write!(formatter, "{field} is inconsistent"),
        }
    }
}

impl std::error::Error for FrameValidationError {}

impl WireFrame {
    pub fn validate(&self, limits: &FrameLimits) -> Result<(), FrameValidationError> {
        validate_version(self.protocol_version, "protocol_version")?;
        if self.frame_id == 0 {
            return Err(out_of_range("frame_id"));
        }
        validate_body(&self.body, self.protocol_version, limits)
    }
}

fn validate_body(
    body: &FrameBody,
    envelope_version: ProtocolVersion,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    match body {
        FrameBody::Hello(frame) => validate_hello(frame, limits),
        FrameBody::HelloAck(frame) => validate_hello_ack(frame, envelope_version, limits),
        FrameBody::ScreenSnapshot(frame) => {
            validate_fence(&frame.fence, limits)?;
            validate_dimensions(frame.rows, frame.columns, limits)?;
            if let Some(recovered) = &frame.recovered_presentation {
                validate_fence(&recovered.source_fence, limits)?;
                if recovered.captured_unix_ms == 0
                    || recovered.source_fence.workspace_id != frame.fence.workspace_id
                    || recovered.source_fence.runner_principal != frame.fence.runner_principal
                    || recovered.source_fence.terminal_epoch == frame.fence.terminal_epoch
                {
                    return Err(inconsistent("screen_snapshot.recovered_presentation"));
                }
            }
            if let Some(projection) = &frame.working_directory {
                validate_working_directory_projection(
                    projection,
                    &frame.fence.terminal_epoch,
                    frame.sequence_through,
                    limits,
                )?;
            }
            if let Some(projection) = &frame.execution_location {
                validate_execution_location_projection(
                    projection,
                    &frame.fence.terminal_epoch,
                    frame.sequence_through,
                    limits,
                )?;
            }
            if let Some(projection) = &frame.agent_identity {
                validate_agent_identity_projection(
                    projection,
                    &frame.fence.terminal_epoch,
                    frame.sequence_through,
                )?;
            }
            if let Some(projection) = &frame.agent_runtime_state {
                validate_agent_runtime_state_projection(
                    projection,
                    &frame.fence.terminal_epoch,
                    frame.sequence_through,
                    limits,
                )?;
            }
            if frame.semantic_idle_ms.is_some()
                && (frame.controller_input_pending != Some(false)
                    || !frame
                        .agent_runtime_state
                        .as_ref()
                        .is_some_and(|state| state.is_semantically_quiescent()))
            {
                return Err(inconsistent("screen_snapshot.semantic_idle_ms"));
            }
            if let Some(projection) = &frame.provider_conversation_identity {
                validate_provider_conversation_identity_projection(
                    projection,
                    &frame.fence,
                    frame.sequence_through,
                    limits,
                )?;
            }
            if let Some(in_reply_to) = &frame.in_reply_to_request_id {
                bounded_text(
                    "screen_snapshot.in_reply_to_request_id",
                    in_reply_to,
                    limits.max_identifier_bytes,
                    false,
                )?;
            }
            bounded_bytes(
                "screen_snapshot.repaint_bytes",
                &frame.repaint_bytes,
                limits.max_snapshot_bytes,
                false,
            )
        }
        FrameBody::ScreenSnapshotRequest(frame) => {
            bounded_text(
                "screen_snapshot_request.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_fence(&frame.expected_fence, limits)
        }
        FrameBody::OutputDelta(frame) => {
            bounded_text(
                "output_delta.terminal_epoch",
                &frame.terminal_epoch,
                limits.max_identifier_bytes,
                false,
            )?;
            if frame.output_seq == 0 {
                return Err(out_of_range("output_delta.output_seq"));
            }
            match (frame.rows, frame.columns) {
                (Some(rows), Some(columns)) => validate_dimensions(rows, columns, limits)?,
                (None, None) => {}
                _ => return Err(inconsistent("output_delta.geometry")),
            }
            if let Some(projection) = &frame.working_directory {
                validate_working_directory_projection(
                    projection,
                    &frame.terminal_epoch,
                    frame.output_seq,
                    limits,
                )?;
            }
            if let Some(projection) = &frame.execution_location {
                validate_execution_location_projection(
                    projection,
                    &frame.terminal_epoch,
                    frame.output_seq,
                    limits,
                )?;
            }
            if let Some(projection) = &frame.agent_identity {
                validate_agent_identity_projection(
                    projection,
                    &frame.terminal_epoch,
                    frame.output_seq,
                )?;
            }
            bounded_bytes(
                "output_delta.bytes",
                &frame.bytes,
                limits.max_output_bytes,
                false,
            )
        }
        FrameBody::WorkingDirectory(frame) => validate_working_directory_projection(
            frame,
            &frame.terminal_epoch,
            frame.observed_through_output_seq,
            limits,
        ),
        FrameBody::AgentIdentity(frame) => bounded_text(
            "agent_identity.terminal_epoch",
            &frame.terminal_epoch,
            limits.max_identifier_bytes,
            false,
        ),
        FrameBody::AgentRuntimeState(frame) => validate_agent_runtime_state_projection(
            frame,
            &frame.terminal_epoch,
            frame.observed_through_output_seq,
            limits,
        ),
        FrameBody::ProviderConversationIdentity(frame) => {
            validate_provider_conversation_identity_projection(
                frame,
                &frame.fence,
                frame.observed_through_output_seq,
                limits,
            )
        }
        FrameBody::ReplayGap(frame) => {
            bounded_text(
                "replay_gap.terminal_epoch",
                &frame.cursor.terminal_epoch,
                limits.max_identifier_bytes,
                false,
            )?;
            let requested_next = frame.cursor.after_output_seq.saturating_add(1);
            if requested_next >= frame.earliest_retained_output_seq
                || frame.earliest_retained_output_seq > frame.current_output_seq.saturating_add(1)
            {
                return Err(inconsistent("replay_gap.sequence_range"));
            }
            Ok(())
        }
        FrameBody::Input(frame) => {
            bounded_text(
                "input.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            bounded_bytes("input.bytes", &frame.bytes, limits.max_input_bytes, false)
        }
        FrameBody::InputReceipt(frame) => {
            bounded_text(
                "input_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_input_receipt_detail(frame.detail.as_deref())?;
            validate_input_receipt_reason(frame.state, frame.reason)
        }
        FrameBody::Resize(frame) => {
            bounded_text(
                "resize.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_dimensions(frame.rows, frame.columns, limits)
        }
        FrameBody::ResizeReceipt(frame) => {
            bounded_text(
                "resize_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_resize_receipt(frame, limits)
        }
        FrameBody::StandaloneTerminate(frame) => bounded_text(
            "standalone_terminate.request_id",
            &frame.request_id,
            limits.max_identifier_bytes,
            false,
        ),
        FrameBody::StandaloneTerminateReceipt(frame) => {
            bounded_text(
                "standalone_terminate_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_standalone_terminate_receipt(frame)
        }
        FrameBody::ManagedProviderStop(frame) => {
            bounded_text(
                "managed_provider_stop.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            if let Some(expected) = &frame.expected_quiescence {
                bounded_text(
                    "managed_provider_stop.expected_quiescence.terminal_epoch",
                    &expected.terminal_epoch,
                    limits.max_identifier_bytes,
                    false,
                )?;
                if expected.runtime_revision == 0 {
                    return Err(out_of_range(
                        "managed_provider_stop.expected_quiescence.runtime_revision",
                    ));
                }
            }
            if let Some(expected) = &frame.expected_conversation {
                bounded_text(
                    "managed_provider_stop.expected_conversation.provider_id",
                    &expected.provider_id,
                    limits.max_identifier_bytes,
                    false,
                )?;
                if let Some(conversation_id) = &expected.conversation_id {
                    bounded_text(
                        "managed_provider_stop.expected_conversation.conversation_id",
                        conversation_id,
                        limits.max_identifier_bytes,
                        false,
                    )?;
                }
            }
            Ok(())
        }
        FrameBody::ManagedProviderStopReceipt(frame) => {
            bounded_text(
                "managed_provider_stop_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_managed_provider_stop_receipt(frame)
        }
        FrameBody::ManagedAuthorizationGrantRequest(frame) => bounded_text(
            "managed_authorization_grant_request.request_id",
            &frame.request_id,
            limits.max_identifier_bytes,
            false,
        ),
        FrameBody::ManagedAuthorizationGrantReceipt(frame) => {
            bounded_text(
                "managed_authorization_grant_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            bounded_text(
                "managed_authorization_grant_receipt.authorization_proof_reference",
                &frame.authorization_proof_reference,
                limits.max_capability_token_bytes,
                false,
            )
        }
        FrameBody::AgentStateReport(frame) => validate_agent_state_report(frame, limits),
        FrameBody::AgentStateReportReceipt(frame) => {
            bounded_text(
                "agent_state_report_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            if let Some(projection) = &frame.provider_conversation_identity {
                validate_provider_conversation_identity_projection(
                    projection,
                    &projection.fence,
                    u64::MAX,
                    limits,
                )?;
            }
            Ok(())
        }
        FrameBody::ControlRequest(frame) => bounded_text(
            "control_request.request_id",
            &frame.request_id,
            limits.max_identifier_bytes,
            false,
        ),
        FrameBody::ControlRelease(frame) => bounded_text(
            "control_release.request_id",
            &frame.request_id,
            limits.max_identifier_bytes,
            false,
        ),
        FrameBody::ControlReceipt(frame) => {
            bounded_text(
                "control_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_control_receipt(frame)
        }
        FrameBody::SessionRetirementRequest(frame) => {
            bounded_text(
                "session_retirement_request.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            validate_fence(&frame.expected_fence, limits)?;
            if let super::SessionRetirementAction::Configure {
                policy: Some(policy),
            } = frame.action
            {
                if !policy.is_valid() {
                    return Err(out_of_range("session_retirement_request.policy"));
                }
            }
            Ok(())
        }
        FrameBody::SessionRetirementReceipt(frame) => {
            bounded_text(
                "session_retirement_receipt.request_id",
                &frame.request_id,
                limits.max_identifier_bytes,
                false,
            )?;
            if frame.policy.is_some_and(|policy| !policy.is_valid()) {
                return Err(out_of_range("session_retirement_receipt.policy"));
            }
            let requires_reason = matches!(
                frame.state,
                super::SessionRetirementReceiptState::SessionPreserved
                    | super::SessionRetirementReceiptState::Refused
            );
            if requires_reason != frame.reason.is_some() {
                return Err(inconsistent("session_retirement_receipt.reason"));
            }
            Ok(())
        }
        FrameBody::Detach(frame) => optional_text(
            "detach.reason",
            frame.reason.as_deref(),
            limits.max_reason_bytes,
        ),
        FrameBody::Exit(frame) => {
            if frame.exit_code.is_none() && frame.platform_status.is_none() {
                return Err(inconsistent("exit.status"));
            }
            optional_text(
                "exit.platform_status",
                frame.platform_status.as_deref(),
                limits.max_reason_bytes,
            )?;
            bounded_text("exit.reason", &frame.reason, limits.max_reason_bytes, false)
        }
        FrameBody::Error(frame) => {
            optional_text(
                "error.origin_code",
                frame.origin_code.as_deref(),
                limits.max_identifier_bytes,
            )?;
            bounded_text(
                "error.message",
                &frame.message,
                limits.max_message_bytes,
                false,
            )?;
            optional_text(
                "error.required_capability",
                frame.required_capability.as_deref(),
                limits.max_capability_bytes,
            )?;
            if let Some(range) = frame.supported_versions {
                validate_version_range(range, "error.supported_versions")?;
            }
            optional_text(
                "error.in_reply_to_request_id",
                frame.in_reply_to_request_id.as_deref(),
                limits.max_identifier_bytes,
            )
        }
    }
}

fn validate_working_directory_projection(
    projection: &super::WorkingDirectoryProjection,
    terminal_epoch: &str,
    maximum_sequence: u64,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    if projection.terminal_epoch != terminal_epoch
        || projection.observed_through_output_seq > maximum_sequence
    {
        return Err(inconsistent("working_directory.fence_or_sequence"));
    }
    bounded_text(
        "working_directory.path",
        &projection.path,
        limits.max_working_directory_bytes,
        false,
    )?;
    if projection.path.chars().any(char::is_control) {
        return Err(inconsistent("working_directory.path"));
    }
    Ok(())
}

fn validate_execution_location_projection(
    projection: &super::ExecutionLocationProjection,
    terminal_epoch: &str,
    maximum_sequence: u64,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    if projection.terminal_epoch != terminal_epoch
        || projection.observed_through_output_seq > maximum_sequence
    {
        return Err(inconsistent("execution_location.fence_or_sequence"));
    }
    if let super::ExecutionLocation::Ssh { target } = &projection.location {
        bounded_text(
            "execution_location.target",
            target,
            limits.max_execution_target_bytes,
            false,
        )?;
        if target.trim() != target
            || target
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
        {
            return Err(inconsistent("execution_location.target"));
        }
    }
    Ok(())
}

fn validate_agent_identity_projection(
    projection: &super::AgentIdentityProjection,
    terminal_epoch: &str,
    maximum_sequence: u64,
) -> Result<(), FrameValidationError> {
    if projection.terminal_epoch != terminal_epoch
        || projection.observed_through_output_seq > maximum_sequence
    {
        return Err(inconsistent("agent_identity.fence_or_sequence"));
    }
    Ok(())
}

fn validate_agent_runtime_state_projection(
    projection: &super::AgentRuntimeStateProjection,
    terminal_epoch: &str,
    maximum_sequence: u64,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    use super::{AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeLifecycle};

    bounded_text(
        "agent_runtime_state.terminal_epoch",
        &projection.terminal_epoch,
        limits.max_identifier_bytes,
        false,
    )?;
    if projection.terminal_epoch != terminal_epoch
        || projection.observed_through_output_seq > maximum_sequence
    {
        return Err(inconsistent("agent_runtime_state.fence_or_sequence"));
    }
    if projection.revision == 0 {
        return Err(out_of_range("agent_runtime_state.revision"));
    }

    match (projection.attention, projection.attention_id.as_deref()) {
        (AgentRuntimeAttention::None, None) => {}
        (AgentRuntimeAttention::None, Some(_)) | (_, None) => {
            return Err(inconsistent("agent_runtime_state.attention_id"));
        }
        (_, Some(attention_id)) => bounded_text(
            "agent_runtime_state.attention_id",
            attention_id,
            limits.max_identifier_bytes,
            false,
        )?,
    }
    if projection.attention != AgentRuntimeAttention::None
        && projection.activity != AgentRuntimeActivity::Waiting
    {
        return Err(inconsistent("agent_runtime_state.attention_activity"));
    }
    if projection.lifecycle == AgentRuntimeLifecycle::Exited
        && (projection.activity != AgentRuntimeActivity::Waiting
            || projection.attention != AgentRuntimeAttention::None)
    {
        return Err(inconsistent("agent_runtime_state.exited"));
    }
    Ok(())
}

fn validate_agent_state_report(
    frame: &super::AgentStateReport,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    use super::{
        AGENT_STATE_REPORT_MAX_WORKING_TTL_MS, AgentRuntimeActivity, AgentRuntimeAttention,
    };

    bounded_text(
        "agent_state_report.request_id",
        &frame.request_id,
        limits.max_identifier_bytes,
        false,
    )?;
    if let Some(completion_id) = &frame.turn_completion_id {
        bounded_text(
            "agent_state_report.turn_completion_id",
            completion_id,
            limits.max_identifier_bytes,
            false,
        )?;
        if !frame.turn_completed || !safe_opaque_identity(completion_id) {
            return Err(inconsistent("agent_state_report.turn_completion_id"));
        }
    }
    if frame.attention != AgentRuntimeAttention::None
        && frame.activity != AgentRuntimeActivity::Waiting
    {
        return Err(inconsistent("agent_state_report.attention_activity"));
    }
    if let Some(causality) = &frame.causality {
        if causality.sequence == 0 {
            return Err(out_of_range("agent_state_report.causality.sequence"));
        }
        if let Some(work_id) = &causality.work_id {
            bounded_text(
                "agent_state_report.causality.work_id",
                work_id,
                limits.max_identifier_bytes,
                false,
            )?;
            if !safe_opaque_identity(work_id) {
                return Err(inconsistent("agent_state_report.causality.work_id"));
            }
        }
        if frame.identity_only
            || (frame.turn_completed
                && (causality.work_id.is_none() || causality.work_id != frame.turn_completion_id))
        {
            return Err(inconsistent("agent_state_report.causality"));
        }
    }
    if let Some(working_ttl_ms) = frame.working_ttl_ms {
        if working_ttl_ms == 0 || working_ttl_ms > AGENT_STATE_REPORT_MAX_WORKING_TTL_MS {
            return Err(out_of_range("agent_state_report.working_ttl_ms"));
        }
    }
    if let Some(identity) = &frame.conversation_identity {
        bounded_text(
            "agent_state_report.conversation_identity.provider_id",
            &identity.provider_id,
            limits.max_identifier_bytes,
            false,
        )?;
        bounded_text(
            "agent_state_report.conversation_identity.conversation_id",
            &identity.conversation_id,
            limits.max_identifier_bytes,
            false,
        )?;
        if !safe_opaque_identity(&identity.provider_id)
            || !safe_opaque_identity(&identity.conversation_id)
        {
            return Err(inconsistent(
                "agent_state_report.conversation_identity.identifier",
            ));
        }
        if let Some(fence) = &identity.expected_fence {
            validate_fence(fence, limits)?;
        }
    }
    if let Some(expected) = &frame.expected_observation {
        bounded_text(
            "agent_state_report.expected_observation.terminal_epoch",
            &expected.terminal_epoch,
            limits.max_identifier_bytes,
            false,
        )?;
        if expected.runtime_revision == 0 {
            return Err(out_of_range(
                "agent_state_report.expected_observation.runtime_revision",
            ));
        }
    }
    if frame.identity_only && frame.conversation_identity.is_none() {
        return Err(inconsistent(
            "agent_state_report.identity_only_conversation_identity",
        ));
    }
    if frame.identity_only && frame.expected_observation.is_some() {
        return Err(inconsistent(
            "agent_state_report.identity_only_expected_observation",
        ));
    }
    if frame.expected_observation.is_some() && frame.conversation_identity.is_some() {
        return Err(inconsistent(
            "agent_state_report.expected_observation_conversation_identity",
        ));
    }
    Ok(())
}

fn validate_provider_conversation_identity_projection(
    projection: &super::ProviderConversationIdentityProjection,
    fence: &SessionFence,
    maximum_sequence: u64,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    validate_fence(&projection.fence, limits)?;
    if projection.fence != *fence
        || projection.revision == 0
        || projection.observed_through_output_seq > maximum_sequence
    {
        return Err(inconsistent(
            "provider_conversation_identity.fence_revision_or_sequence",
        ));
    }
    for (field, value) in [
        (
            "provider_conversation_identity.provider_id",
            projection.provider_id.as_str(),
        ),
        (
            "provider_conversation_identity.conversation_id",
            projection.conversation_id.as_str(),
        ),
    ] {
        bounded_text(field, value, limits.max_identifier_bytes, false)?;
        if !safe_opaque_identity(value) {
            return Err(inconsistent(field));
        }
    }
    Ok(())
}

fn safe_opaque_identity(value: &str) -> bool {
    value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'+' | b'-')
    })
}

fn validate_hello(frame: &Hello, limits: &FrameLimits) -> Result<(), FrameValidationError> {
    validate_version_range(frame.supported_versions, "hello.supported_versions")?;
    validate_capabilities(&frame.requested_capabilities, limits, "hello.capabilities")?;
    validate_fence(&frame.expected_fence, limits)?;
    if let Some(cursor) = &frame.reconnect_cursor {
        bounded_text(
            "hello.cursor.terminal_epoch",
            &cursor.terminal_epoch,
            limits.max_identifier_bytes,
            false,
        )?;
        if cursor.terminal_epoch != frame.expected_fence.terminal_epoch {
            return Err(inconsistent("hello.cursor.terminal_epoch"));
        }
    }
    bounded_text(
        "hello.capability_token",
        &frame.capability_token,
        limits.max_capability_token_bytes,
        false,
    )?;
    optional_text(
        "hello.authorization_proof_reference",
        frame.authorization_proof_reference.as_deref(),
        limits.max_identifier_bytes,
    )
}

// The optional receipt detail names a bounded underlying failure class and
// must never carry prose or provider bytes across the wire, even from a remote
// peer. Enforce the same snake_case token shape the producer bounds so an
// untrusted frame cannot smuggle arbitrary text into a durable diagnostic.
fn validate_input_receipt_detail(detail: Option<&str>) -> Result<(), FrameValidationError> {
    let Some(detail) = detail else {
        return Ok(());
    };
    let valid = detail.len() >= 3
        && detail.len() <= 64
        && detail
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && detail
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase);
    if valid {
        Ok(())
    } else {
        Err(inconsistent("input_receipt.detail"))
    }
}

fn validate_input_receipt_reason(
    state: InputReceiptState,
    reason: Option<OperationReceiptReason>,
) -> Result<(), FrameValidationError> {
    use InputReceiptState::{Accepted, Failed, Refused, Released, Revoked, WrittenToPty};
    use OperationReceiptReason::{
        AuthorizationDenied, ControllerConflict, HostExiting, InputTooLarge, PtyWriteFailed,
        ResourceLimit, StaleControllerGeneration,
    };

    let valid = matches!(
        (state, reason),
        (Accepted | WrittenToPty | Released, None)
            | (
                Refused,
                Some(
                    ControllerConflict
                        | StaleControllerGeneration
                        | AuthorizationDenied
                        | InputTooLarge
                        | ResourceLimit
                        | HostExiting
                )
            )
            | (Revoked, Some(StaleControllerGeneration))
            | (Failed, Some(PtyWriteFailed | ResourceLimit | HostExiting))
    );
    if !valid {
        return Err(inconsistent("input_receipt.reason"));
    }
    Ok(())
}

fn validate_resize_receipt(
    frame: &super::ResizeReceipt,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    let applied = frame.state == ResizeReceiptState::AppliedToTerminal;
    if applied {
        let (Some(rows), Some(columns)) = (frame.rows, frame.columns) else {
            return Err(inconsistent("resize_receipt.applied_dimensions"));
        };
        validate_dimensions(rows, columns, limits)?;
    } else if frame.rows.is_some() || frame.columns.is_some() {
        return Err(inconsistent("resize_receipt.applied_dimensions"));
    }

    use OperationReceiptReason::{
        AuthorizationDenied, ControllerConflict, HostExiting, InvalidTerminalDimensions,
        PlatformResizeFailed, ResourceLimit, StaleControllerGeneration,
    };
    use ResizeReceiptState::{Accepted, AppliedToTerminal, Failed, Refused, Revoked};
    let valid_reason = matches!(
        (frame.state, frame.reason),
        (Accepted | AppliedToTerminal, None)
            | (
                Refused,
                Some(
                    ControllerConflict
                        | StaleControllerGeneration
                        | AuthorizationDenied
                        | InvalidTerminalDimensions
                        | ResourceLimit
                        | HostExiting
                )
            )
            | (Revoked, Some(StaleControllerGeneration))
            | (
                Failed,
                Some(PlatformResizeFailed | ResourceLimit | HostExiting)
            )
    );
    if !valid_reason {
        return Err(inconsistent("resize_receipt.reason"));
    }
    Ok(())
}

fn validate_standalone_terminate_receipt(
    frame: &super::StandaloneTerminateReceipt,
) -> Result<(), FrameValidationError> {
    use OperationReceiptReason::{AuthorizationDenied, HostExiting, ResourceLimit};
    use StandaloneTerminateReceiptState::{Accepted, Failed, Refused};

    let valid = matches!(
        (frame.state, frame.reason),
        (Accepted, None)
            | (Refused, Some(AuthorizationDenied | HostExiting))
            | (Failed, Some(ResourceLimit | HostExiting))
    );
    if valid {
        Ok(())
    } else {
        Err(inconsistent("standalone_terminate_receipt.reason"))
    }
}

fn validate_managed_provider_stop_receipt(
    frame: &super::ManagedProviderStopReceipt,
) -> Result<(), FrameValidationError> {
    use ManagedProviderStopReceiptState::{Accepted, Failed, Refused};
    use OperationReceiptReason::{
        AgentRuntimeChanged, AuthorizationDenied, HostExiting, ResourceLimit,
    };

    let valid = matches!(
        (frame.state, frame.reason),
        (Accepted, None)
            | (
                Refused,
                Some(AuthorizationDenied | HostExiting | AgentRuntimeChanged)
            )
            | (Failed, Some(ResourceLimit | HostExiting))
    );
    if valid {
        Ok(())
    } else {
        Err(inconsistent("managed_provider_stop_receipt.reason"))
    }
}

fn validate_control_receipt(frame: &super::ControlReceipt) -> Result<(), FrameValidationError> {
    // Why: a successful ownership transition increments the fence before the
    // Host accepts any mutation from the new posture. Refusal or failure must
    // preserve the old generation so it cannot accidentally mint authority.
    let changes_generation = matches!(
        frame.state,
        ControlReceiptState::Granted | ControlReceiptState::Released
    );
    if changes_generation && frame.controller_generation <= frame.previous_controller_generation {
        return Err(inconsistent("control_receipt.controller_generation"));
    }
    if !changes_generation && frame.controller_generation != frame.previous_controller_generation {
        return Err(inconsistent("control_receipt.controller_generation"));
    }

    use ControlReceiptState::{Failed, Granted, Refused, Released};
    use OperationReceiptReason::{
        AuthorizationDenied, ControllerConflict, HostExiting, ResourceLimit,
        StaleControllerGeneration,
    };
    let valid_reason = matches!(
        (frame.state, frame.reason),
        (Granted | Released, None)
            | (
                Refused,
                Some(ControllerConflict | StaleControllerGeneration | AuthorizationDenied)
            )
            | (Failed, Some(ResourceLimit | HostExiting))
    );
    if !valid_reason {
        return Err(inconsistent("control_receipt.reason"));
    }
    Ok(())
}

fn validate_hello_ack(
    frame: &HelloAck,
    envelope_version: ProtocolVersion,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    validate_version(frame.selected_version, "hello_ack.selected_version")?;
    if frame.selected_version != envelope_version {
        return Err(inconsistent("hello_ack.selected_version"));
    }
    validate_capabilities(
        &frame.selected_capabilities,
        limits,
        "hello_ack.capabilities",
    )?;
    validate_fence(&frame.actual_fence, limits)?;
    bounded_text(
        "hello_ack.host_build_version",
        &frame.host_build_version,
        limits.max_identifier_bytes,
        false,
    )?;
    validate_process_proof(&frame.host_process, limits, "hello_ack.host_process")?;
    if let Some(provider_process) = frame.provider_process.as_ref() {
        validate_process_proof(provider_process, limits, "hello_ack.provider_process")?;
    }
    if frame.earliest_retained_output_seq > frame.current_output_seq.saturating_add(1) {
        return Err(inconsistent("hello_ack.retained_sequence_range"));
    }
    Ok(())
}

pub(crate) fn validate_fence(
    fence: &SessionFence,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    if fence.channel_epoch == 0 {
        return Err(out_of_range("fence.channel_epoch"));
    }
    for (field, value) in [
        ("fence.workspace_id", fence.workspace_id.as_str()),
        ("fence.session_id", fence.session_id.as_str()),
        ("fence.runner_principal", fence.runner_principal.as_str()),
        ("fence.runner_instance", fence.runner_instance.as_str()),
        ("fence.host_instance_id", fence.host_instance_id.as_str()),
        ("fence.terminal_epoch", fence.terminal_epoch.as_str()),
    ] {
        bounded_text(field, value, limits.max_identifier_bytes, false)?;
    }
    Ok(())
}

pub(crate) fn validate_process_proof(
    proof: &ProcessProof,
    limits: &FrameLimits,
    field: &'static str,
) -> Result<(), FrameValidationError> {
    if proof.process_id == 0 {
        return Err(out_of_range(field));
    }
    bounded_text(
        field,
        &proof.start_marker,
        limits.max_identifier_bytes,
        false,
    )
}

pub(crate) fn bounded_text(
    field: &'static str,
    value: &str,
    maximum: usize,
    allow_empty: bool,
) -> Result<(), FrameValidationError> {
    if !allow_empty && value.is_empty() {
        return Err(FrameValidationError::Empty { field });
    }
    if value.len() > maximum {
        return Err(FrameValidationError::TooLong {
            field,
            actual: value.len(),
            maximum,
        });
    }
    Ok(())
}

fn bounded_bytes(
    field: &'static str,
    value: &[u8],
    maximum: usize,
    allow_empty: bool,
) -> Result<(), FrameValidationError> {
    if !allow_empty && value.is_empty() {
        return Err(FrameValidationError::Empty { field });
    }
    if value.len() > maximum {
        return Err(FrameValidationError::TooLong {
            field,
            actual: value.len(),
            maximum,
        });
    }
    Ok(())
}

fn optional_text(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), FrameValidationError> {
    value.map_or(Ok(()), |value| bounded_text(field, value, maximum, false))
}

fn validate_capabilities(
    capabilities: &[String],
    limits: &FrameLimits,
    field: &'static str,
) -> Result<(), FrameValidationError> {
    if capabilities.len() > limits.max_capabilities {
        return Err(FrameValidationError::TooMany {
            field,
            actual: capabilities.len(),
            maximum: limits.max_capabilities,
        });
    }
    for capability in capabilities {
        bounded_text(field, capability, limits.max_capability_bytes, false)?;
    }
    Ok(())
}

fn validate_dimensions(
    rows: u16,
    columns: u16,
    limits: &FrameLimits,
) -> Result<(), FrameValidationError> {
    if rows == 0 || rows > limits.max_rows {
        return Err(out_of_range("terminal.rows"));
    }
    if columns == 0 || columns > limits.max_columns {
        return Err(out_of_range("terminal.columns"));
    }
    if usize::from(rows) * usize::from(columns) > limits.max_cells {
        return Err(out_of_range("terminal.cells"));
    }
    Ok(())
}

fn validate_version(
    version: ProtocolVersion,
    field: &'static str,
) -> Result<(), FrameValidationError> {
    if version.major == 0 {
        return Err(out_of_range(field));
    }
    Ok(())
}

pub(crate) fn validate_version_range(
    range: VersionRange,
    field: &'static str,
) -> Result<(), FrameValidationError> {
    validate_version(range.minimum, field)?;
    validate_version(range.maximum, field)?;
    if range.minimum > range.maximum {
        return Err(inconsistent(field));
    }
    Ok(())
}

fn out_of_range(field: &'static str) -> FrameValidationError {
    FrameValidationError::OutOfRange { field }
}

fn inconsistent(field: &'static str) -> FrameValidationError {
    FrameValidationError::Inconsistent { field }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentIdentityProjection, AgentIdentitySource, AgentProvider, AgentRuntimeActivity,
        AgentRuntimeAttention, AgentRuntimeLifecycle, AgentRuntimeStateProjection,
        AgentRuntimeStateSource, AttachMode, AuthorizationPosture, ControlReceipt, ControlRelease,
        ControlRequest, FrameCodec, InputReceipt, LifecycleState, OperationReceiptReason,
        OutputDelta, PROTOCOL_V1, ReconnectCursor, ResizeReceipt, ScreenSnapshot,
        ScreenSnapshotEncoding, ScreenSnapshotRequest, StandaloneTerminateReceipt,
        WorkingDirectoryProjection, WorkingDirectorySource,
    };

    fn fence(identifier: &str) -> SessionFence {
        SessionFence {
            workspace_id: identifier.into(),
            session_id: identifier.into(),
            runner_principal: identifier.into(),
            runner_instance: identifier.into(),
            channel_epoch: 1,
            host_instance_id: identifier.into(),
            terminal_epoch: identifier.into(),
        }
    }

    fn frame(body: FrameBody) -> WireFrame {
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body,
        }
    }

    #[test]
    fn reconnect_cursor_must_match_the_expected_terminal_epoch() {
        let hello = Hello {
            supported_versions: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            requested_capabilities: vec![],
            expected_fence: fence("terminal-current"),
            requested_mode: AttachMode::Observer,
            reconnect_cursor: Some(ReconnectCursor {
                terminal_epoch: "terminal-stale".into(),
                after_output_seq: 4,
            }),
            capability_token: "token".into(),
            authorization_proof_reference: None,
            initial_snapshot_profile: None,
        };

        assert_eq!(
            frame(FrameBody::Hello(hello)).validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "hello.cursor.terminal_epoch",
            })
        );
    }

    #[test]
    fn hello_ack_selected_version_must_match_the_envelope() {
        let ack = HelloAck {
            selected_version: ProtocolVersion { major: 2, minor: 0 },
            selected_capabilities: vec![],
            actual_fence: fence("terminal-current"),
            host_build_version: "host-build".into(),
            lifecycle: LifecycleState::Observing,
            host_process: ProcessProof {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            provider_process: Some(ProcessProof {
                process_id: 11,
                start_marker: "provider-start".into(),
            }),
            earliest_retained_output_seq: 0,
            current_output_seq: 0,
            controller_generation: 0,
            authorization_posture: AuthorizationPosture::DaemonAuthorized,
        };

        assert_eq!(
            frame(FrameBody::HelloAck(ack)).validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "hello_ack.selected_version",
            })
        );
    }

    #[test]
    fn zero_channel_epoch_is_not_a_complete_session_fence() {
        let mut incomplete = fence("terminal-current");
        incomplete.channel_epoch = 0;
        let request = ScreenSnapshotRequest {
            request_id: "snapshot-request".into(),
            expected_fence: incomplete,
            profile: None,
        };

        assert_eq!(
            frame(FrameBody::ScreenSnapshotRequest(request)).validate(&FrameLimits::default()),
            Err(FrameValidationError::OutOfRange {
                field: "fence.channel_epoch",
            })
        );
    }

    #[test]
    fn non_success_input_receipt_requires_a_stable_reason() {
        let refused = InputReceipt {
            request_id: "request".into(),
            controller_generation: 2,
            state: InputReceiptState::Refused,
            reason: None,
            detail: None,
        };
        let explained = InputReceipt {
            reason: Some(OperationReceiptReason::ControllerConflict),
            detail: None,
            ..refused.clone()
        };

        assert!(
            frame(FrameBody::InputReceipt(refused))
                .validate(&FrameLimits::default())
                .is_err()
        );
        assert!(
            frame(FrameBody::InputReceipt(explained))
                .validate(&FrameLimits::default())
                .is_ok()
        );
    }

    #[test]
    fn invalid_resize_can_be_reported_without_fake_applied_dimensions() {
        let refused = ResizeReceipt {
            request_id: "request".into(),
            controller_generation: 2,
            rows: None,
            columns: None,
            state: ResizeReceiptState::Refused,
            reason: Some(OperationReceiptReason::InvalidTerminalDimensions),
        };
        let applied = ResizeReceipt {
            rows: Some(24),
            columns: Some(80),
            state: ResizeReceiptState::AppliedToTerminal,
            reason: None,
            ..refused.clone()
        };

        assert!(
            frame(FrameBody::ResizeReceipt(refused))
                .validate(&FrameLimits::default())
                .is_ok()
        );
        assert!(
            frame(FrameBody::ResizeReceipt(applied))
                .validate(&FrameLimits::default())
                .is_ok()
        );
    }

    #[test]
    fn standalone_termination_receipt_requires_a_reason_on_failure() {
        let failed = StandaloneTerminateReceipt {
            request_id: "terminate-1".into(),
            state: StandaloneTerminateReceiptState::Failed,
            reason: None,
        };
        let explained = StandaloneTerminateReceipt {
            reason: Some(OperationReceiptReason::HostExiting),
            ..failed.clone()
        };

        assert!(
            frame(FrameBody::StandaloneTerminateReceipt(failed))
                .validate(&FrameLimits::default())
                .is_err()
        );
        assert!(
            frame(FrameBody::StandaloneTerminateReceipt(explained))
                .validate(&FrameLimits::default())
                .is_ok()
        );
    }

    #[test]
    fn managed_provider_stop_receipt_requires_a_reason_on_failure() {
        let failed = crate::ManagedProviderStopReceipt {
            request_id: "stop-1".into(),
            state: ManagedProviderStopReceiptState::Failed,
            reason: None,
        };
        let explained = crate::ManagedProviderStopReceipt {
            reason: Some(OperationReceiptReason::HostExiting),
            ..failed.clone()
        };

        assert!(
            frame(FrameBody::ManagedProviderStopReceipt(failed))
                .validate(&FrameLimits::default())
                .is_err()
        );
        assert!(
            frame(FrameBody::ManagedProviderStopReceipt(explained))
                .validate(&FrameLimits::default())
                .is_ok()
        );

        let stale_quiescence = crate::ManagedProviderStopReceipt {
            request_id: "stop-stale-quiescence".into(),
            state: ManagedProviderStopReceiptState::Refused,
            reason: Some(OperationReceiptReason::AgentRuntimeChanged),
        };
        assert!(
            frame(FrameBody::ManagedProviderStopReceipt(stale_quiescence))
                .validate(&FrameLimits::default())
                .is_ok()
        );
    }

    #[test]
    fn receipt_reasons_must_match_the_operation_and_final_state() {
        let impossible = [
            frame(FrameBody::InputReceipt(InputReceipt {
                request_id: "input-request".into(),
                controller_generation: 2,
                state: InputReceiptState::Failed,
                reason: Some(OperationReceiptReason::PlatformResizeFailed),
                detail: None,
            })),
            frame(FrameBody::ResizeReceipt(ResizeReceipt {
                request_id: "resize-request".into(),
                controller_generation: 2,
                rows: None,
                columns: None,
                state: ResizeReceiptState::Refused,
                reason: Some(OperationReceiptReason::PlatformResizeFailed),
            })),
            frame(FrameBody::ControlReceipt(ControlReceipt {
                request_id: "control-request".into(),
                previous_controller_generation: 2,
                controller_generation: 2,
                state: ControlReceiptState::Failed,
                reason: Some(OperationReceiptReason::InputTooLarge),
            })),
        ];

        for receipt in impossible {
            assert!(receipt.validate(&FrameLimits::default()).is_err());
        }
    }

    #[test]
    fn failure_receipts_accept_only_their_operation_specific_reasons() {
        let valid = [
            frame(FrameBody::InputReceipt(InputReceipt {
                request_id: "input-request".into(),
                controller_generation: 2,
                state: InputReceiptState::Failed,
                reason: Some(OperationReceiptReason::PtyWriteFailed),
                detail: None,
            })),
            frame(FrameBody::ResizeReceipt(ResizeReceipt {
                request_id: "resize-request".into(),
                controller_generation: 2,
                rows: None,
                columns: None,
                state: ResizeReceiptState::Failed,
                reason: Some(OperationReceiptReason::PlatformResizeFailed),
            })),
            frame(FrameBody::ControlReceipt(ControlReceipt {
                request_id: "control-request".into(),
                previous_controller_generation: 2,
                controller_generation: 2,
                state: ControlReceiptState::Failed,
                reason: Some(OperationReceiptReason::ResourceLimit),
            })),
        ];

        for receipt in valid {
            assert!(receipt.validate(&FrameLimits::default()).is_ok());
        }
    }

    #[test]
    fn input_receipt_detail_is_a_bounded_token_and_survives_the_wire() {
        // A bounded snake_case detail is accepted and round-trips through the codec.
        let codec = FrameCodec::new(FrameLimits::default());
        let receipt = frame(FrameBody::InputReceipt(InputReceipt {
            request_id: "input-request".into(),
            controller_generation: 2,
            state: InputReceiptState::Failed,
            reason: Some(OperationReceiptReason::PtyWriteFailed),
            detail: Some("terminal_input_write_timeout".into()),
        }));
        assert!(receipt.validate(&FrameLimits::default()).is_ok());
        let encoded = codec.encode(&receipt).unwrap();
        let decoded = codec.decode(&encoded).unwrap();
        let FrameBody::InputReceipt(decoded) = decoded.body else {
            panic!("expected input receipt")
        };
        assert_eq!(
            decoded.detail.as_deref(),
            Some("terminal_input_write_timeout")
        );

        // Prose or an oversized value from an untrusted peer is rejected.
        for bad in [
            "wrote the instruction",
            "UPPER",
            "x",
            "1abc",
            "_abc",
            &"a".repeat(65),
        ] {
            let poisoned = frame(FrameBody::InputReceipt(InputReceipt {
                request_id: "input-request".into(),
                controller_generation: 2,
                state: InputReceiptState::Failed,
                reason: Some(OperationReceiptReason::PtyWriteFailed),
                detail: Some(bad.into()),
            }));
            assert!(
                poisoned.validate(&FrameLimits::default()).is_err(),
                "must reject detail {bad}"
            );
        }
    }

    #[test]
    fn control_request_and_release_are_bounded_protocol_frames() {
        let codec = FrameCodec::new(FrameLimits::default());
        for body in [
            FrameBody::ControlRequest(ControlRequest {
                request_id: "control-request".into(),
                expected_controller_generation: 5,
            }),
            FrameBody::ControlRelease(ControlRelease {
                request_id: "control-release".into(),
                controller_generation: 6,
            }),
        ] {
            let wire = frame(body);
            assert_eq!(codec.decode(&codec.encode(&wire).unwrap()).unwrap(), wire);
        }
    }

    #[test]
    fn control_receipt_correlates_success_and_advances_generation() {
        let granted = ControlReceipt {
            request_id: "control-request".into(),
            previous_controller_generation: 5,
            controller_generation: 6,
            state: ControlReceiptState::Granted,
            reason: None,
        };
        let stale_success = ControlReceipt {
            controller_generation: 5,
            ..granted.clone()
        };

        assert!(
            frame(FrameBody::ControlReceipt(granted))
                .validate(&FrameLimits::default())
                .is_ok()
        );
        assert_eq!(
            frame(FrameBody::ControlReceipt(stale_success)).validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "control_receipt.controller_generation",
            })
        );
    }

    #[test]
    fn default_maximum_snapshot_fits_the_default_frame_cap() {
        let limits = FrameLimits::default();
        let identifier = "i".repeat(limits.max_identifier_bytes);
        let snapshot = frame(FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: fence(&identifier),
            sequence_through: 1,
            rows: 24,
            columns: 80,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: vec![0; limits.max_snapshot_bytes],
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: Some("i".repeat(limits.max_identifier_bytes)),
        }));

        assert!(FrameCodec::new(limits).encode(&snapshot).is_ok());
    }

    #[test]
    fn working_directory_projection_is_fenced_and_ordered() {
        let valid = WorkingDirectoryProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 4,
            path: "/workspace".into(),
            source: WorkingDirectorySource::ProcessInspection,
        };
        let delta = frame(FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq: 4,
            bytes: b"prompt".to_vec(),
            rows: None,
            columns: None,
            working_directory: Some(valid.clone()),
            execution_location: None,
            agent_identity: None,
        }));
        assert!(delta.validate(&FrameLimits::default()).is_ok());

        for projection in [
            WorkingDirectoryProjection {
                terminal_epoch: "terminal-stale".into(),
                ..valid.clone()
            },
            WorkingDirectoryProjection {
                observed_through_output_seq: 5,
                ..valid.clone()
            },
        ] {
            let invalid = frame(FrameBody::OutputDelta(OutputDelta {
                terminal_epoch: "terminal-1".into(),
                output_seq: 4,
                bytes: b"prompt".to_vec(),
                rows: None,
                columns: None,
                working_directory: Some(projection),
                execution_location: None,
                agent_identity: None,
            }));
            assert_eq!(
                invalid.validate(&FrameLimits::default()),
                Err(FrameValidationError::Inconsistent {
                    field: "working_directory.fence_or_sequence",
                })
            );
        }
    }

    #[test]
    fn output_geometry_is_complete_and_bounded() {
        let output = |rows, columns| {
            frame(FrameBody::OutputDelta(OutputDelta {
                terminal_epoch: "terminal-1".into(),
                output_seq: 1,
                bytes: b"redraw".to_vec(),
                rows,
                columns,
                working_directory: None,
                execution_location: None,
                agent_identity: None,
            }))
        };

        assert!(
            output(Some(41), Some(132))
                .validate(&FrameLimits::default())
                .is_ok()
        );
        assert_eq!(
            output(Some(41), None).validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "output_delta.geometry",
            })
        );
        assert!(
            output(Some(0), Some(132))
                .validate(&FrameLimits::default())
                .is_err()
        );
    }

    #[test]
    fn execution_location_projection_is_fenced_ordered_and_bounded() {
        use crate::{ExecutionLocation, ExecutionLocationProjection, ExecutionLocationSource};

        let valid = ExecutionLocationProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 4,
            location: ExecutionLocation::Ssh {
                target: "rts@211.181.122.124".into(),
            },
            source: ExecutionLocationSource::ProcessInspection,
        };
        let delta = frame(FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq: 4,
            bytes: b"prompt".to_vec(),
            rows: None,
            columns: None,
            working_directory: None,
            execution_location: Some(valid.clone()),
            agent_identity: None,
        }));
        assert!(delta.validate(&FrameLimits::default()).is_ok());

        for projection in [
            ExecutionLocationProjection {
                observed_through_output_seq: 5,
                ..valid.clone()
            },
            ExecutionLocationProjection {
                location: ExecutionLocation::Ssh {
                    target: "bad target".into(),
                },
                ..valid.clone()
            },
        ] {
            let invalid = frame(FrameBody::OutputDelta(OutputDelta {
                terminal_epoch: "terminal-1".into(),
                output_seq: 4,
                bytes: b"prompt".to_vec(),
                rows: None,
                columns: None,
                working_directory: None,
                execution_location: Some(projection),
                agent_identity: None,
            }));
            assert!(invalid.validate(&FrameLimits::default()).is_err());
        }
    }

    #[test]
    fn agent_identity_projection_is_fenced_and_ordered() {
        let valid = AgentIdentityProjection {
            terminal_epoch: "terminal-1".into(),
            observed_through_output_seq: 4,
            agent: Some(AgentProvider::Claude),
            source: AgentIdentitySource::ProcessInspection,
        };
        assert!(
            frame(FrameBody::AgentIdentity(valid.clone()))
                .validate(&FrameLimits::default())
                .is_ok()
        );
        let delta = frame(FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq: 4,
            bytes: b"prompt".to_vec(),
            rows: None,
            columns: None,
            working_directory: None,
            execution_location: None,
            agent_identity: Some(valid.clone()),
        }));
        assert!(delta.validate(&FrameLimits::default()).is_ok());

        let invalid = frame(FrameBody::OutputDelta(OutputDelta {
            terminal_epoch: "terminal-1".into(),
            output_seq: 4,
            bytes: b"prompt".to_vec(),
            rows: None,
            columns: None,
            working_directory: None,
            execution_location: None,
            agent_identity: Some(AgentIdentityProjection {
                observed_through_output_seq: 5,
                ..valid
            }),
        }));
        assert_eq!(
            invalid.validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "agent_identity.fence_or_sequence",
            })
        );
    }

    #[test]
    fn agent_runtime_state_is_fenced_revisioned_and_semantically_consistent() {
        let valid = AgentRuntimeStateProjection {
            terminal_epoch: "terminal-1".into(),
            revision: 2,
            observed_through_output_seq: 4,
            lifecycle: AgentRuntimeLifecycle::Running,
            activity: AgentRuntimeActivity::Waiting,
            attention: AgentRuntimeAttention::ApprovalRequired,
            attention_id: Some("attention-2".into()),
            source: AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: 0,
        };
        let state = frame(FrameBody::AgentRuntimeState(valid.clone()));
        assert!(state.validate(&FrameLimits::default()).is_ok());

        for (projection, field) in [
            (
                AgentRuntimeStateProjection {
                    revision: 0,
                    ..valid.clone()
                },
                "agent_runtime_state.revision",
            ),
            (
                AgentRuntimeStateProjection {
                    activity: AgentRuntimeActivity::Working,
                    ..valid.clone()
                },
                "agent_runtime_state.attention_activity",
            ),
            (
                AgentRuntimeStateProjection {
                    attention_id: None,
                    ..valid.clone()
                },
                "agent_runtime_state.attention_id",
            ),
        ] {
            let result = frame(FrameBody::AgentRuntimeState(projection.clone()))
                .validate(&FrameLimits::default());
            assert!(
                matches!(
                    result,
                    Err(FrameValidationError::OutOfRange { field: actual })
                        | Err(FrameValidationError::Inconsistent { field: actual })
                        if actual == field
                ),
                "unexpected validation result for {projection:?}: {result:?}"
            );
        }

        let snapshot = frame(FrameBody::ScreenSnapshot(ScreenSnapshot {
            fence: fence("terminal-1"),
            sequence_through: 3,
            rows: 24,
            columns: 80,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: vec![],
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: Some(valid),
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        }));
        assert_eq!(
            snapshot.validate(&FrameLimits::default()),
            Err(FrameValidationError::Inconsistent {
                field: "agent_runtime_state.fence_or_sequence",
            })
        );
    }

    #[test]
    fn semantic_idle_snapshot_is_additive_and_requires_current_quiescent_state() {
        let mut snapshot = ScreenSnapshot {
            fence: fence("terminal-1"),
            sequence_through: 4,
            rows: 24,
            columns: 80,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: Some(false),
            semantic_idle_ms: Some(86_400_000),
            repaint_bytes: b"screen".to_vec(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: Some(AgentRuntimeStateProjection {
                terminal_epoch: "terminal-1".into(),
                revision: 3,
                observed_through_output_seq: 4,
                lifecycle: AgentRuntimeLifecycle::Running,
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::None,
                attention_id: None,
                source: AgentRuntimeStateSource::ProviderEvent,
                turn_completed_count: 1,
            }),
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        };
        assert_eq!(
            frame(FrameBody::ScreenSnapshot(snapshot.clone())).validate(&FrameLimits::default()),
            Ok(())
        );
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["semantic_idle_ms"], "86400000");
        for value in [
            serde_json::json!(0),
            serde_json::json!("01"),
            serde_json::json!("18446744073709551616"),
        ] {
            let mut malformed = wire.clone();
            malformed["semantic_idle_ms"] = value;
            assert!(serde_json::from_value::<ScreenSnapshot>(malformed).is_err());
        }
        let mut legacy = wire;
        legacy.as_object_mut().unwrap().remove("semantic_idle_ms");
        let legacy: ScreenSnapshot = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.semantic_idle_ms, None);
        for pending in [None, Some(true)] {
            snapshot.controller_input_pending = pending;
            assert_eq!(
                frame(FrameBody::ScreenSnapshot(snapshot.clone()))
                    .validate(&FrameLimits::default()),
                Err(FrameValidationError::Inconsistent {
                    field: "screen_snapshot.semantic_idle_ms"
                })
            );
        }
        snapshot.controller_input_pending = Some(false);
        snapshot.agent_runtime_state.as_mut().unwrap().source =
            AgentRuntimeStateSource::ProcessLifecycle;
        assert!(
            frame(FrameBody::ScreenSnapshot(snapshot.clone()))
                .validate(&FrameLimits::default())
                .is_err()
        );
        snapshot.agent_runtime_state = None;
        assert!(
            frame(FrameBody::ScreenSnapshot(snapshot))
                .validate(&FrameLimits::default())
                .is_err()
        );
    }

    #[test]
    fn agent_state_reports_are_bounded_consistent_and_round_trip() {
        use crate::{
            AGENT_STATE_REPORT_MAX_WORKING_TTL_MS, AgentStateReport,
            AgentStateReportObservationFence, AgentStateReportOutcome, AgentStateReportReceipt,
            ProviderConversationIdentityReport,
        };

        let codec = FrameCodec::new(FrameLimits::default());
        let valid = AgentStateReport {
            request_id: "report-1".into(),
            identity_only: false,
            activity: AgentRuntimeActivity::Working,
            attention: AgentRuntimeAttention::None,
            turn_completed: true,
            turn_completion_id: Some("turn-0199aaaa-bbbb-7ac2".into()),
            causality: None,
            working_ttl_ms: Some(600_000),
            conversation_identity: None,
            expected_observation: None,
        };
        for report in [
            valid.clone(),
            AgentStateReport {
                causality: Some(crate::AgentStateReportCausality {
                    sequence: 7,
                    work_id: valid.turn_completion_id.clone(),
                }),
                ..valid.clone()
            },
            AgentStateReport {
                working_ttl_ms: None,
                ..valid.clone()
            },
            AgentStateReport {
                activity: AgentRuntimeActivity::Waiting,
                attention: AgentRuntimeAttention::ApprovalRequired,
                ..valid.clone()
            },
            AgentStateReport {
                expected_observation: Some(AgentStateReportObservationFence {
                    terminal_epoch: "terminal-1".into(),
                    runtime_revision: 4,
                    output_sequence: 0,
                }),
                ..valid.clone()
            },
        ] {
            let wire = frame(FrameBody::AgentStateReport(report));
            assert_eq!(codec.decode(&codec.encode(&wire).unwrap()).unwrap(), wire);
        }

        for (invalid, field) in [
            (
                AgentStateReport {
                    causality: Some(crate::AgentStateReportCausality {
                        sequence: 0,
                        work_id: valid.turn_completion_id.clone(),
                    }),
                    ..valid.clone()
                },
                "agent_state_report.causality.sequence",
            ),
            (
                AgentStateReport {
                    causality: Some(crate::AgentStateReportCausality {
                        sequence: 8,
                        work_id: Some("different-work".into()),
                    }),
                    ..valid.clone()
                },
                "agent_state_report.causality",
            ),
            (
                AgentStateReport {
                    causality: Some(crate::AgentStateReportCausality {
                        sequence: 8,
                        work_id: None,
                    }),
                    ..valid.clone()
                },
                "agent_state_report.causality",
            ),
            (
                AgentStateReport {
                    turn_completed: false,
                    ..valid.clone()
                },
                "agent_state_report.turn_completion_id",
            ),
            (
                AgentStateReport {
                    identity_only: true,
                    conversation_identity: None,
                    ..valid.clone()
                },
                "agent_state_report.identity_only_conversation_identity",
            ),
            (
                AgentStateReport {
                    attention: AgentRuntimeAttention::InputRequired,
                    ..valid.clone()
                },
                "agent_state_report.attention_activity",
            ),
            (
                AgentStateReport {
                    working_ttl_ms: Some(0),
                    ..valid.clone()
                },
                "agent_state_report.working_ttl_ms",
            ),
            (
                AgentStateReport {
                    working_ttl_ms: Some(AGENT_STATE_REPORT_MAX_WORKING_TTL_MS + 1),
                    ..valid.clone()
                },
                "agent_state_report.working_ttl_ms",
            ),
            (
                AgentStateReport {
                    expected_observation: Some(AgentStateReportObservationFence {
                        terminal_epoch: "terminal-1".into(),
                        runtime_revision: 0,
                        output_sequence: 0,
                    }),
                    ..valid.clone()
                },
                "agent_state_report.expected_observation.runtime_revision",
            ),
            (
                AgentStateReport {
                    identity_only: true,
                    conversation_identity: Some(ProviderConversationIdentityReport {
                        provider_id: "codex".into(),
                        conversation_id: "conversation-1".into(),
                        expected_fence: None,
                    }),
                    expected_observation: Some(AgentStateReportObservationFence {
                        terminal_epoch: "terminal-1".into(),
                        runtime_revision: 1,
                        output_sequence: 0,
                    }),
                    ..valid.clone()
                },
                "agent_state_report.identity_only_expected_observation",
            ),
            (
                AgentStateReport {
                    conversation_identity: Some(ProviderConversationIdentityReport {
                        provider_id: "codex".into(),
                        conversation_id: "conversation-1".into(),
                        expected_fence: None,
                    }),
                    expected_observation: Some(AgentStateReportObservationFence {
                        terminal_epoch: "terminal-1".into(),
                        runtime_revision: 1,
                        output_sequence: 0,
                    }),
                    ..valid.clone()
                },
                "agent_state_report.expected_observation_conversation_identity",
            ),
        ] {
            let result =
                frame(FrameBody::AgentStateReport(invalid)).validate(&FrameLimits::default());
            assert!(
                matches!(
                    result,
                    Err(FrameValidationError::Inconsistent { field: actual })
                        | Err(FrameValidationError::OutOfRange { field: actual })
                        if actual == field
                ),
                "unexpected validation result: {result:?}"
            );
        }

        for outcome in [
            AgentStateReportOutcome::Applied,
            AgentStateReportOutcome::DroppedExited,
            AgentStateReportOutcome::NoOp,
        ] {
            let wire = frame(FrameBody::AgentStateReportReceipt(
                AgentStateReportReceipt {
                    request_id: "report-1".into(),
                    outcome,
                    provider_conversation_identity: None,
                },
            ));
            assert_eq!(codec.decode(&codec.encode(&wire).unwrap()).unwrap(), wire);
        }
    }

    #[test]
    fn turn_completed_count_is_additive_in_both_directions() {
        // Old host -> new client: a projection emitted before the field
        // existed deserializes with a zero count.
        let legacy = br#"{"terminal_epoch":"terminal-1","revision":"2","observed_through_output_seq":"1","lifecycle":"running","activity":"working","attention":"none","source":"provider_event"}"#;
        let decoded: AgentRuntimeStateProjection = serde_json::from_slice(legacy).unwrap();
        assert_eq!(decoded.turn_completed_count, 0);

        // New host -> old client: these projection structs tolerate unknown
        // fields, so a projection carrying the counter (or any later additive
        // field) still deserializes for peers that predate it.
        let future = br#"{"terminal_epoch":"terminal-1","revision":"2","observed_through_output_seq":"1","lifecycle":"running","activity":"working","attention":"none","source":"provider_event","turn_completed_count":"3","future_additive_field":true}"#;
        let decoded: AgentRuntimeStateProjection = serde_json::from_slice(future).unwrap();
        assert_eq!(decoded.turn_completed_count, 3);

        // A zero count is omitted, so unchanged hosts emit unchanged wire
        // bytes; a nonzero count round-trips as a canonical decimal string.
        let mut projection = decoded;
        projection.turn_completed_count = 0;
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(!serialized.contains("turn_completed_count"));
        projection.turn_completed_count = 3;
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(serialized.contains(r#""turn_completed_count":"3""#));
        assert_eq!(
            serde_json::from_str::<AgentRuntimeStateProjection>(&serialized).unwrap(),
            projection
        );
    }

    #[test]
    fn legacy_frames_without_cwd_projection_still_decode() {
        let json = br#"{"protocol_version":{"major":1,"minor":0},"frame_id":"1","body":{"kind":"output_delta","payload":{"terminal_epoch":"terminal-1","output_seq":"1","bytes":"cHJvbXB0"}}}"#;
        let decoded: WireFrame = serde_json::from_slice(json).unwrap();
        let FrameBody::OutputDelta(delta) = decoded.body else {
            panic!("legacy output delta must retain its frame kind");
        };

        assert_eq!(delta.bytes, b"prompt");
        assert!(delta.working_directory.is_none());
        assert!(delta.agent_identity.is_none());
        assert!(delta.working_directory.is_none());
    }
}
