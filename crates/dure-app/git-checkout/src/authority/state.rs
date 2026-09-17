use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Phase {
    Creating,
    Active,
    Removing,
    Removed,
}

impl Phase {
    fn token(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Active => "active",
            Self::Removing => "removing",
            Self::Removed => "removed",
        }
    }
}

#[derive(Clone)]
pub(super) struct Slot {
    pub(super) token: String,
    pub(super) operation_id: String,
    pub(super) request_digest: String,
    pub(super) revision: u64,
}

#[derive(Clone)]
pub(super) struct OperationMarker {
    pub(super) operation_id: String,
    pub(super) request_digest: String,
    pub(super) revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Operation {
    pub(super) operation_id: String,
    pub(super) request_digest: String,
    pub(super) kind: &'static str,
    pub(super) revision: u64,
}

#[derive(Clone)]
pub(super) enum ClaimState {
    Active,
    Released(OperationMarker),
}

impl ClaimState {
    fn token(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Released(_) => "released",
        }
    }
}

#[derive(Clone)]
pub(super) struct Claim {
    pub(super) owner_id: String,
    pub(super) claim_id: String,
    pub(super) request_digest: String,
    pub(super) acquire_revision: u64,
    pub(super) state: ClaimState,
}

impl Claim {
    pub(super) fn is_active(&self) -> bool {
        matches!(self.state, ClaimState::Active)
    }

    pub(super) fn release(&self) -> Option<&OperationMarker> {
        match &self.state {
            ClaimState::Active => None,
            ClaimState::Released(release) => Some(release),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum TerminalKind {
    CreationAborted,
    Removed,
    AlreadyAbsent,
}

impl TerminalKind {
    fn token(self) -> &'static str {
        match self {
            Self::CreationAborted => "creation_aborted",
            Self::Removed => "removed",
            Self::AlreadyAbsent => "already_absent",
        }
    }
}

#[derive(Clone)]
pub(super) struct TerminalOperation {
    pub(super) operation_id: String,
    pub(super) request_digest: String,
}

#[derive(Clone)]
pub(super) struct CreationHistory {
    pub(super) reservation: Slot,
    pub(super) start: Slot,
    pub(super) activation: OperationMarker,
}

#[derive(Clone)]
pub(super) enum CreatingState {
    Reserved(Slot),
    Started { reservation: Slot, start: Slot },
}

#[derive(Clone)]
pub(super) enum ActiveRemoval {
    Idle,
    Aborted { permit: Slot, abort: Slot },
}

#[derive(Clone)]
pub(super) enum RemovalProgress {
    Permitted,
    Executing(OperationMarker),
}

#[derive(Clone, Copy)]
pub(super) enum PhysicalOutcome {
    Removed,
    AlreadyAbsent,
}

impl PhysicalOutcome {
    pub(super) fn terminal_kind(self) -> TerminalKind {
        match self {
            Self::Removed => TerminalKind::Removed,
            Self::AlreadyAbsent => TerminalKind::AlreadyAbsent,
        }
    }
}

#[derive(Clone)]
pub(super) struct PhysicalRemovedState {
    pub(super) instance_digest: String,
    pub(super) creation: Option<CreationHistory>,
    pub(super) permit: Slot,
    pub(super) physical: OperationMarker,
    pub(super) outcome: PhysicalOutcome,
}

#[derive(Clone)]
pub(super) enum RemovedState {
    CreationAborted {
        reservation: Slot,
        terminal: TerminalOperation,
    },
    Physical(Box<PhysicalRemovedState>),
}

#[derive(Clone)]
pub(super) enum Lifecycle {
    Creating(CreatingState),
    Active {
        instance_digest: String,
        creation: Option<CreationHistory>,
        removal: ActiveRemoval,
    },
    Removing {
        instance_digest: String,
        creation: Option<CreationHistory>,
        permit: Slot,
        progress: RemovalProgress,
    },
    Removed(RemovedState),
}

#[derive(Clone)]
pub(super) struct State {
    pub(super) revision: u64,
    pub(super) path_digest: String,
    pub(super) lifecycle: Lifecycle,
    pub(super) claims: BTreeMap<String, Claim>,
}

pub(super) struct LoadedState {
    pub(super) oid: String,
    pub(super) state: State,
}

#[derive(Clone, Copy)]
pub(super) struct TerminalView<'a> {
    pub(super) kind: TerminalKind,
    pub(super) operation_id: &'a str,
    pub(super) request_digest: &'a str,
    pub(super) revision: u64,
}

struct WireLifecycle<'a> {
    phase: Phase,
    instance_digest: Option<&'a str>,
    reservation: Option<&'a Slot>,
    creation_start: Option<&'a Slot>,
    activation: Option<&'a OperationMarker>,
    permit: Option<&'a Slot>,
    physical: Option<&'a OperationMarker>,
    last_abort: Option<&'a Slot>,
    terminal: Option<TerminalView<'a>>,
}

impl Lifecycle {
    fn wire(&self, revision: u64) -> WireLifecycle<'_> {
        let mut wire = WireLifecycle {
            phase: match self {
                Self::Creating(_) => Phase::Creating,
                Self::Active { .. } => Phase::Active,
                Self::Removing { .. } => Phase::Removing,
                Self::Removed(_) => Phase::Removed,
            },
            instance_digest: None,
            reservation: None,
            creation_start: None,
            activation: None,
            permit: None,
            physical: None,
            last_abort: None,
            terminal: None,
        };
        match self {
            Self::Creating(CreatingState::Reserved(reservation)) => {
                wire.reservation = Some(reservation);
            }
            Self::Creating(CreatingState::Started { reservation, start }) => {
                wire.reservation = Some(reservation);
                wire.creation_start = Some(start);
            }
            Self::Active {
                instance_digest,
                creation,
                removal,
            } => {
                wire.instance_digest = Some(instance_digest);
                if let Some(creation) = creation {
                    wire.reservation = Some(&creation.reservation);
                    wire.creation_start = Some(&creation.start);
                    wire.activation = Some(&creation.activation);
                }
                if let ActiveRemoval::Aborted { permit, abort } = removal {
                    wire.permit = Some(permit);
                    wire.last_abort = Some(abort);
                }
            }
            Self::Removing {
                instance_digest,
                creation,
                permit,
                progress,
            } => {
                wire.instance_digest = Some(instance_digest);
                if let Some(creation) = creation {
                    wire.reservation = Some(&creation.reservation);
                    wire.creation_start = Some(&creation.start);
                    wire.activation = Some(&creation.activation);
                }
                wire.permit = Some(permit);
                if let RemovalProgress::Executing(physical) = progress {
                    wire.physical = Some(physical);
                }
            }
            Self::Removed(RemovedState::CreationAborted {
                reservation,
                terminal,
            }) => {
                wire.reservation = Some(reservation);
                wire.terminal = Some(TerminalView {
                    kind: TerminalKind::CreationAborted,
                    operation_id: &terminal.operation_id,
                    request_digest: &terminal.request_digest,
                    revision,
                });
            }
            Self::Removed(RemovedState::Physical(removed)) => {
                wire.instance_digest = Some(&removed.instance_digest);
                if let Some(creation) = &removed.creation {
                    wire.reservation = Some(&creation.reservation);
                    wire.creation_start = Some(&creation.start);
                    wire.activation = Some(&creation.activation);
                }
                wire.permit = Some(&removed.permit);
                wire.physical = Some(&removed.physical);
                wire.terminal = Some(TerminalView {
                    kind: removed.outcome.terminal_kind(),
                    operation_id: &removed.physical.operation_id,
                    request_digest: &removed.physical.request_digest,
                    revision,
                });
            }
        }
        wire
    }
}

impl State {
    pub(super) fn phase(&self) -> Phase {
        self.lifecycle.wire(self.revision).phase
    }

    pub(super) fn instance_digest(&self) -> Option<&str> {
        self.lifecycle.wire(self.revision).instance_digest
    }

    pub(super) fn reservation(&self) -> Option<&Slot> {
        self.lifecycle.wire(self.revision).reservation
    }

    pub(super) fn creation_start(&self) -> Option<&Slot> {
        self.lifecycle.wire(self.revision).creation_start
    }

    pub(super) fn permit(&self) -> Option<&Slot> {
        self.lifecycle.wire(self.revision).permit
    }

    pub(super) fn physical(&self) -> Option<&OperationMarker> {
        self.lifecycle.wire(self.revision).physical
    }

    pub(super) fn last_abort(&self) -> Option<&Slot> {
        self.lifecycle.wire(self.revision).last_abort
    }

    pub(super) fn terminal(&self) -> Option<TerminalView<'_>> {
        self.lifecycle.wire(self.revision).terminal
    }
}

pub(super) fn compact_released_claims(state: &mut State) {
    let reservation_claim_id = state
        .reservation()
        .map(|reservation| reservation.operation_id.clone());
    state.claims.retain(|claim_id, claim| {
        claim.is_active() || reservation_claim_id.as_deref() == Some(claim_id.as_str())
    });
}

fn has_uncompacted_released_claims(state: &State) -> bool {
    let reservation_claim_id = state
        .reservation()
        .map(|reservation| reservation.operation_id.as_str());
    state.claims.iter().any(|(claim_id, claim)| {
        !claim.is_active() && reservation_claim_id != Some(claim_id.as_str())
    })
}

fn option_tokens(slot: Option<&Slot>) -> String {
    slot.map_or_else(
        || "- - - -".to_string(),
        |slot| {
            format!(
                "{} {} {} {}",
                slot.token, slot.operation_id, slot.request_digest, slot.revision
            )
        },
    )
}

fn marker_tokens(marker: Option<&OperationMarker>) -> String {
    marker.map_or_else(
        || "- - -".to_string(),
        |marker| {
            format!(
                "{} {} {}",
                marker.operation_id, marker.request_digest, marker.revision
            )
        },
    )
}

pub(super) fn encode_state(state: &State) -> Result<Vec<u8>, GitCheckoutUseError> {
    let mut record = String::new();
    let wire = state.lifecycle.wire(state.revision);
    use std::fmt::Write as _;
    writeln!(&mut record, "{RECORD_HEADER}").expect("writing String cannot fail");
    writeln!(&mut record, "revision {}", state.revision).expect("writing String cannot fail");
    writeln!(&mut record, "phase {}", wire.phase.token()).expect("writing String cannot fail");
    writeln!(&mut record, "path {}", state.path_digest).expect("writing String cannot fail");
    writeln!(
        &mut record,
        "instance {}",
        wire.instance_digest.unwrap_or("-")
    )
    .expect("writing String cannot fail");
    writeln!(
        &mut record,
        "reservation {}",
        option_tokens(wire.reservation)
    )
    .expect("writing String cannot fail");
    writeln!(
        &mut record,
        "creation-start {}",
        option_tokens(wire.creation_start)
    )
    .expect("writing String cannot fail");
    writeln!(&mut record, "activation {}", marker_tokens(wire.activation))
        .expect("writing String cannot fail");
    writeln!(&mut record, "permit {}", option_tokens(wire.permit))
        .expect("writing String cannot fail");
    writeln!(&mut record, "physical {}", marker_tokens(wire.physical))
        .expect("writing String cannot fail");
    writeln!(&mut record, "last-abort {}", option_tokens(wire.last_abort))
        .expect("writing String cannot fail");
    match wire.terminal {
        Some(terminal) => writeln!(
            &mut record,
            "terminal {} {} {} {}",
            terminal.kind.token(),
            terminal.operation_id,
            terminal.request_digest,
            terminal.revision
        ),
        None => writeln!(&mut record, "terminal none - - -"),
    }
    .expect("writing String cannot fail");
    writeln!(&mut record, "claims {}", state.claims.len()).expect("writing String cannot fail");
    for claim in state.claims.values() {
        let release = marker_tokens(claim.release());
        writeln!(
            &mut record,
            "claim {} {} {} {} {} {}",
            claim.state.token(),
            claim.owner_id,
            claim.claim_id,
            claim.request_digest,
            claim.acquire_revision,
            release
        )
        .expect("writing String cannot fail");
    }
    if record.len() > MAX_RECORD_BYTES {
        return Err(GitCheckoutUseError::new(
            "checkout_use_record_too_large",
            "checkout-use state exceeded the bounded record size",
        ));
    }
    Ok(record.into_bytes())
}

fn parse_revision_token(value: &str) -> Result<u64, GitCheckoutUseError> {
    let revision = value
        .parse::<u64>()
        .map_err(|_| state_error("checkout-use state has an invalid revision"))?;
    if revision == 0 || revision > MAX_GIT_CHECKOUT_USE_REVISION_V1 || revision.to_string() != value
    {
        return Err(state_error(
            "checkout-use state has a non-canonical revision",
        ));
    }
    Ok(revision)
}

fn valid_operation_id(value: &str) -> bool {
    OperationIdV1::new(value.to_string()).is_ok()
}

fn valid_oid(authority: &Authority, value: &str) -> bool {
    authority.valid_oid(value)
}

fn parse_optional_slot(
    authority: &Authority,
    values: &[&str],
) -> Result<Option<Slot>, GitCheckoutUseError> {
    if values == ["-", "-", "-", "-"] {
        return Ok(None);
    }
    if values.len() != 4
        || !authority.valid_oid(values[0])
        || !valid_operation_id(values[1])
        || !valid_oid(authority, values[2])
    {
        return Err(state_error(
            "checkout-use state has an invalid authority slot",
        ));
    }
    Ok(Some(Slot {
        token: values[0].to_string(),
        operation_id: values[1].to_string(),
        request_digest: values[2].to_string(),
        revision: parse_revision_token(values[3])?,
    }))
}

fn parse_optional_marker(
    authority: &Authority,
    values: &[&str],
) -> Result<Option<OperationMarker>, GitCheckoutUseError> {
    if values == ["-", "-", "-"] {
        return Ok(None);
    }
    if values.len() != 3 || !valid_operation_id(values[0]) || !valid_oid(authority, values[1]) {
        return Err(state_error(
            "checkout-use state has an invalid operation slot",
        ));
    }
    Ok(Some(OperationMarker {
        operation_id: values[0].to_string(),
        request_digest: values[1].to_string(),
        revision: parse_revision_token(values[2])?,
    }))
}

fn next_parts<'a>(
    lines: &mut impl Iterator<Item = &'a str>,
    key: &str,
    count: usize,
) -> Result<Vec<&'a str>, GitCheckoutUseError> {
    let line = lines
        .next()
        .ok_or_else(|| state_error(format!("checkout-use state is missing {key}")))?;
    let parts = line.split(' ').collect::<Vec<_>>();
    if parts.len() != count || parts[0] != key || parts.iter().any(|part| part.is_empty()) {
        return Err(state_error(format!(
            "checkout-use state has an invalid {key} row"
        )));
    }
    Ok(parts)
}

fn insert_lifecycle_operation(
    authority: &Authority,
    state_revision: u64,
    operations: &mut BTreeMap<String, Operation>,
    operation_id: &str,
    request_digest: &str,
    kind: &'static str,
    operation_revision: u64,
) -> Result<(), GitCheckoutUseError> {
    if !valid_operation_id(operation_id)
        || !authority.valid_oid(request_digest)
        || operation_revision == 0
        || operation_revision > state_revision
    {
        return Err(state_error(
            "checkout-use lifecycle operation has invalid identity or revision",
        ));
    }
    let operation = Operation {
        operation_id: operation_id.to_string(),
        request_digest: request_digest.to_string(),
        kind,
        revision: operation_revision,
    };
    if let Some(previous) = operations.get_mut(operation_id) {
        if previous.request_digest != operation.request_digest
            || previous.kind != operation.kind
            || (previous.revision != operation.revision && operation.kind != "physical")
        {
            return Err(state_error(
                "checkout-use operation id is reused across lifecycle records",
            ));
        }
        previous.revision = previous.revision.max(operation.revision);
    } else {
        operations.insert(operation_id.to_string(), operation);
    }
    Ok(())
}

fn lifecycle_operation_candidates(state: &State) -> Vec<Operation> {
    let wire = state.lifecycle.wire(state.revision);
    let mut operations = Vec::with_capacity(8 + state.claims.len() * 2);
    let mut push = |operation_id: &str, request_digest: &str, kind, revision| {
        operations.push(Operation {
            operation_id: operation_id.to_string(),
            request_digest: request_digest.to_string(),
            kind,
            revision,
        });
    };
    if let Some(terminal) = wire.terminal {
        let kind = match terminal.kind {
            TerminalKind::CreationAborted => "abort_creation",
            TerminalKind::Removed | TerminalKind::AlreadyAbsent => "physical",
        };
        push(
            terminal.operation_id,
            terminal.request_digest,
            kind,
            terminal.revision,
        );
    }
    for (slot, kind) in [
        (wire.last_abort, "abort_removal"),
        (wire.permit, "permit"),
        (wire.creation_start, "start_creation"),
        (wire.reservation, "reserve"),
    ] {
        if let Some(slot) = slot {
            push(
                &slot.operation_id,
                &slot.request_digest,
                kind,
                slot.revision,
            );
        }
    }
    for (marker, kind) in [(wire.physical, "physical"), (wire.activation, "activate")] {
        if let Some(marker) = marker {
            push(
                &marker.operation_id,
                &marker.request_digest,
                kind,
                marker.revision,
            );
        }
    }
    for claim in state.claims.values() {
        let kind = if wire
            .reservation
            .is_some_and(|reservation| reservation.operation_id == claim.claim_id)
        {
            "reserve"
        } else {
            "claim"
        };
        push(
            &claim.claim_id,
            &claim.request_digest,
            kind,
            claim.acquire_revision,
        );
        if let Some(release) = claim.release() {
            push(
                &release.operation_id,
                &release.request_digest,
                "release",
                release.revision,
            );
        }
    }
    operations
}

fn lifecycle_operations(
    authority: &Authority,
    state: &State,
) -> Result<BTreeMap<String, Operation>, GitCheckoutUseError> {
    let mut operations = BTreeMap::new();
    let wire = state.lifecycle.wire(state.revision);
    for slot in [
        wire.reservation,
        wire.creation_start,
        wire.permit,
        wire.last_abort,
    ]
    .into_iter()
    .flatten()
    {
        if !authority.valid_oid(&slot.token) {
            return Err(state_error("checkout-use lifecycle token is invalid"));
        }
    }
    for operation in lifecycle_operation_candidates(state) {
        insert_lifecycle_operation(
            authority,
            state.revision,
            &mut operations,
            &operation.operation_id,
            &operation.request_digest,
            operation.kind,
            operation.revision,
        )?;
    }
    Ok(operations)
}

pub(super) fn find_lifecycle_operation(state: &State, operation_id: &str) -> Option<Operation> {
    lifecycle_operation_candidates(state)
        .into_iter()
        .find(|operation| operation.operation_id == operation_id)
}

pub(super) fn validate_state(
    authority: &Authority,
    state: &State,
) -> Result<(), GitCheckoutUseError> {
    if state.path_digest != authority.path_digest
        || !authority.valid_oid(&state.path_digest)
        || state.revision == 0
        || state.revision > MAX_GIT_CHECKOUT_USE_REVISION_V1
        || state.claims.len() > MAX_CLAIMS
        || state
            .claims
            .values()
            .filter(|claim| claim.is_active())
            .count()
            > MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1
    {
        return Err(state_error(
            "checkout-use state violates its bounded identity",
        ));
    }
    if state
        .instance_digest()
        .is_some_and(|digest| !authority.valid_oid(digest))
    {
        return Err(state_error(
            "checkout-use state has an invalid instance digest",
        ));
    }
    lifecycle_operations(authority, state)?;
    if let Some(reservation) = state.reservation() {
        let reservation_claim = state
            .claims
            .get(&reservation.operation_id)
            .ok_or_else(|| state_error("checkout-use reservation lost its initial claim"))?;
        if reservation_claim.request_digest != reservation.request_digest
            || reservation_claim.acquire_revision != reservation.revision
        {
            return Err(state_error(
                "checkout-use reservation disagrees with its initial claim",
            ));
        }
        let expected = digest_fields(
            &authority.repository,
            RESERVATION_DOMAIN,
            &[
                &authority.path_digest,
                &reservation.operation_id,
                &reservation.request_digest,
                &reservation.revision.to_string(),
            ],
        )?;
        if reservation.token != expected {
            return Err(state_error(
                "checkout-use reservation token disagrees with its authority row",
            ));
        }
        if let Some(start) = state.creation_start() {
            if start.token != reservation.token {
                return Err(state_error(
                    "checkout-use creation-start marker lost its reservation token",
                ));
            }
        }
    }
    if let Some(permit) = state.permit() {
        let instance_digest = state
            .instance_digest()
            .ok_or_else(|| state_error("checkout-use permit lost its instance digest"))?;
        let expected = digest_fields(
            &authority.repository,
            PERMIT_DOMAIN,
            &[
                &authority.path_digest,
                instance_digest,
                &permit.operation_id,
                &permit.request_digest,
                &permit.revision.to_string(),
            ],
        )?;
        if permit.token != expected {
            return Err(state_error(
                "checkout-use permit token disagrees with its authority row",
            ));
        }
        if state
            .last_abort()
            .is_some_and(|abort| abort.token != permit.token)
        {
            return Err(state_error("active checkout-use state is inconsistent"));
        }
    }
    for (claim_id, claim) in &state.claims {
        if claim_id != &claim.claim_id
            || !valid_operation_id(&claim.owner_id)
            || !valid_operation_id(&claim.claim_id)
            || !authority.valid_oid(&claim.request_digest)
        {
            return Err(state_error("checkout-use state has an invalid claim"));
        }
    }
    match &state.lifecycle {
        Lifecycle::Creating(_) => {
            if state.claims.len() != 1 || state.claims.values().any(|claim| !claim.is_active()) {
                return Err(state_error("creating checkout-use state is inconsistent"));
            }
        }
        Lifecycle::Removed(RemovedState::CreationAborted { .. }) => {
            if state.claims.len() != 1 || state.claims.values().any(|claim| !claim.is_active()) {
                return Err(state_error(
                    "aborted creation checkout-use state is inconsistent",
                ));
            }
        }
        Lifecycle::Active {
            removal: ActiveRemoval::Aborted { .. },
            ..
        } if has_uncompacted_released_claims(state) => {
            return Err(state_error("active checkout-use state is inconsistent"));
        }
        Lifecycle::Removed(RemovedState::Physical(_)) if has_uncompacted_released_claims(state) => {
            return Err(state_error("removed checkout-use state is inconsistent"));
        }
        _ => {}
    }
    Ok(())
}

struct FlatTerminal {
    kind: TerminalKind,
    operation_id: String,
    request_digest: String,
    revision: u64,
}

struct FlatLifecycle {
    phase: Phase,
    instance_digest: Option<String>,
    reservation: Option<Slot>,
    creation_start: Option<Slot>,
    activation: Option<OperationMarker>,
    permit: Option<Slot>,
    physical: Option<OperationMarker>,
    last_abort: Option<Slot>,
    terminal: Option<FlatTerminal>,
}

fn decode_creation_history(
    reservation: Option<Slot>,
    start: Option<Slot>,
    activation: Option<OperationMarker>,
    inconsistent: &'static str,
) -> Result<Option<CreationHistory>, GitCheckoutUseError> {
    match (reservation, start, activation) {
        (None, None, None) => Ok(None),
        (Some(reservation), Some(start), Some(activation)) => Ok(Some(CreationHistory {
            reservation,
            start,
            activation,
        })),
        _ => Err(state_error(inconsistent)),
    }
}

fn decode_lifecycle(revision: u64, flat: FlatLifecycle) -> Result<Lifecycle, GitCheckoutUseError> {
    let FlatLifecycle {
        phase,
        instance_digest,
        reservation,
        creation_start,
        activation,
        permit,
        physical,
        last_abort,
        terminal,
    } = flat;
    match phase {
        Phase::Creating => {
            if instance_digest.is_some()
                || activation.is_some()
                || permit.is_some()
                || physical.is_some()
                || last_abort.is_some()
                || terminal.is_some()
            {
                return Err(state_error("creating checkout-use state is inconsistent"));
            }
            let reservation = reservation
                .ok_or_else(|| state_error("creating checkout-use state is inconsistent"))?;
            Ok(Lifecycle::Creating(match creation_start {
                Some(start) => CreatingState::Started { reservation, start },
                None => CreatingState::Reserved(reservation),
            }))
        }
        Phase::Active => {
            if physical.is_some() || terminal.is_some() {
                return Err(state_error("active checkout-use state is inconsistent"));
            }
            let instance_digest = instance_digest
                .ok_or_else(|| state_error("active checkout-use state is inconsistent"))?;
            let creation = decode_creation_history(
                reservation,
                creation_start,
                activation,
                "active checkout-use state is inconsistent",
            )?;
            let removal = match (permit, last_abort) {
                (None, None) => ActiveRemoval::Idle,
                (Some(permit), Some(abort)) => ActiveRemoval::Aborted { permit, abort },
                _ => {
                    return Err(state_error("active checkout-use state is inconsistent"));
                }
            };
            Ok(Lifecycle::Active {
                instance_digest,
                creation,
                removal,
            })
        }
        Phase::Removing => {
            if last_abort.is_some() || terminal.is_some() {
                return Err(state_error("removing checkout-use state is inconsistent"));
            }
            let instance_digest = instance_digest
                .ok_or_else(|| state_error("removing checkout-use state is inconsistent"))?;
            let creation = decode_creation_history(
                reservation,
                creation_start,
                activation,
                "removing checkout-use state is inconsistent",
            )?;
            let permit =
                permit.ok_or_else(|| state_error("removing checkout-use state is inconsistent"))?;
            let progress = physical.map_or(RemovalProgress::Permitted, RemovalProgress::Executing);
            Ok(Lifecycle::Removing {
                instance_digest,
                creation,
                permit,
                progress,
            })
        }
        Phase::Removed => {
            let terminal = terminal
                .ok_or_else(|| state_error("removed checkout-use state has no terminal receipt"))?;
            match terminal.kind {
                TerminalKind::CreationAborted => {
                    if instance_digest.is_some()
                        || reservation.is_none()
                        || creation_start.is_some()
                        || activation.is_some()
                        || permit.is_some()
                        || physical.is_some()
                        || last_abort.is_some()
                    {
                        return Err(state_error(
                            "aborted creation checkout-use state is inconsistent",
                        ));
                    }
                    if terminal.revision != revision {
                        return Err(state_error(
                            "checkout-use terminal revision disagrees with the state revision",
                        ));
                    }
                    let reservation = reservation.expect("checked creation reservation");
                    Ok(Lifecycle::Removed(RemovedState::CreationAborted {
                        reservation,
                        terminal: TerminalOperation {
                            operation_id: terminal.operation_id,
                            request_digest: terminal.request_digest,
                        },
                    }))
                }
                TerminalKind::Removed | TerminalKind::AlreadyAbsent => {
                    let creation = decode_creation_history(
                        reservation,
                        creation_start,
                        activation,
                        "removed checkout-use state is inconsistent",
                    )?;
                    if instance_digest.is_none()
                        || permit.is_none()
                        || physical.is_none()
                        || last_abort.is_some()
                    {
                        return Err(state_error("removed checkout-use state is inconsistent"));
                    }
                    if terminal.revision != revision {
                        return Err(state_error(
                            "checkout-use terminal revision disagrees with the state revision",
                        ));
                    }
                    let instance_digest = instance_digest.expect("checked removed instance");
                    let permit = permit.expect("checked removal permit");
                    let physical = physical.expect("checked physical execution");
                    if terminal.operation_id != physical.operation_id
                        || terminal.request_digest != physical.request_digest
                    {
                        return Err(state_error(
                            "physical terminal disagrees with its execution marker",
                        ));
                    }
                    let outcome = match terminal.kind {
                        TerminalKind::Removed => PhysicalOutcome::Removed,
                        TerminalKind::AlreadyAbsent => PhysicalOutcome::AlreadyAbsent,
                        TerminalKind::CreationAborted => unreachable!(),
                    };
                    Ok(Lifecycle::Removed(RemovedState::Physical(Box::new(
                        PhysicalRemovedState {
                            instance_digest,
                            creation,
                            permit,
                            physical,
                            outcome,
                        },
                    ))))
                }
            }
        }
    }
}

pub(super) fn decode_state(
    authority: &Authority,
    bytes: &[u8],
) -> Result<State, GitCheckoutUseError> {
    if bytes.len() > MAX_RECORD_BYTES || !bytes.is_ascii() || !bytes.ends_with(b"\n") {
        return Err(state_error(
            "checkout-use state is not one bounded ASCII record",
        ));
    }
    let record =
        std::str::from_utf8(bytes).map_err(|_| state_error("checkout-use state is not ASCII"))?;
    let mut lines = record
        .strip_suffix('\n')
        .expect("checked final LF")
        .split('\n');
    if lines.next() != Some(RECORD_HEADER) {
        return Err(state_error("checkout-use state has an unknown schema"));
    }
    let revision = parse_revision_token(next_parts(&mut lines, "revision", 2)?[1])?;
    let phase = match next_parts(&mut lines, "phase", 2)?[1] {
        "creating" => Phase::Creating,
        "active" => Phase::Active,
        "removing" => Phase::Removing,
        "removed" => Phase::Removed,
        _ => return Err(state_error("checkout-use state has an unknown phase")),
    };
    let path = next_parts(&mut lines, "path", 2)?[1].to_string();
    let instance_value = next_parts(&mut lines, "instance", 2)?[1];
    let instance_digest = (instance_value != "-").then(|| instance_value.to_string());

    let reservation_parts = next_parts(&mut lines, "reservation", 5)?;
    let reservation = parse_optional_slot(authority, &reservation_parts[1..])?;
    let creation_start_parts = next_parts(&mut lines, "creation-start", 5)?;
    let creation_start = parse_optional_slot(authority, &creation_start_parts[1..])?;
    let activation_parts = next_parts(&mut lines, "activation", 4)?;
    let activation = parse_optional_marker(authority, &activation_parts[1..])?;
    let permit_parts = next_parts(&mut lines, "permit", 5)?;
    let permit = parse_optional_slot(authority, &permit_parts[1..])?;
    let physical_parts = next_parts(&mut lines, "physical", 4)?;
    let physical = parse_optional_marker(authority, &physical_parts[1..])?;
    let last_abort_parts = next_parts(&mut lines, "last-abort", 5)?;
    let last_abort = parse_optional_slot(authority, &last_abort_parts[1..])?;

    let terminal_parts = next_parts(&mut lines, "terminal", 5)?;
    let terminal = if terminal_parts[1] == "none" {
        if terminal_parts[2..] != ["-", "-", "-"] {
            return Err(state_error("checkout-use terminal placeholder is invalid"));
        }
        None
    } else {
        let kind = match terminal_parts[1] {
            "creation_aborted" => TerminalKind::CreationAborted,
            "removed" => TerminalKind::Removed,
            "already_absent" => TerminalKind::AlreadyAbsent,
            _ => return Err(state_error("checkout-use terminal kind is invalid")),
        };
        if !valid_operation_id(terminal_parts[2]) || !authority.valid_oid(terminal_parts[3]) {
            return Err(state_error("checkout-use terminal receipt is invalid"));
        }
        Some(FlatTerminal {
            kind,
            operation_id: terminal_parts[2].to_string(),
            request_digest: terminal_parts[3].to_string(),
            revision: parse_revision_token(terminal_parts[4])?,
        })
    };

    let claim_count = next_parts(&mut lines, "claims", 2)?[1]
        .parse::<usize>()
        .map_err(|_| state_error("checkout-use claim count is invalid"))?;
    if claim_count > MAX_CLAIMS {
        return Err(state_error("checkout-use claim count exceeds its bound"));
    }
    let mut claims = BTreeMap::new();
    let mut previous_claim_id = None::<String>;
    for _ in 0..claim_count {
        let parts = next_parts(&mut lines, "claim", 9)?;
        if !valid_operation_id(parts[2])
            || !valid_operation_id(parts[3])
            || !authority.valid_oid(parts[4])
        {
            return Err(state_error("checkout-use claim identity is invalid"));
        }
        let claim_id = parts[3].to_string();
        if previous_claim_id
            .as_ref()
            .is_some_and(|previous| previous >= &claim_id)
        {
            return Err(state_error(
                "checkout-use claims are duplicated or not canonically sorted",
            ));
        }
        previous_claim_id = Some(claim_id.clone());
        let acquire_revision = parse_revision_token(parts[5])?;
        let release = if parts[6..] == ["-", "-", "-"] {
            None
        } else {
            if !valid_operation_id(parts[6]) || !authority.valid_oid(parts[7]) {
                return Err(state_error("checkout-use release identity is invalid"));
            }
            Some(OperationMarker {
                operation_id: parts[6].to_string(),
                request_digest: parts[7].to_string(),
                revision: parse_revision_token(parts[8])?,
            })
        };
        let claim_state = match (parts[1], release) {
            ("active", None) => ClaimState::Active,
            ("released", Some(release)) => ClaimState::Released(release),
            ("active" | "released", _) => {
                return Err(state_error("checkout-use claim status is inconsistent"));
            }
            _ => return Err(state_error("checkout-use claim status is invalid")),
        };
        claims.insert(
            claim_id.clone(),
            Claim {
                owner_id: parts[2].to_string(),
                claim_id,
                request_digest: parts[4].to_string(),
                acquire_revision,
                state: claim_state,
            },
        );
    }

    if lines.next().is_some() {
        return Err(state_error("checkout-use state has surplus rows"));
    }

    let lifecycle = decode_lifecycle(
        revision,
        FlatLifecycle {
            phase,
            instance_digest,
            reservation,
            creation_start,
            activation,
            permit,
            physical,
            last_abort,
            terminal,
        },
    )?;
    let state = State {
        revision,
        path_digest: path,
        lifecycle,
        claims,
    };
    validate_state(authority, &state)?;
    if encode_state(&state)? != bytes {
        return Err(state_error("checkout-use state is not canonically encoded"));
    }
    Ok(state)
}
