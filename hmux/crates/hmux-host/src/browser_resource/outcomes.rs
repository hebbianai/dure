//! Unknown effects retain their native owners until exact binding retirement.
use super::*;
use creation::BrowserPageCreationState;

pub(super) enum Phase {
    Ready,
    OutcomeUnknown(BTreeSet<BrowserInstanceId>),
    Retiring,
    Closed,
}

impl Phase {
    pub(super) fn projection(&self) -> BrowserResourcePhase {
        match self {
            Self::Ready => BrowserResourcePhase::Ready,
            Self::OutcomeUnknown(_) => BrowserResourcePhase::OutcomeUnknown,
            Self::Retiring => BrowserResourcePhase::Retiring,
            Self::Closed => BrowserResourcePhase::Closed,
        }
    }
}

impl ActiveAction {
    fn effect_instances(&self) -> impl Iterator<Item = &BrowserInstanceId> {
        std::iter::once(&self.instance).chain(self.page_creation.iter().filter_map(|creation| {
            matches!(
                creation.state,
                BrowserPageCreationState::Pending | BrowserPageCreationState::Accounted
            )
            .then_some(&creation.instance)
        }))
    }
}

impl BrowserResourceHost {
    pub(super) fn outcome_unknown(
        &mut self,
        instances: impl IntoIterator<Item = BrowserInstanceId>,
    ) -> bool {
        let mut changed = false;
        for instance in instances {
            if !self.instances.contains_key(&instance) {
                continue;
            }
            match &mut self.phase {
                Phase::Ready => {
                    self.phase = Phase::OutcomeUnknown(BTreeSet::from([instance]));
                    changed = true;
                }
                Phase::OutcomeUnknown(owners) => changed |= owners.insert(instance),
                Phase::Retiring | Phase::Closed => {}
            }
        }
        changed
    }

    /// A closed page or a missing observation never enters this boundary.
    /// The runtime has confirmed this binding's owned native effects retired.
    pub(super) fn outcome_owner_retired(
        &mut self,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        if let Phase::OutcomeUnknown(owners) = &mut self.phase {
            owners.remove(instance);
            if owners.is_empty() {
                self.phase = Phase::Ready;
            }
        }
        if self.active.as_ref().is_some_and(|action| {
            !action
                .effect_instances()
                .any(|owner| self.instances.contains_key(owner))
        }) {
            self.active = None;
        }
        self.dialogs.retire_instance(instance);
        self.grant_drained_input_transfer()
    }

    pub fn finish_action(
        &mut self,
        permit: BrowserActionPermit,
        outcome: BrowserActionOutcome,
    ) -> Result<BrowserControlProjection, BrowserAdmissionError> {
        self.finish_admitted_action(
            &permit.resource,
            &permit.operation,
            permit.sequence,
            outcome,
        )
    }

    pub(super) fn finish_admitted_action(
        &mut self,
        resource: &BrowserResourceIdentity,
        operation: &BrowserOperationId,
        sequence: NonZeroU64,
        outcome: BrowserActionOutcome,
    ) -> Result<BrowserControlProjection, BrowserAdmissionError> {
        self.require_identity(resource)?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if &active.operation != operation || active.sequence != sequence {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let revision = advance(self.revision)?;
        if outcome == BrowserActionOutcome::OutcomeUnknown {
            let owners = active.effect_instances().cloned().collect::<Vec<_>>();
            self.outcome_unknown(owners);
        } else {
            self.active = None;
        }
        self.revision = revision;
        self.grant_drained_input_transfer()?;
        Ok(self.projection())
    }
}
