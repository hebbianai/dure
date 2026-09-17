use super::*;

impl LocalSessionCatalog {
    /// Read the exact create's current or archived generation. An active
    /// pointer's absence is not evidence that creation never happened.
    pub fn find_creation(
        &self,
        workspace_id: &str,
        session_id: &str,
        create_key: &str,
    ) -> Result<Option<LocalSession>, ClientError> {
        match self.open(&SessionSelector::new(session_id, Some(workspace_id.into()))) {
            Ok(session) if session.create_idempotency_key() == Some(create_key) => {
                return Ok(Some(session));
            }
            Ok(_) => {}
            Err(error) if error.is_session_absent() => {}
            Err(error) => return Err(error),
        }
        let mut found = None;
        for path in self.discovery_paths() {
            let Some(root) = Self::open_path_if_present(path)? else {
                continue;
            };
            let Some(discovered) =
                root.find_retired_creation(workspace_id, session_id, create_key)?
            else {
                continue;
            };
            if found.as_ref().is_some_and(|prior| prior != &discovered) {
                return Err(DiscoveryError::GenerationMismatch.into());
            }
            found = Some(discovered);
        }
        Ok(found.map(LocalSession::from_discovered))
    }
}
