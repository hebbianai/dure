use clap::Args;
use hmux_client::{
    CatalogCensusError, CatalogCensusWorker, CatalogResolutionError, ClientError,
    ConnectionOptions, LocalAttachRole, LocalSessionCatalog, SessionSelector,
    resolve_local_session_isolated,
};
use std::error::Error;
use std::time::{Duration, Instant};

use crate::{CliError, output, recent_visible_lines};

#[derive(Args, Debug)]
pub(crate) struct ReadArgs {
    /// Session name, exact id, or unique printed id prefix.
    pub(crate) session: String,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    pub(crate) workspace: Option<String>,

    /// Maximum number of visible terminal lines to print.
    #[arg(long, short = 'n', default_value_t = 20, value_parser = clap::value_parser!(u16).range(1..=512))]
    pub(crate) lines: u16,

    /// One wall-clock budget for discovery and the initial screen handshake.
    #[arg(long, default_value_t = 2500, value_parser = clap::value_parser!(u64).range(1..=10_000))]
    pub(crate) deadline_ms: u64,
}

pub(crate) fn run(
    catalog: &LocalSessionCatalog,
    args: ReadArgs,
    json: bool,
) -> Result<(), Box<dyn Error>> {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(args.deadline_ms);
    let timeout = |stage: &str, cause: &dyn std::fmt::Display| -> Box<dyn Error> {
        Box::new(CliError(format!(
            "hmux_read_deadline_exceeded: stage={stage} deadlineMs={} elapsedMs={}; {cause}",
            args.deadline_ms,
            started.elapsed().as_millis(),
        )))
    };
    let session = match args.workspace {
        Some(workspace_id) => catalog
            .open_current_managed(&SessionSelector::new(&args.session, Some(workspace_id)))
            .map_err(|error| {
                if Instant::now() >= deadline {
                    timeout("discovery", &error)
                } else {
                    Box::new(error)
                }
            })?,
        None => resolve_local_session_isolated(
            catalog,
            &CatalogCensusWorker::new(std::env::current_exe()?),
            &args.session,
            deadline.saturating_duration_since(Instant::now()),
        )
        .map_err(|error| {
            if matches!(
                error,
                CatalogResolutionError::Census(CatalogCensusError::TimedOut)
            ) || Instant::now() >= deadline
            {
                timeout("discovery", &error)
            } else {
                Box::new(error)
            }
        })?,
    };
    if Instant::now() >= deadline {
        return Err(timeout(
            "discovery",
            &"session resolution completed after the deadline",
        ));
    }
    let connection = session
        .connect_with_options(
            ConnectionOptions::new(LocalAttachRole::Observer, None)
                .with_handshake_deadline(deadline),
        )
        .map_err(|error| {
            let timed_out = matches!(
                &error, ClientError::Io { source, .. }
                    if source.kind() == std::io::ErrorKind::TimedOut
            );
            if timed_out || Instant::now() >= deadline {
                let stage = match &error {
                    ClientError::Io {
                        operation: "hello_ack",
                        ..
                    } => "hello_ack",
                    ClientError::Io {
                        operation: "screen_snapshot",
                        ..
                    } => "snapshot",
                    _ => "handshake",
                };
                timeout(stage, &error)
            } else {
                Box::new(error)
            }
        })?;
    let snapshot = connection.require_initial_snapshot()?;
    let sequence_through = snapshot.sequence_through;
    let lines = recent_visible_lines(
        &snapshot.repaint_bytes,
        snapshot.rows,
        snapshot.columns,
        args.lines,
    );
    // A passive one-shot observer needs no additional unbounded Detach write.
    // Closing the transport releases the Host subscription without changing the session.
    drop(connection);
    if Instant::now() >= deadline {
        return Err(timeout(
            "projection",
            &"screen projection completed after the deadline",
        ));
    }
    if json {
        output::writeln(format_args!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "sessionName": session.descriptor().session_name,
                "sequenceThrough": sequence_through.to_string(),
                "lines": lines,
            }))?
        ))?;
    } else if !lines.is_empty() {
        output::writeln(format_args!("{}", lines.join("\n")))?;
    }
    Ok(())
}
