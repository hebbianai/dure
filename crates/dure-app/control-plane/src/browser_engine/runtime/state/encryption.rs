use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(try_from = "String")]
pub(in crate::browser_engine::runtime) struct BrowserStateKey([u8; 32]);

impl std::fmt::Debug for BrowserStateKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("BrowserStateKey([REDACTED])")
    }
}

impl TryFrom<String> for BrowserStateKey {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("browser_state_key_invalid");
        }
        let mut key = [0; 32];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| "browser_state_key_invalid")?;
        }
        Ok(Self(key))
    }
}

impl BrowserStateKey {
    pub(super) fn encrypt(&self, bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        // The existing artifact bound includes the nonce and authentication tag.
        if bytes.len() > super::super::capture::MAX_ARTIFACT_BYTES - 28 {
            return Err("browser_artifact_too_large");
        }
        let mut nonce = [0; 12];
        getrandom::fill(&mut nonce).map_err(|_| "browser_state_nonce_unavailable")?;
        let cipher = Aes256Gcm::new_from_slice(&self.0).map_err(|_| "browser_state_key_invalid")?;
        let ciphertext = cipher
            .encrypt(&Nonce::from(nonce), bytes)
            .map_err(|_| "browser_state_encryption_failed")?;
        let mut result = Vec::with_capacity(12 + ciphertext.len());
        result.extend_from_slice(&nonce);
        result.extend_from_slice(&ciphertext);
        Ok(result)
    }

    pub(super) fn decrypt(&self, bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
        if bytes.len() < 28 || bytes.len() > super::super::capture::MAX_ARTIFACT_BYTES {
            return Err("browser_state_decryption_failed");
        }
        let nonce: [u8; 12] = bytes[..12]
            .try_into()
            .map_err(|_| "browser_state_decryption_failed")?;
        let cipher = Aes256Gcm::new_from_slice(&self.0).map_err(|_| "browser_state_key_invalid")?;
        cipher
            .decrypt(&Nonce::from(nonce), &bytes[12..])
            .map_err(|_| "browser_state_decryption_failed")
    }
}

#[cfg(test)]
mod tests;
