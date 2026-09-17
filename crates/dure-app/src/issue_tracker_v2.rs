//! Additive read-only tracker contract; production integrations still negotiate V1.
//!
//! The external provider owns task truth. Common operations and lifecycle are
//! projections alongside exact provider capabilities, opaque IDs and status.
//! Beads and GitHub conformance fixtures exercise this contract without credentials
//! or provider mutations. V2 does not change V1 execution or tracker selection.
//!
//! Agent context describes an exact explicit/branch binding and an observation,
//! not a mirrored task store. Production prompt delivery remains separate: a fresh
//! dispatch must use existing durable receipts, resume must not inject it twice,
//! and watch refreshes must never become unsolicited terminal input.

use std::{collections::BTreeSet, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{ProviderIdV1, StableIdError, contract::validate_stable_id};

pub const ISSUE_TRACKER_SCHEMA_VERSION_V2: u16 = 2;
pub const ISSUE_TRACKER_QUERY_LIMIT_V2: u16 = 100;

const ISSUE_TRACKER_IDENTIFIER_LIMIT_V2: usize = 512;
const ISSUE_TRACKER_DISPLAY_KEY_LIMIT_V2: usize = 128;
const ISSUE_TRACKER_LINE_LIMIT_V2: usize = 1_024;
const ISSUE_TRACKER_DESCRIPTION_LIMIT_V2: usize = 262_144;
const ISSUE_TRACKER_AGENT_CONTEXT_DESCRIPTION_LIMIT_V2: usize = 32_768;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssueTrackerContractErrorV2 {
    message: String,
}

impl IssueTrackerContractErrorV2 {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for IssueTrackerContractErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for IssueTrackerContractErrorV2 {}

fn validate_bounded_line(
    value: &str,
    maximum: usize,
    label: &str,
) -> Result<(), IssueTrackerContractErrorV2> {
    if value.is_empty() || value.len() > maximum {
        return Err(IssueTrackerContractErrorV2::new(format!(
            "{label} must be between 1 and {maximum} bytes"
        )));
    }
    if value.trim() != value || value.chars().any(char::is_control) {
        return Err(IssueTrackerContractErrorV2::new(format!(
            "{label} must be bounded single-line text without surrounding whitespace"
        )));
    }
    Ok(())
}

macro_rules! issue_tracker_stable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
                let value = value.into();
                validate_stable_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

macro_rules! issue_tracker_opaque_id {
    ($name:ident, $maximum:expr, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IssueTrackerContractErrorV2> {
                let value = value.into();
                validate_bounded_line(&value, $maximum, $label)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

issue_tracker_stable_id!(IssueTrackerCapabilityIdV2);
issue_tracker_stable_id!(IssueTrackerConnectionIdV2);
issue_tracker_opaque_id!(
    IssueTrackerScopeIdV2,
    ISSUE_TRACKER_IDENTIFIER_LIMIT_V2,
    "issue tracker scope id"
);
issue_tracker_opaque_id!(
    IssueTrackerTaskIdV2,
    ISSUE_TRACKER_IDENTIFIER_LIMIT_V2,
    "issue tracker task id"
);
issue_tracker_opaque_id!(
    IssueTrackerEntityIdV2,
    ISSUE_TRACKER_IDENTIFIER_LIMIT_V2,
    "issue tracker entity id"
);
issue_tracker_opaque_id!(
    IssueTrackerTaskDisplayKeyV2,
    ISSUE_TRACKER_DISPLAY_KEY_LIMIT_V2,
    "issue tracker task display key"
);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueTrackerCommonOperationV2 {
    List,
    Search,
    Show,
    Watch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueTrackerDataAuthorityV2 {
    Provider,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerProviderV2 {
    pub schema_version: u16,
    pub provider: ProviderIdV1,
    pub authority: IssueTrackerDataAuthorityV2,
    pub common_operations: Vec<IssueTrackerCommonOperationV2>,
    pub provider_capabilities: Vec<IssueTrackerCapabilityIdV2>,
}

impl IssueTrackerProviderV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        if self.schema_version != ISSUE_TRACKER_SCHEMA_VERSION_V2 {
            return Err(IssueTrackerContractErrorV2::new(
                "unsupported issue tracker schema version",
            ));
        }
        let operations = self.common_operations.iter().collect::<BTreeSet<_>>();
        if operations.len() != self.common_operations.len() {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker common operations must be unique",
            ));
        }
        if !operations.contains(&IssueTrackerCommonOperationV2::List)
            || !operations.contains(&IssueTrackerCommonOperationV2::Show)
        {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker providers must support list and show",
            ));
        }

        let capabilities = self.provider_capabilities.iter().collect::<BTreeSet<_>>();
        if capabilities.len() != self.provider_capabilities.len() {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker provider capabilities must be unique",
            ));
        }
        let provider_prefix = format!("{}.", self.provider.as_str());
        if self
            .provider_capabilities
            .iter()
            .any(|capability| !capability.as_str().starts_with(&provider_prefix))
        {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker provider capabilities must use the provider namespace",
            ));
        }
        Ok(())
    }

    pub fn supports(&self, operation: IssueTrackerCommonOperationV2) -> bool {
        self.common_operations.contains(&operation)
    }

    pub fn has_capability(&self, capability: &IssueTrackerCapabilityIdV2) -> bool {
        self.provider_capabilities.contains(capability)
    }

    pub fn validate_source(
        &self,
        source: &IssueTrackerSourceV2,
    ) -> Result<(), IssueTrackerContractErrorV2> {
        self.validate()?;
        source.validate()?;
        if source.provider != self.provider {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker source provider does not match its provider contract",
            ));
        }
        Ok(())
    }

    pub fn validate_task_ref(
        &self,
        task_ref: &IssueTrackerTaskRefV2,
    ) -> Result<(), IssueTrackerContractErrorV2> {
        task_ref.validate()?;
        self.validate_source(&task_ref.source)
    }

    pub fn validate_query(
        &self,
        query: &IssueTrackerQueryV2,
    ) -> Result<(), IssueTrackerContractErrorV2> {
        query.validate()?;
        if !self.supports(query.operation()) {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker provider does not support the requested common operation",
            ));
        }
        match query {
            IssueTrackerQueryV2::List { source, .. }
            | IssueTrackerQueryV2::Search { source, .. } => self.validate_source(source),
            IssueTrackerQueryV2::Show { task_ref } => self.validate_task_ref(task_ref),
        }
    }

    pub fn validate_task_detail(
        &self,
        task: &IssueTrackerTaskDetailV2,
    ) -> Result<(), IssueTrackerContractErrorV2> {
        task.validate()?;
        self.validate_task_ref(&task.summary.task_ref)
    }

    pub fn validate_agent_task_context(
        &self,
        context: &IssueTrackerAgentTaskContextV2,
    ) -> Result<(), IssueTrackerContractErrorV2> {
        context.validate()?;
        self.validate_task_detail(&context.snapshot)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerSourceV2 {
    pub provider: ProviderIdV1,
    pub connection_id: IssueTrackerConnectionIdV2,
    pub scope_id: IssueTrackerScopeIdV2,
    pub scope_display_name: String,
}

impl IssueTrackerSourceV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        validate_bounded_line(
            &self.scope_display_name,
            ISSUE_TRACKER_LINE_LIMIT_V2,
            "issue tracker scope display name",
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerTaskRefV2 {
    pub source: IssueTrackerSourceV2,
    pub task_id: IssueTrackerTaskIdV2,
    pub display_key: IssueTrackerTaskDisplayKeyV2,
    pub web_url: Option<String>,
}

impl IssueTrackerTaskRefV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        self.source.validate()?;
        if let Some(web_url) = &self.web_url {
            let remainder = web_url
                .strip_prefix("https://")
                .or_else(|| web_url.strip_prefix("http://"));
            let authority = remainder.and_then(|value| value.split(['/', '?', '#']).next());
            if web_url.len() > 2_048
                || authority.is_none_or(str::is_empty)
                || web_url.chars().any(char::is_whitespace)
                || web_url.chars().any(char::is_control)
            {
                return Err(IssueTrackerContractErrorV2::new(
                    "issue tracker web URL must be a bounded HTTP(S) URL",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueTrackerLifecycleV2 {
    Open,
    Closed,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerProviderStatusV2 {
    pub id: IssueTrackerEntityIdV2,
    pub name: String,
}

impl IssueTrackerProviderStatusV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        validate_bounded_line(
            &self.name,
            ISSUE_TRACKER_LINE_LIMIT_V2,
            "issue tracker provider status name",
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerNamedValueV2 {
    pub id: IssueTrackerEntityIdV2,
    pub name: String,
}

impl IssueTrackerNamedValueV2 {
    fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        validate_bounded_line(
            &self.name,
            ISSUE_TRACKER_LINE_LIMIT_V2,
            "issue tracker named value",
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerTaskSummaryV2 {
    pub task_ref: IssueTrackerTaskRefV2,
    pub title: String,
    pub lifecycle: IssueTrackerLifecycleV2,
    pub provider_status: IssueTrackerProviderStatusV2,
    pub assignees: Vec<IssueTrackerNamedValueV2>,
    pub labels: Vec<IssueTrackerNamedValueV2>,
    pub updated_at: Option<String>,
}

impl IssueTrackerTaskSummaryV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        self.task_ref.validate()?;
        validate_bounded_line(
            &self.title,
            ISSUE_TRACKER_LINE_LIMIT_V2,
            "issue tracker task title",
        )?;
        self.provider_status.validate()?;
        validate_named_values("assignees", &self.assignees)?;
        validate_named_values("labels", &self.labels)?;
        if let Some(updated_at) = &self.updated_at {
            validate_bounded_line(updated_at, 128, "issue tracker updated timestamp")?;
        }
        Ok(())
    }
}

fn validate_named_values(
    label: &str,
    values: &[IssueTrackerNamedValueV2],
) -> Result<(), IssueTrackerContractErrorV2> {
    if values.len() > ISSUE_TRACKER_QUERY_LIMIT_V2.into() {
        return Err(IssueTrackerContractErrorV2::new(format!(
            "issue tracker {label} exceed the supported limit"
        )));
    }
    let ids = values
        .iter()
        .map(|value| &value.id)
        .collect::<BTreeSet<_>>();
    if ids.len() != values.len() {
        return Err(IssueTrackerContractErrorV2::new(format!(
            "issue tracker {label} must have unique ids"
        )));
    }
    for value in values {
        value.validate()?;
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerTaskDetailV2 {
    pub summary: IssueTrackerTaskSummaryV2,
    pub description: Option<String>,
}

impl IssueTrackerTaskDetailV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        self.summary.validate()?;
        if let Some(description) = &self.description {
            if description.len() > ISSUE_TRACKER_DESCRIPTION_LIMIT_V2 || description.contains('\0')
            {
                return Err(IssueTrackerContractErrorV2::new(
                    "issue tracker task description is too large or contains NUL",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerAgentTaskBindingV2 {
    Explicit,
    ScmBranch { branch: String },
}

impl IssueTrackerAgentTaskBindingV2 {
    fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        match self {
            Self::Explicit => Ok(()),
            Self::ScmBranch { branch } => validate_bounded_line(
                branch,
                ISSUE_TRACKER_IDENTIFIER_LIMIT_V2,
                "issue tracker agent task branch",
            ),
        }
    }
}

/// A bounded provider snapshot that tells one Agent pane which task it owns.
/// The provider remains authoritative; this DTO is launch/resume context, not
/// a mirrored task record or permission to mutate the provider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerAgentTaskContextV2 {
    pub schema_version: u16,
    pub binding: IssueTrackerAgentTaskBindingV2,
    pub snapshot: IssueTrackerTaskDetailV2,
    pub observed_at: String,
}

impl IssueTrackerAgentTaskContextV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        if self.schema_version != ISSUE_TRACKER_SCHEMA_VERSION_V2 {
            return Err(IssueTrackerContractErrorV2::new(
                "unsupported issue tracker agent task context schema version",
            ));
        }
        self.binding.validate()?;
        self.snapshot.validate()?;
        validate_bounded_line(
            &self.observed_at,
            128,
            "issue tracker agent task observation timestamp",
        )?;
        if self
            .snapshot
            .description
            .as_ref()
            .is_some_and(|description| {
                description.len() > ISSUE_TRACKER_AGENT_CONTEXT_DESCRIPTION_LIMIT_V2
            })
        {
            return Err(IssueTrackerContractErrorV2::new(
                "issue tracker agent task context description exceeds the supported limit",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerQueryV2 {
    List {
        source: IssueTrackerSourceV2,
        limit: u16,
    },
    Search {
        source: IssueTrackerSourceV2,
        query: String,
        limit: u16,
    },
    Show {
        task_ref: IssueTrackerTaskRefV2,
    },
}

impl IssueTrackerQueryV2 {
    pub fn operation(&self) -> IssueTrackerCommonOperationV2 {
        match self {
            Self::List { .. } => IssueTrackerCommonOperationV2::List,
            Self::Search { .. } => IssueTrackerCommonOperationV2::Search,
            Self::Show { .. } => IssueTrackerCommonOperationV2::Show,
        }
    }

    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        match self {
            Self::List { source, limit } => {
                source.validate()?;
                validate_query_limit(*limit)
            }
            Self::Search {
                source,
                query,
                limit,
            } => {
                source.validate()?;
                validate_bounded_line(query, ISSUE_TRACKER_LINE_LIMIT_V2, "issue tracker query")?;
                validate_query_limit(*limit)
            }
            Self::Show { task_ref } => task_ref.validate(),
        }
    }
}

fn validate_query_limit(limit: u16) -> Result<(), IssueTrackerContractErrorV2> {
    if limit == 0 || limit > ISSUE_TRACKER_QUERY_LIMIT_V2 {
        return Err(IssueTrackerContractErrorV2::new(
            "issue tracker query limit is outside the supported range",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerQueryResultV2 {
    TaskList {
        tasks: Vec<IssueTrackerTaskSummaryV2>,
        complete: bool,
    },
    Task {
        task: Box<IssueTrackerTaskDetailV2>,
    },
}

impl IssueTrackerQueryResultV2 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV2> {
        match self {
            Self::TaskList { tasks, .. } => {
                if tasks.len() > ISSUE_TRACKER_QUERY_LIMIT_V2.into() {
                    return Err(IssueTrackerContractErrorV2::new(
                        "issue tracker result exceeds the supported limit",
                    ));
                }
                for task in tasks {
                    task.validate()?;
                }
                Ok(())
            }
            Self::Task { task } => task.validate(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider() -> IssueTrackerProviderV2 {
        IssueTrackerProviderV2 {
            schema_version: ISSUE_TRACKER_SCHEMA_VERSION_V2,
            provider: ProviderIdV1::new("github").unwrap(),
            authority: IssueTrackerDataAuthorityV2::Provider,
            common_operations: vec![
                IssueTrackerCommonOperationV2::List,
                IssueTrackerCommonOperationV2::Search,
                IssueTrackerCommonOperationV2::Show,
            ],
            provider_capabilities: vec![
                IssueTrackerCapabilityIdV2::new("github.issue.labels").unwrap(),
            ],
        }
    }

    #[test]
    fn provider_separates_common_operations_from_namespaced_features() {
        let mut provider = provider();
        assert!(provider.validate().is_ok());
        provider.provider_capabilities =
            vec![IssueTrackerCapabilityIdV2::new("beads.issue.ready").unwrap()];
        assert!(provider.validate().is_err());
    }

    #[test]
    fn provider_rejects_cross_provider_sources() {
        let provider = provider();
        let source = IssueTrackerSourceV2 {
            provider: ProviderIdV1::new("linear").unwrap(),
            connection_id: IssueTrackerConnectionIdV2::new("linear.primary").unwrap(),
            scope_id: IssueTrackerScopeIdV2::new("team-1").unwrap(),
            scope_display_name: "Engineering".to_owned(),
        };
        assert!(provider.validate_source(&source).is_err());
    }

    #[test]
    fn opaque_task_ids_and_display_keys_preserve_provider_identity() {
        assert!(IssueTrackerTaskIdV2::new("I_kwDOABCD1234").is_ok());
        assert!(IssueTrackerTaskIdV2::new("123").is_ok());
        assert!(IssueTrackerTaskDisplayKeyV2::new("ENG-42").is_ok());
        assert!(IssueTrackerTaskDisplayKeyV2::new("#123").is_ok());
        assert!(IssueTrackerTaskIdV2::new("\n--all").is_err());
    }

    #[test]
    fn queries_fail_before_adapter_work_when_unbounded() {
        let source = IssueTrackerSourceV2 {
            provider: ProviderIdV1::new("github").unwrap(),
            connection_id: IssueTrackerConnectionIdV2::new("github.personal").unwrap(),
            scope_id: IssueTrackerScopeIdV2::new("hebbianai/dure-internal").unwrap(),
            scope_display_name: "hebbianai/dure-internal".to_owned(),
        };
        assert!(
            IssueTrackerQueryV2::List {
                source: source.clone(),
                limit: 0,
            }
            .validate()
            .is_err()
        );
        assert!(
            IssueTrackerQueryV2::Search {
                source,
                query: "broken\nquery".to_owned(),
                limit: 10,
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn provider_rejects_valid_but_unadvertised_queries() {
        let mut provider = provider();
        provider
            .common_operations
            .retain(|operation| *operation != IssueTrackerCommonOperationV2::Search);
        let query = IssueTrackerQueryV2::Search {
            source: IssueTrackerSourceV2 {
                provider: ProviderIdV1::new("github").unwrap(),
                connection_id: IssueTrackerConnectionIdV2::new("github.personal").unwrap(),
                scope_id: IssueTrackerScopeIdV2::new("hebbianai/dure-internal").unwrap(),
                scope_display_name: "hebbianai/dure-internal".to_owned(),
            },
            query: "tracker".to_owned(),
            limit: 10,
        };
        assert!(query.validate().is_ok());
        assert!(provider.validate_query(&query).is_err());
    }
}
