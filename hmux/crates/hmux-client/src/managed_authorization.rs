use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::error::host_refused;
use crate::{ClientError, LocalSession, SessionClass};
use hmux_session_protocol::{
    FrameBody, MANAGED_AUTHORIZATION_GRANT_CAPABILITY, ManagedAuthorizationGrantRequest,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const GRANT_RECEIPT_TIMEOUT: Duration = Duration::from_secs(3);

impl LocalSession {
    /// Select the managed attach proof supported by this exact Host.
    ///
    /// Current Hosts mint a short-lived one-use grant. Older Hosts, including
    /// the Windows compatibility runtime, authenticate the same attach with
    /// the manifest token. Keeping that choice here prevents local product and
    /// SSH gateway callers from maintaining separate capability fallbacks.
    pub fn managed_attach_authorization_proof(&self) -> Result<String, ClientError> {
        if self.descriptor().session_class != SessionClass::Managed {
            return Err(ClientError::transport(
                "hmux_managed_attach_protocol",
                "managed attach authorization requires a managed session",
            ));
        }
        if self
            .descriptor()
            .capabilities
            .iter()
            .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
        {
            self.request_managed_authorization_grant()
        } else {
            self.capability_token()
                .ok_or_else(|| {
                    ClientError::transport(
                        "hmux_managed_attach_protocol",
                        "managed session has no attach capability",
                    )
                })
                .map(str::to_string)
        }
    }

    /// Request one short-lived, single-use managed authorization proof over a
    /// local same-user connection. Runtime brokers use this primitive; the
    /// proof never enters discovery or product-facing state.
    pub fn request_managed_authorization_grant(&self) -> Result<String, ClientError> {
        if self.descriptor().session_class != SessionClass::Managed
            || !self
                .descriptor()
                .capabilities
                .iter()
                .any(|capability| capability == MANAGED_AUTHORIZATION_GRANT_CAPABILITY)
        {
            return Err(ClientError::MissingCapability {
                capability: MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            });
        }
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None)
                .with_optional_capabilities(&[MANAGED_AUTHORIZATION_GRANT_CAPABILITY]),
        )?;
        if !connection.supports(MANAGED_AUTHORIZATION_GRANT_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: MANAGED_AUTHORIZATION_GRANT_CAPABILITY,
            });
        }
        let request_id = next_grant_request_id();
        connection
            .writer()
            .send(FrameBody::ManagedAuthorizationGrantRequest(
                ManagedAuthorizationGrantRequest {
                    request_id: request_id.clone(),
                },
            ))?;

        let started = Instant::now();
        let proof = loop {
            let elapsed = started.elapsed();
            if elapsed >= GRANT_RECEIPT_TIMEOUT {
                return Err(ClientError::transport(
                    "hmux_managed_authorization_grant_timeout",
                    "Hmux Host did not mint a managed authorization grant",
                ));
            }
            connection.set_read_timeout(Some(GRANT_RECEIPT_TIMEOUT.saturating_sub(elapsed)))?;
            match connection.read_body()? {
                FrameBody::ManagedAuthorizationGrantReceipt(receipt)
                    if receipt.request_id == request_id =>
                {
                    break receipt.authorization_proof_reference;
                }
                FrameBody::ManagedAuthorizationGrantReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_managed_authorization_grant_uncorrelated",
                        "Hmux Host returned a managed grant for another request",
                    ));
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                _ => {}
            }
        };
        let _ = connection.detach("managed_authorization_grant_complete");
        Ok(proof)
    }
}

fn next_grant_request_id() -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "managed_authorization_grant_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
