use serde::Deserialize;
use std::collections::BTreeSet;
use std::env;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

// This is a shrink-only map of the Hmux workspace's local dependency closure.
// A dependency belongs either to the target direction or to the explicit debt
// that the source-architecture migration is deleting. New edges fail closed.

#[derive(Debug, Deserialize)]
struct Metadata {
    packages: Vec<Package>,
    workspace_members: Vec<String>,
    workspace_root: PathBuf,
}

#[derive(Debug, Deserialize)]
struct Package {
    dependencies: Vec<Dependency>,
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct Dependency {
    kind: Option<String>,
    name: String,
    optional: bool,
    path: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum DependencyKind {
    Build,
    Development,
    Normal,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum PathScope {
    HmuxWorkspace,
    ParentRepository,
}

use DependencyKind::{Development, Normal};
use PathScope::{HmuxWorkspace, ParentRepository};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct LocalEdge {
    from: String,
    kind: DependencyKind,
    optional: bool,
    scope: PathScope,
    to: String,
}

impl LocalEdge {
    fn new(from: &str, to: &str, kind: DependencyKind, optional: bool, scope: PathScope) -> Self {
        Self {
            from: from.to_string(),
            kind,
            optional,
            scope,
            to: to.to_string(),
        }
    }
}

fn edge(from: &str, to: &str) -> LocalEdge {
    LocalEdge::new(from, to, Normal, false, HmuxWorkspace)
}

fn dev_edge(from: &str, to: &str) -> LocalEdge {
    LocalEdge::new(from, to, Development, false, HmuxWorkspace)
}

fn optional_edge(from: &str, to: &str) -> LocalEdge {
    LocalEdge::new(from, to, Normal, true, HmuxWorkspace)
}

fn parent_edge(from: &str, to: &str) -> LocalEdge {
    LocalEdge::new(from, to, Normal, false, ParentRepository)
}

fn workspace_metadata() -> &'static Metadata {
    static METADATA: OnceLock<Metadata> = OnceLock::new();
    METADATA.get_or_init(|| {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest_dir
            .ancestors()
            .nth(2)
            .expect("runtime-contract must remain below hmux/crates");
        let manifest = workspace_root.join("Cargo.toml");
        let cargo = env::var_os("CARGO").unwrap_or_else(|| OsString::from("cargo"));
        let output = Command::new(cargo)
            .args([
                "metadata",
                "--locked",
                "--offline",
                "--no-deps",
                "--format-version",
                "1",
                "--manifest-path",
            ])
            .arg(&manifest)
            .current_dir(workspace_root)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .output()
            .expect("cargo metadata must start");
        assert!(
            output.status.success(),
            "cargo metadata failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("cargo metadata must return valid JSON")
    })
}

fn workspace_packages(metadata: &Metadata) -> impl Iterator<Item = &Package> {
    metadata
        .packages
        .iter()
        .filter(|package| metadata.workspace_members.contains(&package.id))
}

fn workspace_package_names(metadata: &Metadata) -> BTreeSet<String> {
    workspace_packages(metadata)
        .map(|package| package.name.clone())
        .collect()
}

fn dependency_kind(kind: Option<&str>) -> DependencyKind {
    match kind {
        None => Normal,
        Some("dev") => Development,
        Some("build") => DependencyKind::Build,
        Some(other) => panic!("cargo metadata returned unknown dependency kind {other}"),
    }
}

fn local_edges(metadata: &Metadata) -> BTreeSet<LocalEdge> {
    workspace_packages(metadata)
        .flat_map(|package| {
            package.dependencies.iter().filter_map(|dependency| {
                let path = dependency.path.as_ref()?;
                let scope = if path.starts_with(&metadata.workspace_root) {
                    HmuxWorkspace
                } else {
                    ParentRepository
                };
                Some(LocalEdge::new(
                    &package.name,
                    &dependency.name,
                    dependency_kind(dependency.kind.as_deref()),
                    dependency.optional,
                    scope,
                ))
            })
        })
        .collect()
}

fn target_edges() -> BTreeSet<LocalEdge> {
    [
        edge("hmux-cli", "hmux-client"),
        edge("hmux-cli", "hmux-ssh-transport"),
        edge("hmux-client", "hmux-session-protocol"),
        edge("hmux-client", "hmux-local-platform"),
        optional_edge("hmux-client", "terminal-state-protocol"),
        edge("hmux-host", "hmux-session-protocol"),
        edge("hmux-host", "hmux-local-platform"),
        edge("hmux-local-platform", "hmux-session-protocol"),
        optional_edge("hmux-host", "terminal-state-protocol"),
        edge("hmux-release-candidate", "hmux-release-trust"),
        edge("hmux-runtime", "hmux-client"),
        edge("hmux-runtime", "hmux-host"),
        edge("hmux-runtime", "hmux-local-platform"),
        edge("hmux-runtime", "hmux-runtime-contract"),
        edge("hmux-runtime-contract", "hmux-session-protocol"),
        dev_edge("hmux-runtime", "hmux-ssh-transport"),
        edge("hmux-ssh-transport", "hmux-client"),
        edge("hmux-ssh-transport", "hmux-session-protocol"),
        dev_edge("hmux-ssh-transport", "terminal-state-protocol"),
        optional_edge("terminal-state-protocol-codegen", "terminal-state-protocol"),
    ]
    .into_iter()
    .collect()
}

fn known_direction_debt() -> BTreeSet<LocalEdge> {
    // Keep this list shrink-only. Each edge names a source-architecture
    // inversion that a later migration slice must remove, not an approved
    // extension point. Delete the entry in the same slice that removes it.
    [
        edge("hmux-cli", "hmux-host"),
        edge("hmux-cli", "hmux-runtime-contract"),
        edge("hmux-cli", "terminal-state-protocol"),
        edge("hmux-client", "hmux-host"),
        edge("hmux-client", "hmux-runtime-contract"),
        optional_edge("hmux-host", "terminal-core-ghostty-proof"),
        parent_edge("hmux-runtime", "hebbian-process-sampler"),
        optional_edge("hmux-runtime", "terminal-state-protocol"),
        edge("hmux-ssh-transport", "hmux-runtime-contract"),
    ]
    .into_iter()
    .collect()
}

fn reviewed_edges() -> BTreeSet<LocalEdge> {
    let target = target_edges();
    let debt = known_direction_debt();
    assert!(
        target.is_disjoint(&debt),
        "a dependency cannot be both target direction and known debt"
    );
    target.union(&debt).cloned().collect()
}

fn unreviewed_edges(actual: &BTreeSet<LocalEdge>) -> Vec<LocalEdge> {
    actual.difference(&reviewed_edges()).cloned().collect()
}

fn stale_direction_debt(actual: &BTreeSet<LocalEdge>) -> Vec<LocalEdge> {
    known_direction_debt().difference(actual).cloned().collect()
}

#[test]
fn workspace_members_are_explicit() {
    let actual = workspace_package_names(workspace_metadata());
    let expected = [
        "hmux-cli",
        "hmux-client",
        "hmux-host",
        "hmux-local-platform",
        "hmux-release-candidate",
        "hmux-release-trust",
        "hmux-runtime",
        "hmux-runtime-contract",
        "hmux-session-protocol",
        "hmux-ssh-transport",
        "terminal-core-ghostty-proof",
        "terminal-state-protocol",
        "terminal-state-protocol-codegen",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    assert_eq!(actual, expected, "update the reviewed workspace owner map");
}

#[test]
fn local_dependency_edges_are_target_or_known_shrink_only_debt() {
    let actual = local_edges(workspace_metadata());
    let unreviewed = unreviewed_edges(&actual);

    assert!(
        unreviewed.is_empty(),
        "unreviewed local dependency edges: {unreviewed:#?}"
    );

    let stale_debt = stale_direction_debt(&actual);
    assert!(
        stale_debt.is_empty(),
        "remove resolved edges from the shrink-only debt map: {stale_debt:#?}"
    );
}

#[test]
fn unreviewed_edge_shapes_are_rejected() {
    let cases = [
        (None, edge("hmux-session-protocol", "hmux-host")),
        (None, edge("hmux-local-platform", "hmux-host")),
        (None, edge("hmux-local-platform", "hmux-client")),
        (None, edge("hmux-local-platform", "hmux-runtime-contract")),
        (None, edge("hmux-runtime-contract", "hmux-host")),
        (None, edge("hmux-ssh-transport", "hmux-host")),
        (None, edge("hmux-client", "hmux-release-trust")),
        (
            Some(dev_edge("hmux-ssh-transport", "terminal-state-protocol")),
            edge("hmux-ssh-transport", "terminal-state-protocol"),
        ),
        (
            Some(optional_edge("hmux-client", "terminal-state-protocol")),
            edge("hmux-client", "terminal-state-protocol"),
        ),
    ];

    for (replaced, added) in cases {
        let mut actual = reviewed_edges();
        if let Some(replaced) = replaced {
            assert!(actual.remove(&replaced));
        }
        assert!(actual.insert(added.clone()));
        assert_eq!(unreviewed_edges(&actual), vec![added]);
    }
}

#[test]
fn resolved_direction_debt_must_leave_the_baseline() {
    let resolved = edge("hmux-client", "hmux-host");
    let mut actual = reviewed_edges();
    assert!(actual.remove(&resolved));

    assert_eq!(stale_direction_debt(&actual), vec![resolved]);
}
