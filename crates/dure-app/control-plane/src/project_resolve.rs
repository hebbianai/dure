use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveProjectBody {
    schema_version: u16,
    path: String,
}

/// Read the same canonical catalog used by Run selection. This is discovery,
/// never registration, and an app project ID is not a backend project ID.
pub(crate) async fn resolve(
    state: &ServiceState,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    let body: ResolveProjectBody = serde_json::from_value(body.clone())
        .map_err(|_| BackendDispatchError::from("backend_projects_request_invalid"))?;
    if body.schema_version != 1 || !valid_project_path(&body.path) {
        return Err("backend_projects_request_invalid".into());
    }
    let catalog = projects_catalog(state).await?;
    // A containing registration also selects the Run's root. Return that root
    // explicitly so a caller cannot mistake a nested folder for the Run cwd.
    let project = catalog.project_for_path(&body.path);
    Ok(json!({
        "schemaVersion": 1,
        "project": project.as_ref().map(|entry| entry.projection()),
        "root": project.as_ref().map(|entry| entry.root()),
    }))
}
