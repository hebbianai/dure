//! Names belong to the admitted creation, then its exact native target and page.
use super::*;

impl BrowserResourceHost {
    /// Reserve before starting native creation, including a new profile instance.
    pub fn reserve_creation_label(
        &mut self,
        permit: &BrowserActionPermit,
        label: BrowserPageLabel,
    ) -> Result<(), BrowserAdmissionError> {
        self.dispatch_target(permit)?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.page_creation.is_some() || active.creation_label.is_some() {
            return Err(BrowserAdmissionError::CommandAlreadyDispatched);
        }
        if self
            .pages
            .values()
            .any(|page| page.label.as_ref() == Some(&label))
            || self
                .reserved_targets
                .values()
                .any(|target| target.label.as_ref() == Some(&label))
        {
            return Err(BrowserAdmissionError::PageLabelTaken);
        }
        self.active.as_mut().unwrap().creation_label = Some(label);
        Ok(())
    }

    pub fn page_label(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Option<&BrowserPageLabel>, BrowserAdmissionError> {
        self.target_for(page)?;
        Ok(self.pages.get(&page.page_id).unwrap().label.as_ref())
    }
}
