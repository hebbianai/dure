use super::structured_terminal::{
    StructuredTerminalAttachFailure, StructuredTerminalAttachReceipt, StructuredTerminalReservation,
};
use super::{retirement::PaneAttachmentIdentity, validate_identifier, HmuxManager};
use hmux_client::TerminalSurfaceAccess;
use hmux_ssh_transport::{
    abandon_unpresented_creation_over_ssh, depart_gracefully_over_ssh, RemoteCatalogSession,
    RemoteSessionClass, RemoteSessionLifecycle, RemoteUnpresentedCreationAbandonRequest,
    SessionFence, SessionRetirementReceipt, SshExecConfig,
};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

const MAX_REMOTE_PANE_AUTHORITIES: usize = 1_024;
const MAX_PENDING_REMOTE_CREATIONS: usize = 1_024;
const REMOTE_ABANDON_TIMEOUT: Duration = Duration::from_secs(30);
static REMOTE_ABANDON_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Serializes lifecycle operations per pane owner.
///
/// A pane's pending creation, attach and departure must not interleave with
/// each other, and the attach holds its turn across the SSH connect so the
/// Host acknowledgement lands on the same authority that was prepared. That
/// ordering is a property of one pane: two panes attaching to two boxes (or
/// the same box) share nothing here, so they no longer wait for each other's
/// handshakes.
#[derive(Default)]
pub(super) struct RemotePaneOperations {
    busy: Mutex<HashSet<String>>,
    released: Condvar,
}

impl RemotePaneOperations {
    pub(super) fn acquire(&self, owner_id: &str) -> Result<RemotePaneOperation<'_>, String> {
        let poisoned = || "remote Hmux pane operations poisoned".to_string();
        let mut busy = self.busy.lock().map_err(|_| poisoned())?;
        while busy.contains(owner_id) {
            busy = self.released.wait(busy).map_err(|_| poisoned())?;
        }
        busy.insert(owner_id.to_string());
        Ok(RemotePaneOperation {
            operations: self,
            owner_id: owner_id.to_string(),
        })
    }
}

pub(super) struct RemotePaneOperation<'a> {
    operations: &'a RemotePaneOperations,
    owner_id: String,
}

impl Drop for RemotePaneOperation<'_> {
    fn drop(&mut self) {
        let mut busy = match self.operations.busy.lock() {
            Ok(busy) => busy,
            Err(poisoned) => poisoned.into_inner(),
        };
        busy.remove(&self.owner_id);
        drop(busy);
        self.operations.released.notify_all();
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RemotePaneAuthority {
    owner_id: String,
    host_id: String,
    session_class: RemoteSessionClass,
    fence: SessionFence,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct RemotePendingCreationAuthority {
    authority: RemotePaneAuthority,
    launch_owner_proof: String,
}

impl std::fmt::Debug for RemotePendingCreationAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemotePendingCreationAuthority")
            .field("authority", &self.authority)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

#[derive(Debug)]
enum RemotePaneDeparture {
    Pending(RemotePendingCreationAuthority),
    Attached(RemotePaneAuthority),
}

impl RemotePaneAuthority {
    fn matches(
        &self,
        owner_id: &str,
        host_id: &str,
        session_class: RemoteSessionClass,
        fence: &SessionFence,
    ) -> bool {
        self.owner_id == owner_id
            && self.host_id == host_id
            && self.session_class == session_class
            && self.fence == *fence
    }
}

impl HmuxManager {
    pub fn register_pending_remote_pane_creation(
        &self,
        owner_id: String,
        host_id: String,
        session: RemoteCatalogSession,
        launch_owner_proof: String,
    ) -> Result<(), String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("remote host id", &host_id)?;
        validate_identifier("remote launch owner proof", &launch_owner_proof)?;
        validate_remote_session(&session)?;
        if session.session_class != RemoteSessionClass::Standalone {
            return Err(
                "remote_hmux_pending_creation_managed: managed sessions have no creation proof"
                    .into(),
            );
        }
        let pending = RemotePendingCreationAuthority {
            authority: RemotePaneAuthority {
                owner_id: owner_id.clone(),
                host_id,
                session_class: session.session_class,
                fence: remote_fence(&session)?,
            },
            launch_owner_proof,
        };
        let _operation = self.remote_pane_operations.acquire(&owner_id)?;
        let mut pending_creations = self
            .pending_remote_creations
            .lock()
            .map_err(|_| "remote Hmux pending creation registry poisoned".to_string())?;
        if let Some(existing) = pending_creations.get(&owner_id) {
            return if existing == &pending {
                Ok(())
            } else {
                Err(
                    "remote_hmux_pending_creation_conflict: pane already owns another pending creation"
                        .into(),
                )
            };
        }
        if self
            .remote_pane_authorities
            .lock()
            .map_err(|_| "remote Hmux pane authority registry poisoned".to_string())?
            .contains_key(&owner_id)
        {
            return Err(
                "remote_hmux_pending_creation_conflict: pane already has an attached remote generation"
                    .into(),
            );
        }
        if pending_creations.len() >= MAX_PENDING_REMOTE_CREATIONS {
            return Err("remote Hmux pending creation capacity is exhausted".into());
        }
        pending_creations.insert(owner_id, pending);
        Ok(())
    }

    pub(crate) fn attach_remote_pane(
        &self,
        reservation: StructuredTerminalReservation,
        host_id: String,
        session: RemoteCatalogSession,
        ssh: SshExecConfig,
        access: TerminalSurfaceAccess,
    ) -> Result<StructuredTerminalAttachReceipt, StructuredTerminalAttachFailure> {
        let prepared = (|| {
            validate_identifier("pane owner id", reservation.surface_id())?;
            validate_identifier("remote host id", &host_id)?;
            validate_remote_session(&session)?;
            let authority = RemotePaneAuthority {
                owner_id: reservation.surface_id().to_string(),
                host_id,
                session_class: session.session_class,
                fence: remote_fence(&session)?,
            };
            Ok::<_, String>(authority)
        })();
        let authority = match prepared {
            Ok(authority) => authority,
            Err(error) => {
                self.cancel_structured_terminal_reservation(&reservation);
                return Err(error.into());
            }
        };
        let _operation = match self.remote_pane_operations.acquire(&authority.owner_id) {
            Ok(operation) => operation,
            Err(error) => {
                self.cancel_structured_terminal_reservation(&reservation);
                return Err(error.into());
            }
        };
        if let Err(error) = self.prepare_remote_pane_attach(&authority) {
            self.cancel_structured_terminal_reservation(&reservation);
            return Err(error.into());
        }
        let fence = authority.fence.clone();
        self.attach_remote_structured_terminal(reservation, fence, ssh, access, || {
            self.record_remote_pane_host_attach(&authority)
        })
    }

    pub fn depart_remote_pane_gracefully(
        &self,
        owner_id: String,
        host_id: String,
        session: RemoteCatalogSession,
        ssh: SshExecConfig,
    ) -> Result<SessionRetirementReceipt, String> {
        validate_identifier("pane owner id", &owner_id)?;
        validate_identifier("remote host id", &host_id)?;
        validate_remote_session(&session)?;
        let expected_fence = remote_fence(&session)?;
        let _operation = self.remote_pane_operations.acquire(&owner_id)?;
        let departure = self.take_remote_pane_departure_locked(
            &owner_id,
            &host_id,
            session.session_class,
            &expected_fence,
        )?;
        let target = PaneAttachmentIdentity::new(
            owner_id.clone(),
            expected_fence.session_id.clone(),
            expected_fence.workspace_id.clone(),
        );
        let attachments = match self.take_structured_pane_attachments(&target) {
            Ok(attachments) => attachments,
            Err(error) => {
                self.restore_remote_pane_departure(departure);
                return Err(error);
            }
        };
        for attachment in attachments {
            if let Err(error) = attachment.stop_confirmed() {
                self.restore_remote_pane_departure(departure);
                return Err(format!("remote_hmux_pane_detach_unconfirmed: {error}"));
            }
        }

        match departure {
            RemotePaneDeparture::Pending(pending) => {
                let request = RemoteUnpresentedCreationAbandonRequest {
                    request_id: next_remote_abandon_request_id(),
                    session_id: expected_fence.session_id,
                    workspace_id: expected_fence.workspace_id,
                    launch_owner_proof: pending.launch_owner_proof.clone(),
                };
                match abandon_unpresented_creation_over_ssh(ssh, request, REMOTE_ABANDON_TIMEOUT) {
                    Ok(receipt) => Ok(receipt.receipt),
                    Err(error) => {
                        self.restore_remote_pane_departure(RemotePaneDeparture::Pending(pending));
                        Err(format!("{}: {error}", error.code()))
                    }
                }
            }
            RemotePaneDeparture::Attached(authority) => {
                if authority.session_class != RemoteSessionClass::Standalone {
                    return Err(
                        "remote_hmux_retirement_managed: managed remote sessions are preserve-only"
                            .into(),
                    );
                }
                match depart_gracefully_over_ssh(ssh, expected_fence) {
                    Ok(receipt) => Ok(receipt),
                    Err(error) => {
                        self.restore_remote_pane_departure(RemotePaneDeparture::Attached(
                            authority,
                        ));
                        Err(format!("{}: {error}", error.code()))
                    }
                }
            }
        }
    }

    fn prepare_remote_pane_attach(&self, authority: &RemotePaneAuthority) -> Result<(), String> {
        if self
            .pending_remote_creations
            .lock()
            .map_err(|_| "remote Hmux pending creation registry poisoned".to_string())?
            .get(&authority.owner_id)
            .is_some_and(|candidate| candidate.authority != *authority)
        {
            return Err(
                "remote_hmux_pane_identity_changed: pending creation belongs to another remote generation"
                    .into(),
            );
        }
        let authorities = self
            .remote_pane_authorities
            .lock()
            .map_err(|_| "remote Hmux pane authority registry poisoned".to_string())?;
        if !authorities.contains_key(&authority.owner_id)
            && authorities.len() >= MAX_REMOTE_PANE_AUTHORITIES
        {
            return Err("remote Hmux pane authority capacity is exhausted".into());
        }
        Ok(())
    }

    fn record_remote_pane_host_attach(
        &self,
        authority: &RemotePaneAuthority,
    ) -> Result<(), String> {
        {
            let mut pending = self
                .pending_remote_creations
                .lock()
                .map_err(|_| "remote Hmux pending creation registry poisoned".to_string())?;
            if pending
                .get(&authority.owner_id)
                .is_some_and(|candidate| candidate.authority == *authority)
            {
                pending.remove(&authority.owner_id);
            }
        }
        let mut authorities = self
            .remote_pane_authorities
            .lock()
            .map_err(|_| "remote Hmux pane authority registry poisoned".to_string())?;
        if !authorities.contains_key(&authority.owner_id)
            && authorities.len() >= MAX_REMOTE_PANE_AUTHORITIES
        {
            // The Host acknowledgement burns any exact launch proof even if
            // an impossible local capacity race is injected in a test.
            return Err("remote Hmux pane authority capacity is exhausted".into());
        }
        authorities.insert(authority.owner_id.clone(), authority.clone());
        Ok(())
    }

    fn take_remote_pane_departure_locked(
        &self,
        owner_id: &str,
        host_id: &str,
        session_class: RemoteSessionClass,
        expected_fence: &SessionFence,
    ) -> Result<RemotePaneDeparture, String> {
        let mut pending = self
            .pending_remote_creations
            .lock()
            .map_err(|_| "remote Hmux pending creation registry poisoned".to_string())?;
        if let Some(candidate) = pending.get(owner_id) {
            if candidate
                .authority
                .matches(owner_id, host_id, session_class, expected_fence)
            {
                return Ok(RemotePaneDeparture::Pending(
                    pending
                        .remove(owner_id)
                        .expect("the exact pending creation was just observed"),
                ));
            }
            return Err(
                "remote_hmux_pane_identity_changed: pending creation belongs to another remote generation"
                    .into(),
            );
        }
        drop(pending);

        let mut authorities = self
            .remote_pane_authorities
            .lock()
            .map_err(|_| "remote Hmux pane authority registry poisoned".to_string())?;
        match authorities.get(owner_id) {
            Some(authority)
                if authority.matches(owner_id, host_id, session_class, expected_fence) =>
            {
                Ok(RemotePaneDeparture::Attached(
                    authorities
                        .remove(owner_id)
                        .expect("the exact pane authority was just observed"),
                ))
            }
            Some(_) => Err(
                "remote_hmux_pane_identity_changed: attached pane belongs to another remote generation"
                    .into(),
            ),
            _ => Err(
                "remote_hmux_pane_not_attached: exact remote pane is stale or closed".into(),
            ),
        }
    }

    fn restore_remote_pane_departure(&self, departure: RemotePaneDeparture) {
        match departure {
            RemotePaneDeparture::Pending(pending) => {
                if let Ok(mut creations) = self.pending_remote_creations.lock() {
                    creations
                        .entry(pending.authority.owner_id.clone())
                        .or_insert(pending);
                }
            }
            RemotePaneDeparture::Attached(authority) => {
                if let Ok(mut authorities) = self.remote_pane_authorities.lock() {
                    authorities
                        .entry(authority.owner_id.clone())
                        .or_insert(authority);
                }
            }
        }
    }
}

fn next_remote_abandon_request_id() -> String {
    format!(
        "remote_pane_close_{}_{}",
        std::process::id(),
        REMOTE_ABANDON_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn validate_remote_session(session: &RemoteCatalogSession) -> Result<(), String> {
    if session.lifecycle != RemoteSessionLifecycle::Ready {
        return Err("remote_hmux_session_exited: only a ready remote session can attach".into());
    }
    validate_identifier("session id", &session.session_id)?;
    validate_identifier("workspace id", &session.workspace_id)?;
    validate_identifier("runner principal", &session.runner_principal)?;
    validate_identifier("runner instance", &session.runner_instance)?;
    validate_identifier("host instance id", &session.host_instance_id)?;
    validate_identifier("terminal epoch", &session.terminal_epoch)
}

fn remote_fence(session: &RemoteCatalogSession) -> Result<SessionFence, String> {
    if session.channel_epoch.is_empty()
        || !session
            .channel_epoch
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        || (session.channel_epoch.len() > 1 && session.channel_epoch.starts_with('0'))
    {
        return Err(
            "remote_hmux_session_fence_invalid: channel epoch is not a canonical u64".to_string(),
        );
    }
    let channel_epoch = session.channel_epoch.parse::<u64>().map_err(|_| {
        "remote_hmux_session_fence_invalid: channel epoch is not a canonical u64".to_string()
    })?;
    Ok(SessionFence {
        workspace_id: session.workspace_id.clone(),
        session_id: session.session_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch,
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        remote_fence, validate_remote_session, RemotePaneAuthority, RemotePaneDeparture,
        RemotePaneOperations, RemotePendingCreationAuthority, MAX_REMOTE_PANE_AUTHORITIES,
    };
    use crate::hmux::HmuxManager;
    use std::sync::mpsc;
    use std::time::Duration;

    use hmux_ssh_transport::{
        RemoteCatalogSession, RemoteProtocolVersion, RemoteSessionClass, RemoteSessionLifecycle,
        RemoteVersionRange,
    };

    /// Panes attach one at a time only against themselves: while one owner's
    /// attach is still inside its SSH handshake, another owner's attach must
    /// proceed, and a second operation on the same owner must wait its turn.
    #[test]
    fn pane_operations_serialize_per_owner_only() {
        let operations = std::sync::Arc::new(RemotePaneOperations::default());
        let held = operations.acquire("pane-a").unwrap();

        let other = operations.acquire("pane-b");
        assert!(other.is_ok(), "another pane's operation must not wait");
        drop(other);

        let (started, observe_start) = mpsc::channel();
        let (finished, observe_finish) = mpsc::channel();
        let waiting = std::sync::Arc::clone(&operations);
        let waiter = std::thread::spawn(move || {
            started.send(()).unwrap();
            let _turn = waiting.acquire("pane-a").unwrap();
            finished.send(()).unwrap();
        });
        observe_start.recv().unwrap();
        assert!(
            observe_finish
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "the same pane's second operation must wait for the first"
        );
        drop(held);
        observe_finish
            .recv_timeout(Duration::from_secs(5))
            .expect("the waiting operation proceeds once the first releases");
        waiter.join().unwrap();
    }

    fn session() -> RemoteCatalogSession {
        RemoteCatalogSession {
            session_id: "session-1".into(),
            session_name: Some("shell".into()),
            workspace_id: "workspace-1".into(),
            session_class: RemoteSessionClass::Standalone,
            lifecycle: RemoteSessionLifecycle::Ready,
            provider_id: "shell".into(),
            runner_principal: "standalone".into(),
            runner_instance: "standalone".into(),
            channel_epoch: "7".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            supported_protocol: RemoteVersionRange {
                minimum: RemoteProtocolVersion { major: 1, minor: 0 },
                maximum: RemoteProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["terminal_surface_v1".into()],
            retirement_policy: None,
            launch_program: Some("zsh".into()),
            host_liveness: Some(hmux_ssh_transport::RemoteHostLiveness::Live),
            gateway_build_id: Some("scripted-host".into()),
        }
    }

    fn authority(owner_id: &str, session: &RemoteCatalogSession) -> RemotePaneAuthority {
        RemotePaneAuthority {
            owner_id: owner_id.into(),
            host_id: "ssh-host".into(),
            session_class: session.session_class,
            fence: remote_fence(session).unwrap(),
        }
    }

    #[test]
    fn catalog_identity_becomes_the_exact_remote_fence() {
        let fence = remote_fence(&session()).unwrap();
        assert_eq!(fence.session_id, "session-1");
        assert_eq!(fence.workspace_id, "workspace-1");
        assert_eq!(fence.channel_epoch, 7);
        assert_eq!(fence.host_instance_id, "host-1");
        assert_eq!(fence.terminal_epoch, "terminal-1");
    }

    #[test]
    fn exited_or_malformed_remote_sessions_fail_before_dialing() {
        let mut exited = session();
        exited.lifecycle = RemoteSessionLifecycle::Exited;
        assert!(validate_remote_session(&exited)
            .unwrap_err()
            .starts_with("remote_hmux_session_exited:"));

        let mut malformed = session();
        malformed.channel_epoch = "07".into();
        assert!(remote_fence(&malformed)
            .unwrap_err()
            .starts_with("remote_hmux_session_fence_invalid:"));
    }

    #[test]
    fn departure_authority_rejects_a_replacement_remote_generation() {
        let original = session();
        let authority = authority("pane-owner", &original);
        let mut replacement = original.clone();
        replacement.host_instance_id = "host-2".into();
        replacement.terminal_epoch = "terminal-2".into();

        assert!(authority.matches(
            "pane-owner",
            "ssh-host",
            original.session_class,
            &remote_fence(&original).unwrap(),
        ));
        assert!(!authority.matches(
            "pane-owner",
            "ssh-host",
            replacement.session_class,
            &remote_fence(&replacement).unwrap(),
        ));
    }

    #[test]
    fn failed_first_pane_attach_leaves_exact_pending_authority_for_close() {
        let manager = HmuxManager::default();
        let session = session();
        manager
            .register_pending_remote_pane_creation(
                "pane-owner".into(),
                "ssh-host".into(),
                session.clone(),
                "launch-proof".into(),
            )
            .unwrap();

        let departure = manager
            .take_remote_pane_departure_locked(
                "pane-owner",
                "ssh-host",
                session.session_class,
                &remote_fence(&session).unwrap(),
            )
            .unwrap();
        let RemotePaneDeparture::Pending(pending) = departure else {
            panic!("close after a failed first attach must use pending creation authority");
        };
        assert_eq!(pending.launch_owner_proof, "launch-proof");
        assert!(manager.pending_remote_creations.lock().unwrap().is_empty());
    }

    #[test]
    fn pending_creation_debug_redacts_launch_owner_proof() {
        let pending = RemotePendingCreationAuthority {
            authority: authority("pane-owner", &session()),
            launch_owner_proof: "launch-proof-must-stay-secret".into(),
        };

        let debug = format!("{pending:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains("launch-proof-must-stay-secret"));
    }

    #[test]
    fn existing_session_host_attach_registers_departure_authority() {
        let manager = HmuxManager::default();
        let session = session();
        let authority = authority("pane-owner", &session);

        manager.record_remote_pane_host_attach(&authority).unwrap();
        let departure = manager
            .take_remote_pane_departure_locked(
                "pane-owner",
                "ssh-host",
                session.session_class,
                &remote_fence(&session).unwrap(),
            )
            .unwrap();

        assert!(matches!(departure, RemotePaneDeparture::Attached(_)));
    }

    #[test]
    fn first_host_attach_burns_only_its_exact_pending_proof() {
        let manager = HmuxManager::default();
        let original = session();
        manager
            .register_pending_remote_pane_creation(
                "pane-owner".into(),
                "ssh-host".into(),
                original.clone(),
                "launch-proof".into(),
            )
            .unwrap();
        let authority = authority("pane-owner", &original);

        manager.record_remote_pane_host_attach(&authority).unwrap();

        assert!(manager.pending_remote_creations.lock().unwrap().is_empty());
        assert_eq!(
            manager
                .remote_pane_authorities
                .lock()
                .unwrap()
                .get("pane-owner"),
            Some(&authority)
        );
    }

    #[test]
    fn replacement_host_attach_supersedes_one_pane_authority() {
        let manager = HmuxManager::default();
        let original = session();
        let original_authority = authority("pane-owner", &original);
        manager
            .record_remote_pane_host_attach(&original_authority)
            .unwrap();
        let mut replacement = original.clone();
        replacement.host_instance_id = "replacement-host".into();
        replacement.terminal_epoch = "replacement-terminal".into();
        let replacement_authority = authority("pane-owner", &replacement);

        manager
            .record_remote_pane_host_attach(&replacement_authority)
            .unwrap();

        let error = manager
            .take_remote_pane_departure_locked(
                "pane-owner",
                "ssh-host",
                original.session_class,
                &remote_fence(&original).unwrap(),
            )
            .unwrap_err();
        assert!(error.starts_with("remote_hmux_pane_identity_changed:"));
        assert_eq!(
            manager
                .remote_pane_authorities
                .lock()
                .unwrap()
                .get("pane-owner"),
            Some(&replacement_authority)
        );
    }

    #[test]
    fn stale_close_cannot_take_a_replacement_generation_pending_proof() {
        let manager = HmuxManager::default();
        let original = session();
        manager
            .register_pending_remote_pane_creation(
                "pane-owner".into(),
                "ssh-host".into(),
                original.clone(),
                "launch-proof".into(),
            )
            .unwrap();
        let mut replacement = original.clone();
        replacement.host_instance_id = "replacement-host".into();

        let error = manager
            .take_remote_pane_departure_locked(
                "pane-owner",
                "ssh-host",
                replacement.session_class,
                &remote_fence(&replacement).unwrap(),
            )
            .unwrap_err();

        assert!(error.starts_with("remote_hmux_pane_identity_changed:"));
        assert_eq!(manager.pending_remote_creations.lock().unwrap().len(), 1);
    }

    #[test]
    fn authority_capacity_is_reserved_before_host_attach() {
        let manager = HmuxManager::default();
        let session = session();
        let authority = authority("pane-owner", &session);
        {
            let mut authorities = manager.remote_pane_authorities.lock().unwrap();
            for index in 0..MAX_REMOTE_PANE_AUTHORITIES {
                let mut occupied = authority.clone();
                occupied.owner_id = format!("occupied-{index}");
                authorities.insert(occupied.owner_id.clone(), occupied);
            }
        }

        let error = manager.prepare_remote_pane_attach(&authority).unwrap_err();

        assert!(error.contains("capacity is exhausted"));
    }

    #[test]
    fn host_ack_never_restores_a_burned_launch_proof_on_capacity_fault() {
        let manager = HmuxManager::default();
        let session = session();
        manager
            .register_pending_remote_pane_creation(
                "pane-owner".into(),
                "ssh-host".into(),
                session.clone(),
                "launch-proof".into(),
            )
            .unwrap();
        let authority = authority("pane-owner", &session);
        {
            let mut authorities = manager.remote_pane_authorities.lock().unwrap();
            for index in 0..MAX_REMOTE_PANE_AUTHORITIES {
                let mut occupied = authority.clone();
                occupied.owner_id = format!("occupied-{index}");
                authorities.insert(occupied.owner_id.clone(), occupied);
            }
        }

        let error = manager
            .record_remote_pane_host_attach(&authority)
            .unwrap_err();

        assert!(error.contains("capacity is exhausted"));
        assert!(!manager
            .pending_remote_creations
            .lock()
            .unwrap()
            .contains_key("pane-owner"));
    }
}
