//! Local OS entry points for the shared product checkout lifetime.

pub(crate) mod remote;

use std::path::PathBuf;

use dure_app::SessionCheckoutBindingV1;
use dure_app_sqlite::SqliteDomainStore;
use dure_session_runtime::host_command::{AgentCheckoutRegistrationRequestV1, CheckoutHostCommandV1};
use dure_session_runtime::AgentCheckoutRegistrationV1;
use dure_session_runtime::{CheckoutSessionRuntime, SessionCheckoutError};
use hmux_client::{
    CreatedManagedSession, ManagedCreateChainStopReceipt, ManagedCreateChainStopReceiptV2,
    ManagedCreateReconcileRequest, ManagedCreateRequest,
};
use tokio::sync::OnceCell;

// Local shell commands use the canonical local application database, not the
// currently selected remote profile or the UI review database. Reuse one pool
// across panes/windows and share SQLite's cross-process admission with the CLI.
static STORE: OnceCell<SqliteDomainStore> = OnceCell::const_new();

async fn store() -> Result<SqliteDomainStore, SessionCheckoutError> {
    STORE
        .get_or_try_init(|| async {
            let (root, _) = crate::app_home::app_root_resolution().map_err(std::io::Error::other)?;
            dure_session_runtime::host_command::open_application_store(&root).await
        })
        .await
        .cloned()
}

async fn runtime(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
) -> Result<CheckoutSessionRuntime, SessionCheckoutError> {
    let store = store().await?;
    runtime_with_store(store, executable, discovery_root)
}

fn runtime_with_store(
    store: SqliteDomainStore,
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
) -> Result<CheckoutSessionRuntime, SessionCheckoutError> {
    match discovery_root {
        Some(root) => CheckoutSessionRuntime::at_root(store, executable, root),
        None => CheckoutSessionRuntime::from_environment(store, executable),
    }
}

fn runtime_executable<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        crate::hmux::resolve_runtime_executable(app)
    }
    #[cfg(windows)]
    {
        use tauri::Manager;
        app.state::<std::sync::Arc<crate::windows_hmux::WindowsHmuxState>>()
            .runtime()
    }
}

#[tauri::command]
pub(crate) async fn session_checkout_register_agent_v1<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: AgentCheckoutRegistrationRequestV1,
    target: Option<crate::ssh::target::SshTargetRequest>,
) -> Result<AgentCheckoutRegistrationV1, String> {
    if let Some(target) = target {
        let options = target.checkout_options()?;
        return tauri::async_runtime::spawn_blocking(move || {
            remote::RemoteCheckoutHost::prepare_registration(&app, options)?
                .execute(
                    CheckoutHostCommandV1::RegisterAgent { request },
                    std::time::Duration::from_secs(30),
                )
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    dure_session_runtime::register_agent_checkout(
        store().await.map_err(|error| error.to_string())?,
        hmux_client::LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?,
        request.registration_id,
        request.agent,
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn session_checkout_close_agent_registration_v1<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    binding: SessionCheckoutBindingV1,
    target: Option<crate::ssh::target::SshTargetRequest>,
) -> Result<(), String> {
    if let Some(target) = target {
        let options = target.checkout_options()?;
        return tauri::async_runtime::spawn_blocking(move || {
            remote::RemoteCheckoutHost::prepare_registration(&app, options)?
                .execute(
                    CheckoutHostCommandV1::CloseAgentRegistration { binding },
                    std::time::Duration::from_secs(30),
                )
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    dure_session_runtime::close_agent_registration(
        store().await.map_err(|error| error.to_string())?,
        hmux_client::LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?,
        binding,
        move || runtime_executable(&app).map_err(|error| std::io::Error::other(error).into()),
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn session_checkout_reconcile_managed_close_v1<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: ManagedCreateReconcileRequest,
    target: Option<crate::ssh::target::SshTargetRequest>,
) -> Result<Option<ManagedCreateChainStopReceiptV2>, String> {
    if let Some(target) = target {
        let options = target.checkout_options()?;
        return tauri::async_runtime::spawn_blocking(move || {
            remote::RemoteCheckoutHost::prepare_registration(&app, options)?
                .execute(
                    CheckoutHostCommandV1::ReconcileManagedClose { request },
                    std::time::Duration::from_secs(30),
                )
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    dure_session_runtime::reconcile_managed_close(
        store().await.map_err(|error| error.to_string())?,
        hmux_client::LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?,
        request,
    )
    .await
    .map_err(|error| error.to_string())
}

pub(crate) fn close_standalone(
    catalog: hmux_client::LocalSessionCatalog,
    session_id: &str,
    workspace_id: &str,
    terminal_epoch: Option<&str>,
    timeout: std::time::Duration,
) -> Result<dure_session_runtime::StandaloneCloseOutcome, String> {
    tauri::async_runtime::block_on(async {
        dure_session_runtime::close_standalone_session(
            store().await?,
            catalog,
            workspace_id.to_owned(),
            session_id.to_owned(),
            terminal_epoch.map(str::to_owned),
            timeout,
        )
        .await
    })
    .map_err(|error| error.to_string())
}

pub(crate) async fn reconcile_checkout<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    registration: dure_app::GitCheckoutRegistrationV1,
) -> Result<(), SessionCheckoutError> {
    let catalog = hmux_client::LocalSessionCatalog::from_environment()?;
    dure_session_runtime::reconcile_catalog_checkout_users(
        store().await?,
        move || {
            runtime_executable(&app).map_err(|error| std::io::Error::other(error).into())
        },
        catalog,
        registration,
    )
    .await
}

// These adapters are called by the existing blocking command workers. The
// shared async lifetime releases its transaction before provider work starts.
pub(crate) fn create(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
    request: ManagedCreateRequest,
) -> Result<CreatedManagedSession, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, discovery_root)
            .await?
            .create(request)
            .await
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn advance<F>(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
    request: ManagedCreateRequest,
    replace_current: bool,
    broker_timing: bool,
    mut observe: F,
) -> Result<hmux_client::ManagedCreateAdvanceResolution, SessionCheckoutError>
where
    F: FnMut(&'static str) + Send + 'static,
{
    tauri::async_runtime::block_on(async {
        let store = store().await?;
        observe("checkout.store.ready");
        let runtime = runtime_with_store(store, executable, discovery_root)?;
        observe("checkout.runtime.ready");
        let runtime = if broker_timing {
            runtime.with_broker_timing()
        } else {
            runtime
        };
        if replace_current {
            runtime
                .replace_current_and_advance_observed(request, observe)
                .await
        } else {
            runtime.advance(request).await
        }
    })
}

pub(crate) fn close(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
    root: ManagedCreateReconcileRequest,
) -> Result<ManagedCreateChainStopReceiptV2, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, discovery_root).await?.close(root).await
    })
    .map_err(|error| error.to_string())
}

pub(crate) fn close_legacy(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
    requested: ManagedCreateReconcileRequest,
) -> Result<ManagedCreateChainStopReceipt, String> {
    close(executable, discovery_root, requested.clone())?
        .legacy_projection(&requested)
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn checkout_for_session(
    executable: PathBuf,
    discovery_root: PathBuf,
    source: hmux_client::LocalSession,
) -> Result<Option<SessionCheckoutBindingV1>, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .checkout_for_session(source)
            .await
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn retain_for_recovery(
    executable: PathBuf,
    discovery_root: PathBuf,
    source: SessionCheckoutBindingV1,
    recovery_id: String,
) -> Result<SessionCheckoutBindingV1, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .retain_checkout_for_recovery(source, recovery_id)
            .await
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn select_recovery_checkout(
    executable: PathBuf,
    discovery_root: PathBuf,
    source: Option<SessionCheckoutBindingV1>,
    cwd: &std::path::Path,
    recovery_id: &str,
) -> Result<SessionCheckoutBindingV1, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .select_recovery_checkout(source, cwd, recovery_id)
            .await
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn retained_recovery_checkout(
    executable: PathBuf,
    discovery_root: PathBuf,
    recovery_id: &str,
) -> Result<Option<SessionCheckoutBindingV1>, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .retained_recovery_checkout(recovery_id)
            .await
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn create_replacement_and_advance(
    executable: PathBuf,
    discovery_root: PathBuf,
    source: Option<SessionCheckoutBindingV1>,
    request: ManagedCreateRequest,
) -> Result<hmux_client::ManagedCreateAdvanceResolution, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .create_replacement_and_advance(source, request)
            .await
    })
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
pub(crate) fn create_standalone_replacement(
    executable: PathBuf,
    discovery_root: PathBuf,
    source: Option<SessionCheckoutBindingV1>,
    request: hmux_client::StandaloneCreateRequest,
    replacement_source: Option<dure_session_runtime::StandaloneReplacementSource>,
) -> Result<hmux_client::CreatedStandaloneSession, SessionCheckoutError> {
    tauri::async_runtime::block_on(async {
        runtime(executable, Some(discovery_root))
            .await?
            .create_standalone_replacement(source, request, replacement_source)
            .await
    })
}

pub(crate) fn create_standalone(
    executable: PathBuf,
    discovery_root: Option<PathBuf>,
    operation: dure_app::OperationIdV1,
    request: hmux_client::StandaloneCreateRequest,
) -> Result<hmux_client::CreatedStandaloneSession, String> {
    tauri::async_runtime::block_on(async {
        runtime(executable, discovery_root)
            .await?
            .create_standalone(operation, request)
            .await
    })
    .map_err(|error| error.to_string())
}
