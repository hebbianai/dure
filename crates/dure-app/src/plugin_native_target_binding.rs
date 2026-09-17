use std::{collections::BTreeMap, error::Error, fmt};

use serde::{Deserialize, Deserializer, Serialize};

use crate::{
    AgentNativePluginRegistrationTargetV2, DomainStoreFuture, OperationIdV1, PhysicalTargetKeyV2,
    PluginApplyStepV2,
};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct PluginNativePhysicalTargetDigestV2(String);

impl PluginNativePhysicalTargetDigestV2 {
    pub fn new(value: impl Into<String>) -> Result<Self, PluginNativeTargetBindingErrorV2> {
        let value = value.into();
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(PluginNativeTargetBindingErrorV2::InvalidDigest);
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginNativeTargetBindingErrorV2::InvalidDigest);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PluginNativePhysicalTargetDigestV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginNativePhysicalTargetRoleV2 {
    ProfileRoot,
    WorkspaceRoot,
}

impl PluginNativePhysicalTargetRoleV2 {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProfileRoot => "profile_root",
            Self::WorkspaceRoot => "workspace_root",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativePhysicalTargetBindingV2 {
    pub key: PhysicalTargetKeyV2,
    pub role: PluginNativePhysicalTargetRoleV2,
    pub canonical_path_identity: PluginNativePhysicalTargetDigestV2,
    pub filesystem_object_identity: PluginNativePhysicalTargetDigestV2,
    pub authority_generation_identity: PluginNativePhysicalTargetDigestV2,
    pub authority_identity: PluginNativePhysicalTargetDigestV2,
    pub binding_identity: PluginNativePhysicalTargetDigestV2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeTargetBindingErrorV2 {
    InvalidDigest,
    DuplicateTargetKey { key: PhysicalTargetKeyV2 },
    ConflictingTargetRole { key: PhysicalTargetKeyV2 },
    MissingTargetBinding { key: PhysicalTargetKeyV2 },
    UnexpectedTargetBinding { key: PhysicalTargetKeyV2 },
    UnsortedTargetBindings,
}

impl fmt::Display for PluginNativeTargetBindingErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDigest => formatter
                .write_str("native physical target identity must be a lowercase SHA-256 digest"),
            Self::DuplicateTargetKey { key } => write!(
                formatter,
                "native physical target key {:?} is duplicated",
                key.as_str()
            ),
            Self::ConflictingTargetRole { key } => write!(
                formatter,
                "native physical target key {:?} has conflicting roles",
                key.as_str()
            ),
            Self::MissingTargetBinding { key } => write!(
                formatter,
                "native physical target key {:?} has no binding",
                key.as_str()
            ),
            Self::UnexpectedTargetBinding { key } => write!(
                formatter,
                "native physical target key {:?} is not referenced by the operation",
                key.as_str()
            ),
            Self::UnsortedTargetBindings => {
                formatter.write_str("native physical target bindings must be sorted by key")
            }
        }
    }
}

impl Error for PluginNativeTargetBindingErrorV2 {}

pub fn required_plugin_native_physical_targets(
    steps: &[PluginApplyStepV2],
) -> Result<
    BTreeMap<PhysicalTargetKeyV2, PluginNativePhysicalTargetRoleV2>,
    PluginNativeTargetBindingErrorV2,
> {
    let mut targets = BTreeMap::new();
    for step in steps {
        match &step.registration_target {
            AgentNativePluginRegistrationTargetV2::ManagedProfile { profile_root_key }
            | AgentNativePluginRegistrationTargetV2::User { profile_root_key } => {
                insert_role(
                    &mut targets,
                    profile_root_key,
                    PluginNativePhysicalTargetRoleV2::ProfileRoot,
                )?;
            }
            AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key,
                workspace_root_key,
            } => {
                insert_role(
                    &mut targets,
                    profile_root_key,
                    PluginNativePhysicalTargetRoleV2::ProfileRoot,
                )?;
                insert_role(
                    &mut targets,
                    workspace_root_key,
                    PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
                )?;
            }
        }
    }
    Ok(targets)
}

pub fn validate_plugin_native_physical_target_bindings(
    steps: &[PluginApplyStepV2],
    bindings: &[PluginNativePhysicalTargetBindingV2],
) -> Result<(), PluginNativeTargetBindingErrorV2> {
    let required = required_plugin_native_physical_targets(steps)?;
    let mut previous = None::<&PhysicalTargetKeyV2>;
    for binding in bindings {
        if previous.is_some_and(|key| key >= &binding.key) {
            if previous == Some(&binding.key) {
                return Err(PluginNativeTargetBindingErrorV2::DuplicateTargetKey {
                    key: binding.key.clone(),
                });
            }
            return Err(PluginNativeTargetBindingErrorV2::UnsortedTargetBindings);
        }
        let Some(role) = required.get(&binding.key) else {
            return Err(PluginNativeTargetBindingErrorV2::UnexpectedTargetBinding {
                key: binding.key.clone(),
            });
        };
        if role != &binding.role {
            return Err(PluginNativeTargetBindingErrorV2::ConflictingTargetRole {
                key: binding.key.clone(),
            });
        }
        previous = Some(&binding.key);
    }
    if bindings.len() != required.len() {
        let bound = bindings
            .iter()
            .map(|binding| &binding.key)
            .collect::<std::collections::BTreeSet<_>>();
        let key = required
            .keys()
            .find(|key| !bound.contains(key))
            .expect("a shorter exact-key binding set must omit a required key")
            .clone();
        return Err(PluginNativeTargetBindingErrorV2::MissingTargetBinding { key });
    }
    Ok(())
}

pub trait PluginNativeApplyAuthorityStore: Send + Sync {
    fn validate_plugin_native_target_bindings<'a>(
        &'a self,
        operation_id: &'a OperationIdV1,
        bindings: &'a [PluginNativePhysicalTargetBindingV2],
    ) -> DomainStoreFuture<'a, ()>;

    fn rebuild_plugin_native_target_bindings(&self) -> DomainStoreFuture<'_, usize>;
}

fn insert_role(
    targets: &mut BTreeMap<PhysicalTargetKeyV2, PluginNativePhysicalTargetRoleV2>,
    key: &PhysicalTargetKeyV2,
    role: PluginNativePhysicalTargetRoleV2,
) -> Result<(), PluginNativeTargetBindingErrorV2> {
    if let Some(existing) = targets.insert(key.clone(), role) {
        if existing != role {
            return Err(PluginNativeTargetBindingErrorV2::ConflictingTargetRole {
                key: key.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
        AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
        AgentNativePluginNameV2, AgentNativePluginRegistrationTargetV2,
        AgentNativePluginSelectorV2, PluginVersionV2,
    };

    fn digest(fill: char) -> PluginNativePhysicalTargetDigestV2 {
        PluginNativePhysicalTargetDigestV2::new(format!("sha256:{}", fill.to_string().repeat(64)))
            .unwrap()
    }

    fn workspace_step() -> PluginApplyStepV2 {
        let selector = AgentNativePluginSelectorV2 {
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        };
        PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("dure.beads.claude").unwrap(),
            adapter: AgentAdapterIdV2::new("claude").unwrap(),
            executable: AgentNativePluginExecutableV2::Claude,
            cli_version: PluginVersionV2::new("1.0.0").unwrap(),
            selector: selector.clone(),
            registration_target: AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key: PhysicalTargetKeyV2::new("profile").unwrap(),
                workspace_root_key: PhysicalTargetKeyV2::new("workspace").unwrap(),
            },
            command: AgentNativePluginCliCommandV2::InstallPlugin {
                selector,
                scope: AgentInstallScopeV2::Project,
                output: AgentNativePluginCliOutputV2::Json,
            },
        }
    }

    fn binding(
        key: &str,
        role: PluginNativePhysicalTargetRoleV2,
        fill: char,
    ) -> PluginNativePhysicalTargetBindingV2 {
        PluginNativePhysicalTargetBindingV2 {
            key: PhysicalTargetKeyV2::new(key).unwrap(),
            role,
            canonical_path_identity: digest(fill),
            filesystem_object_identity: digest(char::from_u32(fill as u32 + 1).unwrap()),
            authority_generation_identity: digest('0'),
            authority_identity: digest(char::from_u32(fill as u32 + 2).unwrap()),
            binding_identity: digest('1'),
        }
    }

    #[test]
    fn digests_are_strict_lowercase_sha256_values() {
        let valid = format!("sha256:{}", "a".repeat(64));
        assert!(PluginNativePhysicalTargetDigestV2::new(&valid).is_ok());
        assert!(PluginNativePhysicalTargetDigestV2::new(valid.to_ascii_uppercase()).is_err());
        assert!(PluginNativePhysicalTargetDigestV2::new("sha256:abc").is_err());
    }

    #[test]
    fn binding_snapshot_requires_the_exact_sorted_key_and_role_set() {
        let steps = [workspace_step()];
        let exact = vec![
            binding(
                "profile",
                PluginNativePhysicalTargetRoleV2::ProfileRoot,
                'a',
            ),
            binding(
                "workspace",
                PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
                'd',
            ),
        ];
        validate_plugin_native_physical_target_bindings(&steps, &exact).unwrap();

        let mut reversed = exact.clone();
        reversed.reverse();
        assert_eq!(
            validate_plugin_native_physical_target_bindings(&steps, &reversed),
            Err(PluginNativeTargetBindingErrorV2::UnsortedTargetBindings)
        );
        assert!(matches!(
            validate_plugin_native_physical_target_bindings(&steps, &exact[..1]),
            Err(PluginNativeTargetBindingErrorV2::MissingTargetBinding { .. })
        ));
        let mut wrong_role = exact.clone();
        wrong_role[1].role = PluginNativePhysicalTargetRoleV2::ProfileRoot;
        assert!(matches!(
            validate_plugin_native_physical_target_bindings(&steps, &wrong_role),
            Err(PluginNativeTargetBindingErrorV2::ConflictingTargetRole { .. })
        ));
    }

    #[test]
    fn portable_binding_snapshot_contains_only_opaque_identities() {
        let encoded = serde_json::to_string(&binding(
            "profile",
            PluginNativePhysicalTargetRoleV2::ProfileRoot,
            'a',
        ))
        .unwrap();
        assert!(!encoded.contains("/Users/"));
        assert!(!encoded.contains("workspace_path"));
        assert!(encoded.contains("sha256:"));
    }
}
