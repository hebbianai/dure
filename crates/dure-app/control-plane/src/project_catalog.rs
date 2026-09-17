use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CATALOG_SCHEMA_VERSION: u16 = 2;
const LEGACY_CATALOG_SCHEMA_VERSION: u16 = 1;
const CATALOG_KIND: &str = "dure.backend_projects";
const MAX_CATALOG_BYTES: u64 = 128 * 1024;
const MAX_GIT_POINTER_BYTES: u64 = 4 * 1024;
const MAX_PROJECTS: usize = 128;
const MAX_PROJECT_ID_BYTES: usize = 64;
const MAX_DISPLAY_NAME_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FileSnapshot {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

impl FileSnapshot {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCatalogSource {
    schema_version: u16,
    kind: String,
    projects: Vec<ProjectSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectSource {
    id: String,
    display_name: String,
    root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    repository_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectProjection {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) root_id: String,
    pub(crate) repository_id: String,
}

#[derive(Clone, Debug)]
struct ProjectEntry {
    projection: ProjectProjection,
    root: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectAuthority {
    projection: ProjectProjection,
    root: PathBuf,
}

impl ProjectAuthority {
    pub(crate) fn projection(&self) -> &ProjectProjection {
        &self.projection
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectCatalog {
    projects: Vec<ProjectEntry>,
}

impl ProjectCatalog {
    pub(crate) fn projections(&self) -> Vec<ProjectProjection> {
        self.projects
            .iter()
            .map(|entry| entry.projection.clone())
            .collect()
    }

    pub(crate) fn project(&self, project_id: &str) -> Option<ProjectAuthority> {
        self.projects
            .iter()
            .find(|entry| entry.projection.id == project_id)
            .map(ProjectAuthority::from)
    }

    pub(crate) fn project_for_path(&self, project_path: &str) -> Option<ProjectAuthority> {
        if !valid_project_path(project_path) {
            return None;
        }
        let project_path = fs::canonicalize(project_path).ok()?;
        if !project_path.is_dir() {
            return None;
        }
        self.projects
            .iter()
            .filter(|entry| project_path.starts_with(&entry.root))
            .max_by_key(|entry| entry.root.components().count())
            .map(ProjectAuthority::from)
    }
}

impl From<&ProjectEntry> for ProjectAuthority {
    fn from(entry: &ProjectEntry) -> Self {
        Self {
            projection: entry.projection.clone(),
            root: entry.root.clone(),
        }
    }
}

fn safe_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_bytes
        && value.bytes().all(|byte| !byte.is_ascii_control())
}

pub(crate) fn valid_project_id(value: &str) -> bool {
    if !safe_text(value, MAX_PROJECT_ID_BYTES) {
        return false;
    }
    let bytes = value.as_bytes();
    (bytes.first().is_some_and(u8::is_ascii_lowercase)
        || bytes.first().is_some_and(u8::is_ascii_digit))
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

pub(crate) fn valid_project_path(value: &str) -> bool {
    safe_text(value, MAX_PATH_BYTES) && Path::new(value).is_absolute()
}

fn valid_project_display_name(value: &str) -> bool {
    safe_text(value, MAX_DISPLAY_NAME_BYTES)
}

fn owner_file_metadata(metadata: &fs::Metadata, owner_only: bool) -> bool {
    metadata.is_file()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.len() > 0
        && if owner_only {
            metadata.mode() & 0o077 == 0
        } else {
            metadata.mode() & 0o022 == 0
        }
}

fn read_bounded_file_snapshot_with_hook(
    path: &Path,
    maximum_bytes: u64,
    owner_only: bool,
    before_final_check: impl FnOnce(),
) -> Result<(Vec<u8>, FileSnapshot), &'static str> {
    let before = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "backend_projects_catalog_missing"
        } else {
            "backend_projects_catalog_unavailable"
        }
    })?;
    if !owner_file_metadata(&before, owner_only) {
        return Err("backend_projects_catalog_unsafe");
    }
    if before.len() > maximum_bytes {
        return Err("backend_projects_catalog_too_large");
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "backend_projects_catalog_unsafe")?;
    let opened = file
        .metadata()
        .map_err(|_| "backend_projects_catalog_unavailable")?;
    if !owner_file_metadata(&opened, owner_only)
        || FileSnapshot::from(&before) != FileSnapshot::from(&opened)
    {
        return Err("backend_projects_catalog_changed");
    }
    let mut source = Vec::with_capacity(opened.len() as usize);
    Read::by_ref(&mut file)
        .take(maximum_bytes + 1)
        .read_to_end(&mut source)
        .map_err(|_| "backend_projects_catalog_unavailable")?;
    if source.len() as u64 != opened.len() || source.len() as u64 > maximum_bytes {
        return Err("backend_projects_catalog_too_large");
    }
    before_final_check();
    let after = file
        .metadata()
        .map_err(|_| "backend_projects_catalog_unavailable")?;
    let final_path = fs::symlink_metadata(path).map_err(|_| "backend_projects_catalog_changed")?;
    let snapshot = FileSnapshot::from(&after);
    if FileSnapshot::from(&opened) != snapshot || snapshot != FileSnapshot::from(&final_path) {
        return Err("backend_projects_catalog_changed");
    }
    Ok((source, snapshot))
}

fn read_bounded_file_with_hook(
    path: &Path,
    maximum_bytes: u64,
    owner_only: bool,
    before_final_check: impl FnOnce(),
) -> Result<Vec<u8>, &'static str> {
    read_bounded_file_snapshot_with_hook(path, maximum_bytes, owner_only, before_final_check)
        .map(|(source, _)| source)
}

fn read_bounded_file(
    path: &Path,
    maximum_bytes: u64,
    owner_only: bool,
) -> Result<Vec<u8>, &'static str> {
    read_bounded_file_with_hook(path, maximum_bytes, owner_only, || {})
}

fn owner_directory_snapshot(path: &Path) -> Result<FileSnapshot, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "backend_project_root_unavailable")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err("backend_project_root_unsafe");
    }
    Ok(FileSnapshot::from(&metadata))
}

fn stable_directory_identity(
    path: &Path,
    code: &'static str,
) -> Result<FileSnapshot, &'static str> {
    let before = fs::symlink_metadata(path).map_err(|_| code)?;
    if !before.is_dir()
        || before.file_type().is_symlink()
        || before.uid() != unsafe { libc::geteuid() }
        || before.mode() & 0o022 != 0
    {
        return Err(code);
    }
    let canonical = fs::canonicalize(path).map_err(|_| code)?;
    let after = fs::symlink_metadata(&canonical).map_err(|_| code)?;
    if FileSnapshot::from(&before).device != FileSnapshot::from(&after).device
        || FileSnapshot::from(&before).inode != FileSnapshot::from(&after).inode
    {
        return Err(code);
    }
    Ok(FileSnapshot::from(&after))
}

fn parse_git_pointer(source: &[u8], parent: &Path) -> Result<PathBuf, &'static str> {
    let source = std::str::from_utf8(source).map_err(|_| "backend_project_repository_invalid")?;
    let line = source
        .strip_suffix('\n')
        .unwrap_or(source)
        .strip_prefix("gitdir: ")
        .ok_or("backend_project_repository_invalid")?;
    if !safe_text(line, MAX_PATH_BYTES) || line.contains('\n') || line.contains('\r') {
        return Err("backend_project_repository_invalid");
    }
    let path = Path::new(line);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        parent.join(path)
    };
    fs::canonicalize(resolved).map_err(|_| "backend_project_repository_unavailable")
}

fn git_directory(root: &Path) -> Result<PathBuf, &'static str> {
    let marker = root.join(".git");
    let metadata =
        fs::symlink_metadata(&marker).map_err(|_| "backend_project_repository_unavailable")?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        return fs::canonicalize(marker).map_err(|_| "backend_project_repository_unavailable");
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("backend_project_repository_unsafe");
    }
    let source = read_bounded_file(&marker, MAX_GIT_POINTER_BYTES, false)
        .map_err(|_| "backend_project_repository_unsafe")?;
    parse_git_pointer(&source, root)
}

fn common_git_directory(git_directory: &Path) -> Result<PathBuf, &'static str> {
    let pointer = git_directory.join("commondir");
    match fs::symlink_metadata(&pointer) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            let source = read_bounded_file(&pointer, MAX_GIT_POINTER_BYTES, false)
                .map_err(|_| "backend_project_repository_unsafe")?;
            let source =
                std::str::from_utf8(&source).map_err(|_| "backend_project_repository_invalid")?;
            let relative = source.strip_suffix('\n').unwrap_or(source);
            if !safe_text(relative, MAX_PATH_BYTES)
                || relative.contains('\n')
                || relative.contains('\r')
            {
                return Err("backend_project_repository_invalid");
            }
            let path = Path::new(relative);
            fs::canonicalize(if path.is_absolute() {
                path.to_path_buf()
            } else {
                git_directory.join(path)
            })
            .map_err(|_| "backend_project_repository_unavailable")
        }
        Ok(_) => Err("backend_project_repository_unsafe"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(git_directory.to_path_buf())
        }
        Err(_) => Err("backend_project_repository_unavailable"),
    }
}

fn identity(prefix: &str, snapshot: FileSnapshot) -> String {
    let mut hash = Sha256::new();
    hash.update(prefix.as_bytes());
    hash.update([0]);
    hash.update(snapshot.device.to_string().as_bytes());
    hash.update([0]);
    hash.update(snapshot.inode.to_string().as_bytes());
    let digest = format!("{:x}", hash.finalize());
    format!("{prefix}_{}", &digest[..32])
}

fn valid_identity(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 1 + 32
        && value.starts_with(prefix)
        && value.as_bytes().get(prefix.len()) == Some(&b'_')
        && value[prefix.len() + 1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn observed_repository_id(root: &Path) -> Option<String> {
    let directory = git_directory(root).ok()?;
    let common = common_git_directory(&directory).ok()?;
    let snapshot =
        stable_directory_identity(&common, "backend_project_repository_unavailable").ok()?;
    Some(identity("repo", snapshot))
}

fn project_entry_with_hook(
    source: ProjectSource,
    before_root_recheck: impl FnOnce(),
) -> Result<ProjectEntry, &'static str> {
    if !valid_project_id(&source.id)
        || !valid_project_display_name(&source.display_name)
        || !safe_text(&source.root, MAX_PATH_BYTES)
    {
        return Err("backend_projects_catalog_invalid");
    }
    let root = PathBuf::from(&source.root);
    if !root.is_absolute() {
        return Err("backend_projects_catalog_invalid");
    }
    let root_before = owner_directory_snapshot(&root)?;
    if fs::canonicalize(&root).map_err(|_| "backend_project_root_unavailable")? != root {
        return Err("backend_project_root_unsafe");
    }
    let repository_before = observed_repository_id(&root);
    before_root_recheck();
    let root_after = owner_directory_snapshot(&root).map_err(|_| "backend_project_root_changed")?;
    if root_before.device != root_after.device || root_before.inode != root_after.inode {
        return Err("backend_project_root_changed");
    }
    if fs::canonicalize(&root).map_err(|_| "backend_project_root_changed")? != root {
        return Err("backend_project_root_changed");
    }
    let repository_after = observed_repository_id(&root);
    if repository_before != repository_after {
        return Err("backend_project_repository_changed");
    }
    let projection = ProjectProjection {
        id: source.id,
        display_name: source.display_name,
        root_id: identity("root", root_after),
        // This opaque catalog identity does not grant Git checkout authority.
        // Without readable Git metadata, scope it to the validated folder;
        // Git-specific operations still validate their own checkout capability.
        repository_id: repository_after.unwrap_or_else(|| identity("repo", root_after)),
    };
    if source
        .root_id
        .as_deref()
        .is_some_and(|expected| expected != projection.root_id)
    {
        return Err("backend_project_root_changed");
    }
    if source
        .repository_id
        .as_deref()
        .is_some_and(|expected| expected != projection.repository_id)
    {
        return Err("backend_project_repository_changed");
    }
    Ok(ProjectEntry { projection, root })
}

fn project_entry(source: ProjectSource) -> Result<ProjectEntry, &'static str> {
    project_entry_with_hook(source, || {})
}

/// Builds a catalog entry from its persisted form without touching the
/// filesystem. The stored identity pins are the last observation made at
/// registration time; they are allowed to drift (a device renumber changes
/// every device+inode hash while no directory moved), so loading must not
/// re-derive or re-compare them. Filesystem safety is enforced where the
/// root is actually used — `validate_project_root` — and pins converge on
/// the next registration replay.
fn project_entry_stored(source: ProjectSource) -> Result<ProjectEntry, &'static str> {
    if !valid_project_id(&source.id)
        || !valid_project_display_name(&source.display_name)
        || !safe_text(&source.root, MAX_PATH_BYTES)
    {
        return Err("backend_projects_catalog_invalid");
    }
    let root = PathBuf::from(&source.root);
    if !root.is_absolute() {
        return Err("backend_projects_catalog_invalid");
    }
    let (Some(root_id), Some(repository_id)) = (source.root_id, source.repository_id) else {
        return Err("backend_projects_catalog_invalid");
    };
    Ok(ProjectEntry {
        projection: ProjectProjection {
            id: source.id,
            display_name: source.display_name,
            root_id,
            repository_id,
        },
        root,
    })
}

/// Point-of-use safety check for a resolved project root: it must still be
/// an owner-held, non-symlinked directory whose path is canonical. Run this
/// at destructive boundaries (agent spawn) instead of at catalog load, so a
/// single broken entry cannot take every other project down with it.
pub(crate) fn validate_project_root(project: &ProjectAuthority) -> Result<(), &'static str> {
    owner_directory_snapshot(&project.root)?;
    if fs::canonicalize(&project.root).map_err(|_| "backend_project_root_unavailable")?
        != project.root
    {
        return Err("backend_project_root_unsafe");
    }
    Ok(())
}

fn project_catalog(source: ProjectCatalogSource) -> Result<ProjectCatalog, &'static str> {
    if ![LEGACY_CATALOG_SCHEMA_VERSION, CATALOG_SCHEMA_VERSION].contains(&source.schema_version)
        || source.kind != CATALOG_KIND
        || source.projects.len() > MAX_PROJECTS
    {
        return Err("backend_projects_catalog_invalid");
    }
    let mut ids = BTreeSet::new();
    let mut roots = BTreeSet::new();
    let mut projects = Vec::with_capacity(source.projects.len());
    for project_source in source.projects {
        let identity_fields_valid = match source.schema_version {
            LEGACY_CATALOG_SCHEMA_VERSION => {
                project_source.root_id.is_none() && project_source.repository_id.is_none()
            }
            CATALOG_SCHEMA_VERSION => {
                project_source
                    .root_id
                    .as_deref()
                    .is_some_and(|value| valid_identity(value, "root"))
                    && project_source
                        .repository_id
                        .as_deref()
                        .is_some_and(|value| valid_identity(value, "repo"))
            }
            _ => false,
        };
        if !identity_fields_valid {
            return Err("backend_projects_catalog_invalid");
        }
        // Schema v2 entries carry their identity pins; loading them is pure
        // parsing. Legacy v1 entries have no pins yet, so their projection is
        // still derived from the filesystem until registration migrates them.
        let project = match source.schema_version {
            CATALOG_SCHEMA_VERSION => project_entry_stored(project_source)?,
            _ => project_entry(project_source)?,
        };
        if !ids.insert(project.projection.id.clone()) || !roots.insert(project.root.clone()) {
            return Err("backend_projects_catalog_duplicate");
        }
        projects.push(project);
    }
    projects.sort_by(|left, right| left.projection.id.cmp(&right.projection.id));
    Ok(ProjectCatalog { projects })
}

fn parse_project_catalog_with_schema(source: &[u8]) -> Result<(ProjectCatalog, u16), &'static str> {
    let source: ProjectCatalogSource =
        serde_json::from_slice(source).map_err(|_| "backend_projects_catalog_invalid")?;
    let schema_version = source.schema_version;
    Ok((project_catalog(source)?, schema_version))
}

fn parse_project_catalog(source: &[u8]) -> Result<ProjectCatalog, &'static str> {
    parse_project_catalog_with_schema(source).map(|(catalog, _)| catalog)
}

/// A home that has never registered a project has no catalog file yet. That is
/// the empty catalog, not a fault: readers answer "no projects" so a spawn
/// reaches `agent_spawn_project_not_found` and the on-demand registration
/// path, exactly as registration itself already treats a missing file.
pub(crate) fn load_project_catalog(path: &Path) -> Result<ProjectCatalog, &'static str> {
    match read_bounded_file(path, MAX_CATALOG_BYTES, true) {
        Ok(source) => parse_project_catalog(&source),
        Err("backend_projects_catalog_missing") => Ok(ProjectCatalog {
            projects: Vec::new(),
        }),
        Err(code) => Err(code),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CatalogSnapshot {
    Missing,
    Present(FileSnapshot),
}

fn catalog_snapshot(path: &Path) -> Result<CatalogSnapshot, &'static str> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CatalogSnapshot::Missing),
        Err(_) => Err("backend_projects_catalog_unavailable"),
        Ok(metadata) if !owner_file_metadata(&metadata, true) => {
            Err("backend_projects_catalog_unsafe")
        }
        Ok(metadata) if metadata.len() > MAX_CATALOG_BYTES => {
            Err("backend_projects_catalog_too_large")
        }
        Ok(metadata) => Ok(CatalogSnapshot::Present(FileSnapshot::from(&metadata))),
    }
}

fn assert_catalog_snapshot(path: &Path, expected: CatalogSnapshot) -> Result<(), &'static str> {
    if catalog_snapshot(path)? == expected {
        Ok(())
    } else {
        Err("backend_projects_catalog_changed")
    }
}

fn load_project_catalog_for_registration(
    path: &Path,
) -> Result<(ProjectCatalog, CatalogSnapshot, bool), &'static str> {
    match read_bounded_file_snapshot_with_hook(path, MAX_CATALOG_BYTES, true, || {}) {
        Ok((source, snapshot)) => {
            let (catalog, schema_version) = parse_project_catalog_with_schema(&source)?;
            Ok((
                catalog,
                CatalogSnapshot::Present(snapshot),
                schema_version == LEGACY_CATALOG_SCHEMA_VERSION,
            ))
        }
        Err("backend_projects_catalog_missing") => Ok((
            ProjectCatalog {
                projects: Vec::new(),
            },
            CatalogSnapshot::Missing,
            false,
        )),
        Err(code) => Err(code),
    }
}

fn project_sources(catalog: &ProjectCatalog) -> Vec<ProjectSource> {
    catalog
        .projects
        .iter()
        .map(|entry| ProjectSource {
            id: entry.projection.id.clone(),
            display_name: entry.projection.display_name.clone(),
            root: entry.root.to_string_lossy().into_owned(),
            root_id: Some(entry.projection.root_id.clone()),
            repository_id: Some(entry.projection.repository_id.clone()),
        })
        .collect()
}

fn catalog_bytes(catalog: &ProjectCatalog) -> Result<Vec<u8>, &'static str> {
    let mut source = serde_json::to_vec(&ProjectCatalogSource {
        schema_version: CATALOG_SCHEMA_VERSION,
        kind: CATALOG_KIND.into(),
        projects: project_sources(catalog),
    })
    .map_err(|_| "backend_projects_catalog_invalid")?;
    source.push(b'\n');
    if source.len() as u64 > MAX_CATALOG_BYTES {
        return Err("backend_projects_catalog_too_large");
    }
    Ok(source)
}

fn catalog_parent(path: &Path) -> Result<&Path, &'static str> {
    let parent = path
        .parent()
        .ok_or("backend_projects_catalog_unavailable")?;
    let metadata =
        fs::symlink_metadata(parent).map_err(|_| "backend_projects_catalog_unavailable")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("backend_projects_catalog_unsafe");
    }
    Ok(parent)
}

fn temporary_catalog_path(path: &Path) -> Result<PathBuf, &'static str> {
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|_| "backend_projects_catalog_unavailable")?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(catalog_parent(path)?.join(format!(".backend-projects-{suffix}.tmp")))
}

fn publish_project_catalog(
    path: &Path,
    source: &[u8],
    expected: CatalogSnapshot,
) -> Result<(), &'static str> {
    let parent = catalog_parent(path)?;
    let temporary = temporary_catalog_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "backend_projects_catalog_unavailable")?;
        file.write_all(source)
            .and_then(|()| file.sync_all())
            .map_err(|_| "backend_projects_catalog_unavailable")?;
        drop(file);
        assert_catalog_snapshot(path, expected)?;
        match expected {
            CatalogSnapshot::Missing => fs::hard_link(&temporary, path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "backend_projects_catalog_changed"
                } else {
                    "backend_projects_catalog_unavailable"
                }
            })?,
            CatalogSnapshot::Present(_) => {
                fs::rename(&temporary, path).map_err(|_| "backend_projects_catalog_unavailable")?
            }
        }
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "backend_projects_catalog_unavailable")?;
        Ok(())
    })();
    let cleanup = match fs::remove_file(&temporary) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("backend_projects_catalog_unavailable"),
    };
    if result.is_ok() {
        cleanup?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "backend_projects_catalog_unavailable")?;
    }
    result
}

fn register_project_with_hook(
    path: &Path,
    id: String,
    display_name: String,
    root: String,
    before_publish: impl FnOnce(),
) -> Result<ProjectProjection, &'static str> {
    let requested_source = ProjectSource {
        id,
        display_name,
        root,
        root_id: None,
        repository_id: None,
    };
    let requested = project_entry(requested_source.clone()).map_err(|code| {
        if code == "backend_projects_catalog_invalid" {
            "backend_project_registration_invalid"
        } else {
            code
        }
    })?;
    let (catalog, snapshot, migrate_legacy) = load_project_catalog_for_registration(path)?;
    // Replay identity is the durable mapping (id, root path, display name).
    // The identity pins are deliberately excluded: they drift whenever the
    // device number changes, and a replay is exactly the moment they converge
    // back to the current filesystem observation.
    let replay = if let Some(existing) = catalog
        .projects
        .iter()
        .find(|entry| entry.projection.id == requested.projection.id)
    {
        if existing.projection.display_name == requested.projection.display_name
            && existing.root == requested.root
        {
            true
        } else {
            return Err("backend_project_registration_conflict");
        }
    } else {
        false
    };
    let converge = replay
        && catalog.projects.iter().any(|entry| {
            entry.projection.id == requested.projection.id
                && entry.projection != requested.projection
        });
    if replay && !migrate_legacy && !converge {
        return Ok(requested.projection);
    }
    // Duplicate detection follows the root path: comparing pins would let the
    // same root register twice as soon as the stored pin went stale.
    if !replay
        && catalog
            .projects
            .iter()
            .any(|entry| entry.root == requested.root)
    {
        return Err("backend_project_registration_conflict");
    }
    if !replay && catalog.projects.len() >= MAX_PROJECTS {
        return Err("backend_projects_catalog_full");
    }

    let mut desired_sources = project_sources(&catalog);
    if replay {
        for source in &mut desired_sources {
            if source.id == requested.projection.id {
                source.root_id = Some(requested.projection.root_id.clone());
                source.repository_id = Some(requested.projection.repository_id.clone());
            }
        }
    } else {
        desired_sources.push(ProjectSource {
            id: requested.projection.id.clone(),
            display_name: requested.projection.display_name.clone(),
            root: requested.root.to_string_lossy().into_owned(),
            root_id: Some(requested.projection.root_id.clone()),
            repository_id: Some(requested.projection.repository_id.clone()),
        });
    }
    before_publish();
    assert_catalog_snapshot(path, snapshot)?;
    // The publish decision was made from the identity observed at the top of
    // this registration; re-observe the requested root right before writing
    // so a root or repository swapped mid-registration cannot be pinned.
    let reobserved = project_entry(requested_source)?;
    if reobserved.root != requested.root
        || reobserved.projection.root_id != requested.projection.root_id
    {
        return Err("backend_project_root_changed");
    }
    if reobserved.projection.repository_id != requested.projection.repository_id {
        return Err("backend_project_repository_changed");
    }
    let desired = project_catalog(ProjectCatalogSource {
        schema_version: CATALOG_SCHEMA_VERSION,
        kind: CATALOG_KIND.into(),
        projects: desired_sources,
    })?;
    let validated = desired
        .projects
        .iter()
        .find(|entry| entry.projection.id == requested.projection.id)
        .ok_or("backend_project_registration_conflict")?;
    if validated.projection.root_id != requested.projection.root_id
        || validated.root != requested.root
    {
        return Err("backend_project_root_changed");
    }
    if validated.projection.repository_id != requested.projection.repository_id {
        return Err("backend_project_repository_changed");
    }
    if validated.projection.id != requested.projection.id
        || validated.projection.display_name != requested.projection.display_name
    {
        return Err("backend_project_registration_conflict");
    }
    publish_project_catalog(path, &catalog_bytes(&desired)?, snapshot)?;
    Ok(requested.projection)
}

pub(crate) fn register_project(
    path: &Path,
    id: String,
    display_name: String,
    root: String,
) -> Result<ProjectProjection, &'static str> {
    register_project_with_hook(path, id, display_name, root, || {})
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    fn owner_file(path: &Path, source: &[u8]) {
        fs::write(path, source).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn repository(root: &Path, id: &str) -> PathBuf {
        let path = root.join(id);
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join(".git")).unwrap();
        path.canonicalize().unwrap()
    }

    fn catalog(projects: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "kind": "dure.backend_projects",
            "projects": projects,
        }))
        .unwrap()
    }

    #[test]
    fn loads_sorted_projects_without_project_paths_in_the_projection() {
        let fixture = tempdir().unwrap();
        let first = repository(fixture.path(), "first");
        let second = repository(fixture.path(), "second");
        let path = fixture.path().join("backend-projects.json");
        owner_file(
            &path,
            &catalog(json!([
                { "id": "second", "displayName": "Second", "root": second },
                { "id": "first", "displayName": "First", "root": first },
            ])),
        );

        let loaded = load_project_catalog(&path).unwrap();
        assert_eq!(
            loaded
                .projections()
                .iter()
                .map(|project| project.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        let output = serde_json::to_string(&loaded.projections()).unwrap();
        assert!(!output.contains(first.to_str().unwrap()));
    }

    #[test]
    fn resolves_a_path_to_the_nearest_catalog_project() {
        let fixture = tempdir().unwrap();
        let parent = repository(fixture.path(), "parent");
        let nested = repository(&parent, "nested");
        let parent_directory = parent.join("parent-directory");
        let nested_directory = nested.join("nested-directory");
        fs::create_dir(&parent_directory).unwrap();
        fs::create_dir(&nested_directory).unwrap();
        let unrelated = fixture.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        let path = fixture.path().join("backend-projects.json");
        owner_file(
            &path,
            &catalog(json!([
                { "id": "parent", "displayName": "Parent", "root": parent },
                { "id": "nested", "displayName": "Nested", "root": nested },
            ])),
        );

        let loaded = load_project_catalog(&path).unwrap();
        assert_eq!(
            loaded
                .project_for_path(parent_directory.to_str().unwrap())
                .unwrap()
                .projection()
                .id,
            "parent"
        );
        assert_eq!(
            loaded
                .project_for_path(nested_directory.to_str().unwrap())
                .unwrap()
                .projection()
                .id,
            "nested"
        );
        assert!(
            loaded
                .project_for_path(unrelated.to_str().unwrap())
                .is_none()
        );
        assert!(loaded.project_for_path("relative/path").is_none());
    }

    #[test]
    fn accepts_a_linked_worktree_pointer_and_uses_the_common_repository_identity() {
        let fixture = tempdir().unwrap();
        let common = fixture.path().join("common.git");
        let worktree_git = common.join("worktrees/linked");
        let project = fixture.path().join("linked");
        fs::create_dir_all(&worktree_git).unwrap();
        fs::create_dir(&project).unwrap();
        owner_file(
            &project.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()).as_bytes(),
        );
        owner_file(&worktree_git.join("commondir"), b"../..\n");
        let path = fixture.path().join("backend-projects.json");
        owner_file(
            &path,
            &catalog(json!([
                { "id": "linked", "displayName": "Linked", "root": project.canonicalize().unwrap() },
            ])),
        );

        let loaded = load_project_catalog(&path).unwrap();
        assert!(
            loaded
                .project("linked")
                .unwrap()
                .projection()
                .repository_id
                .starts_with("repo_")
        );
    }

    #[test]
    fn reads_a_missing_catalog_as_empty_and_rejects_unsafe_symlinked_and_oversized_catalogs() {
        let fixture = tempdir().unwrap();
        let path = fixture.path().join("backend-projects.json");
        assert!(load_project_catalog(&path).unwrap().projects.is_empty());
        owner_file(&path, &catalog(json!([])));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            load_project_catalog(&path).unwrap_err(),
            "backend_projects_catalog_unsafe"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let link = fixture.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert_eq!(
            load_project_catalog(&link).unwrap_err(),
            "backend_projects_catalog_unsafe"
        );
        owner_file(
            &fixture.path().join("large.json"),
            &vec![b'x'; MAX_CATALOG_BYTES as usize + 1],
        );
        assert_eq!(
            load_project_catalog(&fixture.path().join("large.json")).unwrap_err(),
            "backend_projects_catalog_too_large"
        );
    }

    #[test]
    fn rejects_unknown_fields_duplicate_ids_and_duplicate_roots() {
        let fixture = tempdir().unwrap();
        let root = repository(fixture.path(), "repo");
        let path = fixture.path().join("backend-projects.json");
        owner_file(
            &path,
            &catalog(json!([
                { "id": "same", "displayName": "One", "root": root },
                { "id": "same", "displayName": "Two", "root": root },
            ])),
        );
        assert_eq!(
            load_project_catalog(&path).unwrap_err(),
            "backend_projects_catalog_duplicate"
        );
        owner_file(
            &path,
            &serde_json::to_vec(&json!({
                "schemaVersion": 1,
                "kind": "dure.backend_projects",
                "projects": [],
                "token": "forbidden",
            }))
            .unwrap(),
        );
        assert_eq!(
            load_project_catalog(&path).unwrap_err(),
            "backend_projects_catalog_invalid"
        );
    }

    #[test]
    fn detects_catalog_and_root_replacement_at_the_authority_boundary() {
        let fixture = tempdir().unwrap();
        let path = fixture.path().join("backend-projects.json");
        owner_file(&path, &catalog(json!([])));
        let replacement = fixture.path().join("replacement.json");
        owner_file(&replacement, &catalog(json!([])));
        assert_eq!(
            read_bounded_file_with_hook(&path, MAX_CATALOG_BYTES, true, || {
                fs::rename(&replacement, &path).unwrap();
            })
            .unwrap_err(),
            "backend_projects_catalog_changed"
        );

        let root = repository(fixture.path(), "root");
        let replacement_root = repository(fixture.path(), "replacement-root");
        let source = ProjectSource {
            id: "root".into(),
            display_name: "Root".into(),
            root: root.to_string_lossy().into_owned(),
            root_id: None,
            repository_id: None,
        };
        assert_eq!(
            project_entry_with_hook(source, || {
                fs::rename(&root, fixture.path().join("retired-root")).unwrap();
                fs::rename(&replacement_root, &root).unwrap();
            })
            .unwrap_err(),
            "backend_project_root_changed"
        );

        let repository_root = repository(fixture.path(), "repository-root");
        let replacement_repository = repository(fixture.path(), "replacement-repository");
        let source = ProjectSource {
            id: "repository".into(),
            display_name: "Repository".into(),
            root: repository_root.to_string_lossy().into_owned(),
            root_id: None,
            repository_id: None,
        };
        assert_eq!(
            project_entry_with_hook(source, || {
                fs::rename(
                    repository_root.join(".git"),
                    repository_root.join(".git-retired"),
                )
                .unwrap();
                fs::rename(
                    replacement_repository.join(".git"),
                    repository_root.join(".git"),
                )
                .unwrap();
            })
            .unwrap_err(),
            "backend_project_repository_changed"
        );
    }

    #[test]
    fn registers_plain_folders_without_git_metadata() {
        assert_folder_registration_without_git(|_| {});
    }

    #[test]
    fn registers_folders_with_unreadable_git_metadata() {
        assert_folder_registration_without_git(|root| {
            fs::create_dir(root.join("metadata")).unwrap();
            owner_file(&root.join(".git"), b"gitdir: metadata\n");
            fs::set_permissions(root.join(".git"), fs::Permissions::from_mode(0o000)).unwrap();
            assert_eq!(
                fs::read(root.join(".git")).unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied,
            );
        });
    }

    #[test]
    fn registers_folders_with_invalid_git_metadata() {
        assert_folder_registration_without_git(|root| {
            owner_file(&root.join(".git"), b"invalid pointer\n");
        });
    }

    #[test]
    fn refuses_invalid_folder_roots_without_git() {
        let fixture = tempdir().unwrap();
        let path = fixture.path().join("backend-projects.json");
        let folder = fixture.path().join("folder");
        let file = fixture.path().join("file");
        let link = fixture.path().join("link");
        fs::create_dir(&folder).unwrap();
        fs::write(&file, b"not a directory").unwrap();
        symlink(&folder, &link).unwrap();
        for (root, code) in [
            (
                fixture.path().join("missing"),
                "backend_project_root_unavailable",
            ),
            (file, "backend_project_root_unsafe"),
            (link, "backend_project_root_unsafe"),
        ] {
            assert_eq!(
                register_project(
                    &path,
                    "folder".into(),
                    "Folder".into(),
                    root.to_string_lossy().into_owned()
                )
                .unwrap_err(),
                code,
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn refuses_git_changes_during_folder_registration() {
        let fixture = tempdir().unwrap();
        let root = fixture.path().join("folder");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = fixture.path().join("backend-projects.json");
        assert_eq!(
            register_project_with_hook(
                &path,
                "folder".into(),
                "Folder".into(),
                root.to_string_lossy().into_owned(),
                || fs::create_dir(root.join(".git")).unwrap(),
            )
            .unwrap_err(),
            "backend_project_repository_changed",
        );
        assert!(!path.exists());
    }

    fn assert_folder_registration_without_git(prepare: impl FnOnce(&Path)) {
        let fixture = tempdir().unwrap();
        let root = fixture.path().join("folder");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        prepare(&root);
        let path = fixture.path().join("backend-projects.json");
        let register = || {
            register_project(
                &path,
                "folder".into(),
                "Folder".into(),
                root.to_string_lossy().into_owned(),
            )
        };
        let registered = register().unwrap();
        let loaded = load_project_catalog(&path).unwrap();
        let project = loaded.project_for_path(root.to_str().unwrap()).unwrap();
        assert_eq!(project.projection(), &registered);
        validate_project_root(&project).unwrap();
        let before = FileSnapshot::from(&fs::metadata(&path).unwrap());
        assert_eq!(register().unwrap(), registered);
        assert_eq!(FileSnapshot::from(&fs::metadata(&path).unwrap()), before);

        if root.join(".git").exists() {
            fs::remove_file(root.join(".git")).unwrap();
        }
        fs::create_dir(root.join(".git")).unwrap();
        let recovered = register().unwrap();
        assert_eq!(recovered.root_id, registered.root_id);
        assert_ne!(recovered.repository_id, registered.repository_id);
        assert_eq!(register().unwrap(), recovered);
        fs::rename(root.join(".git"), root.join("retired.git")).unwrap();
        assert_eq!(register().unwrap(), registered);
    }

    #[test]
    fn registers_once_and_replays_without_rewriting_the_catalog() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = repository(fixture.path(), "root");
        let other = repository(fixture.path(), "other");
        let path = fixture.path().join("backend-projects.json");

        let registered = register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(
            load_project_catalog(&path)
                .unwrap()
                .project("dure")
                .unwrap()
                .projection(),
            &registered
        );
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["schemaVersion"], CATALOG_SCHEMA_VERSION);
        assert_eq!(document["projects"][0]["rootId"], registered.root_id);
        assert_eq!(
            document["projects"][0]["repositoryId"],
            registered.repository_id
        );
        let before = FileSnapshot::from(&fs::metadata(&path).unwrap());
        let replayed = register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(replayed, registered);
        assert_eq!(FileSnapshot::from(&fs::metadata(&path).unwrap()), before);

        assert_eq!(
            register_project(
                &path,
                "dure".into(),
                "Other".into(),
                root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_registration_conflict"
        );
        assert_eq!(
            register_project(
                &path,
                "other-id".into(),
                "Other".into(),
                root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_registration_conflict"
        );
        assert_eq!(
            register_project(
                &path,
                "dure".into(),
                "Dure".into(),
                other.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_registration_conflict"
        );
        assert_eq!(FileSnapshot::from(&fs::metadata(&path).unwrap()), before);
    }

    #[test]
    fn upgrades_a_valid_legacy_catalog_to_persisted_identity_snapshots() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let first = repository(fixture.path(), "first");
        let second = repository(fixture.path(), "second");
        let path = fixture.path().join("backend-projects.json");
        owner_file(
            &path,
            &catalog(json!([
                { "id": "first", "displayName": "First", "root": first },
            ])),
        );

        register_project(
            &path,
            "first".into(),
            "First".into(),
            first.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap()["schemaVersion"],
            CATALOG_SCHEMA_VERSION
        );

        register_project(
            &path,
            "second".into(),
            "Second".into(),
            second.to_string_lossy().into_owned(),
        )
        .unwrap();

        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["schemaVersion"], CATALOG_SCHEMA_VERSION);
        for project in document["projects"].as_array().unwrap() {
            assert!(project["rootId"].as_str().unwrap().starts_with("root_"));
            assert!(
                project["repositoryId"]
                    .as_str()
                    .unwrap()
                    .starts_with("repo_")
            );
        }
    }

    #[test]
    fn rejects_repository_root_and_catalog_replacement_without_publication() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = repository(fixture.path(), "root");
        let path = fixture.path().join("backend-projects.json");
        register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        fs::rename(root.join(".git"), root.join(".git-retired")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        // A repository identity that changed between registrations is a stale
        // observation, not a mid-write swap: the catalog stays loadable and a
        // replay converges the stored pin to the current identity.
        let stale = load_project_catalog(&path).unwrap();
        let replayed = register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_ne!(
            stale.project("dure").unwrap().projection().repository_id,
            replayed.repository_id
        );
        assert_eq!(
            load_project_catalog(&path)
                .unwrap()
                .project("dure")
                .unwrap()
                .projection()
                .repository_id,
            replayed.repository_id
        );

        let fresh_root = repository(fixture.path(), "fresh-root");
        let fresh_path = fixture.path().join("fresh-projects.json");
        assert_eq!(
            register_project_with_hook(
                &fresh_path,
                "fresh".into(),
                "Fresh".into(),
                fresh_root.to_string_lossy().into_owned(),
                || owner_file(&fresh_path, &catalog(json!([]))),
            )
            .unwrap_err(),
            "backend_projects_catalog_changed"
        );
        assert_eq!(
            load_project_catalog(&fresh_path).unwrap().projections(),
            Vec::new()
        );

        let moving_root = repository(fixture.path(), "moving-root");
        let replacement = repository(fixture.path(), "replacement-root");
        let moving_path = fixture.path().join("moving-projects.json");
        assert_eq!(
            register_project_with_hook(
                &moving_path,
                "moving".into(),
                "Moving".into(),
                moving_root.to_string_lossy().into_owned(),
                || {
                    fs::rename(&moving_root, fixture.path().join("retired-moving-root")).unwrap();
                    fs::rename(&replacement, &moving_root).unwrap();
                },
            )
            .unwrap_err(),
            "backend_project_root_changed"
        );
        assert!(!moving_path.exists());

        let moving_repository = repository(fixture.path(), "moving-repository");
        let repository_replacement = repository(fixture.path(), "repository-replacement");
        let repository_path = fixture.path().join("repository-projects.json");
        assert_eq!(
            register_project_with_hook(
                &repository_path,
                "repository".into(),
                "Repository".into(),
                moving_repository.to_string_lossy().into_owned(),
                || {
                    fs::rename(
                        moving_repository.join(".git"),
                        moving_repository.join(".git-retired"),
                    )
                    .unwrap();
                    fs::rename(
                        repository_replacement.join(".git"),
                        moving_repository.join(".git"),
                    )
                    .unwrap();
                },
            )
            .unwrap_err(),
            "backend_project_repository_changed"
        );
        assert!(!repository_path.exists());
    }

    #[test]
    fn never_overwrites_a_malformed_or_unowned_catalog() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = repository(fixture.path(), "root");
        let linked_root = fixture.path().join("linked-root");
        symlink(&root, &linked_root).unwrap();
        let linked_catalog = fixture.path().join("linked-projects.json");
        assert_eq!(
            register_project(
                &linked_catalog,
                "linked".into(),
                "Linked".into(),
                linked_root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_root_unsafe"
        );
        assert!(!linked_catalog.exists());

        let path = fixture.path().join("backend-projects.json");
        owner_file(&path, b"{");
        let malformed = fs::read(&path).unwrap();
        assert_eq!(
            register_project(
                &path,
                "dure".into(),
                "Dure".into(),
                root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_projects_catalog_invalid"
        );
        assert_eq!(fs::read(&path).unwrap(), malformed);

        owner_file(&path, &catalog(json!([])));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let unsafe_source = fs::read(&path).unwrap();
        assert_eq!(
            register_project(
                &path,
                "dure".into(),
                "Dure".into(),
                root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_projects_catalog_unsafe"
        );
        assert_eq!(fs::read(&path).unwrap(), unsafe_source);
    }

    /// Rewrites every persisted identity pin in the catalog file to a
    /// different valid-format value — exactly what a macOS device renumber
    /// (reboot/remount changing `st_dev`) does to hashes derived from
    /// device+inode while the directories themselves never moved.
    fn drift_identity_pins(path: &Path) {
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        for project in document["projects"].as_array_mut().unwrap() {
            project["rootId"] = json!(format!("root_{}", "d".repeat(32)));
            project["repositoryId"] = json!(format!("repo_{}", "d".repeat(32)));
        }
        owner_file(path, &serde_json::to_vec(&document).unwrap());
    }

    #[test]
    fn survives_identity_pin_drift_and_converges_pins_on_replay() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let root = repository(fixture.path(), "root");
        let path = fixture.path().join("backend-projects.json");
        let registered = register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        drift_identity_pins(&path);

        // Drifted pins are stale observations, not a root swap: the catalog
        // must stay loadable and the project resolvable by id and by path.
        let loaded = load_project_catalog(&path).unwrap();
        let authority = loaded.project("dure").unwrap();
        assert_eq!(authority.root(), root.as_path());
        assert!(
            loaded
                .project_for_path(root.to_str().unwrap())
                .is_some_and(|resolved| resolved.projection().id == "dure")
        );
        validate_project_root(&authority).unwrap();

        // A replay of the same registration converges the pins back to the
        // current filesystem identity instead of reporting a conflict.
        let replayed = register_project(
            &path,
            "dure".into(),
            "Dure".into(),
            root.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert_eq!(replayed, registered);
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["projects"][0]["rootId"], registered.root_id);
        assert_eq!(
            document["projects"][0]["repositoryId"],
            registered.repository_id
        );

        // A different root under an existing id is still a genuine conflict,
        // even while the stored pins are stale.
        drift_identity_pins(&path);
        let other = repository(fixture.path(), "other");
        assert_eq!(
            register_project(
                &path,
                "dure".into(),
                "Dure".into(),
                other.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_registration_conflict"
        );
        // So is the same root under a new id: duplicate detection follows the
        // root path, which stale pins can no longer hide.
        assert_eq!(
            register_project(
                &path,
                "other-id".into(),
                "Other".into(),
                root.to_string_lossy().into_owned(),
            )
            .unwrap_err(),
            "backend_project_registration_conflict"
        );
    }

    #[test]
    fn one_broken_entry_does_not_block_the_other_projects() {
        let fixture = tempdir().unwrap();
        fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let kept = repository(fixture.path(), "kept");
        let removed = repository(fixture.path(), "removed");
        let path = fixture.path().join("backend-projects.json");
        register_project(
            &path,
            "kept".into(),
            "Kept".into(),
            kept.to_string_lossy().into_owned(),
        )
        .unwrap();
        register_project(
            &path,
            "removed".into(),
            "Removed".into(),
            removed.to_string_lossy().into_owned(),
        )
        .unwrap();
        fs::remove_dir_all(&removed).unwrap();

        // A vanished root (deleted worktree) breaks only its own project.
        let loaded = load_project_catalog(&path).unwrap();
        assert_eq!(loaded.projections().len(), 2);
        let intact = loaded.project("kept").unwrap();
        validate_project_root(&intact).unwrap();
        let broken = loaded.project("removed").unwrap();
        assert_eq!(
            validate_project_root(&broken).unwrap_err(),
            "backend_project_root_unavailable"
        );
    }
}
