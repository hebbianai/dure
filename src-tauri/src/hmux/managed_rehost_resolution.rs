use hmux_client::{ManagedRehostResolutionResponse, SessionSelector};

use super::product_catalog;

pub(crate) fn resolve(
    session_id: &str,
    workspace_id: &str,
) -> Result<ManagedRehostResolutionResponse, String> {
    let catalog = product_catalog().map_err(|error| error.to_string())?;
    let source = SessionSelector::new(session_id, Some(workspace_id.to_string()));
    let lookup = catalog
        .resolve_current_managed_rehost(&source)
        .map_err(|error| error.to_string())?;
    Ok(ManagedRehostResolutionResponse::from_lookup(
        lookup,
        session_id,
        workspace_id,
    ))
}
