use super::*;

#[derive(Clone)]
pub(in crate::authority) struct PreparedRequest {
    pub(in crate::authority) authority: Authority,
    pub(super) operation_id: OperationIdV1,
    pub(super) request_digest: String,
    pub(super) action: PreparedAction,
}

impl PreparedRequest {
    pub(in crate::authority) fn directory_removal(&self) -> Option<(&GitCheckoutInstanceV1, bool)> {
        match &self.action {
            PreparedAction::Permit { instance, .. } => Some((instance, true)),
            PreparedAction::AbortRemoval { instance, .. } => Some((instance, false)),
            _ => None,
        }
    }

    #[cfg(unix)]
    pub(in crate::authority) fn operation_digest(&self) -> &str {
        &self.request_digest
    }

    #[cfg(unix)]
    pub(in crate::authority) fn creation_abort(
        &self,
        operation_id: OperationIdV1,
        reservation_token: &str,
    ) -> Result<Self, GitCheckoutUseError> {
        let action = PreparedAction::AbortCreation {
            reservation_token: reservation_token.to_owned(),
            quiescent_start: match self.action {
                PreparedAction::StartCreation { .. } => {
                    Some((self.operation_id.clone(), self.request_digest.clone()))
                }
                PreparedAction::Reserve { .. } => None,
                _ => {
                    return Err(state_error(
                        "creation abort requires a reservation or bound start",
                    ));
                }
            },
        };
        Ok(Self {
            authority: self.authority.clone(),
            request_digest: request_digest(&self.authority, &operation_id, &action)?,
            operation_id,
            action,
        })
    }

    #[cfg(unix)]
    pub(in crate::authority) fn creation_start(
        &self,
        operation_id: OperationIdV1,
        reservation_token: &str,
    ) -> Result<Self, GitCheckoutUseError> {
        let action = PreparedAction::StartCreation {
            reservation_token: reservation_token.to_owned(),
        };
        Ok(Self {
            authority: self.authority.clone(),
            request_digest: request_digest(&self.authority, &operation_id, &action)?,
            operation_id,
            action,
        })
    }

    #[cfg(unix)]
    pub(in crate::authority) fn retire_absent(
        &self,
        operation_id: OperationIdV1,
    ) -> Result<Self, GitCheckoutUseError> {
        let action = PreparedAction::RetireAbsent;
        Ok(Self {
            authority: self.authority.clone(),
            request_digest: request_digest(&self.authority, &operation_id, &action)?,
            operation_id,
            action,
        })
    }

    #[cfg(unix)]
    pub(in crate::authority) fn matches_operation(&self, id: &str, digest: &str) -> bool {
        self.operation_id.as_str() == id && self.request_digest == digest
    }

    /// A completed creator already owns its reservation claim. Resolve that
    /// registration by replaying its stored activation, not by minting a Claim
    /// with a different payload under the reservation's immutable operation ID.
    pub(in crate::authority) fn for_registration(
        mut self,
        state: Option<&State>,
    ) -> Result<Self, GitCheckoutUseError> {
        let PreparedAction::Claim {
            instance,
            instance_digest,
            owner_id,
        } = &self.action
        else {
            return Err(state_error(
                "registration resolution requires a prepared claim",
            ));
        };
        let Some(state) = state else {
            return Ok(self);
        };
        let creation = match &state.lifecycle {
            Lifecycle::Active { creation, .. } | Lifecycle::Removing { creation, .. } => creation,
            Lifecycle::Removed(RemovedState::Physical(removed)) => &removed.creation,
            _ => return Ok(self),
        };
        let Some(creation) = creation else {
            return Ok(self);
        };
        if creation.reservation.operation_id != self.operation_id.as_str()
            || !state
                .claims
                .get(self.operation_id.as_str())
                .is_some_and(|claim| claim.owner_id == owner_id.as_str())
        {
            return Ok(self);
        }
        self.operation_id = OperationIdV1::new(creation.activation.operation_id.clone())
            .map_err(|_| state_error("stored creation activation operation id is invalid"))?;
        self.action = PreparedAction::Activate {
            instance: instance.clone(),
            instance_digest: instance_digest.clone(),
            reservation_token: creation.reservation.token.clone(),
        };
        self.request_digest = request_digest(&self.authority, &self.operation_id, &self.action)?;
        Ok(self)
    }
}
