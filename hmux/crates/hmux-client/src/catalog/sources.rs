use super::*;

impl LocalSessionCatalog {
    #[must_use]
    pub fn discovery_root(&self) -> &Path {
        &self.discovery_root
    }

    /// Configured lookup roots, including roots that no longer exist. Their
    /// paths identify discovery namespaces, not process or mutation authority.
    pub fn discovery_paths(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.discovery_root.as_path())
            .chain(self.read_only_discovery_roots.iter().map(PathBuf::as_path))
    }

    /// Follow an exact completed runtime edge without changing the caller's
    /// creation namespace or dropping its legacy lookup roots. This is derived
    /// observation scope, not another configured discovery root or stop permit.
    #[cfg(feature = "local-runtime")]
    #[must_use]
    pub fn including_completed_standalone_target(
        &self,
        target: &crate::CompletedStandaloneTarget,
    ) -> Self {
        let mut catalog = self.clone();
        let root = target.receipt().discovery_root();
        if !catalog.discovery_paths().any(|path| path == root) {
            catalog.read_only_discovery_roots.push(root.to_path_buf());
        }
        catalog
    }

    pub(super) fn open_path_if_present(path: &Path) -> Result<Option<DiscoveryRoot>, ClientError> {
        match path.try_exists() {
            Ok(false) => Ok(None),
            Ok(true) => DiscoveryRoot::open(path)
                .map(Some)
                .map_err(ClientError::from),
            Err(error) => Err(ClientError::Discovery(DiscoveryError::Io {
                operation: "inspect discovery root",
                path: path.to_path_buf(),
                source: error,
            })),
        }
    }

    #[cfg(feature = "local-runtime")]
    pub(super) fn mutation_source<'a>(
        &'a self,
        expected: &'a LocalSession,
        mutation: ExactSourceMutation,
    ) -> Result<&'a Path, ClientError> {
        let source = expected.discovery_root().unwrap_or(&self.discovery_root);
        if source == self.discovery_root {
            return Ok(source);
        }
        if !self
            .read_only_discovery_roots
            .iter()
            .any(|root| root == source)
            || !matches!(
                mutation,
                ExactSourceMutation::ConfirmedRetirement | ExactSourceMutation::ManagedStop
            )
        {
            let descriptor = expected.descriptor();
            return Err(ClientError::ReadOnlyDiscoveryRoot {
                session_id: descriptor.session_id.clone(),
                workspace_id: descriptor.workspace_id.clone(),
            });
        }
        Ok(source)
    }
}
