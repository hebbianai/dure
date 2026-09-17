use dure_app::{
    AgentInstallScopeV2, AgentNativeMarketplaceNameV2, AgentNativePluginNameV2,
    PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2, PluginNativeTargetStateV2,
    PluginTargetStateDigestV2, PluginVersionV2,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const MAX_CLAUDE_SETTINGS_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginNativeCliStateError {
    UnexpectedScope,
    ExpectedSourceUnavailable,
    InvalidMarketplaceOutput,
    InvalidPluginOutput,
    DuplicateMarketplace,
    DuplicatePlugin,
    InvalidPluginVersion,
    InvalidPluginScope,
    WorkspaceRequired,
    SettingsUnavailable,
    SettingsIsSymlink,
    SettingsIsNotFile,
    SettingsTooLarge,
    InvalidSettings,
    InconsistentMarketplaceState,
    InconsistentPluginState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexMarketplaceList {
    marketplaces: Vec<CodexMarketplace>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexMarketplace {
    name: String,
    marketplace_source: CodexMarketplaceSource,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexMarketplaceSource {
    source_type: String,
    source: String,
}

#[derive(Deserialize)]
struct CodexPluginList {
    installed: Vec<CodexInstalledPlugin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexInstalledPlugin {
    plugin_id: String,
    version: String,
    installed: bool,
    enabled: bool,
}

#[derive(Deserialize)]
struct ClaudeMarketplace {
    name: String,
    source: String,
    path: String,
}

#[derive(Deserialize)]
struct ClaudePluginList {
    installed: Vec<ClaudeInstalledPlugin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeInstalledPlugin {
    id: String,
    version: String,
    scope: String,
    enabled: bool,
    project_path: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSettings {
    #[serde(default)]
    extra_known_marketplaces: BTreeMap<String, ClaudeSettingsMarketplace>,
}

#[derive(Deserialize)]
struct ClaudeSettingsMarketplace {
    source: ClaudeSettingsSource,
}

#[derive(Deserialize)]
struct ClaudeSettingsSource {
    source: String,
    path: String,
}

#[derive(Clone, Copy)]
pub enum ClaudePluginTargetRoot<'a> {
    Path(&'a Path),
    Directory(&'a File),
}

pub struct ClaudePluginTargetStateInspection<'a> {
    pub marketplace_output: &'a [u8],
    pub plugin_output: &'a [u8],
    pub marketplace: &'a AgentNativeMarketplaceNameV2,
    pub plugin: &'a AgentNativePluginNameV2,
    pub expected_source: &'a Path,
    pub scope: &'a AgentInstallScopeV2,
    pub home_root: ClaudePluginTargetRoot<'a>,
    pub workspace_root: Option<ClaudePluginTargetRoot<'a>>,
}

pub fn inspect_codex_plugin_target_state(
    marketplace_output: &[u8],
    plugin_output: &[u8],
    marketplace: &AgentNativeMarketplaceNameV2,
    plugin: &AgentNativePluginNameV2,
    expected_source: &Path,
    scope: &AgentInstallScopeV2,
) -> Result<PluginNativeTargetStateV2, PluginNativeCliStateError> {
    if scope != &AgentInstallScopeV2::Managed {
        return Err(PluginNativeCliStateError::UnexpectedScope);
    }
    let expected_source = fs::canonicalize(expected_source)
        .map_err(|_| PluginNativeCliStateError::ExpectedSourceUnavailable)?;
    let marketplace_state =
        inspect_codex_marketplace(marketplace_output, marketplace, &expected_source)?;
    let installation = inspect_codex_installation(plugin_output, marketplace.as_str(), plugin)?;
    Ok(PluginNativeTargetStateV2 {
        marketplace: marketplace_state,
        installation,
    })
}

pub fn inspect_claude_plugin_target_state(
    inspection: ClaudePluginTargetStateInspection<'_>,
) -> Result<PluginNativeTargetStateV2, PluginNativeCliStateError> {
    let ClaudePluginTargetStateInspection {
        marketplace_output,
        plugin_output,
        marketplace,
        plugin,
        expected_source,
        scope,
        home_root,
        workspace_root,
    } = inspection;
    if scope == &AgentInstallScopeV2::Managed {
        return Err(PluginNativeCliStateError::UnexpectedScope);
    }
    let expected_source = fs::canonicalize(expected_source)
        .map_err(|_| PluginNativeCliStateError::ExpectedSourceUnavailable)?;
    let marketplace_state = inspect_claude_marketplace(
        marketplace_output,
        marketplace,
        &expected_source,
        scope,
        home_root,
        workspace_root,
    )?;
    let installation = inspect_claude_installation(
        plugin_output,
        marketplace.as_str(),
        plugin,
        scope,
        workspace_root,
    )?;
    Ok(PluginNativeTargetStateV2 {
        marketplace: marketplace_state,
        installation,
    })
}

fn inspect_claude_marketplace(
    output: &[u8],
    expected: &AgentNativeMarketplaceNameV2,
    expected_source: &Path,
    scope: &AgentInstallScopeV2,
    home_root: ClaudePluginTargetRoot<'_>,
    workspace_root: Option<ClaudePluginTargetRoot<'_>>,
) -> Result<PluginNativeMarketplaceStateV2, PluginNativeCliStateError> {
    let parsed = serde_json::from_slice::<Vec<ClaudeMarketplace>>(output)
        .map_err(|_| PluginNativeCliStateError::InvalidMarketplaceOutput)?;
    let mut listed = parsed
        .into_iter()
        .filter(|marketplace| marketplace.name == expected.as_str());
    let first_listed = listed.next();
    if first_listed.is_some() && listed.next().is_some() {
        return Err(PluginNativeCliStateError::DuplicateMarketplace);
    }

    let settings = read_claude_scope_settings(scope, home_root, workspace_root)?;
    let Some(settings) = settings else {
        return Ok(PluginNativeMarketplaceStateV2::Absent);
    };
    let Some(declaration) = settings.extra_known_marketplaces.get(expected.as_str()) else {
        return Ok(PluginNativeMarketplaceStateV2::Absent);
    };
    let Some(listed) = first_listed else {
        return Err(PluginNativeCliStateError::InconsistentMarketplaceState);
    };
    let listed_matches_declaration = listed.source == declaration.source.source
        && match (
            fs::canonicalize(&listed.path),
            fs::canonicalize(&declaration.source.path),
        ) {
            (Ok(listed), Ok(declared)) => listed == declared,
            _ => listed.path == declaration.source.path,
        };
    if !listed_matches_declaration {
        return Err(PluginNativeCliStateError::InconsistentMarketplaceState);
    }
    let matches_expected_source = declaration.source.source == "directory"
        && fs::canonicalize(&declaration.source.path).is_ok_and(|source| source == expected_source);
    let source_fingerprint = PluginTargetStateDigestV2::sha256(format!(
        "{}\0{}",
        declaration.source.source, declaration.source.path
    ));
    Ok(PluginNativeMarketplaceStateV2::Registered {
        source_fingerprint,
        matches_expected_source,
        scope: scope.clone(),
    })
}

fn inspect_claude_installation(
    output: &[u8],
    marketplace: &str,
    plugin: &AgentNativePluginNameV2,
    expected_scope: &AgentInstallScopeV2,
    workspace_root: Option<ClaudePluginTargetRoot<'_>>,
) -> Result<PluginNativeInstallationStateV2, PluginNativeCliStateError> {
    let parsed = serde_json::from_slice::<ClaudePluginList>(output)
        .map_err(|_| PluginNativeCliStateError::InvalidPluginOutput)?;
    let selector = format!("{}@{marketplace}", plugin.as_str());
    let mut matches = Vec::new();
    for installed in parsed.installed {
        if installed.id != selector {
            continue;
        }
        let scope = parse_claude_scope(&installed.scope)?;
        if &scope != expected_scope {
            continue;
        }
        let project_matches = match expected_scope {
            AgentInstallScopeV2::User => {
                if installed.project_path.is_some() {
                    return Err(PluginNativeCliStateError::InconsistentPluginState);
                }
                true
            }
            AgentInstallScopeV2::Project | AgentInstallScopeV2::Local => {
                let expected =
                    workspace_root.ok_or(PluginNativeCliStateError::WorkspaceRequired)?;
                let project_path = installed
                    .project_path
                    .as_deref()
                    .ok_or(PluginNativeCliStateError::InconsistentPluginState)?;
                claude_root_matches_path(expected, Path::new(project_path))
            }
            AgentInstallScopeV2::Managed => false,
        };
        if project_matches {
            matches.push((installed, scope));
        }
    }
    let mut matches = matches.into_iter();
    let Some((installed, scope)) = matches.next() else {
        return Ok(PluginNativeInstallationStateV2::Absent);
    };
    if matches.next().is_some() {
        return Err(PluginNativeCliStateError::DuplicatePlugin);
    }
    let version = PluginVersionV2::new(installed.version)
        .map_err(|_| PluginNativeCliStateError::InvalidPluginVersion)?;
    Ok(PluginNativeInstallationStateV2::Installed {
        version,
        enabled: installed.enabled,
        scope,
    })
}

fn read_claude_scope_settings(
    scope: &AgentInstallScopeV2,
    home_root: ClaudePluginTargetRoot<'_>,
    workspace_root: Option<ClaudePluginTargetRoot<'_>>,
) -> Result<Option<ClaudeSettings>, PluginNativeCliStateError> {
    let (root, file_name) = match scope {
        AgentInstallScopeV2::User => (home_root, "settings.json"),
        AgentInstallScopeV2::Project => (
            workspace_root.ok_or(PluginNativeCliStateError::WorkspaceRequired)?,
            "settings.json",
        ),
        AgentInstallScopeV2::Local => (
            workspace_root.ok_or(PluginNativeCliStateError::WorkspaceRequired)?,
            "settings.local.json",
        ),
        AgentInstallScopeV2::Managed => {
            return Err(PluginNativeCliStateError::UnexpectedScope);
        }
    };
    match root {
        ClaudePluginTargetRoot::Path(root) => read_claude_settings_path(root, file_name),
        ClaudePluginTargetRoot::Directory(root) => read_claude_settings_directory(root, file_name),
    }
}

fn read_claude_settings_path(
    root: &Path,
    file_name: &str,
) -> Result<Option<ClaudeSettings>, PluginNativeCliStateError> {
    let path = root.join(".claude").join(file_name);
    let Some(parent) = path.parent() else {
        return Err(PluginNativeCliStateError::SettingsUnavailable);
    };
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(PluginNativeCliStateError::SettingsIsSymlink);
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(PluginNativeCliStateError::SettingsIsNotFile);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(PluginNativeCliStateError::SettingsUnavailable),
    }
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(PluginNativeCliStateError::SettingsUnavailable),
    };
    if metadata.file_type().is_symlink() {
        return Err(PluginNativeCliStateError::SettingsIsSymlink);
    }
    if !metadata.is_file() {
        return Err(PluginNativeCliStateError::SettingsIsNotFile);
    }
    if metadata.len() > MAX_CLAUDE_SETTINGS_BYTES {
        return Err(PluginNativeCliStateError::SettingsTooLarge);
    }
    let file = open_claude_settings_path(&path)
        .map_err(|_| PluginNativeCliStateError::SettingsUnavailable)?;
    read_claude_settings_file(file)
}

#[cfg(unix)]
fn open_claude_settings_path(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
}

#[cfg(not(unix))]
fn open_claude_settings_path(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

#[cfg(unix)]
fn read_claude_settings_directory(
    root: &File,
    file_name: &str,
) -> Result<Option<ClaudeSettings>, PluginNativeCliStateError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    fn open_at(directory: &File, name: &str, directory_only: bool) -> std::io::Result<File> {
        let name = CString::new(name).expect("fixed settings component has no NUL");
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if directory_only { libc::O_DIRECTORY } else { 0 };
        let descriptor = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor == -1 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }
    }

    let settings_directory = match open_at(root, ".claude", true) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(PluginNativeCliStateError::SettingsIsSymlink);
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOTDIR) => {
            return Err(PluginNativeCliStateError::SettingsIsNotFile);
        }
        Err(_) => return Err(PluginNativeCliStateError::SettingsUnavailable),
    };
    let file = match open_at(&settings_directory, file_name, false) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
            return Err(PluginNativeCliStateError::SettingsIsSymlink);
        }
        Err(_) => return Err(PluginNativeCliStateError::SettingsUnavailable),
    };
    read_claude_settings_file(file)
}

#[cfg(not(unix))]
fn read_claude_settings_directory(
    _root: &File,
    _file_name: &str,
) -> Result<Option<ClaudeSettings>, PluginNativeCliStateError> {
    Err(PluginNativeCliStateError::SettingsUnavailable)
}

fn read_claude_settings_file(
    mut file: File,
) -> Result<Option<ClaudeSettings>, PluginNativeCliStateError> {
    let metadata = file
        .metadata()
        .map_err(|_| PluginNativeCliStateError::SettingsUnavailable)?;
    if !metadata.is_file() {
        return Err(PluginNativeCliStateError::SettingsIsNotFile);
    }
    if metadata.len() > MAX_CLAUDE_SETTINGS_BYTES {
        return Err(PluginNativeCliStateError::SettingsTooLarge);
    }
    let mut source = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_CLAUDE_SETTINGS_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|_| PluginNativeCliStateError::SettingsUnavailable)?;
    if source.len() as u64 > MAX_CLAUDE_SETTINGS_BYTES {
        return Err(PluginNativeCliStateError::SettingsTooLarge);
    }
    serde_json::from_slice(&source)
        .map(Some)
        .map_err(|_| PluginNativeCliStateError::InvalidSettings)
}

fn claude_root_matches_path(root: ClaudePluginTargetRoot<'_>, candidate: &Path) -> bool {
    match root {
        ClaudePluginTargetRoot::Path(expected) => {
            match (fs::canonicalize(candidate), fs::canonicalize(expected)) {
                (Ok(candidate), Ok(expected)) => candidate == expected,
                _ => false,
            }
        }
        ClaudePluginTargetRoot::Directory(expected) => {
            exact_directory_matches_file(candidate, expected)
        }
    }
}

#[cfg(unix)]
fn exact_directory_matches_file(candidate: &Path, expected: &File) -> bool {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let Ok(candidate) = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(candidate)
    else {
        return false;
    };
    match (candidate.metadata(), expected.metadata()) {
        (Ok(candidate), Ok(expected)) => {
            candidate.dev() == expected.dev() && candidate.ino() == expected.ino()
        }
        _ => false,
    }
}

#[cfg(not(unix))]
fn exact_directory_matches_file(_candidate: &Path, _expected: &File) -> bool {
    false
}

fn parse_claude_scope(value: &str) -> Result<AgentInstallScopeV2, PluginNativeCliStateError> {
    match value {
        "user" => Ok(AgentInstallScopeV2::User),
        "project" => Ok(AgentInstallScopeV2::Project),
        "local" => Ok(AgentInstallScopeV2::Local),
        _ => Err(PluginNativeCliStateError::InvalidPluginScope),
    }
}

fn inspect_codex_marketplace(
    output: &[u8],
    expected: &AgentNativeMarketplaceNameV2,
    expected_source: &Path,
) -> Result<PluginNativeMarketplaceStateV2, PluginNativeCliStateError> {
    let parsed = serde_json::from_slice::<CodexMarketplaceList>(output)
        .map_err(|_| PluginNativeCliStateError::InvalidMarketplaceOutput)?;
    let mut matches = parsed
        .marketplaces
        .into_iter()
        .filter(|marketplace| marketplace.name == expected.as_str());
    let Some(marketplace) = matches.next() else {
        return Ok(PluginNativeMarketplaceStateV2::Absent);
    };
    if matches.next().is_some() {
        return Err(PluginNativeCliStateError::DuplicateMarketplace);
    }
    let matches_expected_source = marketplace.marketplace_source.source_type == "local"
        && fs::canonicalize(&marketplace.marketplace_source.source)
            .is_ok_and(|source| source == expected_source);
    let source_fingerprint = PluginTargetStateDigestV2::sha256(format!(
        "{}\0{}",
        marketplace.marketplace_source.source_type, marketplace.marketplace_source.source
    ));
    Ok(PluginNativeMarketplaceStateV2::Registered {
        source_fingerprint,
        matches_expected_source,
        scope: AgentInstallScopeV2::Managed,
    })
}

fn inspect_codex_installation(
    output: &[u8],
    marketplace: &str,
    plugin: &AgentNativePluginNameV2,
) -> Result<PluginNativeInstallationStateV2, PluginNativeCliStateError> {
    let parsed = serde_json::from_slice::<CodexPluginList>(output)
        .map_err(|_| PluginNativeCliStateError::InvalidPluginOutput)?;
    let selector = format!("{}@{marketplace}", plugin.as_str());
    let mut matches = parsed
        .installed
        .into_iter()
        .filter(|installed| selector == installed.plugin_id);
    let Some(installed) = matches.next() else {
        return Ok(PluginNativeInstallationStateV2::Absent);
    };
    if matches.next().is_some() {
        return Err(PluginNativeCliStateError::DuplicatePlugin);
    }
    if !installed.installed {
        return Err(PluginNativeCliStateError::InvalidPluginOutput);
    }
    let version = PluginVersionV2::new(installed.version)
        .map_err(|_| PluginNativeCliStateError::InvalidPluginVersion)?;
    Ok(PluginNativeInstallationStateV2::Installed {
        version,
        enabled: installed.enabled,
        scope: AgentInstallScopeV2::Managed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspect(
        source: &Path,
        marketplace_json: &str,
        plugin_json: &str,
    ) -> Result<PluginNativeTargetStateV2, PluginNativeCliStateError> {
        inspect_codex_plugin_target_state(
            marketplace_json.as_bytes(),
            plugin_json.as_bytes(),
            &AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
            &AgentNativePluginNameV2::new("dure-beads").unwrap(),
            source,
            &AgentInstallScopeV2::Managed,
        )
    }

    fn marketplace(source: &Path) -> String {
        serde_json::json!({
            "marketplaces": [{
                "name": "dure-bundled",
                "root": source,
                "marketplaceSource": {
                    "sourceType": "local",
                    "source": source,
                },
            }],
        })
        .to_string()
    }

    fn installed() -> String {
        serde_json::json!({
            "installed": [{
                "pluginId": "dure-beads@dure-bundled",
                "version": "0.1.0",
                "installed": true,
                "enabled": true,
            }],
            "available": [],
        })
        .to_string()
    }

    fn claude_marketplace(source: &Path) -> String {
        serde_json::json!([{
            "name": "dure-bundled",
            "source": "directory",
            "path": source,
            "installLocation": source,
        }])
        .to_string()
    }

    fn claude_installed(workspace: &Path) -> String {
        serde_json::json!({
            "installed": [{
                "id": "dure-beads@dure-bundled",
                "version": "0.1.0",
                "scope": "local",
                "enabled": true,
                "projectPath": workspace,
            }],
            "available": [],
        })
        .to_string()
    }

    fn write_local_marketplace(workspace: &Path, source: &Path) {
        let directory = workspace.join(".claude");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.local.json"),
            serde_json::json!({
                "extraKnownMarketplaces": {
                    "dure-bundled": {
                        "source": {"source": "directory", "path": source},
                    },
                },
            })
            .to_string(),
        )
        .unwrap();
    }

    fn inspect_claude(
        source: &Path,
        home: &Path,
        workspace: &Path,
        marketplace_json: &str,
        plugin_json: &str,
    ) -> Result<PluginNativeTargetStateV2, PluginNativeCliStateError> {
        inspect_claude_plugin_target_state(ClaudePluginTargetStateInspection {
            marketplace_output: marketplace_json.as_bytes(),
            plugin_output: plugin_json.as_bytes(),
            marketplace: &AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
            plugin: &AgentNativePluginNameV2::new("dure-beads").unwrap(),
            expected_source: source,
            scope: &AgentInstallScopeV2::Local,
            home_root: ClaudePluginTargetRoot::Path(home),
            workspace_root: Some(ClaudePluginTargetRoot::Path(workspace)),
        })
    }

    #[test]
    fn parses_expected_marketplace_and_installed_plugin_without_retaining_paths() {
        let source = tempfile::tempdir().unwrap();
        let state = inspect(source.path(), &marketplace(source.path()), &installed()).unwrap();

        assert!(matches!(
            state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Managed,
                ..
            }
        ));
        assert_eq!(
            state.installation,
            PluginNativeInstallationStateV2::Installed {
                version: PluginVersionV2::new("0.1.0").unwrap(),
                enabled: true,
                scope: AgentInstallScopeV2::Managed,
            }
        );
        assert!(!format!("{state:?}").contains(source.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn distinguishes_absent_and_foreign_state() {
        let expected = tempfile::tempdir().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let absent = inspect(
            expected.path(),
            r#"{"marketplaces":[]}"#,
            r#"{"installed":[]}"#,
        )
        .unwrap();
        assert_eq!(
            absent,
            PluginNativeTargetStateV2 {
                marketplace: PluginNativeMarketplaceStateV2::Absent,
                installation: PluginNativeInstallationStateV2::Absent,
            }
        );

        let state = inspect(expected.path(), &marketplace(foreign.path()), &installed()).unwrap();
        assert!(matches!(
            state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: false,
                ..
            }
        ));
    }

    #[test]
    fn duplicate_and_malformed_provider_state_fail_closed() {
        let source = tempfile::tempdir().unwrap();
        let entry = serde_json::json!({
            "name": "dure-bundled",
            "marketplaceSource": {"sourceType": "local", "source": source.path()},
        });
        let duplicates = serde_json::json!({"marketplaces": [entry.clone(), entry]}).to_string();
        assert_eq!(
            inspect(source.path(), &duplicates, &installed()).unwrap_err(),
            PluginNativeCliStateError::DuplicateMarketplace
        );

        let invalid_version = serde_json::json!({
            "installed": [{
                "pluginId": "dure-beads@dure-bundled",
                "version": "not-semver",
                "installed": true,
                "enabled": true,
            }],
        })
        .to_string();
        assert_eq!(
            inspect(source.path(), &marketplace(source.path()), &invalid_version).unwrap_err(),
            PluginNativeCliStateError::InvalidPluginVersion
        );
        assert_eq!(
            inspect(source.path(), "not-json", &installed()).unwrap_err(),
            PluginNativeCliStateError::InvalidMarketplaceOutput
        );
    }

    #[test]
    fn claude_state_requires_the_exact_scope_declaration_and_project_path() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("home");
        let workspace = temp.path().join("workspace");
        let other_workspace = temp.path().join("other-workspace");
        for directory in [&source, &home, &workspace, &other_workspace] {
            fs::create_dir(directory).unwrap();
        }
        write_local_marketplace(&workspace, &source);

        let state = inspect_claude(
            &source,
            &home,
            &workspace,
            &claude_marketplace(&source),
            &claude_installed(&workspace),
        )
        .unwrap();
        assert!(matches!(
            state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));
        assert!(matches!(
            state.installation,
            PluginNativeInstallationStateV2::Installed {
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));

        let state = inspect_claude(
            &source,
            &home,
            &other_workspace,
            &claude_marketplace(&source),
            &claude_installed(&workspace),
        )
        .unwrap();
        assert_eq!(state.marketplace, PluginNativeMarketplaceStateV2::Absent);
        assert_eq!(state.installation, PluginNativeInstallationStateV2::Absent);
    }

    #[cfg(unix)]
    #[test]
    fn claude_descriptor_inspection_ignores_a_replacement_at_the_host_path() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("home");
        let workspace = temp.path().join("workspace");
        let retained_workspace = temp.path().join("retained-workspace");
        for directory in [&source, &home, &workspace] {
            fs::create_dir(directory).unwrap();
        }
        write_local_marketplace(&workspace, &source);
        let home = File::open(&home).unwrap();
        let workspace_handle = File::open(&workspace).unwrap();
        fs::rename(&workspace, &retained_workspace).unwrap();
        fs::create_dir_all(workspace.join(".claude")).unwrap();
        fs::write(workspace.join(".claude/settings.local.json"), "{}").unwrap();

        let state = inspect_claude_plugin_target_state(ClaudePluginTargetStateInspection {
            marketplace_output: claude_marketplace(&source).as_bytes(),
            plugin_output: claude_installed(&retained_workspace).as_bytes(),
            marketplace: &AgentNativeMarketplaceNameV2::new("dure-bundled").unwrap(),
            plugin: &AgentNativePluginNameV2::new("dure-beads").unwrap(),
            expected_source: &source,
            scope: &AgentInstallScopeV2::Local,
            home_root: ClaudePluginTargetRoot::Directory(&home),
            workspace_root: Some(ClaudePluginTargetRoot::Directory(&workspace_handle)),
        })
        .unwrap();

        assert!(matches!(
            state.marketplace,
            PluginNativeMarketplaceStateV2::Registered {
                matches_expected_source: true,
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));
        assert!(matches!(
            state.installation,
            PluginNativeInstallationStateV2::Installed {
                scope: AgentInstallScopeV2::Local,
                ..
            }
        ));
    }

    #[test]
    fn claude_inconsistent_and_unknown_scope_state_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let foreign = temp.path().join("foreign");
        let home = temp.path().join("home");
        let workspace = temp.path().join("workspace");
        for directory in [&source, &foreign, &home, &workspace] {
            fs::create_dir(directory).unwrap();
        }
        write_local_marketplace(&workspace, &source);
        assert_eq!(
            inspect_claude(
                &source,
                &home,
                &workspace,
                &claude_marketplace(&foreign),
                &claude_installed(&workspace),
            )
            .unwrap_err(),
            PluginNativeCliStateError::InconsistentMarketplaceState
        );

        let invalid_scope = serde_json::json!({
            "installed": [{
                "id": "dure-beads@dure-bundled",
                "version": "0.1.0",
                "scope": "ambient",
                "enabled": true,
            }],
        })
        .to_string();
        assert_eq!(
            inspect_claude(
                &source,
                &home,
                &workspace,
                &claude_marketplace(&source),
                &invalid_scope,
            )
            .unwrap_err(),
            PluginNativeCliStateError::InvalidPluginScope
        );

        let missing_project_path = serde_json::json!({
            "installed": [{
                "id": "dure-beads@dure-bundled",
                "version": "0.1.0",
                "scope": "local",
                "enabled": true,
            }],
        })
        .to_string();
        assert_eq!(
            inspect_claude(
                &source,
                &home,
                &workspace,
                &claude_marketplace(&source),
                &missing_project_path,
            )
            .unwrap_err(),
            PluginNativeCliStateError::InconsistentPluginState
        );
    }

    #[cfg(unix)]
    #[test]
    fn claude_scope_settings_symlink_fails_closed() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let home = temp.path().join("home");
        let workspace = temp.path().join("workspace");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&home).unwrap();
        fs::create_dir_all(workspace.join(".claude")).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, "{}").unwrap();
        symlink(&outside, workspace.join(".claude/settings.local.json")).unwrap();

        assert_eq!(
            inspect_claude(&source, &home, &workspace, "[]", r#"{"installed":[]}"#,).unwrap_err(),
            PluginNativeCliStateError::SettingsIsSymlink
        );
    }
}
