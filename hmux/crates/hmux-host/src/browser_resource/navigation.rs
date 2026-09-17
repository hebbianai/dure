//! An action may continue only in the exact document its navigation committed.
use super::*;

/// A non-wire, single-use witness captured before the adapter sends navigation.
pub struct BrowserNavigationPermit {
    page: BrowserPageIdentity,
    target: BrowserTargetId,
    instance: BrowserInstanceId,
    operation: BrowserOperationId,
    sequence: NonZeroU64,
}

impl BrowserResourceHost {
    pub fn prepare_action_navigation(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<BrowserNavigationPermit, BrowserAdmissionError> {
        let target = self.dispatch_target(permit)?.clone();
        if !permit.references.is_empty() {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(BrowserNavigationPermit {
            page: permit.page.clone(),
            target,
            instance: self.pages[&permit.page.page_id].instance.clone(),
            operation: permit.operation.clone(),
            sequence: permit.sequence,
        })
    }

    /// The adapter supplies the native navigation acknowledgement's document,
    /// never a later arbitrary snapshot. The retained observer must agree.
    pub fn continue_action_navigation(
        &self,
        permit: &mut BrowserActionPermit,
        navigation: BrowserNavigationPermit,
        document: &BrowserDocumentId,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_identity(&permit.resource)?;
        self.require_ready()?;
        let active = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::PermitMismatch)?;
        if active.operation != permit.operation
            || active.sequence != permit.sequence
            || active.page.as_ref() != Some(&permit.page.page_id)
            || permit.page != navigation.page
            || permit.operation != navigation.operation
            || permit.sequence != navigation.sequence
            || !permit.references.is_empty()
        {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let current = self
            .pages
            .get(&navigation.page.page_id)
            .ok_or(BrowserAdmissionError::PageGone)?;
        self.require_active_instance(&navigation.instance)?;
        if current.target != navigation.target || current.instance != navigation.instance {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        if &current.document != document {
            return Err(BrowserAdmissionError::DocumentChanged);
        }
        permit.page = self.page_identity(&navigation.page.page_id)?;
        permit.frame_revision = current.frames.revision;
        Ok(())
    }
}
