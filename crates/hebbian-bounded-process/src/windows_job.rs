//! Kernel-owned Windows process containment shared by probes and launchers.

use std::ffi::{OsStr, c_void};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::ptr::null;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, GetLastError};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE};

/// The last handle kills the entire Job, including background descendants.
/// No breakaway permission is enabled. Assign a child before releasing its
/// suspended thread or cooperative launch barrier.
pub struct WindowsJob(OwnedHandle);

impl WindowsJob {
    pub fn create(name: Option<&OsStr>) -> io::Result<Self> {
        let name = name.map(wide_name).transpose()?;
        let raw = unsafe { CreateJobObjectW(null(), name.as_ref().map_or(null(), |v| v.as_ptr())) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let already_exists = name.is_some() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let job = Self(unsafe { OwnedHandle::from_raw_handle(raw) });
        if already_exists {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Job already exists",
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Opens the existing kernel object; absence never creates a replacement.
    pub fn open(name: &OsStr) -> io::Result<Option<Self>> {
        let name = wide_name(name)?;
        let raw =
            unsafe { OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, 0, name.as_ptr()) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(Self(unsafe { OwnedHandle::from_raw_handle(raw) })))
    }

    pub fn assign(&self, process: BorrowedHandle<'_>) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process.as_raw_handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn terminate(&self, exit_code: u32) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), exit_code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn is_empty(&self) -> io::Result<bool> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses == 0)
    }

    pub fn wait_empty(&self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        while !self.is_empty()? {
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Job retirement timed out",
                ));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}

fn wide_name(name: &OsStr) -> io::Result<Vec<u16>> {
    let mut name = name.encode_wide().collect::<Vec<_>>();
    if name.is_empty() || name.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid Job name",
        ));
    }
    name.push(0);
    Ok(name)
}
