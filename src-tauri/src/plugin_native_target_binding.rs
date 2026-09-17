use std::collections::BTreeMap;
#[cfg(unix)]
use std::collections::BTreeSet;
use std::error::Error;
#[cfg(unix)]
use std::ffi::OsString;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use dure_app::{
    required_plugin_native_physical_targets, AgentNativePluginCliInvocationV2, PhysicalTargetKeyV2,
    PluginApplyStepV2, PluginNativePhysicalTargetBindingV2, PluginNativePhysicalTargetDigestV2,
    PluginNativePhysicalTargetRoleV2,
};
#[cfg(unix)]
use dure_app::{
    AgentNativePluginCliArgumentV2, AgentNativePluginCliEnvironmentV2,
    AgentNativePluginCliWorkingDirectoryV2, AgentNativePluginExecutableV2,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

#[cfg(unix)]
use crate::plugin_native_cli::{
    execute_prepared_plugin_native_cli_command_with_directory_anchors,
    rewrite_prepared_plugin_native_cli_route,
};
#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
use crate::plugin_native_cli::execute_prepared_plugin_native_cli_command_with_pre_exec_barrier;
use crate::plugin_native_cli::{
    prepare_plugin_native_cli_command, PluginNativeCliExecution, PluginNativeCliHostContext,
    PluginNativeCliPrepareError, PreparedPluginNativeCliCommand,
};

#[cfg(unix)]
use hebbian_bounded_process::{UnixBoundCommandFailure, UnixDirectoryAnchor};
#[cfg(unix)]
use std::os::fd::AsFd;

type HmacSha256 = Hmac<Sha256>;
const AUTHORITY_KEY_FILE: &str = "plugin-native-target-authority-v1.key";
const AUTHORITY_LOCK_FILE: &str = "plugin-native-target-authority-v1.lock";

#[derive(Clone)]
pub struct PluginNativeTargetBindingAuthority {
    secret: [u8; 32],
}

impl PluginNativeTargetBindingAuthority {
    pub fn open_or_create(control_root: &Path) -> Result<Self, PluginNativeTargetBindingHostError> {
        open_or_create_authority(control_root)
    }

    #[cfg(test)]
    pub(crate) fn for_test(secret: [u8; 32]) -> Self {
        Self { secret }
    }
}

pub struct PluginNativeTargetLeases {
    authority: PluginNativeTargetBindingAuthority,
    bindings: Vec<PluginNativePhysicalTargetBindingV2>,
    targets: BTreeMap<PhysicalTargetKeyV2, LeasedPhysicalTarget>,
}

pub(crate) enum PluginNativeTargetExecutionLeaseDisposition<'a> {
    Acquired(PluginNativeTargetExecutionLease<'a>),
    Occupied,
}

pub(crate) struct PluginNativeTargetExecutionLease<'a> {
    directories: Vec<&'a File>,
    bindings: &'a [PluginNativePhysicalTargetBindingV2],
}

impl PluginNativeTargetExecutionLease<'_> {
    pub(crate) fn validate_bindings(
        &self,
        bindings: Option<&[PluginNativePhysicalTargetBindingV2]>,
    ) -> Result<(), PluginNativeTargetBindingHostError> {
        if bindings == Some(self.bindings) {
            Ok(())
        } else {
            Err(PluginNativeTargetBindingHostError::ExecutionLeaseBindingMismatch)
        }
    }
}

impl Drop for PluginNativeTargetExecutionLease<'_> {
    fn drop(&mut self) {
        for directory in self.directories.iter().rev() {
            let _ = fs2::FileExt::unlock(*directory);
        }
    }
}

struct LeasedPhysicalTarget {
    canonical_path: PathBuf,
    directory: File,
    binding: PluginNativePhysicalTargetBindingV2,
}

pub(crate) struct PreparedBoundPluginNativeCliCommand<'a> {
    prepared: PreparedPluginNativeCliCommand,
    #[cfg(target_os = "macos")]
    _executable_anchor: File,
    #[cfg(unix)]
    directory_anchors: Vec<UnixDirectoryAnchor<'a>>,
    #[cfg(unix)]
    current_directory_anchor: Option<usize>,
    #[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
    descriptor_route_generation: &'static str,
    #[cfg(not(unix))]
    _lifetime: std::marker::PhantomData<&'a ()>,
}

#[cfg(unix)]
enum UnixPluginNativeDescriptorRoute {
    Codex {
        environment_name: OsString,
        profile_anchor: usize,
    },
    Claude {
        environment_name: OsString,
        profile_key: PhysicalTargetKeyV2,
        workspace_anchor: Option<usize>,
    },
}

impl PreparedBoundPluginNativeCliCommand<'_> {
    #[cfg(test)]
    pub(crate) fn command(&self) -> &hebbian_bounded_process::CommandSpec {
        self.prepared.command()
    }

    #[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
    pub(crate) fn descriptor_route_generation(&self) -> &'static str {
        self.descriptor_route_generation
    }
}

#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
impl UnixPluginNativeDescriptorRoute {
    fn generation(&self, package_root_lease: bool) -> &'static str {
        #[cfg(target_os = "macos")]
        {
            if package_root_lease {
                return match self {
                    Self::Codex { .. } => {
                        "macos_codex_volume_file_id_exec_fchdir_relative_home_package_sealed_lexical_anchor_v3"
                    }
                    Self::Claude {
                        workspace_anchor: None,
                        ..
                    } => "macos_claude_volume_file_id_exec_home_package_sealed_lexical_anchor_v3",
                    Self::Claude {
                        workspace_anchor: Some(_),
                        ..
                    } => {
                        "macos_claude_volume_file_id_exec_home_workspace_fchdir_package_sealed_lexical_anchor_v3"
                    }
                };
            }
            return match self {
                Self::Codex { .. } => {
                    "macos_codex_volume_file_id_exec_fchdir_relative_home_v2"
                }
                Self::Claude {
                    workspace_anchor: None,
                    ..
                } => "macos_claude_volume_file_id_exec_home_v2",
                Self::Claude {
                    workspace_anchor: Some(_),
                    ..
                } => "macos_claude_volume_file_id_exec_home_workspace_fchdir_v2",
            };
        }
        #[cfg(target_os = "linux")]
        {
            if package_root_lease {
                return match self {
                    Self::Codex { .. } => "linux_codex_fchdir_relative_home_package_procfd_v2",
                    Self::Claude {
                        workspace_anchor: None,
                        ..
                    } => "linux_claude_procfd_home_package_procfd_v2",
                    Self::Claude {
                        workspace_anchor: Some(_),
                        ..
                    } => "linux_claude_procfd_home_workspace_fchdir_package_procfd_v2",
                };
            }
            return match self {
                Self::Codex { .. } => "linux_codex_fchdir_relative_home_v1",
                Self::Claude {
                    workspace_anchor: None,
                    ..
                } => "linux_claude_procfd_home_v1",
                Self::Claude {
                    workspace_anchor: Some(_),
                    ..
                } => "linux_claude_procfd_home_workspace_fchdir_v1",
            };
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            "unsupported_platform"
        }
    }
}

impl PluginNativeTargetLeases {
    pub fn bindings(&self) -> &[PluginNativePhysicalTargetBindingV2] {
        &self.bindings
    }

    pub fn validate(
        &self,
        context: &PluginNativeCliHostContext<'_>,
    ) -> Result<(), PluginNativeTargetBindingHostError> {
        for target in self.targets.values() {
            validate_retained_directory(target)?;
            let fresh = resolve_target(
                context,
                &self.authority,
                &target.binding.key,
                target.binding.role,
            )?;
            if fresh.binding != target.binding || fresh.canonical_path != target.canonical_path {
                return Err(PluginNativeTargetBindingHostError::BindingChanged {
                    key: target.binding.key.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn canonical_path(
        &self,
        context: &PluginNativeCliHostContext<'_>,
        key: &PhysicalTargetKeyV2,
    ) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
        self.validate(context)?;
        self.targets
            .get(key)
            .map(|target| target.canonical_path.clone())
            .ok_or_else(|| PluginNativeTargetBindingHostError::MissingTarget { key: key.clone() })
    }

    pub(crate) fn directory(
        &self,
        context: &PluginNativeCliHostContext<'_>,
        key: &PhysicalTargetKeyV2,
    ) -> Result<&File, PluginNativeTargetBindingHostError> {
        self.validate(context)?;
        self.targets
            .get(key)
            .map(|target| &target.directory)
            .ok_or_else(|| PluginNativeTargetBindingHostError::MissingTarget { key: key.clone() })
    }

    pub(crate) fn try_acquire_execution_lease(
        &self,
    ) -> Result<PluginNativeTargetExecutionLeaseDisposition<'_>, PluginNativeTargetBindingHostError>
    {
        let mut directories = Vec::with_capacity(self.targets.len());
        for target in self.targets.values() {
            match fs2::FileExt::try_lock_exclusive(&target.directory) {
                Ok(()) => directories.push(&target.directory),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    for directory in directories.iter().rev() {
                        let _ = fs2::FileExt::unlock(*directory);
                    }
                    return Ok(PluginNativeTargetExecutionLeaseDisposition::Occupied);
                }
                Err(_) => {
                    for directory in directories.iter().rev() {
                        let _ = fs2::FileExt::unlock(*directory);
                    }
                    return Err(PluginNativeTargetBindingHostError::ExecutionLease);
                }
            }
        }
        Ok(PluginNativeTargetExecutionLeaseDisposition::Acquired(
            PluginNativeTargetExecutionLease {
                directories,
                bindings: &self.bindings,
            },
        ))
    }

    fn canonical_targets(&self) -> BTreeMap<PhysicalTargetKeyV2, PathBuf> {
        self.targets
            .iter()
            .map(|(key, target)| (key.clone(), target.canonical_path.clone()))
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeTargetBindingHostError {
    MissingTarget { key: PhysicalTargetKeyV2 },
    TargetUnavailable { key: PhysicalTargetKeyV2 },
    TargetIsSymlink { key: PhysicalTargetKeyV2 },
    TargetIsNotDirectory { key: PhysicalTargetKeyV2 },
    TargetOwnerChanged { key: PhysicalTargetKeyV2 },
    TargetPermissionsUnsafe { key: PhysicalTargetKeyV2 },
    TargetAncestorUnsafe { key: PhysicalTargetKeyV2 },
    TargetIdentityUnstable { key: PhysicalTargetKeyV2 },
    BindingChanged { key: PhysicalTargetKeyV2 },
    TargetChangedBeforeExecution,
    ConflictingTargetRoles,
    DescriptorRouteUnavailable,
    DescriptorRouteUnsupported,
    AuthorityStore,
    ExecutionLease,
    ExecutionLeaseBindingMismatch,
    UnsupportedPlatform,
    Digest,
    Preparation(PluginNativeCliPrepareError),
}

impl fmt::Display for PluginNativeTargetBindingHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::MissingTarget { .. } => "native physical target is missing from the host map",
            Self::TargetUnavailable { .. } => "native physical target is unavailable",
            Self::TargetIsSymlink { .. } => "native physical target is a symbolic link",
            Self::TargetIsNotDirectory { .. } => "native physical target is not a directory",
            Self::TargetOwnerChanged { .. } => {
                "native physical target is not owned by the effective user"
            }
            Self::TargetPermissionsUnsafe { .. } => {
                "native physical target is writable by another user or group"
            }
            Self::TargetAncestorUnsafe { .. } => {
                "native physical target has an untrusted ancestor directory"
            }
            Self::TargetIdentityUnstable { .. } => {
                "native physical target changed while it was being validated"
            }
            Self::BindingChanged { .. } => {
                "native physical target differs from its retained binding"
            }
            Self::TargetChangedBeforeExecution => {
                "native physical target changed before provider execution"
            }
            Self::ConflictingTargetRoles => {
                "native physical target keys have conflicting profile/workspace roles"
            }
            Self::DescriptorRouteUnavailable => {
                "native physical target descriptor route is unavailable"
            }
            Self::DescriptorRouteUnsupported => {
                "native physical target descriptor route is unsupported"
            }
            Self::AuthorityStore => "native physical target authority store is unavailable",
            Self::ExecutionLease => "native physical target execution lease is unavailable",
            Self::ExecutionLeaseBindingMismatch => {
                "native physical target execution lease does not match the durable binding set"
            }
            Self::UnsupportedPlatform => {
                "native physical target identity is unsupported on this platform"
            }
            Self::Digest => "native physical target identity could not be encoded",
            Self::Preparation(_) => "native plugin command preparation failed",
        };
        formatter.write_str(message)
    }
}

impl Error for PluginNativeTargetBindingHostError {}

pub fn resolve_plugin_native_target_leases(
    steps: &[PluginApplyStepV2],
    context: &PluginNativeCliHostContext<'_>,
    authority: &PluginNativeTargetBindingAuthority,
) -> Result<PluginNativeTargetLeases, PluginNativeTargetBindingHostError> {
    let required = required_plugin_native_physical_targets(steps)
        .map_err(|_| PluginNativeTargetBindingHostError::ConflictingTargetRoles)?;
    let mut targets = BTreeMap::new();
    for (key, role) in required {
        targets.insert(key.clone(), resolve_target(context, authority, &key, role)?);
    }
    let bindings = targets
        .values()
        .map(|target| target.binding.clone())
        .collect();
    Ok(PluginNativeTargetLeases {
        authority: authority.clone(),
        bindings,
        targets,
    })
}

pub(crate) fn prepare_bound_plugin_native_cli_command<'a>(
    invocation: &AgentNativePluginCliInvocationV2,
    context: &PluginNativeCliHostContext<'_>,
    leases: &'a PluginNativeTargetLeases,
) -> Result<PreparedBoundPluginNativeCliCommand<'a>, PluginNativeTargetBindingHostError> {
    prepare_bound_plugin_native_cli_command_inner(invocation, context, leases, None)
}

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub(crate) fn prepare_bound_plugin_native_cli_command_with_package_root_lease<'a>(
    invocation: &AgentNativePluginCliInvocationV2,
    context: &PluginNativeCliHostContext<'_>,
    leases: &'a PluginNativeTargetLeases,
    package_root_lease: &'a File,
) -> Result<PreparedBoundPluginNativeCliCommand<'a>, PluginNativeTargetBindingHostError> {
    prepare_bound_plugin_native_cli_command_inner(
        invocation,
        context,
        leases,
        Some(package_root_lease),
    )
}

fn prepare_bound_plugin_native_cli_command_inner<'a>(
    invocation: &AgentNativePluginCliInvocationV2,
    context: &PluginNativeCliHostContext<'_>,
    leases: &'a PluginNativeTargetLeases,
    package_root_lease: Option<&'a File>,
) -> Result<PreparedBoundPluginNativeCliCommand<'a>, PluginNativeTargetBindingHostError> {
    leases.validate(context)?;
    let targets = leases.canonical_targets();
    let prepared = prepare_plugin_native_cli_command(
        invocation,
        &PluginNativeCliHostContext {
            executable: context.executable.clone(),
            executable_path: context.executable_path,
            executable_version: context.executable_version,
            package_root: context.package_root,
            neutral_working_directory: context.neutral_working_directory,
            physical_targets: &targets,
        },
    )
    .map_err(PluginNativeTargetBindingHostError::Preparation)?;
    prepare_descriptor_bound_command(
        invocation,
        leases,
        prepared,
        context.package_root,
        package_root_lease,
    )
}

pub(crate) fn execute_bound_plugin_native_cli_command(
    prepared: &PreparedBoundPluginNativeCliCommand<'_>,
) -> Result<PluginNativeCliExecution, PluginNativeTargetBindingHostError> {
    #[cfg(unix)]
    {
        execute_prepared_plugin_native_cli_command_with_directory_anchors(
            &prepared.prepared,
            &prepared.directory_anchors,
            prepared.current_directory_anchor,
        )
        .map_err(|error| match error {
            UnixBoundCommandFailure::DirectoryAnchorUnavailable => {
                PluginNativeTargetBindingHostError::DescriptorRouteUnavailable
            }
            UnixBoundCommandFailure::DirectoryAnchorChanged => {
                PluginNativeTargetBindingHostError::TargetChangedBeforeExecution
            }
            UnixBoundCommandFailure::PreExecBarrierUnavailable
            | UnixBoundCommandFailure::PreExecBarrierCancelled => {
                PluginNativeTargetBindingHostError::DescriptorRouteUnavailable
            }
            UnixBoundCommandFailure::Command(_) => {
                unreachable!("ordinary command failures are classified as execution outcomes")
            }
        })
    }
    #[cfg(not(unix))]
    {
        let _ = prepared;
        Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
    }
}

#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
pub(crate) fn execute_bound_plugin_native_cli_command_with_pre_exec_barrier(
    prepared: &PreparedBoundPluginNativeCliCommand<'_>,
    barrier: hebbian_bounded_process::UnixPreExecBarrier,
) -> Result<PluginNativeCliExecution, UnixBoundCommandFailure> {
    execute_prepared_plugin_native_cli_command_with_pre_exec_barrier(
        &prepared.prepared,
        &prepared.directory_anchors,
        prepared.current_directory_anchor,
        barrier,
    )
}

#[cfg(unix)]
fn prepare_descriptor_bound_command<'a>(
    invocation: &AgentNativePluginCliInvocationV2,
    leases: &'a PluginNativeTargetLeases,
    prepared: PreparedPluginNativeCliCommand,
    package_root: &Path,
    package_root_lease: Option<&'a File>,
) -> Result<PreparedBoundPluginNativeCliCommand<'a>, PluginNativeTargetBindingHostError> {
    let mut environment_targets = Vec::<(OsString, PhysicalTargetKeyV2)>::new();
    let mut referenced_keys = BTreeSet::new();
    for environment in invocation.environment() {
        let (name, key) = match environment {
            AgentNativePluginCliEnvironmentV2::CodexHome { profile_root_key } => {
                (OsString::from("CODEX_HOME"), profile_root_key)
            }
            AgentNativePluginCliEnvironmentV2::ClaudeHome { profile_root_key } => {
                (OsString::from("HOME"), profile_root_key)
            }
        };
        referenced_keys.insert(key.clone());
        environment_targets.push((name, key.clone()));
    }
    let workspace_key = match invocation.working_directory() {
        AgentNativePluginCliWorkingDirectoryV2::HostNeutral => None,
        AgentNativePluginCliWorkingDirectoryV2::Workspace { workspace_root_key } => {
            referenced_keys.insert(workspace_root_key.clone());
            Some(workspace_root_key.clone())
        }
    };
    let mut directory_anchors =
        Vec::with_capacity(referenced_keys.len() + usize::from(package_root_lease.is_some()));
    let mut anchor_indices = BTreeMap::new();
    for key in referenced_keys {
        let target = leases.targets.get(&key).ok_or_else(|| {
            PluginNativeTargetBindingHostError::MissingTarget { key: key.clone() }
        })?;
        validate_retained_directory(target)?;
        let anchor = UnixDirectoryAnchor::new(target.directory.as_fd(), &target.canonical_path)
            .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
        anchor_indices.insert(key, directory_anchors.len());
        directory_anchors.push(anchor);
    }
    let package_anchor_index = if let Some(package_root_lease) = package_root_lease {
        validate_retained_package_root(package_root, package_root_lease)?;
        let index = directory_anchors.len();
        directory_anchors.push(
            UnixDirectoryAnchor::new(package_root_lease.as_fd(), package_root)
                .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?,
        );
        Some(index)
    } else {
        None
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let original_current_directory = prepared
        .command()
        .current_directory()
        .map(Path::to_path_buf);
    let route = unix_plugin_native_descriptor_route(
        invocation,
        &environment_targets,
        workspace_key.as_ref(),
        &anchor_indices,
    )?;
    #[cfg(all(test, feature = "provider-conformance-test-support"))]
    let descriptor_route_generation = route.generation(package_anchor_index.is_some());
    #[cfg(target_os = "macos")]
    let (executable_anchor, executable_route) =
        prepare_macos_executable_route(prepared.command().program())?;
    let mut environment_overrides = BTreeMap::new();
    let mut argument_overrides = BTreeMap::new();
    if let Some(package_anchor_index) = package_anchor_index {
        if invocation.arguments().len() != prepared.command().arguments().len() {
            return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
        }
        let package_route = stable_package_root_route(
            package_root,
            package_root_lease
                .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?,
            directory_anchors
                .get(package_anchor_index)
                .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?,
        )?;
        for (index, argument) in invocation.arguments().iter().enumerate() {
            if let AgentNativePluginCliArgumentV2::PackageResource(resource) = argument {
                let relative = resource.as_str().strip_prefix("./").ok_or(
                    PluginNativeTargetBindingHostError::DescriptorRouteUnavailable,
                )?;
                argument_overrides.insert(index, package_route.join(relative).into_os_string());
            }
        }
    }

    #[cfg(target_os = "linux")]
    let (current_directory, current_directory_anchor) = match route {
        UnixPluginNativeDescriptorRoute::Codex {
            environment_name,
            profile_anchor,
        } => {
            environment_overrides.insert(environment_name, OsString::from("."));
            (None, Some(profile_anchor))
        }
        UnixPluginNativeDescriptorRoute::Claude {
            environment_name,
            profile_key,
            workspace_anchor,
            ..
        } => {
            let path = directory_anchors
                .get(
                    *anchor_indices
                        .get(&profile_key)
                        .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?,
                )
                .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?
                .descriptor_path();
            validate_stable_directory_route(
                &path,
                leases
                    .targets
                    .get(&profile_key)
                    .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?,
            )?;
            environment_overrides.insert(environment_name, path.into_os_string());
            (
                if workspace_anchor.is_some() {
                    None
                } else {
                    original_current_directory
                },
                workspace_anchor,
            )
        }
    };

    #[cfg(target_os = "macos")]
    let (current_directory, current_directory_anchor) = match route {
        UnixPluginNativeDescriptorRoute::Codex {
            environment_name,
            profile_anchor,
        } => {
            environment_overrides.insert(environment_name, OsString::from("."));
            (None, Some(profile_anchor))
        }
        UnixPluginNativeDescriptorRoute::Claude {
            environment_name,
            profile_key,
            workspace_anchor,
            ..
        } => {
            let target = leases
                .targets
                .get(&profile_key)
                .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
            let path = macos_volume_file_id_route(target)?;
            validate_stable_directory_route(&path, target)?;
            environment_overrides.insert(environment_name, path.into_os_string());
            (
                if workspace_anchor.is_some() {
                    None
                } else {
                    original_current_directory
                },
                workspace_anchor,
            )
        }
    };

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let (current_directory, current_directory_anchor) = {
        let _ = (environment_targets, workspace_key, anchor_indices, route);
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported);
    };

    Ok(PreparedBoundPluginNativeCliCommand {
        prepared: rewrite_prepared_plugin_native_cli_route(
            prepared,
            {
                #[cfg(target_os = "macos")]
                {
                    Some(executable_route)
                }
                #[cfg(not(target_os = "macos"))]
                {
                    None
                }
            },
            current_directory,
            &environment_overrides,
            &argument_overrides,
        ),
        #[cfg(target_os = "macos")]
        _executable_anchor: executable_anchor,
        directory_anchors,
        current_directory_anchor,
        #[cfg(all(test, feature = "provider-conformance-test-support"))]
        descriptor_route_generation,
    })
}

#[cfg(unix)]
fn unix_plugin_native_descriptor_route(
    invocation: &AgentNativePluginCliInvocationV2,
    environment_targets: &[(OsString, PhysicalTargetKeyV2)],
    workspace_key: Option<&PhysicalTargetKeyV2>,
    anchor_indices: &BTreeMap<PhysicalTargetKeyV2, usize>,
) -> Result<UnixPluginNativeDescriptorRoute, PluginNativeTargetBindingHostError> {
    let [(environment_name, profile_key)] = environment_targets else {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported);
    };
    let profile_anchor = *anchor_indices
        .get(profile_key)
        .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    match invocation.executable() {
        AgentNativePluginExecutableV2::Codex => {
            if environment_name != "CODEX_HOME" || workspace_key.is_some() {
                return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported);
            }
            Ok(UnixPluginNativeDescriptorRoute::Codex {
                environment_name: environment_name.clone(),
                profile_anchor,
            })
        }
        AgentNativePluginExecutableV2::Claude => {
            if environment_name != "HOME" {
                return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported);
            }
            let workspace_anchor = workspace_key
                .map(|key| {
                    anchor_indices
                        .get(key)
                        .copied()
                        .ok_or(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)
                })
                .transpose()?;
            if workspace_anchor == Some(profile_anchor) {
                return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported);
            }
            Ok(UnixPluginNativeDescriptorRoute::Claude {
                environment_name: environment_name.clone(),
                profile_key: profile_key.clone(),
                workspace_anchor,
            })
        }
    }
}

#[cfg(not(unix))]
fn prepare_descriptor_bound_command<'a>(
    _invocation: &AgentNativePluginCliInvocationV2,
    _leases: &'a PluginNativeTargetLeases,
    _prepared: PreparedPluginNativeCliCommand,
    _package_root: &Path,
    _package_root_lease: Option<&'a File>,
) -> Result<PreparedBoundPluginNativeCliCommand<'a>, PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

#[cfg(unix)]
fn validate_retained_package_root(
    package_root: &Path,
    package_root_lease: &File,
) -> Result<(), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let lease_metadata = package_root_lease
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    let path_metadata = std::fs::symlink_metadata(package_root)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    if !lease_metadata.is_dir()
        || path_metadata.file_type().is_symlink()
        || !path_metadata.is_dir()
        || !same_filesystem_object(&lease_metadata, &path_metadata)
        || lease_metadata.uid() != unsafe { libc::geteuid() }
        || lease_metadata.permissions().mode() & 0o022 != 0
    {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn stable_package_root_route(
    _package_root: &Path,
    package_root_lease: &File,
    package_anchor: &UnixDirectoryAnchor<'_>,
) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    let route = package_anchor.descriptor_path();
    validate_file_directory_route(&route, package_root_lease)?;
    Ok(route)
}

#[cfg(target_os = "macos")]
fn stable_package_root_route(
    package_root: &Path,
    package_root_lease: &File,
    _package_anchor: &UnixDirectoryAnchor<'_>,
) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    let route = package_root.to_path_buf();
    validate_file_directory_route(&route, package_root_lease)?;
    Ok(route)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn stable_package_root_route(
    _package_root: &Path,
    _package_root_lease: &File,
    _package_anchor: &UnixDirectoryAnchor<'_>,
) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::DescriptorRouteUnsupported)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_file_directory_route(
    route: &Path,
    directory: &File,
) -> Result<(), PluginNativeTargetBindingHostError> {
    let route_metadata = std::fs::metadata(route)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    let directory_metadata = directory
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    if !route_metadata.is_dir()
        || !same_filesystem_object(&route_metadata, &directory_metadata)
        || std::fs::read_dir(route).is_err()
    {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn validate_stable_directory_route(
    path: &Path,
    target: &LeasedPhysicalTarget,
) -> Result<(), PluginNativeTargetBindingHostError> {
    let descriptor_metadata = std::fs::metadata(path)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    let target_metadata = target
        .directory
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    if !descriptor_metadata.is_dir()
        || !same_filesystem_object(&descriptor_metadata, &target_metadata)
        || std::fs::read_dir(path).is_err()
    {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_volume_file_id_route(
    target: &LeasedPhysicalTarget,
) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    macos_file_id_route(&target.directory)
}

#[cfg(target_os = "macos")]
fn macos_file_id_route(directory: &File) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = directory
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    Ok(PathBuf::from(format!(
        "/.vol/{}/{}",
        metadata.dev(),
        metadata.ino()
    )))
}

#[cfg(target_os = "macos")]
fn prepare_macos_executable_route(
    executable: &Path,
) -> Result<(File, PathBuf), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let anchor = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(executable)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    let anchor_metadata = anchor
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    let path_metadata = std::fs::symlink_metadata(executable)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    if !anchor_metadata.is_file()
        || anchor_metadata.permissions().mode() & 0o111 == 0
        || path_metadata.file_type().is_symlink()
        || !same_filesystem_object(&anchor_metadata, &path_metadata)
    {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
    }
    let route = PathBuf::from(format!(
        "/.vol/{}/{}",
        anchor_metadata.dev(),
        anchor_metadata.ino()
    ));
    let route_metadata = std::fs::metadata(&route)
        .map_err(|_| PluginNativeTargetBindingHostError::DescriptorRouteUnavailable)?;
    if !route_metadata.is_file()
        || !same_filesystem_object(&anchor_metadata, &route_metadata)
        || route_metadata.permissions().mode() & 0o111 == 0
    {
        return Err(PluginNativeTargetBindingHostError::DescriptorRouteUnavailable);
    }
    Ok((anchor, route))
}

fn resolve_target(
    context: &PluginNativeCliHostContext<'_>,
    authority: &PluginNativeTargetBindingAuthority,
    key: &PhysicalTargetKeyV2,
    role: PluginNativePhysicalTargetRoleV2,
) -> Result<LeasedPhysicalTarget, PluginNativeTargetBindingHostError> {
    let path = context
        .physical_targets
        .get(key)
        .ok_or_else(|| PluginNativeTargetBindingHostError::MissingTarget { key: key.clone() })?;
    let path_metadata = std::fs::symlink_metadata(path)
        .map_err(|_| PluginNativeTargetBindingHostError::TargetUnavailable { key: key.clone() })?;
    if path_metadata.file_type().is_symlink() {
        return Err(PluginNativeTargetBindingHostError::TargetIsSymlink { key: key.clone() });
    }
    if !path_metadata.is_dir() {
        return Err(PluginNativeTargetBindingHostError::TargetIsNotDirectory { key: key.clone() });
    }
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|_| PluginNativeTargetBindingHostError::TargetUnavailable { key: key.clone() })?;
    validate_ancestor_authority(&canonical_path, key)?;
    let directory = open_exact_directory(&canonical_path, key)?;
    let handle_metadata = directory
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::TargetUnavailable { key: key.clone() })?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical_path)
        .map_err(|_| PluginNativeTargetBindingHostError::TargetUnavailable { key: key.clone() })?;
    if canonical_metadata.file_type().is_symlink() {
        return Err(PluginNativeTargetBindingHostError::TargetIsSymlink { key: key.clone() });
    }
    if !same_filesystem_object(&path_metadata, &canonical_metadata)
        || !same_filesystem_object(&canonical_metadata, &handle_metadata)
    {
        return Err(PluginNativeTargetBindingHostError::TargetIdentityUnstable {
            key: key.clone(),
        });
    }
    validate_authority(&handle_metadata, key)?;
    let binding = binding_from_metadata(authority, key, role, &canonical_path, &handle_metadata)?;
    Ok(LeasedPhysicalTarget {
        canonical_path,
        directory,
        binding,
    })
}

fn validate_retained_directory(
    target: &LeasedPhysicalTarget,
) -> Result<(), PluginNativeTargetBindingHostError> {
    let metadata = target.directory.metadata().map_err(|_| {
        PluginNativeTargetBindingHostError::TargetUnavailable {
            key: target.binding.key.clone(),
        }
    })?;
    validate_authority(&metadata, &target.binding.key)
}

#[cfg(unix)]
fn open_exact_directory(
    path: &Path,
    key: &PhysicalTargetKeyV2,
) -> Result<File, PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| PluginNativeTargetBindingHostError::TargetUnavailable { key: key.clone() })
}

#[cfg(not(unix))]
fn open_exact_directory(
    _path: &Path,
    _key: &PhysicalTargetKeyV2,
) -> Result<File, PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

#[cfg(unix)]
fn same_filesystem_object(first: &std::fs::Metadata, second: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    first.dev() == second.dev() && first.ino() == second.ino()
}

#[cfg(not(unix))]
fn same_filesystem_object(_first: &std::fs::Metadata, _second: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn validate_authority(
    metadata: &std::fs::Metadata,
    key: &PhysicalTargetKeyV2,
) -> Result<(), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let effective_uid = unsafe { libc::geteuid() };
    let authority = unix_authority(metadata.uid(), effective_uid, metadata.mode());
    if authority == UnixTargetAuthority::WrongOwner {
        return Err(PluginNativeTargetBindingHostError::TargetOwnerChanged { key: key.clone() });
    }
    if authority == UnixTargetAuthority::UnsafePermissions {
        return Err(
            PluginNativeTargetBindingHostError::TargetPermissionsUnsafe { key: key.clone() },
        );
    }
    Ok(())
}

#[cfg(unix)]
fn validate_ancestor_authority(
    canonical_path: &Path,
    key: &PhysicalTargetKeyV2,
) -> Result<(), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let effective_uid = unsafe { libc::geteuid() };
    let Some(parent) = canonical_path.parent() else {
        return Err(PluginNativeTargetBindingHostError::TargetAncestorUnsafe { key: key.clone() });
    };
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|_| {
            PluginNativeTargetBindingHostError::TargetAncestorUnsafe { key: key.clone() }
        })?;
        let owner_is_trusted = metadata.uid() == 0 || metadata.uid() == effective_uid;
        let writable_is_sticky = metadata.mode() & 0o022 == 0 || metadata.mode() & 0o1000 != 0;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !owner_is_trusted
            || !writable_is_sticky
        {
            return Err(PluginNativeTargetBindingHostError::TargetAncestorUnsafe {
                key: key.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_ancestor_authority(
    _canonical_path: &Path,
    _key: &PhysicalTargetKeyV2,
) -> Result<(), PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnixTargetAuthority {
    Trusted,
    WrongOwner,
    UnsafePermissions,
}

#[cfg(unix)]
fn unix_authority(owner_uid: u32, effective_uid: u32, mode: u32) -> UnixTargetAuthority {
    if owner_uid != effective_uid {
        UnixTargetAuthority::WrongOwner
    } else if mode & 0o022 != 0 {
        UnixTargetAuthority::UnsafePermissions
    } else {
        UnixTargetAuthority::Trusted
    }
}

#[cfg(not(unix))]
fn validate_authority(
    _metadata: &std::fs::Metadata,
    _key: &PhysicalTargetKeyV2,
) -> Result<(), PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

#[cfg(unix)]
fn binding_from_metadata(
    authority: &PluginNativeTargetBindingAuthority,
    key: &PhysicalTargetKeyV2,
    role: PluginNativePhysicalTargetRoleV2,
    canonical_path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<PluginNativePhysicalTargetBindingV2, PluginNativeTargetBindingHostError> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let authority_generation_identity = hmac_digest(
        &authority.secret,
        b"dure.plugin-native.authority-generation/v1",
        &[],
    )?;
    let canonical_path_identity = hmac_digest(
        &authority.secret,
        b"dure.plugin-native.canonical-path/v1",
        &[canonical_path.as_os_str().as_bytes()],
    )?;
    let dev = metadata.dev().to_be_bytes();
    let ino = metadata.ino().to_be_bytes();
    let uid = metadata.uid().to_be_bytes();
    let filesystem_object_identity = hmac_digest(
        &authority.secret,
        b"dure.plugin-native.filesystem-object/v1",
        &[&dev, &ino, &uid],
    )?;
    let mode = (metadata.mode() & 0o7777).to_be_bytes();
    let authority_identity = hmac_digest(
        &authority.secret,
        b"dure.plugin-native.authority/v1",
        &[&uid, &mode],
    )?;
    let binding_identity = hmac_digest(
        &authority.secret,
        b"dure.plugin-native.binding/v1",
        &[
            key.as_str().as_bytes(),
            role.as_str().as_bytes(),
            canonical_path_identity.as_str().as_bytes(),
            filesystem_object_identity.as_str().as_bytes(),
            authority_generation_identity.as_str().as_bytes(),
            authority_identity.as_str().as_bytes(),
        ],
    )?;
    Ok(PluginNativePhysicalTargetBindingV2 {
        key: key.clone(),
        role,
        canonical_path_identity,
        filesystem_object_identity,
        authority_generation_identity,
        authority_identity,
        binding_identity,
    })
}

#[cfg(not(unix))]
fn binding_from_metadata(
    _authority: &PluginNativeTargetBindingAuthority,
    _key: &PhysicalTargetKeyV2,
    _role: PluginNativePhysicalTargetRoleV2,
    _canonical_path: &Path,
    _metadata: &std::fs::Metadata,
) -> Result<PluginNativePhysicalTargetBindingV2, PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

fn hmac_digest(
    secret: &[u8; 32],
    domain: &[u8],
    fields: &[&[u8]],
) -> Result<PluginNativePhysicalTargetDigestV2, PluginNativeTargetBindingHostError> {
    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|_| PluginNativeTargetBindingHostError::Digest)?;
    mac.update(domain);
    mac.update(&[0]);
    for field in fields {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field);
    }
    PluginNativePhysicalTargetDigestV2::new(format!("sha256:{:x}", mac.finalize().into_bytes()))
        .map_err(|_| PluginNativeTargetBindingHostError::Digest)
}

#[cfg(unix)]
fn open_or_create_authority(
    control_root: &Path,
) -> Result<PluginNativeTargetBindingAuthority, PluginNativeTargetBindingHostError> {
    use fs2::FileExt;

    let canonical_root = validate_authority_root(control_root)?;
    let lock_path = canonical_root.join(AUTHORITY_LOCK_FILE);
    let lock = open_or_create_authority_file(&lock_path)?;
    FileExt::lock_exclusive(&lock)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let result = (|| {
        validate_authority_root(&canonical_root)?;
        let key_path = canonical_root.join(AUTHORITY_KEY_FILE);
        let secret = match std::fs::symlink_metadata(&key_path) {
            Ok(_) => read_authority_secret(&key_path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_authority_secret(&canonical_root, &key_path)?
            }
            Err(_) => return Err(PluginNativeTargetBindingHostError::AuthorityStore),
        };
        Ok(PluginNativeTargetBindingAuthority { secret })
    })();
    let _ = FileExt::unlock(&lock);
    result
}

#[cfg(not(unix))]
fn open_or_create_authority(
    _control_root: &Path,
) -> Result<PluginNativeTargetBindingAuthority, PluginNativeTargetBindingHostError> {
    Err(PluginNativeTargetBindingHostError::UnsupportedPlatform)
}

#[cfg(unix)]
fn validate_authority_root(path: &Path) -> Result<PathBuf, PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let original = std::fs::symlink_metadata(path)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let effective_uid = unsafe { libc::geteuid() };
    if original.file_type().is_symlink()
        || !original.is_dir()
        || original.uid() != effective_uid
        || original.mode() & 0o022 != 0
    {
        return Err(PluginNativeTargetBindingHostError::AuthorityStore);
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let canonical_metadata = std::fs::symlink_metadata(&canonical)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    if canonical_metadata.file_type().is_symlink()
        || !canonical_metadata.is_dir()
        || canonical_metadata.dev() != original.dev()
        || canonical_metadata.ino() != original.ino()
    {
        return Err(PluginNativeTargetBindingHostError::AuthorityStore);
    }
    validate_authority_root_ancestors(&canonical, effective_uid)?;
    Ok(canonical)
}

#[cfg(unix)]
fn validate_authority_root_ancestors(
    canonical_root: &Path,
    effective_uid: u32,
) -> Result<(), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let parent = canonical_root
        .parent()
        .ok_or(PluginNativeTargetBindingHostError::AuthorityStore)?;
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
        let owner_is_trusted = metadata.uid() == 0 || metadata.uid() == effective_uid;
        let writable_is_sticky = metadata.mode() & 0o022 == 0 || metadata.mode() & 0o1000 != 0;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || !owner_is_trusted
            || !writable_is_sticky
        {
            return Err(PluginNativeTargetBindingHostError::AuthorityStore);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_or_create_authority_file(path: &Path) -> Result<File, PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::OpenOptionsExt;

    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    validate_authority_file(&file)?;
    Ok(file)
}

#[cfg(unix)]
fn read_authority_secret(path: &Path) -> Result<[u8; 32], PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    validate_authority_file(&file)?;
    if file
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?
        .len()
        != 32
    {
        return Err(PluginNativeTargetBindingHostError::AuthorityStore);
    }
    let mut secret = [0_u8; 32];
    file.read_exact(&mut secret)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let mut extra = [0_u8; 1];
    if file
        .read(&mut extra)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?
        != 0
    {
        return Err(PluginNativeTargetBindingHostError::AuthorityStore);
    }
    Ok(secret)
}

#[cfg(unix)]
fn create_authority_secret(
    directory: &Path,
    path: &Path,
) -> Result<[u8; 32], PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    validate_authority_file(&file)?;
    file.write_all(&secret)
        .and_then(|_| file.sync_all())
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    Ok(secret)
}

#[cfg(unix)]
fn validate_authority_file(file: &File) -> Result<(), PluginNativeTargetBindingHostError> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file
        .metadata()
        .map_err(|_| PluginNativeTargetBindingHostError::AuthorityStore)?;
    let effective_uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.uid() != effective_uid
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err(PluginNativeTargetBindingHostError::AuthorityStore);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use dure_app::{
        AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationIdV2, AgentNativeMarketplaceNameV2,
        AgentNativePluginCliCommandV2, AgentNativePluginExecutableV2, AgentNativePluginNameV2,
        AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PluginVersionV2,
    };
    #[cfg(feature = "provider-conformance-test-support")]
    use dure_app::{AgentNativePluginMarketplaceSourceV2, PluginResourcePathV2};
    #[cfg(feature = "provider-conformance-test-support")]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Child, Command};
    use std::time::{Duration, Instant};

    const LEASE_CHILD_TARGET: &str = "DURE_TEST_PLUGIN_NATIVE_LEASE_TARGET";
    const LEASE_CHILD_READY: &str = "DURE_TEST_PLUGIN_NATIVE_LEASE_READY";
    const LEASE_PROVIDER_EXECUTABLE: &str = "DURE_TEST_PLUGIN_NATIVE_LEASE_EXECUTABLE";
    const LEASE_PROVIDER_RELEASE: &str = "DURE_TEST_PLUGIN_NATIVE_LEASE_RELEASE";

    fn step(key: PhysicalTargetKeyV2) -> PluginApplyStepV2 {
        let selector = AgentNativePluginSelectorV2 {
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        };
        PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
            adapter: AgentAdapterIdV2::new("codex").unwrap(),
            executable: AgentNativePluginExecutableV2::Codex,
            cli_version: PluginVersionV2::new("1.0.0").unwrap(),
            selector: selector.clone(),
            registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: key,
            },
            command: AgentNativePluginCliCommandV2::InstallPlugin {
                selector,
                scope: AgentInstallScopeV2::Managed,
                output: dure_app::AgentNativePluginCliOutputV2::Json,
            },
        }
    }

    fn target_leases_for_path(path: &Path) -> PluginNativeTargetLeases {
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), path.to_path_buf())]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let executable = std::fs::canonicalize("/usr/bin/true").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: path,
            neutral_working_directory: path,
            physical_targets: &targets,
        };
        resolve_plugin_native_target_leases(
            &[step(key)],
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x42; 32]),
        )
        .unwrap()
    }

    struct OwnedChild(Child);

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn crash_lease_child_helper() {
        let Some(target) = std::env::var_os(LEASE_CHILD_TARGET) else {
            return;
        };
        let ready = PathBuf::from(std::env::var_os(LEASE_CHILD_READY).unwrap());
        let leases = target_leases_for_path(Path::new(&target));
        let _lease = match leases.try_acquire_execution_lease().unwrap() {
            PluginNativeTargetExecutionLeaseDisposition::Acquired(lease) => lease,
            PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                panic!("child target lease was unexpectedly occupied")
            }
        };
        std::fs::write(ready, b"ready").unwrap();
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }

    #[test]
    fn orphan_provider_lease_child_helper() {
        let Some(target) = std::env::var_os(LEASE_CHILD_TARGET) else {
            return;
        };
        let executable = PathBuf::from(std::env::var_os(LEASE_PROVIDER_EXECUTABLE).unwrap());
        let target = PathBuf::from(target);
        let root = target.parent().unwrap().to_path_buf();
        let neutral = root.join("neutral");
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), target)]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: &root,
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };
        let step = step(key);
        let leases = resolve_plugin_native_target_leases(
            std::slice::from_ref(&step),
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x81; 32]),
        )
        .unwrap();
        let _execution_lease = match leases.try_acquire_execution_lease().unwrap() {
            PluginNativeTargetExecutionLeaseDisposition::Acquired(lease) => lease,
            PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                panic!("provider target lease was unexpectedly occupied")
            }
        };
        let invocation = dure_app::compile_agent_native_plugin_cli_invocation(&step).unwrap();
        let prepared =
            prepare_bound_plugin_native_cli_command(&invocation, &context, &leases).unwrap();
        let execution = execute_bound_plugin_native_cli_command(&prepared).unwrap();
        assert_eq!(
            execution.outcome(),
            &dure_app::PluginNativeCommandOutcomeV2::Succeeded
        );
    }

    #[test]
    fn execution_lease_is_cross_process_and_kernel_released_after_crash() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("profile");
        let ready = temp.path().join("child-ready");
        std::fs::create_dir(&target).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("plugin_native_target_binding::tests::crash_lease_child_helper")
            .arg("--nocapture")
            .env(LEASE_CHILD_TARGET, &target)
            .env(LEASE_CHILD_READY, &ready)
            .spawn()
            .unwrap();
        let mut child = OwnedChild(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lease helper exited before publishing readiness"
            );
            assert!(
                Instant::now() < deadline,
                "lease helper readiness timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        let leases = target_leases_for_path(&target);
        assert!(matches!(
            leases.try_acquire_execution_lease().unwrap(),
            PluginNativeTargetExecutionLeaseDisposition::Occupied
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(matches!(
            leases.try_acquire_execution_lease().unwrap(),
            PluginNativeTargetExecutionLeaseDisposition::Acquired(_)
        ));
    }

    #[test]
    fn orphan_provider_inherits_the_lease_until_its_process_exits() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("profile");
        let neutral = temp.path().join("neutral");
        let executable = temp.path().join("codex");
        let ready = temp.path().join("provider-ready");
        let release = temp.path().join("provider-release");
        std::fs::create_dir(&target).unwrap();
        std::fs::create_dir(&neutral).unwrap();
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nset -eu\ntouch '{}'\nwhile [ ! -e '{}' ]; do sleep 0.01; done\n",
                ready.display(),
                release.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("plugin_native_target_binding::tests::orphan_provider_lease_child_helper")
            .arg("--nocapture")
            .env(LEASE_CHILD_TARGET, &target)
            .env(LEASE_CHILD_READY, &ready)
            .env(LEASE_PROVIDER_EXECUTABLE, &executable)
            .env(LEASE_PROVIDER_RELEASE, &release)
            .spawn()
            .unwrap();
        let mut child = OwnedChild(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "lease helper exited before the provider published readiness"
            );
            assert!(Instant::now() < deadline, "provider readiness timed out");
            std::thread::sleep(Duration::from_millis(10));
        }

        let leases = target_leases_for_path(&target);
        assert!(matches!(
            leases.try_acquire_execution_lease().unwrap(),
            PluginNativeTargetExecutionLeaseDisposition::Occupied
        ));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(matches!(
            leases.try_acquire_execution_lease().unwrap(),
            PluginNativeTargetExecutionLeaseDisposition::Occupied
        ));

        std::fs::write(&release, b"release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match leases.try_acquire_execution_lease().unwrap() {
                PluginNativeTargetExecutionLeaseDisposition::Acquired(_) => break,
                PluginNativeTargetExecutionLeaseDisposition::Occupied => {
                    assert!(
                        Instant::now() < deadline,
                        "orphan provider retained its lease after exit"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    #[test]
    fn rejects_symlinks_and_detects_delete_recreate_at_the_same_path() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let alias = temp.path().join("alias");
        std::fs::create_dir(&profile).unwrap();
        std::os::unix::fs::symlink(&profile, &alias).unwrap();
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let executable = std::fs::canonicalize("/usr/bin/true").unwrap();
        let package = temp.path().join("package");
        let neutral = temp.path().join("neutral");
        std::fs::create_dir(&package).unwrap();
        std::fs::create_dir(&neutral).unwrap();
        let authority = PluginNativeTargetBindingAuthority::for_test([7; 32]);
        let alias_targets = BTreeMap::from([(key.clone(), alias)]);
        let alias_context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: &package,
            neutral_working_directory: &neutral,
            physical_targets: &alias_targets,
        };
        assert!(matches!(
            resolve_plugin_native_target_leases(&[step(key.clone())], &alias_context, &authority),
            Err(PluginNativeTargetBindingHostError::TargetIsSymlink { .. })
        ));

        let targets = BTreeMap::from([(key.clone(), profile.clone())]);
        let context = PluginNativeCliHostContext {
            physical_targets: &targets,
            ..alias_context
        };
        let leases =
            resolve_plugin_native_target_leases(&[step(key)], &context, &authority).unwrap();
        std::fs::remove_dir(&profile).unwrap();
        std::fs::create_dir(&profile).unwrap();
        assert!(matches!(
            leases.validate(&context),
            Err(PluginNativeTargetBindingHostError::BindingChanged { .. })
                | Err(PluginNativeTargetBindingHostError::TargetIdentityUnstable { .. })
        ));
    }

    #[test]
    fn replaced_path_after_bound_prepare_never_executes_the_provider() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("codex");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        let retained = temp.path().join("retained-profile");
        std::fs::create_dir(&neutral).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::write(
            &executable,
            b"#!/bin/sh\nset -eu\ntouch \"$CODEX_HOME/provider-executed\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };
        let step = step(key);
        let leases = resolve_plugin_native_target_leases(
            std::slice::from_ref(&step),
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x61; 32]),
        )
        .unwrap();
        let invocation = dure_app::compile_agent_native_plugin_cli_invocation(&step).unwrap();
        let prepared =
            prepare_bound_plugin_native_cli_command(&invocation, &context, &leases).unwrap();
        let canonical_profile = std::fs::canonicalize(&profile).unwrap();
        assert!(prepared
            .command()
            .environment()
            .iter()
            .all(|(_, value)| { Path::new(value) != canonical_profile }));

        std::fs::rename(&profile, &retained).unwrap();
        std::fs::create_dir(&profile).unwrap();
        assert!(matches!(
            execute_bound_plugin_native_cli_command(&prepared),
            Err(PluginNativeTargetBindingHostError::TargetChangedBeforeExecution)
        ));
        assert!(!retained.join("provider-executed").exists());
        assert!(!profile.join("provider-executed").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unix_codex_managed_profile_uses_descriptor_cwd_and_relative_home() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("codex");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        std::fs::create_dir(&neutral).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::write(
            &executable,
            b"#!/bin/sh\nset -eu\ntest -z \"${CLAUDE_CONFIG_DIR+x}\"\ntest -z \"${CODEX_SQLITE_HOME+x}\"\ntest -z \"${ANTHROPIC_API_KEY+x}\"\ntest -z \"${CLAUDE_CODE_OAUTH_TOKEN+x}\"\ntest -z \"${OPENAI_API_KEY+x}\"\nprofile=$(pwd -P)\nresolved=$(cd \"$CODEX_HOME\" && pwd -P)\ntest \"$resolved\" = \"$profile\"\ntouch \"$resolved/provider-executed\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };
        let step = step(profile_key);
        let leases = resolve_plugin_native_target_leases(
            std::slice::from_ref(&step),
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x70; 32]),
        )
        .unwrap();
        let invocation = dure_app::compile_agent_native_plugin_cli_invocation(&step).unwrap();
        let prepared =
            prepare_bound_plugin_native_cli_command(&invocation, &context, &leases).unwrap();

        assert!(prepared.command().clears_environment());
        assert!(prepared.command().current_directory().is_none());
        assert_eq!(
            prepared.command().environment(),
            &[(OsString::from("CODEX_HOME"), OsString::from("."))]
        );
        assert!(prepared
            .command()
            .environment()
            .iter()
            .all(|(name, _)| name != "PATH"));
        #[cfg(target_os = "macos")]
        {
            use std::os::unix::fs::MetadataExt;

            let executable_metadata = std::fs::metadata(&executable).unwrap();
            assert_eq!(
                prepared.command().program(),
                PathBuf::from(format!(
                    "/.vol/{}/{}",
                    executable_metadata.dev(),
                    executable_metadata.ino()
                ))
            );
            std::fs::rename(&executable, temp.path().join("codex.retained")).unwrap();
            std::fs::write(&executable, b"#!/bin/sh\nexit 42\n").unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            execute_bound_plugin_native_cli_command(&prepared)
                .unwrap()
                .outcome(),
            &dure_app::PluginNativeCommandOutcomeV2::Succeeded
        );
        assert!(profile.join("provider-executed").is_file());
        assert!(!neutral.join("provider-executed").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_workspace_route_uses_profile_file_id_and_workspace_descriptor() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("claude");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&neutral).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(
            &executable,
            b"#!/bin/sh\nset -eu\ntest -z \"${CLAUDE_CONFIG_DIR+x}\"\ntest -z \"${CODEX_SQLITE_HOME+x}\"\ntest -z \"${ANTHROPIC_API_KEY+x}\"\ntest -z \"${CLAUDE_CODE_OAUTH_TOKEN+x}\"\ntest -z \"${OPENAI_API_KEY+x}\"\ntouch \"$HOME/profile-executed\"\ntouch workspace-executed\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("profile").unwrap();
        let workspace_key = PhysicalTargetKeyV2::new("workspace").unwrap();
        let targets = BTreeMap::from([
            (profile_key.clone(), profile.clone()),
            (workspace_key.clone(), workspace.clone()),
        ]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Claude,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };
        let selector = AgentNativePluginSelectorV2 {
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        };
        let step = PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("dure.beads.claude").unwrap(),
            adapter: AgentAdapterIdV2::new("claude").unwrap(),
            executable: AgentNativePluginExecutableV2::Claude,
            cli_version: version.clone(),
            selector: selector.clone(),
            registration_target: AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key: profile_key,
                workspace_root_key: workspace_key,
            },
            command: AgentNativePluginCliCommandV2::InstallPlugin {
                selector,
                scope: AgentInstallScopeV2::Local,
                output: dure_app::AgentNativePluginCliOutputV2::HumanText,
            },
        };
        let leases = resolve_plugin_native_target_leases(
            std::slice::from_ref(&step),
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x71; 32]),
        )
        .unwrap();
        let invocation = dure_app::compile_agent_native_plugin_cli_invocation(&step).unwrap();
        let prepared =
            prepare_bound_plugin_native_cli_command(&invocation, &context, &leases).unwrap();
        assert!(prepared.command().clears_environment());
        assert!(prepared.command().current_directory().is_none());
        assert_eq!(prepared.command().environment().len(), 1);
        assert_eq!(prepared.command().environment()[0].0, "HOME");
        assert!(Path::new(&prepared.command().environment()[0].1).starts_with("/.vol"));
        for hostile in [
            "PATH",
            "CLAUDE_CONFIG_DIR",
            "CODEX_SQLITE_HOME",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
        ] {
            assert!(prepared
                .command()
                .environment()
                .iter()
                .all(|(name, _)| name != hostile));
        }
        assert_eq!(
            execute_bound_plugin_native_cli_command(&prepared)
                .unwrap()
                .outcome(),
            &dure_app::PluginNativeCommandOutcomeV2::Succeeded
        );
        assert!(profile.join("profile-executed").is_file());
        assert!(workspace.join("workspace-executed").is_file());
    }

    #[cfg(feature = "provider-conformance-test-support")]
    #[test]
    fn package_resource_route_is_bound_to_the_validated_package_directory() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("codex");
        let package_root = temp.path().join("package");
        let resource_root = package_root.join("agents/codex");
        let profile = temp.path().join("profile");
        let neutral = temp.path().join("neutral");
        std::fs::create_dir_all(&resource_root).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&neutral).unwrap();
        std::fs::write(resource_root.join("marker"), b"retained").unwrap();
        std::fs::write(
            &executable,
            b"#!/bin/sh\nset -eu\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    */agents/codex) cat \"$argument/marker\"; exit 0 ;;\n  esac\ndone\nexit 91\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let package_root_lease = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&package_root)
            .unwrap();
        let package_identity = package_root_lease.metadata().unwrap();
        let profile_key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: &package_root,
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };
        let selector = AgentNativePluginSelectorV2 {
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        };
        let step = PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
            adapter: AgentAdapterIdV2::new("codex").unwrap(),
            executable: AgentNativePluginExecutableV2::Codex,
            cli_version: version.clone(),
            selector,
            registration_target: AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: profile_key,
            },
            command: AgentNativePluginCliCommandV2::AddMarketplace {
                source: AgentNativePluginMarketplaceSourceV2 {
                    resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
                },
                scope: AgentInstallScopeV2::Managed,
                output: dure_app::AgentNativePluginCliOutputV2::Json,
            },
        };
        let leases = resolve_plugin_native_target_leases(
            std::slice::from_ref(&step),
            &context,
            &PluginNativeTargetBindingAuthority::for_test([0x73; 32]),
        )
        .unwrap();
        let invocation = dure_app::compile_agent_native_plugin_cli_invocation(&step).unwrap();
        let prepared = prepare_bound_plugin_native_cli_command_with_package_root_lease(
            &invocation,
            &context,
            &leases,
            &package_root_lease,
        )
        .unwrap();
        assert!(prepared
            .command()
            .arguments()
            .iter()
            .any(|argument| Path::new(argument).ends_with("agents/codex")));

        let retained = temp.path().join("package.retained");
        #[cfg(target_os = "macos")]
        {
            std::fs::rename(&package_root, &retained).unwrap();
            std::fs::create_dir_all(package_root.join("agents/codex")).unwrap();
            std::fs::write(package_root.join("agents/codex/marker"), b"decoy").unwrap();
            assert_eq!(
                execute_bound_plugin_native_cli_command(&prepared).unwrap_err(),
                PluginNativeTargetBindingHostError::TargetChangedBeforeExecution
            );
            assert_eq!(
                std::fs::read(package_root.join("agents/codex/marker")).unwrap(),
                b"decoy"
            );
        }
        #[cfg(target_os = "linux")]
        {
            let (mut controller, barrier) =
                hebbian_bounded_process::unix_pre_exec_barrier().unwrap();
            let execution = std::thread::scope(|scope| {
                let child = scope.spawn(|| {
                    execute_bound_plugin_native_cli_command_with_pre_exec_barrier(
                        &prepared, barrier,
                    )
                });
                controller
                    .wait_until_ready(Duration::from_secs(10))
                    .expect("child reached the exact post-anchor-validation boundary");
                std::fs::rename(&package_root, &retained).unwrap();
                std::fs::create_dir_all(package_root.join("agents/codex")).unwrap();
                std::fs::write(package_root.join("agents/codex/marker"), b"decoy").unwrap();
                controller.release().unwrap();
                child.join().unwrap().unwrap()
            });
            assert_eq!(
                execution.outcome(),
                &dure_app::PluginNativeCommandOutcomeV2::Succeeded
            );
            assert_eq!(execution.stdout(), b"retained");
            assert_eq!(
                std::fs::read(package_root.join("agents/codex/marker")).unwrap(),
                b"decoy"
            );
        }
        assert_eq!(std::fs::metadata(&retained).unwrap().ino(), package_identity.ino());
        assert_ne!(std::fs::metadata(&package_root).unwrap().ino(), package_identity.ino());
    }

    #[test]
    fn rejects_group_or_world_writable_targets() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        std::fs::set_permissions(&profile, std::fs::Permissions::from_mode(0o777)).unwrap();
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), profile)]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let executable = std::fs::canonicalize("/usr/bin/true").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: temp.path(),
            physical_targets: &targets,
        };
        assert!(matches!(
            resolve_plugin_native_target_leases(
                &[step(key)],
                &context,
                &PluginNativeTargetBindingAuthority::for_test([9; 32]),
            ),
            Err(PluginNativeTargetBindingHostError::TargetPermissionsUnsafe { .. })
        ));
    }

    #[test]
    fn rejects_a_safe_target_below_a_non_sticky_writable_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = shared.join("profile");
        std::fs::create_dir(&shared).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), profile)]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let executable = std::fs::canonicalize("/usr/bin/true").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: temp.path(),
            physical_targets: &targets,
        };
        assert!(matches!(
            resolve_plugin_native_target_leases(
                &[step(key)],
                &context,
                &PluginNativeTargetBindingAuthority::for_test([0x19; 32]),
            ),
            Err(PluginNativeTargetBindingHostError::TargetAncestorUnsafe { .. })
        ));
    }

    #[test]
    fn owner_and_permission_policy_fails_closed_independently() {
        assert_eq!(
            unix_authority(501, 501, 0o755),
            UnixTargetAuthority::Trusted
        );
        assert_eq!(
            unix_authority(0, 501, 0o700),
            UnixTargetAuthority::WrongOwner
        );
        assert_eq!(
            unix_authority(501, 501, 0o775),
            UnixTargetAuthority::UnsafePermissions
        );
    }

    #[test]
    fn durable_authority_secret_is_owner_only_and_stable_across_reopen() {
        use std::os::unix::fs::MetadataExt;

        let root = tempfile::tempdir().unwrap();
        let first = PluginNativeTargetBindingAuthority::open_or_create(root.path()).unwrap();
        let second = PluginNativeTargetBindingAuthority::open_or_create(root.path()).unwrap();
        assert_eq!(first.secret, second.secret);
        assert_ne!(first.secret, [0_u8; 32]);

        let metadata = std::fs::symlink_metadata(root.path().join(AUTHORITY_KEY_FILE)).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.mode() & 0o7777, 0o600);

        std::fs::set_permissions(
            root.path().join(AUTHORITY_KEY_FILE),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(matches!(
            PluginNativeTargetBindingAuthority::open_or_create(root.path()),
            Err(PluginNativeTargetBindingHostError::AuthorityStore)
        ));
    }

    #[test]
    fn durable_authority_rejects_a_non_sticky_writable_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let root = shared.join("authority");
        std::fs::create_dir(&shared).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();

        assert!(matches!(
            PluginNativeTargetBindingAuthority::open_or_create(&root),
            Err(PluginNativeTargetBindingHostError::AuthorityStore)
        ));
    }

    #[test]
    fn binding_mac_binds_key_and_role_without_weakening_reverse_alias_identity() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let canonical = std::fs::canonicalize(&target).unwrap();
        let metadata = std::fs::metadata(&canonical).unwrap();
        let authority = PluginNativeTargetBindingAuthority::for_test([0x31; 32]);
        let first = binding_from_metadata(
            &authority,
            &PhysicalTargetKeyV2::new("first").unwrap(),
            PluginNativePhysicalTargetRoleV2::ProfileRoot,
            &canonical,
            &metadata,
        )
        .unwrap();
        let second = binding_from_metadata(
            &authority,
            &PhysicalTargetKeyV2::new("second").unwrap(),
            PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
            &canonical,
            &metadata,
        )
        .unwrap();

        assert_eq!(
            first.canonical_path_identity,
            second.canonical_path_identity
        );
        assert_eq!(
            first.filesystem_object_identity,
            second.filesystem_object_identity
        );
        assert_eq!(
            first.authority_generation_identity,
            second.authority_generation_identity
        );
        assert_ne!(first.binding_identity, second.binding_identity);
    }

    #[test]
    fn canonical_identity_accepts_non_utf8_unix_paths_without_serializing_them() {
        use std::os::unix::ffi::OsStringExt;

        let temp = tempfile::tempdir().unwrap();
        let profile = temp
            .path()
            .join(std::ffi::OsString::from_vec(vec![b'p', 0xff, b'r']));
        if let Err(error) = std::fs::create_dir(&profile) {
            #[cfg(target_os = "macos")]
            {
                assert_eq!(error.raw_os_error(), Some(92));
                return;
            }
            #[cfg(not(target_os = "macos"))]
            panic!("non-UTF8 fixture directory failed: {error}");
        }
        let key = PhysicalTargetKeyV2::new("profile").unwrap();
        let targets = BTreeMap::from([(key.clone(), profile)]);
        let version = PluginVersionV2::new("1.0.0").unwrap();
        let executable = std::fs::canonicalize("/usr/bin/true").unwrap();
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable,
            executable_version: &version,
            package_root: temp.path(),
            neutral_working_directory: temp.path(),
            physical_targets: &targets,
        };
        let leases = resolve_plugin_native_target_leases(
            &[step(key)],
            &context,
            &PluginNativeTargetBindingAuthority::for_test([3; 32]),
        )
        .unwrap();
        let encoded = serde_json::to_string(leases.bindings()).unwrap();
        assert!(encoded.contains("sha256:"));
        assert!(!encoded.contains(temp.path().to_string_lossy().as_ref()));
    }
}
