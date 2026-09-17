//! Read-only evidence for an exact local Host that lost every socket owner.

use crate::{
    EndpointKind, LocalProcessGenerationStatus, SessionDescriptor, probe_local_process_generation,
};

/// A failed handshake alone cannot authorize replacement. Prove a complete
/// socket-free descriptor census between two observations of the same live
/// process generation. Any socket, incomplete census or unsupported platform
/// preserves the source. This is not a probe of provider activity.
#[must_use]
pub fn local_host_socket_owner_absent(session: &SessionDescriptor) -> bool {
    session.endpoint.kind == EndpointKind::UnixSocket
        && socket_owner_absent(
            || probe_local_process_generation(&session.host_process).ok(),
            || process_has_socket(session.host_process.process_id),
        )
}

fn socket_owner_absent(
    mut generation: impl FnMut() -> Option<LocalProcessGenerationStatus>,
    census: impl FnOnce() -> Option<bool>,
) -> bool {
    generation() == Some(LocalProcessGenerationStatus::Live)
        && census() == Some(false)
        && generation() == Some(LocalProcessGenerationStatus::Live)
}

#[cfg(target_os = "macos")]
fn process_has_socket(pid: u32) -> Option<bool> {
    use std::mem::{self, MaybeUninit};
    let pid = i32::try_from(pid).ok()?;
    let record_size = mem::size_of::<libc::proc_fdinfo>();
    let mut capacity = 64;
    while capacity <= 16_384 {
        let mut records: Vec<_> = (0..capacity)
            .map(|_| MaybeUninit::<libc::proc_fdinfo>::uninit())
            .collect();
        let bytes = i32::try_from(capacity * record_size).ok()?;
        // SAFETY: records owns bytes of writable memory; only complete records
        // reported initialized by the kernel are inspected below.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                records.as_mut_ptr().cast(),
                bytes,
            )
        };
        if written <= 0 || written as usize % record_size != 0 {
            return None;
        }
        let count = written as usize / record_size;
        if count > capacity {
            return None;
        }
        for record in records.iter().take(count) {
            // SAFETY: this record is within the initialized kernel response.
            if unsafe { record.assume_init_ref().proc_fdtype } == libc::PROX_FDTYPE_SOCKET as u32 {
                return Some(true);
            }
        }
        if count < capacity {
            return Some(false);
        }
        capacity *= 2;
    }
    None
}

#[cfg(target_os = "linux")]
fn process_has_socket(pid: u32) -> Option<bool> {
    let entries = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    for (index, entry) in entries.enumerate() {
        if index >= 16_384 {
            return None;
        }
        let target = std::fs::read_link(entry.ok()?.path()).ok()?;
        if target
            .as_os_str()
            .as_encoded_bytes()
            .starts_with(b"socket:[")
        {
            return Some(true);
        }
    }
    Some(false)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_has_socket(_pid: u32) -> Option<bool> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_socket_free_live_generation_is_admitted() {
        for sockets in [None, Some(true), Some(false)] {
            for before in [
                None,
                Some(LocalProcessGenerationStatus::Absent),
                Some(LocalProcessGenerationStatus::Live),
            ] {
                for after in [
                    None,
                    Some(LocalProcessGenerationStatus::Absent),
                    Some(LocalProcessGenerationStatus::Live),
                ] {
                    let mut states = [before, after].into_iter();
                    assert_eq!(
                        socket_owner_absent(|| states.next().flatten(), || sockets),
                        sockets == Some(false)
                            && before == Some(LocalProcessGenerationStatus::Live)
                            && after == before,
                    );
                }
            }
        }
    }
}
