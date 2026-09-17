use dure_app::{OperationIdV1, SessionCheckoutIdentityV1, SessionCheckoutRecordV1};
use dure_app_sqlite::SqliteDomainStore;
use dure_git_checkout::{release_git_checkout_registration, release_working_directory};

use crate::SessionCheckoutError;

pub(crate) async fn finish_managed_close(
    store: &SqliteDomainStore,
    namespace: &str,
    receipt: &hmux_client::ManagedCreateChainStopReceiptV2,
) -> Result<(), SessionCheckoutError> {
    for retired in receipt.chain() {
        // The runtime supplies the complete retired lineage, including when
        // a caller knows only a successor or lost the original close response.
        finish_retired_checkout(
            store,
            crate::managed_identity(
                namespace,
                retired.idempotency_key(),
                retired.session_id(),
                retired.workspace_id(),
            ),
        )
        .await?;
    }
    Ok(())
}

pub(crate) async fn finish_retired_checkout(
    store: &SqliteDomainStore,
    identity: SessionCheckoutIdentityV1,
) -> Result<(), SessionCheckoutError> {
    // Runtime retirement already prevents another launch. Serialize with
    // any claim that was admitted before that retirement, then release it;
    // a late claimant must never overtake this cleanup.
    if let Some(record) = store.begin_session_checkout_close(&identity).await? {
        finish_checkout_cleanup(store, record).await?;
    } else {
        // Legacy runtimes and former owners can retire without a resource
        // binding. Finish their existing admission, never invent a claim.
        store.finish_session_checkout_close(&identity).await?;
    }
    Ok(())
}

/// The runtime has already retired this owner. Git release is idempotent and
/// precedes the final SQL checkpoint, so interrupted cleanup can resume.
pub(crate) async fn finish_checkout_cleanup(
    store: &SqliteDomainStore,
    record: SessionCheckoutRecordV1,
) -> Result<(), SessionCheckoutError> {
    let identity = record.binding.identity;
    let registration_id = record.binding.claim_id;
    let release_id = OperationIdV1::new(format!("close-{registration_id}"))
        .expect("a fixed prefix and claim digest form a valid operation identity");
    tokio::task::spawn_blocking(move || {
        if let Some(registration) = record.binding.registration {
            release_git_checkout_registration(&registration, &registration_id, &release_id)?;
        } else {
            release_working_directory(&registration_id)?;
        }
        Ok::<_, SessionCheckoutError>(())
    })
    .await??;
    store.finish_session_checkout_close(&identity).await?;
    Ok(())
}
