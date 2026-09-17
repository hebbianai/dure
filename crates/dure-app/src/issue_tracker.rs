use std::{collections::BTreeSet, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{ContributionIdV2, PluginIdV2, ProviderIdV1};

pub const ISSUE_TRACKER_SCHEMA_VERSION_V1: u16 = 1;
pub const ISSUE_TRACKER_QUERY_LIMIT_V1: u16 = 100;
const ISSUE_TRACKER_STATUS_LIMIT_V1: usize = 8;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct IssueTrackerIssueIdV1(String);

impl IssueTrackerIssueIdV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, IssueTrackerContractErrorV1> {
        let value = value.into();
        if value.is_empty() || value.len() > 256 {
            return Err(IssueTrackerContractErrorV1::new(
                "issue id must be between 1 and 256 bytes",
            ));
        }
        if value.trim() != value
            || !value.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte)
            })
            || !value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        {
            return Err(IssueTrackerContractErrorV1::new(
                "issue id must be a lowercase stable identifier",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for IssueTrackerIssueIdV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum IssueTrackerOperationV1 {
    Human,
    List,
    Ready,
    Show,
    Watch,
}

/// Legacy declaration retained for schema-v1 compatibility. Dure's native
/// host never executes repository-owned package scripts; a future host-owned
/// adapter contract must use a new schema version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerRepositoryWrapperV1 {
    PackageScript { script: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerAgentBindingSourceV1 {
    ScmBranchMetadata { metadata_key: String },
}

/// How a mutation started from the issue surface reaches the tracker. The
/// host never executes these argv templates: the frontend renders the one
/// `{issue_id}` placeholder and runs the line as a command pane in the
/// workspace, where the repository's own wrapper attributes the actor and
/// journals the write exactly as for a hand-typed command.
///
/// `requires_package_script` names the package script those templates go
/// through. A workspace whose `package.json` does not declare it cannot run
/// them, so the surface offers no mutation there rather than an action that
/// always fails.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerMutationDeliveryV1 {
    TerminalCommand {
        #[serde(default)]
        close: Option<Vec<String>>,
        #[serde(default)]
        delete: Option<Vec<String>>,
        #[serde(default)]
        requires_package_script: Option<String>,
    },
}

pub const ISSUE_TRACKER_ISSUE_ID_PLACEHOLDER_V1: &str = "{issue_id}";

fn validate_terminal_command_template(
    template: &[String],
) -> Result<(), IssueTrackerContractErrorV1> {
    let placeholders = template
        .iter()
        .filter(|token| token.as_str() == ISSUE_TRACKER_ISSUE_ID_PLACEHOLDER_V1)
        .count();
    let bounded = !template.is_empty()
        && template.len() <= 16
        && template.iter().all(|token| {
            !token.is_empty()
                && token.len() <= 128
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-{}=/:@".contains(&byte))
        });
    if !bounded || placeholders != 1 {
        return Err(IssueTrackerContractErrorV1::new(
            "terminal command template must be bounded shell words with exactly one {issue_id}",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerAgentBindingV1 {
    ScmBranch { branch: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerProviderV1 {
    pub schema_version: u16,
    pub provider: ProviderIdV1,
    pub operations: Vec<IssueTrackerOperationV1>,
    #[serde(default)]
    pub prefer_repository_wrapper: bool,
    pub repository_wrapper: Option<IssueTrackerRepositoryWrapperV1>,
    pub agent_binding: Option<IssueTrackerAgentBindingSourceV1>,
    #[serde(default)]
    pub mutation_delivery: Option<IssueTrackerMutationDeliveryV1>,
}

impl IssueTrackerProviderV1 {
    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV1> {
        if self.schema_version != ISSUE_TRACKER_SCHEMA_VERSION_V1 {
            return Err(IssueTrackerContractErrorV1::new(
                "unsupported issue tracker schema version",
            ));
        }
        if self.operations.is_empty() {
            return Err(IssueTrackerContractErrorV1::new(
                "issue tracker must declare at least one operation",
            ));
        }
        let unique = self.operations.iter().collect::<BTreeSet<_>>();
        if unique.len() != self.operations.len() {
            return Err(IssueTrackerContractErrorV1::new(
                "issue tracker operations must be unique",
            ));
        }
        if self.prefer_repository_wrapper && self.repository_wrapper.is_none() {
            return Err(IssueTrackerContractErrorV1::new(
                "preferred repository wrapper must be declared",
            ));
        }
        if let Some(IssueTrackerRepositoryWrapperV1::PackageScript { script }) =
            &self.repository_wrapper
        {
            let valid = !script.is_empty()
                && script.len() <= 128
                && script.trim() == script
                && script.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b":-_".contains(&byte)
                })
                && script
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_lowercase);
            if !valid {
                return Err(IssueTrackerContractErrorV1::new(
                    "package wrapper script is not a bounded stable name",
                ));
            }
        }
        if let Some(IssueTrackerAgentBindingSourceV1::ScmBranchMetadata { metadata_key }) =
            &self.agent_binding
        {
            let valid = !metadata_key.is_empty()
                && metadata_key.len() <= 64
                && metadata_key.trim() == metadata_key
                && metadata_key.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
                && metadata_key
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_lowercase);
            if !valid {
                return Err(IssueTrackerContractErrorV1::new(
                    "issue tracker agent binding metadata key is invalid",
                ));
            }
        }
        if let Some(IssueTrackerMutationDeliveryV1::TerminalCommand {
            close,
            delete,
            requires_package_script,
        }) = &self.mutation_delivery
        {
            for template in [close, delete].into_iter().flatten() {
                validate_terminal_command_template(template)?;
            }
            if let Some(script) = requires_package_script {
                let valid = !script.is_empty()
                    && script.len() <= 128
                    && script.trim() == script
                    && script.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || b":-_".contains(&byte)
                    })
                    && script
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_lowercase);
                if !valid {
                    return Err(IssueTrackerContractErrorV1::new(
                        "mutation delivery package script is not a bounded stable name",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn supports(&self, operation: IssueTrackerOperationV1) -> bool {
        self.operations.contains(&operation)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerQueryV1 {
    Ready { limit: u16 },
    List { limit: u16 },
    ListByStatus { statuses: Vec<String>, limit: u16 },
    AgentClaims { statuses: Vec<String>, limit: u16 },
    Show { issue_id: IssueTrackerIssueIdV1 },
    Human { limit: u16 },
    Counts,
}

impl IssueTrackerQueryV1 {
    pub fn operation(&self) -> IssueTrackerOperationV1 {
        match self {
            Self::Ready { .. } => IssueTrackerOperationV1::Ready,
            Self::List { .. } | Self::ListByStatus { .. } | Self::AgentClaims { .. } => {
                IssueTrackerOperationV1::List
            }
            Self::Show { .. } => IssueTrackerOperationV1::Show,
            Self::Human { .. } => IssueTrackerOperationV1::Human,
            Self::Counts => IssueTrackerOperationV1::List,
        }
    }

    pub fn validate(&self) -> Result<(), IssueTrackerContractErrorV1> {
        let limit = match self {
            Self::Ready { limit }
            | Self::List { limit }
            | Self::ListByStatus { limit, .. }
            | Self::AgentClaims { limit, .. }
            | Self::Human { limit } => Some(*limit),
            Self::Show { .. } | Self::Counts => None,
        };
        if limit.is_some_and(|limit| limit == 0 || limit > ISSUE_TRACKER_QUERY_LIMIT_V1) {
            return Err(IssueTrackerContractErrorV1::new(
                "issue tracker query limit is outside the supported range",
            ));
        }
        if let Self::ListByStatus { statuses, .. } | Self::AgentClaims { statuses, .. } = self {
            if statuses.is_empty() || statuses.len() > ISSUE_TRACKER_STATUS_LIMIT_V1 {
                return Err(IssueTrackerContractErrorV1::new(
                    "issue tracker status filter is outside the supported range",
                ));
            }
            let unique = statuses.iter().collect::<BTreeSet<_>>();
            if unique.len() != statuses.len()
                || statuses.iter().any(|status| {
                    status.is_empty()
                        || status.len() > 128
                        || status.trim() != status
                        || !status.bytes().all(|byte| {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || b"_-".contains(&byte)
                        })
                        || !status
                            .as_bytes()
                            .first()
                            .is_some_and(u8::is_ascii_lowercase)
                })
            {
                return Err(IssueTrackerContractErrorV1::new(
                    "issue tracker status filters must be unique bounded text",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerCountsV1 {
    pub ready: u32,
    pub open: u32,
    pub blocked: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerIssueSummaryV1 {
    pub id: IssueTrackerIssueIdV1,
    pub title: String,
    pub status: String,
    /// Tracker priority where the tracker has one (Beads: 0 is the highest).
    /// `None` is "this tracker has no priority", not "priority zero" — a
    /// GitHub issue rendered as P0 would claim the top Beads rank.
    #[serde(default)]
    pub priority: Option<i32>,
    pub issue_type: String,
    pub assignee: Option<String>,
    pub updated_at: Option<String>,
    pub dependency_count: u32,
    pub dependent_count: u32,
    pub agent_binding: Option<IssueTrackerAgentBindingV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerIssueDetailV1 {
    pub summary: IssueTrackerIssueSummaryV1,
    pub description: Option<String>,
    pub design: Option<String>,
    pub acceptance_criteria: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerQueryResultV1 {
    Ready {
        issues: Vec<IssueTrackerIssueSummaryV1>,
        #[serde(default)]
        complete: Option<bool>,
    },
    List {
        issues: Vec<IssueTrackerIssueSummaryV1>,
        #[serde(default)]
        complete: Option<bool>,
    },
    Show {
        issue: Box<IssueTrackerIssueDetailV1>,
    },
    Human {
        issues: Vec<IssueTrackerIssueSummaryV1>,
        #[serde(default)]
        complete: Option<bool>,
    },
    Counts {
        counts: IssueTrackerCountsV1,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerWatchSnapshotV1 {
    pub issues: Vec<IssueTrackerIssueSummaryV1>,
    #[serde(default)]
    pub issues_complete: Option<bool>,
    pub human_issues: Vec<IssueTrackerIssueSummaryV1>,
    #[serde(default)]
    pub human_issues_complete: Option<bool>,
    /// Issues participating in a view-declared agent-claim projection. Older
    /// schema-v1 hosts omit this field, so consumers must accept an empty list.
    #[serde(default)]
    pub agent_claim_issues: Option<Vec<IssueTrackerIssueSummaryV1>>,
    #[serde(default)]
    pub agent_claim_issues_complete: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueTrackerWatchStateV1 {
    Snapshot {
        revision_digest: String,
        snapshot: IssueTrackerWatchSnapshotV1,
    },
    Unavailable {
        code: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerWatchEventV1 {
    /// Optional for wire compatibility with schema-v1 events emitted before
    /// contribution-scoped watchers were introduced.
    #[serde(default)]
    pub plugin_id: Option<PluginIdV2>,
    #[serde(default)]
    pub contribution_id: Option<ContributionIdV2>,
    pub workspace_key: String,
    pub generation: u32,
    pub revision: u32,
    pub state: IssueTrackerWatchStateV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct IssueTrackerWatchSubscriptionV1 {
    pub workspace_key: String,
    pub generation: u32,
    pub reused_watcher: bool,
    pub latest: Option<IssueTrackerWatchEventV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssueTrackerContractErrorV1 {
    message: &'static str,
}

impl IssueTrackerContractErrorV1 {
    fn new(message: &'static str) -> Self {
        Self { message }
    }
}

impl fmt::Display for IssueTrackerContractErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl Error for IssueTrackerContractErrorV1 {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_bounds_terminal_mutation_templates() {
        let provider = |delete: Vec<&str>| IssueTrackerProviderV1 {
            schema_version: ISSUE_TRACKER_SCHEMA_VERSION_V1,
            provider: ProviderIdV1::new("beads").unwrap(),
            operations: vec![IssueTrackerOperationV1::List],
            prefer_repository_wrapper: false,
            repository_wrapper: None,
            agent_binding: None,
            mutation_delivery: Some(IssueTrackerMutationDeliveryV1::TerminalCommand {
                close: None,
                delete: Some(delete.into_iter().map(str::to_owned).collect()),
                requires_package_script: Some("beads".to_owned()),
            }),
        };

        assert!(
            provider(vec![
                "pnpm",
                "beads",
                "--",
                "mutate",
                "delete",
                "{issue_id}",
                "--force"
            ])
            .validate()
            .is_ok()
        );
        for template in [
            vec![],
            vec!["pnpm", "beads", "--", "mutate", "delete"],
            vec!["{issue_id}", "{issue_id}"],
            vec!["rm -rf", "{issue_id}"],
            vec!["pnpm", "beads;", "{issue_id}"],
        ] {
            assert!(provider(template).validate().is_err());
        }

        let mut named = provider(vec!["pnpm", "beads", "--", "close", "{issue_id}"]);
        if let Some(IssueTrackerMutationDeliveryV1::TerminalCommand {
            requires_package_script,
            ..
        }) = &mut named.mutation_delivery
        {
            *requires_package_script = Some("Beads Wrapper".to_owned());
        }
        assert!(named.validate().is_err());
    }

    #[test]
    fn provider_requires_unique_operations() {
        let mut provider = IssueTrackerProviderV1 {
            schema_version: ISSUE_TRACKER_SCHEMA_VERSION_V1,
            provider: ProviderIdV1::new("beads").unwrap(),
            operations: vec![
                IssueTrackerOperationV1::Ready,
                IssueTrackerOperationV1::Watch,
            ],
            prefer_repository_wrapper: false,
            repository_wrapper: None,
            agent_binding: Some(IssueTrackerAgentBindingSourceV1::ScmBranchMetadata {
                metadata_key: "dure_worktree_branch".to_owned(),
            }),
            mutation_delivery: None,
        };
        assert!(provider.validate().is_ok());
        provider.operations.push(IssueTrackerOperationV1::Watch);
        assert!(provider.validate().is_err());
    }

    #[test]
    fn queries_and_issue_ids_are_bounded_before_adapter_work() {
        assert!(IssueTrackerIssueIdV1::new("hebbian-frontend-kacd.3").is_ok());
        assert!(IssueTrackerIssueIdV1::new("--all").is_err());
        assert!(
            IssueTrackerQueryV1::Ready {
                limit: ISSUE_TRACKER_QUERY_LIMIT_V1 + 1
            }
            .validate()
            .is_err()
        );
        assert!(
            IssueTrackerQueryV1::ListByStatus {
                statuses: vec!["in_progress".to_owned(), "in_progress".to_owned()],
                limit: 100,
            }
            .validate()
            .is_err()
        );
        assert!(
            IssueTrackerQueryV1::ListByStatus {
                statuses: vec!["--all".to_owned()],
                limit: 100,
            }
            .validate()
            .is_err()
        );
        assert_eq!(
            IssueTrackerQueryV1::Counts.operation(),
            IssueTrackerOperationV1::List
        );
    }
}
