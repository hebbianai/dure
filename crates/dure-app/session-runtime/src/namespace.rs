use std::io;
use std::path::{Path, PathBuf};

/// Resolve a resource namespace even after its discovery directory is gone.
/// Only existing ancestors are canonicalized; a missing ordinary suffix stays
/// part of the identity. This neither creates a root nor proves runtime absence.
pub(crate) fn runtime_namespace(root: &Path) -> io::Result<String> {
    namespace_path(root)?
        .into_os_string()
        .into_string()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF-8 runtime namespace"))
}

fn namespace_path(root: &Path) -> io::Result<PathBuf> {
    match root.canonicalize() {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match root.symlink_metadata() {
                Err(missing) if missing.kind() == io::ErrorKind::NotFound => {}
                // A dangling symlink has an unresolved destination, not a
                // namespace equal to its lexical path.
                Ok(_) => return Err(error),
                Err(other) => return Err(other),
            }
            let name = root.file_name().ok_or(error)?;
            let parent = root
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            Ok(namespace_path(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests;
