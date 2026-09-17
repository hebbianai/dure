use super::*;

/// A closed current page retains only its native instance until that instance's
/// active tab is observed. Viewer selection never writes this input target.
#[derive(Clone, PartialEq)]
pub(super) enum InputSelection {
    Page(BrowserPageId),
    Instance(BrowserInstanceId),
}

impl BrowserResourceHost {
    pub fn current_page(&self) -> Option<BrowserPageIdentity> {
        match self.selection.as_ref()? {
            InputSelection::Page(page) => self.page_identity(page).ok(),
            InputSelection::Instance(_) => None,
        }
    }

    fn selection_instance(&self) -> Option<&BrowserInstanceId> {
        match self.selection.as_ref()? {
            InputSelection::Page(page) => self.pages.get(page).map(|page| &page.instance),
            InputSelection::Instance(instance) => Some(instance),
        }
    }

    /// Record Chromium's known activation reply only for the admitted page or
    /// the page created by that same operation. A read cannot choose a profile.
    pub fn page_activated(
        &mut self,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        let admitted = self.dispatch_target(permit)?;
        let target = self.target_for(page)?;
        if target != admitted && self.created_page_target(permit).ok() != Some(target) {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        self.set_selection(InputSelection::Page(page.page_id.clone()))
    }

    /// Native engines have one active tab per profile. Only the selected
    /// instance may advance this resource's current target; a late observation
    /// from another profile cannot reverse an admitted cross-profile switch.
    pub fn active_page_observed(
        &mut self,
        instance: &BrowserInstanceId,
        target: Option<&BrowserTargetId>,
    ) -> Result<(), BrowserAdmissionError> {
        if self.selection_instance() != Some(instance) {
            return Ok(());
        }
        // A shared native browser can be displaying another resource's tab.
        // That does not erase this resource's last admitted current target.
        let Some(target) = target else {
            return Ok(());
        };
        let page = self
            .page_for_target(target)
            .ok_or(BrowserAdmissionError::PageGone)?;
        if self.instance_for_page(&page.page_id)? != instance {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        self.set_selection(InputSelection::Page(page.page_id))
    }

    fn set_selection(&mut self, selection: InputSelection) -> Result<(), BrowserAdmissionError> {
        if self.selection.as_ref() != Some(&selection) {
            let revision = advance(self.revision)?;
            self.selection = Some(selection);
            self.revision = revision;
        }
        Ok(())
    }

    pub(super) fn selection_page_closed(
        &mut self,
        closed: &BrowserPageId,
        instance: &BrowserInstanceId,
    ) {
        match &self.selection {
            Some(InputSelection::Page(page)) if page == closed => {}
            Some(InputSelection::Instance(selected)) if selected == instance => {}
            _ => return,
        }
        let next_instance = self
            .pages
            .values()
            .filter(|page| self.require_active_instance(&page.instance).is_ok())
            .min_by_key(|page| &page.instance != instance)
            .map(|page| page.instance.clone());
        self.selection = next_instance.map(InputSelection::Instance);
    }
}
