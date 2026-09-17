use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{
    ContributionIdV2, PluginContractValidationErrorV2, PluginManifestV2, PluginPlacementV2,
    PluginSettingKeyV1, StableIdError, contract::validate_stable_id,
};

pub const PLUGIN_VIEWS_SCHEMA_VERSION_V1: u16 = 1;
const MAX_VIEW_CONTAINERS_V1: usize = 8;
const MAX_VIEWS_V1: usize = 32;
const MAX_TRANSLATIONS_V1: usize = 16;
const MAX_AGENT_CLAIM_STATUSES_V1: usize = 8;

macro_rules! view_stable_id {
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
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }
    };
}

view_stable_id!(PluginViewContainerIdV1);
view_stable_id!(PluginViewIdV1);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginLocalizedTextV1 {
    pub default: String,
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
}

impl PluginLocalizedTextV1 {
    fn validate(&self, field: &str) -> Result<(), PluginContractValidationErrorV2> {
        self.validate_for("plugin view", field)
    }

    pub(crate) fn validate_for(
        &self,
        subject: &str,
        field: &str,
    ) -> Result<(), PluginContractValidationErrorV2> {
        validate_copy(subject, field, &self.default)?;
        if self.translations.len() > MAX_TRANSLATIONS_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "{subject} {field} has too many translations"
            )));
        }
        for (locale, value) in &self.translations {
            if locale.is_empty()
                || locale.len() > 32
                || locale.starts_with('-')
                || locale.ends_with('-')
                || !locale
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
            {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "{subject} {field} has invalid locale {locale:?}"
                )));
            }
            validate_copy(subject, field, value)?;
        }
        Ok(())
    }
}

fn validate_copy(
    subject: &str,
    field: &str,
    value: &str,
) -> Result<(), PluginContractValidationErrorV2> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.len() > 128
        || value.chars().any(char::is_control)
    {
        return Err(PluginContractValidationErrorV2::new(format!(
            "{subject} {field} must be non-empty, trimmed, control-free, and at most 128 bytes"
        )));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginViewContainerLocationV1 {
    PrimarySidebar,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginViewIconV1 {
    CircleDot,
    /// The GitHub mark. Reserved for surfaces that mean the GitHub service
    /// (the bundled GitHub plugin); the app's own git surfaces use a branch.
    Github,
    Inbox,
    ListTodo,
    Puzzle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginViewContainerV1 {
    pub id: PluginViewContainerIdV1,
    pub location: PluginViewContainerLocationV1,
    pub title: PluginLocalizedTextV1,
    pub icon: PluginViewIconV1,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginIssueTrackerDefaultQueryV1 {
    Human,
    List,
    Ready,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginIssueTrackerAgentClaimsSurfaceV1 {
    AgentPaneClaimStatus,
    PrimarySidebar,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginIssueTrackerAgentClaimsV1 {
    pub title: PluginLocalizedTextV1,
    pub setting_key: PluginSettingKeyV1,
    pub statuses: Vec<String>,
    pub surfaces: Vec<PluginIssueTrackerAgentClaimsSurfaceV1>,
}

/// How a plugin names the tracker's lists in its own words. The neutral
/// query `ready` means "actionable for the current actor"; Beads reads that
/// as unblocked work and GitHub as "assigned to me". Absent titles fall back
/// to the host's generic labels.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginIssueTrackerQueryTitlesV1 {
    #[serde(default)]
    pub ready: Option<PluginLocalizedTextV1>,
    #[serde(default)]
    pub list: Option<PluginLocalizedTextV1>,
    #[serde(default)]
    pub human: Option<PluginLocalizedTextV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginViewKindV1 {
    IssueTracker {
        provider_contribution_id: ContributionIdV2,
        default_query: PluginIssueTrackerDefaultQueryV1,
        #[serde(default)]
        default_query_setting_key: Option<PluginSettingKeyV1>,
        #[serde(default)]
        watch_interval_setting_key: Option<PluginSettingKeyV1>,
        agent_claims: Option<PluginIssueTrackerAgentClaimsV1>,
        #[serde(default)]
        query_titles: Option<PluginIssueTrackerQueryTitlesV1>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginViewV1 {
    pub id: PluginViewIdV1,
    pub container_id: PluginViewContainerIdV1,
    pub title: PluginLocalizedTextV1,
    #[serde(flatten)]
    pub kind: PluginViewKindV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct PluginViewsV1 {
    pub schema_version: u16,
    pub containers: Vec<PluginViewContainerV1>,
    pub views: Vec<PluginViewV1>,
}

impl PluginViewsV1 {
    pub fn validate_for_manifest(
        &self,
        manifest: &PluginManifestV2,
    ) -> Result<(), PluginContractValidationErrorV2> {
        if self.schema_version != PLUGIN_VIEWS_SCHEMA_VERSION_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "unsupported plugin views schema version {}; expected {}",
                self.schema_version, PLUGIN_VIEWS_SCHEMA_VERSION_V1
            )));
        }
        if self.containers.is_empty() || self.containers.len() > MAX_VIEW_CONTAINERS_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "plugin views must declare between 1 and {MAX_VIEW_CONTAINERS_V1} containers"
            )));
        }
        if self.views.is_empty() || self.views.len() > MAX_VIEWS_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "plugin views must declare between 1 and {MAX_VIEWS_V1} views"
            )));
        }
        if manifest.contributions.iter().any(|contribution| {
            contribution.family.as_str() == "dure.views"
                && contribution.placement != PluginPlacementV2::Ui
        }) {
            return Err(PluginContractValidationErrorV2::new(
                "dure.views contributions must use ui placement".to_owned(),
            ));
        }
        let primary_sidebar_granted = manifest.permissions.iter().any(|permission| {
            permission.kind.as_str() == "dure.ui.contribute"
                && permission
                    .parameters
                    .get("surfaces")
                    .is_some_and(|surfaces| {
                        surfaces.iter().any(|surface| surface == "primary_sidebar")
                    })
        });
        if !primary_sidebar_granted {
            return Err(PluginContractValidationErrorV2::new(
                "primary sidebar views require dure.ui.contribute surfaces=primary_sidebar"
                    .to_owned(),
            ));
        }
        let namespace = format!("{}.", manifest.id.as_str());
        let mut container_ids = BTreeSet::new();
        for container in &self.containers {
            if !container.id.as_str().starts_with(&namespace) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin view container {} must be namespaced by plugin {}",
                    container.id.as_str(),
                    manifest.id.as_str()
                )));
            }
            if !container_ids.insert(&container.id) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin views contain duplicate container {}",
                    container.id.as_str()
                )));
            }
            container.title.validate("container title")?;
        }

        let issue_tracker_contributions = manifest
            .contributions
            .iter()
            .filter(|contribution| contribution.family.as_str() == "dure.issue-tracker")
            .map(|contribution| &contribution.id)
            .collect::<BTreeSet<_>>();
        let mut view_ids = BTreeSet::new();
        let mut populated_containers = BTreeSet::new();
        for view in &self.views {
            if !view.id.as_str().starts_with(&namespace) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin view {} must be namespaced by plugin {}",
                    view.id.as_str(),
                    manifest.id.as_str()
                )));
            }
            if !view_ids.insert(&view.id) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin views contain duplicate view {}",
                    view.id.as_str()
                )));
            }
            if !container_ids.contains(&view.container_id) {
                return Err(PluginContractValidationErrorV2::new(format!(
                    "plugin view {} references undeclared container {}",
                    view.id.as_str(),
                    view.container_id.as_str()
                )));
            }
            populated_containers.insert(&view.container_id);
            view.title.validate("title")?;
            match &view.kind {
                PluginViewKindV1::IssueTracker {
                    provider_contribution_id,
                    ..
                } if !issue_tracker_contributions.contains(provider_contribution_id) => {
                    return Err(PluginContractValidationErrorV2::new(format!(
                        "plugin view {} references unavailable issue tracker contribution {}",
                        view.id.as_str(),
                        provider_contribution_id.as_str()
                    )));
                }
                PluginViewKindV1::IssueTracker { agent_claims, .. } => {
                    if let Some(agent_claims) = agent_claims {
                        agent_claims.title.validate("agent claims title")?;
                        let surfaces = agent_claims.surfaces.iter().collect::<BTreeSet<_>>();
                        if surfaces.is_empty() || surfaces.len() != agent_claims.surfaces.len() {
                            return Err(PluginContractValidationErrorV2::new(format!(
                                "plugin view {} agent claims surfaces must be non-empty and unique",
                                view.id.as_str()
                            )));
                        }
                        let ui_surfaces = manifest
                            .permissions
                            .iter()
                            .find(|permission| permission.kind.as_str() == "dure.ui.contribute")
                            .and_then(|permission| permission.parameters.get("surfaces"));
                        for surface in &agent_claims.surfaces {
                            let required = match surface {
                                PluginIssueTrackerAgentClaimsSurfaceV1::AgentPaneClaimStatus => {
                                    "agent_pane_claim_status"
                                }
                                PluginIssueTrackerAgentClaimsSurfaceV1::PrimarySidebar => {
                                    "primary_sidebar"
                                }
                            };
                            if !ui_surfaces.is_some_and(|granted| {
                                granted.iter().any(|surface| surface == required)
                            }) {
                                return Err(PluginContractValidationErrorV2::new(format!(
                                    "plugin view {} agent claims require dure.ui.contribute surfaces={required}",
                                    view.id.as_str()
                                )));
                            }
                        }
                        if agent_claims.statuses.is_empty()
                            || agent_claims.statuses.len() > MAX_AGENT_CLAIM_STATUSES_V1
                        {
                            return Err(PluginContractValidationErrorV2::new(format!(
                                "plugin view {} agent claims must declare between 1 and {MAX_AGENT_CLAIM_STATUSES_V1} statuses",
                                view.id.as_str()
                            )));
                        }
                        let mut statuses = BTreeSet::new();
                        for status in &agent_claims.statuses {
                            if status.is_empty()
                                || status.len() > 128
                                || !status.bytes().all(|byte| {
                                    byte.is_ascii_lowercase()
                                        || byte.is_ascii_digit()
                                        || b"_-".contains(&byte)
                                })
                                || !status
                                    .as_bytes()
                                    .first()
                                    .is_some_and(u8::is_ascii_lowercase)
                            {
                                return Err(PluginContractValidationErrorV2::new(format!(
                                    "plugin view {} agent claims contain invalid status {status:?}",
                                    view.id.as_str()
                                )));
                            }
                            if !statuses.insert(status) {
                                return Err(PluginContractValidationErrorV2::new(format!(
                                    "plugin view {} agent claims contain duplicate status {status:?}",
                                    view.id.as_str()
                                )));
                            }
                        }
                    }
                }
            }
        }
        if populated_containers.len() != container_ids.len() {
            return Err(PluginContractValidationErrorV2::new(
                "every plugin view container must contain at least one view".to_owned(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> PluginManifestV2 {
        serde_json::from_str(include_str!("../../../plugins/beads/dure-plugin.json")).unwrap()
    }

    fn views() -> PluginViewsV1 {
        serde_json::from_str(include_str!(
            "../../../plugins/beads/contributions/views.json"
        ))
        .unwrap()
    }

    #[test]
    fn bundled_views_are_namespaced_and_reference_a_declared_provider() {
        views().validate_for_manifest(&manifest()).unwrap();
    }

    #[test]
    fn views_reject_foreign_provider_and_unbounded_container_growth() {
        let manifest = manifest();
        let mut invalid_provider_views = views();
        let PluginViewKindV1::IssueTracker {
            provider_contribution_id,
            ..
        } = &mut invalid_provider_views.views[0].kind;
        *provider_contribution_id = ContributionIdV2::new("example.foreign.issues").unwrap();
        assert!(
            invalid_provider_views
                .validate_for_manifest(&manifest)
                .is_err()
        );

        let mut oversized_views = views();
        let template = oversized_views.containers[0].clone();
        for index in 0..MAX_VIEW_CONTAINERS_V1 {
            let mut container = template.clone();
            container.id =
                PluginViewContainerIdV1::new(format!("dure.beads.container-{index}")).unwrap();
            oversized_views.containers.push(container);
        }
        assert!(oversized_views.validate_for_manifest(&manifest).is_err());

        let mut missing_permission_manifest = manifest.clone();
        missing_permission_manifest
            .permissions
            .retain(|permission| permission.kind.as_str() != "dure.ui.contribute");
        assert!(
            views()
                .validate_for_manifest(&missing_permission_manifest)
                .is_err()
        );

        let mut missing_agent_pane_permission = manifest.clone();
        let ui_permission = missing_agent_pane_permission
            .permissions
            .iter_mut()
            .find(|permission| permission.kind.as_str() == "dure.ui.contribute")
            .unwrap();
        ui_permission
            .parameters
            .get_mut("surfaces")
            .unwrap()
            .retain(|surface| surface != "agent_pane_claim_status");
        assert!(
            views()
                .validate_for_manifest(&missing_agent_pane_permission)
                .is_err()
        );

        let mut invalid_status_views = views();
        let PluginViewKindV1::IssueTracker {
            agent_claims: Some(agent_claims),
            ..
        } = &mut invalid_status_views.views[0].kind
        else {
            panic!("fixture must declare agent claims");
        };
        agent_claims.statuses = vec!["--all".to_owned()];
        assert!(
            invalid_status_views
                .validate_for_manifest(&manifest)
                .is_err()
        );

        let mut duplicate_surface_views = views();
        let PluginViewKindV1::IssueTracker {
            agent_claims: Some(agent_claims),
            ..
        } = &mut duplicate_surface_views.views[0].kind
        else {
            panic!("fixture must declare agent claims");
        };
        agent_claims.surfaces.push(agent_claims.surfaces[0].clone());
        assert!(
            duplicate_surface_views
                .validate_for_manifest(&manifest)
                .is_err()
        );
    }
}
