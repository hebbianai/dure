use crate::connection::{ConnectionOptions, LocalAttachRole, LocalConnection};
use crate::error::host_refused;
use crate::{ClientError, SessionDescriptor};
#[cfg(feature = "local-runtime")]
use hmux_host::local_discovery::ManifestGeneration;
use hmux_host::local_discovery::{
    DiscoveredSession, DiscoveryKey, DiscoveryManifest, DiscoveryRoot,
};
use hmux_session_protocol::{
    FrameBody, Input, InputReceipt, InputReceiptState, Resize, ResizeReceipt, ResizeReceiptState,
    SHARED_TERMINAL_INPUT_CAPABILITY, ScreenSnapshot, ScreenSnapshotProfile,
};
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const ONE_SHOT_INPUT_TIMEOUT: Duration = Duration::from_secs(6);
const ONE_SHOT_RESIZE_TIMEOUT: Duration = Duration::from_secs(2);

/// An attachable local session whose authority-bearing manifest stays opaque.
///
/// "Local" means local **to the Host**, not to the client — see
/// [`LocalAttachRole`]. The session is discovered and attached through one Host
/// process on one machine; nothing here says the client shares that machine.
///
/// `Debug` deliberately renders only the redacted descriptor. Capability tokens
/// remain inside this crate, so IDE, CLI, and relay adapters can share the same
/// transport without copying discovery secrets into their own data models.
#[derive(Clone)]
pub struct LocalSession {
    descriptor: SessionDescriptor,
    manifest_refresh: Option<LocalManifestRefresh>,
    manifest: DiscoveryManifest,
}

#[derive(Clone)]
struct LocalManifestRefresh {
    discovery_root: PathBuf,
    key: DiscoveryKey,
}

impl fmt::Debug for LocalSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalSession")
            .field("descriptor", &self.descriptor)
            .finish_non_exhaustive()
    }
}

impl LocalSession {
    pub fn from_manifest(manifest: DiscoveryManifest) -> Result<Self, ClientError> {
        let lifetime = &manifest.common().lifetime;
        let key = hmux_host::local_discovery::DiscoveryKey::new(
            &lifetime.workspace_id,
            &lifetime.session_id,
            &lifetime.runner_instance,
            lifetime.channel_epoch,
        )
        .map_err(|error| {
            ClientError::transport(
                "hmux_manifest_identity_invalid",
                format!("Hmux manifest has an invalid discovery identity: {error}"),
            )
        })?;
        Ok(Self::from_discovered(DiscoveredSession {
            key,
            manifest,
            discovery_path: std::path::PathBuf::new(),
        }))
    }

    #[must_use]
    pub fn from_discovered(discovered: DiscoveredSession) -> Self {
        let manifest_refresh = LocalManifestRefresh::from_discovered(&discovered);
        Self {
            descriptor: SessionDescriptor::from(discovered.clone()),
            manifest_refresh,
            manifest: discovered.manifest,
        }
    }

    #[must_use]
    pub fn descriptor(&self) -> &SessionDescriptor {
        &self.descriptor
    }

    /// Non-secret create identity recorded in the exact Host manifest for a
    /// managed or recovery-created standalone session. Product adapters may
    /// associate resources with this creation; attach capabilities remain opaque.
    #[must_use]
    pub fn create_idempotency_key(&self) -> Option<&str> {
        self.manifest
            .common()
            .claim_linkage
            .kickoff_action_id
            .as_deref()
    }

    /// The catalog location of this observation, absent for a manifest-only
    /// handle. This is not permission to mutate a discovery root or generation.
    #[cfg(feature = "local-runtime")]
    #[must_use]
    pub fn discovery_root(&self) -> Option<&std::path::Path> {
        self.manifest_refresh
            .as_ref()
            .map(|refresh| refresh.discovery_root.as_path())
    }

    // Both of these hand out authority the *local* manifest carries: the
    // exact generation a stale-entry cleanup must match, and the capability
    // token a managed stop authenticates against. Their only callers are
    // local-runtime ones, and nothing off this machine can act on either.
    #[cfg(feature = "local-runtime")]
    pub(crate) fn manifest_generation(&self) -> ManifestGeneration {
        self.manifest.generation()
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn matches_capability_token(&self, candidate: &str) -> bool {
        match &self.manifest {
            DiscoveryManifest::Ready(manifest) => manifest.capability_token == candidate,
            DiscoveryManifest::Exited(manifest) => manifest.capability_token == candidate,
            DiscoveryManifest::Starting(_) => false,
        }
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn capability_token(&self) -> Option<&str> {
        match &self.manifest {
            DiscoveryManifest::Ready(manifest) => Some(&manifest.capability_token),
            DiscoveryManifest::Exited(manifest) => Some(&manifest.capability_token),
            DiscoveryManifest::Starting(_) => None,
        }
    }

    #[cfg(feature = "local-runtime")]
    pub(crate) fn manifest(&self) -> &DiscoveryManifest {
        &self.manifest
    }

    pub fn connect(
        &self,
        role: LocalAttachRole,
        authorization_proof_reference: Option<String>,
    ) -> Result<LocalConnection, ClientError> {
        self.connect_with_options(ConnectionOptions::new(role, authorization_proof_reference))
    }

    /// Select the strongest writable role supported by this Host.
    ///
    /// Current Hosts allow multiple shared writers. Hosts created before that
    /// capability existed remain writable through their exclusive controller
    /// role, so rolling upgrades do not strand their PTYs.
    #[must_use]
    pub fn writable_attach_role(&self) -> LocalAttachRole {
        if self
            .descriptor
            .capabilities
            .iter()
            .any(|capability| capability == SHARED_TERMINAL_INPUT_CAPABILITY)
        {
            LocalAttachRole::SharedWriter
        } else {
            LocalAttachRole::Controller
        }
    }

    /// Attach with the full option set, including a reconnect cursor.
    ///
    /// Public because resume has no other door: [`Self::connect`] cannot carry a
    /// cursor, and a caller recovering from a drop is exactly the caller that
    /// must both offer one and inspect
    /// [`LocalConnection::attach_replay`](crate::LocalConnection::attach_replay).
    pub fn connect_with_options(
        &self,
        mut options: ConnectionOptions,
    ) -> Result<LocalConnection, ClientError> {
        // Resolve one absolute budget before cloning. A lifecycle refresh must
        // not reset a relative timeout and turn one bounded attach into two.
        options.begin_handshake();
        let retry_options = options.clone();
        match LocalConnection::connect(&self.manifest, options) {
            Err(error)
                if error.is_manifest_process_mismatch()
                    && matches!(self.manifest, DiscoveryManifest::Ready(_)) =>
            {
                let Some(refresh) = &self.manifest_refresh else {
                    return Err(error);
                };
                let refreshed = refresh.read()?;
                if !is_same_generation_exit(&self.manifest, &refreshed) {
                    return Err(error);
                }
                LocalConnection::connect(&refreshed, retry_options)
            }
            result => result,
        }
    }

    pub fn read_screen(
        &self,
        authorization_proof_reference: Option<String>,
    ) -> Result<ScreenSnapshot, ClientError> {
        let mut connection =
            self.connect(LocalAttachRole::Observer, authorization_proof_reference)?;
        let snapshot = connection.require_initial_snapshot()?.clone();
        let _ = connection.detach("screen_read_complete");
        Ok(snapshot)
    }

    pub fn send_input(&self, bytes: Vec<u8>) -> Result<InputReceipt, ClientError> {
        if bytes.is_empty() {
            return Err(ClientError::transport(
                "hmux_input_empty",
                "Hmux input must not be empty",
            ));
        }
        let deadline = Instant::now() + ONE_SHOT_INPUT_TIMEOUT;
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(self.writable_attach_role(), None)
                .with_initial_snapshot_profile(Some(ScreenSnapshotProfile::ViewportOnly))
                .with_handshake_deadline(deadline),
        )?;
        let request_id = next_request_id("external_input");
        connection.writer().send_before(
            FrameBody::Input(Input {
                request_id: request_id.clone(),
                controller_generation: connection.hello_ack().controller_generation,
                bytes,
            }),
            deadline,
        )?;
        loop {
            match connection.read_body_before(deadline)? {
                FrameBody::InputReceipt(receipt) if receipt.request_id == request_id => {
                    if receipt.state != InputReceiptState::WrittenToPty {
                        return Err(ClientError::transport(
                            "hmux_input_refused",
                            format!(
                                "Hmux input was {:?} ({:?}{})",
                                receipt.state,
                                receipt.reason,
                                receipt
                                    .detail
                                    .as_deref()
                                    .map(|detail| format!(", {detail}"))
                                    .unwrap_or_default()
                            ),
                        ));
                    }
                    let _ = connection.detach("send_input_complete");
                    return Ok(receipt);
                }
                FrameBody::InputReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_input_receipt_uncorrelated",
                        "Hmux Host returned an input receipt for another request",
                    ));
                }
                FrameBody::OutputDelta(_) | FrameBody::ScreenSnapshot(_) => {}
                FrameBody::Exit(_) => {
                    return Err(ClientError::transport(
                        "hmux_session_exited",
                        "Hmux session exited before input was written",
                    ));
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                _ => {}
            }
        }
    }

    /// Apply terminal geometry through the same shared-writer contract used by
    /// the standalone CLI attach path. The receipt is not considered complete
    /// until the Host confirms that the provider PTY accepted the dimensions.
    pub fn send_resize(&self, rows: u16, columns: u16) -> Result<ResizeReceipt, ClientError> {
        if rows == 0 || columns == 0 {
            return Err(ClientError::transport(
                "hmux_resize_invalid",
                "Hmux terminal dimensions must be non-zero",
            ));
        }
        let deadline = Instant::now() + ONE_SHOT_RESIZE_TIMEOUT;
        let mut connection = self.connect_with_options(
            ConnectionOptions::new(self.writable_attach_role(), None)
                .with_initial_snapshot_profile(Some(ScreenSnapshotProfile::ViewportOnly))
                .with_handshake_deadline(deadline),
        )?;
        let request_id = next_request_id("external_resize");
        connection.writer().send_before(
            FrameBody::Resize(Resize {
                request_id: request_id.clone(),
                controller_generation: connection.hello_ack().controller_generation,
                rows,
                columns,
            }),
            deadline,
        )?;
        loop {
            match connection.read_body_before(deadline)? {
                FrameBody::ResizeReceipt(receipt) if receipt.request_id == request_id => {
                    match receipt.state {
                        ResizeReceiptState::Accepted => continue,
                        ResizeReceiptState::AppliedToTerminal => {
                            let _ = connection.detach("send_resize_complete");
                            return Ok(receipt);
                        }
                        ResizeReceiptState::Refused
                        | ResizeReceiptState::Revoked
                        | ResizeReceiptState::Failed => {
                            return Err(ClientError::transport(
                                "hmux_resize_refused",
                                format!(
                                    "Hmux resize was {:?} ({:?})",
                                    receipt.state, receipt.reason
                                ),
                            ));
                        }
                    }
                }
                FrameBody::ResizeReceipt(_) => {
                    return Err(ClientError::transport(
                        "hmux_resize_receipt_uncorrelated",
                        "Hmux Host returned a resize receipt for another request",
                    ));
                }
                FrameBody::OutputDelta(_) | FrameBody::ScreenSnapshot(_) => {}
                FrameBody::Exit(_) => {
                    return Err(ClientError::transport(
                        "hmux_session_exited",
                        "Hmux session exited before resize was applied",
                    ));
                }
                FrameBody::Error(error) => return Err(host_refused(error)),
                _ => {}
            }
        }
    }
}

impl LocalManifestRefresh {
    fn from_discovered(discovered: &DiscoveredSession) -> Option<Self> {
        let discovery_root = discovered.discovery_path.parent()?.parent()?.to_path_buf();
        if discovery_root.join(discovered.key.relative_path()) != discovered.discovery_path {
            return None;
        }
        Some(Self {
            discovery_root,
            key: discovered.key.clone(),
        })
    }

    fn read(&self) -> Result<DiscoveryManifest, ClientError> {
        Ok(DiscoveryRoot::open(&self.discovery_root)?
            .open_session(self.key.clone())?
            .read_manifest()?)
    }
}

fn is_same_generation_exit(previous: &DiscoveryManifest, refreshed: &DiscoveryManifest) -> bool {
    matches!(
        (previous, refreshed),
        (DiscoveryManifest::Ready(_), DiscoveryManifest::Exited(_))
    ) && previous.generation() == refreshed.generation()
}

fn next_request_id(prefix: &str) -> String {
    static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    format!(
        "{prefix}_{}_{}",
        std::process::id(),
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_host::local_discovery::{
        ClaimLinkage, ExitedManifest, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind,
        ManifestCommon, ReadyManifest, SessionClass,
    };
    use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
    use hmux_session_protocol::{
        Exit, PROTOCOL_V1, ProcessProof, RuntimeContext, SessionFence, VersionRange,
    };

    fn discovered(capability_token: &str) -> DiscoveredSession {
        let common = ManifestCommon {
            launch_program: None,
            schema_version: 1,
            host_build_version: "test".into(),
            supported_protocol: VersionRange {
                minimum: PROTOCOL_V1,
                maximum: PROTOCOL_V1,
            },
            capabilities: vec!["screen_snapshot".into()],
            lifetime: HostLifetimeIdentity {
                workspace_id: "workspace".into(),
                session_id: "standalone_abc".into(),
                runner_principal: "standalone".into(),
                runner_instance: "standalone".into(),
                channel_epoch: 1,
            },
            host_instance_id: "host".into(),
            provider_id: "shell".into(),
            runtime_context: RuntimeContext::default(),
            claim_linkage: ClaimLinkage {
                claim_id: None,
                kickoff_action_id: None,
            },
            host_process: ProcessProof {
                process_id: 10,
                start_marker: "host-start".into(),
            },
            created_unix_ms: 1,
            session_class: SessionClass::Standalone,
            session_name: Some("dev".into()),
            retirement_policy: None,
        };
        DiscoveredSession {
            key: hmux_host::local_discovery::DiscoveryKey::new(
                "workspace",
                "standalone_abc",
                "standalone",
                1,
            )
            .unwrap(),
            manifest: DiscoveryManifest::Ready(ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: 11,
                    start_marker: "provider-start".into(),
                },
                terminal_epoch: "terminal".into(),
                ready_output_seq: 1,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: "/tmp/hmux-test.sock".into(),
                },
                capability_token: capability_token.into(),
                ready_unix_ms: 2,
            }),
            discovery_path: "/tmp/discovery".into(),
        }
    }

    fn exited_after(ready: ReadyManifest) -> DiscoveryManifest {
        let fence = SessionFence {
            workspace_id: ready.common.lifetime.workspace_id.clone(),
            session_id: ready.common.lifetime.session_id.clone(),
            runner_principal: ready.common.lifetime.runner_principal.clone(),
            runner_instance: ready.common.lifetime.runner_instance.clone(),
            channel_epoch: ready.common.lifetime.channel_epoch,
            host_instance_id: ready.common.host_instance_id.clone(),
            terminal_epoch: ready.terminal_epoch.clone(),
        };
        DiscoveryManifest::Exited(ExitedManifest {
            common: ready.common,
            tombstone: Box::new(ExitTombstone {
                provider_conversation_identity: None,
                fence,
                provider_process: ready.provider_process,
                exit: Exit {
                    final_output_seq: ready.ready_output_seq,
                    exit_code: Some(0),
                    platform_status: None,
                    reason: "provider_exit".into(),
                },
                exit_kind: ProviderExitKind::Normal,
                created_unix_ms: 3,
                failure: None,
            }),
            endpoint: ready.endpoint,
            capability_token: ready.capability_token,
            exited_unix_ms: 3,
        })
    }

    #[test]
    fn debug_never_exposes_capability_token() {
        let session = LocalSession::from_discovered(discovered("top-secret-token"));
        let rendered = format!("{session:?}");
        assert!(rendered.contains("standalone_abc"));
        assert!(!rendered.contains("top-secret-token"));
    }

    #[test]
    fn attach_retry_accepts_only_the_same_host_generation_exiting() {
        let ready = discovered("top-secret-token").manifest;
        let DiscoveryManifest::Ready(ready_manifest) = ready.clone() else {
            panic!("fixture must be ready");
        };
        let exited = exited_after(ready_manifest);

        assert!(is_same_generation_exit(&ready, &exited));

        let mut replacement = exited.clone();
        let DiscoveryManifest::Exited(replacement_manifest) = &mut replacement else {
            panic!("fixture must be exited");
        };
        replacement_manifest.common.host_process.start_marker = "replacement".into();
        assert!(!is_same_generation_exit(&ready, &replacement));
    }

    #[test]
    fn writable_attach_falls_back_to_the_legacy_exclusive_controller() {
        let mut session = LocalSession::from_discovered(discovered("top-secret-token"));
        assert_eq!(session.writable_attach_role(), LocalAttachRole::Controller);

        session
            .descriptor
            .capabilities
            .push(SHARED_TERMINAL_INPUT_CAPABILITY.into());
        assert_eq!(
            session.writable_attach_role(),
            LocalAttachRole::SharedWriter
        );
    }

    #[test]
    fn resize_rejects_zero_dimensions_before_connecting() {
        let session = LocalSession::from_discovered(discovered("top-secret-token"));

        assert_eq!(
            session.send_resize(0, 80).unwrap_err().code(),
            "hmux_resize_invalid"
        );
        assert_eq!(
            session.send_resize(24, 0).unwrap_err().code(),
            "hmux_resize_invalid"
        );
    }
}
