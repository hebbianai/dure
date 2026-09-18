//! Backend-owned permission to use registered profiles for automatic recovery.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    AgentExecutionProfileV1, DomainStoreErrorV1, DomainStoreFuture, ProviderCredentialProfileV1,
    ProviderIdV1,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRecoveryAccountV1 {
    pub profile: ProviderCredentialProfileV1,
    pub name: String,
}

impl ProviderRecoveryAccountV1 {
    pub fn execution_profile(&self) -> AgentExecutionProfileV1 {
        AgentExecutionProfileV1::CredentialReference {
            reference_id: self.profile.reference_id.clone(),
            credential_generation: Some(self.profile.credential_generation.clone()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRecoveryUsageV1 {
    pub profile: ProviderCredentialProfileV1,
    /// The fuller of the provider's short and weekly windows, when observed.
    pub used_percent: Option<f64>,
    pub observed_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRecoveryPolicyV1 {
    pub schema_version: u16,
    pub provider_id: ProviderIdV1,
    pub revision: u64,
    pub enabled: bool,
    pub accounts: Vec<ProviderRecoveryAccountV1>,
    /// Enabling recovery does not automatically replay older failed work.
    pub activated_at_ms: Option<i64>,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRecoveryPolicyPutV1 {
    pub schema_version: u16,
    pub provider_id: ProviderIdV1,
    pub expected_revision: u64,
    pub idempotency_key: String,
    pub enabled: bool,
    pub accounts: Vec<ProviderRecoveryAccountV1>,
}

impl ProviderRecoveryPolicyPutV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != 1 {
            return Err(invalid(
                "schemaVersion",
                "unsupported recovery policy schema",
            ));
        }
        if self.idempotency_key.is_empty() || self.idempotency_key.len() > 160 {
            return Err(invalid("idempotencyKey", "must contain 1 to 160 bytes"));
        }
        let mut references = BTreeSet::new();
        for account in &self.accounts {
            account.profile.validate()?;
            if account.profile.provider_id != self.provider_id {
                return Err(invalid("accounts", "profile must belong to this provider"));
            }
            if !references.insert(&account.profile.reference_id) {
                return Err(invalid("accounts", "profile references must be unique"));
            }
        }
        Ok(())
    }
}

fn invalid(field: &'static str, reason: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

pub trait ProviderRecoveryStore: Send + Sync {
    fn provider_recovery_policy<'a>(
        &'a self,
        provider_id: &'a ProviderIdV1,
    ) -> DomainStoreFuture<'a, Option<ProviderRecoveryPolicyV1>>;

    fn put_provider_recovery_policy<'a>(
        &'a self,
        request: &'a ProviderRecoveryPolicyPutV1,
        observed_at_ms: i64,
    ) -> DomainStoreFuture<'a, ProviderRecoveryPolicyV1>;

    /// Optional telemetry improves selection; its absence never denies a try.
    fn observe_provider_recovery_usage<'a>(
        &'a self,
        observation: &'a ProviderRecoveryUsageV1,
    ) -> DomainStoreFuture<'a, ()>;
}
