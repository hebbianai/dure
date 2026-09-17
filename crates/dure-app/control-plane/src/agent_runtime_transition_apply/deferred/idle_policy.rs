//! Backend admission policy; Hmux remains the only destructive stop authority.
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::service_lifecycle::with_descriptor_transition;
use crate::{ControlPlaneError, ServiceState, assert_owner_directory, private_record};

const FILE_NAME: &str = "runtime-idle-policy-v1.json";
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "u64", into = "u64")]
pub(super) struct IdleAfterMs(u64);

impl TryFrom<u64> for IdleAfterMs {
    type Error = &'static str;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        (1_000..=2_592_000_000)
            .contains(&value)
            .then_some(Self(value))
            .ok_or("runtime_idle_configuration_invalid")
    }
}

impl From<IdleAfterMs> for u64 {
    fn from(value: IdleAfterMs) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Policy {
    Disabled {},
    Enabled { after_ms: IdleAfterMs },
}

impl Policy {
    pub(super) fn from_environment_value(value: Option<&str>) -> Result<Self, &'static str> {
        let Some(value) = value else {
            return Ok(Self::Disabled {});
        };
        let parsed = value
            .parse::<u64>()
            .ok()
            .filter(|parsed| parsed.to_string() == value)
            .ok_or("runtime_idle_configuration_invalid")?;
        Ok(Self::Enabled {
            after_ms: parsed.try_into()?,
        })
    }

    pub(super) fn after_ms(self) -> Option<u64> {
        match self {
            Self::Disabled {} => None,
            Self::Enabled { after_ms } => Some(after_ms.into()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    schema_version: u16,
    pub(super) revision: u64,
    pub(super) policy: Policy,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            policy: Policy::Disabled {},
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfigureBody {
    schema_version: u16,
    expected_revision: u64,
    policy: Policy,
}

fn read(root: &Path) -> Result<Option<Record>, ControlPlaneError> {
    assert_owner_directory(root)?;
    let Some(bytes) = private_record::read(&root.join(FILE_NAME))? else {
        return Ok(None);
    };
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| ControlPlaneError::Invalid("runtime_idle_policy_invalid"))?;
    if record.schema_version != 1 || !(1..=MAX_REVISION).contains(&record.revision) {
        return Err(ControlPlaneError::Invalid("runtime_idle_policy_invalid"));
    }
    Ok(Some(record))
}

pub(super) fn load(
    state: &ServiceState,
    seed: Result<Policy, &'static str>,
) -> Result<Record, ControlPlaneError> {
    let root = state
        .canonical_descriptor_path
        .parent()
        .ok_or(ControlPlaneError::Invalid(
            "runtime_idle_policy_unavailable",
        ))?;
    if let Some(record) = read(root)? {
        return Ok(record);
    }
    let policy = seed.map_err(ControlPlaneError::Invalid)?;
    if matches!(policy, Policy::Disabled {}) || !state.is_mutation_authority() {
        return Ok(Record::default());
    }
    // Seeding is a migration write. Staged and retired generations cannot seed.
    with_descriptor_transition(root, |_| {
        if let Some(record) = read(root)? {
            return Ok(record);
        }
        if !state.is_mutation_authority() {
            return Err(ControlPlaneError::Invalid(
                "runtime_idle_authority_unavailable",
            ));
        }
        let record = Record {
            schema_version: 1,
            revision: 1,
            policy,
        };
        private_record::write(&root.join(FILE_NAME), &record)?;
        Ok(record)
    })
}

pub(super) fn configure(
    state: &ServiceState,
    body: ConfigureBody,
) -> Result<Record, ControlPlaneError> {
    if body.schema_version != 1 || body.expected_revision >= MAX_REVISION {
        return Err(ControlPlaneError::Invalid(
            "runtime_idle_configure_request_invalid",
        ));
    }
    let root = state
        .canonical_descriptor_path
        .parent()
        .ok_or(ControlPlaneError::Invalid(
            "runtime_idle_policy_unavailable",
        ))?;
    with_descriptor_transition(root, |_| {
        if !state.is_mutation_authority() {
            return Err(ControlPlaneError::Invalid(
                "runtime_idle_authority_unavailable",
            ));
        }
        let current = read(root)?.unwrap_or_default();
        if current.revision != body.expected_revision {
            return Err(ControlPlaneError::Invalid(
                "runtime_idle_policy_revision_conflict",
            ));
        }
        let record = Record {
            schema_version: 1,
            revision: current.revision + 1,
            policy: body.policy,
        };
        private_record::write(&root.join(FILE_NAME), &record)?;
        Ok(record)
    })
}
