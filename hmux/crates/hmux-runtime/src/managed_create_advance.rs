#[cfg(unix)]
use crate::runtime_diagnostics::broker_timing::{self, Phase};
use hmux_client::LocalSessionCatalog;
use hmux_client::recovery_journal::{
    managed_create_ledger::{
        self, ManagedCreateAdmissionError, ManagedCreateSuccessorIdentity,
        ManagedCreateSuccessorLedgerState, ManagedCreateSuccessorTraversal,
    },
    request_fingerprint,
};
use hmux_runtime_contract::{
    MANAGED_CONVERSATION_WRITER_CONFLICT_CODE, MANAGED_CREATE_RETIRED_EXACT_CODE,
    MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE, MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest,
    ManagedCreateReconcileBrokerResponse, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedRehostSourceRecipe, ManagedStopRequest, read_managed_create_advance_request,
    write_managed_create_advance_response,
};
use std::io;

#[path = "managed_create_advance/replacement.rs"]
mod replacement;

const AUTHORITY_UNAVAILABLE_CODE: &str = "hmux_managed_create_advance_authority_unavailable";
const AUTHORITY_INCONSISTENT_CODE: &str = "hmux_managed_create_advance_authority_inconsistent";
const MAX_SAME_SHARD_SUCCESSOR_CANDIDATES: u32 = 65_536;

pub(crate) fn broker() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let request = match read_managed_create_advance_request(&mut io::stdin()) {
        Ok(request) => request,
        Err(error) => {
            let response = ManagedCreateAdvanceBrokerResponse::refused(
                hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE,
                error.to_string(),
            );
            write_managed_create_advance_response(&mut io::stdout(), &response)?;
            return Ok(());
        }
    };
    #[cfg(unix)]
    let timing = broker_timing::begin(request.request());
    let response = execute(request);
    let published = {
        #[cfg(unix)]
        let _phase = broker_timing::phase(Phase::ResponsePublish);
        write_managed_create_advance_response(&mut io::stdout(), &response)
    };
    #[cfg(unix)]
    timing.finish(&response, published.is_ok());
    published?;
    Ok(())
}

fn execute(request: ManagedCreateAdvanceRequest) -> ManagedCreateAdvanceBrokerResponse {
    let replace_current = request.replaces_current();
    let request = request.into_request();
    if replace_current {
        return replacement::execute(request);
    }
    execute_advance(request)
}

fn execute_advance(mut current_request: ManagedCreateRequest) -> ManagedCreateAdvanceBrokerResponse {
    let mut catalog = None;
    let mut traversal = ManagedCreateSuccessorTraversal::default();
    let mut hop = 0_usize;
    let mut durable_effect = false;
    let mut current_edge_created_by_call = false;

    loop {
        if hop >= MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES {
            return ManagedCreateAdvanceBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                format!(
                    "hmux_managed_create_successor_capacity: successor chain exceeds {MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES} identities"
                ),
            );
        }
        let current_identity = match ManagedCreateReconcileRequest::new(
            current_request.idempotency_key(),
            current_request.session_id(),
            current_request.workspace_id(),
        ) {
            Ok(identity) => identity,
            Err(error) => {
                return ManagedCreateAdvanceBrokerResponse::refused(
                    hmux_runtime_contract::MANAGED_CREATE_REQUEST_INVALID_CODE,
                    error.to_string(),
                );
            }
        };
        if !traversal.visit(&current_identity) {
            return ManagedCreateAdvanceBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                "managed create successor chain contains an identity cycle",
            );
        }

        let launch = if hop == 0 {
            super::launch_managed(current_request.clone())
        } else {
            super::launch_managed_successor(current_request.clone())
        };
        let mut canonical_source_changed = false;
        let mut exact_exited = None;
        let mut writer_conflict = None;
        match launch {
            Ok(receipt) => {
                return if hop == 0 {
                    ManagedCreateAdvanceBrokerResponse::Current(Box::new(receipt))
                } else {
                    ManagedCreateAdvanceBrokerResponse::Advanced(Box::new(receipt))
                };
            }
            Err(error)
                if super::managed_create_failure::canonical_source_changed(error.as_ref()) =>
            {
                if hop != 0 {
                    return ManagedCreateAdvanceBrokerResponse::refused(
                        AUTHORITY_INCONSISTENT_CODE,
                        "managed create successor changed its immutable canonical request",
                    );
                }
                canonical_source_changed = true;
            }
            Err(error)
                if super::managed_create_failure::successor_lineage_conflict(error.as_ref()) =>
            {
                return ManagedCreateAdvanceBrokerResponse::refused(
                    AUTHORITY_INCONSISTENT_CODE,
                    error.to_string(),
                );
            }
            Err(error) => match super::managed_create_failure::admission_code(error.as_ref()) {
                Some(MANAGED_CREATE_RETIRED_EXACT_CODE) if current_edge_created_by_call => {
                    return newly_created_successor_requires_retry(
                        "the newly created managed successor was already retired",
                    );
                }
                Some(MANAGED_CREATE_RETIRED_EXACT_CODE) => {}
                Some(MANAGED_CONVERSATION_WRITER_CONFLICT_CODE) => {
                    writer_conflict = Some(error.to_string());
                }
                Some(code) => {
                    return admission_launch_failure(durable_effect, code, error.to_string());
                }
                None => match super::managed_create_failure::exact_exited_generation(error.as_ref())
                {
                    Some(_) if current_edge_created_by_call => {
                        return newly_created_successor_requires_retry(
                            "the newly created managed successor exited before advance completed",
                        );
                    }
                    Some(exited) => exact_exited = Some(exited.clone()),
                    None => {
                        return transient_launch_failure(
                            durable_effect,
                            super::managed_create_failure::failure_code(error.as_ref())
                                .unwrap_or("hmux_managed_launch_failed"),
                            error.to_string(),
                        );
                    }
                },
            },
        }

        if catalog.is_none() {
            catalog = Some(match exact_exited.as_ref() {
                Some(exited) => LocalSessionCatalog::new(exited.receipt().discovery_root()),
                None => match LocalSessionCatalog::from_environment() {
                    Ok(catalog) => catalog,
                    Err(error) => {
                        return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                            AUTHORITY_UNAVAILABLE_CODE,
                            error.to_string(),
                        );
                    }
                },
            });
        }
        let discovery_root = catalog
            .as_ref()
            .expect("managed create advance initializes its catalog")
            .discovery_root();
        let stop_request = if let Some(exited) = exact_exited.as_ref() {
            Some(exited.stop_request().clone())
        } else {
            let reconciled =
                super::managed_create_reconcile::reconcile(discovery_root, &current_identity);
            if current_edge_created_by_call
                && matches!(
                    reconciled,
                    ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
                        | ManagedCreateReconcileBrokerResponse::Retired
                )
            {
                return newly_created_successor_requires_retry(
                    "the newly created managed successor became terminal before advance completed",
                );
            }
            if let Some(message) = writer_conflict.as_ref() {
                match reconciled {
                    ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
                    | ManagedCreateReconcileBrokerResponse::Retired => durable_effect = true,
                    ManagedCreateReconcileBrokerResponse::Completed(_) if hop == 0 => {}
                    _ if hop == 0 && !durable_effect => {
                        return ManagedCreateAdvanceBrokerResponse::refused(
                            MANAGED_CONVERSATION_WRITER_CONFLICT_CODE,
                            message.clone(),
                        );
                    }
                    _ => {
                        return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                            AUTHORITY_UNAVAILABLE_CODE,
                            message.clone(),
                        );
                    }
                }
            }
            match reconciled {
                ManagedCreateReconcileBrokerResponse::Completed(receipt)
                    if hop == 0 && (canonical_source_changed || writer_conflict.is_some()) =>
                {
                    match completed_source_stop_request(
                        discovery_root,
                        &current_identity,
                        receipt.as_ref(),
                    ) {
                        Ok(request) => Some(request),
                        Err(message) => {
                            return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                                AUTHORITY_UNAVAILABLE_CODE,
                                message,
                            );
                        }
                    }
                }
                ManagedCreateReconcileBrokerResponse::Completed(_) => {
                    return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                        AUTHORITY_UNAVAILABLE_CODE,
                        "completed managed create source lacks exact retirement authority",
                    );
                }
                ManagedCreateReconcileBrokerResponse::Pending => {
                    return ManagedCreateAdvanceBrokerResponse::Pending;
                }
                ManagedCreateReconcileBrokerResponse::NotFound => {
                    return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                        AUTHORITY_UNAVAILABLE_CODE,
                        "managed create chain identity disappeared before terminal advance",
                    );
                }
                ManagedCreateReconcileBrokerResponse::AuthorityUnavailable(authority) => {
                    return ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(authority);
                }
                ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
                | ManagedCreateReconcileBrokerResponse::Retired => {
                    durable_effect = true;
                    None
                }
            }
        };
        let successor_intent = {
            let mut candidate = 0;
            let (successor, created_by_call) = match managed_create_ledger::reserve_successor_intent_with_conversation(
                discovery_root,
                &current_identity,
                current_request.conversation_identity(),
                || allocate_successor(&current_request, &mut candidate),
            ) {
                Ok(ManagedCreateSuccessorLedgerState::Existing(successor)) => (successor, false),
                Ok(ManagedCreateSuccessorLedgerState::ExistingUnavailable {
                    successor,
                    error,
                }) => {
                    if let Err(error) = prepare_successor(&current_request, successor) {
                        return admission_failure(error, true);
                    }
                    return admission_failure(*error, true);
                }
                Ok(ManagedCreateSuccessorLedgerState::Created(successor)) => (successor, true),
                Ok(ManagedCreateSuccessorLedgerState::Pending) => {
                    return ManagedCreateAdvanceBrokerResponse::Pending;
                }
                Ok(ManagedCreateSuccessorLedgerState::Closed) => {
                    return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                        AUTHORITY_UNAVAILABLE_CODE,
                        "managed create successor allocation was closed by durable cleanup",
                    );
                }
                Ok(ManagedCreateSuccessorLedgerState::NotFound) => {
                    return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                        AUTHORITY_UNAVAILABLE_CODE,
                        "managed create chain identity disappeared before successor intent",
                    );
                }
                Err(error) => return admission_failure(error, durable_effect),
            };
            durable_effect |= created_by_call;
            let prepared = match prepare_successor(&current_request, successor) {
                Ok(prepared) => prepared,
                Err(error) => return admission_failure(error, durable_effect),
            };
            if let Err(error) = persist_successor_policy_projection(
                discovery_root,
                &current_identity,
                &prepared,
            ) {
                return admission_failure(error, durable_effect);
            }
            (prepared, created_by_call)
        };
        inject_advance_fault("after_successor_intent_before_source_retirement");
        if let Some(stop_request) = stop_request {
            if let Err(error) = super::stop_managed_provider(&stop_request) {
                return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                    AUTHORITY_UNAVAILABLE_CODE,
                    error.to_string(),
                );
            }
            durable_effect = true;
        }
        inject_advance_fault("after_source_retirement_before_successor");

        let (successor, reserved_after_terminal) = match managed_create_ledger::reserve_terminal_successor_with_conversation(
            discovery_root,
            &current_identity,
            current_request.conversation_identity(),
            || Ok(successor_intent.0.identity.clone()),
        ) {
            Ok(ManagedCreateSuccessorLedgerState::Existing(successor)) => (successor, false),
            Ok(ManagedCreateSuccessorLedgerState::ExistingUnavailable {
                successor,
                error,
            }) => {
                if let Err(error) = prepare_successor(&current_request, successor) {
                    return admission_failure(error, true);
                }
                return admission_failure(*error, true);
            }
            Ok(ManagedCreateSuccessorLedgerState::Created(successor)) => (successor, true),
            Ok(ManagedCreateSuccessorLedgerState::Pending) => {
                return ManagedCreateAdvanceBrokerResponse::Pending;
            }
            Ok(ManagedCreateSuccessorLedgerState::Closed) => {
                return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                    AUTHORITY_UNAVAILABLE_CODE,
                    "managed create successor allocation was closed by durable cleanup",
                );
            }
            Ok(ManagedCreateSuccessorLedgerState::NotFound) => {
                return ManagedCreateAdvanceBrokerResponse::authority_unavailable(
                    AUTHORITY_UNAVAILABLE_CODE,
                    "managed create chain identity disappeared before successor reservation",
                );
            }
            Err(error) => return admission_failure(error, durable_effect),
        };
        durable_effect = true;
        if successor_intent.0.identity.session_id() != successor.session_id()
            || successor_intent.0.identity.idempotency_key() != successor.idempotency_key()
        {
            return ManagedCreateAdvanceBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                "managed create successor identity changed across source retirement",
            );
        }
        let prepared = match prepare_successor(&current_request, successor) {
            Ok(prepared) => prepared,
            Err(error) => return admission_failure(error, durable_effect),
        };
        if let Err(error) = persist_successor_policy_projection(
            discovery_root,
            &current_identity,
            &prepared,
        ) {
            return admission_failure(error, durable_effect);
        }

        pause_after_successor_persist_for_test();
        inject_advance_fault("after_successor_persist_before_target_create");
        current_request = prepared.target;
        current_edge_created_by_call = reserved_after_terminal || successor_intent.1;
        hop += 1;
    }
}

fn completed_source_stop_request(
    discovery_root: &std::path::Path,
    source_identity: &ManagedCreateReconcileRequest,
    expected_receipt: &hmux_runtime_contract::ManagedCreateReceipt,
) -> Result<ManagedStopRequest, String> {
    let evidence = managed_create_ledger::completed_generation_evidence(
        discovery_root,
        source_identity,
    )
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "completed managed-create source evidence disappeared".to_string())?;
    if evidence.receipt() != expected_receipt
        || evidence.receipt().discovery_root() != discovery_root
    {
        return Err("completed managed-create source evidence changed".to_string());
    }
    super::managed_create_failure::exact_stop_request(&evidence)
        .map_err(|error| error.to_string())
}

#[cfg(debug_assertions)]
fn inject_advance_fault(point: &str) {
    if std::env::var("HMUX_TEST_MANAGED_CREATE_ADVANCE_FAULT").as_deref() == Ok(point) {
        std::process::exit(86);
    }
}

#[cfg(not(debug_assertions))]
fn inject_advance_fault(_point: &str) {}

#[cfg(debug_assertions)]
fn pause_after_successor_persist_for_test() {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::time::{Duration, Instant};

    let Some(marker) = std::env::var_os("HMUX_TEST_MANAGED_CREATE_ADVANCE_PAUSE_MARKER") else {
        return;
    };
    let marker = std::path::PathBuf::from(marker);
    if !marker.is_absolute() {
        std::process::exit(87);
    }
    let mut published = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return,
        Err(_) => std::process::exit(87),
    };
    if published.write_all(b"paused").is_err() || published.sync_all().is_err() {
        std::process::exit(87);
    }
    let resume = marker.with_extension("resume");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !resume.try_exists().unwrap_or(false) {
        if Instant::now() >= deadline {
            std::process::exit(87);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(debug_assertions))]
fn pause_after_successor_persist_for_test() {}

fn allocate_successor(
    source_request: &ManagedCreateRequest,
    next_candidate: &mut u32,
) -> Result<ManagedCreateSuccessorIdentity, ManagedCreateAdmissionError> {
    source_request.validate().map_err(|error| error.to_string())?;
    let request_without_colors = source_request
        .clone()
        .with_terminal_default_colors_option(None)
        .map_err(|error| format!("managed create successor identity failed: {error}"))?;
    let serialized_request = serde_json::to_string(&request_without_colors)
        .map_err(|error| format!("managed create successor identity failed: {error}"))?;
    let source = ManagedCreateReconcileRequest::new(
        source_request.idempotency_key(),
        source_request.session_id(),
        source_request.workspace_id(),
    )
    .map_err(|error| error.to_string())?;
    while *next_candidate < MAX_SAME_SHARD_SUCCESSOR_CANDIDATES {
        let candidate = *next_candidate;
        *next_candidate += 1;
        let candidate = candidate.to_string();
        let session_digest = request_fingerprint(&[
            "managed-create-successor-session-identity-v2",
            source_request.workspace_id(),
            source_request.session_id(),
            source_request.idempotency_key(),
            &serialized_request,
            &candidate,
        ]);
        let session_id = format!("session_{}", &session_digest[..32]);
        if managed_create_ledger::successor_session_shares_create_shard(&source, &session_id)? {
            let idempotency_digest = request_fingerprint(&[
                "managed-create-successor-idempotency-identity-v2",
                source_request.workspace_id(),
                source_request.session_id(),
                source_request.idempotency_key(),
                &serialized_request,
                &candidate,
            ]);
            let idempotency_key = format!("create_{}", &idempotency_digest[..32]);
            let target = source_request
                .retarget_identity(&idempotency_key, &session_id)
                .map_err(|error| error.to_string())?;
            let digests = successor_policy_digests(&target)?;
            let canonical_rehost_recipe = ManagedRehostSourceRecipe::from_create_request(&target)
                .map_err(|error| error.to_string())?
                .map(|recipe| {
                    serde_json::to_string(&recipe).map_err(|error| {
                        format!("managed create successor policy encode failed: {error}")
                    })
                })
                .transpose()?;
            return ManagedCreateSuccessorIdentity::with_target_policy(
                session_id,
                idempotency_key,
                digests.request,
                digests.canonical_request,
                digests.rehost_recipe,
                canonical_rehost_recipe,
                target.conversation_identity().cloned(),
            );
        }
    }
    Err(ManagedCreateAdmissionError::Ledger(
        "hmux_managed_create_successor_capacity: bounded same-shard identity allocation exhausted"
            .to_string(),
    ))
}

struct PreparedSuccessor {
    identity: ManagedCreateSuccessorIdentity,
    target: ManagedCreateRequest,
    digests: SuccessorPolicyDigests,
}

fn prepare_successor(
    source_request: &ManagedCreateRequest,
    identity: ManagedCreateSuccessorIdentity,
) -> Result<PreparedSuccessor, ManagedCreateAdmissionError> {
    let target = source_request
        .retarget_identity(identity.idempotency_key(), identity.session_id())
        .map_err(|error| error.to_string())?;
    let digests = successor_policy_digests(&target)?;
    identity.ensure_request_policy_digests(
        &digests.request,
        &digests.canonical_request,
        digests.rehost_recipe.as_deref(),
    )?;
    Ok(PreparedSuccessor {
        identity,
        target,
        digests,
    })
}

fn persist_successor_policy_projection(
    discovery_root: &std::path::Path,
    source: &ManagedCreateReconcileRequest,
    prepared: &PreparedSuccessor,
) -> Result<(), ManagedCreateAdmissionError> {
    managed_create_ledger::ensure_successor_digest_projection(
        discovery_root,
        source,
        &prepared.identity,
        &prepared.digests.canonical_request,
        prepared.digests.rehost_recipe.as_deref(),
    )
}

struct SuccessorPolicyDigests {
    request: String,
    canonical_request: String,
    rehost_recipe: Option<String>,
}

fn successor_policy_digests(
    request: &ManagedCreateRequest,
) -> Result<SuccessorPolicyDigests, ManagedCreateAdmissionError> {
    request.validate().map_err(|error| error.to_string())?;
    let request_without_colors = request
        .clone()
        .with_terminal_default_colors_option(None)
        .map_err(|error| format!("managed create successor digest failed: {error}"))?;
    let serialized_request = serde_json::to_string(&request_without_colors)
        .map_err(|error| format!("managed create successor digest failed: {error}"))?;
    let canonical_request = request
        .canonical_create_identity_json()
        .map_err(|error| format!("managed create successor digest failed: {error}"))?;
    let rehost_recipe = request
        .managed_rehost_recipe()
        .map(|recipe| {
            serde_json::to_string(recipe)
                .map(|serialized| request_fingerprint(&[&serialized]))
                .map_err(|error| format!("managed create successor digest failed: {error}"))
        })
        .transpose()?;
    Ok(SuccessorPolicyDigests {
        request: request_fingerprint(&[&serialized_request]),
        canonical_request: request_fingerprint(&[&canonical_request]),
        rehost_recipe,
    })
}

fn newly_created_successor_requires_retry(
    message: &str,
) -> ManagedCreateAdvanceBrokerResponse {
    ManagedCreateAdvanceBrokerResponse::authority_unavailable(AUTHORITY_UNAVAILABLE_CODE, message)
}

fn admission_failure(
    error: ManagedCreateAdmissionError,
    durable_effect: bool,
) -> ManagedCreateAdvanceBrokerResponse {
    match error.code() {
        Some(hmux_runtime_contract::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE) => {
            ManagedCreateAdvanceBrokerResponse::refused(
                hmux_runtime_contract::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE,
                error.to_string(),
            )
        }
        Some(code) if !durable_effect => {
            ManagedCreateAdvanceBrokerResponse::refused(code, error.to_string())
        }
        Some(_) | None => ManagedCreateAdvanceBrokerResponse::authority_unavailable(
            AUTHORITY_UNAVAILABLE_CODE,
            error.to_string(),
        ),
    }
}

fn admission_launch_failure(
    durable_effect: bool,
    code: &str,
    message: String,
) -> ManagedCreateAdvanceBrokerResponse {
    if durable_effect {
        ManagedCreateAdvanceBrokerResponse::authority_unavailable(
            AUTHORITY_UNAVAILABLE_CODE,
            message,
        )
    } else {
        ManagedCreateAdvanceBrokerResponse::refused(code, message)
    }
}

fn transient_launch_failure(
    durable_effect: bool,
    code: &'static str,
    message: String,
) -> ManagedCreateAdvanceBrokerResponse {
    if durable_effect {
        ManagedCreateAdvanceBrokerResponse::authority_unavailable(
            AUTHORITY_UNAVAILABLE_CODE,
            message,
        )
    } else {
        ManagedCreateAdvanceBrokerResponse::retryable(code, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_runtime_contract::{PermissionMode, TerminalDefaultColors};

    fn request(command: &str) -> ManagedCreateRequest {
        ManagedCreateRequest::new(
            "create-source",
            "session-source",
            "workspace-source",
            "fixture",
            PermissionMode::Default,
            "/tmp",
            vec![command.to_string()],
            24,
            80,
        )
        .unwrap()
    }

    fn first_successor(request: &ManagedCreateRequest) -> ManagedCreateSuccessorIdentity {
        let mut candidate = 0;
        allocate_successor(request, &mut candidate).unwrap()
    }

    #[test]
    fn successor_identity_is_deterministic_policy_bound_and_acyclic() {
        let source = request("fixture");
        let first = first_successor(&source);
        assert_eq!(first_successor(&source), first);
        let source_identity = ManagedCreateReconcileRequest::new(
            source.idempotency_key(),
            source.session_id(),
            source.workspace_id(),
        )
        .unwrap();
        assert!(
            managed_create_ledger::successor_session_shares_create_shard(
                &source_identity,
                first.session_id(),
            )
            .unwrap()
        );

        let colored = source
            .clone()
            .with_terminal_default_colors(TerminalDefaultColors::new(0x12_34_56, 0x65_43_21).unwrap())
            .unwrap();
        assert_eq!(
            first_successor(&colored),
            first,
            "terminal presentation colors must not change successor identity",
        );

        let changed_policy = first_successor(&request("fixture-changed"));
        assert_ne!(changed_policy.session_id(), first.session_id());
        assert_ne!(changed_policy.idempotency_key(), first.idempotency_key());

        let target = source
            .retarget_identity(first.idempotency_key(), first.session_id())
            .unwrap();
        let next = first_successor(&target);
        assert_ne!(next.session_id(), first.session_id());
        assert_ne!(next.idempotency_key(), first.idempotency_key());
        let target_identity = ManagedCreateReconcileRequest::new(
            target.idempotency_key(),
            target.session_id(),
            target.workspace_id(),
        )
        .unwrap();
        assert!(
            managed_create_ledger::successor_session_shares_create_shard(
                &target_identity,
                next.session_id(),
            )
            .unwrap()
        );
    }

    #[test]
    fn successor_identity_allocator_reports_bounded_exhaustion() {
        let mut candidate = MAX_SAME_SHARD_SUCCESSOR_CANDIDATES;
        let error = allocate_successor(&request("fixture"), &mut candidate).unwrap_err();
        assert_eq!(
            error.to_string(),
            "hmux_managed_create_successor_capacity: bounded same-shard identity allocation exhausted",
        );
    }
}
