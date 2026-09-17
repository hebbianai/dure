use super::wide_null;
use crate::{CommandFailure, CommandSpec};
use std::ffi::OsStr;
use std::ptr::null_mut;
use windows_sys::Win32::Storage::FileSystem::SearchPathW;

pub(super) fn resolve(specification: &CommandSpec) -> Result<Vec<u16>, CommandFailure> {
    let program = specification.program();
    let name = wide_null(program.as_os_str())?;
    if program.file_name() != Some(program.as_os_str()) {
        return Ok(name);
    }

    // CreateProcessW does not search PATH when lpApplicationName is supplied.
    // Resolve only bare names against this command's effective PATH, then keep
    // the explicit application parameter (including paths containing spaces).
    let search_path = specification
        .environment()
        .iter()
        .rev()
        .find(|(key, _)| key.as_encoded_bytes().eq_ignore_ascii_case(b"PATH"))
        .map(|(_, value)| value.clone())
        .or_else(|| {
            (!specification.clears_environment())
                .then(|| std::env::var_os("PATH"))
                .flatten()
        })
        .ok_or(CommandFailure::Spawn)?;
    if search_path.is_empty() {
        return Err(CommandFailure::Spawn);
    }
    let search_path = wide_null(&search_path)?;
    let extension = wide_null(OsStr::new(".exe"))?;
    let mut resolved = Vec::new();
    loop {
        let capacity = u32::try_from(resolved.len()).map_err(|_| CommandFailure::Spawn)?;
        let length = unsafe {
            SearchPathW(
                search_path.as_ptr(),
                name.as_ptr(),
                extension.as_ptr(),
                capacity,
                if resolved.is_empty() {
                    null_mut()
                } else {
                    resolved.as_mut_ptr()
                },
                null_mut(),
            )
        };
        if length == 0 {
            return Err(CommandFailure::Spawn);
        }
        if length < capacity {
            resolved.truncate(length as usize + 1);
            return Ok(resolved);
        }
        resolved.resize(length as usize + 1, 0);
    }
}
