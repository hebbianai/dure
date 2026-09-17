use std::io;

pub(super) fn is_contended(error: &io::Error) -> bool {
    let expected = fs2::lock_contended_error();
    match (error.raw_os_error(), expected.raw_os_error()) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => error.kind() == expected.kind(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_platform_lock_contention_error() {
        assert!(is_contended(&fs2::lock_contended_error()));
        assert!(!is_contended(&io::Error::new(
            io::ErrorKind::PermissionDenied,
            "not contention",
        )));
    }
}
