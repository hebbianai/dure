use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    CopySid, GetLengthSid, GetTokenInformation, IsValidSid, PSECURITY_DESCRIPTOR, PSID,
    SECURITY_ATTRIBUTES, TOKEN_ELEVATION_TYPE, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER,
    TokenElevationType, TokenElevationTypeDefault, TokenElevationTypeFull,
    TokenElevationTypeLimited, TokenIntegrityLevel, TokenUser,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

#[derive(Debug)]
pub(crate) enum WindowsSecurityError {
    Os {
        operation: &'static str,
        source: io::Error,
    },
    InvalidKernelResponse {
        operation: &'static str,
    },
}

impl WindowsSecurityError {
    pub(crate) fn into_io(self) -> io::Error {
        match self {
            Self::Os { source, .. } => source,
            Self::InvalidKernelResponse { operation } => io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{operation} returned an invalid Windows security record"),
            ),
        }
    }
}

pub(crate) struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn from_nullable(raw: HANDLE) -> Option<Self> {
        (!raw.is_null()).then_some(Self(raw))
    }

    pub(crate) fn from_file(raw: HANDLE) -> Option<Self> {
        (raw != INVALID_HANDLE_VALUE).then_some(Self(raw))
    }

    pub(crate) fn raw(&self) -> HANDLE {
        self.0
    }

    pub(crate) fn into_raw(self) -> HANDLE {
        let raw = self.0;
        std::mem::forget(self);
        raw
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is non-null, owned by this value, and closed once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(crate) struct OwnedSid {
    storage: Vec<usize>,
}

pub(crate) struct WindowsTokenFacts {
    user_sid: OwnedSid,
    elevation_type: TOKEN_ELEVATION_TYPE,
    integrity_sid: OwnedSid,
}

impl WindowsTokenFacts {
    pub(crate) fn user_sid(&self) -> &OwnedSid {
        &self.user_sid
    }

    pub(crate) fn elevation_type(&self) -> TOKEN_ELEVATION_TYPE {
        self.elevation_type
    }

    pub(crate) fn integrity_sid(&self) -> &OwnedSid {
        &self.integrity_sid
    }
}

/// Owner/System-only protected DACL shared by discovery files and named pipes.
///
/// Keeping the SDDL in one place is security-relevant: a carrier and the
/// manifest that names it must expose the same user boundary, rather than two
/// nearly identical ACL builders drifting independently.
pub(crate) struct PrivateSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl PrivateSecurityDescriptor {
    pub(crate) fn new() -> Result<Self, WindowsSecurityError> {
        let sid = current_process_sid()?.to_string()?;
        let sddl = format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FA;;;SY)");
        let mut encoded = sddl.encode_utf16().collect::<Vec<_>>();
        encoded.push(0);
        let mut descriptor = null_mut();
        // SAFETY: encoded is NUL-terminated and descriptor is writable. The
        // returned descriptor is LocalAlloc-owned and released by Drop.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                encoded.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(os_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(Self(descriptor))
    }

    pub(crate) fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>())
                .expect("SECURITY_ATTRIBUTES size fits u32"),
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for PrivateSecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: SDDL conversion allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(self.0);
        }
    }
}

impl OwnedSid {
    pub(crate) fn as_ptr(&self) -> PSID {
        self.storage.as_ptr().cast_mut().cast::<c_void>()
    }

    pub(crate) fn to_string(&self) -> Result<String, WindowsSecurityError> {
        let mut encoded = null_mut();
        // SAFETY: `self` owns a valid SID for the duration of the call and the
        // API initializes one LocalAlloc-owned, NUL-terminated UTF-16 string.
        if unsafe { ConvertSidToStringSidW(self.as_ptr(), &raw mut encoded) } == 0 {
            return Err(os_error("ConvertSidToStringSidW"));
        }
        let encoded = LocalWideString(encoded);
        let mut length = 0_usize;
        while length <= 256 {
            // SAFETY: the API returned a NUL-terminated SID string. The bound
            // prevents an invalid kernel response from causing an unbounded scan.
            if unsafe { *encoded.0.add(length) } == 0 {
                break;
            }
            length += 1;
        }
        if length > 256 {
            return Err(WindowsSecurityError::InvalidKernelResponse {
                operation: "ConvertSidToStringSidW",
            });
        }
        // SAFETY: the preceding bounded scan proved these UTF-16 code units
        // precede the terminator in the LocalAlloc-owned buffer.
        let units = unsafe { std::slice::from_raw_parts(encoded.0, length) };
        String::from_utf16(units).map_err(|_| WindowsSecurityError::InvalidKernelResponse {
            operation: "ConvertSidToStringSidW",
        })
    }
}

struct LocalWideString(*mut u16);

impl Drop for LocalWideString {
    fn drop(&mut self) {
        // SAFETY: ConvertSidToStringSidW allocated this buffer with LocalAlloc.
        unsafe {
            LocalFree(self.0.cast::<c_void>());
        }
    }
}

pub(crate) fn current_process_sid() -> Result<OwnedSid, WindowsSecurityError> {
    let token = current_process_token()?;
    token_user_sid(token.raw())
}

pub(crate) fn current_process_token_facts() -> Result<WindowsTokenFacts, WindowsSecurityError> {
    token_facts(current_process_token()?.raw())
}

pub(crate) fn current_thread_token_facts() -> Result<WindowsTokenFacts, WindowsSecurityError> {
    token_facts(current_thread_token()?.raw())
}

pub(crate) fn process_token_facts(
    process_id: u32,
) -> Result<WindowsTokenFacts, WindowsSecurityError> {
    // SAFETY: process_id is supplied by the kernel for the connected pipe and
    // the returned process handle, when non-null, is owned by this function.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    let process =
        OwnedHandle::from_nullable(process).ok_or_else(|| os_error("OpenProcess(pipe server)"))?;
    let mut token = null_mut();
    // SAFETY: process is a live query handle and token is writable storage.
    if unsafe { OpenProcessToken(process.raw(), TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(os_error("OpenProcessToken(pipe server)"));
    }
    let token =
        OwnedHandle::from_nullable(token).ok_or(WindowsSecurityError::InvalidKernelResponse {
            operation: "OpenProcessToken(pipe server)",
        })?;
    token_facts(token.raw())
}

fn current_process_token() -> Result<OwnedHandle, WindowsSecurityError> {
    let mut token = null_mut();
    // SAFETY: the pseudo process handle is always valid in the current process
    // and token points to writable HANDLE storage.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
        return Err(os_error("OpenProcessToken"));
    }
    OwnedHandle::from_nullable(token).ok_or(WindowsSecurityError::InvalidKernelResponse {
        operation: "OpenProcessToken",
    })
}

fn current_thread_token() -> Result<OwnedHandle, WindowsSecurityError> {
    let mut token = null_mut();
    // SAFETY: the pseudo thread handle is valid and token points to writable
    // HANDLE storage. open_as_self keeps the query permission check explicit.
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &raw mut token) } == 0 {
        return Err(os_error("OpenThreadToken"));
    }
    OwnedHandle::from_nullable(token).ok_or(WindowsSecurityError::InvalidKernelResponse {
        operation: "OpenThreadToken",
    })
}

fn token_facts(token: HANDLE) -> Result<WindowsTokenFacts, WindowsSecurityError> {
    Ok(WindowsTokenFacts {
        user_sid: token_user_sid(token)?,
        elevation_type: token_elevation_type(token)?,
        integrity_sid: token_integrity_sid(token)?,
    })
}

fn token_elevation_type(token: HANDLE) -> Result<TOKEN_ELEVATION_TYPE, WindowsSecurityError> {
    let mut elevation = 0_i32;
    let mut returned = 0_u32;
    let expected = u32::try_from(size_of::<TOKEN_ELEVATION_TYPE>())
        .expect("TOKEN_ELEVATION_TYPE size fits u32");
    // SAFETY: elevation is writable for exactly expected bytes and token is a
    // live query-capable token handle.
    if unsafe {
        GetTokenInformation(
            token,
            TokenElevationType,
            (&raw mut elevation).cast::<c_void>(),
            expected,
            &raw mut returned,
        )
    } == 0
    {
        return Err(os_error("GetTokenInformation(TokenElevationType)"));
    }
    if returned != expected
        || ![
            TokenElevationTypeDefault,
            TokenElevationTypeFull,
            TokenElevationTypeLimited,
        ]
        .contains(&elevation)
    {
        return Err(WindowsSecurityError::InvalidKernelResponse {
            operation: "GetTokenInformation(TokenElevationType)",
        });
    }
    Ok(elevation)
}

fn token_integrity_sid(token: HANDLE) -> Result<OwnedSid, WindowsSecurityError> {
    let storage = token_information_buffer(
        token,
        TokenIntegrityLevel,
        size_of::<TOKEN_MANDATORY_LABEL>(),
        "GetTokenInformation(TokenIntegrityLevel)",
    )?;
    // SAFETY: token_information_buffer proved the initialized buffer is large
    // enough and aligned for TOKEN_MANDATORY_LABEL.
    let label = unsafe { &*storage.as_ptr().cast::<TOKEN_MANDATORY_LABEL>() };
    copy_sid(label.Label.Sid, "GetTokenInformation(TokenIntegrityLevel)")
}

fn token_information_buffer(
    token: HANDLE,
    information_class: i32,
    minimum: usize,
    operation: &'static str,
) -> Result<Vec<usize>, WindowsSecurityError> {
    let mut required = 0_u32;
    // SAFETY: the first call intentionally supplies no buffer so Windows
    // reports the exact byte requirement.
    let first =
        unsafe { GetTokenInformation(token, information_class, null_mut(), 0, &raw mut required) };
    if first != 0
        || usize::try_from(required).unwrap_or(0) < minimum
        || io::Error::last_os_error().raw_os_error()
            != Some(i32::try_from(ERROR_INSUFFICIENT_BUFFER).expect("Win32 error fits i32"))
    {
        return Err(if required == 0 {
            os_error(operation)
        } else {
            WindowsSecurityError::InvalidKernelResponse { operation }
        });
    }
    let words = usize::try_from(required)
        .expect("Windows token buffer length fits usize")
        .div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut returned = required;
    // SAFETY: storage is aligned and large enough for the reported byte count.
    if unsafe {
        GetTokenInformation(
            token,
            information_class,
            storage.as_mut_ptr().cast::<c_void>(),
            required,
            &raw mut returned,
        )
    } == 0
    {
        return Err(os_error(operation));
    }
    if returned > required || usize::try_from(returned).unwrap_or(0) < minimum {
        return Err(WindowsSecurityError::InvalidKernelResponse { operation });
    }
    Ok(storage)
}

fn token_user_sid(token: HANDLE) -> Result<OwnedSid, WindowsSecurityError> {
    let mut required = 0_u32;
    // SAFETY: the first call intentionally supplies no buffer so Windows
    // reports the exact TokenUser byte requirement.
    let first = unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &raw mut required) };
    if first != 0
        || required < u32::try_from(size_of::<TOKEN_USER>()).expect("TOKEN_USER size fits u32")
        || io::Error::last_os_error().raw_os_error()
            != Some(i32::try_from(ERROR_INSUFFICIENT_BUFFER).expect("Win32 error fits i32"))
    {
        return Err(if required == 0 {
            os_error("GetTokenInformation(TokenUser) size")
        } else {
            WindowsSecurityError::InvalidKernelResponse {
                operation: "GetTokenInformation(TokenUser) size",
            }
        });
    }

    let words = usize::try_from(required)
        .expect("Windows token buffer length fits usize")
        .div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut returned = required;
    // SAFETY: `storage` is aligned and large enough for the byte count Windows
    // reported, and remains live while the embedded SID is copied below.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast::<c_void>(),
            required,
            &raw mut returned,
        )
    } == 0
    {
        return Err(os_error("GetTokenInformation(TokenUser)"));
    }
    if returned > required {
        return Err(WindowsSecurityError::InvalidKernelResponse {
            operation: "GetTokenInformation(TokenUser)",
        });
    }
    // SAFETY: the successful call initialized a TOKEN_USER at the aligned start
    // of `storage` and Windows reported at least that structure's size.
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    copy_sid(user.User.Sid, "GetTokenInformation(TokenUser)")
}

pub(crate) fn copy_sid(
    sid: PSID,
    operation: &'static str,
) -> Result<OwnedSid, WindowsSecurityError> {
    // SAFETY: callers pass a SID pointer returned by a successful Windows
    // security API while its owning buffer remains live.
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(WindowsSecurityError::InvalidKernelResponse { operation });
    }
    // SAFETY: IsValidSid succeeded for this pointer.
    let byte_len = unsafe { GetLengthSid(sid) };
    if byte_len == 0 || byte_len > 256 {
        return Err(WindowsSecurityError::InvalidKernelResponse { operation });
    }
    let words = usize::try_from(byte_len)
        .expect("Windows SID length fits usize")
        .div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    // SAFETY: destination storage is aligned and at least byte_len bytes long;
    // source remains valid for the duration of the copy.
    if unsafe { CopySid(byte_len, storage.as_mut_ptr().cast::<c_void>(), sid) } == 0 {
        return Err(os_error("CopySid"));
    }
    Ok(OwnedSid { storage })
}

pub(crate) fn os_error(operation: &'static str) -> WindowsSecurityError {
    WindowsSecurityError::Os {
        operation,
        source: io::Error::last_os_error(),
    }
}
