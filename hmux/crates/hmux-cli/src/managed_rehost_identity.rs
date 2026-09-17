use std::path::Path;

use clap::Args;
use hmux_client::recovery_journal::resolve_managed_rehost_operation_identity;
use hmux_runtime_contract::ManagedRehostReconcileRequest;

pub(crate) const CAPABILITY: &str = "managed_rehost_operation_source_lookup_v1";

#[derive(Args, Debug)]
pub(crate) struct ManagedRehostSourceArgs {
    /// Original source session; omit the pair only when looking up an existing operation.
    #[arg(long, requires = "workspace")]
    pub(crate) session: Option<String>,
    /// Original source workspace, not a current pane or successor.
    #[arg(long, requires = "session")]
    pub(crate) workspace: Option<String>,
}

impl ManagedRehostSourceArgs {
    pub(crate) fn required(&self) -> Result<(&str, &str), crate::CliError> {
        match (self.session.as_deref(), self.workspace.as_deref()) {
            (Some(session), Some(workspace)) => Ok((session, workspace)),
            _ => Err(crate::CliError("hmux_managed_rehost_source_required: specify the original --session and --workspace".into())),
        }
    }

    pub(crate) fn resolve(
        &self,
        root: &Path,
        operation_id: &str,
    ) -> Result<ManagedRehostReconcileRequest, Box<dyn std::error::Error>> {
        if self.session.is_some() || self.workspace.is_some() {
            let (session, workspace) = self.required()?;
            return Ok(ManagedRehostReconcileRequest::by_operation_identity(
                operation_id,
                session,
                workspace,
            )?);
        }
        resolve_managed_rehost_operation_identity(root, operation_id)?.ok_or_else(|| {
            crate::CliError("hmux_managed_rehost_operation_source_unavailable: the original record is missing or compacted. Inspect status with the saved original --session and --workspace; do not start another operation.".into()).into()
        })
    }
}
