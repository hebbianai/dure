use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SshTargetRequest {
    pub(crate) host_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) user: String,
    pub(crate) auth: String,
    pub(crate) secret_id: Option<String>,
    pub(crate) key_path: Option<String>,
    pub(crate) host_key_fingerprints: Vec<String>,
}

impl SshTargetRequest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_host_id(&self.host_id)?;
        if self.host.trim().is_empty() || self.user.trim().is_empty() || self.port == 0 {
            return Err("remote_hmux_target_invalid: host, port, and user are required".into());
        }
        validate_fingerprints(&self.host_key_fingerprints)?;
        Ok(())
    }

    pub(crate) fn checkout_options(&self) -> Result<super::SshOptions, String> {
        self.validate()?;
        Ok(self.ssh_options())
    }

    pub(crate) fn ssh_options(&self) -> super::SshOptions {
        super::SshOptions {
            host: self.host.clone(),
            port: Some(self.port),
            user: self.user.clone(),
            auth: Some(self.auth.clone()),
            secret_id: self.secret_id.clone(),
            password: None,
            key_path: self.key_path.clone(),
            passphrase: None,
            host_key_fingerprints: self.host_key_fingerprints.clone(),
        }
    }
}

fn validate_host_id(host_id: &str) -> Result<(), String> {
    if host_id.is_empty()
        || host_id.len() > 256
        || !host_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("remote_hmux_host_id_invalid: registered host id is invalid".into());
    }
    Ok(())
}

fn validate_fingerprints(fingerprints: &[String]) -> Result<(), String> {
    if fingerprints.is_empty()
        || fingerprints.iter().any(|fingerprint| {
            let Some(value) = fingerprint.strip_prefix("SHA256:") else {
                return true;
            };
            value.len() < 16
                || value.len() > 128
                || !value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'_' | b'-' | b'=')
                })
        })
    {
        return Err(
            "remote_hmux_host_untrusted: at least one valid pinned SHA256 host key is required"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SshTargetRequest {
        serde_json::from_value(serde_json::json!({
            "hostId": "saved-host", "host": "example.test", "port": 22,
            "user": "developer", "auth": "auto",
            "hostKeyFingerprints": ["SHA256:abcdefghijklmnop"]
        }))
        .unwrap()
    }

    #[test]
    fn checkout_preparation_leaves_authentication_to_the_actual_ssh_connection() {
        let mut target = target();
        // Preparation carries references, even when keys or secrets are not
        // available yet. The connection owns agent/default-key authentication.
        target.key_path = Some("/not/a/local/key".into());
        target.secret_id = Some("credential-reference".into());
        let options = target.checkout_options().unwrap();
        assert_eq!(options.auth.as_deref(), Some("auto"));
        assert_eq!(options.key_path, target.key_path);
        assert_eq!(options.secret_id, target.secret_id);
        assert_eq!(options.host_key_fingerprints, target.host_key_fingerprints);
        assert!(options.password.is_none());
        assert!(options.passphrase.is_none());
    }

    #[test]
    fn a_missing_pin_cannot_turn_a_saved_target_into_an_unpinned_connection() {
        let mut target = target();
        target.host_key_fingerprints.clear();
        assert!(target.checkout_options().is_err());
    }
}
