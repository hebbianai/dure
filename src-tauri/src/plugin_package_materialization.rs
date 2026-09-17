#![cfg(unix)]

use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    ffi::{CStr, CString, OsStr, OsString},
    fmt,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, RawFd},
        unix::ffi::{OsStrExt, OsStringExt},
    },
    path::{Component, Path, PathBuf},
};

use dure_app::{
    PluginIdV2, PluginPackageEmbeddedAuthoritySha256V2, PluginPackageEmbeddedAuthorityV2,
    PluginPackageEmbeddedFileManifestSha256V2, PluginVersionV2, RegisteredPluginPackageV2,
};
use fs2::FileExt;

const MATERIALIZATION_SCHEMA_VERSION_V1: u16 = 1;
const MATERIALIZATION_DIRECTORY: &str = "native-plugin-packages";
const MATERIALIZATION_LOCK_FILE: &str = ".materialize.lock";
const PACKAGE_DIRECTORY: &str = "package";
const CONTROL_DIRECTORY_MODE: u32 = 0o700;
const STAGING_FILE_MODE: u32 = 0o600;
const SEALED_DIRECTORY_MODE: u32 = 0o500;
const SEALED_FILE_MODE: u32 = 0o400;
const MAX_STAGING_ATTEMPTS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PluginPackageMaterializationReceiptV1 {
    schema_version: u16,
    plugin_id: PluginIdV2,
    plugin_version: PluginVersionV2,
    embedded_authority_sha256: PluginPackageEmbeddedAuthoritySha256V2,
    file_manifest_sha256: PluginPackageEmbeddedFileManifestSha256V2,
    root_device: u64,
    root_inode: u64,
}

impl PluginPackageMaterializationReceiptV1 {
    pub(crate) fn schema_version(&self) -> u16 {
        self.schema_version
    }

    pub(crate) fn plugin_id(&self) -> &PluginIdV2 {
        &self.plugin_id
    }

    pub(crate) fn plugin_version(&self) -> &PluginVersionV2 {
        &self.plugin_version
    }

    pub(crate) fn embedded_authority_sha256(&self) -> &PluginPackageEmbeddedAuthoritySha256V2 {
        &self.embedded_authority_sha256
    }

    pub(crate) fn file_manifest_sha256(&self) -> &PluginPackageEmbeddedFileManifestSha256V2 {
        &self.file_manifest_sha256
    }

    pub(crate) fn root_identity(&self) -> (u64, u64) {
        (self.root_device, self.root_inode)
    }
}

#[derive(Debug)]
pub(crate) struct MaterializedPluginPackage {
    package_root: PathBuf,
    package_root_lease: File,
    receipt: PluginPackageMaterializationReceiptV1,
}

impl MaterializedPluginPackage {
    pub(crate) fn package_root(&self) -> &Path {
        &self.package_root
    }

    pub(crate) fn package_root_lease(&self) -> &File {
        &self.package_root_lease
    }

    pub(crate) fn receipt(&self) -> &PluginPackageMaterializationReceiptV1 {
        &self.receipt
    }

    pub(crate) fn revalidate(
        &self,
        package: &RegisteredPluginPackageV2,
    ) -> Result<(), PluginPackageMaterializationError> {
        let authority = package
            .embedded_authority()
            .ok_or(PluginPackageMaterializationError::EmbeddedAuthorityUnavailable)?;
        validate_materialized_tree(&self.package_root_lease, authority, true)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PluginPackageMaterializationError {
    EmbeddedAuthorityUnavailable,
    RootUnavailable,
    RootIsSymlink,
    RootIsNotDirectory,
    RootIsNotOwnerOnly,
    MaterializedPackageInvalid,
    PublishFailed {
        retained_staging: PathBuf,
    },
    Io {
        operation: &'static str,
        path: PathBuf,
    },
}

impl fmt::Display for PluginPackageMaterializationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmbeddedAuthorityUnavailable => {
                formatter.write_str("plugin has no embedded package authority")
            }
            Self::RootUnavailable => formatter.write_str("materialization root is unavailable"),
            Self::RootIsSymlink => formatter.write_str("materialization root is a symlink"),
            Self::RootIsNotDirectory => {
                formatter.write_str("materialization root is not a directory")
            }
            Self::RootIsNotOwnerOnly => {
                formatter.write_str("materialization root is not owner-only")
            }
            Self::MaterializedPackageInvalid => {
                formatter.write_str("materialized plugin package is not the exact embedded image")
            }
            Self::PublishFailed { retained_staging } => write!(
                formatter,
                "materialized plugin package publish failed; staging retained at {}",
                retained_staging.display()
            ),
            Self::Io { operation, path } => {
                write!(formatter, "failed to {operation} {}", path.display())
            }
        }
    }
}

impl Error for PluginPackageMaterializationError {}

struct AnchoredDirectory {
    file: File,
    diagnostic_path: PathBuf,
}

impl AnchoredDirectory {
    fn open_absolute(path: &Path) -> Result<Self, PluginPackageMaterializationError> {
        if !path.is_absolute() {
            return Err(PluginPackageMaterializationError::RootUnavailable);
        }
        let segments = path
            .components()
            .filter_map(|component| match component {
                Component::RootDir => None,
                Component::Normal(segment) => Some(Ok(segment)),
                _ => Some(Err(PluginPackageMaterializationError::RootUnavailable)),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut directory = open_root_directory()?;
        let mut diagnostic_path = PathBuf::from("/");
        for segment in &segments {
            diagnostic_path.push(segment);
            directory = open_directory_at_raw(directory.as_raw_fd(), segment).map_err(|error| {
                if error.raw_os_error() == Some(libc::ELOOP) {
                    PluginPackageMaterializationError::RootIsSymlink
                } else {
                    io_error("open anchored materialization root", &diagnostic_path)
                }
            })?;
            if file_metadata(&directory)?.mode & libc::S_IFMT as u32 != libc::S_IFDIR as u32 {
                return Err(PluginPackageMaterializationError::RootIsNotDirectory);
            }
        }
        validate_directory_metadata(&directory, CONTROL_DIRECTORY_MODE)?;
        Ok(Self {
            file: directory,
            diagnostic_path,
        })
    }

    fn open_child(
        &self,
        name: &OsStr,
        expected_mode: u32,
    ) -> Result<Self, PluginPackageMaterializationError> {
        let diagnostic_path = self.diagnostic_path.join(name);
        let file = open_directory_at(self.file.as_raw_fd(), name, &diagnostic_path, expected_mode)?;
        Ok(Self {
            file,
            diagnostic_path,
        })
    }

    fn open_child_if_present(
        &self,
        name: &OsStr,
        expected_mode: u32,
    ) -> Result<Option<Self>, PluginPackageMaterializationError> {
        let diagnostic_path = self.diagnostic_path.join(name);
        match open_directory_at_raw(self.file.as_raw_fd(), name) {
            Ok(file) => {
                validate_directory_metadata(&file, expected_mode)?;
                Ok(Some(Self {
                    file,
                    diagnostic_path,
                }))
            }
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(None),
            Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
                Err(PluginPackageMaterializationError::RootIsSymlink)
            }
            Err(_) => Err(io_error(
                "open anchored materialization directory",
                &diagnostic_path,
            )),
        }
    }

    fn create_child(
        &self,
        name: &OsStr,
        mode: u32,
    ) -> Result<Self, PluginPackageMaterializationError> {
        let diagnostic_path = self.diagnostic_path.join(name);
        mkdir_at(self.file.as_raw_fd(), name, mode).map_err(|_| {
            io_error(
                "create anchored materialization directory",
                &diagnostic_path,
            )
        })?;
        self.open_child(name, mode)
    }

    fn open_or_create_child(
        &self,
        name: &OsStr,
        mode: u32,
    ) -> Result<Self, PluginPackageMaterializationError> {
        match self.create_child(name, mode) {
            Ok(directory) => Ok(directory),
            Err(PluginPackageMaterializationError::Io { .. }) => self.open_child(name, mode),
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn materialize_registered_plugin_package(
    app_data_root: &Path,
    package: &RegisteredPluginPackageV2,
) -> Result<MaterializedPluginPackage, PluginPackageMaterializationError> {
    let authority = package
        .embedded_authority()
        .ok_or(PluginPackageMaterializationError::EmbeddedAuthorityUnavailable)?;
    let digest = authority_digest_directory(authority)?;
    let app_data = AnchoredDirectory::open_absolute(app_data_root)?;
    let control = app_data.open_or_create_child(
        OsStr::new(MATERIALIZATION_DIRECTORY),
        CONTROL_DIRECTORY_MODE,
    )?;
    let lock = open_or_create_lock_file(&control)?;
    lock.lock_exclusive()
        .map_err(|_| io_error("lock materialization publisher", &control.diagnostic_path))?;

    if let Some(generation) =
        control.open_child_if_present(OsStr::new(&digest), CONTROL_DIRECTORY_MODE)?
    {
        return open_materialized_package(package, authority, generation);
    }

    let staging_name = create_staging_name(&control)?;
    let staging = control.create_child(OsStr::new(&staging_name), CONTROL_DIRECTORY_MODE)?;
    let package_root =
        staging.create_child(OsStr::new(PACKAGE_DIRECTORY), CONTROL_DIRECTORY_MODE)?;
    for (resource, bytes) in authority.package_files() {
        write_package_file(&package_root, resource.as_str(), bytes)?;
    }
    validate_materialized_tree(&package_root.file, authority, false)?;
    seal_materialized_tree(&package_root.file, authority)?;
    validate_materialized_tree(&package_root.file, authority, true)?;
    staging.file.sync_all().map_err(|_| {
        io_error(
            "sync materialization staging directory",
            &staging.diagnostic_path,
        )
    })?;

    if publish_noreplace(
        control.file.as_raw_fd(),
        OsStr::new(&staging_name),
        OsStr::new(&digest),
    )
    .is_err()
    {
        return Err(PluginPackageMaterializationError::PublishFailed {
            retained_staging: control.diagnostic_path.join(staging_name),
        });
    }
    control.file.sync_all().map_err(|_| {
        io_error(
            "sync materialization control directory",
            &control.diagnostic_path,
        )
    })?;
    let generation = control.open_child(OsStr::new(&digest), CONTROL_DIRECTORY_MODE)?;
    open_materialized_package(package, authority, generation)
}

pub(crate) fn open_existing_registered_plugin_package(
    app_data_root: &Path,
    package: &RegisteredPluginPackageV2,
) -> Result<MaterializedPluginPackage, PluginPackageMaterializationError> {
    let authority = package
        .embedded_authority()
        .ok_or(PluginPackageMaterializationError::EmbeddedAuthorityUnavailable)?;
    let digest = authority_digest_directory(authority)?;
    let app_data = AnchoredDirectory::open_absolute(app_data_root)?;
    let control = app_data.open_child(
        OsStr::new(MATERIALIZATION_DIRECTORY),
        CONTROL_DIRECTORY_MODE,
    )?;
    let generation = control.open_child(OsStr::new(&digest), CONTROL_DIRECTORY_MODE)?;
    open_materialized_package(package, authority, generation)
}

#[cfg(feature = "provider-conformance-test-support")]
pub(crate) fn revalidate_registered_plugin_package_lease(
    package_root_lease: &File,
    package: &RegisteredPluginPackageV2,
) -> Result<(), PluginPackageMaterializationError> {
    let authority = package
        .embedded_authority()
        .ok_or(PluginPackageMaterializationError::EmbeddedAuthorityUnavailable)?;
    validate_materialized_tree(package_root_lease, authority, true)
}

fn open_materialized_package(
    package: &RegisteredPluginPackageV2,
    authority: &PluginPackageEmbeddedAuthorityV2,
    generation: AnchoredDirectory,
) -> Result<MaterializedPluginPackage, PluginPackageMaterializationError> {
    validate_generation(&generation, authority)?;
    let package_root =
        generation.open_child(OsStr::new(PACKAGE_DIRECTORY), SEALED_DIRECTORY_MODE)?;
    validate_materialized_tree(&package_root.file, authority, true)?;
    let metadata = package_root.file.metadata().map_err(|_| {
        io_error(
            "inspect materialized package lease",
            &package_root.diagnostic_path,
        )
    })?;
    Ok(MaterializedPluginPackage {
        package_root: package_root.diagnostic_path,
        package_root_lease: package_root.file,
        receipt: PluginPackageMaterializationReceiptV1 {
            schema_version: MATERIALIZATION_SCHEMA_VERSION_V1,
            plugin_id: package.manifest().id.clone(),
            plugin_version: package.manifest().version.clone(),
            embedded_authority_sha256: authority.sha256().clone(),
            file_manifest_sha256: authority.file_manifest_sha256().clone(),
            root_device: std::os::unix::fs::MetadataExt::dev(&metadata),
            root_inode: std::os::unix::fs::MetadataExt::ino(&metadata),
        },
    })
}

fn validate_generation(
    generation: &AnchoredDirectory,
    authority: &PluginPackageEmbeddedAuthorityV2,
) -> Result<(), PluginPackageMaterializationError> {
    let names = directory_names(&generation.file)?;
    if names != [OsString::from(PACKAGE_DIRECTORY)] {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    let package_root =
        generation.open_child(OsStr::new(PACKAGE_DIRECTORY), SEALED_DIRECTORY_MODE)?;
    validate_materialized_tree(&package_root.file, authority, true)
}

fn authority_digest_directory(
    authority: &PluginPackageEmbeddedAuthorityV2,
) -> Result<String, PluginPackageMaterializationError> {
    let digest = authority
        .sha256()
        .as_str()
        .strip_prefix("sha256:")
        .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(digest.to_owned())
}

type ExpectedTree<'a> = (BTreeMap<String, &'a [u8]>, BTreeSet<String>);

fn expected_tree(
    authority: &PluginPackageEmbeddedAuthorityV2,
) -> Result<ExpectedTree<'_>, PluginPackageMaterializationError> {
    let mut files = BTreeMap::new();
    let mut directories = BTreeSet::new();
    for (resource, bytes) in authority.package_files() {
        let relative = resource
            .as_str()
            .strip_prefix("./")
            .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
        files.insert(relative.to_owned(), bytes);
        let mut parent = Path::new(relative).parent();
        while let Some(path) = parent {
            if path.as_os_str().is_empty() {
                break;
            }
            directories.insert(
                path.to_str()
                    .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?
                    .to_owned(),
            );
            parent = path.parent();
        }
    }
    Ok((files, directories))
}

fn validate_materialized_tree(
    package_root: &File,
    authority: &PluginPackageEmbeddedAuthorityV2,
    sealed: bool,
) -> Result<(), PluginPackageMaterializationError> {
    validate_directory_metadata(
        package_root,
        if sealed {
            SEALED_DIRECTORY_MODE
        } else {
            CONTROL_DIRECTORY_MODE
        },
    )?;
    let (expected_files, expected_directories) = expected_tree(authority)?;
    let mut observed_files = BTreeSet::new();
    let mut observed_directories = BTreeSet::new();
    validate_directory_contents(
        package_root,
        "",
        &expected_files,
        &expected_directories,
        &mut observed_files,
        &mut observed_directories,
        sealed,
    )?;
    if observed_files.len() != expected_files.len() || observed_directories != expected_directories
    {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(())
}

fn validate_directory_contents(
    directory: &File,
    prefix: &str,
    expected_files: &BTreeMap<String, &[u8]>,
    expected_directories: &BTreeSet<String>,
    observed_files: &mut BTreeSet<String>,
    observed_directories: &mut BTreeSet<String>,
    sealed: bool,
) -> Result<(), PluginPackageMaterializationError> {
    for name in directory_names(directory)? {
        let name = name
            .to_str()
            .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
        let relative = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        let path_metadata = stat_at(directory.as_raw_fd(), OsStr::new(name))?;
        match path_metadata.mode & libc::S_IFMT as u32 {
            value if value == libc::S_IFDIR as u32 => {
                if !expected_directories.contains(&relative) {
                    return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
                }
                let child = open_directory_at_raw(directory.as_raw_fd(), OsStr::new(name))
                    .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
                validate_identity(&child, &path_metadata)?;
                validate_directory_metadata(
                    &child,
                    if sealed {
                        SEALED_DIRECTORY_MODE
                    } else {
                        CONTROL_DIRECTORY_MODE
                    },
                )?;
                observed_directories.insert(relative.clone());
                validate_directory_contents(
                    &child,
                    &relative,
                    expected_files,
                    expected_directories,
                    observed_files,
                    observed_directories,
                    sealed,
                )?;
            }
            value if value == libc::S_IFREG as u32 => {
                let expected = expected_files
                    .get(&relative)
                    .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
                validate_exact_file(
                    directory,
                    OsStr::new(name),
                    &path_metadata,
                    expected,
                    if sealed {
                        SEALED_FILE_MODE
                    } else {
                        STAGING_FILE_MODE
                    },
                )?;
                observed_files.insert(relative);
            }
            _ => return Err(PluginPackageMaterializationError::MaterializedPackageInvalid),
        }
    }
    Ok(())
}

fn validate_exact_file(
    parent: &File,
    name: &OsStr,
    path_metadata: &RawMetadata,
    expected: &[u8],
    expected_mode: u32,
) -> Result<(), PluginPackageMaterializationError> {
    if path_metadata.owner != effective_uid()
        || path_metadata.mode & 0o7777 != expected_mode
        || path_metadata.link_count != 1
        || path_metadata.size != expected.len() as u64
    {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    let mut file = open_file_at(parent.as_raw_fd(), name, libc::O_RDONLY, 0)
        .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    validate_identity(&file, path_metadata)?;
    let mut actual = Vec::with_capacity(expected.len());
    file.read_to_end(&mut actual)
        .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    if actual != expected {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(())
}

fn write_package_file(
    package_root: &AnchoredDirectory,
    resource: &str,
    bytes: &[u8],
) -> Result<(), PluginPackageMaterializationError> {
    let segments = resource_segments(resource)?;
    let (file_name, parent_segments) = segments
        .split_last()
        .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    let mut parent = package_root.file.try_clone().map_err(|_| {
        io_error(
            "clone materialized package root descriptor",
            &package_root.diagnostic_path,
        )
    })?;
    let mut diagnostic_path = package_root.diagnostic_path.clone();
    for segment in parent_segments {
        diagnostic_path.push(segment);
        match mkdir_at(
            parent.as_raw_fd(),
            OsStr::new(segment),
            CONTROL_DIRECTORY_MODE,
        ) {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {}
            Err(_) => {
                return Err(io_error(
                    "create materialized package parent",
                    &diagnostic_path,
                ));
            }
        }
        parent = open_directory_at(
            parent.as_raw_fd(),
            OsStr::new(segment),
            &diagnostic_path,
            CONTROL_DIRECTORY_MODE,
        )?;
    }
    let file_path = diagnostic_path.join(file_name);
    let mut file = open_file_at(
        parent.as_raw_fd(),
        OsStr::new(file_name),
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        STAGING_FILE_MODE,
    )
    .map_err(|_| io_error("create materialized package file", &file_path))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| io_error("write materialized package file", &file_path))?;
    validate_regular_file_metadata(&file, STAGING_FILE_MODE, bytes.len() as u64)
}

fn resource_segments(resource: &str) -> Result<Vec<&str>, PluginPackageMaterializationError> {
    let relative = resource
        .strip_prefix("./")
        .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    let segments = relative.split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(segments)
}

fn seal_materialized_tree(
    package_root: &File,
    authority: &PluginPackageEmbeddedAuthorityV2,
) -> Result<(), PluginPackageMaterializationError> {
    let (expected_files, expected_directories) = expected_tree(authority)?;
    seal_directory_contents(package_root, "", &expected_files, &expected_directories)?;
    set_file_mode(package_root, SEALED_DIRECTORY_MODE)?;
    package_root
        .sync_all()
        .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)
}

fn seal_directory_contents(
    directory: &File,
    prefix: &str,
    expected_files: &BTreeMap<String, &[u8]>,
    expected_directories: &BTreeSet<String>,
) -> Result<(), PluginPackageMaterializationError> {
    for name in directory_names(directory)? {
        let name = name
            .to_str()
            .ok_or(PluginPackageMaterializationError::MaterializedPackageInvalid)?;
        let relative = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        let metadata = stat_at(directory.as_raw_fd(), OsStr::new(name))?;
        match metadata.mode & libc::S_IFMT as u32 {
            value if value == libc::S_IFDIR as u32 && expected_directories.contains(&relative) => {
                let child = open_directory_at_raw(directory.as_raw_fd(), OsStr::new(name))
                    .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
                validate_identity(&child, &metadata)?;
                seal_directory_contents(&child, &relative, expected_files, expected_directories)?;
                set_file_mode(&child, SEALED_DIRECTORY_MODE)?;
                child
                    .sync_all()
                    .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
            }
            value if value == libc::S_IFREG as u32 && expected_files.contains_key(&relative) => {
                let file = open_file_at(directory.as_raw_fd(), OsStr::new(name), libc::O_RDONLY, 0)
                    .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
                validate_identity(&file, &metadata)?;
                set_file_mode(&file, SEALED_FILE_MODE)?;
                file.sync_all()
                    .map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
            }
            _ => return Err(PluginPackageMaterializationError::MaterializedPackageInvalid),
        }
    }
    Ok(())
}

fn create_staging_name(
    control: &AnchoredDirectory,
) -> Result<String, PluginPackageMaterializationError> {
    for _ in 0..MAX_STAGING_ATTEMPTS {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| {
            io_error(
                "generate materialization staging identity",
                &control.diagnostic_path,
            )
        })?;
        let name = format!(
            ".materialize-{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        match control.open_child_if_present(OsStr::new(&name), CONTROL_DIRECTORY_MODE) {
            Ok(None) => return Ok(name),
            Ok(Some(_)) => continue,
            Err(PluginPackageMaterializationError::RootIsNotOwnerOnly) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(PluginPackageMaterializationError::PublishFailed {
        retained_staging: control.diagnostic_path.clone(),
    })
}

fn open_or_create_lock_file(
    control: &AnchoredDirectory,
) -> Result<File, PluginPackageMaterializationError> {
    let path = control.diagnostic_path.join(MATERIALIZATION_LOCK_FILE);
    let mut file = None;
    for _ in 0..MAX_STAGING_ATTEMPTS {
        match open_file_at(
            control.file.as_raw_fd(),
            OsStr::new(MATERIALIZATION_LOCK_FILE),
            libc::O_RDWR | libc::O_CREAT,
            STAGING_FILE_MODE,
        ) {
            Ok(opened) => {
                file = Some(opened);
                break;
            }
            Err(error)
                if error.raw_os_error() == Some(libc::ENOENT)
                    || error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(io_error("open materialization lock", &path)),
        }
        std::thread::yield_now();
    }
    let file = file.ok_or_else(|| io_error("open materialization lock", &path))?;
    validate_regular_file_metadata(&file, STAGING_FILE_MODE, 0)?;
    Ok(file)
}

fn open_root_directory() -> Result<File, PluginPackageMaterializationError> {
    let path = CString::new("/").expect("root path contains no NUL");
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        return Err(PluginPackageMaterializationError::RootUnavailable);
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn open_directory_at(
    parent: RawFd,
    name: &OsStr,
    diagnostic_path: &Path,
    expected_mode: u32,
) -> Result<File, PluginPackageMaterializationError> {
    let file = open_directory_at_raw(parent, name).map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            PluginPackageMaterializationError::RootIsSymlink
        } else {
            io_error("open anchored materialization directory", diagnostic_path)
        }
    })?;
    validate_directory_metadata(&file, expected_mode)?;
    Ok(file)
}

fn open_directory_at_raw(parent: RawFd, name: &OsStr) -> std::io::Result<File> {
    open_file_at_raw(
        parent,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        0,
    )
}

fn open_file_at(
    parent: RawFd,
    name: &OsStr,
    flags: libc::c_int,
    mode: u32,
) -> std::io::Result<File> {
    open_file_at_raw(parent, name, flags | libc::O_NOFOLLOW, mode)
}

fn open_file_at_raw(
    parent: RawFd,
    name: &OsStr,
    flags: libc::c_int,
    mode: u32,
) -> std::io::Result<File> {
    let name = cstring(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if descriptor == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

fn mkdir_at(parent: RawFd, name: &OsStr, mode: u32) -> std::io::Result<()> {
    let name = cstring(name)?;
    if unsafe { libc::mkdirat(parent, name.as_ptr(), mode as libc::mode_t) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn publish_noreplace(parent: RawFd, source: &OsStr, destination: &OsStr) -> std::io::Result<()> {
    let source = cstring(source)?;
    let destination = cstring(destination)?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            parent,
            source.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            parent,
            source.as_ptr(),
            parent,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = -1;
    if result == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct RawMetadata {
    device: u64,
    inode: u64,
    owner: u32,
    mode: u32,
    link_count: u64,
    size: u64,
}

fn stat_at(parent: RawFd, name: &OsStr) -> Result<RawMetadata, PluginPackageMaterializationError> {
    let name =
        cstring(name).map_err(|_| PluginPackageMaterializationError::MaterializedPackageInvalid)?;
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == -1
    {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(raw_metadata(unsafe { metadata.assume_init() }))
}

fn file_metadata(file: &File) -> Result<RawMetadata, PluginPackageMaterializationError> {
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), metadata.as_mut_ptr()) } == -1 {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(raw_metadata(unsafe { metadata.assume_init() }))
}

fn raw_metadata(metadata: libc::stat) -> RawMetadata {
    RawMetadata {
        device: metadata.st_dev as u64,
        inode: metadata.st_ino,
        owner: metadata.st_uid,
        mode: metadata.st_mode as u32,
        link_count: metadata.st_nlink as u64,
        size: metadata.st_size as u64,
    }
}

fn validate_directory_metadata(
    directory: &File,
    expected_mode: u32,
) -> Result<(), PluginPackageMaterializationError> {
    let metadata = file_metadata(directory)?;
    if metadata.mode & libc::S_IFMT as u32 != libc::S_IFDIR as u32 {
        return Err(PluginPackageMaterializationError::RootIsNotDirectory);
    }
    if metadata.owner != effective_uid() || metadata.mode & 0o7777 != expected_mode {
        return Err(PluginPackageMaterializationError::RootIsNotOwnerOnly);
    }
    Ok(())
}

fn validate_regular_file_metadata(
    file: &File,
    expected_mode: u32,
    expected_size: u64,
) -> Result<(), PluginPackageMaterializationError> {
    let metadata = file_metadata(file)?;
    if metadata.mode & libc::S_IFMT as u32 != libc::S_IFREG as u32
        || metadata.owner != effective_uid()
        || metadata.mode & 0o7777 != expected_mode
        || metadata.link_count != 1
        || metadata.size != expected_size
    {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(())
}

fn validate_identity(
    file: &File,
    expected: &RawMetadata,
) -> Result<(), PluginPackageMaterializationError> {
    let actual = file_metadata(file)?;
    if actual.device != expected.device || actual.inode != expected.inode {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(())
}

fn set_file_mode(file: &File, mode: u32) -> Result<(), PluginPackageMaterializationError> {
    if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } == -1 {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    Ok(())
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn directory_names(directory: &File) -> Result<Vec<OsString>, PluginPackageMaterializationError> {
    let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate == -1 {
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        unsafe {
            libc::close(duplicate);
        }
        return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
    }
    let stream = DirectoryStream(stream);
    unsafe {
        libc::rewinddir(stream.0);
    }
    let mut names = Vec::new();
    loop {
        set_errno(0);
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if current_errno() != 0 {
                return Err(PluginPackageMaterializationError::MaterializedPackageInvalid);
            }
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        names.push(OsString::from_vec(bytes.to_vec()));
    }
    names.sort();
    Ok(names)
}

#[cfg(target_os = "macos")]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

#[cfg(target_os = "linux")]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn errno_location() -> *mut libc::c_int {
    std::ptr::null_mut()
}

fn set_errno(value: libc::c_int) {
    let location = errno_location();
    if !location.is_null() {
        unsafe {
            *location = value;
        }
    }
}

fn current_errno() -> libc::c_int {
    let location = errno_location();
    if location.is_null() {
        0
    } else {
        unsafe { *location }
    }
}

fn cstring(value: &OsStr) -> std::io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))
}

fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn io_error(operation: &'static str, path: &Path) -> PluginPackageMaterializationError {
    PluginPackageMaterializationError::Io {
        operation,
        path: path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt, PermissionsExt},
        sync::Arc,
    };

    use super::*;
    use crate::plugin_catalog::bundled_plugin_registry;

    fn owner_only_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("create materialization test root");
        fs::set_permissions(
            root.path(),
            fs::Permissions::from_mode(CONTROL_DIRECTORY_MODE),
        )
        .expect("protect materialization test root");
        root
    }

    fn exact_root(root: &tempfile::TempDir) -> PathBuf {
        fs::canonicalize(root.path()).expect("canonical materialization test root")
    }

    fn bundled_package() -> &'static RegisteredPluginPackageV2 {
        bundled_plugin_registry()
            .package(&PluginIdV2::new("dure.beads").unwrap())
            .expect("bundled package")
    }

    #[test]
    fn materializes_exact_sealed_embedded_bytes_with_a_held_root_identity() {
        let root = owner_only_root();
        let root_path = exact_root(&root);
        let materialized =
            materialize_registered_plugin_package(&root_path, bundled_package()).unwrap();
        let authority = bundled_package().embedded_authority().unwrap();

        assert_eq!(materialized.receipt().schema_version(), 1);
        assert_eq!(materialized.receipt().plugin_id().as_str(), "dure.beads");
        assert_eq!(materialized.receipt().plugin_version().as_str(), "0.2.1");
        assert_eq!(
            materialized.receipt().embedded_authority_sha256(),
            authority.sha256()
        );
        assert_eq!(
            materialized.receipt().file_manifest_sha256(),
            authority.file_manifest_sha256()
        );
        let lease_metadata = materialized.package_root_lease().metadata().unwrap();
        assert_eq!(
            materialized.receipt().root_identity(),
            (lease_metadata.dev(), lease_metadata.ino())
        );
        assert_eq!(lease_metadata.mode() & 0o7777, SEALED_DIRECTORY_MODE);
        for (path, expected) in authority.package_files() {
            let relative = path.as_str().strip_prefix("./").unwrap();
            let file = materialized.package_root().join(relative);
            assert_eq!(fs::read(&file).unwrap(), expected);
            assert_eq!(
                fs::metadata(file).unwrap().mode() & 0o7777,
                SEALED_FILE_MODE
            );
        }
        materialized.revalidate(bundled_package()).unwrap();

        let reused =
            open_existing_registered_plugin_package(&root_path, bundled_package()).unwrap();
        assert_eq!(reused.package_root(), materialized.package_root());
        assert_eq!(
            reused.receipt().root_identity(),
            materialized.receipt().root_identity()
        );
    }

    #[test]
    fn existing_modified_or_extra_content_is_rejected_without_repair() {
        let root = owner_only_root();
        let root_path = exact_root(&root);
        let materialized =
            materialize_registered_plugin_package(&root_path, bundled_package()).unwrap();
        let manifest = materialized.package_root().join("dure-plugin.json");
        fs::set_permissions(&manifest, fs::Permissions::from_mode(STAGING_FILE_MODE)).unwrap();
        fs::write(&manifest, b"tampered").unwrap();
        assert_eq!(
            open_existing_registered_plugin_package(&root_path, bundled_package()).unwrap_err(),
            PluginPackageMaterializationError::MaterializedPackageInvalid
        );
        assert_eq!(fs::read(&manifest).unwrap(), b"tampered");
    }

    #[test]
    fn existing_missing_content_is_rejected_without_recreation() {
        let root = owner_only_root();
        let root_path = exact_root(&root);
        let materialized =
            materialize_registered_plugin_package(&root_path, bundled_package()).unwrap();
        let manifest = materialized.package_root().join("dure-plugin.json");
        let package_root = materialized.package_root();
        fs::set_permissions(
            package_root,
            fs::Permissions::from_mode(CONTROL_DIRECTORY_MODE),
        )
        .unwrap();
        fs::remove_file(&manifest).unwrap();
        fs::set_permissions(
            package_root,
            fs::Permissions::from_mode(SEALED_DIRECTORY_MODE),
        )
        .unwrap();

        assert_eq!(
            open_existing_registered_plugin_package(&root_path, bundled_package()).unwrap_err(),
            PluginPackageMaterializationError::MaterializedPackageInvalid
        );
        assert!(!manifest.exists());
    }

    #[test]
    fn existing_symlink_entry_is_rejected_without_following_it() {
        let root = owner_only_root();
        let root_path = exact_root(&root);
        let materialized =
            materialize_registered_plugin_package(&root_path, bundled_package()).unwrap();
        let outside = root_path.join("outside");
        fs::write(&outside, b"outside").unwrap();
        let injected = materialized.package_root().join("unexpected-link");
        fs::set_permissions(
            materialized.package_root(),
            fs::Permissions::from_mode(CONTROL_DIRECTORY_MODE),
        )
        .unwrap();
        symlink(&outside, &injected).unwrap();
        fs::set_permissions(
            materialized.package_root(),
            fs::Permissions::from_mode(SEALED_DIRECTORY_MODE),
        )
        .unwrap();

        assert_eq!(
            open_existing_registered_plugin_package(&root_path, bundled_package()).unwrap_err(),
            PluginPackageMaterializationError::MaterializedPackageInvalid
        );
        assert_eq!(fs::read(outside).unwrap(), b"outside");
    }

    #[test]
    fn no_replace_publish_preserves_both_names_on_conflict() {
        let root = owner_only_root();
        let root_path = exact_root(&root);
        let app_data = AnchoredDirectory::open_absolute(&root_path).unwrap();
        let control = app_data
            .create_child(
                OsStr::new(MATERIALIZATION_DIRECTORY),
                CONTROL_DIRECTORY_MODE,
            )
            .unwrap();
        let staging = control
            .create_child(OsStr::new(".materialize-test"), CONTROL_DIRECTORY_MODE)
            .unwrap();
        let final_directory = control
            .create_child(OsStr::new("final"), CONTROL_DIRECTORY_MODE)
            .unwrap();
        let staging_identity = file_metadata(&staging.file).unwrap();
        let final_identity = file_metadata(&final_directory.file).unwrap();

        assert!(publish_noreplace(
            control.file.as_raw_fd(),
            OsStr::new(".materialize-test"),
            OsStr::new("final"),
        )
        .is_err());
        let retained_staging = control
            .open_child(OsStr::new(".materialize-test"), CONTROL_DIRECTORY_MODE)
            .unwrap();
        let retained_final = control
            .open_child(OsStr::new("final"), CONTROL_DIRECTORY_MODE)
            .unwrap();
        assert_eq!(
            file_metadata(&retained_staging.file).unwrap().inode,
            staging_identity.inode
        );
        assert_eq!(
            file_metadata(&retained_final.file).unwrap().inode,
            final_identity.inode
        );
    }

    #[test]
    fn concurrent_publishers_reuse_one_exact_generation() {
        let root = Arc::new(owner_only_root());
        let root_path = Arc::new(exact_root(&root));
        let outcomes = std::thread::scope(|scope| {
            (0..8)
                .map(|_| {
                    let root_path = Arc::clone(&root_path);
                    scope.spawn(move || {
                        materialize_registered_plugin_package(&root_path, bundled_package()).map(
                            |package| {
                                (
                                    package.package_root().to_path_buf(),
                                    package.receipt().root_identity(),
                                )
                            },
                        )
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|thread| thread.join().unwrap().unwrap())
                .collect::<Vec<_>>()
        });

        assert!(outcomes.iter().all(|outcome| outcome == &outcomes[0]));
        let control_root = root_path.join(MATERIALIZATION_DIRECTORY);
        let names = fs::read_dir(control_root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<BTreeSet<_>>();
        assert_eq!(names.len(), 2);
        assert!(names.contains(OsStr::new(MATERIALIZATION_LOCK_FILE)));
        assert!(names.iter().any(|name| name != MATERIALIZATION_LOCK_FILE));
    }
}
