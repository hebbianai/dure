//! Identity of the durable backend data, independent of a process generation
//! or the profile name used by a particular client to reach this server.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{ControlPlaneError, private_record, random_opaque_reference};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u16,
    scope_id: String,
}

pub(crate) fn load_or_create(root: &Path) -> Result<String, ControlPlaneError> {
    crate::service_lifecycle::with_descriptor_transition(root, |_| {
        let path = root.join("scope.json");
        if let Some(source) = private_record::read(&path)? {
            let record: Record = serde_json::from_slice(&source)
                .map_err(|_| ControlPlaneError::Invalid("backend scope record is invalid"))?;
            if record.schema_version != 1
                || !record
                    .scope_id
                    .strip_prefix("backend-scope-")
                    .is_some_and(|suffix| {
                        suffix.len() == 48 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
            {
                return Err(ControlPlaneError::Invalid(
                    "backend scope record is invalid",
                ));
            }
            return Ok(record.scope_id);
        }
        let record = Record {
            schema_version: 1,
            scope_id: random_opaque_reference("backend-scope")
                .map_err(|error| ControlPlaneError::Message(error.code))?,
        };
        private_record::write(&path, &record)?;
        Ok(record.scope_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simultaneous_startup_and_reopen_keep_one_data_scope() {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(4);
        let scopes = std::thread::scope(|threads| {
            let pending: Vec<_> = (0..4)
                .map(|_| {
                    threads.spawn(|| {
                        barrier.wait();
                        load_or_create(root.path()).unwrap()
                    })
                })
                .collect();
            pending
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(scopes.iter().all(|scope| scope == &scopes[0]));
        assert_eq!(load_or_create(root.path()).unwrap(), scopes[0]);
    }

    #[test]
    fn an_invalid_saved_identity_is_not_replaced() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("scope.json");
        let record = serde_json::json!({ "schemaVersion": 1, "scopeId": "invalid" });
        private_record::write(&path, &record).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(load_or_create(root.path()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
