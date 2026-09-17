use dure_app::{
    AgentNativePluginCliArgumentV2, AgentNativePluginCliEnvironmentV2,
    AgentNativePluginCliInvocationV2, AgentNativePluginCliOutputV2,
    AgentNativePluginCliWorkingDirectoryV2, AgentNativePluginExecutableV2, PhysicalTargetKeyV2,
    PluginResourcePathV2, PluginVersionV2,
};
#[cfg(test)]
use dure_app::{PluginNativeCommandHostFailureV2, PluginNativeCommandOutcomeV2};
#[cfg(test)]
use hebbian_bounded_process::CommandFailure;
use hebbian_bounded_process::CommandSpec;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[path = "plugin_native_cli/execution.rs"]
mod execution_result;
pub use execution_result::PluginNativeCliExecution;
use execution_result::classify_execution;

#[cfg(unix)]
use hebbian_bounded_process::{
    UnixBoundCommandFailure, UnixDirectoryAnchor, run_unix_bound_command,
};
#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
use hebbian_bounded_process::{
    UnixPreExecBarrier, run_unix_bound_command_with_pre_exec_barrier,
};

const PLUGIN_NATIVE_CLI_TIMEOUT: Duration = Duration::from_secs(30);
const PLUGIN_NATIVE_CLI_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedPluginNativeCliCommand {
    command: CommandSpec,
    output: AgentNativePluginCliOutputV2,
}

impl PreparedPluginNativeCliCommand {
    pub fn command(&self) -> &CommandSpec {
        &self.command
    }

    pub fn output(&self) -> &AgentNativePluginCliOutputV2 {
        &self.output
    }
}

#[derive(Debug)]
pub struct PluginNativeCliHostContext<'a> {
    pub executable: AgentNativePluginExecutableV2,
    pub executable_path: &'a Path,
    pub executable_version: &'a PluginVersionV2,
    pub package_root: &'a Path,
    pub neutral_working_directory: &'a Path,
    pub physical_targets: &'a BTreeMap<PhysicalTargetKeyV2, PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeCliPrepareError {
    ExecutableIdentityChanged,
    ExecutableVersionChanged,
    ExecutableUnavailable,
    ExecutableIsSymlink,
    ExecutableIsNotFile,
    ExecutableIsNotRunnable,
    PackageRootUnavailable,
    PackageRootIsSymlink,
    PackageRootIsNotDirectory,
    NeutralWorkingDirectoryUnavailable,
    NeutralWorkingDirectoryIsSymlink,
    NeutralWorkingDirectoryIsNotDirectory,
    ResourceUnavailable,
    ResourceIsSymlink,
    ResourceIsNotDirectory,
    ResourceEscapedPackage,
    PhysicalTargetMissing { key: PhysicalTargetKeyV2 },
    PhysicalTargetUnavailable { key: PhysicalTargetKeyV2 },
    PhysicalTargetIsSymlink { key: PhysicalTargetKeyV2 },
    PhysicalTargetIsNotDirectory { key: PhysicalTargetKeyV2 },
}

pub fn prepare_plugin_native_cli_command(
    invocation: &AgentNativePluginCliInvocationV2,
    context: &PluginNativeCliHostContext<'_>,
) -> Result<PreparedPluginNativeCliCommand, PluginNativeCliPrepareError> {
    if invocation.executable() != &context.executable {
        return Err(PluginNativeCliPrepareError::ExecutableIdentityChanged);
    }
    if invocation.cli_version() != context.executable_version {
        return Err(PluginNativeCliPrepareError::ExecutableVersionChanged);
    }
    let executable = exact_executable(context.executable_path)?;

    let mut command = CommandSpec::new(executable);
    command.clear_env();
    let mut package_root = None;
    for argument in invocation.arguments() {
        match argument {
            AgentNativePluginCliArgumentV2::Literal(value) => {
                command.arg(value);
            }
            AgentNativePluginCliArgumentV2::PackageResource(resource) => {
                if package_root.is_none() {
                    package_root = Some(exact_directory(
                        context.package_root,
                        PluginNativeCliPrepareError::PackageRootUnavailable,
                        PluginNativeCliPrepareError::PackageRootIsSymlink,
                        PluginNativeCliPrepareError::PackageRootIsNotDirectory,
                    )?);
                }
                command.arg(resolve_package_directory(
                    package_root
                        .as_deref()
                        .expect("package root was resolved for a package resource"),
                    resource,
                )?);
            }
        }
    }
    match invocation.working_directory() {
        AgentNativePluginCliWorkingDirectoryV2::HostNeutral => {
            command.current_dir(exact_directory(
                context.neutral_working_directory,
                PluginNativeCliPrepareError::NeutralWorkingDirectoryUnavailable,
                PluginNativeCliPrepareError::NeutralWorkingDirectoryIsSymlink,
                PluginNativeCliPrepareError::NeutralWorkingDirectoryIsNotDirectory,
            )?);
        }
        AgentNativePluginCliWorkingDirectoryV2::Workspace { workspace_root_key } => {
            command.current_dir(resolve_physical_target(context, workspace_root_key)?);
        }
    }
    for environment in invocation.environment() {
        match environment {
            AgentNativePluginCliEnvironmentV2::CodexHome { profile_root_key } => {
                command.env(
                    "CODEX_HOME",
                    resolve_physical_target(context, profile_root_key)?,
                );
            }
            AgentNativePluginCliEnvironmentV2::ClaudeHome { profile_root_key } => {
                command.env("HOME", resolve_physical_target(context, profile_root_key)?);
            }
        }
    }
    Ok(PreparedPluginNativeCliCommand {
        command,
        output: invocation.output().clone(),
    })
}

pub fn execute_prepared_plugin_native_cli_command(
    prepared: &PreparedPluginNativeCliCommand,
) -> PluginNativeCliExecution {
    classify_execution(hebbian_bounded_process::run(
        prepared.command(),
        PLUGIN_NATIVE_CLI_TIMEOUT,
        PLUGIN_NATIVE_CLI_OUTPUT_LIMIT,
    ))
}

#[cfg(unix)]
pub(crate) fn execute_prepared_plugin_native_cli_command_with_directory_anchors(
    prepared: &PreparedPluginNativeCliCommand,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
) -> Result<PluginNativeCliExecution, UnixBoundCommandFailure> {
    match run_unix_bound_command(
        prepared.command(),
        directory_anchors,
        current_directory_anchor,
        PLUGIN_NATIVE_CLI_TIMEOUT,
        PLUGIN_NATIVE_CLI_OUTPUT_LIMIT,
    ) {
        Ok(output) => Ok(classify_execution(Ok(output))),
        Err(UnixBoundCommandFailure::Command(failure)) => {
            Ok(classify_execution(Err(failure)))
        }
        Err(error) => Err(error),
    }
}

#[cfg(all(test, unix, feature = "provider-conformance-test-support"))]
pub(crate) fn execute_prepared_plugin_native_cli_command_with_pre_exec_barrier(
    prepared: &PreparedPluginNativeCliCommand,
    directory_anchors: &[UnixDirectoryAnchor<'_>],
    current_directory_anchor: Option<usize>,
    barrier: UnixPreExecBarrier,
) -> Result<PluginNativeCliExecution, UnixBoundCommandFailure> {
    match run_unix_bound_command_with_pre_exec_barrier(
        prepared.command(),
        directory_anchors,
        current_directory_anchor,
        barrier,
        PLUGIN_NATIVE_CLI_TIMEOUT,
        PLUGIN_NATIVE_CLI_OUTPUT_LIMIT,
    ) {
        Ok(output) => Ok(classify_execution(Ok(output))),
        Err(UnixBoundCommandFailure::Command(failure)) => {
            Ok(classify_execution(Err(failure)))
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
pub(crate) fn rewrite_prepared_plugin_native_cli_route(
    prepared: PreparedPluginNativeCliCommand,
    program: Option<PathBuf>,
    current_directory: Option<PathBuf>,
    environment_overrides: &BTreeMap<OsString, OsString>,
    argument_overrides: &BTreeMap<usize, OsString>,
) -> PreparedPluginNativeCliCommand {
    let mut command =
        CommandSpec::new(program.unwrap_or_else(|| prepared.command.program().into()));
    for (index, argument) in prepared.command.arguments().iter().enumerate() {
        command.arg(
            argument_overrides
                .get(&index)
                .map_or(argument.as_os_str(), OsString::as_os_str),
        );
    }
    if prepared.command.clears_environment() {
        command.clear_env();
    }
    for (key, value) in prepared.command.environment() {
        command.env(
            key,
            environment_overrides
                .get(key)
                .map_or(value.as_os_str(), OsString::as_os_str),
        );
    }
    if let Some(current_directory) = current_directory {
        command.current_dir(current_directory);
    }
    PreparedPluginNativeCliCommand {
        command,
        output: prepared.output,
    }
}

fn exact_executable(path: &Path) -> Result<PathBuf, PluginNativeCliPrepareError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| PluginNativeCliPrepareError::ExecutableUnavailable)?;
    if metadata.file_type().is_symlink() {
        return Err(PluginNativeCliPrepareError::ExecutableIsSymlink);
    }
    if !metadata.is_file() {
        return Err(PluginNativeCliPrepareError::ExecutableIsNotFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(PluginNativeCliPrepareError::ExecutableIsNotRunnable);
        }
    }
    fs::canonicalize(path).map_err(|_| PluginNativeCliPrepareError::ExecutableUnavailable)
}

fn exact_directory(
    path: &Path,
    unavailable: PluginNativeCliPrepareError,
    symlink: PluginNativeCliPrepareError,
    wrong_type: PluginNativeCliPrepareError,
) -> Result<PathBuf, PluginNativeCliPrepareError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable.clone())?;
    if metadata.file_type().is_symlink() {
        return Err(symlink);
    }
    if !metadata.is_dir() {
        return Err(wrong_type);
    }
    fs::canonicalize(path).map_err(|_| unavailable)
}

fn resolve_package_directory(
    package_root: &Path,
    resource: &PluginResourcePathV2,
) -> Result<PathBuf, PluginNativeCliPrepareError> {
    let relative = resource
        .as_str()
        .strip_prefix("./")
        .expect("PluginResourcePathV2 always has a ./ prefix");
    let mut candidate = package_root.to_path_buf();
    for segment in relative.split('/') {
        candidate.push(segment);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| PluginNativeCliPrepareError::ResourceUnavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(PluginNativeCliPrepareError::ResourceIsSymlink);
        }
        if !metadata.is_dir() {
            return Err(PluginNativeCliPrepareError::ResourceIsNotDirectory);
        }
    }
    let resolved = fs::canonicalize(candidate)
        .map_err(|_| PluginNativeCliPrepareError::ResourceUnavailable)?;
    if !resolved.starts_with(package_root) {
        return Err(PluginNativeCliPrepareError::ResourceEscapedPackage);
    }
    Ok(resolved)
}

pub fn resolve_plugin_native_package_resource(
    context: &PluginNativeCliHostContext<'_>,
    resource: &PluginResourcePathV2,
) -> Result<PathBuf, PluginNativeCliPrepareError> {
    let package_root = exact_directory(
        context.package_root,
        PluginNativeCliPrepareError::PackageRootUnavailable,
        PluginNativeCliPrepareError::PackageRootIsSymlink,
        PluginNativeCliPrepareError::PackageRootIsNotDirectory,
    )?;
    resolve_package_directory(&package_root, resource)
}

fn resolve_physical_target(
    context: &PluginNativeCliHostContext<'_>,
    key: &PhysicalTargetKeyV2,
) -> Result<PathBuf, PluginNativeCliPrepareError> {
    let path = context
        .physical_targets
        .get(key)
        .ok_or_else(|| PluginNativeCliPrepareError::PhysicalTargetMissing { key: key.clone() })?;
    exact_directory(
        path,
        PluginNativeCliPrepareError::PhysicalTargetUnavailable { key: key.clone() },
        PluginNativeCliPrepareError::PhysicalTargetIsSymlink { key: key.clone() },
        PluginNativeCliPrepareError::PhysicalTargetIsNotDirectory { key: key.clone() },
    )
}

pub fn resolve_plugin_native_physical_target(
    context: &PluginNativeCliHostContext<'_>,
    key: &PhysicalTargetKeyV2,
) -> Result<PathBuf, PluginNativeCliPrepareError> {
    resolve_physical_target(context, key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{
        compile_agent_native_plugin_cli_invocation, AgentAdapterIdV2, AgentInstallScopeV2,
        AgentIntegrationIdV2, AgentNativeMarketplaceNameV2, AgentNativePluginCliCommandV2,
        AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
        AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
        AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PluginApplyStepV2,
    };
    use std::ffi::OsStr;

    fn executable(path: &Path) {
        fs::write(path, b"fixture").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    fn selector() -> AgentNativePluginSelectorV2 {
        AgentNativePluginSelectorV2 {
            plugin: AgentNativePluginNameV2::new("dure-beads").unwrap(),
            marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
        }
    }

    fn invocation(
        target: AgentNativePluginRegistrationTargetV2,
        command: AgentNativePluginCliCommandV2,
    ) -> AgentNativePluginCliInvocationV2 {
        compile_agent_native_plugin_cli_invocation(&PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new("codex").unwrap(),
            adapter: AgentAdapterIdV2::new("codex").unwrap(),
            executable: AgentNativePluginExecutableV2::Codex,
            cli_version: PluginVersionV2::new("1.2.3").unwrap(),
            selector: selector(),
            registration_target: target,
            command,
        })
        .unwrap()
    }

    #[test]
    fn prepares_exact_executable_resource_profile_and_neutral_directory() {
        let temp = tempfile::tempdir().unwrap();
        let executable_path = temp.path().join("codex");
        let package = temp.path().join("package");
        let marketplace = package.join("agents/codex");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        executable(&executable_path);
        fs::create_dir_all(&marketplace).unwrap();
        fs::create_dir(&neutral).unwrap();
        fs::create_dir(&profile).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("codex-profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.2.3").unwrap();
        let invocation = invocation(
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: profile_key,
            },
            AgentNativePluginCliCommandV2::AddMarketplace {
                source: AgentNativePluginMarketplaceSourceV2 {
                    resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
                },
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        );

        let prepared = prepare_plugin_native_cli_command(
            &invocation,
            &PluginNativeCliHostContext {
                executable: AgentNativePluginExecutableV2::Codex,
                executable_path: &executable_path,
                executable_version: &version,
                package_root: &package,
                neutral_working_directory: &neutral,
                physical_targets: &targets,
            },
        )
        .unwrap();
        let command = prepared.command();

        assert_eq!(
            command.program(),
            fs::canonicalize(executable_path).unwrap()
        );
        assert_eq!(
            command.arguments()[3],
            fs::canonicalize(marketplace).unwrap()
        );
        assert_eq!(
            command.current_directory(),
            Some(fs::canonicalize(neutral).unwrap().as_path())
        );
        assert!(command.clears_environment());
        assert_eq!(command.environment().len(), 1);
        assert_eq!(command.environment()[0].0, OsStr::new("CODEX_HOME"));
        assert_eq!(
            command.environment()[0].1,
            fs::canonicalize(profile).unwrap()
        );
        for hostile in [
            "PATH",
            "CLAUDE_CONFIG_DIR",
            "CODEX_SQLITE_HOME",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "OPENAI_API_KEY",
        ] {
            assert!(
                command
                    .environment()
                    .iter()
                    .all(|(name, _)| name != hostile),
                "hostile ambient variable {hostile} must not be reintroduced after env_clear"
            );
        }
    }

    #[test]
    fn non_resource_commands_do_not_depend_on_the_package_and_recheck_executable_identity() {
        let temp = tempfile::tempdir().unwrap();
        let executable_path = temp.path().join("codex");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        executable(&executable_path);
        fs::create_dir(&neutral).unwrap();
        fs::create_dir(&profile).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("codex-profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.2.3").unwrap();
        let invocation = invocation(
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: profile_key,
            },
            AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector(),
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        );
        let context = PluginNativeCliHostContext {
            executable: AgentNativePluginExecutableV2::Codex,
            executable_path: &executable_path,
            executable_version: &version,
            package_root: &temp.path().join("missing-package"),
            neutral_working_directory: &neutral,
            physical_targets: &targets,
        };

        assert!(prepare_plugin_native_cli_command(&invocation, &context).is_ok());
        assert_eq!(
            prepare_plugin_native_cli_command(
                &invocation,
                &PluginNativeCliHostContext {
                    executable: AgentNativePluginExecutableV2::Claude,
                    ..context
                },
            )
            .unwrap_err(),
            PluginNativeCliPrepareError::ExecutableIdentityChanged
        );
    }

    #[test]
    fn classifies_host_failures_without_retaining_output() {
        let failed = classify_execution(Err(CommandFailure::Spawn));
        assert_eq!(
            failed.outcome(),
            &PluginNativeCommandOutcomeV2::HostFailed {
                stage: PluginNativeCommandHostFailureV2::Spawn,
            }
        );
        assert!(failed.stdout().is_empty());

        let timed_out = classify_execution(Err(CommandFailure::Timeout(
            hebbian_bounded_process::TimeoutStage::ProcessExit,
        )));
        assert_eq!(timed_out.outcome(), &PluginNativeCommandOutcomeV2::TimedOut);
        assert!(timed_out.stdout().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn executes_only_a_prepared_bounded_command() {
        let temp = tempfile::tempdir().unwrap();
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        fs::create_dir(&neutral).unwrap();
        fs::create_dir(&profile).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("codex-profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile)]);
        let version = PluginVersionV2::new("1.2.3").unwrap();
        let invocation = invocation(
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: profile_key,
            },
            AgentNativePluginCliCommandV2::ListMarketplaces {
                output: AgentNativePluginCliOutputV2::Json,
            },
        );

        for (program, expected) in [
            ("/usr/bin/true", PluginNativeCommandOutcomeV2::Succeeded),
            (
                "/usr/bin/false",
                PluginNativeCommandOutcomeV2::ExitedNonzero { exit_code: Some(1) },
            ),
        ] {
            let executable_path = fs::canonicalize(program).unwrap();
            let prepared = prepare_plugin_native_cli_command(
                &invocation,
                &PluginNativeCliHostContext {
                    executable: AgentNativePluginExecutableV2::Codex,
                    executable_path: &executable_path,
                    executable_version: &version,
                    package_root: &temp.path().join("missing-package"),
                    neutral_working_directory: &neutral,
                    physical_targets: &targets,
                },
            )
            .unwrap();
            assert_eq!(prepared.output(), &AgentNativePluginCliOutputV2::Json);

            let execution = execute_prepared_plugin_native_cli_command(&prepared);
            assert_eq!(execution.outcome(), &expected);
            assert!(execution.stdout().is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_resource_and_target_symlinks_before_process_creation() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let executable_path = temp.path().join("codex");
        let package = temp.path().join("package");
        let outside = temp.path().join("outside");
        let neutral = temp.path().join("neutral");
        let profile = temp.path().join("profile");
        executable(&executable_path);
        fs::create_dir_all(package.join("agents")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::create_dir(&neutral).unwrap();
        fs::create_dir(&profile).unwrap();
        symlink(&outside, package.join("agents/codex")).unwrap();
        let profile_key = PhysicalTargetKeyV2::new("codex-profile").unwrap();
        let targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        let version = PluginVersionV2::new("1.2.3").unwrap();
        let invocation = invocation(
            AgentNativePluginRegistrationTargetV2::ManagedProfile {
                profile_root_key: profile_key,
            },
            AgentNativePluginCliCommandV2::AddMarketplace {
                source: AgentNativePluginMarketplaceSourceV2 {
                    resource: PluginResourcePathV2::new("./agents/codex").unwrap(),
                },
                scope: AgentInstallScopeV2::Managed,
                output: AgentNativePluginCliOutputV2::Json,
            },
        );

        assert_eq!(
            prepare_plugin_native_cli_command(
                &invocation,
                &PluginNativeCliHostContext {
                    executable: AgentNativePluginExecutableV2::Codex,
                    executable_path: &executable_path,
                    executable_version: &version,
                    package_root: &package,
                    neutral_working_directory: &neutral,
                    physical_targets: &targets,
                },
            )
            .unwrap_err(),
            PluginNativeCliPrepareError::ResourceIsSymlink
        );

        fs::remove_file(package.join("agents/codex")).unwrap();
        fs::create_dir(package.join("agents/codex")).unwrap();
        fs::remove_dir(&profile).unwrap();
        symlink(&outside, &profile).unwrap();
        assert_eq!(
            prepare_plugin_native_cli_command(
                &invocation,
                &PluginNativeCliHostContext {
                    executable: AgentNativePluginExecutableV2::Codex,
                    executable_path: &executable_path,
                    executable_version: &version,
                    package_root: &package,
                    neutral_working_directory: &neutral,
                    physical_targets: &targets,
                },
            )
            .unwrap_err(),
            PluginNativeCliPrepareError::PhysicalTargetIsSymlink {
                key: PhysicalTargetKeyV2::new("codex-profile").unwrap(),
            }
        );
    }
}
