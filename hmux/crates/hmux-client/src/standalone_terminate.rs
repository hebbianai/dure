use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::{
    ClientError, LocalSession, LocalSessionCatalog, SessionClass, SessionDescriptor,
    SessionLifecycle, SessionSelector,
};
use hmux_host::provider_epoch::{
    ProcessSessionCleanupStage, process_session_cleanup_is_incomplete,
};
use hmux_session_protocol::{
    FrameBody, STANDALONE_TERMINATION_CAPABILITY, StandaloneTerminate,
    StandaloneTerminateReceiptState,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const TERMINATION_POLL_INTERVAL: Duration = Duration::from_millis(25);
const TERMINATION_RECEIPT_TIMEOUT: Duration = Duration::from_secs(3);

impl LocalSession {
    /// Ask this exact standalone Host to terminate its owned provider.
    ///
    /// New Hosts own termination through the fully fenced protocol. A legacy
    /// Host must first authenticate the same fence and process proofs; on Unix,
    /// the client then verifies those proofs against OS process identity before
    /// terminating only the provider-owned POSIX session.
    pub fn terminate_standalone(
        &self,
        catalog: &LocalSessionCatalog,
        retirement_timeout: Duration,
    ) -> Result<(), ClientError> {
        if self.descriptor().session_class != SessionClass::Standalone {
            return Err(ClientError::transport(
                "hmux_standalone_termination_refused",
                "only standalone Hmux sessions can be terminated locally",
            ));
        }
        if self.descriptor().lifecycle == SessionLifecycle::Exited {
            return ensure_cleanup_complete(self.descriptor());
        }
        if !supports_termination(self) {
            return self.terminate_legacy_standalone(catalog, retirement_timeout);
        }
        match self.terminate_standalone_via_host(catalog, retirement_timeout) {
            Ok(()) => Ok(()),
            Err(error) if protocol_failure_allows_verified_fallback(&error) => {
                #[cfg(all(unix, feature = "local-runtime"))]
                {
                    self.terminate_legacy_standalone(catalog, retirement_timeout)
                }
                #[cfg(not(all(unix, feature = "local-runtime")))]
                {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }

    fn terminate_standalone_via_host(
        &self,
        catalog: &LocalSessionCatalog,
        retirement_timeout: Duration,
    ) -> Result<(), ClientError> {
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None)
                .with_optional_capabilities(&[STANDALONE_TERMINATION_CAPABILITY]),
        )?;
        if !connection.supports(STANDALONE_TERMINATION_CAPABILITY) {
            return Err(ClientError::MissingCapability {
                capability: STANDALONE_TERMINATION_CAPABILITY,
            });
        }
        let request_id = next_termination_request_id();
        connection
            .writer()
            .send(FrameBody::StandaloneTerminate(StandaloneTerminate {
                request_id: request_id.clone(),
            }))?;

        let receipt_started = Instant::now();
        loop {
            let elapsed = receipt_started.elapsed();
            if elapsed >= TERMINATION_RECEIPT_TIMEOUT {
                return Err(ClientError::transport(
                    "hmux_standalone_termination_receipt_timeout",
                    "Hmux Host did not acknowledge standalone termination before the deadline",
                ));
            }
            connection
                .set_read_timeout(Some(TERMINATION_RECEIPT_TIMEOUT.saturating_sub(elapsed)))?;
            match connection.read_body()? {
                FrameBody::StandaloneTerminateReceipt(receipt)
                    if receipt.request_id == request_id =>
                {
                    match receipt.state {
                        StandaloneTerminateReceiptState::Accepted => break,
                        StandaloneTerminateReceiptState::Refused
                        | StandaloneTerminateReceiptState::Failed => {
                            return Err(ClientError::transport(
                                "hmux_standalone_termination_refused",
                                format!(
                                    "Hmux Host refused standalone termination ({:?})",
                                    receipt.reason
                                ),
                            ));
                        }
                    }
                }
                FrameBody::StandaloneTerminateReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_standalone_termination_uncorrelated",
                        "Hmux Host returned a termination receipt for another request",
                    ));
                }
                FrameBody::OutputDelta(_)
                | FrameBody::ScreenSnapshot(_)
                | FrameBody::AgentRuntimeState(_) => {}
                FrameBody::Exit(_) => break,
                _ => {}
            }
        }
        connection.shutdown();

        if wait_until_retired(catalog, self, retirement_timeout)? {
            return Ok(());
        }
        Err(ClientError::transport(
            "hmux_standalone_termination_timeout",
            format!(
                "standalone Hmux session {:?} remained ready after Host-owned termination",
                self.descriptor().session_id
            ),
        ))
    }

    #[cfg(all(unix, feature = "local-runtime"))]
    fn terminate_legacy_standalone(
        &self,
        catalog: &LocalSessionCatalog,
        retirement_timeout: Duration,
    ) -> Result<(), ClientError> {
        // The connection is kept alive past its detach purely to own the
        // colocation witness. Every step below reads or signals *this
        // machine's* process table using ids that came from a manifest, and
        // the witness is the receipt proving the Host we authenticated is on
        // this kernel. Dropping the connection would drop the evidence.
        let mut connection = match self
            .connect_with_options(ConnectionOptions::new(LocalAttachRole::Observer, None))
        {
            Ok(connection) => connection,
            Err(error) if protocol_failure_allows_verified_fallback(&error) => {
                // Previously this fell through to signalling pids that had
                // only been checked against a manifest. That is precisely
                // the path that answers confidently wrong once a manifest
                // can describe another machine, and there is no way to
                // obtain a witness here: the dial failed, so nothing
                // proved the Host is local.
                return Err(ClientError::transport(
                    "hmux_termination_unwitnessed",
                    "cannot terminate this session: its Host did not answer, so there is \
                         no proof it is running on this machine",
                ));
            }
            Err(error) => return Err(error),
        };
        ensure_authenticated_process_proofs(self.descriptor(), &connection)?;
        if connection
            .detach("legacy_termination_identity_verified")
            .is_err()
        {
            // The authenticated hello already fenced the exact Host
            // generation. A broken legacy writer must not make its
            // own provider impossible to terminate.
            connection.shutdown();
        }

        let Some(current) = current_instance(catalog, self)? else {
            return Ok(());
        };
        ensure_same_process_proofs(self.descriptor(), current.descriptor())?;
        let scope = session_scope(current.descriptor());
        let colocation = connection
            .attestation()
            .witness_for(&scope)
            .map_err(|error| {
                ClientError::transport("hmux_termination_unwitnessed", error.to_string())
            })?;
        crate::legacy_terminate::terminate_verified_process_session(
            colocation,
            current.descriptor(),
        )?;
        if wait_until_retired(catalog, self, retirement_timeout)? {
            return Ok(());
        }
        crate::legacy_terminate::terminate_verified_host(colocation, current.descriptor())?;
        if current_instance(catalog, self)?.is_none() {
            return Ok(());
        }
        catalog.cleanup_exact(colocation, &current)?;
        Ok(())
    }

    #[cfg(not(all(unix, feature = "local-runtime")))]
    fn terminate_legacy_standalone(
        &self,
        _catalog: &LocalSessionCatalog,
        _retirement_timeout: Duration,
    ) -> Result<(), ClientError> {
        Err(ClientError::MissingCapability {
            capability: STANDALONE_TERMINATION_CAPABILITY,
        })
    }
}

fn supports_termination(session: &LocalSession) -> bool {
    session
        .descriptor()
        .capabilities
        .iter()
        .any(|capability| capability == STANDALONE_TERMINATION_CAPABILITY)
}

fn protocol_failure_allows_verified_fallback(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Io { .. }
            | ClientError::EndpointUnavailable { .. }
            | ClientError::Protocol(_)
            | ClientError::ProtocolVersionMismatch
            | ClientError::UnexpectedFrame { .. }
            | ClientError::InconsistentStream { .. }
            | ClientError::MissingCapability { .. }
            | ClientError::Transport {
                code: "hmux_transport_closed" | "hmux_standalone_termination_receipt_timeout",
                ..
            }
    )
}

#[cfg(all(unix, feature = "local-runtime"))]
fn ensure_authenticated_process_proofs(
    descriptor: &SessionDescriptor,
    connection: &crate::connection::LocalConnection,
) -> Result<(), ClientError> {
    let hello = connection.hello_ack();
    let provider_matches = hello.provider_process.as_ref().is_some_and(|provider| {
        provider.process_id == descriptor.provider_process.process_id
            && provider.start_marker == descriptor.provider_process.start_marker
    });
    if hello.host_process.process_id != descriptor.host_process.process_id
        || hello.host_process.start_marker != descriptor.host_process.start_marker
        || !provider_matches
    {
        return Err(ClientError::transport(
            "hmux_legacy_termination_unverified",
            "refusing legacy Hmux termination: authenticated Host process proofs do not match discovery",
        ));
    }
    Ok(())
}

#[cfg(all(unix, feature = "local-runtime"))]
fn ensure_same_process_proofs(
    expected: &SessionDescriptor,
    current: &SessionDescriptor,
) -> Result<(), ClientError> {
    if current.host_process != expected.host_process
        || current.provider_process != expected.provider_process
    {
        return Err(ClientError::transport(
            "hmux_legacy_termination_unverified",
            "refusing legacy Hmux termination: discovery process generation changed after authentication",
        ));
    }
    Ok(())
}

fn next_termination_request_id() -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "standalone_terminate_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn wait_until_retired(
    catalog: &LocalSessionCatalog,
    target: &LocalSession,
    timeout: Duration,
) -> Result<bool, ClientError> {
    let started = Instant::now();
    loop {
        if current_instance(catalog, target)?.is_none() {
            return Ok(true);
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Ok(false);
        }
        thread::sleep(TERMINATION_POLL_INTERVAL.min(timeout.saturating_sub(elapsed)));
    }
}

/// Identity a colocation witness must have been taken for. `host_instance_id`
/// is included so a witness cannot outlive the Host it attests to.
#[cfg(all(unix, feature = "local-runtime"))]
fn session_scope(
    descriptor: &SessionDescriptor,
) -> hmux_local_platform::peer_attestation::SessionScope {
    hmux_local_platform::peer_attestation::SessionScope::new(
        descriptor.workspace_id.clone(),
        descriptor.session_id.clone(),
        descriptor.host_instance_id.clone(),
    )
}

fn current_instance(
    catalog: &LocalSessionCatalog,
    target: &LocalSession,
) -> Result<Option<LocalSession>, ClientError> {
    let target_descriptor = target.descriptor();
    let selector = SessionSelector::new(
        target_descriptor.session_id.clone(),
        Some(target_descriptor.workspace_id.clone()),
    );
    let current = match catalog.open(&selector) {
        Ok(current) => current,
        Err(ClientError::SessionNotFound { .. }) => return Ok(None),
        Err(error) => return Err(error),
    };
    let descriptor = current.descriptor();
    if descriptor.lifecycle == SessionLifecycle::Exited {
        ensure_cleanup_complete(descriptor)?;
        return Ok(None);
    }
    // The legacy fallback signals an OS process after this check. Comparing
    // only process-adjacent fields would let a same-process replacement with a
    // new runner/channel epoch inherit the old generation's authority.
    if !descriptor.same_generation(target_descriptor) {
        return Ok(None);
    }
    Ok(Some(current))
}

fn ensure_cleanup_complete(descriptor: &SessionDescriptor) -> Result<(), ClientError> {
    if descriptor
        .exit
        .as_ref()
        .is_some_and(|exit| process_session_cleanup_is_incomplete(&exit.reason))
    {
        let stages = descriptor
            .exit
            .as_ref()
            .map(|exit| cleanup_failure_stages(&exit.reason))
            .unwrap_or_default();
        let stage_detail = (!stages.is_empty()).then(|| {
            format!(
                " (proof stage: {})",
                stages
                    .iter()
                    .map(|stage| stage.stable_name())
                    .collect::<Vec<_>>()
                    .join(",")
            )
        });
        return Err(ClientError::transport(
            "hmux_standalone_termination_incomplete",
            format!(
                "Hmux Host could not prove that every provider-session process group was terminated{}",
                stage_detail.as_deref().unwrap_or_default()
            ),
        ));
    }
    Ok(())
}

fn cleanup_failure_stages(reason: &str) -> Vec<ProcessSessionCleanupStage> {
    reason
        .split("; ")
        .filter_map(ProcessSessionCleanupStage::from_reason_token)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{cleanup_failure_stages, protocol_failure_allows_verified_fallback};
    use crate::{ClientError, HostErrorCode, RetryDirective};
    use hmux_host::provider_epoch::{
        ProcessSessionCleanupStage, process_session_cleanup_is_incomplete,
    };

    #[test]
    fn incomplete_process_session_cleanup_is_a_stable_exit_diagnostic() {
        assert!(process_session_cleanup_is_incomplete(
            "provider terminated by Hmux Host; process_session_cleanup_incomplete"
        ));
        assert!(!process_session_cleanup_is_incomplete(
            "provider terminated by Hmux Host; terminal output drain timed out"
        ));
        assert_eq!(
            cleanup_failure_stages(
                "provider terminated by Hmux Host; process_session_cleanup_incomplete; \
                 process_session_cleanup_stage_v1=process_group_signal; \
                 process_session_cleanup_stage_v1=descendant_drain"
            ),
            vec![
                ProcessSessionCleanupStage::ProcessGroupSignal,
                ProcessSessionCleanupStage::DescendantDrain,
            ]
        );
        assert!(
            cleanup_failure_stages(
                "provider terminated by Hmux Host; process_session_cleanup_stage_v2=future"
            )
            .is_empty()
        );
    }

    #[test]
    fn only_unreachable_protocol_failures_allow_direct_verified_fallback() {
        assert!(protocol_failure_allows_verified_fallback(
            &ClientError::transport("hmux_transport_closed", "closed")
        ));
        assert!(protocol_failure_allows_verified_fallback(
            &ClientError::MissingCapability {
                capability: "standalone_termination_v1"
            }
        ));
        assert!(!protocol_failure_allows_verified_fallback(
            &ClientError::HostRefused {
                code: HostErrorCode::AuthorizationDenied,
                message: "denied".into(),
                retry: RetryDirective::Never,
            }
        ));
        assert!(!protocol_failure_allows_verified_fallback(
            &ClientError::HostRefused {
                code: HostErrorCode::UnsupportedProtocolVersion,
                message: "unsupported".into(),
                retry: RetryDirective::Never,
            }
        ));
        assert!(!protocol_failure_allows_verified_fallback(
            &ClientError::HostRefused {
                code: HostErrorCode::TransportClosed,
                message: "closed".into(),
                retry: RetryDirective::Reconnect,
            }
        ));
        assert!(!protocol_failure_allows_verified_fallback(
            &ClientError::transport("hmux_standalone_termination_refused", "refused")
        ));
    }
}
