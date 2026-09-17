use hmux_client::LocalSessionCatalog;
use hmux_client::recovery_journal::{
    managed_create_ledger::{self, ManagedCreateSuccessorChainResolution},
    request_fingerprint,
};
use hmux_host::local_discovery::{DiscoveryError, DiscoveryManifest, DiscoveryRoot, SessionClass};
use hmux_runtime_contract::{
    MANAGED_CREATE_REQUEST_INVALID_CODE,
    ManagedCreateChainStopBrokerResponse as ManagedCreateChainStopBrokerResponseV1,
    ManagedCreateChainStopBrokerResponseV2 as ManagedCreateChainStopBrokerResponse,
    ManagedCreateChainStopReceiptV2 as ManagedCreateChainStopReceipt,
    ManagedCreateReconcileBrokerResponse,
    ManagedCreateReconcileRequest, ManagedStopReceipt, ManagedStopRequest,
    read_managed_create_chain_stop_request, write_managed_create_chain_stop_response,
    write_managed_create_chain_stop_response_v2,
};
use std::io;

const AUTHORITY_UNAVAILABLE_CODE: &str = "hmux_managed_create_chain_stop_authority_unavailable";
const AUTHORITY_INCONSISTENT_CODE: &str = "hmux_managed_create_chain_stop_authority_inconsistent";

pub(crate) fn broker() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let root = match read_managed_create_chain_stop_request(&mut io::stdin()) {
        Ok(root) => root,
        Err(error) => {
            let response = ManagedCreateChainStopBrokerResponseV1::refused(
                MANAGED_CREATE_REQUEST_INVALID_CODE,
                error.to_string(),
            );
            write_managed_create_chain_stop_response(&mut io::stdout(), &response)?;
            return Ok(());
        }
    };
    let response = execute(root.clone()).legacy_projection(&root).unwrap_or_else(|error| {
        ManagedCreateChainStopBrokerResponseV1::refused(
            AUTHORITY_INCONSISTENT_CODE,
            error.to_string(),
        )
    });
    write_managed_create_chain_stop_response(&mut io::stdout(), &response)?;
    Ok(())
}

pub(crate) fn broker_v2() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let root = match read_managed_create_chain_stop_request(&mut io::stdin()) {
        Ok(root) => root,
        Err(error) => {
            let response = ManagedCreateChainStopBrokerResponse::refused(
                MANAGED_CREATE_REQUEST_INVALID_CODE,
                error.to_string(),
            );
            write_managed_create_chain_stop_response_v2(&mut io::stdout(), &response)?;
            return Ok(());
        }
    };
    let response = execute(root);
    write_managed_create_chain_stop_response_v2(&mut io::stdout(), &response)?;
    Ok(())
}

fn execute(root: ManagedCreateReconcileRequest) -> ManagedCreateChainStopBrokerResponse {
    let catalog = match LocalSessionCatalog::from_environment() {
        Ok(catalog) => catalog,
        Err(error) => {
            return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                AUTHORITY_UNAVAILABLE_CODE,
                error.to_string(),
            );
        }
    };
    let discovery_root = catalog.discovery_root();

    loop {
        let claim = match managed_create_ledger::claim_successor_chain_cleanup(
            discovery_root,
            &root,
        ) {
            Ok(claim) => claim,
            Err(error) => {
                return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                    AUTHORITY_UNAVAILABLE_CODE,
                    error,
                );
            }
        };
        let prior_stop_receipts = match &claim {
            ManagedCreateSuccessorChainResolution::NotFound => &[][..],
            ManagedCreateSuccessorChainResolution::Completed { chain, .. }
            | ManagedCreateSuccessorChainResolution::Pending { chain }
            | ManagedCreateSuccessorChainResolution::UnbornSuccessor { chain, .. }
            | ManagedCreateSuccessorChainResolution::Retiring { chain, .. }
            | ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain,
                ..
            } => chain.prior_stop_receipts(),
        };
        for stop_receipt in prior_stop_receipts {
            if let Err(response) = reconcile_chain_stop_receipt(stop_receipt) {
                return response;
            }
        }
        match claim {
            ManagedCreateSuccessorChainResolution::NotFound => {
                return ManagedCreateChainStopBrokerResponse::NotFound;
            }
            ManagedCreateSuccessorChainResolution::Pending { chain } => {
                let effective = chain.effective();
                match super::managed_create_reconcile::reconcile(discovery_root, effective) {
                    ManagedCreateReconcileBrokerResponse::Completed(_)
                    | ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
                    | ManagedCreateReconcileBrokerResponse::Retired => continue,
                    ManagedCreateReconcileBrokerResponse::Pending => {
                        match stop_launched_generation_if_ready(discovery_root, effective) {
                            Ok(Some(_)) => continue,
                            Ok(None) => {
                                return ManagedCreateChainStopBrokerResponse::Pending;
                            }
                            Err(response) => return response,
                        }
                    }
                    ManagedCreateReconcileBrokerResponse::NotFound => {
                        return ManagedCreateChainStopBrokerResponse::refused(
                            AUTHORITY_INCONSISTENT_CODE,
                            "managed create chain-stop pending identity disappeared",
                        );
                    }
                    ManagedCreateReconcileBrokerResponse::AuthorityUnavailable(failure) => {
                        return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                            AUTHORITY_UNAVAILABLE_CODE,
                            failure.message,
                        );
                    }
                }
            }
            ManagedCreateSuccessorChainResolution::UnbornSuccessor {
                chain,
                expected,
            } => {
                let effective = chain.effective();
                if let Err(error) = managed_create_ledger::claim_unborn_successor_cleanup(
                    discovery_root,
                    effective,
                    &expected,
                ) {
                    return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                        AUTHORITY_UNAVAILABLE_CODE,
                        error,
                    );
                }
                continue;
            }
            ManagedCreateSuccessorChainResolution::Retiring {
                stop_receipt,
                ..
            } => {
                if let Err(response) = reconcile_chain_stop_receipt(stop_receipt.as_ref()) {
                    return response;
                }
                continue;
            }
            ManagedCreateSuccessorChainResolution::TerminalWithoutSuccessor {
                chain,
                stop_receipt,
            } => {
                let receipt = match stop_receipt {
                    Some(stop_receipt) => {
                        if let Err(response) = reconcile_chain_stop_receipt(stop_receipt.as_ref()) {
                            return response;
                        }
                        ManagedCreateChainStopReceipt::stopped(
                            chain.into_identities(),
                            *stop_receipt,
                        )
                    }
                    None => ManagedCreateChainStopReceipt::closed(chain.into_identities()),
                };
                return completed(receipt);
            }
            ManagedCreateSuccessorChainResolution::Completed { chain, receipt: expected } => {
                let effective = match ManagedCreateReconcileRequest::new(
                    expected.idempotency_key(),
                    expected.session_id(),
                    expected.workspace_id(),
                ) {
                    Ok(effective) => effective,
                    Err(error) => {
                        return ManagedCreateChainStopBrokerResponse::refused(
                            AUTHORITY_INCONSISTENT_CODE,
                            error.to_string(),
                        );
                    }
                };
                if &effective != chain.effective() {
                    return ManagedCreateChainStopBrokerResponse::refused(
                        AUTHORITY_INCONSISTENT_CODE,
                        "managed create chain-stop receipt changed the effective identity",
                    );
                }
                let evidence = match managed_create_ledger::completed_generation_evidence(
                    discovery_root,
                    &effective,
                ) {
                    Ok(Some(evidence)) if evidence.receipt() == expected.as_ref() => evidence,
                    Ok(Some(_)) => {
                        return ManagedCreateChainStopBrokerResponse::refused(
                            AUTHORITY_INCONSISTENT_CODE,
                            "managed create chain-stop target changed after cleanup claim",
                        );
                    }
                    // Ledger retirement is monotonic. If another exact stop
                    // won after the claim, the next pass returns its durable
                    // receipt instead of inventing a second outcome.
                    Ok(None) => continue,
                    Err(error) => {
                        return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                            AUTHORITY_UNAVAILABLE_CODE,
                            error,
                        );
                    }
                };
                let stop_request = match super::managed_create_failure::exact_stop_request(&evidence)
                {
                    Ok(request) => request,
                    Err(error) => {
                        return ManagedCreateChainStopBrokerResponse::refused(
                            AUTHORITY_INCONSISTENT_CODE,
                            error.to_string(),
                        );
                    }
                };
                let stop_receipt = match super::stop_managed_provider(&stop_request) {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        return ManagedCreateChainStopBrokerResponse::authority_unavailable(
                            AUTHORITY_UNAVAILABLE_CODE,
                            error.to_string(),
                        );
                    }
                };
                return completed(ManagedCreateChainStopReceipt::stopped(
                    chain.into_identities(),
                    stop_receipt,
                ));
            }
        }
    }
}

fn stop_launched_generation_if_ready(
    discovery_root: &std::path::Path,
    identity: &ManagedCreateReconcileRequest,
) -> Result<Option<ManagedStopReceipt>, ManagedCreateChainStopBrokerResponse> {
    let evidence = managed_create_ledger::launched_generation_evidence(discovery_root, identity)
        .map_err(|error| {
            ManagedCreateChainStopBrokerResponse::authority_unavailable(
                AUTHORITY_UNAVAILABLE_CODE,
                error,
            )
        })?;
    let Some(evidence) = evidence else {
        return Ok(None);
    };
    let discovery = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedCreateChainStopBrokerResponse::authority_unavailable(
            AUTHORITY_UNAVAILABLE_CODE,
            error.to_string(),
        )
    })?;
    let found = match discovery.find_manifest_by_session(identity.workspace_id(), identity.session_id()) {
        Ok(found) => found,
        Err(DiscoveryError::SessionNotFound | DiscoveryError::StaleDiscovery { .. }) => {
            return Ok(None);
        }
        Err(error) => {
            return Err(
                ManagedCreateChainStopBrokerResponse::authority_unavailable(
                    AUTHORITY_UNAVAILABLE_CODE,
                    error.to_string(),
                ),
            );
        }
    };
    let common = found.manifest.common();
    if common.session_class != SessionClass::Managed
        || common.lifetime.workspace_id != identity.workspace_id()
        || common.lifetime.session_id != identity.session_id()
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(identity.idempotency_key())
        || common.host_process.process_id != evidence.host_process().process_id
        || common.host_process.start_marker != evidence.host_process().start_marker
    {
        return Err(ManagedCreateChainStopBrokerResponse::refused(
            AUTHORITY_INCONSISTENT_CODE,
            "managed create chain-stop launch evidence changed",
        ));
    }
    let terminal_epoch = match &found.manifest {
        DiscoveryManifest::Starting(_) => return Ok(None),
        DiscoveryManifest::Ready(ready) => ready.terminal_epoch.as_str(),
        DiscoveryManifest::Exited(exited) => exited.tombstone.fence.terminal_epoch.as_str(),
    };
    if let Some(starting) = evidence.starting_generation() {
        let fence = starting.generation_fence();
        if starting.host_process() != evidence.host_process()
            || fence.runner_principal() != common.lifetime.runner_principal
            || fence.runner_instance() != common.lifetime.runner_instance
            || fence.channel_epoch() != common.lifetime.channel_epoch
            || fence.host_instance_id() != common.host_instance_id
            || fence.terminal_epoch() != terminal_epoch
        {
            return Err(ManagedCreateChainStopBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                "managed create chain-stop Starting evidence changed",
            ));
        }
    }
    let conversation = evidence.conversation_identity();
    if conversation.is_some_and(|conversation| conversation.provider_id() != common.provider_id) {
        return Err(ManagedCreateChainStopBrokerResponse::refused(
            AUTHORITY_INCONSISTENT_CODE,
            "managed create chain-stop conversation provider changed",
        ));
    }
    let channel_epoch = common.lifetime.channel_epoch.to_string();
    let stop_id = format!(
        "managed_create_chain_stop_{}",
        request_fingerprint(&[
            "managed-create-chain-stop-v1",
            identity.workspace_id(),
            identity.session_id(),
            identity.idempotency_key(),
            &common.lifetime.runner_principal,
            &common.lifetime.runner_instance,
            &channel_epoch,
            &common.host_instance_id,
            terminal_epoch,
        ])
    );
    let request = ManagedStopRequest::new(stop_id, identity.session_id(), identity.workspace_id())
        .and_then(|request| {
            request.with_expected_fence(
                &common.lifetime.runner_principal,
                &common.lifetime.runner_instance,
                common.lifetime.channel_epoch,
                &common.host_instance_id,
                terminal_epoch,
            )
        })
        .map_err(|error| {
            ManagedCreateChainStopBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                error.to_string(),
            )
        })?;
    let request = super::managed_create_failure::with_persisted_conversation_fence(
        request,
        conversation,
    )
    .map_err(|error| {
        ManagedCreateChainStopBrokerResponse::refused(
            AUTHORITY_INCONSISTENT_CODE,
            error.to_string(),
        )
    })?;
    super::stop_managed_provider(&request)
        .map(Some)
        .map_err(|error| {
            ManagedCreateChainStopBrokerResponse::authority_unavailable(
                AUTHORITY_UNAVAILABLE_CODE,
                error.to_string(),
            )
        })
}

fn reconcile_chain_stop_receipt(
    expected: &ManagedStopReceipt,
) -> Result<(), ManagedCreateChainStopBrokerResponse> {
    super::managed_create_reconcile::reconcile_stop_receipt(expected).map_err(|error| {
        if error.inconsistent() {
            ManagedCreateChainStopBrokerResponse::refused(
                AUTHORITY_INCONSISTENT_CODE,
                error.to_string(),
            )
        } else {
            ManagedCreateChainStopBrokerResponse::authority_unavailable(
                AUTHORITY_UNAVAILABLE_CODE,
                error.to_string(),
            )
        }
    })
}

fn completed(
    receipt: Result<ManagedCreateChainStopReceipt, hmux_runtime_contract::RuntimeContractError>,
) -> ManagedCreateChainStopBrokerResponse {
    match receipt {
        Ok(receipt) => ManagedCreateChainStopBrokerResponse::Completed(Box::new(receipt)),
        Err(error) => ManagedCreateChainStopBrokerResponse::refused(
            AUTHORITY_INCONSISTENT_CODE,
            error.to_string(),
        ),
    }
}
