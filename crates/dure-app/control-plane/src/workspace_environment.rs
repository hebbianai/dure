//! Provider-owned compute lifecycle; SSH and Session ownership stay in their
//! existing services. Recipes are explicitly selected and content-fenced.
mod process;
mod recipe;
mod store;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

use crate::{BackendDispatchError, ServiceState, now_ms, pro_features};
use store::{Record, Status, Store};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Recipes {
        #[serde(rename = "projectPath")]
        project_path: String,
    },
    List,
    Create {
        #[serde(rename = "projectPath")]
        project_path: String,
        #[serde(rename = "recipeId")]
        recipe_id: String,
        #[serde(rename = "recipeDigest")]
        recipe_digest: String,
        name: String,
        #[serde(rename = "idempotencyKey")]
        idempotency_key: String,
    },
    Transition {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
        operation: String,
        #[serde(rename = "idempotencyKey")]
        idempotency_key: String,
    },
}

pub(crate) async fn invoke(
    state: &ServiceState,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    let root = state
        .projects_catalog_path
        .parent()
        .ok_or("environment_store_unavailable")?;
    dispatch(
        root,
        &state.scope_id,
        &state.descriptor.generation,
        pro_features::available(),
        body,
    )
    .map_err(BackendDispatchError::terminal)
}

fn dispatch(
    root: &Path,
    scope: &str,
    generation: &str,
    pro: bool,
    body: &Value,
) -> Result<Value, &'static str> {
    let mut fields = body
        .as_object()
        .cloned()
        .ok_or("environment_request_invalid")?;
    if fields.remove("schemaVersion") != Some(json!(1)) {
        return Err("environment_request_invalid");
    }
    let action: Action =
        serde_json::from_value(Value::Object(fields)).map_err(|_| "environment_request_invalid")?;
    // Admission precedes filesystem access or provider execution.
    if !pro
        && (matches!(&action, Action::Create { .. })
            || matches!(&action, Action::Transition { operation, .. } if operation == "resume"))
    {
        return Err("pro_required");
    }
    let store = Store::open(root)?;
    match action {
        Action::Recipes { project_path } => {
            let root = recipe::project_root(&project_path)?;
            let recipes = recipe::catalog(&root)?
                .iter()
                .map(|recipe| {
                    json!({
                        "id": recipe.id, "name": recipe.name, "digest": recipe.digest,
                        "canSuspend": recipe.suspend.is_some(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "schemaVersion": 1, "proAvailable": pro, "recipes": recipes }))
        }
        Action::List => {
            let mut records = store.list()?;
            for record in &mut records {
                if record.status.pending() {
                    match store.lock(&record.id) {
                        Ok(_lock) => {
                            *record = store.read(&record.id)?.ok_or("environment_not_found")?;
                            if record.status.pending() {
                                record.status = if record.status == Status::Destroying {
                                    Status::CleanupFailed
                                } else {
                                    Status::Failed
                                };
                                record.error = Some("environment_operation_interrupted".into());
                                record.revision += 1;
                                record.updated_at_ms =
                                    now_ms().map_err(|_| "environment_clock_unavailable")?;
                                store.write(record)?;
                            }
                        }
                        Err("environment_busy") => {}
                        Err(error) => return Err(error),
                    }
                }
            }
            Ok(json!({ "schemaVersion": 1, "proAvailable": pro,
                "environments": records.iter().map(projection).collect::<Vec<_>>() }))
        }
        Action::Create {
            project_path,
            recipe_id,
            recipe_digest,
            name,
            idempotency_key,
        } => {
            if !pro {
                return Err("pro_required");
            }
            if !recipe::label(&name) || !recipe::token(&idempotency_key) {
                return Err("environment_request_invalid");
            }
            let project_path = recipe::project_root(&project_path)?;
            let mut identity = Sha256::new();
            identity.update(scope.as_bytes());
            identity.update([0]);
            identity.update(idempotency_key.as_bytes());
            let id = format!("env-{:x}", identity.finalize());
            let _catalog = store.lock("catalog")?;
            if let Some(record) = store.read(&id)? {
                if record.project_path != project_path
                    || record.recipe.id != recipe_id
                    || record.recipe.digest != recipe_digest
                    || record.name != name
                {
                    return Err("environment_idempotency_conflict");
                }
                return Ok(json!({ "schemaVersion": 1, "environment": projection(&record) }));
            }
            if store.list()?.len() >= 512 {
                return Err("environment_store_full");
            }
            let captured = recipe::catalog(&project_path)?
                .into_iter()
                .find(|recipe| recipe.id == recipe_id)
                .ok_or("environment_recipe_not_found")?;
            if captured.digest != recipe_digest {
                return Err("environment_recipe_changed");
            }
            let lock = store.lock(&id)?;
            let time = now_ms().map_err(|_| "environment_clock_unavailable")?;
            let record = Record {
                schema_version: 1,
                id,
                revision: 1,
                project_path,
                name,
                recipe: captured,
                request_key: idempotency_key.clone(),
                last_action_key: idempotency_key,
                last_action: "create".into(),
                generation: generation.into(),
                status: Status::Creating,
                result: None,
                error: None,
                created_at_ms: time,
                updated_at_ms: time,
            };
            store.write(&record)?;
            let response = json!({ "schemaVersion": 1, "environment": projection(&record) });
            tokio::spawn(process::execute(store, record, "create".into(), lock));
            Ok(response)
        }
        Action::Transition {
            id,
            expected_revision,
            operation,
            idempotency_key,
        } => {
            if !store::valid_id(&id)
                || !recipe::token(&idempotency_key)
                || !["suspend", "resume", "destroy"].contains(&operation.as_str())
            {
                return Err("environment_request_invalid");
            }
            let existing = store.read(&id)?.ok_or("environment_not_found")?;
            if existing.last_action_key == idempotency_key {
                if existing.last_action != operation {
                    return Err("environment_idempotency_conflict");
                }
                return Ok(json!({ "schemaVersion": 1, "environment": projection(&existing) }));
            }
            let lock = store.lock(&id)?;
            let mut record = store.read(&id)?.ok_or("environment_not_found")?;
            if record.revision != expected_revision {
                return Err("environment_revision_changed");
            }
            if record.status.pending() {
                return Err("environment_operation_interrupted");
            }
            match operation.as_str() {
                "suspend"
                    if record.status == Status::Running && record.recipe.suspend.is_some() =>
                {
                    record.status = Status::Suspending
                }
                "resume"
                    if matches!(record.status, Status::Suspended | Status::Failed)
                        && record.result.is_some()
                        && record.recipe.resume.is_some() =>
                {
                    record.status = Status::Resuming
                }
                "destroy" if record.status != Status::Destroyed => {
                    record.status = Status::Destroying
                }
                _ => return Err("environment_action_unavailable"),
            }
            record.last_action_key = idempotency_key;
            record.last_action = operation.clone();
            record.generation = generation.into();
            record.error = None;
            record.revision += 1;
            record.updated_at_ms = now_ms().map_err(|_| "environment_clock_unavailable")?;
            store.write(&record)?;
            let response = json!({ "schemaVersion": 1, "environment": projection(&record) });
            tokio::spawn(process::execute(store, record, operation, lock));
            Ok(response)
        }
    }
}

fn projection(record: &Record) -> Value {
    json!({
        "id": record.id, "revision": record.revision, "name": record.name,
        "projectPath": record.project_path, "recipeId": record.recipe.id, "recipeName": record.recipe.name,
        "status": record.status, "error": record.error, "createdAtMs": record.created_at_ms,
        "updatedAtMs": record.updated_at_ms, "canSuspend": record.recipe.suspend.is_some(),
        "connection": record.result.as_ref().map(|result| &result.connection),
    })
}

#[cfg(test)]
mod tests;
