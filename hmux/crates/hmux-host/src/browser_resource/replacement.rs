//! One admitted action keeps the logical page while replacing its native binding.
use super::*;

/// Exact cleanup authority issued by Host after the replacement is published.
#[derive(Debug)]
pub struct BrowserReplacedTarget {
    resource: BrowserResourceIdentity,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
}

#[cfg(test)]
mod tests;

impl BrowserReplacedTarget {
    pub fn instance(&self) -> &BrowserInstanceId {
        &self.instance
    }
    pub fn target(&self) -> &BrowserTargetId {
        &self.target
    }
}

impl BrowserResourceHost {
    /// Observe admitted documents independently of permission to start actions.
    /// Fenced, unpublished targets stay retained solely for native cleanup.
    pub fn observe_page_document(
        &mut self,
        instance: BrowserInstanceId,
        target: BrowserTargetId,
        document: BrowserDocumentId,
    ) -> Result<Option<BrowserPageIdentity>, BrowserAdmissionError> {
        if let Some(owner) = self.instance_for_target(&target) {
            if owner != &instance {
                return Err(BrowserAdmissionError::InstanceMismatch);
            }
            if self.page_target_is_retiring(&target) {
                return Ok(None);
            }
        }
        if let Some(owner) = self.reserved_targets.get(&target) {
            if self.phase.projection() == BrowserResourcePhase::OutcomeUnknown {
                return Ok(None);
            }
            if let targets::ReservationKind::Replacement(previous) = &owner.kind {
                if previous.as_ref() != Some(&document) {
                    let revision = advance(self.revision)?;
                    self.reserved_targets.get_mut(&target).unwrap().kind =
                        targets::ReservationKind::Replacement(Some(document));
                    self.revision = revision;
                }
                return Ok(None);
            }
        }
        match self.page_for_target(&target) {
            Some(page) => {
                if self.instance_for_page(&page.page_id)? != &instance {
                    return Err(BrowserAdmissionError::InstanceMismatch);
                }
                self.document_committed(&page.page_id, document).map(Some)
            }
            None => self.register_page(instance, target, document).map(Some),
        }
    }

    pub fn page_replacement_target(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<&BrowserTargetId, BrowserAdmissionError> {
        let creation = self
            .action_creation(permit)?
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if creation.kind != creation::CreationKind::Replacement {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        self.created_page_target(permit)
    }

    /// Publish the prepared native binding and continue the same admitted action.
    pub fn replace_page_binding(
        &mut self,
        permit: &mut BrowserActionPermit,
        replacement: &BrowserTargetId,
    ) -> Result<(BrowserPageIdentity, BrowserReplacedTarget), BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        if self.page_replacement_target(permit)? != replacement {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let candidate = self
            .reserved_targets
            .get(replacement)
            .ok_or(BrowserAdmissionError::PageGone)?;
        self.require_active_instance(&candidate.instance)?;
        let targets::ReservationKind::Replacement(Some(document)) = &candidate.kind else {
            return Err(BrowserAdmissionError::PermitMismatch);
        };
        if self.pointer_held() || self.keyboard_held() || self.touch_held() {
            return Err(BrowserAdmissionError::ActionInFlight);
        }
        let document_revision = advance(permit.page.document_revision)?;
        let revision = advance(self.revision)?;
        let mut next = PageState::new(
            candidate.instance.clone(),
            replacement.clone(),
            document.clone(),
            document_revision,
        );
        let old = self
            .pages
            .remove(&permit.page.page_id)
            .expect("admitted page");
        next.label = old.label;
        self.reserved_targets.remove(replacement);
        let retired = BrowserReplacedTarget {
            resource: permit.resource.clone(),
            instance: old.instance,
            target: old.target,
        };
        self.pages.insert(permit.page.page_id.clone(), next);
        self.reserved_targets.insert(
            retired.target.clone(),
            targets::TargetReservation {
                label: None,
                instance: retired.instance.clone(),
                kind: targets::ReservationKind::Retiring,
            },
        );
        self.network.remove_page(&retired.target);
        let page = &permit.page.page_id;
        self.console.remove_page(page);
        self.dialogs.remove_page(page, Instant::now());
        self.pointer_page_closed(page)?;
        self.keyboard_page_closed(page)?;
        self.touch_page_closed(page)?;
        self.revision = revision;
        permit.page = self.page_identity(&permit.page.page_id)?;
        Ok((permit.page.clone(), retired))
    }

    /// The exact native owner confirms absence after draining its older events.
    /// An ordinary census must retain this fence until that drain has completed.
    pub fn replaced_target_retired(
        &mut self,
        retired: &BrowserReplacedTarget,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&retired.resource)?;
        match self.reserved_targets.get(&retired.target) {
            Some(owner) if owner.is_retiring() && owner.instance == retired.instance => {}
            None if !self.owns_page_target(&retired.target) => return Ok(()),
            _ => return Err(BrowserAdmissionError::InstanceMismatch),
        }
        let revision = advance(self.revision)?;
        self.reserved_targets.remove(&retired.target);
        self.revision = revision;
        Ok(())
    }
}

impl PageState {
    pub(super) fn new(
        instance: BrowserInstanceId,
        target: BrowserTargetId,
        document: BrowserDocumentId,
        document_revision: NonZeroU64,
    ) -> Self {
        Self {
            label: None,
            storage_origins: Default::default(),
            recording: None,
            frames: Default::default(),
            instance,
            target,
            document,
            document_revision,
            dialog_observation_lost: false,
            request_headers: Default::default(),
            interception: Default::default(),
            execution_started: Instant::now(),
            dialog_wait: Duration::ZERO,
            snapshot_revision: None,
            elements: BTreeSet::new(),
        }
    }
}
