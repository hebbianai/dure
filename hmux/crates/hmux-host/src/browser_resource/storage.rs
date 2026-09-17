use super::*;

#[derive(Default)]
pub(super) struct StorageOrigins {
    origins: BTreeSet<String>,
    bytes: usize,
    incomplete: bool,
}

impl BrowserResourceHost {
    /// Native frame observations supply canonical origins. Retain visited
    /// origins across documents, including navigation that replaces history.
    pub fn storage_origin_observed(
        &mut self,
        page: &BrowserPageIdentity,
        origin: String,
    ) -> Result<(), BrowserAdmissionError> {
        self.target_for(page)?;
        let state = &mut self.pages.get_mut(&page.page_id).unwrap().storage_origins;
        if state.origins.contains(&origin) || state.incomplete {
            return Ok(());
        }
        if origin.len() > 8192
            || state.origins.len() >= 1024
            || state.bytes + origin.len() > 256 * 1024
        {
            // Browsing remains available; an export cannot claim completeness.
            state.incomplete = true;
        } else {
            state.bytes += origin.len();
            state.origins.insert(origin);
        }
        Ok(())
    }

    pub fn storage_origins(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<&BTreeSet<String>, BrowserAdmissionError> {
        self.target_for(page)?;
        let state = &self.pages.get(&page.page_id).unwrap().storage_origins;
        if state.incomplete {
            return Err(BrowserAdmissionError::CapacityExceeded);
        }
        Ok(&state.origins)
    }
}
