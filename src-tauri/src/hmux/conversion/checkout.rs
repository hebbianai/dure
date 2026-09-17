use super::*;
use dure_app::SessionCheckoutBindingV1;
use std::path::Path;

pub(super) fn source_binding(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
    current: &runtime::InstalledBuild,
) -> Result<Option<SessionCheckoutBindingV1>, String> {
    let source = match catalog.open(&SessionSelector::new(
        &request.source_session_id,
        Some(request.source_workspace_id.clone()),
    )) {
        Ok(source) => source,
        Err(error) if error.is_session_absent() => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let binding = crate::session_checkout::checkout_for_session(
        current.runtime.clone(),
        catalog.discovery_root().to_path_buf(),
        source,
    )?;
    crate::session_checkout::select_recovery_checkout(
        current.runtime.clone(),
        catalog.discovery_root().to_path_buf(),
        binding,
        Path::new(&request.cwd),
        &request.conversion_id,
    )
    .map(Some)
}

impl launch::PreparedConversion {
    pub(super) fn recovery_checkout(
        &self,
        catalog: &LocalSessionCatalog,
    ) -> Result<Option<SessionCheckoutBindingV1>, String> {
        match &self.source_checkout {
            Some(source) => dure_session_runtime::recovery_checkout_binding(
                source,
                catalog.discovery_root(),
                &self.request.conversion_id,
            )
            .map(Some)
            .map_err(|error| error.to_string()),
            None => crate::session_checkout::retained_recovery_checkout(
                self.current.runtime.clone(),
                catalog.discovery_root().to_path_buf(),
                &self.request.conversion_id,
            ),
        }
    }

    pub(super) fn retain_source_checkout(
        &self,
        catalog: &LocalSessionCatalog,
    ) -> Result<(), String> {
        let source = match &self.source_checkout {
            Some(source) => source.clone(),
            // Preserve old immutable operation payloads. SQL freezes this
            // selection before stop and serves it on all subsequent retries.
            None => crate::session_checkout::select_recovery_checkout(
                self.current.runtime.clone(),
                catalog.discovery_root().to_path_buf(),
                None,
                Path::new(&self.request.cwd),
                &self.request.conversion_id,
            )?,
        };
        crate::session_checkout::retain_for_recovery(
            self.current.runtime.clone(),
            catalog.discovery_root().to_path_buf(),
            source,
            self.request.conversion_id.clone(),
        )?;
        Ok(())
    }
}
