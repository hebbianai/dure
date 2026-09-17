//! The admitted action owns creation progress across the adapter's reply wait.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserPageCreationState {
    Prepared,
    Pending,
    Rejected,
    Accounted,
}

pub(super) struct PageCreation {
    pub(super) instance: BrowserInstanceId,
    pub(super) state: BrowserPageCreationState,
    pub(super) kind: CreationKind,
    pub(super) target: Option<BrowserTargetId>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum CreationKind {
    Page,
    Replacement,
}

/// A queued native creation retains its exact action and destination instance.
/// It cannot be cloned, deserialized or reused for a later command sequence.
pub struct BrowserPageCreationPermit {
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    page: BrowserPageIdentity,
    instance: BrowserInstanceId,
}

impl BrowserResourceHost {
    pub fn prepare_page_creation(
        &mut self,
        permit: &BrowserActionPermit,
    ) -> Result<BrowserPageCreationPermit, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?;
        let instance = self
            .instance_for_target(target)
            .ok_or(BrowserAdmissionError::InstanceMismatch)?
            .clone();
        self.prepare_page_creation_in(permit, &instance)
    }

    pub fn prepare_page_creation_in(
        &mut self,
        permit: &BrowserActionPermit,
        instance: &BrowserInstanceId,
    ) -> Result<BrowserPageCreationPermit, BrowserAdmissionError> {
        self.prepare_creation(permit, instance, CreationKind::Page)
    }

    /// Reserve the action's sole replacement before admitting its native owner.
    pub fn prepare_page_replacement(
        &mut self,
        permit: &BrowserActionPermit,
        instance: &BrowserInstanceId,
    ) -> Result<BrowserPageCreationPermit, BrowserAdmissionError> {
        if !permit.references.is_empty() {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        self.prepare_creation(permit, instance, CreationKind::Replacement)
    }

    fn prepare_creation(
        &mut self,
        permit: &BrowserActionPermit,
        instance: &BrowserInstanceId,
        kind: CreationKind,
    ) -> Result<BrowserPageCreationPermit, BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        if kind == CreationKind::Page {
            self.require_active_instance(instance)?;
        } else if self.instances.get(instance) == Some(&instances::InstanceState::Retiring) {
            return Err(BrowserAdmissionError::ResourceRetiring);
        }
        let active = self
            .active
            .as_mut()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.page_creation.is_some() {
            return Err(BrowserAdmissionError::CommandAlreadyDispatched);
        }
        if kind == CreationKind::Replacement && active.creation_label.is_some() {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        active.page_creation = Some(PageCreation {
            instance: instance.clone(),
            state: BrowserPageCreationState::Prepared,
            kind,
            target: None,
        });
        Ok(BrowserPageCreationPermit {
            operation: permit.operation.clone(),
            sequence: permit.sequence,
            page: permit.page.clone(),
            instance: instance.clone(),
        })
    }

    pub fn begin_page_creation(
        &mut self,
        permit: &BrowserPageCreationPermit,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_creation_state(permit, BrowserPageCreationState::Prepared)?;
        self.target_for(&permit.page)?;
        if instance != &permit.instance {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        self.require_active_instance(instance)?;
        if self
            .active
            .as_ref()
            .unwrap()
            .page_creation
            .as_ref()
            .unwrap()
            .kind
            == CreationKind::Page
            && self.live_page_capacity() >= MAX_LIVE_PAGES
        {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        self.set_creation_state(BrowserPageCreationState::Pending);
        Ok(())
    }

    pub fn reserve_created_page_target(
        &mut self,
        permit: &BrowserPageCreationPermit,
        target: BrowserTargetId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&permit.page.resource)?;
        self.require_active_instance(&permit.instance)?;
        self.require_creation_state(permit, BrowserPageCreationState::Pending)?;
        let kind = self
            .active
            .as_ref()
            .unwrap()
            .page_creation
            .as_ref()
            .unwrap()
            .kind;
        if kind == CreationKind::Replacement {
            if self.owns_page_target(&target) {
                return Err(BrowserAdmissionError::InstanceMismatch);
            }
            let revision = advance(self.revision)?;
            self.reserved_targets.insert(
                target.clone(),
                targets::TargetReservation {
                    label: None,
                    instance: permit.instance.clone(),
                    kind: targets::ReservationKind::Replacement(None),
                },
            );
            self.revision = revision;
        } else {
            self.reserve_page_target(
                &permit.page.resource,
                permit.instance.clone(),
                target.clone(),
            )?;
            self.reserved_targets.get_mut(&target).unwrap().label =
                self.active.as_ref().unwrap().creation_label.clone();
        }
        self.active
            .as_mut()
            .unwrap()
            .page_creation
            .as_mut()
            .unwrap()
            .target = Some(target);
        self.set_creation_state(BrowserPageCreationState::Accounted);
        Ok(())
    }

    /// A native protocol rejection proves no target was created by this request.
    pub fn page_creation_rejected(
        &mut self,
        permit: &BrowserPageCreationPermit,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_creation_state(permit, BrowserPageCreationState::Pending)?;
        self.set_creation_state(BrowserPageCreationState::Rejected);
        Ok(())
    }

    /// Use only after exact native absence confirms cleanup of an unbound target.
    pub fn created_page_retired(
        &mut self,
        permit: &BrowserPageCreationPermit,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_creation_state(permit, BrowserPageCreationState::Pending)?;
        self.set_creation_state(BrowserPageCreationState::Accounted);
        Ok(())
    }

    pub fn page_creation_state(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<Option<BrowserPageCreationState>, BrowserAdmissionError> {
        Ok(self.action_creation(permit)?.map(|creation| creation.state))
    }

    /// Return only the exact target accounted to this admitted creation.
    pub fn created_page_target(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<&BrowserTargetId, BrowserAdmissionError> {
        let creation = self
            .action_creation(permit)?
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if creation.state != BrowserPageCreationState::Accounted {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        creation
            .target
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)
    }

    pub fn page_creation_instance(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<Option<&BrowserInstanceId>, BrowserAdmissionError> {
        Ok(self
            .action_creation(permit)?
            .map(|creation| &creation.instance))
    }

    pub(super) fn replacement_instance_admitted(&self, instance: &BrowserInstanceId) -> bool {
        self.active
            .as_ref()
            .and_then(|active| active.page_creation.as_ref())
            .is_some_and(|creation| {
                creation.kind == CreationKind::Replacement && &creation.instance == instance
            })
    }

    pub(super) fn action_creation(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<Option<&PageCreation>, BrowserAdmissionError> {
        self.require_identity(&permit.resource)?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.operation != permit.operation || active.sequence != permit.sequence {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(active.page_creation.as_ref())
    }

    fn set_creation_state(&mut self, state: BrowserPageCreationState) {
        self.active
            .as_mut()
            .unwrap()
            .page_creation
            .as_mut()
            .unwrap()
            .state = state;
    }

    fn require_creation_state(
        &self,
        permit: &BrowserPageCreationPermit,
        expected: BrowserPageCreationState,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&permit.page.resource)?;
        self.require_ready()?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.operation != permit.operation || active.sequence != permit.sequence {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        if active.page_creation.as_ref().map(|creation| creation.state) != Some(expected) {
            return Err(BrowserAdmissionError::CommandAlreadyDispatched);
        }
        if active
            .page_creation
            .as_ref()
            .map(|creation| &creation.instance)
            != Some(&permit.instance)
        {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
