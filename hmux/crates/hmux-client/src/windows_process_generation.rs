use crate::{ClientError, ProcessDescriptor};
use std::io;
#[cfg(test)]
use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_HANDLE, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, STILL_ACTIVE,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const WINDOWS_PROCESS_START_MARKER_PREFIX: &str = "windows-proc-start-v1:";

/// Read-only lifecycle posture for one exact Windows process generation.
///
/// `Absent` means the recorded generation has exited or its numeric process id
/// now belongs to another generation. An inspection failure remains an error
/// so callers never turn an access-denied result into authority to clean up.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalProcessGenerationStatus {
    Live,
    Absent,
}

/// Captures the kernel creation identity of one local Windows process.
pub fn exact_local_process_generation(process_id: u32) -> Result<ProcessDescriptor, ClientError> {
    validate_process_id(process_id)?;
    let process = ProcessHandle::open(process_id).map_err(process_inspection_refused)?;
    ensure_process_is_active(&process)?;
    let creation_time = process_creation_time(&process).map_err(process_inspection_refused)?;
    Ok(ProcessDescriptor {
        process_id,
        start_marker: format!("{WINDOWS_PROCESS_START_MARKER_PREFIX}{creation_time}"),
    })
}

/// Inspects one exact Windows process generation without signaling it.
pub fn probe_local_process_generation(
    process: &ProcessDescriptor,
) -> Result<LocalProcessGenerationStatus, ClientError> {
    validate_process_id(process.process_id)?;
    let expected_creation_time = parse_start_marker(&process.start_marker)?;
    let handle = match ProcessHandle::open(process.process_id) {
        Ok(handle) => handle,
        Err(error) if process_object_disappeared(&error) => {
            return Ok(LocalProcessGenerationStatus::Absent);
        }
        Err(error) => return Err(process_inspection_refused(error)),
    };
    let creation_time = match process_creation_time(&handle) {
        Ok(creation_time) => creation_time,
        Err(error) if process_object_disappeared(&error) => {
            return Ok(LocalProcessGenerationStatus::Absent);
        }
        Err(error) => return Err(process_inspection_refused(error)),
    };
    if creation_time != expected_creation_time {
        return Ok(LocalProcessGenerationStatus::Absent);
    }
    let mut exit_code = 0_u32;
    if unsafe { GetExitCodeProcess(handle.raw(), &raw mut exit_code) } == 0 {
        let error = io::Error::last_os_error();
        return if process_object_disappeared(&error) {
            Ok(LocalProcessGenerationStatus::Absent)
        } else {
            Err(process_inspection_refused(error))
        };
    }
    Ok(if exit_code == STILL_ACTIVE as u32 {
        LocalProcessGenerationStatus::Live
    } else {
        LocalProcessGenerationStatus::Absent
    })
}

fn validate_process_id(process_id: u32) -> Result<(), ClientError> {
    if process_id == 0 {
        return Err(process_inspection_refused(io::Error::other(
            "process id is invalid",
        )));
    }
    Ok(())
}

fn parse_start_marker(marker: &str) -> Result<u64, ClientError> {
    marker
        .strip_prefix(WINDOWS_PROCESS_START_MARKER_PREFIX)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value != 0)
        .ok_or_else(|| {
            process_inspection_refused(io::Error::other(
                "Windows process generation marker is invalid",
            ))
        })
}

fn ensure_process_is_active(process: &ProcessHandle) -> Result<(), ClientError> {
    let mut exit_code = 0_u32;
    if unsafe { GetExitCodeProcess(process.raw(), &raw mut exit_code) } == 0 {
        return Err(process_inspection_refused(io::Error::last_os_error()));
    }
    if exit_code != STILL_ACTIVE as u32 {
        return Err(process_inspection_refused(io::Error::other(
            "process generation has already exited",
        )));
    }
    Ok(())
}

fn process_creation_time(process: &ProcessHandle) -> io::Result<u64> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe {
        GetProcessTimes(
            process.raw(),
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let creation_time =
        (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if creation_time == 0 {
        return Err(io::Error::other(
            "Windows process creation time is unavailable",
        ));
    }
    Ok(creation_time)
}

fn process_object_disappeared(error: &io::Error) -> bool {
    // Windows reports either code while a terminated process object is being
    // removed. Permission and query failures remain distinguishable errors.
    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_INVALID_HANDLE as i32
                || code == ERROR_INVALID_PARAMETER as i32
    )
}

fn process_inspection_refused(reason: io::Error) -> ClientError {
    ClientError::transport(
        "hmux_process_generation_unverified",
        format!(
            "refusing local process action: Windows process identity is not verifiable ({reason})"
        ),
    )
}

struct ProcessHandle(HANDLE);

impl ProcessHandle {
    fn open(process_id: u32) -> io::Result<Self> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        (!handle.is_null())
            .then_some(Self(handle))
            .ok_or_else(io::Error::last_os_error)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_process_generation_is_exact_and_live() {
        let generation = exact_local_process_generation(std::process::id()).unwrap();
        assert!(
            generation
                .start_marker
                .starts_with(WINDOWS_PROCESS_START_MARKER_PREFIX)
        );
        assert_eq!(
            probe_local_process_generation(&generation).unwrap(),
            LocalProcessGenerationStatus::Live
        );
    }

    #[test]
    fn changed_creation_identity_is_absent() {
        let mut generation = exact_local_process_generation(std::process::id()).unwrap();
        let creation_time = parse_start_marker(&generation.start_marker).unwrap();
        generation.start_marker = format!(
            "{WINDOWS_PROCESS_START_MARKER_PREFIX}{}",
            creation_time.saturating_add(1)
        );
        assert_eq!(
            probe_local_process_generation(&generation).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }

    #[test]
    fn unknown_marker_fails_closed() {
        let error = probe_local_process_generation(&ProcessDescriptor {
            process_id: std::process::id(),
            start_marker: "future-windows-marker".into(),
        })
        .unwrap_err();
        assert!(error.to_string().contains("not verifiable"));
    }

    #[test]
    fn only_disappeared_process_errors_converge_to_absent() {
        assert!(process_object_disappeared(&io::Error::from_raw_os_error(
            ERROR_INVALID_HANDLE as i32,
        )));
        assert!(process_object_disappeared(&io::Error::from_raw_os_error(
            ERROR_INVALID_PARAMETER as i32,
        )));
        assert!(!process_object_disappeared(&io::Error::from_raw_os_error(
            ERROR_ACCESS_DENIED as i32,
        )));
    }
}
