use super::{
    AttachedSessionObserver, AuthorizationProofReference, LocalSessionObserver,
    ObserverAttachOptions, ObserverAttachment, ObserverEvent, ObserverInterrupt,
    ObserverMutationHandle, project_session_at_snapshot,
};
use crate::connection::{ConnectionOptions, LocalAttachRole};
use crate::{ClientError, LocalSession, LocalSessionCatalog, SessionSelector};
use hmux_session_protocol::{
    AGENT_IDENTITY_PROJECTION_CAPABILITY, AGENT_RUNTIME_STATE_CAPABILITY,
    EXECUTION_LOCATION_PROJECTION_CAPABILITY, ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
    PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY, PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
    SCREEN_SNAPSHOT_PROFILE_CAPABILITY, SESSION_RETIREMENT_ADMIN_CAPABILITY,
    WORKING_DIRECTORY_PROJECTION_CAPABILITY,
};

impl LocalSessionObserver {
    pub fn connect(
        catalog: &LocalSessionCatalog,
        selector: &SessionSelector,
        options: ObserverAttachOptions,
    ) -> Result<Self, ClientError> {
        let session = catalog.open(selector)?;
        Self::connect_resolved(session, options)
    }

    /// Attach an already resolved exact session without reopening its logical
    /// path and discarding the selected Host generation fence.
    pub fn connect_resolved(
        session: LocalSession,
        options: ObserverAttachOptions,
    ) -> Result<Self, ClientError> {
        Self::connect_session(session, options, &[])
    }

    /// Request the Host's administrative observation posture. Supporting
    /// standalone Hosts exclude this connection from presentation history and
    /// leave pending retirement intact. Normal pane attachments never opt in.
    pub(crate) fn inspect(
        catalog: &LocalSessionCatalog,
        selector: &SessionSelector,
        options: ObserverAttachOptions,
    ) -> Result<Self, ClientError> {
        Self::connect_session(
            catalog.open(selector)?,
            options,
            &[SESSION_RETIREMENT_ADMIN_CAPABILITY],
        )
    }

    #[must_use]
    pub fn attachment(&self) -> &ObserverAttachment {
        &self.attachment
    }

    pub fn read_event(&mut self) -> Result<Option<ObserverEvent>, ClientError> {
        self.attached.read_event()
    }

    #[must_use]
    pub fn mutation_handle(&self) -> ObserverMutationHandle {
        self.attached.mutation_handle()
    }

    pub fn detach(self) -> Result<(), ClientError> {
        self.attached.detach()
    }

    pub fn interrupt_handle(&self) -> Result<ObserverInterrupt, ClientError> {
        self.attached.interrupt_handle()
    }

    fn connect_session(
        session: LocalSession,
        options: ObserverAttachOptions,
        additional_capabilities: &[&'static str],
    ) -> Result<Self, ClientError> {
        let mut capabilities = vec![
            WORKING_DIRECTORY_PROJECTION_CAPABILITY,
            EXECUTION_LOCATION_PROJECTION_CAPABILITY,
            AGENT_IDENTITY_PROJECTION_CAPABILITY,
            AGENT_RUNTIME_STATE_CAPABILITY,
            PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            PROVIDER_CONVERSATION_CONTINUATION_CAPABILITY,
            ORDERED_SNAPSHOT_REFRESH_CAPABILITY,
            SCREEN_SNAPSHOT_PROFILE_CAPABILITY,
        ];
        capabilities.extend_from_slice(additional_capabilities);
        let mut connection_options = ConnectionOptions::new(
            LocalAttachRole::Observer,
            options
                .authorization_proof_reference
                .map(AuthorizationProofReference::into_inner),
        )
        .with_optional_capabilities(&capabilities)
        .with_initial_snapshot_profile(options.initial_snapshot_profile);
        if let Some(timeout) = options.handshake_timeout {
            connection_options = connection_options.with_handshake_timeout(timeout);
        }
        if let Some(timeout) = options.handshake_completion_timeout {
            connection_options = connection_options.with_handshake_completion_timeout(timeout);
        }
        if let Some(deadline) = options.handshake_deadline {
            connection_options = connection_options.with_handshake_deadline(deadline);
        }
        let connection = session.connect_with_options(connection_options)?;
        let attached = AttachedSessionObserver::from_connection(connection)?;
        let observed_session = project_session_at_snapshot(
            session.descriptor(),
            &attached.attachment.initial_snapshot,
        );
        let attachment = ObserverAttachment {
            session: observed_session,
            negotiation: attached.attachment.negotiation.clone(),
            initial_snapshot: attached.attachment.initial_snapshot.clone(),
        };

        Ok(Self {
            attachment,
            attached,
        })
    }
}
