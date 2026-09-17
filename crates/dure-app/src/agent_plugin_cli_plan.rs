use std::{collections::BTreeSet, error::Error, fmt};

use crate::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentNativePluginCliCapabilityV2,
    AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2, AgentNativePluginCliPlanRequestV2,
    AgentNativePluginCliPlanV2, AgentNativePluginCliProbeV2, AgentNativePluginExecutableV2,
    AgentNativePluginRegistrationTargetV2,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentNativePluginCliPlanErrorV2 {
    UnsupportedAdapter {
        adapter: AgentAdapterIdV2,
    },
    MissingProbe {
        adapter: AgentAdapterIdV2,
    },
    DuplicateProbe {
        adapter: AgentAdapterIdV2,
    },
    ExecutableMismatch {
        adapter: AgentAdapterIdV2,
        executable: AgentNativePluginExecutableV2,
    },
    DuplicateCapability {
        adapter: AgentAdapterIdV2,
        capability: AgentNativePluginCliCapabilityV2,
    },
    MissingCapability {
        adapter: AgentAdapterIdV2,
        capability: AgentNativePluginCliCapabilityV2,
    },
    UnsupportedScope {
        adapter: AgentAdapterIdV2,
        scope: AgentInstallScopeV2,
    },
    AmbiguousRegistrationTarget {
        adapter: AgentAdapterIdV2,
        scope: AgentInstallScopeV2,
    },
}

impl fmt::Display for AgentNativePluginCliPlanErrorV2 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedAdapter { adapter } => {
                write!(
                    formatter,
                    "unsupported native plugin adapter {}",
                    adapter.as_str()
                )
            }
            Self::MissingProbe { adapter } => {
                write!(
                    formatter,
                    "native plugin adapter {} has no CLI probe",
                    adapter.as_str()
                )
            }
            Self::DuplicateProbe { adapter } => write!(
                formatter,
                "native plugin adapter {} has more than one CLI probe",
                adapter.as_str()
            ),
            Self::ExecutableMismatch {
                adapter,
                executable,
            } => write!(
                formatter,
                "native plugin adapter {} does not match executable {}",
                adapter.as_str(),
                executable.as_str()
            ),
            Self::DuplicateCapability {
                adapter,
                capability,
            } => write!(
                formatter,
                "native plugin adapter {} reports duplicate capability {capability:?}",
                adapter.as_str()
            ),
            Self::MissingCapability {
                adapter,
                capability,
            } => write!(
                formatter,
                "native plugin adapter {} is missing capability {capability:?}",
                adapter.as_str()
            ),
            Self::UnsupportedScope { adapter, scope } => write!(
                formatter,
                "native plugin adapter {} does not support scope {scope:?}",
                adapter.as_str()
            ),
            Self::AmbiguousRegistrationTarget { adapter, scope } => write!(
                formatter,
                "native plugin adapter {} has an ambiguous registration target for scope {scope:?}",
                adapter.as_str()
            ),
        }
    }
}

impl Error for AgentNativePluginCliPlanErrorV2 {}

pub fn plan_agent_native_plugin_cli(
    request: &AgentNativePluginCliPlanRequestV2,
    probes: &[AgentNativePluginCliProbeV2],
) -> Result<AgentNativePluginCliPlanV2, AgentNativePluginCliPlanErrorV2> {
    let expected_executable = match request.adapter.as_str() {
        "codex" => AgentNativePluginExecutableV2::Codex,
        "claude" => AgentNativePluginExecutableV2::Claude,
        _ => {
            return Err(AgentNativePluginCliPlanErrorV2::UnsupportedAdapter {
                adapter: request.adapter.clone(),
            });
        }
    };
    let matching_probes = probes
        .iter()
        .filter(|probe| probe.adapter == request.adapter)
        .collect::<Vec<_>>();
    let probe = match matching_probes.as_slice() {
        [] => {
            return Err(AgentNativePluginCliPlanErrorV2::MissingProbe {
                adapter: request.adapter.clone(),
            });
        }
        [probe] => *probe,
        _ => {
            return Err(AgentNativePluginCliPlanErrorV2::DuplicateProbe {
                adapter: request.adapter.clone(),
            });
        }
    };
    if probe.executable != expected_executable {
        return Err(AgentNativePluginCliPlanErrorV2::ExecutableMismatch {
            adapter: request.adapter.clone(),
            executable: probe.executable.clone(),
        });
    }

    let mut capabilities = BTreeSet::new();
    for capability in &probe.capabilities {
        if !capabilities.insert(capability.clone()) {
            return Err(AgentNativePluginCliPlanErrorV2::DuplicateCapability {
                adapter: request.adapter.clone(),
                capability: capability.clone(),
            });
        }
    }
    for capability in [
        AgentNativePluginCliCapabilityV2::MarketplaceListJson,
        AgentNativePluginCliCapabilityV2::MarketplaceAdd,
        AgentNativePluginCliCapabilityV2::MarketplaceRemove,
        AgentNativePluginCliCapabilityV2::PluginListJson,
        AgentNativePluginCliCapabilityV2::PluginInstall,
        AgentNativePluginCliCapabilityV2::PluginRemove,
    ] {
        require_capability(request, &capabilities, capability)?;
    }

    let mutation_output = match probe.executable {
        AgentNativePluginExecutableV2::Codex => {
            require_capability(
                request,
                &capabilities,
                AgentNativePluginCliCapabilityV2::JsonMutationOutput,
            )?;
            validate_codex_target(request)?;
            AgentNativePluginCliOutputV2::Json
        }
        AgentNativePluginExecutableV2::Claude => {
            validate_claude_target(request, &capabilities)?;
            if capabilities.contains(&AgentNativePluginCliCapabilityV2::JsonMutationOutput) {
                AgentNativePluginCliOutputV2::Json
            } else {
                AgentNativePluginCliOutputV2::HumanText
            }
        }
    };

    Ok(AgentNativePluginCliPlanV2 {
        adapter: request.adapter.clone(),
        executable: probe.executable.clone(),
        cli_version: probe.version.clone(),
        selector: request.selector.clone(),
        registration_target: request.registration_target.clone(),
        commands: vec![
            AgentNativePluginCliCommandV2::ListMarketplaces {
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::AddMarketplace {
                source: request.source.clone(),
                scope: request.scope.clone(),
                output: mutation_output.clone(),
            },
            AgentNativePluginCliCommandV2::ListPlugins {
                marketplace: request.selector.marketplace.clone(),
                include_available: true,
                output: AgentNativePluginCliOutputV2::Json,
            },
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector: request.selector.clone(),
                scope: request.scope.clone(),
                output: mutation_output.clone(),
            },
            AgentNativePluginCliCommandV2::RemovePlugin {
                selector: request.selector.clone(),
                scope: request.scope.clone(),
                preserve_data: true,
                output: mutation_output.clone(),
            },
            AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace: request.selector.marketplace.clone(),
                scope: request.scope.clone(),
                output: mutation_output,
            },
        ],
    })
}

fn require_capability(
    request: &AgentNativePluginCliPlanRequestV2,
    capabilities: &BTreeSet<AgentNativePluginCliCapabilityV2>,
    capability: AgentNativePluginCliCapabilityV2,
) -> Result<(), AgentNativePluginCliPlanErrorV2> {
    if capabilities.contains(&capability) {
        return Ok(());
    }
    Err(AgentNativePluginCliPlanErrorV2::MissingCapability {
        adapter: request.adapter.clone(),
        capability,
    })
}

fn validate_codex_target(
    request: &AgentNativePluginCliPlanRequestV2,
) -> Result<(), AgentNativePluginCliPlanErrorV2> {
    if request.scope != AgentInstallScopeV2::Managed {
        return Err(AgentNativePluginCliPlanErrorV2::UnsupportedScope {
            adapter: request.adapter.clone(),
            scope: request.scope.clone(),
        });
    }
    if matches!(
        request.registration_target,
        AgentNativePluginRegistrationTargetV2::ManagedProfile { .. }
    ) {
        return Ok(());
    }
    Err(
        AgentNativePluginCliPlanErrorV2::AmbiguousRegistrationTarget {
            adapter: request.adapter.clone(),
            scope: request.scope.clone(),
        },
    )
}

fn validate_claude_target(
    request: &AgentNativePluginCliPlanRequestV2,
    capabilities: &BTreeSet<AgentNativePluginCliCapabilityV2>,
) -> Result<(), AgentNativePluginCliPlanErrorV2> {
    let required = match request.scope {
        AgentInstallScopeV2::User => AgentNativePluginCliCapabilityV2::UserScope,
        AgentInstallScopeV2::Project => AgentNativePluginCliCapabilityV2::ProjectScope,
        AgentInstallScopeV2::Local => AgentNativePluginCliCapabilityV2::LocalScope,
        AgentInstallScopeV2::Managed => {
            return Err(AgentNativePluginCliPlanErrorV2::UnsupportedScope {
                adapter: request.adapter.clone(),
                scope: request.scope.clone(),
            });
        }
    };
    require_capability(request, capabilities, required)?;
    let target_matches = matches!(
        (&request.scope, &request.registration_target),
        (
            AgentInstallScopeV2::User,
            AgentNativePluginRegistrationTargetV2::User { .. }
        ) | (
            AgentInstallScopeV2::Project | AgentInstallScopeV2::Local,
            AgentNativePluginRegistrationTargetV2::Workspace { .. }
        )
    );
    if target_matches {
        return Ok(());
    }
    Err(
        AgentNativePluginCliPlanErrorV2::AmbiguousRegistrationTarget {
            adapter: request.adapter.clone(),
            scope: request.scope.clone(),
        },
    )
}
