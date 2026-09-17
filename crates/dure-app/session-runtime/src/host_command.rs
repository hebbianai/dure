//! One-shot selected-host commands over the existing bounded helper transport.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use dure_app::{AgentBootstrapV1, OperationIdV1, SessionCheckoutBindingV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::{
    LocalSessionCatalog, ManagedCreateChainStopReceiptV2, ManagedCreateReceipt,
    ManagedCreateReconcileRequest, ManagedCreateRequest,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    AgentCheckoutRegistrationV1, CheckoutSessionRuntime, ManagedCreateAdvanceCommandResolution,
    SessionCheckoutError, project_checkout_advance,
};

// Keep the installed name and Git operations compatible. The same executable
// now composes product lifetime operations without making Git depend on them.
pub const HELPER_NAME: &str = "dure-git-checkout-helper";
// v2 requires session-v1 to support ReconcileManagedClose. Older bundles must
// be rejected before the adapter sends a command they cannot decode.
pub const HELPER_PROTOCOL: &str = "dure-git-checkout-helper-v2";
pub const HELPER_OPERATIONS: [&str; 4] = ["capture-v1", "locations-v1", "remove-v1", "session-v1"];

/// The executable and SSH adapter share one envelope. In particular, a failure
/// must never deserialize as a successful unit-valued cancellation receipt.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum HelperResponseV1<T> {
    Success {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        value: T,
    },
    Failure {
        #[serde(rename = "schemaVersion")]
        schema_version: u8,
        error: HelperErrorV1,
    },
}

#[derive(Debug, Deserialize, Serialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct HelperErrorV1 {
    pub code: String,
    pub message: String,
}

/// Keep a reported host error distinct from a response lost in transport.
#[derive(Debug, thiserror::Error)]
pub enum HelperCallErrorV1 {
    #[error("{0}")]
    Reported(HelperErrorV1),
    #[error("remote_session_checkout_outcome_unknown: {0}")]
    OutcomeUnknown(String),
}

pub fn decode_helper_response<T: DeserializeOwned>(
    code: i32,
    output: &[u8],
) -> Result<T, HelperCallErrorV1> {
    let response: HelperResponseV1<T> = serde_json::from_slice(output)
        .map_err(|error| HelperCallErrorV1::OutcomeUnknown(error.to_string()))?;
    match response {
        HelperResponseV1::Success {
            schema_version: 1,
            value,
        } if code == 0 => Ok(value),
        HelperResponseV1::Failure {
            schema_version: 1,
            error,
        } if code != 0 => Err(HelperCallErrorV1::Reported(error)),
        _ => Err(HelperCallErrorV1::OutcomeUnknown(
            "incompatible helper response".into(),
        )),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckoutHostContextV1 {
    /// An explicitly selected backend root wins over the host environment.
    pub application_home: Option<PathBuf>,
    pub user_home: PathBuf,
    /// Registration and unlaunched cancellation do not select an executable.
    pub runtime_executable: Option<PathBuf>,
    pub discovery_root: Option<PathBuf>,
}

pub const APPLICATION_DIRECTORY_NAME: &str = ".dure";

pub fn application_home_under(home: &Path) -> PathBuf {
    home.join(APPLICATION_DIRECTORY_NAME)
}

pub fn application_home_override(value: Option<OsString>) -> Option<PathBuf> {
    value.filter(|value| !value.is_empty()).map(PathBuf::from)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCheckoutRegistrationRequestV1 {
    pub registration_id: OperationIdV1,
    pub agent: AgentBootstrapV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CheckoutHostCommandV1 {
    RegisterAgent {
        request: AgentCheckoutRegistrationRequestV1,
    },
    CloseAgentRegistration {
        binding: SessionCheckoutBindingV1,
    },
    CreateManaged {
        request: ManagedCreateRequest,
    },
    AdvanceManaged {
        request: ManagedCreateRequest,
        #[serde(default)]
        replace_current: bool,
    },
    CloseManaged {
        request: ManagedCreateReconcileRequest,
    },
    ReconcileManagedClose {
        request: ManagedCreateReconcileRequest,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckoutHostRequestV1 {
    pub context: CheckoutHostContextV1,
    pub command: CheckoutHostCommandV1,
}

/// Each command keeps its existing receipt shape inside the helper envelope.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CheckoutHostResponseV1 {
    Registered(AgentCheckoutRegistrationV1),
    Created(ManagedCreateReceipt),
    Advanced(ManagedCreateAdvanceCommandResolution<ManagedCreateReceipt>),
    Closed(ManagedCreateChainStopReceiptV2),
    ReconciledClose(Option<ManagedCreateChainStopReceiptV2>),
    Done,
}

/// Desktop adapters reuse their pool; one-shot helpers close theirs after the
/// operation. Both open the same product database on the selected host.
pub async fn open_application_store(
    application_home: &Path,
) -> Result<SqliteDomainStore, SessionCheckoutError> {
    let backend = application_home.join("backend");
    let mut directory = std::fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&backend)?;
    SqliteDomainStore::open(backend.join("application-state.sqlite3"))
        .await
        .map_err(Into::into)
}

impl CheckoutHostRequestV1 {
    pub async fn execute(self) -> Result<CheckoutHostResponseV1, String> {
        self.command.validate()?;
        let context = self.context;
        let application_home = context
            .application_home
            .clone()
            .or_else(|| application_home_override(std::env::var_os("DURE_HOME")))
            .unwrap_or_else(|| application_home_under(&context.user_home));
        if !application_home.is_absolute()
            || !context.user_home.is_absolute()
            || context
                .discovery_root
                .as_ref()
                .is_some_and(|root| !root.is_absolute())
        {
            return Err("session_checkout_request_invalid: host paths must be absolute".into());
        }
        let store = open_application_store(&application_home)
            .await
            .map_err(|error| error.to_string())?;
        let result = self.command.execute(context, &store).await;
        store.close().await;
        result
    }
}

impl CheckoutHostContextV1 {
    fn catalog(&self) -> Result<LocalSessionCatalog, SessionCheckoutError> {
        match &self.discovery_root {
            Some(root) => Ok(LocalSessionCatalog::new(root)),
            None => LocalSessionCatalog::from_environment().map_err(Into::into),
        }
    }

    fn executable(&self) -> Result<PathBuf, SessionCheckoutError> {
        let executable = self.runtime_executable.clone().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "session_checkout_runtime_required: native retirement or launch requires an executable")
        })?;
        if !executable.is_absolute() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "session_checkout_request_invalid: runtime path must be absolute",
            )
            .into());
        }
        Ok(executable)
    }

    fn runtime(&self, store: &SqliteDomainStore) -> Result<CheckoutSessionRuntime, String> {
        let executable = self.executable().map_err(|error| error.to_string())?;
        match &self.discovery_root {
            Some(root) => CheckoutSessionRuntime::at_root(store.clone(), executable, root.clone()),
            None => CheckoutSessionRuntime::from_environment(store.clone(), executable),
        }
        .map_err(|error| error.to_string())
    }
}

impl CheckoutHostCommandV1 {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::CreateManaged { request } | Self::AdvanceManaged { request, .. } => {
                request.validate().map_err(|error| error.to_string())
            }
            Self::CloseManaged { request } | Self::ReconcileManagedClose { request } => {
                request.validate().map_err(|error| error.to_string())
            }
            Self::RegisterAgent { .. } | Self::CloseAgentRegistration { .. } => Ok(()),
        }
    }

    async fn execute(
        self,
        context: CheckoutHostContextV1,
        store: &SqliteDomainStore,
    ) -> Result<CheckoutHostResponseV1, String> {
        match self {
            Self::RegisterAgent { request } => crate::register_agent_checkout(
                store.clone(),
                context.catalog().map_err(|error| error.to_string())?,
                request.registration_id,
                request.agent,
            )
            .await
            .map(CheckoutHostResponseV1::Registered)
            .map_err(|error| error.to_string()),
            Self::CloseAgentRegistration { binding } => crate::close_agent_registration(
                store.clone(),
                context.catalog().map_err(|error| error.to_string())?,
                binding,
                move || context.executable(),
            )
            .await
            .map(|()| CheckoutHostResponseV1::Done)
            .map_err(|error| error.to_string()),
            Self::CreateManaged { request } => context
                .runtime(store)?
                .create(request)
                .await
                .map(|created| CheckoutHostResponseV1::Created(created.receipt().clone()))
                .map_err(|error| error.to_string()),
            Self::AdvanceManaged {
                request,
                replace_current,
            } => {
                let runtime = context.runtime(store)?;
                let outcome = if replace_current {
                    runtime.replace_current_and_advance(request).await
                } else {
                    runtime.advance(request).await
                };
                project_checkout_advance(outcome).map(|outcome| {
                    CheckoutHostResponseV1::Advanced(
                        outcome.map(|created| created.receipt().clone()),
                    )
                })
            }
            Self::CloseManaged { request } => context
                .runtime(store)?
                .close(request)
                .await
                .map(CheckoutHostResponseV1::Closed)
                .map_err(|error| error.to_string()),
            Self::ReconcileManagedClose { request } => crate::reconcile_managed_close(
                store.clone(),
                context.catalog().map_err(|error| error.to_string())?,
                request,
            )
            .await
            .map(CheckoutHostResponseV1::ReconciledClose)
            .map_err(|error| error.to_string()),
        }
    }
}
