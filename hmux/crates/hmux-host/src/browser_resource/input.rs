//! One Host admission and controller-transfer boundary for held input.

use super::*;

pub(super) enum Purpose {
    Action(BrowserOperationId, NonZeroU64),
    Transfer(BrowserControllerId),
}

impl BrowserResourceHost {
    pub(super) fn input_action_authority(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&permit.resource)?;
        self.require_ready()?;
        if !self.active.as_ref().is_some_and(|active| {
            active.operation == permit.operation && active.sequence == permit.sequence
        }) {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub(super) fn require_input_purpose(
        &self,
        resource: &BrowserResourceIdentity,
        purpose: &Purpose,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        self.require_ready()?;
        let matches = match purpose {
            Purpose::Action(operation, sequence) => self.active.as_ref().is_some_and(|active| {
                &active.operation == operation && &active.sequence == sequence
            }),
            Purpose::Transfer(controller) => {
                !self.input_in_flight() && self.requested_controller.as_ref() == Some(controller)
            }
        };
        if !matches {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub(super) fn grant_drained_input_transfer(&mut self) -> Result<(), BrowserAdmissionError> {
        if self.phase.projection() == BrowserResourcePhase::Ready
            && !self.input_in_flight()
            && !self.pointer_held()
            && !self.keyboard_held()
            && !self.touch_held()
        {
            if let Some(controller) = self.requested_controller.clone() {
                self.grant_control(controller)?;
            }
        }
        Ok(())
    }
}
