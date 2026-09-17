use std::fmt;

const MAX_BYTES: usize = 4096;

/// An execution-side absolute path, independent of the desktop's filesystem.
/// Parse remote input once; joins and parents preserve the POSIX invariant.
#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) struct RemotePosixPath(String);

impl RemotePosixPath {
    pub(crate) fn from_absolute(path: impl AsRef<str>) -> Result<Self, String> {
        let path = path.as_ref();
        if path.len() > MAX_BYTES {
            return Err("remote POSIX path is too long".to_string());
        }
        if !path.starts_with('/') || path.starts_with("//") {
            return Err("remote POSIX path must have one absolute root".to_string());
        }
        let normalized = path.trim_end_matches('/');
        if normalized.is_empty() {
            return Ok(Self("/".to_string()));
        }
        Self::validate_relative(&normalized[1..])?;
        Ok(Self(normalized.to_string()))
    }

    #[cfg(any(not(windows), test))]
    pub(crate) fn join_relative(&self, relative: &str) -> Result<Self, String> {
        Self::validate_relative(relative)?;
        let root = self.0.trim_end_matches('/');
        if root.len() + 1 + relative.len() > MAX_BYTES {
            return Err("remote POSIX path is too long".to_string());
        }
        Ok(Self(format!("{root}/{relative}")))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    #[cfg(any(not(windows), test))]
    pub(crate) fn parent(&self) -> Option<Self> {
        if self.0 == "/" {
            return None;
        }
        let (parent, _) = self.0.rsplit_once('/')?;
        Some(Self(if parent.is_empty() { "/" } else { parent }.to_string()))
    }

    fn validate_relative(relative: &str) -> Result<(), String> {
        if relative.chars().any(char::is_control) || relative.contains('\\') {
            return Err("remote path contains control or backslash character".to_string());
        }
        if relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("remote relative path contains empty, '.' or '..' segment".to_string());
        }
        Ok(())
    }
}

impl fmt::Display for RemotePosixPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::RemotePosixPath;

    #[test]
    fn accepts_absolute_linux_home_paths() {
        let path = RemotePosixPath::from_absolute("/home/developer").unwrap();
        assert_eq!(path.as_str(), "/home/developer");
    }

    #[test]
    fn rejects_relative_and_backslash_windows_style_paths() {
        for path in [
            "", "home/developer", "C:/home/developer", "\\home\\developer",
            "/home\\developer", "/home/../developer", "/home/./developer",
            "/home//developer", "//home/developer", "//", "/home/a\n",
            "/home/a\r", "/home/a\t", "/home/a\0", "/home/a\u{85}",
        ] {
            assert!(RemotePosixPath::from_absolute(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn joins_reject_unsafe_fragments() {
        let home = RemotePosixPath::from_absolute("/home/developer").unwrap();
        for fragment in ["", "/tmp", ".", "..", "a/../b", "a//b", "a/", "a\\b", "a\n"] {
            assert!(home.join_relative(fragment).is_err(), "{fragment:?}");
        }
    }

    #[test]
    fn joined_path_cannot_exceed_the_absolute_path_bound() {
        let home = RemotePosixPath::from_absolute(format!("/{}", "h".repeat(4094))).unwrap();
        assert!(home.join_relative("x").is_err());
        assert!(RemotePosixPath::from_absolute(format!("/{}", "h".repeat(4096))).is_err());
        let home = RemotePosixPath::from_absolute(format!("/{}", "h".repeat(4093))).unwrap();
        let joined = home.join_relative("x").unwrap();
        assert_eq!(joined.as_str().len(), 4096);
        assert_eq!(RemotePosixPath::from_absolute(joined.as_str()).unwrap(), joined);
    }

    #[test]
    fn accepts_spaces_and_slash_join_for_remote_relative_append() {
        let home = RemotePosixPath::from_absolute("/home/has spaces").unwrap();
        let profile = home.join_relative(".dure/accounts/codex-work").unwrap();
        assert_eq!(profile.as_str(), "/home/has spaces/.dure/accounts/codex-work");
    }

    #[test]
    fn root_trailing_slashes_and_parents_preserve_absolute_paths() {
        let root = RemotePosixPath::from_absolute("/").unwrap();
        let home = RemotePosixPath::from_absolute("/home/developer/").unwrap();
        assert_eq!(home.to_string(), "/home/developer");
        assert_eq!(home.parent().unwrap().as_str(), "/home");
        assert_eq!(root.join_relative(".codex").unwrap().as_str(), "/.codex");
        assert_eq!(root.join_relative(".codex").unwrap().parent(), Some(root.clone()));
        assert_eq!(root.parent(), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_host_paths_do_not_define_remote_absolute_paths() {
        let linux_home = "/home/has spaces";
        assert!(!std::path::Path::new(linux_home).is_absolute());
        assert!(std::path::Path::new(linux_home)
            .join(".codex")
            .to_str()
            .unwrap()
            .contains('\\'));
        let remote = RemotePosixPath::from_absolute(linux_home).unwrap();
        assert_eq!(remote.join_relative(".codex").unwrap().as_str(), "/home/has spaces/.codex");
    }
}
