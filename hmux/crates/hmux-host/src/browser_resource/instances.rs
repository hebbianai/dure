//! Browser-instance ownership is part of the Host's canonical page binding.
use super::*;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum InstanceState {
    Active,
    Retiring,
}

impl BrowserResourceHost {
    /// Register the native owner before its first process or page is created.
    pub fn register_instance_binding(
        &mut self,
        resource: &BrowserResourceIdentity,
        instance: BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        self.require_ready()?;
        self.require_instance_registration(&instance)?;
        if self.instances.contains_key(&instance) {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        let revision = advance(self.revision)?;
        self.instances.insert(instance, InstanceState::Active);
        self.revision = revision;
        Ok(())
    }

    pub fn require_instance_binding(
        &self,
        resource: &BrowserResourceIdentity,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        self.require_ready()?;
        self.require_active_instance(instance)
    }

    pub fn instance_for_page(
        &self,
        page: &BrowserPageId,
    ) -> Result<&BrowserInstanceId, BrowserAdmissionError> {
        Ok(&self
            .pages
            .get(page)
            .ok_or(BrowserAdmissionError::PageGone)?
            .instance)
    }

    pub fn instance_binding_ids(&self) -> Vec<BrowserInstanceId> {
        self.instances.keys().cloned().collect()
    }

    pub(super) fn require_active_instance(
        &self,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        if self.instances.get(instance) != Some(&InstanceState::Active) {
            return Err(BrowserAdmissionError::ResourceRetiring);
        }
        Ok(())
    }

    pub(super) fn require_instance_registration(
        &self,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        match self.instances.get(instance) {
            Some(InstanceState::Retiring) => Err(BrowserAdmissionError::ResourceRetiring),
            None if self.instances.len() >= MAX_LIVE_PAGES
                && !self.replacement_instance_admitted(instance) =>
            {
                Err(BrowserAdmissionError::CapacityExceeded)
            }
            _ => Ok(()),
        }
    }

    /// Fence this resource's binding before its owner withdraws native handlers.
    /// A browser with no remaining pages still owns its binding until retirement.
    pub fn begin_instance_retirement(
        &mut self,
        resource: &BrowserResourceIdentity,
        instance: &BrowserInstanceId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(resource)?;
        if self.instances.get(instance) != Some(&InstanceState::Active) {
            return Ok(());
        }
        let revision = advance(self.revision)?;
        let last = self
            .instances
            .iter()
            .all(|(id, state)| id == instance || *state == InstanceState::Retiring);
        self.instances
            .insert(instance.clone(), InstanceState::Retiring);
        if last && self.phase.projection() != BrowserResourcePhase::Closed {
            self.phase = outcomes::Phase::Retiring;
            self.requested_controller = None;
        }
        self.revision = revision;
        Ok(())
    }

    /// Report only after this binding's owned targets or exact browser have
    /// retired and its retained event connection has withdrawn the resource.
    /// Other resources may still hold leases on the same native browser.
    pub fn instance_binding_retired(
        &mut self,
        resource: &BrowserResourceIdentity,
        instance: &BrowserInstanceId,
    ) -> Result<bool, BrowserAdmissionError> {
        self.require_identity(resource)?;
        if !self.instances.contains_key(instance) {
            return Ok(self.phase.projection() == BrowserResourcePhase::Closed);
        }
        if self.instances.len() == 1 {
            self.engine_exited(resource)?;
            return Ok(true);
        }
        let targets = self.instance_targets(instance);
        let pages = self
            .pages
            .iter()
            .filter(|(_, page)| &page.instance == instance)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for page in pages {
            self.page_closed(&page)?;
        }
        let revision = advance(self.revision)?;
        for target in targets {
            self.network.remove_page(&target);
        }
        self.reserved_targets
            .retain(|_, owner| &owner.instance != instance);
        self.instances.remove(instance);
        self.revision = revision;
        self.outcome_owner_retired(instance)?;
        Ok(false)
    }

    pub fn instance_for_target(&self, target: &BrowserTargetId) -> Option<&BrowserInstanceId> {
        self.reserved_targets
            .get(target)
            .map(|owner| &owner.instance)
            .or_else(|| {
                self.pages
                    .values()
                    .find(|page| &page.target == target)
                    .map(|page| &page.instance)
            })
    }

    pub fn instance_targets(&self, instance: &BrowserInstanceId) -> BTreeSet<BrowserTargetId> {
        self.reserved_targets
            .iter()
            .filter(|(_, owner)| &owner.instance == instance)
            .map(|(target, _)| target.clone())
            .chain(
                self.pages
                    .values()
                    .filter(|page| &page.instance == instance)
                    .map(|page| page.target.clone()),
            )
            .collect()
    }

    /// Absence is meaningful only within the reporting browser instance.
    pub fn reconcile_instance_pages(
        &mut self,
        instance: &BrowserInstanceId,
        live: &BTreeSet<BrowserTargetId>,
        now: Instant,
    ) -> Result<(), BrowserAdmissionError> {
        let targets = self.instance_targets(instance);
        let closed = self
            .pages
            .iter()
            .filter(|(_, page)| &page.instance == instance && !live.contains(&page.target))
            .map(|(page, _)| page.clone())
            .collect::<Vec<_>>();
        for page in closed {
            self.page_closed(&page)?;
        }
        self.reserved_targets.retain(|target, owner| {
            &owner.instance != instance || owner.is_retiring() || live.contains(target)
        });
        self.network.reconcile_sources(&targets, live, now);
        Ok(())
    }

    pub fn instance_observation_lost(&mut self, instance: &BrowserInstanceId) {
        let targets = self.instance_targets(instance);
        self.network.observation_lost(&targets);
        self.dialog_observation_lost(instance);
    }
}

#[cfg(test)]
mod tests;
