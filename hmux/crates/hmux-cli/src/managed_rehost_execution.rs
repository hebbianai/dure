use std::path::{Path, PathBuf};

use crate::managed_rehost_identity::ManagedRehostSourceArgs;
use clap::Args;
use hmux_client::{
    ClientError, LocalSessionCatalog, ManagedRehostReceipt, ManagedSessionRehoster, SessionSelector,
};
use hmux_runtime_contract::{ManagedRehostReconcileRequest, ManagedRehostRequest};

pub(crate) const RECONCILE_CAPABILITY: &str = "managed_rehost_operation_reconcile_v1";
pub(crate) const START_CAPABILITY: &str = "managed_rehost_operation_start_v1";

#[derive(Args, Debug)]
pub(crate) struct ManagedRehostArgs {
    /// Exact managed source session id.
    #[arg(long)]
    pub(crate) session: String,
    /// Exact source workspace id.
    #[arg(long)]
    pub(crate) workspace: String,
    /// Complete runner + Host + terminal source generation.
    #[arg(long, value_name = "JSON")]
    pub(crate) expected_fence_json: String,
    /// Stable operation identity reused for every retry.
    #[arg(long)]
    pub(crate) operation_id: String,
    /// Explicitly confirm retiring the exact live source provider.
    #[arg(long)]
    pub(crate) confirm_restart: bool,
    /// Optional equality assertion; never a replacement recipe.
    #[arg(long)]
    pub(crate) expected_provider: Option<String>,
    /// Optional exact Host conversation equality assertion.
    #[arg(long)]
    pub(crate) expected_conversation: Option<String>,
    /// Optional non-secret launch-reference equality assertion.
    #[arg(long)]
    pub(crate) expected_launch_reference: Option<String>,
    /// Runtime executable; defaults to HMUX_RUNTIME or a bundled/sibling binary.
    #[arg(long, value_name = "PATH")]
    pub(crate) runtime: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub(crate) struct ManagedRehostOperationArgs {
    #[command(flatten)]
    source: ManagedRehostSourceArgs,
    /// Stable operation identity; an existing journal owns every replacement input.
    #[arg(long)]
    operation_id: String,
    /// Explicitly allow source retirement and exact conversation replacement.
    #[arg(long)]
    confirm_restart: bool,
    /// Runtime executable; defaults to HMUX_RUNTIME or a bundled/sibling binary.
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,
}

pub(crate) fn rehost(
    root: &Path,
    args: ManagedRehostArgs,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let expected = crate::parse_expected_fence(&args.expected_fence_json)?;
    let mut request = ManagedRehostRequest::new(
        args.operation_id,
        args.session,
        args.workspace,
        expected.runner_principal,
        expected.runner_instance,
        expected.channel_epoch,
        expected.host_instance_id,
        expected.terminal_epoch,
        args.confirm_restart,
    )?;
    if let Some(provider) = args.expected_provider {
        request = request.with_expected_provider_id(provider)?;
    }
    if let Some(conversation) = args.expected_conversation {
        request = request.with_expected_conversation_id(conversation)?;
    }
    if let Some(reference) = args.expected_launch_reference {
        request = request.with_expected_launch_reference(reference)?;
    }
    render(broker(root, args.runtime)?.rehost(request), json)
}

pub(crate) fn reconcile(
    root: &Path,
    args: ManagedRehostOperationArgs,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    args.confirmation()?;
    let request = args.source.resolve(root, &args.operation_id)?;
    render(broker(root, args.runtime)?.reconcile(request), json)
}

pub(crate) fn start(
    catalog: &LocalSessionCatalog,
    args: ManagedRehostOperationArgs,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    args.confirmation()?;
    let (session, workspace) = args.source.required()?;
    let identity = ManagedRehostReconcileRequest::by_operation_identity(
        &args.operation_id,
        session,
        workspace,
    )?;
    let broker = broker(catalog.discovery_root(), args.runtime)?;
    // Only authoritative absence permits new admission for an explicit start.
    // All other outcomes belong to the original operation, even without a source manifest.
    match broker.reconcile(identity) {
        Err(error) if error.code() == "hmux_managed_rehost_intent_not_found" => {}
        result => return render(result, json),
    }
    let source = catalog
        .managed_rehost_source(&SessionSelector::new(session, Some(workspace.to_string())))?;
    let descriptor = source.descriptor();
    let request = ManagedRehostRequest::new(
        args.operation_id,
        &descriptor.session_id,
        &descriptor.workspace_id,
        &descriptor.runner_principal,
        &descriptor.runner_instance,
        descriptor.channel_epoch.parse()?,
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
        true,
    )?;
    // The broker rechecks/reserves atomically; this handle cannot authorize a later generation.
    render(broker.with_source(source).rehost(request), json)
}

impl ManagedRehostOperationArgs {
    fn confirmation(&self) -> Result<(), Box<dyn std::error::Error>> {
        if !self.confirm_restart {
            return Err(crate::CliError("hmux_managed_rehost_confirmation_required: source retirement requires --confirm-restart".into()).into());
        }
        Ok(())
    }
}

fn broker(
    root: &Path,
    runtime: Option<PathBuf>,
) -> Result<ManagedSessionRehoster, Box<dyn std::error::Error>> {
    let runtime = crate::resolve_runtime_executable(runtime)?;
    let working_directory = std::env::current_dir()?.canonicalize()?;
    Ok(ManagedSessionRehoster::new(runtime, working_directory).with_discovery_root(root))
}

fn render(
    result: Result<ManagedRehostReceipt, ClientError>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let receipt = result.inspect_err(|error| {
        if json {
            let _ =
                crate::output::writeln(format_args!("{}", crate::managed_rehost_error_json(error)));
        }
    })?;
    let rendered = if json {
        serde_json::to_string_pretty(&receipt)?
    } else {
        format!(
            "Rehosted managed session {} -> {} (operation {}, replayed={})",
            receipt.source_stop_receipt().session_id(),
            receipt.replacement_receipt().session_id(),
            receipt.operation_id(),
            receipt.replayed()
        )
    };
    crate::output::writeln(format_args!("{rendered}"))?;
    Ok(())
}
