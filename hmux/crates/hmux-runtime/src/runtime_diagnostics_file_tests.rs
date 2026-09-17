use super::*;
use std::os::unix::fs::symlink;

#[test]
fn owner_file_creation_and_permission_repair_preserve_private_contents() {
    let root = tempfile::tempdir().unwrap();
    for read in [true, false] {
        let path = root.path().join(format!("diagnostics-{read}"));
        let mut file = open_owner_file(&path, read).unwrap();
        file.write_all(b"retained record\n").unwrap();
        assert_eq!(file.metadata().unwrap().mode() & 0o7777, 0o600);
        for mode in [0o640, 0o660, 0o700, 0o4600] {
            file.set_permissions(fs::Permissions::from_mode(mode))
                .unwrap();
            let reopened = open_owner_file(&path, read).unwrap();
            assert_eq!(reopened.metadata().unwrap().mode() & 0o7777, 0o600);
            assert_eq!(fs::read(&path).unwrap(), b"retained record\n");
        }
    }
}

#[test]
fn owner_file_refuses_symlinks_and_non_regular_files_without_mutation() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    fs::write(&target, b"untouched").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
    let link = root.path().join("link");
    symlink(&target, &link).unwrap();
    let directory = root.path().join("directory");
    fs::create_dir(&directory).unwrap();
    for read in [true, false] {
        for path in [&link, &directory] {
            assert_eq!(
                open_owner_file(path, read).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }
    assert_eq!(fs::read(&target).unwrap(), b"untouched");
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o7777, 0o640);
}

#[cfg(target_os = "macos")]
#[test]
fn private_owner_file_reopens_do_not_emit_attribute_changes() {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    let root = tempfile::tempdir().unwrap();
    let mut attribute_changes = 0;
    for read in [true, false] {
        let path = root.path().join(format!("diagnostics-{read}"));
        let file = open_owner_file(&path, read).unwrap();
        // SAFETY: kqueue takes no pointers and returns a newly owned descriptor.
        let queue_fd = unsafe { libc::kqueue() };
        assert!(queue_fd >= 0, "{}", io::Error::last_os_error());
        // SAFETY: the successful kqueue descriptor has no other Rust owner.
        let queue = unsafe { OwnedFd::from_raw_fd(queue_fd) };
        let mut event = libc::kevent {
            ident: file.as_raw_fd() as usize,
            filter: libc::EVFILT_VNODE,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            fflags: libc::NOTE_ATTRIB,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let no_wait = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: one initialized registration; no output entries requested.
        let registered = unsafe {
            libc::kevent(
                queue.as_raw_fd(),
                &event,
                1,
                std::ptr::null_mut(),
                0,
                &no_wait,
            )
        };
        assert_eq!(registered, 0, "{}", io::Error::last_os_error());
        let mut observe_attribute_change = || {
            // SAFETY: one writable event slot and a valid zero-timeout pointer.
            let count = unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    &no_wait,
                )
            };
            assert!(count >= 0, "{}", io::Error::last_os_error());
            if count == 1 {
                let flags = event.fflags;
                assert_ne!(flags & libc::NOTE_ATTRIB, 0);
            }
            count
        };
        for _ in 0..16 {
            drop(open_owner_file(&path, read).unwrap());
            attribute_changes += observe_attribute_change();
        }
        // Prove the same observation detects a real permission change.
        file.set_permissions(fs::Permissions::from_mode(0o640))
            .unwrap();
        assert_eq!(observe_attribute_change(), 1);
    }
    assert_eq!(
        attribute_changes, 0,
        "private reopens changed file attributes"
    );
}
