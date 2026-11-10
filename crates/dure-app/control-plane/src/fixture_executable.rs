//! Test fixture executables that a parallel test's fork cannot keep busy.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

/// Writes `script` to `path` as an owner-only executable, from a short-lived
/// writer process.
///
/// Linux refuses to execute a file that any process holds open for writing
/// (`ETXTBSY`). `fs::write` opens the fixture in this test process, and a child
/// that another test thread forks meanwhile keeps a copy of that descriptor
/// until it execs or exits. The fixture's first launch then fails
/// intermittently. A separate writer process owns the only writable descriptor
/// and closes it when it exits, so no fork of this process can inherit one.
pub(crate) fn write_fixture_executable(path: &Path, script: &str) {
    let status = Command::new("/bin/sh")
        .args([
            "-c",
            r#"umask 077 && printf '%s' "$1" > "$2""#,
            "write-fixture-executable",
        ])
        .arg(script)
        .arg(path)
        .status()
        .expect("start the fixture writer");
    assert!(
        status.success(),
        "write fixture executable {}: {status}",
        path.display()
    );
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_script_verbatim_as_an_owner_only_executable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fixture with 'quotes'");
        let script =
            "#!/bin/sh\n# 'single' \"double\" \\n 100% $HOME `date` --\nprintf '%s\\n' \"$1\"\n\n";

        write_fixture_executable(&path, script);

        assert_eq!(fs::read_to_string(&path).unwrap(), script);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let output = Command::new(&path).arg("ran").output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ran\n");
    }
}
