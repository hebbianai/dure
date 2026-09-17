#![cfg(unix)]

use crate::plugin_native_cli::PluginNativeCliHostContext;
use crate::plugin_catalog::bundled_plugin_registry;
use crate::plugin_native_cli_inspect::{
    inspect_bound_plugin_native_cli_target, PluginNativeCliInspection,
};
use crate::plugin_package_materialization::{
    materialize_registered_plugin_package, open_existing_registered_plugin_package,
    revalidate_registered_plugin_package_lease, MaterializedPluginPackage,
    PluginPackageMaterializationReceiptV1,
};
use crate::plugin_native_target_binding::{
    execute_bound_plugin_native_cli_command,
    execute_bound_plugin_native_cli_command_with_pre_exec_barrier,
    prepare_bound_plugin_native_cli_command_with_package_root_lease,
    resolve_plugin_native_target_leases, PluginNativeTargetBindingAuthority,
    PluginNativeTargetBindingHostError, PluginNativeTargetExecutionLease,
    PluginNativeTargetExecutionLeaseDisposition, PluginNativeTargetLeases,
};
use dure_app::{
    compile_agent_native_plugin_cli_invocation, AgentAdapterIdV2, AgentInstallScopeV2,
    AgentIntegrationIdV2, AgentNativeMarketplaceNameV2, AgentNativePluginCliCommandV2,
    AgentNativePluginCliOutputV2, AgentNativePluginExecutableV2,
    AgentNativePluginMarketplaceSourceV2, AgentNativePluginNameV2,
    AgentNativePluginRegistrationTargetV2, AgentNativePluginSelectorV2, PhysicalTargetKeyV2,
    PluginApplyStepV2, PluginNativeCommandOutcomeV2, PluginNativeInstallationStateV2,
    PluginNativeMarketplaceStateV2, PluginNativeTargetStateV2, PluginResourcePathV2,
    PluginVersionV2,
};
use hebbian_bounded_process::unix_pre_exec_barrier;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const CONFORMANCE_ROOT_ENV: &str = "DURE_QA_PROVIDER_CONFORMANCE_ROOT";
const PACKAGE_ROOT_ENV: &str = "DURE_QA_PROVIDER_PACKAGE_ROOT";
const PACKAGE_EVIDENCE_PREFIX: &str = "DURE_QA_EMBEDDED_PACKAGE_EVIDENCE:";
const CODEX_BIN_ENV: &str = "DURE_QA_CODEX_BIN";
const CLAUDE_BIN_ENV: &str = "DURE_QA_CLAUDE_BIN";
const CODEX_VERSION: &str = "0.146.0";
const CLAUDE_VERSION: &str = "2.1.220";
const BEADS_PLUGIN_VERSION: &str = "0.2.1";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const RECEIPT_FILE: &str = "provider-conformance-receipt.json";
const LIFECYCLE_OPERATIONS: [&str; 8] = [
    "list_marketplaces",
    "add_marketplace",
    "install_plugin",
    "list_plugins",
    "remove_plugin",
    "list_plugins",
    "remove_marketplace",
    "list_marketplaces",
];

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CODEX_SHA256: &str = "ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const CLAUDE_SHA256: &str = "8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CODEX_SHA256: &str = "2e863156ed35ecc5253b1e2f907a9143077b9f7cb51942070c61996471ff6e04";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const CLAUDE_SHA256: &str = "674f61f20ff306f3100cf9200e4c36c4b70278b5bef2884549819b942a89c863";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const CODEX_SHA256: &str = "unsupported-platform";
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
const CLAUDE_SHA256: &str = "unsupported-platform";

#[derive(Clone)]
struct ProviderObservation {
    executable: AgentNativePluginExecutableV2,
    path: PathBuf,
    version: PluginVersionV2,
    sha256: String,
    identity: ExecutableIdentity,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ExecutableIdentity {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

impl ProviderObservation {
    fn revalidate_identity(&self) {
        assert_eq!(executable_identity(&self.path), self.identity);
    }

    fn revalidate_hash(&self) {
        self.revalidate_identity();
        assert_eq!(file_sha256(&self.path), self.sha256);
        self.revalidate_identity();
    }
}

#[derive(Clone)]
struct CaseSpec {
    provider: ProviderObservation,
    scope: AgentInstallScopeV2,
}

impl CaseSpec {
    fn label(&self) -> &'static str {
        match (&self.provider.executable, &self.scope) {
            (AgentNativePluginExecutableV2::Codex, AgentInstallScopeV2::Managed) => "codex-managed",
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => "claude-user",
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::Project) => {
                "claude-project"
            }
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::Local) => "claude-local",
            _ => panic!("unsupported provider conformance case"),
        }
    }

    fn target_name(&self) -> &'static str {
        match (&self.provider.executable, &self.scope) {
            (AgentNativePluginExecutableV2::Codex, AgentInstallScopeV2::Managed) => {
                "managed_profile"
            }
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => "user",
            (AgentNativePluginExecutableV2::Claude, _) => "workspace",
            _ => panic!("unsupported provider conformance target"),
        }
    }

    fn id(&self) -> &'static str {
        match (&self.provider.executable, &self.scope) {
            (AgentNativePluginExecutableV2::Codex, AgentInstallScopeV2::Managed) => "codex_managed",
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => "claude_user",
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::Project) => {
                "claude_project"
            }
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::Local) => "claude_local",
            _ => panic!("unsupported provider conformance case id"),
        }
    }

    fn scope_name(&self) -> &'static str {
        match self.scope {
            AgentInstallScopeV2::Managed => "managed",
            AgentInstallScopeV2::User => "user",
            AgentInstallScopeV2::Project => "project",
            AgentInstallScopeV2::Local => "local",
        }
    }

    fn route_name(&self) -> &'static str {
        match (&self.provider.executable, &self.scope) {
            (AgentNativePluginExecutableV2::Codex, AgentInstallScopeV2::Managed) => {
                #[cfg(target_os = "macos")]
                {
                    "macos_codex_volume_file_id_exec_fchdir_relative_home_package_sealed_lexical_anchor_v3"
                }
                #[cfg(target_os = "linux")]
                {
                    "linux_codex_fchdir_relative_home_package_procfd_v2"
                }
                #[cfg(not(any(target_os = "macos", target_os = "linux")))]
                {
                    "unsupported_platform"
                }
            }
            #[cfg(target_os = "macos")]
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => {
                "macos_claude_volume_file_id_exec_home_package_sealed_lexical_anchor_v3"
            }
            #[cfg(target_os = "macos")]
            (AgentNativePluginExecutableV2::Claude, _) => {
                "macos_claude_volume_file_id_exec_home_workspace_fchdir_package_sealed_lexical_anchor_v3"
            }
            #[cfg(target_os = "linux")]
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => {
                "linux_claude_procfd_home_package_procfd_v2"
            }
            #[cfg(target_os = "linux")]
            (AgentNativePluginExecutableV2::Claude, _) => {
                "linux_claude_procfd_home_workspace_fchdir_package_procfd_v2"
            }
            _ => panic!("unsupported provider conformance route"),
        }
    }
}

struct Fixture<'a> {
    root: PathBuf,
    package_root: PathBuf,
    neutral: PathBuf,
    profile: PathBuf,
    workspace: Option<PathBuf>,
    profile_key: PhysicalTargetKeyV2,
    workspace_key: Option<PhysicalTargetKeyV2>,
    targets: BTreeMap<PhysicalTargetKeyV2, PathBuf>,
    provider: ProviderObservation,
    scope: AgentInstallScopeV2,
    authority: PluginNativeTargetBindingAuthority,
    route_generation: &'static str,
    package_root_lease: &'a File,
}

impl<'a> Fixture<'a> {
    fn new(
        state_root: &Path,
        materialized: &'a MaterializedPluginPackage,
        case: &CaseSpec,
        suffix: &str,
    ) -> Self {
        let root = state_root.join(format!("{}-{suffix}", case.label()));
        create_owner_only_directory(&root);
        let neutral = root.join("neutral");
        let profile = root.join("profile");
        let authority_root = root.join("authority");
        for directory in [&neutral, &profile, &authority_root] {
            create_owner_only_directory(directory);
        }
        let workspace = matches!(
            case.scope,
            AgentInstallScopeV2::Project | AgentInstallScopeV2::Local
        )
        .then(|| {
            let path = root.join("workspace");
            create_owner_only_directory(&path);
            path
        });
        let profile_key = PhysicalTargetKeyV2::new("profile").expect("valid profile key");
        let workspace_key = workspace
            .as_ref()
            .map(|_| PhysicalTargetKeyV2::new("workspace").expect("valid workspace key"));
        let mut targets = BTreeMap::from([(profile_key.clone(), profile.clone())]);
        if let (Some(key), Some(path)) = (&workspace_key, &workspace) {
            targets.insert(key.clone(), path.clone());
        }
        let authority = PluginNativeTargetBindingAuthority::open_or_create(&authority_root)
            .expect("create exact target-binding authority");
        Self {
            root,
            package_root: materialized.package_root().to_path_buf(),
            neutral,
            profile,
            workspace,
            profile_key,
            workspace_key,
            targets,
            provider: case.provider.clone(),
            scope: case.scope.clone(),
            authority,
            route_generation: case.route_name(),
            package_root_lease: materialized.package_root_lease(),
        }
    }

    fn host(&self) -> PluginNativeCliHostContext<'_> {
        PluginNativeCliHostContext {
            executable: self.provider.executable.clone(),
            executable_path: &self.provider.path,
            executable_version: &self.provider.version,
            package_root: &self.package_root,
            neutral_working_directory: &self.neutral,
            physical_targets: &self.targets,
        }
    }

    fn registration_target(&self) -> AgentNativePluginRegistrationTargetV2 {
        match (&self.provider.executable, &self.scope) {
            (AgentNativePluginExecutableV2::Codex, AgentInstallScopeV2::Managed) => {
                AgentNativePluginRegistrationTargetV2::ManagedProfile {
                    profile_root_key: self.profile_key.clone(),
                }
            }
            (AgentNativePluginExecutableV2::Claude, AgentInstallScopeV2::User) => {
                AgentNativePluginRegistrationTargetV2::User {
                    profile_root_key: self.profile_key.clone(),
                }
            }
            (
                AgentNativePluginExecutableV2::Claude,
                AgentInstallScopeV2::Project | AgentInstallScopeV2::Local,
            ) => AgentNativePluginRegistrationTargetV2::Workspace {
                profile_root_key: self.profile_key.clone(),
                workspace_root_key: self
                    .workspace_key
                    .clone()
                    .expect("workspace scope has a workspace key"),
            },
            _ => panic!("invalid provider registration target"),
        }
    }

    fn source(&self) -> AgentNativePluginMarketplaceSourceV2 {
        let resource = match self.provider.executable {
            AgentNativePluginExecutableV2::Codex => "./agents/codex",
            AgentNativePluginExecutableV2::Claude => "./agents/claude",
        };
        AgentNativePluginMarketplaceSourceV2 {
            resource: PluginResourcePathV2::new(resource).expect("valid provider source"),
        }
    }

    fn step(&self, command: AgentNativePluginCliCommandV2) -> PluginApplyStepV2 {
        let adapter = self.provider.executable.as_str();
        PluginApplyStepV2 {
            integration_id: AgentIntegrationIdV2::new(format!("dure.beads.{adapter}"))
                .expect("valid integration id"),
            adapter: AgentAdapterIdV2::new(adapter).expect("valid adapter id"),
            executable: self.provider.executable.clone(),
            cli_version: self.provider.version.clone(),
            selector: selector(),
            registration_target: self.registration_target(),
            command,
        }
    }

    fn mutation_output(&self) -> AgentNativePluginCliOutputV2 {
        match self.provider.executable {
            AgentNativePluginExecutableV2::Codex => AgentNativePluginCliOutputV2::Json,
            AgentNativePluginExecutableV2::Claude => AgentNativePluginCliOutputV2::HumanText,
        }
    }

    fn mutation_step(&self, mutation: Mutation) -> PluginApplyStepV2 {
        let output = self.mutation_output();
        let command = match mutation {
            Mutation::AddMarketplace => AgentNativePluginCliCommandV2::AddMarketplace {
                source: self.source(),
                scope: self.scope.clone(),
                output,
            },
            Mutation::InstallPlugin => AgentNativePluginCliCommandV2::InstallPlugin {
                selector: selector(),
                scope: self.scope.clone(),
                output,
            },
            Mutation::RemovePlugin => AgentNativePluginCliCommandV2::RemovePlugin {
                selector: selector(),
                scope: self.scope.clone(),
                preserve_data: true,
                output,
            },
            Mutation::RemoveMarketplace => AgentNativePluginCliCommandV2::RemoveMarketplace {
                marketplace: selector().marketplace,
                scope: self.scope.clone(),
                output,
            },
        };
        self.step(command)
    }

    fn list_marketplaces_step(&self) -> PluginApplyStepV2 {
        self.step(AgentNativePluginCliCommandV2::ListMarketplaces {
            output: AgentNativePluginCliOutputV2::Json,
        })
    }

    fn list_plugins_step(&self) -> PluginApplyStepV2 {
        self.step(AgentNativePluginCliCommandV2::ListPlugins {
            marketplace: selector().marketplace,
            include_available: false,
            output: AgentNativePluginCliOutputV2::Json,
        })
    }

    fn retained_targets(&self) -> Vec<(&Path, PathBuf)> {
        let mut targets = vec![(self.profile.as_path(), self.root.join("profile.retained"))];
        if let Some(workspace) = &self.workspace {
            targets.push((workspace.as_path(), self.root.join("workspace.retained")));
        }
        targets
    }
}

#[derive(Clone, Copy, Debug)]
enum Mutation {
    AddMarketplace,
    InstallPlugin,
    RemovePlugin,
    RemoveMarketplace,
}

impl Mutation {
    const ALL: [Self; 4] = [
        Self::AddMarketplace,
        Self::InstallPlugin,
        Self::RemovePlugin,
        Self::RemoveMarketplace,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::AddMarketplace => "add_marketplace",
            Self::InstallPlugin => "install_plugin",
            Self::RemovePlugin => "remove_plugin",
            Self::RemoveMarketplace => "remove_marketplace",
        }
    }

    fn expected_before(self) -> (bool, bool) {
        match self {
            Self::AddMarketplace => (false, false),
            Self::InstallPlugin => (true, false),
            Self::RemovePlugin => (true, true),
            Self::RemoveMarketplace => (true, false),
        }
    }

    fn expected_after(self) -> (bool, bool) {
        match self {
            Self::AddMarketplace => (true, false),
            Self::InstallPlugin => (true, true),
            Self::RemovePlugin => (true, false),
            Self::RemoveMarketplace => (false, false),
        }
    }
}

fn selector() -> AgentNativePluginSelectorV2 {
    AgentNativePluginSelectorV2 {
        plugin: AgentNativePluginNameV2::new("dure-beads").expect("valid plugin name"),
        marketplace: AgentNativeMarketplaceNameV2::new("dure-bundled")
            .expect("valid marketplace name"),
    }
}

fn bundled_package() -> &'static dure_app::RegisteredPluginPackageV2 {
    bundled_plugin_registry()
        .package(&dure_app::PluginIdV2::new("dure.beads").expect("valid bundled plugin ID"))
        .expect("bundled Beads package is registered")
}

#[test]
#[ignore = "runs exact pinned native provider CLIs inside the external networkless QA harness"]
fn materialize_bundled_package_for_conformance() {
    let package_state_root = exact_owner_only_root(PACKAGE_ROOT_ENV);
    let package = bundled_plugin_registry()
        .package(&dure_app::PluginIdV2::new("dure.beads").expect("valid bundled plugin ID"))
        .expect("bundled Beads package is registered");
    let materialized = materialize_registered_plugin_package(&package_state_root, package)
        .expect("materialize exact embedded Beads package");
    materialized
        .revalidate(package)
        .expect("revalidate exact embedded Beads package");
    let receipt = materialized.receipt();
    let evidence = json!({
        "schema_version": receipt.schema_version(),
        "plugin_id": receipt.plugin_id().as_str(),
        "plugin_version": receipt.plugin_version().as_str(),
        "embedded_authority_sha256": receipt.embedded_authority_sha256().as_str(),
        "file_manifest_sha256": receipt.file_manifest_sha256().as_str(),
        "root_device": receipt.root_identity().0.to_string(),
        "root_inode": receipt.root_identity().1.to_string(),
        "source_sha256": format!("sha256:{}", tree_sha256(materialized.package_root())),
    });
    println!(
        "{PACKAGE_EVIDENCE_PREFIX}{}",
        serde_json::to_string(&evidence).expect("serialize embedded package evidence")
    );
}

#[test]
#[ignore = "runs exact pinned native provider CLIs inside the external networkless QA harness"]
fn pinned_provider_lifecycle_conforms() {
    assert_supported_platform();
    let state_root = exact_owner_only_root(CONFORMANCE_ROOT_ENV);
    let package_state_root = exact_owner_only_root(PACKAGE_ROOT_ENV);
    let package = bundled_plugin_registry()
        .package(&dure_app::PluginIdV2::new("dure.beads").expect("valid bundled plugin ID"))
        .expect("bundled Beads package is registered");
    let materialized = open_existing_registered_plugin_package(&package_state_root, package)
        .expect("open exact pre-materialized embedded Beads package");
    assert_package_sandbox_read_only(&materialized, package);
    let package_root = materialized.package_root().to_path_buf();
    let source_sha256 = tree_sha256(&package_root);
    let codex = observe_provider(
        CODEX_BIN_ENV,
        AgentNativePluginExecutableV2::Codex,
        CODEX_VERSION,
        CODEX_SHA256,
        &state_root,
    );
    let claude = observe_provider(
        CLAUDE_BIN_ENV,
        AgentNativePluginExecutableV2::Claude,
        CLAUDE_VERSION,
        CLAUDE_SHA256,
        &state_root,
    );
    let cases = [
        CaseSpec {
            provider: codex.clone(),
            scope: AgentInstallScopeV2::Managed,
        },
        CaseSpec {
            provider: claude.clone(),
            scope: AgentInstallScopeV2::User,
        },
    ];

    for case in &cases {
        run_lifecycle(&state_root, &materialized, case, &source_sha256);
        for mutation in Mutation::ALL {
            run_inode_swap_mutation(
                &state_root,
                &materialized,
                case,
                mutation,
                &source_sha256,
            );
        }
    }
    materialized
        .revalidate(package)
        .expect("revalidate sealed embedded package after provider lifecycle");
    assert_eq!(
        tree_sha256(&package_root),
        source_sha256,
        "provider lifecycle changed the immutable beads package source"
    );
    write_receipt(
        &state_root,
        &package_root,
        &source_sha256,
        &codex,
        &claude,
        &cases,
        materialized.receipt(),
    );
}

fn assert_supported_platform() {
    assert!(
        cfg!(all(target_os = "macos", target_arch = "aarch64")),
        "provider conformance has no fail-closed pins for {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
}

fn exact_owner_only_root(environment_name: &str) -> PathBuf {
    let supplied = std::env::var_os(environment_name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{environment_name} is required"));
    assert!(
        supplied.is_absolute(),
        "{environment_name} must be absolute"
    );
    let metadata =
        fs::symlink_metadata(&supplied).unwrap_or_else(|_| panic!("{environment_name} must exist"));
    assert!(!metadata.file_type().is_symlink());
    assert!(metadata.is_dir());
    assert_eq!(metadata.uid(), effective_uid());
    assert_eq!(metadata.mode() & 0o777, 0o700);
    let canonical = fs::canonicalize(&supplied).expect("canonical conformance root");
    assert_eq!(supplied, canonical, "{environment_name} must be exact");
    canonical
}

fn assert_package_sandbox_read_only(
    materialized: &MaterializedPluginPackage,
    package: &dure_app::RegisteredPluginPackageV2,
) {
    let manifest = materialized.package_root().join("dure-plugin.json");
    let write_error = OpenOptions::new()
        .write(true)
        .open(&manifest)
        .expect_err("sealed package manifest must reject provider writes");
    assert_eq!(write_error.kind(), std::io::ErrorKind::PermissionDenied);

    let retained = materialized
        .package_root()
        .parent()
        .expect("materialized package has a generation parent")
        .join("package.sandbox-rename-probe");
    match fs::rename(materialized.package_root(), &retained) {
        Ok(()) => {
            fs::rename(&retained, materialized.package_root())
                .expect("restore unexpectedly writable package root");
            panic!("provider sandbox allowed package-root rename");
        }
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied),
    }

    let delete_error = fs::remove_file(&manifest)
        .expect_err("sealed package manifest must reject provider deletion");
    assert_eq!(delete_error.kind(), std::io::ErrorKind::PermissionDenied);
    materialized
        .revalidate(package)
        .expect("read-only probes preserve the exact embedded package");
}

fn exact_provider_executable(environment_name: &str) -> PathBuf {
    let supplied = std::env::var_os(environment_name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{environment_name} is required"));
    assert!(
        supplied.is_absolute(),
        "{environment_name} must be absolute"
    );
    let metadata =
        fs::symlink_metadata(&supplied).unwrap_or_else(|_| panic!("{environment_name} must exist"));
    assert!(!metadata.file_type().is_symlink());
    assert!(metadata.is_file());
    assert!(metadata.uid() == effective_uid() || metadata.uid() == 0);
    assert_ne!(metadata.mode() & 0o100, 0, "provider must be executable");
    assert_eq!(
        metadata.mode() & 0o022,
        0,
        "provider must not be writable by others"
    );
    let canonical = fs::canonicalize(&supplied).expect("canonical provider executable");
    assert_eq!(supplied, canonical, "{environment_name} must be exact");
    canonical
}

fn observe_provider(
    environment_name: &str,
    executable: AgentNativePluginExecutableV2,
    expected_version: &str,
    expected_sha256: &str,
    state_root: &Path,
) -> ProviderObservation {
    let path = exact_provider_executable(environment_name);
    let identity = executable_identity(&path);
    let sha256 = file_sha256(&path);
    assert_eq!(executable_identity(&path), identity);
    assert_eq!(
        sha256, expected_sha256,
        "{environment_name} SHA-256 changed"
    );
    let version_root = state_root.join(format!("{}-version", executable.as_str()));
    create_owner_only_directory(&version_root);
    #[cfg(target_os = "macos")]
    let version_program = PathBuf::from(format!("/.vol/{}/{}", identity.device, identity.inode));
    #[cfg(not(target_os = "macos"))]
    let version_program = path.clone();
    assert_eq!(executable_identity(&version_program), identity);
    assert_eq!(file_sha256(&version_program), sha256);
    let mut command = Command::new(&version_program);
    command
        .arg("--version")
        .env_clear()
        .current_dir(&version_root);
    match executable {
        AgentNativePluginExecutableV2::Codex => {
            command.env("CODEX_HOME", &version_root);
        }
        AgentNativePluginExecutableV2::Claude => {
            command.env("HOME", &version_root);
        }
    }
    let output = command
        .output()
        .expect("execute exact provider version probe");
    assert!(output.status.success(), "provider version probe failed");
    let raw = if output.stdout.is_empty() {
        &output.stderr
    } else {
        &output.stdout
    };
    let version_text = String::from_utf8(raw.clone())
        .expect("provider version is UTF-8")
        .trim()
        .to_owned();
    let observed_version = match executable {
        AgentNativePluginExecutableV2::Codex => version_text.strip_prefix("codex-cli "),
        AgentNativePluginExecutableV2::Claude => version_text.split_whitespace().next(),
    }
    .expect("provider version output has its pinned shape");
    assert_eq!(
        observed_version, expected_version,
        "provider version changed"
    );
    assert_eq!(executable_identity(&path), identity);
    assert_eq!(file_sha256(&path), sha256);
    assert_eq!(executable_identity(&path), identity);
    ProviderObservation {
        executable,
        path,
        version: PluginVersionV2::new(observed_version)
            .expect("observed provider version is valid"),
        sha256,
        identity,
    }
}

fn run_lifecycle(
    state_root: &Path,
    materialized: &MaterializedPluginPackage,
    case: &CaseSpec,
    source_sha256: &str,
) {
    let fixture = Fixture::new(state_root, materialized, case, "lifecycle");
    let steps = vec![
        fixture.list_marketplaces_step(),
        fixture.mutation_step(Mutation::AddMarketplace),
        fixture.mutation_step(Mutation::InstallPlugin),
        fixture.list_plugins_step(),
        fixture.mutation_step(Mutation::RemovePlugin),
        fixture.list_plugins_step(),
        fixture.mutation_step(Mutation::RemoveMarketplace),
        fixture.list_marketplaces_step(),
    ];
    let host = fixture.host();
    let leases = resolve_plugin_native_target_leases(&steps, &host, &fixture.authority)
        .expect("resolve lifecycle target leases");
    let _execution_lease = acquire_execution_lease(&leases, "lifecycle");
    let source = fixture.source();

    assert_expected_state(
        &inspect_state(&fixture, &steps[1], &source, &host, &leases),
        &fixture.scope,
        false,
        false,
    );
    execute_step(&fixture, &steps[0], &host, &leases);
    execute_step(&fixture, &steps[1], &host, &leases);
    assert_expected_state(
        &inspect_state(&fixture, &steps[2], &source, &host, &leases),
        &fixture.scope,
        true,
        false,
    );
    execute_step(&fixture, &steps[2], &host, &leases);
    assert_expected_state(
        &inspect_state(&fixture, &steps[4], &source, &host, &leases),
        &fixture.scope,
        true,
        true,
    );
    execute_step(&fixture, &steps[3], &host, &leases);
    execute_step(&fixture, &steps[4], &host, &leases);
    assert_expected_state(
        &inspect_state(&fixture, &steps[6], &source, &host, &leases),
        &fixture.scope,
        true,
        false,
    );
    execute_step(&fixture, &steps[5], &host, &leases);
    execute_step(&fixture, &steps[6], &host, &leases);
    assert_expected_state(
        &inspect_state(&fixture, &steps[1], &source, &host, &leases),
        &fixture.scope,
        false,
        false,
    );
    execute_step(&fixture, &steps[7], &host, &leases);
    materialized.revalidate(bundled_package()).unwrap();
    assert_eq!(tree_sha256(materialized.package_root()), source_sha256);
}

fn inspect_state(
    fixture: &Fixture<'_>,
    step: &PluginApplyStepV2,
    source: &AgentNativePluginMarketplaceSourceV2,
    host: &PluginNativeCliHostContext<'_>,
    leases: &PluginNativeTargetLeases,
) -> PluginNativeTargetStateV2 {
    fixture.provider.revalidate_identity();
    let state = inspect_bound_plugin_native_cli_target(
        PluginNativeCliInspection {
            step,
            marketplace_source: source,
            host,
        },
        leases,
    )
    .expect("inspect stable production provider state")
    .state;
    fixture.provider.revalidate_identity();
    state
}

fn validate_materialized_tree_at_execution_boundary(fixture: &Fixture<'_>) {
    revalidate_registered_plugin_package_lease(fixture.package_root_lease, bundled_package())
        .expect("revalidate exact sealed package at provider execution boundary");
}

fn assert_expected_state(
    state: &PluginNativeTargetStateV2,
    expected_scope: &AgentInstallScopeV2,
    marketplace_present: bool,
    installation_present: bool,
) {
    if marketplace_present {
        assert!(matches!(
            &state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope,
                ..
            } if scope == expected_scope
        ));
    } else {
        assert_eq!(state.marketplace, PluginNativeMarketplaceStateV2::Absent);
    }
    if installation_present {
        assert!(matches!(
            &state.installation,
            PluginNativeInstallationStateV2::Installed {
                version,
                enabled: true,
                scope,
            } if version.as_str() == BEADS_PLUGIN_VERSION && scope == expected_scope
        ));
    } else {
        assert_eq!(state.installation, PluginNativeInstallationStateV2::Absent);
    }
}

fn execute_step(
    fixture: &Fixture<'_>,
    step: &PluginApplyStepV2,
    host: &PluginNativeCliHostContext<'_>,
    leases: &PluginNativeTargetLeases,
) -> Vec<u8> {
    fixture.provider.revalidate_identity();
    validate_materialized_tree_at_execution_boundary(fixture);
    let invocation = compile_agent_native_plugin_cli_invocation(step)
        .expect("compile production provider invocation");
    let prepared = prepare_bound_plugin_native_cli_command_with_package_root_lease(
        &invocation,
        host,
        leases,
        fixture.package_root_lease,
    )
    .expect("prepare production descriptor-bound provider invocation");
    assert_eq!(
        prepared.descriptor_route_generation(),
        fixture.route_generation
    );
    assert_prepared_provider_route(&prepared, &fixture.provider);
    let execution = execute_bound_plugin_native_cli_command(&prepared)
        .expect("execute production descriptor-bound provider invocation");
    assert_prepared_provider_route(&prepared, &fixture.provider);
    fixture.provider.revalidate_identity();
    validate_materialized_tree_at_execution_boundary(fixture);
    assert_eq!(
        execution.outcome(),
        &PluginNativeCommandOutcomeV2::Succeeded,
        "provider command failed: {:?}: {}",
        step.command,
        String::from_utf8_lossy(execution.stdout())
    );
    execution.stdout().to_vec()
}

fn run_inode_swap_mutation(
    state_root: &Path,
    materialized: &MaterializedPluginPackage,
    case: &CaseSpec,
    mutation: Mutation,
    source_sha256: &str,
) {
    let fixture = Fixture::new(state_root, materialized, case, mutation.name());
    seed_mutation_preconditions(&fixture, mutation);
    let step = fixture.mutation_step(mutation);
    let host = fixture.host();
    let leases =
        resolve_plugin_native_target_leases(std::slice::from_ref(&step), &host, &fixture.authority)
            .expect("resolve inode-swap target leases");
    let _execution_lease = acquire_execution_lease(&leases, "inode-swap");
    let source = fixture.source();
    let (marketplace_before, installation_before) = mutation.expected_before();
    assert_expected_state(
        &inspect_state(&fixture, &step, &source, &host, &leases),
        &fixture.scope,
        marketplace_before,
        installation_before,
    );
    let invocation = compile_agent_native_plugin_cli_invocation(&step)
        .expect("compile inode-swap provider invocation");
    validate_materialized_tree_at_execution_boundary(&fixture);
    let prepared = prepare_bound_plugin_native_cli_command_with_package_root_lease(
        &invocation,
        &host,
        &leases,
        fixture.package_root_lease,
    )
    .expect("prepare inode-swap descriptor-bound invocation");
    assert_eq!(
        prepared.descriptor_route_generation(),
        fixture.route_generation
    );
    assert_prepared_provider_route(&prepared, &fixture.provider);
    let targets = fixture.retained_targets();
    let before = targets
        .iter()
        .map(|(original, _)| (directory_identity(original), tree_sha256(original)))
        .collect::<Vec<_>>();
    let (mut controller, barrier) = unix_pre_exec_barrier().expect("create pre-exec barrier");

    fixture.provider.revalidate_identity();
    let output = std::thread::scope(|scope| {
        let child = scope.spawn(|| {
            execute_bound_plugin_native_cli_command_with_pre_exec_barrier(&prepared, barrier)
        });
        let ready = controller
            .wait_until_ready(COMMAND_TIMEOUT)
            .expect("provider reached the exact pre-exec boundary");
        assert!(ready.process_id() > 1);
        for (original, retained) in &targets {
            fs::rename(original, retained).expect("retain exact target inode under a new name");
            create_owner_only_directory(original);
        }
        assert!(matches!(
            leases.validate(&host),
            Err(PluginNativeTargetBindingHostError::BindingChanged { .. })
        ));
        assert_prepared_provider_route(&prepared, &fixture.provider);
        assert_prepared_provider_hash(&prepared, &fixture.provider);
        controller.release().expect("release exact provider child");
        child
            .join()
            .expect("provider conformance execution thread did not panic")
            .expect("bounded provider execution failed")
    });
    assert_prepared_provider_route(&prepared, &fixture.provider);
    fixture.provider.revalidate_identity();
    assert_eq!(
        output.outcome(),
        &PluginNativeCommandOutcomeV2::Succeeded,
        "{} {} failed with {:?}: {}",
        case.label(),
        mutation.name(),
        output.outcome(),
        String::from_utf8_lossy(output.stdout())
    );

    let mut retained_changed = false;
    for (index, (original, retained)) in targets.iter().enumerate() {
        let retained_identity = directory_identity(retained);
        assert_eq!(retained_identity, before[index].0);
        assert_ne!(directory_identity(original), before[index].0);
        assert!(
            fs::read_dir(original)
                .expect("read decoy target")
                .next()
                .is_none(),
            "provider mutated the same-name decoy {}",
            original.display()
        );
        retained_changed |= tree_sha256(retained) != before[index].1;
        fs::remove_dir(original).expect("remove exact empty same-name decoy");
        fs::rename(retained, original).expect("restore retained target to its exact original path");
        assert_eq!(directory_identity(original), before[index].0);
    }
    assert!(
        retained_changed,
        "{} {} did not mutate a retained target inode",
        case.label(),
        mutation.name()
    );
    leases
        .validate(&host)
        .expect("restored retained targets match their durable bindings");
    let (marketplace_after, installation_after) = mutation.expected_after();
    assert_expected_state(
        &inspect_state(&fixture, &step, &source, &host, &leases),
        &fixture.scope,
        marketplace_after,
        installation_after,
    );
    materialized.revalidate(bundled_package()).unwrap();
    assert_eq!(tree_sha256(materialized.package_root()), source_sha256);
}

fn seed_mutation_preconditions(fixture: &Fixture<'_>, mutation: Mutation) {
    let commands: &[Mutation] = match mutation {
        Mutation::AddMarketplace => &[],
        Mutation::InstallPlugin => &[Mutation::AddMarketplace],
        Mutation::RemovePlugin => &[Mutation::AddMarketplace, Mutation::InstallPlugin],
        Mutation::RemoveMarketplace => &[
            Mutation::AddMarketplace,
            Mutation::InstallPlugin,
            Mutation::RemovePlugin,
        ],
    };
    if commands.is_empty() {
        return;
    }
    let steps = commands
        .iter()
        .map(|command| fixture.mutation_step(*command))
        .collect::<Vec<_>>();
    let host = fixture.host();
    let leases = resolve_plugin_native_target_leases(&steps, &host, &fixture.authority)
        .expect("resolve mutation seed leases");
    let _execution_lease = acquire_execution_lease(&leases, "mutation seed");
    for step in &steps {
        execute_step(fixture, step, &host, &leases);
    }
}

fn acquire_execution_lease<'a>(
    leases: &'a PluginNativeTargetLeases,
    phase: &str,
) -> PluginNativeTargetExecutionLease<'a> {
    match leases
        .try_acquire_execution_lease()
        .unwrap_or_else(|_| panic!("acquire exact {phase} execution lease"))
    {
        PluginNativeTargetExecutionLeaseDisposition::Acquired(lease) => lease,
        PluginNativeTargetExecutionLeaseDisposition::Occupied => {
            panic!("{phase} target execution lease is occupied")
        }
    }
}

fn create_owner_only_directory(path: &Path) {
    fs::create_dir(path).unwrap_or_else(|_| panic!("create directory {}", path.display()));
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .unwrap_or_else(|_| panic!("protect directory {}", path.display()));
}

fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn directory_identity(path: &Path) -> (u64, u64) {
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|_| panic!("read target identity {}", path.display()));
    assert!(metadata.is_dir());
    (metadata.dev(), metadata.ino())
}

fn executable_identity(path: &Path) -> ExecutableIdentity {
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|_| panic!("read provider identity {}", path.display()));
    assert!(metadata.is_file());
    assert!(!metadata.file_type().is_symlink());
    ExecutableIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.size(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
    }
}

fn file_sha256(path: &Path) -> String {
    let mut file = File::open(path).expect("open exact provider executable");
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .expect("stream exact provider executable");
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    format!("{:x}", digest.finalize())
}

fn tree_sha256(root: &Path) -> String {
    let mut entries = Vec::new();
    collect_tree_entries(root, root, &mut entries);
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, kind, contents) in entries {
        digest.update((relative.len() as u64).to_be_bytes());
        digest.update(relative);
        digest.update([kind]);
        digest.update((contents.len() as u64).to_be_bytes());
        digest.update(contents);
    }
    format!("{:x}", digest.finalize())
}

fn collect_tree_entries(root: &Path, directory: &Path, entries: &mut Vec<(Vec<u8>, u8, Vec<u8>)>) {
    let mut children = fs::read_dir(directory)
        .unwrap_or_else(|_| panic!("read source tree {}", directory.display()))
        .map(|entry| entry.expect("read source tree entry").path())
        .collect::<Vec<_>>();
    children.sort();
    for path in children {
        let metadata = fs::symlink_metadata(&path)
            .unwrap_or_else(|_| panic!("read source metadata {}", path.display()));
        assert!(!metadata.file_type().is_symlink(), "tree contains symlink");
        let relative = path
            .strip_prefix(root)
            .expect("tree entry stays below root")
            .as_os_str()
            .as_bytes()
            .to_vec();
        if metadata.is_dir() {
            entries.push((relative, b'd', Vec::new()));
            collect_tree_entries(root, &path, entries);
        } else if metadata.is_file() {
            entries.push((
                relative,
                b'f',
                fs::read(&path).unwrap_or_else(|_| panic!("read tree file {}", path.display())),
            ));
        } else {
            panic!("tree contains unsupported entry {}", path.display());
        }
    }
}

fn write_receipt(
    state_root: &Path,
    package_root: &Path,
    source_sha256: &str,
    codex: &ProviderObservation,
    claude: &ProviderObservation,
    cases: &[CaseSpec],
    materialization: &PluginPackageMaterializationReceiptV1,
) {
    assert_eq!(
        tree_sha256(package_root),
        source_sha256,
        "beads source changed immediately before receipt publication"
    );
    codex.revalidate_hash();
    claude.revalidate_hash();
    let case_receipts = cases
        .iter()
        .map(|case| {
            json!({
                "id": case.id(),
                "provider": case.provider.executable.as_str(),
                "registration_target": case.target_name(),
                "scope": case.scope_name(),
                "route_generation": case.route_name(),
                "lifecycle_operations": LIFECYCLE_OPERATIONS,
                "inode_swap_mutations": Mutation::ALL.map(Mutation::name),
                "status": "passed",
            })
        })
        .collect::<Vec<_>>();
    let receipt = json!({
        "schema_version": 2,
        "host": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "providers": {
            "codex": {
                "version": codex.version.as_str(),
                "executable_sha256": format!("sha256:{}", codex.sha256),
                "status": "passed",
            },
            "claude": {
                "version": claude.version.as_str(),
                "executable_sha256": format!("sha256:{}", claude.sha256),
                "status": "passed",
            },
        },
        "package_materialization": {
            "schema_version": materialization.schema_version(),
            "plugin_id": materialization.plugin_id().as_str(),
            "plugin_version": materialization.plugin_version().as_str(),
            "embedded_authority_sha256": materialization.embedded_authority_sha256().as_str(),
            "file_manifest_sha256": materialization.file_manifest_sha256().as_str(),
            "root_device": materialization.root_identity().0.to_string(),
            "root_inode": materialization.root_identity().1.to_string(),
        },
        "source_sha256": format!("sha256:{source_sha256}"),
        "cases": case_receipts,
        "status": "passed",
    });
    let path = state_root.join(RECEIPT_FILE);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .expect("create provider conformance receipt exactly once");
    let bytes = serde_json::to_vec_pretty(&receipt).expect("serialize conformance receipt");
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .expect("durably write provider conformance receipt");
    let metadata = file.metadata().expect("inspect conformance receipt");
    assert_eq!(metadata.uid(), effective_uid());
    assert_eq!(metadata.mode() & 0o777, 0o600);
    File::open(state_root)
        .and_then(|directory| directory.sync_all())
        .expect("durably publish provider conformance receipt");
    assert_eq!(
        tree_sha256(package_root),
        source_sha256,
        "beads source changed while the receipt was published"
    );
}

fn assert_prepared_provider_route(
    prepared: &crate::plugin_native_target_binding::PreparedBoundPluginNativeCliCommand<'_>,
    provider: &ProviderObservation,
) {
    #[cfg(target_os = "macos")]
    let expected = PathBuf::from(format!(
        "/.vol/{}/{}",
        provider.identity.device, provider.identity.inode
    ));
    #[cfg(not(target_os = "macos"))]
    let expected = provider.path.clone();
    assert_eq!(prepared.command().program(), expected);
    assert_eq!(
        executable_identity(prepared.command().program()),
        provider.identity
    );
}

fn assert_prepared_provider_hash(
    prepared: &crate::plugin_native_target_binding::PreparedBoundPluginNativeCliCommand<'_>,
    provider: &ProviderObservation,
) {
    assert_prepared_provider_route(prepared, provider);
    assert_eq!(
        file_sha256(prepared.command().program()),
        provider.sha256
    );
}
