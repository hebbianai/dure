use hmux_host::local_protocol::AgentPromptCapabilitySelection;
use terminal_state_protocol::{
    TerminalStateRecord, decode_record, terminal_state_record, viewport_intent,
};

use crate::Result;
use crate::input_transaction::InputAdmission;

pub(crate) struct IngressPermissions<'a> {
    pub(crate) viewport: bool,
    pub(crate) input: bool,
    pub(crate) agent_prompt: Option<AgentPromptCapabilitySelection>,
    pub(crate) process_observed_agent_prompt: bool,
    pub(crate) wheel: bool,
    pub(crate) default_colors: bool,
    pub(crate) base_protocol_minor: u8,
    pub(crate) host_provider_id: &'a str,
}

pub(crate) enum StructuredUpstream {
    Input {
        record_id: u64,
        record: TerminalStateRecord,
        admission: InputAdmission,
    },
    ViewportIntent {
        record: terminal_state_protocol::DecodedRecord,
    },
    Unauthorized(&'static str),
}

pub(crate) fn decode_upstream(
    payload: &[u8],
    permissions: IngressPermissions<'_>,
) -> Result<StructuredUpstream> {
    let decoded = decode_record(payload)?;
    let wheel = matches!(
        decoded.record.body.as_ref(),
        Some(terminal_state_record::Body::ViewportIntent(intent))
            if matches!(intent.intent, Some(viewport_intent::Intent::Wheel(_)))
    );
    let default_colors = matches!(
        decoded.record.body.as_ref(),
        Some(terminal_state_record::Body::ViewportIntent(intent))
            if matches!(
                intent.intent,
                Some(viewport_intent::Intent::TerminalDefaultColors(_))
            )
    );
    let input_admission = match decoded.record.body.as_ref() {
        Some(terminal_state_record::Body::InputIntent(intent)) => {
            Some(InputAdmission::from_validated_structured(
                intent
                    .intent
                    .as_ref()
                    .ok_or("structured input intent is empty")?,
                permissions.agent_prompt,
                permissions.process_observed_agent_prompt,
                permissions.host_provider_id,
            ))
        }
        _ => None,
    };
    let unauthorized = match decoded.record.body.as_ref() {
        Some(terminal_state_record::Body::ViewportIntent(_)) if !permissions.viewport => {
            Some(hmux_runtime_contract::TERMINAL_VIEWPORT_PROJECTION_CAPABILITY)
        }
        Some(terminal_state_record::Body::ViewportIntent(_)) if wheel && !permissions.wheel => {
            Some(hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_CAPABILITY)
        }
        Some(terminal_state_record::Body::ViewportIntent(_))
            if default_colors && !permissions.default_colors =>
        {
            Some(hmux_runtime_contract::TERMINAL_DEFAULT_COLORS_CAPABILITY)
        }
        Some(terminal_state_record::Body::InputIntent(_)) => match input_admission.as_ref() {
            Some(Err(required_capability)) => Some(*required_capability),
            Some(Ok(InputAdmission::Ordinary)) if !permissions.input => {
                Some(hmux_runtime_contract::TERMINAL_INPUT_INTENT_CAPABILITY)
            }
            Some(Ok(_)) => None,
            None => unreachable!("input body must carry parsed admission"),
        },
        Some(terminal_state_record::Body::ViewportIntent(_)) => None,
        _ => return Err("structured upstream record has no supported intent".into()),
    };
    if let Some(capability) = unauthorized {
        return Ok(StructuredUpstream::Unauthorized(capability));
    }
    let permitted_minor = if default_colors && permissions.default_colors {
        hmux_runtime_contract::TERMINAL_DEFAULT_COLORS_PROTOCOL_VERSION.envelope_minor
    } else if wheel && permissions.wheel {
        hmux_runtime_contract::TERMINAL_VIEWPORT_WHEEL_PROTOCOL_VERSION.envelope_minor
    } else {
        permissions.base_protocol_minor
    };
    if decoded.metadata.protocol_minor > permitted_minor {
        return Err(format!(
            "structured upstream protocol minor {} exceeds selected record minor {}",
            decoded.metadata.protocol_minor, permitted_minor
        )
        .into());
    }
    match decoded.record.body.as_ref() {
        Some(terminal_state_record::Body::ViewportIntent(_)) => {
            Ok(StructuredUpstream::ViewportIntent { record: decoded })
        }
        Some(terminal_state_record::Body::InputIntent(_)) => Ok(StructuredUpstream::Input {
            record_id: decoded.metadata.record_id,
            record: decoded.record,
            admission: input_admission
                .expect("input body must carry parsed admission")
                .expect("capability refusal returned before minor validation"),
        }),
        _ => unreachable!("supported upstream body was checked before minor validation"),
    }
}
