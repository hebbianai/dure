use super::{
    AgentRuntimeActivity, AgentRuntimeAttention, AgentRuntimeStateSource,
    AgentStateReportObservation, TerminalReplay, TerminalReplayError,
};

impl TerminalReplay {
    pub(super) fn causal_report_matches(
        &self,
        report: &AgentStateReportObservation,
    ) -> Result<bool, TerminalReplayError> {
        let Some(incoming) = &report.causality else {
            // Once ordered evidence owns this epoch, unsequenced input can
            // conservatively protect work, but cannot establish quiescence.
            return Ok(self.report_causality.is_none()
                || report.activity == AgentRuntimeActivity::Working
                || report.attention != AgentRuntimeAttention::None);
        };
        if incoming.sequence == 0
            || incoming.work_id.as_ref().is_some_and(|id| {
                id.is_empty()
                    || id.len() > 256
                    || !id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
            })
            || (report.turn_completed
                && (incoming.work_id.is_none() || incoming.work_id != report.turn_completion_id))
        {
            return Err(TerminalReplayError::InvalidAgentRuntimeState);
        }
        if self
            .report_causality
            .as_ref()
            .is_some_and(|current| incoming.sequence <= current.sequence)
        {
            return Ok(false);
        }
        if report.turn_completed {
            return Ok(self.report_causality.as_ref().is_some_and(|current| {
                current.work_id.is_some() && current.work_id == incoming.work_id
            }));
        }
        if report.activity == AgentRuntimeActivity::Working
            || report.attention != AgentRuntimeAttention::None
        {
            return Ok(true);
        }
        // Bootstrap has no work identity to acknowledge input or contradict
        // semantic work that an older reporter already established.
        Ok(self.report_causality.is_none()
            && !self.has_pending_controller_input()
            && !self.agent_runtime_state.as_ref().is_some_and(|current| {
                current.activity == AgentRuntimeActivity::Working
                    && matches!(
                        current.source,
                        AgentRuntimeStateSource::ProviderEvent
                            | AgentRuntimeStateSource::OrchestrationEvent
                    )
            }))
    }

    pub(super) fn remember_report_causality(&mut self, report: &AgentStateReportObservation) {
        match &report.causality {
            Some(incoming) => {
                let work_id = if report.activity == AgentRuntimeActivity::Working {
                    incoming.work_id.clone()
                } else {
                    self.report_causality
                        .as_ref()
                        .and_then(|current| current.work_id.clone())
                };
                self.report_causality = Some(crate::local_protocol::AgentStateReportCausality {
                    sequence: incoming.sequence,
                    work_id,
                });
            }
            None => {
                // An unsequenced update may represent new work. Preserve the
                // watermark, but require a new identified begin before idle.
                if let Some(current) = self.report_causality.as_mut() {
                    current.work_id = None;
                }
            }
        }
    }
}
