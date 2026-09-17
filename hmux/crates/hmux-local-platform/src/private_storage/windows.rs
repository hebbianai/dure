use super::{PrivateFileIdentity, PrivateFileMetadata, SecurityViolation, StorageError};
use crate::windows_security::{
    OwnedHandle, OwnedSid, PrivateSecurityDescriptor, current_process_sid,
};
use std::ffi::c_void;
use std::fs::{self, File};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    ERROR_ALREADY_EXISTS, ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid,
    GetAce, GetSecurityDescriptorControl, INHERITED_ACE, OWNER_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, SECURITY_MAX_SID_SIZE, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ALL_ACCESS,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileBasicInfo, FlushFileBuffers,
    GetFileInformationByHandle, GetFileInformationByHandleEx, OPEN_EXISTING, READ_CONTROL,
};
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;

const SHARING: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

#[derive(Clone, Copy, Debug)]
pub struct WindowsFileFacts {
    pub volume_serial: u64,
    pub file_index: u64,
    pub creation_time: u64,
    pub last_write_time: u64,
    pub change_time: i64,
    pub attributes: u32,
    pub size: u64,
}

pub fn create_directory(path: &Path) -> Result<(), StorageError> {
    if super::path_entry_exists(path)? {
        return validate_directory(path);
    }
    let encoded = wide_path(path)?;
    let descriptor = PrivateSecurityDescriptor::new().map_err(|error| {
        StorageError::io(
            "create private Windows security descriptor",
            path,
            error.into_io(),
        )
    })?;
    let attributes = descriptor.attributes();
    // SAFETY: both UTF-16 path and security descriptor stay live for the call.
    if unsafe { CreateDirectoryW(encoded.as_ptr(), &raw const attributes) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error()
            != Some(i32::try_from(ERROR_ALREADY_EXISTS).expect("Win32 error fits i32"))
        {
            return Err(StorageError::io("create private directory", path, error));
        }
    }
    validate_directory(path)
}

pub fn validate_directory(path: &Path) -> Result<(), StorageError> {
    let handle = open_path_handle(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        "open private directory",
    )?;
    validate_handle(path, handle.raw(), ExpectedKind::Directory).map(|_| ())
}

pub fn directory_identity(path: &Path) -> Result<(u64, u64), StorageError> {
    let handle = open_path_handle(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        "open private directory identity",
    )?;
    let information = validate_handle(path, handle.raw(), ExpectedKind::Directory)?;
    Ok((
        u64::from(information.dwVolumeSerialNumber),
        file_index(&information),
    ))
}

pub fn file_facts(path: &Path) -> Result<WindowsFileFacts, StorageError> {
    let handle = open_path_handle(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_OPEN_REPARSE_POINT,
        "open private file identity",
    )?;
    let information = validate_handle(path, handle.raw(), ExpectedKind::File)?;
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: handle is a validated live file handle and basic is writable for
    // exactly the FILE_BASIC_INFO size supplied to Windows.
    if unsafe {
        GetFileInformationByHandleEx(
            handle.raw(),
            FileBasicInfo,
            (&raw mut basic).cast::<c_void>(),
            u32::try_from(size_of::<FILE_BASIC_INFO>()).expect("FILE_BASIC_INFO size fits u32"),
        )
    } == 0
    {
        return Err(StorageError::io(
            "read private file generation",
            path,
            io::Error::last_os_error(),
        ));
    }
    Ok(WindowsFileFacts {
        volume_serial: u64::from(information.dwVolumeSerialNumber),
        file_index: file_index(&information),
        creation_time: file_time(information.ftCreationTime),
        last_write_time: file_time(information.ftLastWriteTime),
        change_time: basic.ChangeTime,
        attributes: information.dwFileAttributes,
        size: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
    })
}

pub fn private_file_identity(path: &Path) -> Result<(u64, u64), StorageError> {
    let facts = file_facts(path)?;
    Ok((facts.volume_serial, facts.file_index))
}

pub fn private_file_metadata(path: &Path) -> Result<PrivateFileMetadata, StorageError> {
    let handle = open_path_handle(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_OPEN_REPARSE_POINT,
        "open private file metadata",
    )?;
    let information = validate_handle(path, handle.raw(), ExpectedKind::File)?;
    // SAFETY: ownership of this validated handle moves to File, so metadata
    // comes from the same file even if its path is replaced in the meantime.
    let file = unsafe { File::from_raw_handle(handle.into_raw()) };
    let metadata = file
        .metadata()
        .map_err(|error| StorageError::io("inspect private file metadata", path, error))?;
    Ok(PrivateFileMetadata {
        identity: PrivateFileIdentity {
            volume: u64::from(information.dwVolumeSerialNumber),
            object: file_index(&information),
        },
        metadata,
    })
}

pub fn open_private_file_identity(path: &Path, file: &File) -> Result<(u64, u64), StorageError> {
    let information = validate_handle(path, file.as_raw_handle(), ExpectedKind::File)?;
    let identity = (
        u64::from(information.dwVolumeSerialNumber),
        file_index(&information),
    );
    if private_file_identity(path)? != identity {
        return Err(StorageError::security(
            path,
            SecurityViolation::ReplacedDuringOpen,
        ));
    }
    Ok(identity)
}

pub fn open_new_file(path: &Path) -> Result<File, StorageError> {
    let encoded = wide_path(path)?;
    let descriptor = PrivateSecurityDescriptor::new().map_err(|error| {
        StorageError::io(
            "create private Windows security descriptor",
            path,
            error.into_io(),
        )
    })?;
    let attributes = descriptor.attributes();
    // SAFETY: path and security descriptor remain live, and no template handle
    // is supplied. CREATE_NEW prevents an existing reparse point from winning.
    let raw = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
            SHARING,
            &raw const attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    let handle = OwnedHandle::from_file(raw)
        .ok_or_else(|| StorageError::io("create private file", path, io::Error::last_os_error()))?;
    validate_handle(path, handle.raw(), ExpectedKind::File)?;
    // SAFETY: ownership of this valid file handle moves from OwnedHandle to File.
    Ok(unsafe { File::from_raw_handle(handle.into_raw()) })
}

pub fn open_lock_file(path: &Path) -> Result<File, StorageError> {
    if !super::path_entry_exists(path)? {
        match open_new_file(path) {
            Ok(file) => return Ok(file),
            Err(error) if is_already_exists(&error) => {}
            Err(error) => return Err(error),
        }
    }
    open_private_file(
        path,
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
        "open lifetime lock",
    )
}

pub fn open_existing_file(path: &Path) -> Result<File, StorageError> {
    open_private_file(path, GENERIC_READ | READ_CONTROL, "open private file")
}

pub fn open_existing_lock_file(path: &Path) -> Result<File, StorageError> {
    open_private_file(
        path,
        GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
        "open private lock",
    )
}

pub fn replace_file(source: &Path, target: &Path) -> Result<(), StorageError> {
    let source_handle = open_path_handle(
        source,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_OPEN_REPARSE_POINT,
        "inspect replacement source",
    )?;
    validate_handle(source, source_handle.raw(), ExpectedKind::File)?;
    if super::path_entry_exists(target)? {
        let target_handle = open_path_handle(
            target,
            FILE_READ_ATTRIBUTES | READ_CONTROL,
            FILE_FLAG_OPEN_REPARSE_POINT,
            "inspect replacement target",
        )?;
        validate_handle(target, target_handle.raw(), ExpectedKind::File)?;
    }
    drop(source_handle);

    // Publish the prepared private file by rename, not ReplaceFileW's
    // multi-step metadata merge, which exposes missing-path and sharing
    // windows to readers. Rust owns the Windows rename compatibility path;
    // callers own file sync before publication and directory sync afterward.
    fs::rename(source, target)
        .map_err(|error| StorageError::io("atomically replace manifest", target, error))?;
    let target_handle = open_path_handle(
        target,
        FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_OPEN_REPARSE_POINT,
        "inspect replaced manifest",
    )?;
    validate_handle(target, target_handle.raw(), ExpectedKind::File).map(|_| ())
}

pub fn sync_directory(path: &Path) -> Result<(), StorageError> {
    let handle = open_path_handle(
        path,
        GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        "open discovery directory for sync",
    )?;
    validate_handle(path, handle.raw(), ExpectedKind::Directory)?;
    // SAFETY: handle is a live directory handle opened with backup semantics.
    if unsafe { FlushFileBuffers(handle.raw()) } == 0 {
        return Err(StorageError::io(
            "sync discovery directory",
            path,
            io::Error::last_os_error(),
        ));
    }
    Ok(())
}

fn open_private_file(
    path: &Path,
    access: u32,
    operation: &'static str,
) -> Result<File, StorageError> {
    let handle = open_path_handle(path, access, FILE_FLAG_OPEN_REPARSE_POINT, operation)?;
    validate_handle(path, handle.raw(), ExpectedKind::File)?;
    // SAFETY: ownership of this valid file handle moves from OwnedHandle to File.
    Ok(unsafe { File::from_raw_handle(handle.into_raw()) })
}

fn open_path_handle(
    path: &Path,
    access: u32,
    flags: u32,
    operation: &'static str,
) -> Result<OwnedHandle, StorageError> {
    let encoded = wide_path(path)?;
    // SAFETY: the UTF-16 path remains live and no security/template pointers
    // are supplied. OPEN_REPARSE_POINT ensures validation examines the entry.
    let raw = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            access,
            SHARING,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    OwnedHandle::from_file(raw)
        .ok_or_else(|| StorageError::io(operation, path, io::Error::last_os_error()))
}

fn validate_handle(
    path: &Path,
    handle: *mut c_void,
    expected_kind: ExpectedKind,
) -> Result<BY_HANDLE_FILE_INFORMATION, StorageError> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: information is writable and handle is live for this call.
    if unsafe { GetFileInformationByHandle(handle, &raw mut information) } == 0 {
        return Err(StorageError::io(
            "inspect private path handle",
            path,
            io::Error::last_os_error(),
        ));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsReparsePoint,
        ));
    }
    let is_directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    match expected_kind {
        ExpectedKind::Directory if !is_directory => {
            return Err(StorageError::security(
                path,
                SecurityViolation::ExpectedDirectory,
            ));
        }
        ExpectedKind::File if is_directory => {
            return Err(StorageError::security(
                path,
                SecurityViolation::ExpectedRegularFile,
            ));
        }
        _ => {}
    }
    validate_security(path, handle)?;
    Ok(information)
}

fn file_index(information: &BY_HANDLE_FILE_INFORMATION) -> u64 {
    (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow)
}

fn file_time(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

fn validate_security(path: &Path, handle: *mut c_void) -> Result<(), StorageError> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: output pointers are writable and descriptor is freed below.
    let result = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &raw mut owner,
            null_mut(),
            &raw mut dacl,
            null_mut(),
            &raw mut descriptor,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(StorageError::io(
            "read private path security",
            path,
            io::Error::from_raw_os_error(i32::try_from(result).unwrap_or(i32::MAX)),
        ));
    }
    let descriptor = LocalSecurityDescriptor(descriptor);
    let current = current_process_sid()
        .map_err(|error| StorageError::io("read current Windows SID", path, error.into_io()))?;
    // SAFETY: owner and current are valid SIDs owned by live descriptors.
    if owner.is_null() || unsafe { EqualSid(owner, current.as_ptr()) } == 0 {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsOwnerMismatch,
        ));
    }
    if dacl.is_null() {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsDaclMissing,
        ));
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor is a successful GetSecurityInfo result and both
    // output values are writable.
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &raw mut control, &raw mut revision) }
        == 0
    {
        return Err(StorageError::io(
            "inspect private path DACL control",
            path,
            io::Error::last_os_error(),
        ));
    }
    if control & SE_DACL_PROTECTED == 0 {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsDaclUnprotected,
        ));
    }
    validate_dacl(path, dacl, &current)
}

fn validate_dacl(path: &Path, dacl: *mut ACL, current: &OwnedSid) -> Result<(), StorageError> {
    let system = local_system_sid(path)?;
    // SAFETY: dacl is non-null and belongs to the live security descriptor.
    let ace_count = unsafe { (*dacl).AceCount };
    let mut owner_rights = false;
    let mut system_rights = false;
    for index in 0..u32::from(ace_count) {
        let mut raw_ace = null_mut();
        // SAFETY: index is bounded by AceCount and raw_ace is writable.
        if unsafe { GetAce(dacl, index, &raw mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(StorageError::io(
                "enumerate private path DACL",
                path,
                io::Error::last_os_error(),
            ));
        }
        // SAFETY: GetAce returned a non-null ACE pointer within the ACL.
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || header.AceFlags & u8::try_from(INHERITED_ACE).expect("ACE flag fits u8") != 0
            || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(StorageError::security(
                path,
                SecurityViolation::WindowsDaclUnexpectedAce,
            ));
        }
        // SAFETY: the header proved this is a complete ACCESS_ALLOWED_ACE.
        let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Mask & FILE_ALL_ACCESS != FILE_ALL_ACCESS {
            return Err(StorageError::security(
                path,
                SecurityViolation::WindowsDaclUnexpectedAce,
            ));
        }
        let sid = std::ptr::from_ref(&ace.SidStart)
            .cast_mut()
            .cast::<c_void>();
        // SAFETY: SidStart is the variable-length SID tail of this complete ACE.
        if unsafe { EqualSid(sid, current.as_ptr()) } != 0 {
            if owner_rights {
                return Err(StorageError::security(
                    path,
                    SecurityViolation::WindowsDaclUnexpectedAce,
                ));
            }
            owner_rights = true;
        } else if unsafe { EqualSid(sid, system.as_ptr()) } != 0 {
            if system_rights {
                return Err(StorageError::security(
                    path,
                    SecurityViolation::WindowsDaclUnexpectedAce,
                ));
            }
            system_rights = true;
        } else {
            return Err(StorageError::security(
                path,
                SecurityViolation::WindowsDaclUnexpectedAce,
            ));
        }
    }
    if !owner_rights {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsDaclMissingOwnerRights,
        ));
    }
    if !system_rights {
        return Err(StorageError::security(
            path,
            SecurityViolation::WindowsDaclMissingSystemRights,
        ));
    }
    Ok(())
}

fn local_system_sid(path: &Path) -> Result<OwnedSid, StorageError> {
    let bytes = usize::try_from(SECURITY_MAX_SID_SIZE).expect("SID size fits usize");
    let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
    let mut length = SECURITY_MAX_SID_SIZE;
    // SAFETY: storage is aligned and has SECURITY_MAX_SID_SIZE writable bytes.
    if unsafe {
        CreateWellKnownSid(
            WinLocalSystemSid,
            null_mut(),
            storage.as_mut_ptr().cast::<c_void>(),
            &raw mut length,
        )
    } == 0
    {
        return Err(StorageError::io(
            "create LocalSystem SID",
            path,
            io::Error::last_os_error(),
        ));
    }
    crate::windows_security::copy_sid(
        storage.as_mut_ptr().cast::<c_void>(),
        "CreateWellKnownSid(LocalSystem)",
    )
    .map_err(|error| StorageError::io("copy LocalSystem SID", path, error.into_io()))
}

fn wide_path(path: &Path) -> Result<Vec<u16>, StorageError> {
    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(StorageError::io(
            "encode Windows path",
            path,
            io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL code unit"),
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

fn is_already_exists(error: &StorageError) -> bool {
    matches!(
        error,
        StorageError::Io { source, .. }
            if source.raw_os_error()
                == Some(i32::try_from(ERROR_ALREADY_EXISTS).expect("Win32 error fits i32"))
                || source.kind() == io::ErrorKind::AlreadyExists
    )
}

struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

#[derive(Clone, Copy)]
enum ExpectedKind {
    Directory,
    File,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::windows::fs::symlink_dir;

    #[test]
    fn creates_and_reopens_private_discovery_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("discovery");

        create_directory(&path).unwrap();
        validate_directory(&path).unwrap();
    }

    #[test]
    fn inherited_directory_acl_is_not_accepted_as_private() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("inherited");
        fs::create_dir(&path).unwrap();

        assert!(matches!(
            validate_directory(&path),
            Err(StorageError::Security { .. })
        ));
    }

    #[test]
    fn directory_reparse_point_is_not_accepted_as_private() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("target");
        let link = temporary.path().join("link");
        create_directory(&target).unwrap();
        symlink_dir(&target, &link).unwrap();

        assert!(matches!(
            validate_directory(&link),
            Err(StorageError::Security {
                violation: SecurityViolation::WindowsReparsePoint,
                ..
            })
        ));
    }

    #[test]
    fn atomically_replaces_an_existing_private_file() {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("discovery");
        create_directory(&directory).unwrap();
        let target = directory.join("manifest.json");
        let source = directory.join(".manifest.tmp");

        let mut original = open_new_file(&target).unwrap();
        original.write_all(b"starting").unwrap();
        original.sync_all().unwrap();
        drop(original);
        let mut previous = open_existing_file(&target).unwrap();
        let previous_identity = private_file_identity(&target).unwrap();
        let mut replacement = open_new_file(&source).unwrap();
        replacement.write_all(b"ready").unwrap();
        replacement.sync_all().unwrap();
        drop(replacement);
        let replacement_identity = private_file_identity(&source).unwrap();

        replace_file(&source, &target).unwrap();

        assert!(!source.exists());
        let mut current = open_existing_file(&target).unwrap();
        let mut contents = Vec::new();
        current.read_to_end(&mut contents).unwrap();
        assert_eq!(contents, b"ready");
        contents.clear();
        previous.read_to_end(&mut contents).unwrap();
        assert_eq!(contents, b"starting");
        assert_eq!(
            private_file_identity(&target).unwrap(),
            replacement_identity
        );
        assert_ne!(previous_identity, replacement_identity);
    }
}
