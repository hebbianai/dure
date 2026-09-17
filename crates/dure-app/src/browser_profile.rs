//! Durable browser storage selection. Live pages and process generations remain
//! Host facts; a profile record is not evidence that a browser is running.
use serde::{Deserialize, Serialize};

use crate::{DomainIdErrorV1, DomainStoreErrorV1, DomainStoreFuture};

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BrowserProfileIdV1(String);

impl BrowserProfileIdV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainIdErrorV1> {
        let value = value.into();
        crate::domain_store::validate_domain_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_default(&self) -> bool {
        self.0 == "default"
    }
}

impl<'de> Deserialize<'de> for BrowserProfileIdV1 {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserProfileScopeV1 {
    Default,
    Isolated,
    Imported,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserProfileUserAgentModeV1 {
    #[default]
    Clean,
    Native,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(
    rename_all = "camelCase",
    deny_unknown_fields,
    try_from = "ProfileSpec"
)]
pub struct BrowserProfileSpecV1 {
    profile_id: BrowserProfileIdV1,
    label: String,
    scope: BrowserProfileScopeV1,
    user_agent_mode: BrowserProfileUserAgentModeV1,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileSpec {
    profile_id: BrowserProfileIdV1,
    label: String,
    scope: BrowserProfileScopeV1,
    #[serde(default)]
    user_agent_mode: BrowserProfileUserAgentModeV1,
}

impl TryFrom<ProfileSpec> for BrowserProfileSpecV1 {
    type Error = DomainStoreErrorV1;

    fn try_from(raw: ProfileSpec) -> Result<Self, Self::Error> {
        Self::new(raw.profile_id, raw.label, raw.scope, raw.user_agent_mode)
    }
}

impl BrowserProfileSpecV1 {
    pub fn new(
        profile_id: BrowserProfileIdV1,
        label: String,
        scope: BrowserProfileScopeV1,
        user_agent_mode: BrowserProfileUserAgentModeV1,
    ) -> Result<Self, DomainStoreErrorV1> {
        crate::domain_store::validate_label("label", &label)?;
        if profile_id.is_default() != (scope == BrowserProfileScopeV1::Default) {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "scope",
                reason: "only the reserved default profile may have default scope".into(),
            });
        }
        Ok(Self {
            profile_id,
            label,
            scope,
            user_agent_mode,
        })
    }

    pub fn profile_id(&self) -> &BrowserProfileIdV1 {
        &self.profile_id
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn scope(&self) -> BrowserProfileScopeV1 {
        self.scope
    }
    pub fn user_agent_mode(&self) -> BrowserProfileUserAgentModeV1 {
        self.user_agent_mode
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserProfileStateV1 {
    Active,
    Retiring,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserProfileRecordV1 {
    pub profile: BrowserProfileSpecV1,
    pub state: BrowserProfileStateV1,
}

pub trait BrowserProfileStore: Send + Sync {
    fn browser_profiles(&self) -> DomainStoreFuture<'_, Vec<BrowserProfileRecordV1>>;
    fn browser_profile<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, Option<BrowserProfileRecordV1>>;
    fn create_browser_profile<'a>(
        &'a self,
        profile: &'a BrowserProfileSpecV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1>;
    /// Persist retirement before closing consumers or clearing profile storage.
    fn begin_browser_profile_retirement<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1>;
    /// Call only after the owning adapter confirms process and storage retirement.
    fn complete_browser_profile_retirement<'a>(
        &'a self,
        id: &'a BrowserProfileIdV1,
    ) -> DomainStoreFuture<'a, BrowserProfileRecordV1>;
}
