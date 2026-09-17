use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use dure_app::{
    PluginManifestV2, PluginPackageCandidateIdV2, PluginPackageCatalogSnapshotV2,
    PluginPackageSourceCandidateV2, PluginPackageSourceErrorV2, PluginPackageSourceV2,
};

pub(crate) const INSTALLED_PLUGIN_PACKAGES_DIRECTORY: &str = "installed-plugin-packages";
const MANIFEST_FILE: &str = "dure-plugin.json";
const MAX_CANDIDATES: usize = 64;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_CONTRIBUTION_FILES: usize = 64;
const MAX_CONTRIBUTION_FILE_BYTES: usize = 256 * 1024;
const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;

#[cfg(unix)]
type AnchoredDirectory = File;
#[cfg(not(unix))]
type AnchoredDirectory = PathBuf;

#[derive(Clone, Debug)]
pub(crate) struct InstalledPluginPackageSourceV2 {
    root: PathBuf,
}

impl InstalledPluginPackageSourceV2 {
    pub(crate) fn under_app_root(app_root: &Path) -> Self {
        Self {
            root: app_root.join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY),
        }
    }

    fn source_rejection(
        candidate_id: &str,
        message: impl Into<String>,
    ) -> Vec<PluginPackageSourceCandidateV2> {
        vec![PluginPackageSourceCandidateV2::rejected(
            PluginPackageCandidateIdV2::new(candidate_id)
                .expect("installed source rejection ID is static and valid"),
            PluginPackageSourceErrorV2::new(message),
        )]
    }

    fn load_candidate(
        source_root: &AnchoredDirectory,
        file_name: &OsStr,
        index: usize,
    ) -> PluginPackageSourceCandidateV2 {
        let candidate_id = match file_name
            .to_str()
            .and_then(|name| PluginPackageCandidateIdV2::new(name).ok())
        {
            Some(candidate_id) => candidate_id,
            None => {
                return PluginPackageSourceCandidateV2::rejected(
                    PluginPackageCandidateIdV2::new(format!("invalid.{index}"))
                        .expect("generated installed candidate ID is valid"),
                    PluginPackageSourceErrorV2::new(
                        "installed package directory name is not a stable candidate ID",
                    ),
                );
            }
        };
        let outcome = load_package(source_root, file_name);
        match outcome {
            Ok(package) => PluginPackageSourceCandidateV2::accepted(candidate_id, package),
            Err(error) => PluginPackageSourceCandidateV2::rejected(
                candidate_id,
                PluginPackageSourceErrorV2::new(error),
            ),
        }
    }
}

impl PluginPackageSourceV2 for InstalledPluginPackageSourceV2 {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        let metadata = match fs::symlink_metadata(&self.root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(_) => {
                return Self::source_rejection(
                    "source.unavailable",
                    "installed package source is unavailable",
                );
            }
        };
        if metadata.file_type().is_symlink() {
            return Self::source_rejection(
                "source.symlink",
                "installed package source cannot be a symlink",
            );
        }
        if !metadata.is_dir() {
            return Self::source_rejection(
                "source.invalid",
                "installed package source is not a directory",
            );
        }
        let source_root = match open_directory(&self.root) {
            Ok(source_root) => source_root,
            Err(message) => return Self::source_rejection("source.unavailable", message),
        };
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(_) => {
                return Self::source_rejection(
                    "source.unavailable",
                    "installed package source cannot be enumerated",
                );
            }
        };
        let mut file_names = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else {
                return Self::source_rejection(
                    "source.unavailable",
                    "installed package source cannot be enumerated",
                );
            };
            file_names.push(entry.file_name());
            if file_names.len() > MAX_CANDIDATES {
                return Self::source_rejection(
                    "source.limit",
                    format!(
                        "installed package source exceeds the {MAX_CANDIDATES}-candidate limit"
                    ),
                );
            }
        }
        file_names.sort();
        file_names
            .iter()
            .enumerate()
            .map(|(index, file_name)| Self::load_candidate(&source_root, file_name, index))
            .collect()
    }
}

fn load_package(
    source_root: &AnchoredDirectory,
    candidate_name: &OsStr,
) -> Result<PluginPackageCatalogSnapshotV2, String> {
    let candidate_root = open_child_directory(source_root, candidate_name)?;
    let manifest_bytes =
        read_bounded_relative_file(&candidate_root, MANIFEST_FILE, MAX_MANIFEST_BYTES)?;
    let manifest: PluginManifestV2 = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "installed package manifest is invalid JSON".to_owned())?;
    if !manifest.agent_integrations.is_empty() {
        return Err(
            "installed declarative packages cannot contain native agent integrations".to_owned(),
        );
    }
    let resource_paths = manifest
        .contributions
        .iter()
        .map(|contribution| contribution.resource.clone())
        .collect::<BTreeSet<_>>();
    if resource_paths.len() > MAX_CONTRIBUTION_FILES {
        return Err(format!(
            "installed package exceeds the {MAX_CONTRIBUTION_FILES}-resource limit"
        ));
    }
    let mut total_bytes = manifest_bytes.len();
    let mut resources = BTreeMap::new();
    for resource_path in resource_paths {
        let relative = resource_path
            .as_str()
            .strip_prefix("./")
            .expect("validated plugin resource paths start with './'");
        let bytes =
            read_bounded_relative_file(&candidate_root, relative, MAX_CONTRIBUTION_FILE_BYTES)?;
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "installed package byte count overflowed".to_owned())?;
        if total_bytes > MAX_PACKAGE_BYTES {
            return Err(format!(
                "installed package exceeds the {MAX_PACKAGE_BYTES}-byte limit"
            ));
        }
        resources.insert(resource_path, bytes);
    }
    PluginPackageCatalogSnapshotV2::try_new(manifest, resources).map_err(|error| error.to_string())
}

fn read_bounded(mut file: File, maximum_bytes: usize) -> Result<Arc<[u8]>, String> {
    let metadata = file
        .metadata()
        .map_err(|_| "installed package file metadata is unavailable".to_owned())?;
    if !metadata.is_file() {
        return Err("installed package resource is not a regular file".to_owned());
    }
    if metadata.len() > maximum_bytes as u64 {
        return Err(format!(
            "installed package file exceeds the {maximum_bytes}-byte limit"
        ));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "installed package file cannot be read".to_owned())?;
    if bytes.len() > maximum_bytes {
        return Err(format!(
            "installed package file exceeds the {maximum_bytes}-byte limit"
        ));
    }
    Ok(Arc::from(bytes))
}

#[cfg(unix)]
fn open_directory(path: &Path) -> Result<AnchoredDirectory, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW);
    options
        .open(path)
        .map_err(|_| "installed package source cannot be opened safely".to_owned())
}

#[cfg(not(unix))]
fn open_directory(path: &Path) -> Result<AnchoredDirectory, String> {
    Ok(path.to_path_buf())
}

#[cfg(unix)]
fn open_child_directory(
    parent: &AnchoredDirectory,
    name: &OsStr,
) -> Result<AnchoredDirectory, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| "installed package directory name is invalid".to_owned())?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err("installed package candidate is not a real directory".to_owned());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(not(unix))]
fn open_child_directory(
    parent: &AnchoredDirectory,
    name: &OsStr,
) -> Result<AnchoredDirectory, String> {
    let path = parent.join(name);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "installed package candidate is unavailable".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("installed package candidate is not a real directory".to_owned());
    }
    Ok(path)
}

#[cfg(unix)]
fn read_bounded_relative_file(
    root: &AnchoredDirectory,
    relative: &str,
    maximum_bytes: usize,
) -> Result<Arc<[u8]>, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let segments = relative.split('/').collect::<Vec<_>>();
    let (file_name, parent_segments) = segments
        .split_last()
        .ok_or_else(|| "installed package resource path is empty".to_owned())?;
    let mut directory = root
        .try_clone()
        .map_err(|_| "installed package directory cannot be retained".to_owned())?;
    for segment in parent_segments {
        directory = open_child_directory(&directory, OsStr::new(segment))?;
    }
    let file_name = std::ffi::CString::new(OsStr::new(file_name).as_bytes())
        .map_err(|_| "installed package resource path is invalid".to_owned())?;
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if descriptor < 0 {
        return Err("installed package resource is unavailable".to_owned());
    }
    read_bounded(unsafe { File::from_raw_fd(descriptor) }, maximum_bytes)
}

#[cfg(not(unix))]
fn read_bounded_relative_file(
    root: &AnchoredDirectory,
    relative: &str,
    maximum_bytes: usize,
) -> Result<Arc<[u8]>, String> {
    let mut path = root.clone();
    let segments = relative.split('/').collect::<Vec<_>>();
    for (index, segment) in segments.iter().enumerate() {
        path.push(segment);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "installed package resource is unavailable".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("installed package resource cannot be a symlink".to_owned());
        }
        if index + 1 == segments.len() {
            if !metadata.is_file() {
                return Err("installed package resource is not a regular file".to_owned());
            }
        } else if !metadata.is_dir() {
            return Err("installed package resource parent is not a directory".to_owned());
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| "installed package resource is unavailable".to_owned())?;
    read_bounded(file, maximum_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_bundled_package::{BUNDLED_BEADS_MANIFEST, BUNDLED_BEADS_SETTINGS};
    use dure_app::{
        PluginIdV2, PluginPackageRegistryV2, PluginPackageSourceIdV2,
        PluginPackageSourceRegistrationV2,
    };

    fn write_package(root: &Path, candidate: &str, plugin_id: &str) -> PathBuf {
        let package_root = root
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .join(candidate);
        fs::create_dir_all(package_root.join("contributions")).unwrap();
        let mut manifest: serde_json::Value =
            serde_json::from_slice(BUNDLED_BEADS_MANIFEST).unwrap();
        manifest["id"] = serde_json::Value::String(plugin_id.to_owned());
        manifest["publisher"] = serde_json::Value::String(
            plugin_id
                .split_once('.')
                .map(|(publisher, _)| publisher)
                .unwrap()
                .to_owned(),
        );
        manifest["display_name"] = serde_json::Value::String(plugin_id.to_owned());
        manifest["agent_integrations"] = serde_json::json!([]);
        manifest["permissions"] = serde_json::json!([]);
        let settings = manifest["contributions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|contribution| contribution["family"] == "dure.settings")
            .unwrap()
            .clone();
        manifest["contributions"] = serde_json::json!([settings]);
        manifest["contributions"][0]["id"] =
            serde_json::Value::String(format!("{plugin_id}.settings"));
        fs::write(
            package_root.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            package_root.join("contributions/settings.json"),
            BUNDLED_BEADS_SETTINGS,
        )
        .unwrap();
        package_root
    }

    fn registry(source: &InstalledPluginPackageSourceV2) -> PluginPackageRegistryV2 {
        PluginPackageRegistryV2::from_sources(&[PluginPackageSourceRegistrationV2::new(
            PluginPackageSourceIdV2::new("dure.installed").unwrap(),
            source,
        )])
    }

    #[test]
    fn missing_root_is_empty_without_creating_storage() {
        let app_root = tempfile::tempdir().unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        assert!(source.load().is_empty());
        assert!(!app_root
            .path()
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .exists());
    }

    #[test]
    fn valid_package_survives_a_malformed_sibling() {
        let app_root = tempfile::tempdir().unwrap();
        write_package(app_root.path(), "example.valid", "example.valid");
        let broken = app_root
            .path()
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .join("example.broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(MANIFEST_FILE), b"{").unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);

        assert_eq!(registry.available_len(), 1);
        assert!(registry
            .package(&PluginIdV2::new("example.valid").unwrap())
            .is_ok());
        assert_eq!(registry.source_rejections().len(), 1);
        assert_eq!(
            registry.source_rejections()[0].candidate_id().as_str(),
            "example.broken"
        );
    }

    #[test]
    fn native_integration_manifest_is_rejected_before_resources_are_read() {
        let app_root = tempfile::tempdir().unwrap();
        let package_root = app_root
            .path()
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .join("example.native");
        fs::create_dir_all(&package_root).unwrap();
        fs::write(package_root.join(MANIFEST_FILE), BUNDLED_BEADS_MANIFEST).unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);

        assert!(registry.is_empty());
        assert_eq!(registry.source_rejections().len(), 1);
        assert!(registry.source_rejections()[0]
            .error()
            .to_string()
            .contains("native agent integrations"));
    }

    #[test]
    fn candidate_limit_fails_closed_without_partial_selection() {
        let app_root = tempfile::tempdir().unwrap();
        let source_root = app_root.path().join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY);
        fs::create_dir_all(&source_root).unwrap();
        for index in 0..=MAX_CANDIDATES {
            fs::create_dir(source_root.join(format!("example.package{index}"))).unwrap();
        }
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);

        assert!(registry.is_empty());
        assert_eq!(registry.source_rejections().len(), 1);
        assert_eq!(
            registry.source_rejections()[0].candidate_id().as_str(),
            "source.limit"
        );
    }

    #[test]
    fn oversized_resource_rejection_does_not_expose_host_path() {
        let app_root = tempfile::tempdir().unwrap();
        let package_root = write_package(app_root.path(), "example.oversized", "example.oversized");
        fs::write(
            package_root.join("contributions/settings.json"),
            vec![b'x'; MAX_CONTRIBUTION_FILE_BYTES + 1],
        )
        .unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);
        let error = registry.source_rejections()[0].error().to_string();

        assert!(error.contains("byte limit"));
        assert!(!error.contains(app_root.path().to_string_lossy().as_ref()));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_candidate_directory_is_rejected() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let source_root = app_root.path().join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY);
        let outside = app_root.path().join("outside");
        fs::create_dir_all(&source_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join(MANIFEST_FILE), BUNDLED_BEADS_MANIFEST).unwrap();
        symlink(&outside, source_root.join("example.symlinked-directory")).unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);

        assert!(registry.is_empty());
        assert_eq!(registry.source_rejections().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_manifest_is_rejected() {
        use std::os::unix::fs::symlink;

        let app_root = tempfile::tempdir().unwrap();
        let package_root = app_root
            .path()
            .join(INSTALLED_PLUGIN_PACKAGES_DIRECTORY)
            .join("example.symlink");
        fs::create_dir_all(&package_root).unwrap();
        let outside = app_root.path().join("outside.json");
        fs::write(&outside, BUNDLED_BEADS_MANIFEST).unwrap();
        symlink(&outside, package_root.join(MANIFEST_FILE)).unwrap();
        let source = InstalledPluginPackageSourceV2::under_app_root(app_root.path());

        let registry = registry(&source);

        assert!(registry.is_empty());
        assert_eq!(registry.source_rejections().len(), 1);
    }
}
