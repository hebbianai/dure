use std::{collections::BTreeMap, sync::Arc};

mod slack;

use dure_app::{
    AgentIntegrationIdV2, PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2,
    PluginResourcePathV2,
};

pub(crate) const BUNDLED_BEADS_MANIFEST: &[u8] =
    include_bytes!("../../plugins/beads/dure-plugin.json");
pub(crate) const BUNDLED_BEADS_SETTINGS: &[u8] =
    include_bytes!("../../plugins/beads/contributions/settings.json");
pub(crate) const BUNDLED_BEADS_ISSUE_TRACKER: &[u8] =
    include_bytes!("../../plugins/beads/contributions/issue-tracker.json");
pub(crate) const BUNDLED_BEADS_VIEWS: &[u8] =
    include_bytes!("../../plugins/beads/contributions/views.json");
pub(crate) const BUNDLED_GITHUB_MANIFEST: &[u8] =
    include_bytes!("../../plugins/github/dure-plugin.json");
pub(crate) const BUNDLED_GITHUB_SETTINGS: &[u8] =
    include_bytes!("../../plugins/github/contributions/settings.json");
pub(crate) const BUNDLED_GITHUB_ISSUE_TRACKER: &[u8] =
    include_bytes!("../../plugins/github/contributions/issue-tracker.json");
pub(crate) const BUNDLED_GITHUB_VIEWS: &[u8] =
    include_bytes!("../../plugins/github/contributions/views.json");
pub(crate) const BUNDLED_CORE_MANIFEST: &[u8] =
    include_bytes!("../../plugins/core/dure-plugin.json");
pub(crate) const BUNDLED_CORE_WORKFLOWS: &[u8] =
    include_bytes!("../../plugins/core/contributions/workflows.json");

const BUNDLED_BEADS_CODEX_MARKETPLACE: &[u8] =
    include_bytes!("../../plugins/beads/agents/codex/.agents/plugins/marketplace.json");
const BUNDLED_BEADS_CODEX_PLUGIN: &[u8] =
    include_bytes!("../../plugins/beads/agents/codex/plugins/dure-beads/.codex-plugin/plugin.json");
const BUNDLED_BEADS_CODEX_SKILL: &[u8] =
    include_bytes!("../../plugins/beads/agents/codex/plugins/dure-beads/skills/beads/SKILL.md");
const BUNDLED_BEADS_CLAUDE_MARKETPLACE: &[u8] =
    include_bytes!("../../plugins/beads/agents/claude/.claude-plugin/marketplace.json");
const BUNDLED_BEADS_CLAUDE_PLUGIN: &[u8] = include_bytes!(
    "../../plugins/beads/agents/claude/plugins/dure-beads/.claude-plugin/plugin.json"
);
const BUNDLED_BEADS_CLAUDE_SKILL: &[u8] =
    include_bytes!("../../plugins/beads/agents/claude/plugins/dure-beads/skills/beads/SKILL.md");

fn resource_path(value: &str) -> PluginResourcePathV2 {
    PluginResourcePathV2::new(value).expect("bundled resource path is static and valid")
}

fn owned(bytes: &'static [u8]) -> Arc<[u8]> {
    Arc::from(bytes)
}

pub(crate) fn bundled_contribution_resources() -> BTreeMap<PluginResourcePathV2, Arc<[u8]>> {
    BTreeMap::from([
        (
            resource_path("./contributions/issue-tracker.json"),
            owned(BUNDLED_BEADS_ISSUE_TRACKER),
        ),
        (
            resource_path("./contributions/settings.json"),
            owned(BUNDLED_BEADS_SETTINGS),
        ),
        (
            resource_path("./contributions/views.json"),
            owned(BUNDLED_BEADS_VIEWS),
        ),
    ])
}

pub(crate) fn bundled_github_contribution_resources(
) -> BTreeMap<PluginResourcePathV2, Arc<[u8]>> {
    BTreeMap::from([
        (
            resource_path("./contributions/issue-tracker.json"),
            owned(BUNDLED_GITHUB_ISSUE_TRACKER),
        ),
        (
            resource_path("./contributions/settings.json"),
            owned(BUNDLED_GITHUB_SETTINGS),
        ),
        (
            resource_path("./contributions/views.json"),
            owned(BUNDLED_GITHUB_VIEWS),
        ),
    ])
}

pub(crate) fn bundled_core_contribution_resources(
) -> BTreeMap<PluginResourcePathV2, Arc<[u8]>> {
    BTreeMap::from([(
        resource_path("./contributions/workflows.json"),
        owned(BUNDLED_CORE_WORKFLOWS),
    )])
}

fn bundled_agent_integration_resources(
) -> BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>> {
    BTreeMap::from([
        (
            AgentIntegrationIdV2::new("dure.beads.claude")
                .expect("bundled integration ID is static and valid"),
            BTreeMap::from([
                (
                    resource_path("./.claude-plugin/marketplace.json"),
                    owned(BUNDLED_BEADS_CLAUDE_MARKETPLACE),
                ),
                (
                    resource_path("./plugins/dure-beads/.claude-plugin/plugin.json"),
                    owned(BUNDLED_BEADS_CLAUDE_PLUGIN),
                ),
                (
                    resource_path("./plugins/dure-beads/skills/beads/SKILL.md"),
                    owned(BUNDLED_BEADS_CLAUDE_SKILL),
                ),
            ]),
        ),
        (
            AgentIntegrationIdV2::new("dure.beads.codex")
                .expect("bundled integration ID is static and valid"),
            BTreeMap::from([
                (
                    resource_path("./.agents/plugins/marketplace.json"),
                    owned(BUNDLED_BEADS_CODEX_MARKETPLACE),
                ),
                (
                    resource_path("./plugins/dure-beads/.codex-plugin/plugin.json"),
                    owned(BUNDLED_BEADS_CODEX_PLUGIN),
                ),
                (
                    resource_path("./plugins/dure-beads/skills/beads/SKILL.md"),
                    owned(BUNDLED_BEADS_CODEX_SKILL),
                ),
            ]),
        ),
    ])
}

pub(crate) fn bundled_beads_package_snapshot(
) -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        owned(BUNDLED_BEADS_MANIFEST),
        bundled_contribution_resources(),
        bundled_agent_integration_resources(),
    )
}

pub(crate) fn bundled_github_package_snapshot(
) -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        owned(BUNDLED_GITHUB_MANIFEST),
        bundled_github_contribution_resources(),
        BTreeMap::new(),
    )
}

pub(crate) fn bundled_core_package_snapshot(
) -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        owned(BUNDLED_CORE_MANIFEST),
        bundled_core_contribution_resources(),
        BTreeMap::new(),
    )
}

pub(crate) const BUNDLED_BEADS_CANDIDATE_ID: &str = "dure.beads.bundled";
pub(crate) const BUNDLED_CORE_CANDIDATE_ID: &str = "dure.core.bundled";
pub(crate) const BUNDLED_GITHUB_CANDIDATE_ID: &str = "dure.github.bundled";

/// Every package compiled into the app, with the candidate id the catalog
/// reports it under. The catalog registers these as one trusted source.
pub(crate) fn bundled_package_candidates() -> [(
    &'static str,
    Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2>,
); 4] {
    [
        (BUNDLED_BEADS_CANDIDATE_ID, bundled_beads_package_snapshot()),
        (BUNDLED_CORE_CANDIDATE_ID, bundled_core_package_snapshot()),
        (BUNDLED_GITHUB_CANDIDATE_ID, bundled_github_package_snapshot()),
        ("dure.slack.bundled", slack::snapshot()),
    ]
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::Path};

    use super::*;

    fn collect_repository_files(
        root: &Path,
        directory: &Path,
        files: &mut BTreeMap<String, Vec<u8>>,
    ) {
        let mut children = fs::read_dir(directory)
            .unwrap_or_else(|error| panic!("read {}: {error}", directory.display()))
            .map(|entry| entry.expect("read bundled package entry").path())
            .collect::<Vec<_>>();
        children.sort();
        for path in children {
            let metadata = fs::symlink_metadata(&path)
                .unwrap_or_else(|error| panic!("inspect {}: {error}", path.display()));
            assert!(
                !metadata.file_type().is_symlink(),
                "bundled package contains a symlink: {}",
                path.display()
            );
            if metadata.is_dir() {
                collect_repository_files(root, &path, files);
                continue;
            }
            assert!(
                metadata.is_file(),
                "bundled package contains a special file: {}",
                path.display()
            );
            let relative = path
                .strip_prefix(root)
                .expect("bundled entry stays below package root")
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .expect("bundled paths are UTF-8")
                })
                .collect::<Vec<_>>()
                .join("/");
            assert!(
                files
                    .insert(
                        format!("./{relative}"),
                        fs::read(&path).expect("read bundled package file"),
                    )
                    .is_none(),
                "bundled package path was duplicated"
            );
        }
    }

    #[test]
    fn embedded_inventory_is_the_exact_repository_package_tree() {
        let package_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a repository parent")
            .join("plugins/beads");
        let mut repository_files = BTreeMap::new();
        collect_repository_files(&package_root, &package_root, &mut repository_files);

        let snapshot = bundled_beads_package_snapshot().expect("bundled package authority");
        let embedded_files = snapshot
            .embedded_authority()
            .expect("bundled native package has embedded authority")
            .package_files()
            .map(|(path, bytes)| (path.as_str().to_owned(), bytes.to_vec()))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(embedded_files.len(), 10);
        assert_eq!(embedded_files, repository_files);
    }

    #[test]
    fn github_inventory_is_the_exact_repository_package_tree() {
        let package_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a repository parent")
            .join("plugins/github");
        let mut repository_files = BTreeMap::new();
        collect_repository_files(&package_root, &package_root, &mut repository_files);
        let snapshot = bundled_github_package_snapshot().expect("bundled GitHub authority");
        let embedded_files = snapshot
            .embedded_authority()
            .expect("bundled GitHub package has embedded authority")
            .package_files()
            .map(|(path, bytes)| (path.as_str().to_owned(), bytes.to_vec()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(embedded_files.len(), 4);
        assert_eq!(embedded_files, repository_files);
    }

    #[test]
    fn core_inventory_is_the_exact_repository_package_tree() {
        let package_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a repository parent")
            .join("plugins/core");
        let mut repository_files = BTreeMap::new();
        collect_repository_files(&package_root, &package_root, &mut repository_files);

        let snapshot = bundled_core_package_snapshot().expect("bundled core authority");
        let embedded_files = snapshot
            .embedded_authority()
            .expect("bundled core package has embedded authority")
            .package_files()
            .map(|(path, bytes)| (path.as_str().to_owned(), bytes.to_vec()))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(embedded_files.len(), 2);
        assert_eq!(embedded_files, repository_files);
    }
}
