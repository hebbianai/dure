use dure_app::DomainStoreErrorV1;
use dure_git_checkout::GitCheckoutInstanceError;
use hmux_client::recovery_journal::managed_create_ledger::ManagedCreateAdmissionError;
use hmux_client::{ClientError, ManagedCreateError};

#[derive(Debug, thiserror::Error)]
pub enum SessionCheckoutError {
    #[error(transparent)]
    Store(#[from] DomainStoreErrorV1),
    #[error("{code}: {0}", code = .0.code)]
    Checkout(#[from] GitCheckoutInstanceError),
    #[error(transparent)]
    Reservation(#[from] ManagedCreateAdmissionError),
    #[error("{code}: {0}", code = .0.code())]
    Runtime(#[from] ClientError),
    #[error("{code}: {0}", code = .0.code())]
    Create(#[from] ManagedCreateError),
    #[error("session_checkout_storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("session_checkout_task: {0}")]
    Task(#[from] tokio::task::JoinError),
    #[error("session_checkout_closing: checkout claim admission is closed")]
    Closing,
    #[error(
        "session_checkout_create_identity_missing: checkout handoff requires the journal's prepared standalone identity"
    )]
    MissingCreateIdentity,
    #[error("{0}")]
    Journal(String),
    #[error("session_checkout_close_payload_invalid: {0}")]
    ClosePayload(#[from] serde_json::Error),
    #[error(
        "session_checkout_close_target_changed: the close no longer names this standalone generation"
    )]
    CloseTargetChanged,
    #[error("session_checkout_close_pending: exact standalone retirement is not yet confirmed")]
    ClosePending,
}

impl From<hmux_client::recovery_journal::prepared_standalone_create::execution::LaunchError>
    for SessionCheckoutError
{
    fn from(
        error: hmux_client::recovery_journal::prepared_standalone_create::execution::LaunchError,
    ) -> Self {
        use hmux_client::recovery_journal::prepared_standalone_create::execution::LaunchError;
        match error {
            LaunchError::Runtime(error) => Self::Runtime(error),
            LaunchError::Journal(error) => Self::Journal(error),
        }
    }
}
