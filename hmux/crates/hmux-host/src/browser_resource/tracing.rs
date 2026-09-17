//! One physical browser owns scope admission and the shared trace/profiler interval.
use super::*;
use hmux_session_protocol::browser_tracing::*;

pub struct BrowserTracingPermit {
    resource: BrowserResourceIdentity,
    origin: BrowserPageIdentity,
    instance: BrowserInstanceId,
    target: BrowserTargetId,
    operation: BrowserOperationId,
}

/// One resource command for an exact retained interval, with no page input grant.
pub struct BrowserTracingStopPermit {
    resource: BrowserResourceIdentity,
    operation: BrowserOperationId,
    sequence: NonZeroU64,
    lease: BrowserTracingLease,
}

impl BrowserTracingStopPermit {
    pub fn lease(&self) -> &BrowserTracingLease {
        &self.lease
    }
}

impl BrowserTracingPermit {
    pub fn target(&self) -> &BrowserTargetId {
        &self.target
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrowserTracingLease {
    instance: BrowserInstanceId,
    generation: NonZeroU64,
}

pub struct BrowserTracingHost {
    instance: BrowserInstanceId,
    // Native browser events can retain prior resources' URLs after they close.
    // This fact never becomes exclusive again by counting current leases.
    task: Option<BrowserResourceIdentity>,
    generation: NonZeroU64,
    active: Option<BrowserTracingInterval>,
}

impl BrowserResourceHost {
    pub fn prepare_tracing(
        &self,
        action: &BrowserActionPermit,
    ) -> Result<BrowserTracingPermit, BrowserAdmissionError> {
        Ok(BrowserTracingPermit {
            resource: self.identity.clone(),
            origin: action.page.clone(),
            instance: self.instance_for_page(&action.page.page_id)?.clone(),
            target: self.dispatch_target(action)?.clone(),
            operation: action.operation.clone(),
        })
    }

    pub fn finish_tracing_stop(
        &mut self,
        permit: BrowserTracingStopPermit,
        outcome: BrowserActionOutcome,
    ) -> Result<BrowserControlProjection, BrowserAdmissionError> {
        self.finish_admitted_action(
            &permit.resource,
            &permit.operation,
            permit.sequence,
            outcome,
        )
    }

    pub fn dispatch_tracing_stop(
        &self,
        permit: &BrowserTracingStopPermit,
    ) -> Result<(), BrowserAdmissionError> {
        self.require_instance_binding(&permit.resource, &permit.lease.instance)?;
        if !self.active.as_ref().is_some_and(|active| {
            active.operation == permit.operation
                && active.sequence == permit.sequence
                && active.page.is_none()
                && active.instance == permit.lease.instance
        }) {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }
}

impl BrowserTracingHost {
    pub fn new(instance: BrowserInstanceId, resource: BrowserResourceIdentity) -> Self {
        Self {
            instance,
            task: Some(resource),
            generation: NonZeroU64::MIN,
            active: None,
        }
    }

    /// Admit the destination before any page or renderer for it can exist.
    pub fn admit_resource(
        &mut self,
        resource: &BrowserResourceIdentity,
    ) -> Result<(), BrowserAdmissionError> {
        if self.task.as_ref() != Some(resource) {
            if self
                .active
                .as_ref()
                .is_some_and(|interval| interval.scope == BrowserTracingScope::Task)
            {
                return Err(BrowserAdmissionError::TracingAlreadyActive);
            }
            self.task = None;
        }
        Ok(())
    }

    pub fn start(
        &mut self,
        permit: &BrowserTracingPermit,
        mode: BrowserTracingMode,
        scope: BrowserTracingScope,
    ) -> Result<BrowserTracingLease, BrowserAdmissionError> {
        self.require_instance(permit)?;
        if self.active.is_some() {
            return Err(BrowserAdmissionError::TracingAlreadyActive);
        }
        if scope == BrowserTracingScope::Task && self.task.as_ref() != Some(&permit.resource) {
            return Err(BrowserAdmissionError::TracingScopeRequired);
        }
        self.generation = advance(self.generation)?;
        self.active = Some(BrowserTracingInterval {
            resource: permit.resource.clone(),
            origin: permit.origin.clone(),
            operation_id: permit.operation.clone(),
            mode,
            scope,
            phase: BrowserTracingPhase::Starting,
            cleanup_confirmed: None,
        });
        Ok(self.lease())
    }

    pub fn stop(
        &self,
        permit: &BrowserTracingPermit,
        recording: &BrowserOperationId,
    ) -> Result<BrowserTracingLease, BrowserAdmissionError> {
        self.require_instance(permit)?;
        let interval = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::TracingNotActive)?;
        if interval.resource != permit.resource || &interval.operation_id != recording {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(self.lease())
    }

    pub fn begin_stop(
        &self,
        resource: &mut BrowserResourceHost,
        caller: &BrowserControllerId,
        authority: &BrowserTracingStopAuthority,
    ) -> Result<BrowserTracingStopPermit, BrowserAdmissionError> {
        resource.require_action_admission(caller, &authority.lease, authority.command_sequence)?;
        resource.require_instance_binding(&authority.lease.resource, &authority.instance_id)?;
        if authority.instance_id != self.instance {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        let interval = self
            .active
            .as_ref()
            .ok_or(BrowserAdmissionError::TracingNotActive)?;
        if interval.resource != authority.lease.resource
            || interval.operation_id != authority.recording
        {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        let permit = BrowserTracingStopPermit {
            resource: authority.lease.resource.clone(),
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            lease: self.lease(),
        };
        resource.admit_action(ActiveAction {
            operation: authority.operation_id.clone(),
            sequence: authority.command_sequence,
            page: None,
            instance: self.instance.clone(),
            page_creation: None,
            creation_label: None,
        })?;
        Ok(permit)
    }

    pub fn require_stop(
        &self,
        permit: &BrowserTracingStopPermit,
    ) -> Result<(), BrowserAdmissionError> {
        if self.active.is_none() || permit.lease != self.lease() {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        Ok(())
    }

    pub fn started(&mut self, lease: &BrowserTracingLease) -> Result<(), BrowserAdmissionError> {
        let interval = self.require_lease(lease)?;
        if interval.phase == BrowserTracingPhase::Starting {
            interval.phase = BrowserTracingPhase::Recording;
        }
        Ok(())
    }

    pub fn finished(
        &mut self,
        lease: &BrowserTracingLease,
        cleanup_confirmed: bool,
    ) -> Result<(), BrowserAdmissionError> {
        let interval = self.require_lease(lease)?;
        interval.phase = BrowserTracingPhase::Finished;
        interval.cleanup_confirmed = Some(cleanup_confirmed);
        Ok(())
    }

    /// Called after the original native owner confirms cleanup or process exit.
    pub fn release(&mut self, lease: &BrowserTracingLease) -> Result<(), BrowserAdmissionError> {
        if self.require_lease(lease)?.cleanup_confirmed != Some(true) {
            return Err(BrowserAdmissionError::OutcomeUnknown);
        }
        self.active = None;
        Ok(())
    }

    pub fn current(&self) -> Option<(BrowserTracingLease, &BrowserTracingInterval)> {
        self.active
            .as_ref()
            .map(|interval| (self.lease(), interval))
    }

    pub fn status(&self, resource: &BrowserResourceIdentity) -> BrowserTracingStatus {
        BrowserTracingStatus {
            resource: resource.clone(),
            instance_id: self.instance.clone(),
            interval: self
                .active
                .as_ref()
                .filter(|interval| &interval.resource == resource)
                .cloned(),
            busy: self.active.is_some(),
        }
    }

    fn lease(&self) -> BrowserTracingLease {
        BrowserTracingLease {
            instance: self.instance.clone(),
            generation: self.generation,
        }
    }

    fn require_instance(&self, permit: &BrowserTracingPermit) -> Result<(), BrowserAdmissionError> {
        if permit.instance != self.instance {
            return Err(BrowserAdmissionError::InstanceMismatch);
        }
        Ok(())
    }

    fn require_lease(
        &mut self,
        lease: &BrowserTracingLease,
    ) -> Result<&mut BrowserTracingInterval, BrowserAdmissionError> {
        if lease != &self.lease() {
            return Err(BrowserAdmissionError::PermitMismatch);
        }
        self.active
            .as_mut()
            .ok_or(BrowserAdmissionError::TracingNotActive)
    }
}
