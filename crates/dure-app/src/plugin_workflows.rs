use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

use crate::{
    PluginContractValidationErrorV2, PluginLocalizedTextV1, PluginManifestV2, PluginPlacementV2,
    StableIdError, contract::validate_stable_id,
};

pub const PLUGIN_WORKFLOWS_SCHEMA_VERSION_V1: u16 = 1;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "string")]
pub struct WorkflowKindIdV1(String);

impl WorkflowKindIdV1 {
    pub fn new(value: impl Into<String>) -> Result<Self, StableIdError> {
        let value = value.into();
        validate_stable_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for WorkflowKindIdV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginWorkflowContributionV1 {
    pub schema_version: u16,
    pub kind: WorkflowKindIdV1,
    pub title: PluginLocalizedTextV1,
    pub description: PluginLocalizedTextV1,
}

impl PluginWorkflowContributionV1 {
    pub fn validate_for_manifest(
        &self,
        manifest: &PluginManifestV2,
    ) -> Result<(), PluginContractValidationErrorV2> {
        if self.schema_version != PLUGIN_WORKFLOWS_SCHEMA_VERSION_V1 {
            return Err(PluginContractValidationErrorV2::new(format!(
                "unsupported plugin workflow schema version {}; expected {}",
                self.schema_version, PLUGIN_WORKFLOWS_SCHEMA_VERSION_V1
            )));
        }
        if !self.kind.as_str().starts_with("workflow.") {
            return Err(PluginContractValidationErrorV2::new(
                "plugin workflow kind must use the workflow namespace".to_owned(),
            ));
        }
        if manifest.contributions.iter().any(|contribution| {
            contribution.family.as_str() == "dure.workflows"
                && contribution.placement != PluginPlacementV2::Ui
        }) {
            return Err(PluginContractValidationErrorV2::new(
                "dure.workflows contributions must use ui placement".to_owned(),
            ));
        }
        self.title.validate_for("plugin workflow", "title")?;
        self.description
            .validate_for("plugin workflow", "description")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        ContractVersionRangeV2, ContributionDescriptorV2, ContributionFamilyIdV2, ContributionIdV2,
        PluginIdV2, PluginManifestV2, PluginPlacementV2, PluginPublisherIdV2, PluginResourcePathV2,
        PluginVersionV2,
    };

    use super::*;

    fn manifest(placement: PluginPlacementV2) -> PluginManifestV2 {
        PluginManifestV2 {
            schema_version: 2,
            id: PluginIdV2::new("dure.core").unwrap(),
            publisher: PluginPublisherIdV2::new("dure").unwrap(),
            version: PluginVersionV2::new("0.1.0").unwrap(),
            display_name: "Dure Core".into(),
            description: None,
            host_api: ContractVersionRangeV2::new(1, 2),
            activation: Vec::new(),
            contributions: vec![ContributionDescriptorV2 {
                id: ContributionIdV2::new("dure.core.delegate-once").unwrap(),
                family: ContributionFamilyIdV2::new("dure.workflows").unwrap(),
                family_api: ContractVersionRangeV2::new(1, 1),
                required: true,
                placement,
                resource: PluginResourcePathV2::new("./contributions/workflows.json").unwrap(),
            }],
            agent_integrations: Vec::new(),
            permissions: Vec::new(),
        }
    }

    fn workflow() -> PluginWorkflowContributionV1 {
        PluginWorkflowContributionV1 {
            schema_version: 1,
            kind: WorkflowKindIdV1::new("workflow.delegate_once").unwrap(),
            title: PluginLocalizedTextV1 {
                default: "작업 위임".into(),
                translations: Default::default(),
            },
            description: PluginLocalizedTextV1 {
                default: "worker 하나를 시작합니다.".into(),
                translations: Default::default(),
            },
        }
    }

    #[test]
    fn accepts_one_host_rendered_workflow_declaration() {
        workflow()
            .validate_for_manifest(&manifest(PluginPlacementV2::Ui))
            .unwrap();
    }

    #[test]
    fn rejects_wrong_placement_namespace_and_future_fields() {
        assert!(
            workflow()
                .validate_for_manifest(&manifest(PluginPlacementV2::Workspace))
                .is_err()
        );
        let mut wrong_kind = workflow();
        wrong_kind.kind = WorkflowKindIdV1::new("delegate_once").unwrap();
        assert!(
            wrong_kind
                .validate_for_manifest(&manifest(PluginPlacementV2::Ui))
                .is_err()
        );
        assert!(
            serde_json::from_value::<PluginWorkflowContributionV1>(serde_json::json!({
                "schema_version": 1,
                "kind": "workflow.delegate_once",
                "title": { "default": "작업 위임" },
                "description": { "default": "worker 하나를 시작합니다." },
                "command": "codex"
            }))
            .is_err()
        );
    }
}
