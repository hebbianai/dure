//! Bounded SSH host-key observation without authentication or an exec channel.

use crate::error::SshTransportError;
use crate::session::{SshEndpoint, client_config};
use russh::keys::HashAlg;
use std::io;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedHostKey {
    algorithm: String,
    fingerprint_sha256: [u8; 32],
}

impl ObservedHostKey {
    #[must_use]
    pub fn algorithm(&self) -> &str {
        &self.algorithm
    }

    #[must_use]
    pub fn fingerprint_sha256(&self) -> [u8; 32] {
        self.fingerprint_sha256
    }

    #[must_use]
    pub fn fingerprint(&self) -> String {
        russh::keys::ssh_key::Fingerprint::Sha256(self.fingerprint_sha256).to_string()
    }
}

struct Observer {
    observed: Arc<Mutex<Option<ObservedHostKey>>>,
}

impl russh::client::Handler for Observer {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint_sha256 = server_public_key
            .fingerprint(HashAlg::Sha256)
            .sha256()
            .expect("a SHA-256 fingerprint contains a SHA-256 digest");
        *self.observed.lock().expect("observed host-key lock") = Some(ObservedHostKey {
            algorithm: server_public_key.algorithm().as_str().to_string(),
            fingerprint_sha256,
        });
        // Observation grants no trust. Returning false ends the handshake
        // before authentication, channel creation, or command execution.
        Ok(false)
    }
}

/// Observes the key sshd actually offers at one endpoint.
///
/// This is intentionally separate from [`crate::HostKeyPolicy`]: observation
/// creates no accept-any policy and cannot be reused to authenticate a session.
pub fn observe_server_host_key(
    endpoint: SshEndpoint,
    timeout: Duration,
) -> Result<ObservedHostKey, SshTransportError> {
    thread::Builder::new()
        .name("hmux-ssh-host-key-observer".to_string())
        .spawn(move || observe_blocking(endpoint, timeout))
        .map_err(SshTransportError::Runtime)?
        .join()
        .map_err(|_| {
            SshTransportError::Runtime(io::Error::other("SSH host-key observer panicked"))
        })?
}

fn observe_blocking(
    endpoint: SshEndpoint,
    timeout: Duration,
) -> Result<ObservedHostKey, SshTransportError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(SshTransportError::Runtime)?;
    let result = runtime.block_on(async move {
        match tokio::time::timeout(timeout, observe(&endpoint)).await {
            Err(_) => Err(SshTransportError::Timeout {
                phase: "SSH host-key observation",
                after: timeout,
            }),
            Ok(result) => result,
        }
    });
    // A hostname lookup may occupy Tokio's blocking pool after its future is
    // cancelled. It must not turn this bounded probe into an unbounded runtime
    // drop on the caller's worker thread.
    runtime.shutdown_timeout(Duration::ZERO);
    result
}

async fn observe(endpoint: &SshEndpoint) -> Result<ObservedHostKey, SshTransportError> {
    let observed = Arc::new(Mutex::new(None));
    let result = russh::client::connect(
        client_config(),
        (endpoint.host.as_str(), endpoint.port),
        Observer {
            observed: Arc::clone(&observed),
        },
    )
    .await;
    if let Some(host_key) = observed.lock().expect("observed host-key lock").take() {
        return Ok(host_key);
    }
    Err(SshTransportError::Connect {
        target: format!("{}:{}", endpoint.host, endpoint.port),
        detail: result.err().map_or_else(
            || "the SSH handshake offered no host key".to_string(),
            |error| error.to_string(),
        ),
    })
}
