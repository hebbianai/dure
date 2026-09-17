//! Provider-neutral wire contracts for exact Git checkout identity.
//!
//! The `dure-git-checkout` adapter owns capture, validation, and removal. These
//! DTOs live here so application plans can freeze its typed authority without
//! depending on filesystem or process behavior.

use crate::OperationIdV1;
use serde::{Deserialize, Deserializer, Serialize};

pub const GIT_CHECKOUT_SCHEMA_VERSION_V1: u8 = 1;
pub const GIT_CHECKOUT_USE_SCHEMA_VERSION_V1: u8 = 1;
pub const MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1: usize = 128;
pub const MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1: usize = 8_192;
pub const MAX_GIT_CHECKOUT_USE_REVISION_V1: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutLocationV1 {
    pub schema_version: u8,
    pub canonical_path: String,
    pub git_common_dir: String,
}

/// A successful location or a proven missing path. Unavailable observations
/// remain None at the batch boundary; absence must not mask permission errors.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum GitCheckoutPathObservationV1 {
    Located(GitCheckoutLocationV1),
    Absent {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        #[serde(rename = "absentPath")]
        absent_path: String,
    },
}

/// A selected checkout's observed state before admission. Unlike an instance
/// token, branch and HEAD describe mutable work and do not authorize removal.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutReferenceV1 {
    pub canonical_path: String,
    pub git_common_dir: String,
    pub git_dir: String,
    pub branch: String,
    pub head: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutInstanceV1 {
    pub schema_version: u8,
    pub canonical_path: String,
    pub git_common_dir: String,
    pub git_dir: String,
    pub instance_token: String,
}

/// Immutable locator for a caller-owned registration in the Git use authority.
/// The enclosing operation supplies its claim identity; claim state stays in Git.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutRegistrationV1 {
    pub repository_path: String,
    pub instance: GitCheckoutInstanceV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutCaptureRequestV1 {
    pub repository_path: String,
    pub checkout_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCheckoutRemovalOutcomeV1 {
    Removed,
    AlreadyAbsent,
}

/// Durable adapter-issued evidence, revalidated against the frozen instance.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutRemovalReceiptV1 {
    pub schema_version: u8,
    pub outcome: GitCheckoutRemovalOutcomeV1,
    pub instance: GitCheckoutInstanceV1,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCheckoutRemovalPolicyV1 {
    #[default]
    RequireClean,
    DiscardChanges,
}

impl GitCheckoutRemovalPolicyV1 {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequireClean => "require_clean",
            Self::DiscardChanges => "discard_changes",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutRemovalRequestV1 {
    pub repository_path: String,
    pub instance: GitCheckoutInstanceV1,
    #[serde(default)]
    pub policy: GitCheckoutRemovalPolicyV1,
}

/// One exact app-owned use of a checkout incarnation.
///
/// `claim_id` is the operation id that acquired the claim. The request digest
/// is authority-derived, so the same owner may safely acquire another use with
/// a new operation id while a changed retry is rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutUseClaimV1 {
    pub owner_id: OperationIdV1,
    pub claim_id: OperationIdV1,
    pub request_digest: String,
}

/// Cross-transport canonical decimal revision.
///
/// The explicit 2^53-1 ceiling keeps POSIX/awk and JavaScript adapters exact.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct GitCheckoutUseRevisionV1(String);

impl GitCheckoutUseRevisionV1 {
    pub fn new(value: u64) -> Option<Self> {
        (value > 0 && value <= MAX_GIT_CHECKOUT_USE_REVISION_V1).then(|| Self(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn value(&self) -> u64 {
        self.0
            .parse()
            .expect("validated checkout-use revision must remain decimal")
    }
}

impl<'de> Deserialize<'de> for GitCheckoutUseRevisionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        let parsed = value.parse::<u64>().map_err(serde::de::Error::custom)?;
        let revision = Self::new(parsed)
            .filter(|revision| revision.as_str() == value)
            .ok_or_else(|| serde::de::Error::custom("invalid checkout-use revision"))?;
        Ok(revision)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutCreationReservationV1 {
    pub schema_version: u8,
    pub canonical_path: String,
    pub path_digest: String,
    pub reservation_token: String,
    pub operation_id: OperationIdV1,
    pub request_digest: String,
    pub revision: GitCheckoutUseRevisionV1,
    pub claim: GitCheckoutUseClaimV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutRemovalPermitV1 {
    pub schema_version: u8,
    pub canonical_path: String,
    pub path_digest: String,
    pub instance: GitCheckoutInstanceV1,
    pub instance_digest: String,
    pub permit_token: String,
    pub operation_id: OperationIdV1,
    pub request_digest: String,
    pub revision: GitCheckoutUseRevisionV1,
    pub retiring_claims: Vec<GitCheckoutUseClaimV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitCheckoutUseActionV1 {
    ReserveCreation {
        checkout_path: String,
        owner_id: OperationIdV1,
    },
    AbortCreation {
        canonical_path: String,
        reservation_token: String,
    },
    StartCreation {
        canonical_path: String,
        reservation_token: String,
    },
    ActivateCreation {
        instance: GitCheckoutInstanceV1,
        reservation_token: String,
    },
    Claim {
        instance: GitCheckoutInstanceV1,
        owner_id: OperationIdV1,
    },
    Release {
        instance: GitCheckoutInstanceV1,
        claim_id: OperationIdV1,
    },
    AcquireRemovalPermit {
        instance: GitCheckoutInstanceV1,
        retiring_claim_ids: Vec<OperationIdV1>,
        #[serde(default)]
        policy: GitCheckoutRemovalPolicyV1,
    },
    AbortRemoval {
        instance: GitCheckoutInstanceV1,
        permit_token: String,
    },
    /// Retire an active generation whose checkout no longer exists on disk and
    /// holds no active claim. The authority verifies absence before committing.
    RetireAbsentCheckout { checkout_path: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutUseRequestV1 {
    pub schema_version: u8,
    pub repository_path: String,
    pub operation_id: OperationIdV1,
    pub action: GitCheckoutUseActionV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitCheckoutUsePhaseV1 {
    Creating,
    Active,
    Removing,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum GitCheckoutUseOutcomeV1 {
    CreationReserved {
        reservation: GitCheckoutCreationReservationV1,
    },
    CreationAborted {
        reservation: GitCheckoutCreationReservationV1,
    },
    CreationStarted,
    CreationActivated {
        instance_digest: String,
        claim: GitCheckoutUseClaimV1,
    },
    ClaimAcquired {
        instance_digest: String,
        claim: GitCheckoutUseClaimV1,
    },
    ClaimReleased {
        instance_digest: String,
        claim: GitCheckoutUseClaimV1,
    },
    RemovalPermitted {
        permit: GitCheckoutRemovalPermitV1,
    },
    RemovalAborted {
        permit: GitCheckoutRemovalPermitV1,
    },
    Removed {
        permit: GitCheckoutRemovalPermitV1,
        removal: GitCheckoutRemovalReceiptV1,
    },
    AbsentCheckoutRetired {
        instance_digest: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutUseReceiptV1 {
    pub schema_version: u8,
    pub operation_id: OperationIdV1,
    pub request_digest: String,
    pub revision: GitCheckoutUseRevisionV1,
    pub phase: GitCheckoutUsePhaseV1,
    pub outcome: GitCheckoutUseOutcomeV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCheckoutUsePhysicalRemovalRequestV1 {
    pub schema_version: u8,
    pub repository_path: String,
    pub operation_id: OperationIdV1,
    pub instance: GitCheckoutInstanceV1,
    pub permit_token: String,
    #[serde(default)]
    pub policy: GitCheckoutRemovalPolicyV1,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_use_revisions_keep_the_cross_transport_decimal_contract() {
        let maximum = GitCheckoutUseRevisionV1::new(MAX_GIT_CHECKOUT_USE_REVISION_V1).unwrap();
        assert_eq!(maximum.as_str(), "9007199254740991");
        assert!(GitCheckoutUseRevisionV1::new(0).is_none());
        assert!(GitCheckoutUseRevisionV1::new(MAX_GIT_CHECKOUT_USE_REVISION_V1 + 1).is_none());
        assert!(serde_json::from_str::<GitCheckoutUseRevisionV1>("\"01\"").is_err());
    }
}
