use std::path::Path;

use crate::managed_rehost_identity::ManagedRehostSourceArgs;
use clap::Args;
use hmux_client::ManagedRehostResolutionResponse;
use hmux_client::recovery_journal::{
    ManagedRehostResolutionLookup, observe_managed_rehost_operation, resolve_managed_rehost_current,
};

pub(crate) const CAPABILITY: &str = "managed_rehost_operation_observation_v1";

#[derive(Args, Debug)]
pub(crate) struct ManagedRehostResolveArgs {
    #[command(flatten)]
    pub(crate) source: ManagedRehostSourceArgs,

    /// Observe only this operation's direct result; never resume it or follow later successors.
    #[arg(long)]
    pub(crate) operation_id: Option<String>,
}

pub(crate) fn run(
    root: &Path,
    args: ManagedRehostResolveArgs,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (lookup, session, workspace) = match args.operation_id {
        Some(operation_id) => {
            let request = args.source.resolve(root, &operation_id)?;
            (
                observe_managed_rehost_operation(root, &request)?,
                request.source_session_id().to_string(),
                request.source_workspace_id().to_string(),
            )
        }
        None => {
            let (session, workspace) = args.source.required()?;
            (
                resolve_managed_rehost_current(root, workspace, session)?,
                session.into(),
                workspace.into(),
            )
        }
    };
    let rendered = if json {
        serde_json::to_string_pretty(&ManagedRehostResolutionResponse::from_lookup(
            lookup, &session, &workspace,
        ))?
    } else {
        match lookup {
            ManagedRehostResolutionLookup::Resolved(resolution) => format!(
                "{} -> {} ({} durable operation(s))",
                resolution.source_generation().session_id(),
                resolution.current_generation().session_id(),
                resolution.operation_ids().len(),
            ),
            ManagedRehostResolutionLookup::NotFound => {
                "No durable managed rehost successor was found.".into()
            }
            ManagedRehostResolutionLookup::RetryRequired { operation_id } => {
                format!("Managed rehost operation {operation_id} requires an exact retry.")
            }
        }
    };
    crate::output::writeln(format_args!("{rendered}"))?;
    Ok(())
}
