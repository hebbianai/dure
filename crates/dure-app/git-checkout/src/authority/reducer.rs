use super::*;
use std::collections::BTreeMap;
use std::fs;
use std::path::Component;

mod creation;
mod prepared_request;
mod replay;
pub(super) use prepared_request::PreparedRequest;

#[derive(Clone)]
enum PreparedAction {
    Reserve {
        owner_id: OperationIdV1,
    },
    AbortCreation {
        reservation_token: String,
        quiescent_start: Option<(OperationIdV1, String)>,
    },
    StartCreation {
        reservation_token: String,
    },
    Activate {
        instance: GitCheckoutInstanceV1,
        instance_digest: String,
        reservation_token: String,
    },
    Claim {
        instance: GitCheckoutInstanceV1,
        instance_digest: String,
        owner_id: OperationIdV1,
    },
    Release {
        instance_digest: String,
        claim_id: OperationIdV1,
    },
    Permit {
        instance: GitCheckoutInstanceV1,
        instance_digest: String,
        retiring_claim_ids: Vec<OperationIdV1>,
        policy: GitCheckoutRemovalPolicyV1,
    },
    AbortRemoval {
        instance: GitCheckoutInstanceV1,
        instance_digest: String,
        permit_token: String,
    },
    RetireAbsent,
}

impl PreparedAction {
    fn kind(&self) -> &'static str {
        match self {
            Self::Reserve { .. } => "reserve",
            Self::AbortCreation { .. } => "abort_creation",
            Self::StartCreation { .. } => "start_creation",
            Self::Activate { .. } => "activate",
            Self::Claim { .. } => "claim",
            Self::Release { .. } => "release",
            Self::Permit { .. } => "permit",
            Self::AbortRemoval { .. } => "abort_removal",
            Self::RetireAbsent => "retire_absent",
        }
    }
}

fn canonical_creation_target(path: &str) -> Result<TrustedLocator, GitCheckoutUseError> {
    let requested = TrustedLocator::parse(path, "checkout creation path")?;
    if path.as_bytes().last().is_some_and(|byte| {
        *byte == std::path::MAIN_SEPARATOR as u8 || (cfg!(windows) && *byte == b'/')
    }) {
        return Err(request_error(
            "checkout creation path must not end in a path separator",
        ));
    }
    let path = requested.as_path();
    if !matches!(path.components().next_back(), Some(Component::Normal(_))) {
        return Err(request_error(
            "checkout creation path must be absolute and end in one normal component",
        ));
    }
    // Normalize the locator before replay lookup. Only a new reservation needs
    // target absence; the mutation plan checks it before publishing that state.
    let parent = path
        .parent()
        .ok_or_else(|| request_error("checkout creation path has no parent"))?;
    let parent = fs::canonicalize(parent).map_err(|cause| {
        request_error(format!(
            "could not canonicalize checkout creation parent: {cause}"
        ))
    })?;
    if !parent.is_dir() {
        return Err(request_error("checkout creation parent is not a directory"));
    }
    let target = parent.join(
        path.file_name()
            .ok_or_else(|| request_error("checkout creation path has no final component"))?,
    );
    let target = dunce::simplified(&target)
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| request_error("canonical checkout creation path is not UTF-8"))?;
    TrustedLocator::parse(&target, "canonical checkout creation path")
}

fn normalize_claim_ids(
    claim_ids: &[OperationIdV1],
) -> Result<Vec<OperationIdV1>, GitCheckoutUseError> {
    if claim_ids.len() > MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1 {
        return Err(GitCheckoutUseError::new(
            "checkout_use_capacity_exceeded",
            "checkout-use retiring claim ids exceed the shared active-claim bound",
        ));
    }
    let mut claim_ids = claim_ids.to_vec();
    claim_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    if claim_ids.windows(2).any(|ids| ids[0] == ids[1]) {
        return Err(request_error(
            "checkout-use retiring claim ids contain duplicates",
        ));
    }
    Ok(claim_ids)
}

fn prepare_instance(
    repository: &TrustedLocator,
    instance: &GitCheckoutInstanceV1,
) -> Result<(Authority, String, ValidatedGitCheckoutInstance), GitCheckoutUseError> {
    let instance = ValidatedGitCheckoutInstance::parse(instance)
        .map_err(|cause| instance_error(cause, InstanceErrorContext::Request))?;
    let (authority, instance_digest) = Authority::for_validated_instance(repository, &instance)?;
    Ok((authority, instance_digest, instance))
}

fn request_digest(
    authority: &Authority,
    operation_id: &OperationIdV1,
    action: &PreparedAction,
) -> Result<String, GitCheckoutUseError> {
    if let PreparedAction::Permit {
        instance_digest,
        retiring_claim_ids,
        policy,
        ..
    } = action
    {
        return permit_request_digest(
            authority,
            operation_id,
            instance_digest,
            retiring_claim_ids,
            *policy,
        );
    }
    let mut fields = Vec::<String>::new();
    fields.push(action.kind().to_string());
    fields.push(authority.path_digest.clone());
    match action {
        PreparedAction::Reserve { owner_id } => {
            fields.push(owner_id.as_str().to_string());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::AbortCreation {
            reservation_token,
            quiescent_start,
        } => {
            fields.push(reservation_token.clone());
            fields.push(operation_id.as_str().to_string());
            if let Some((operation_id, digest)) = quiescent_start {
                fields.push(operation_id.as_str().to_owned());
                fields.push(digest.clone());
            }
        }
        PreparedAction::StartCreation { reservation_token } => {
            fields.push(reservation_token.clone());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::Activate {
            instance_digest,
            reservation_token,
            ..
        } => {
            fields.push(reservation_token.clone());
            fields.push(instance_digest.clone());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::Claim {
            instance_digest,
            owner_id,
            ..
        } => {
            fields.push(instance_digest.clone());
            fields.push(owner_id.as_str().to_string());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::Release {
            instance_digest,
            claim_id,
            ..
        } => {
            fields.push(instance_digest.clone());
            fields.push(claim_id.as_str().to_string());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::Permit { .. } => unreachable!("permit digest returned above"),
        PreparedAction::AbortRemoval {
            instance_digest,
            permit_token,
            ..
        } => {
            fields.push(instance_digest.clone());
            fields.push(permit_token.clone());
            fields.push(operation_id.as_str().to_string());
        }
        PreparedAction::RetireAbsent => {
            fields.push(operation_id.as_str().to_string());
        }
    }
    let fields = fields.iter().map(String::as_str).collect::<Vec<_>>();
    digest_fields(&authority.repository, REQUEST_DOMAIN, &fields)
}

pub(super) fn permit_request_digest(
    authority: &Authority,
    operation_id: &OperationIdV1,
    instance_digest: &str,
    retiring_claim_ids: &[OperationIdV1],
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<String, GitCheckoutUseError> {
    let mut fields = vec![
        "permit".to_string(),
        authority.path_digest.clone(),
        instance_digest.to_string(),
        retiring_claim_ids.len().to_string(),
    ];
    fields.extend(
        retiring_claim_ids
            .iter()
            .map(|claim_id| claim_id.as_str().to_string()),
    );
    if policy == GitCheckoutRemovalPolicyV1::DiscardChanges {
        fields.push(policy.as_str().to_string());
    }
    fields.push(operation_id.as_str().to_string());
    let fields = fields.iter().map(String::as_str).collect::<Vec<_>>();
    digest_fields(&authority.repository, REQUEST_DOMAIN, &fields)
}

pub(super) fn prepare_request(
    request: &GitCheckoutUseRequestV1,
) -> Result<PreparedRequest, GitCheckoutUseError> {
    if request.schema_version != GIT_CHECKOUT_USE_SCHEMA_VERSION_V1 {
        return Err(request_error("checkout-use request schema is unsupported"));
    }
    let repository = TrustedLocator::parse(&request.repository_path, "repository path")?;
    let (authority, action) = match &request.action {
        GitCheckoutUseActionV1::ReserveCreation {
            checkout_path,
            owner_id,
        } => {
            let canonical_path = canonical_creation_target(checkout_path)?;
            (
                Authority::from_trusted(&repository, canonical_path)?,
                PreparedAction::Reserve {
                    owner_id: owner_id.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::AbortCreation {
            canonical_path,
            reservation_token,
        } => {
            let canonical_path = TrustedLocator::parse(canonical_path, "canonical checkout path")?;
            let authority = Authority::from_trusted(&repository, canonical_path)?;
            if !authority.valid_oid(reservation_token) {
                return Err(request_error("creation reservation token is invalid"));
            }
            (
                authority,
                PreparedAction::AbortCreation {
                    reservation_token: reservation_token.clone(),
                    quiescent_start: None,
                },
            )
        }
        GitCheckoutUseActionV1::StartCreation {
            canonical_path,
            reservation_token,
        } => {
            let canonical_path = TrustedLocator::parse(canonical_path, "canonical checkout path")?;
            let authority = Authority::from_trusted(&repository, canonical_path)?;
            if !authority.valid_oid(reservation_token) {
                return Err(request_error("creation reservation token is invalid"));
            }
            (
                authority,
                PreparedAction::StartCreation {
                    reservation_token: reservation_token.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::ActivateCreation {
            instance,
            reservation_token,
        } => {
            let (authority, instance_digest, instance) = prepare_instance(&repository, instance)?;
            if !authority.valid_oid(reservation_token) {
                return Err(request_error("creation reservation token is invalid"));
            }
            (
                authority,
                PreparedAction::Activate {
                    instance: instance.into_instance(),
                    instance_digest,
                    reservation_token: reservation_token.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::Claim { instance, owner_id } => {
            let (authority, instance_digest, instance) = prepare_instance(&repository, instance)?;
            (
                authority,
                PreparedAction::Claim {
                    instance: instance.into_instance(),
                    instance_digest,
                    owner_id: owner_id.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::Release { instance, claim_id } => {
            let (authority, instance_digest, _) = prepare_instance(&repository, instance)?;
            (
                authority,
                PreparedAction::Release {
                    instance_digest,
                    claim_id: claim_id.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::AcquireRemovalPermit {
            instance,
            retiring_claim_ids,
            policy,
        } => {
            let (authority, instance_digest, instance) = prepare_instance(&repository, instance)?;
            let retiring_claim_ids = normalize_claim_ids(retiring_claim_ids)?;
            (
                authority,
                PreparedAction::Permit {
                    instance: instance.into_instance(),
                    instance_digest,
                    retiring_claim_ids,
                    policy: *policy,
                },
            )
        }
        GitCheckoutUseActionV1::AbortRemoval {
            instance,
            permit_token,
        } => {
            let (authority, instance_digest, instance) = prepare_instance(&repository, instance)?;
            if !authority.valid_oid(permit_token) {
                return Err(request_error("checkout removal permit token is invalid"));
            }
            (
                authority,
                PreparedAction::AbortRemoval {
                    instance: instance.into_instance(),
                    instance_digest,
                    permit_token: permit_token.clone(),
                },
            )
        }
        GitCheckoutUseActionV1::RetireAbsentCheckout { checkout_path } => {
            let canonical_path = canonical_creation_target(checkout_path)?;
            (
                Authority::from_trusted(&repository, canonical_path)?,
                PreparedAction::RetireAbsent,
            )
        }
    };
    let request_digest = request_digest(&authority, &request.operation_id, &action)?;
    Ok(PreparedRequest {
        authority,
        operation_id: request.operation_id.clone(),
        request_digest,
        action,
    })
}

fn operation_conflict(
    state: &State,
    request: &PreparedRequest,
) -> Result<bool, GitCheckoutUseError> {
    let Some(operation) = find_lifecycle_operation(state, request.operation_id.as_str()) else {
        return Ok(false);
    };
    if operation.request_digest != request.request_digest || operation.kind != request.action.kind()
    {
        return Err(GitCheckoutUseError::new(
            "checkout_use_operation_conflict",
            "checkout-use operation id was replayed with a changed payload",
        ));
    }
    Ok(true)
}

fn claim_wire(claim: &Claim) -> Result<GitCheckoutUseClaimV1, GitCheckoutUseError> {
    Ok(GitCheckoutUseClaimV1 {
        owner_id: OperationIdV1::new(claim.owner_id.clone())
            .map_err(|_| state_error("stored checkout-use owner id is invalid"))?,
        claim_id: OperationIdV1::new(claim.claim_id.clone())
            .map_err(|_| state_error("stored checkout-use claim id is invalid"))?,
        request_digest: claim.request_digest.clone(),
    })
}

pub(super) fn active_claims(
    state: &State,
) -> Result<Vec<GitCheckoutUseClaimV1>, GitCheckoutUseError> {
    state
        .claims
        .values()
        .filter(|claim| claim.is_active())
        .map(claim_wire)
        .collect()
}

fn reservation_receipt(
    authority: &Authority,
    slot: &Slot,
    claim: GitCheckoutUseClaimV1,
) -> Result<GitCheckoutCreationReservationV1, GitCheckoutUseError> {
    Ok(GitCheckoutCreationReservationV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        canonical_path: authority.canonical_path.clone(),
        path_digest: authority.path_digest.clone(),
        reservation_token: slot.token.clone(),
        operation_id: OperationIdV1::new(slot.operation_id.clone())
            .map_err(|_| state_error("stored reservation operation id is invalid"))?,
        request_digest: slot.request_digest.clone(),
        revision: revision(slot.revision)?,
        claim,
    })
}

fn reservation_from_state(
    authority: &Authority,
    state: &State,
) -> Result<GitCheckoutCreationReservationV1, GitCheckoutUseError> {
    let slot = state
        .reservation()
        .ok_or_else(|| state_error("checkout-use state lost its creation reservation"))?;
    let claim = state
        .claims
        .get(&slot.operation_id)
        .ok_or_else(|| state_error("creation reservation lost its initial claim"))?;
    reservation_receipt(authority, slot, claim_wire(claim)?)
}

fn permit_receipt(
    authority: &Authority,
    slot: &Slot,
    instance: &GitCheckoutInstanceV1,
    instance_digest: &str,
    retiring_claims: Vec<GitCheckoutUseClaimV1>,
) -> Result<GitCheckoutRemovalPermitV1, GitCheckoutUseError> {
    Ok(GitCheckoutRemovalPermitV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        canonical_path: authority.canonical_path.clone(),
        path_digest: authority.path_digest.clone(),
        instance: instance.clone(),
        instance_digest: instance_digest.to_string(),
        permit_token: slot.token.clone(),
        operation_id: OperationIdV1::new(slot.operation_id.clone())
            .map_err(|_| state_error("stored permit operation id is invalid"))?,
        request_digest: slot.request_digest.clone(),
        revision: revision(slot.revision)?,
        retiring_claims,
    })
}

pub(super) fn permit_from_state(
    authority: &Authority,
    state: &State,
    instance: &GitCheckoutInstanceV1,
) -> Result<GitCheckoutRemovalPermitV1, GitCheckoutUseError> {
    let slot = state
        .permit()
        .ok_or_else(|| state_error("checkout-use state lost its removal permit"))?;
    let instance_digest = state
        .instance_digest()
        .ok_or_else(|| state_error("checkout-use state lost its instance digest"))?;
    permit_receipt(
        authority,
        slot,
        instance,
        instance_digest,
        active_claims(state)?,
    )
}

pub(super) fn use_receipt(
    operation_id: &str,
    request_digest: &str,
    revision_value: u64,
    phase: GitCheckoutUsePhaseV1,
    outcome: GitCheckoutUseOutcomeV1,
) -> Result<GitCheckoutUseReceiptV1, GitCheckoutUseError> {
    Ok(GitCheckoutUseReceiptV1 {
        schema_version: GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
        operation_id: OperationIdV1::new(operation_id.to_string())
            .map_err(|_| state_error("stored receipt operation id is invalid"))?,
        request_digest: request_digest.to_string(),
        revision: revision(revision_value)?,
        phase,
        outcome,
    })
}

pub(super) struct Plan {
    pub(super) state: Option<State>,
    pub(super) receipt: GitCheckoutUseReceiptV1,
    pub(super) validate_instance: Option<GitCheckoutInstanceV1>,
    pub(super) validate_absent_target: bool,
}

fn reservation_token(
    authority: &Authority,
    operation_id: &str,
    request_digest: &str,
    revision: u64,
) -> Result<String, GitCheckoutUseError> {
    digest_fields(
        &authority.repository,
        RESERVATION_DOMAIN,
        &[
            &authority.path_digest,
            operation_id,
            request_digest,
            &revision.to_string(),
        ],
    )
}

fn permit_token(
    authority: &Authority,
    instance_digest: &str,
    operation_id: &str,
    request_digest: &str,
    revision: u64,
) -> Result<String, GitCheckoutUseError> {
    digest_fields(
        &authority.repository,
        PERMIT_DOMAIN,
        &[
            &authority.path_digest,
            instance_digest,
            operation_id,
            request_digest,
            &revision.to_string(),
        ],
    )
}

fn generation(authority: &Authority, revision: u64, lifecycle: Lifecycle) -> State {
    State {
        revision,
        path_digest: authority.path_digest.clone(),
        lifecycle,
        claims: BTreeMap::new(),
    }
}

pub(super) fn physical_receipt(
    instance: &GitCheckoutInstanceV1,
    kind: TerminalKind,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutUseError> {
    let outcome = match kind {
        TerminalKind::Removed => GitCheckoutRemovalOutcomeV1::Removed,
        TerminalKind::AlreadyAbsent => GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
        TerminalKind::CreationAborted => {
            return Err(state_error(
                "creation-aborted state cannot issue a physical removal receipt",
            ));
        }
    };
    Ok(GitCheckoutRemovalReceiptV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        outcome,
        instance: instance.clone(),
    })
}

pub(super) fn phase_conflict(message: &str) -> GitCheckoutUseError {
    GitCheckoutUseError::new("checkout_use_phase_conflict", message)
}

pub(super) fn instance_conflict() -> GitCheckoutUseError {
    GitCheckoutUseError::new(
        "checkout_use_instance_conflict",
        "checkout-use state belongs to a different exact checkout instance",
    )
}

pub(super) fn reduce_request(
    current: Option<&State>,
    request: &PreparedRequest,
) -> Result<Plan, GitCheckoutUseError> {
    if let Some(state) = current {
        if operation_conflict(state, request)? {
            if matches!(&request.action, PreparedAction::StartCreation { .. }) {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_creation_reconcile_required",
                    "creation already started; inspect the frozen target before reconciling",
                ));
            }
            return Ok(Plan {
                state: None,
                receipt: replay::replay_request(state, request)?,
                validate_instance: match &request.action {
                    PreparedAction::Claim { instance, .. }
                    | PreparedAction::Activate { instance, .. } => Some(instance.clone()),
                    _ => None,
                },
                validate_absent_target: false,
            });
        }
    }
    let base_revision = current.map_or(0, |state| state.revision);
    match &request.action {
        PreparedAction::Reserve { owner_id } => {
            if current.is_some_and(|state| state.phase() != Phase::Removed) {
                return Err(phase_conflict(
                    "checkout creation cannot be reserved in the current phase",
                ));
            }
            let new_revision = next_revision(base_revision)?;
            let token = reservation_token(
                &request.authority,
                request.operation_id.as_str(),
                &request.request_digest,
                new_revision,
            )?;
            let slot = Slot {
                token,
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            let claim = Claim {
                owner_id: owner_id.as_str().to_string(),
                claim_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                acquire_revision: new_revision,
                state: ClaimState::Active,
            };
            let claim_receipt = claim_wire(&claim)?;
            let mut state = generation(
                &request.authority,
                new_revision,
                Lifecycle::Creating(CreatingState::Reserved(slot.clone())),
            );
            state.claims.insert(claim.claim_id.clone(), claim);
            let reservation = reservation_receipt(&request.authority, &slot, claim_receipt)?;
            Ok(Plan {
                state: Some(state),
                receipt: use_receipt(
                    &slot.operation_id,
                    &slot.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Creating,
                    GitCheckoutUseOutcomeV1::CreationReserved { reservation },
                )?,
                validate_instance: None,
                validate_absent_target: true,
            })
        }
        PreparedAction::AbortCreation {
            reservation_token,
            quiescent_start,
        } => creation::abort(
            current,
            request,
            reservation_token,
            quiescent_start.as_ref(),
        ),
        PreparedAction::StartCreation { reservation_token } => {
            let state = current
                .ok_or_else(|| phase_conflict("checkout creation has no reservation to start"))?;
            if state.phase() != Phase::Creating {
                return Err(phase_conflict(
                    "checkout creation cannot start in the current phase",
                ));
            }
            let reservation = state
                .reservation()
                .ok_or_else(|| state_error("creating state lost its reservation"))?;
            if reservation.token != *reservation_token {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_operation_conflict",
                    "creation start did not consume the exact reservation token",
                ));
            }
            if state.creation_start().is_some() {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_creation_reconcile_required",
                    "creation already started; inspect the frozen target before reconciling",
                ));
            }
            let new_revision = next_revision(state.revision)?;
            let mut next = state.clone();
            next.revision = new_revision;
            let creation_start = Slot {
                token: reservation_token.clone(),
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            next.lifecycle = Lifecycle::Creating(CreatingState::Started {
                reservation: reservation.clone(),
                start: creation_start.clone(),
            });
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &creation_start.operation_id,
                    &creation_start.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Creating,
                    GitCheckoutUseOutcomeV1::CreationStarted,
                )?,
                validate_instance: None,
                validate_absent_target: true,
            })
        }
        PreparedAction::Activate {
            instance,
            instance_digest,
            reservation_token,
        } => {
            let state = current.ok_or_else(|| {
                phase_conflict("checkout creation has no reservation to activate")
            })?;
            if state.phase() != Phase::Creating {
                return Err(phase_conflict(
                    "checkout creation cannot be activated in the current phase",
                ));
            }
            let slot = state
                .creation_start()
                .ok_or_else(|| phase_conflict("checkout creation has not started"))?;
            let reservation = state
                .reservation()
                .ok_or_else(|| state_error("creating state lost its reservation"))?;
            if slot.token != *reservation_token
                || reservation.token != *reservation_token
                || instance.canonical_path != request.authority.canonical_path
            {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_operation_conflict",
                    "creation activation did not consume the exact reservation",
                ));
            }
            let new_revision = next_revision(state.revision)?;
            let claim = reservation_from_state(&request.authority, state)?.claim;
            let mut next = state.clone();
            next.revision = new_revision;
            let activation = OperationMarker {
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            next.lifecycle = Lifecycle::Active {
                instance_digest: instance_digest.clone(),
                creation: Some(CreationHistory {
                    reservation: reservation.clone(),
                    start: slot.clone(),
                    activation: activation.clone(),
                }),
                removal: ActiveRemoval::Idle,
            };
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &activation.operation_id,
                    &activation.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Active,
                    GitCheckoutUseOutcomeV1::CreationActivated {
                        instance_digest: instance_digest.clone(),
                        claim,
                    },
                )?,
                validate_instance: Some(instance.clone()),
                validate_absent_target: false,
            })
        }
        PreparedAction::Claim {
            instance,
            instance_digest,
            owner_id,
        } => {
            let start_new_generation = match current {
                None => true,
                Some(state) if state.phase() == Phase::Removed => true,
                Some(state) if state.phase() == Phase::Active => {
                    if state.instance_digest() == Some(instance_digest) {
                        false
                    } else {
                        return Err(instance_conflict());
                    }
                }
                Some(_) => {
                    return Err(phase_conflict(
                        "checkout use cannot be claimed in the current phase",
                    ));
                }
            };
            let new_revision = next_revision(base_revision)?;
            let mut next = if start_new_generation {
                generation(
                    &request.authority,
                    new_revision,
                    Lifecycle::Active {
                        instance_digest: instance_digest.clone(),
                        creation: None,
                        removal: ActiveRemoval::Idle,
                    },
                )
            } else {
                let mut state = current.expect("active state checked above").clone();
                state.revision = new_revision;
                let Lifecycle::Active {
                    instance_digest,
                    creation,
                    ..
                } = &state.lifecycle
                else {
                    unreachable!("active phase is represented by active lifecycle");
                };
                state.lifecycle = Lifecycle::Active {
                    instance_digest: instance_digest.clone(),
                    creation: creation.clone(),
                    removal: ActiveRemoval::Idle,
                };
                state
            };
            if next.claims.len() >= MAX_CLAIMS
                || active_claims(&next)?.len() >= MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1
            {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_capacity_exceeded",
                    "checkout-use claim ledger reached its explicit bound",
                ));
            }
            let claim = Claim {
                owner_id: owner_id.as_str().to_string(),
                claim_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                acquire_revision: new_revision,
                state: ClaimState::Active,
            };
            let receipt_operation_id = claim.claim_id.clone();
            let receipt_request_digest = claim.request_digest.clone();
            let claim_receipt = claim_wire(&claim)?;
            next.claims.insert(claim.claim_id.clone(), claim);
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &receipt_operation_id,
                    &receipt_request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Active,
                    GitCheckoutUseOutcomeV1::ClaimAcquired {
                        instance_digest: instance_digest.clone(),
                        claim: claim_receipt,
                    },
                )?,
                validate_instance: Some(instance.clone()),
                validate_absent_target: false,
            })
        }
        PreparedAction::Release {
            instance_digest,
            claim_id,
        } => {
            let state = current.ok_or_else(|| {
                GitCheckoutUseError::new(
                    "checkout_use_claim_missing",
                    "checkout-use claim does not exist",
                )
            })?;
            if state.phase() != Phase::Active {
                return Err(phase_conflict(
                    "checkout-use claim cannot be released in the current phase",
                ));
            }
            if state.instance_digest() != Some(instance_digest) {
                return Err(instance_conflict());
            }
            let stored = state.claims.get(claim_id.as_str()).ok_or_else(|| {
                GitCheckoutUseError::new(
                    "checkout_use_claim_missing",
                    "checkout-use claim does not exist",
                )
            })?;
            let claim = claim_wire(stored)?;
            if let Some(release) = stored.release() {
                return Ok(Plan {
                    state: None,
                    receipt: use_receipt(
                        &release.operation_id,
                        &release.request_digest,
                        release.revision,
                        GitCheckoutUsePhaseV1::Active,
                        GitCheckoutUseOutcomeV1::ClaimReleased {
                            instance_digest: instance_digest.clone(),
                            claim,
                        },
                    )?,
                    validate_instance: None,
                    validate_absent_target: false,
                });
            }
            let new_revision = next_revision(state.revision)?;
            let mut next = state.clone();
            let (lifecycle_instance_digest, lifecycle_creation) = match &next.lifecycle {
                Lifecycle::Active {
                    instance_digest,
                    creation,
                    ..
                } => (instance_digest.clone(), creation.clone()),
                _ => unreachable!("active phase is represented by active lifecycle"),
            };
            next.lifecycle = Lifecycle::Active {
                instance_digest: lifecycle_instance_digest,
                creation: lifecycle_creation,
                removal: ActiveRemoval::Idle,
            };
            let release = OperationMarker {
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            let stored = next
                .claims
                .get_mut(claim_id.as_str())
                .expect("claim checked above");
            stored.state = ClaimState::Released(release.clone());
            next.revision = new_revision;
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &release.operation_id,
                    &release.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Active,
                    GitCheckoutUseOutcomeV1::ClaimReleased {
                        instance_digest: instance_digest.clone(),
                        claim,
                    },
                )?,
                validate_instance: None,
                validate_absent_target: false,
            })
        }
        PreparedAction::Permit {
            instance,
            instance_digest,
            retiring_claim_ids,
            policy: _,
        } => {
            let mut retiring_claims = Vec::new();
            let start_new_generation = match current {
                None => {
                    if !retiring_claim_ids.is_empty() {
                        return Err(GitCheckoutUseError::new(
                            "checkout_use_in_use",
                            "retiring claims do not match the active checkout uses",
                        ));
                    }
                    true
                }
                Some(state) if state.phase() == Phase::Removed => {
                    if !retiring_claim_ids.is_empty() {
                        return Err(GitCheckoutUseError::new(
                            "checkout_use_in_use",
                            "retiring claims do not match the active checkout uses",
                        ));
                    }
                    true
                }
                Some(state) if state.phase() == Phase::Active => {
                    if state.instance_digest() == Some(instance_digest) {
                        retiring_claims = active_claims(state)?;
                        let active_ids = retiring_claims
                            .iter()
                            .map(|claim| claim.claim_id.clone())
                            .collect::<Vec<_>>();
                        if active_ids != *retiring_claim_ids {
                            return Err(GitCheckoutUseError::new(
                                "checkout_use_in_use",
                                "retiring claims do not match the active checkout uses",
                            ));
                        }
                        false
                    } else {
                        return Err(instance_conflict());
                    }
                }
                Some(_) => {
                    return Err(phase_conflict(
                        "checkout removal cannot be permitted in the current phase",
                    ));
                }
            };
            let new_revision = next_revision(base_revision)?;
            let token = permit_token(
                &request.authority,
                instance_digest,
                request.operation_id.as_str(),
                &request.request_digest,
                new_revision,
            )?;
            let slot = Slot {
                token,
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            let next = if start_new_generation {
                generation(
                    &request.authority,
                    new_revision,
                    Lifecycle::Removing {
                        instance_digest: instance_digest.clone(),
                        creation: None,
                        permit: slot.clone(),
                        progress: RemovalProgress::Permitted,
                    },
                )
            } else {
                let mut state = current.expect("active state checked above").clone();
                state.revision = new_revision;
                let Lifecycle::Active {
                    instance_digest,
                    creation,
                    ..
                } = &state.lifecycle
                else {
                    unreachable!("active phase is represented by active lifecycle");
                };
                state.lifecycle = Lifecycle::Removing {
                    instance_digest: instance_digest.clone(),
                    creation: creation.clone(),
                    permit: slot.clone(),
                    progress: RemovalProgress::Permitted,
                };
                state
            };
            let permit = permit_receipt(
                &request.authority,
                &slot,
                instance,
                instance_digest,
                retiring_claims.clone(),
            )?;
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &slot.operation_id,
                    &slot.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Removing,
                    GitCheckoutUseOutcomeV1::RemovalPermitted { permit },
                )?,
                validate_instance: Some(instance.clone()),
                validate_absent_target: false,
            })
        }
        PreparedAction::AbortRemoval {
            instance,
            instance_digest,
            permit_token,
        } => {
            let state =
                current.ok_or_else(|| phase_conflict("checkout removal has no permit to abort"))?;
            if state.phase() != Phase::Removing {
                return Err(phase_conflict(
                    "checkout removal cannot be aborted in the current phase",
                ));
            }
            if state.instance_digest() != Some(instance_digest) {
                return Err(instance_conflict());
            }
            if state.physical().is_some() {
                return Err(phase_conflict(
                    "checkout removal cannot be aborted after physical execution started",
                ));
            }
            let slot = state
                .permit()
                .ok_or_else(|| state_error("removing state lost its permit"))?;
            if slot.token != *permit_token {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_operation_conflict",
                    "removal abort did not consume the exact permit",
                ));
            }
            let permit = permit_from_state(&request.authority, state, instance)?;
            let new_revision = next_revision(state.revision)?;
            let mut next = state.clone();
            next.revision = new_revision;
            let abort = Slot {
                token: permit_token.clone(),
                operation_id: request.operation_id.as_str().to_string(),
                request_digest: request.request_digest.clone(),
                revision: new_revision,
            };
            let Lifecycle::Removing {
                instance_digest,
                creation,
                permit: permit_slot,
                ..
            } = &next.lifecycle
            else {
                unreachable!("removing phase is represented by removing lifecycle");
            };
            next.lifecycle = Lifecycle::Active {
                instance_digest: instance_digest.clone(),
                creation: creation.clone(),
                removal: ActiveRemoval::Aborted {
                    permit: permit_slot.clone(),
                    abort: abort.clone(),
                },
            };
            compact_released_claims(&mut next);
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    &abort.operation_id,
                    &abort.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Active,
                    GitCheckoutUseOutcomeV1::RemovalAborted {
                        permit: permit.clone(),
                    },
                )?,
                validate_instance: None,
                validate_absent_target: false,
            })
        }
        PreparedAction::RetireAbsent => {
            let state = current
                .ok_or_else(|| phase_conflict("no checkout-use generation to retire as absent"))?;
            let Lifecycle::Active {
                instance_digest,
                creation,
                ..
            } = &state.lifecycle
            else {
                return Err(phase_conflict(
                    "only an active checkout generation can be retired as absent",
                ));
            };
            if state.claims.values().any(Claim::is_active) {
                return Err(GitCheckoutUseError::new(
                    "checkout_use_in_use",
                    "an absent checkout cannot be retired while claims are active",
                ));
            }
            // The generation ends through the same removal shape a physical
            // removal leaves behind: one permit and one execution marker. Each
            // record carries its own derived id because lifecycle records never
            // share one; the retirement request itself is never replayed.
            let new_revision = next_revision(state.revision)?;
            let permit_id = format!("{}:permit", request.operation_id.as_str());
            let physical_id = format!("{}:physical", request.operation_id.as_str());
            let token = permit_token(
                &request.authority,
                instance_digest,
                &permit_id,
                &request.request_digest,
                new_revision,
            )?;
            let mut next = state.clone();
            next.revision = new_revision;
            next.lifecycle =
                Lifecycle::Removed(RemovedState::Physical(Box::new(PhysicalRemovedState {
                    instance_digest: instance_digest.clone(),
                    creation: creation.clone(),
                    permit: Slot {
                        token,
                        operation_id: permit_id,
                        request_digest: request.request_digest.clone(),
                        revision: new_revision,
                    },
                    physical: OperationMarker {
                        operation_id: physical_id,
                        request_digest: request.request_digest.clone(),
                        revision: new_revision,
                    },
                    outcome: PhysicalOutcome::AlreadyAbsent,
                })));
            compact_released_claims(&mut next);
            Ok(Plan {
                state: Some(next),
                receipt: use_receipt(
                    request.operation_id.as_str(),
                    &request.request_digest,
                    new_revision,
                    GitCheckoutUsePhaseV1::Removed,
                    GitCheckoutUseOutcomeV1::AbsentCheckoutRetired {
                        instance_digest: instance_digest.clone(),
                    },
                )?,
                validate_instance: None,
                validate_absent_target: true,
            })
        }
    }
}
