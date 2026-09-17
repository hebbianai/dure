use crate::{
    CliError, managed_mutation_failure, parse_expected_fence, resolve_readable_session,
    semantic_keys,
};
use clap::Args;
use hmux_client::{
    ClientError, LocalSessionCatalog, SessionClass, SessionSelector, TerminalCommandInputReceipt,
    TerminalSurfaceAccess, TerminalSurfaceAttachment,
};
use std::time::Duration;

#[derive(Args, Debug)]
pub(super) struct CommandInputArgs {
    /// Session name, exact id, or unique printed id prefix.
    #[arg(short = 't', long = "target")]
    pub(super) session: String,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    pub(super) workspace: Option<String>,

    /// Refuse unless the resolved managed session still has this complete generation.
    #[arg(long, value_name = "JSON")]
    pub(super) expected_fence_json: Option<String>,

    /// Semantic text. Embedded newlines remain text and never imply submit.
    #[arg(long, default_value = "", allow_hyphen_values = true)]
    pub(super) text: String,

    /// Send one semantic Enter key after the text receipt is written to the PTY.
    #[arg(long)]
    pub(super) submit: bool,

    /// Named key (repeat for an ordered batch of up to 64). Host chooses the encoding.
    #[arg(long = "key", conflicts_with_all = ["text", "submit"])]
    pub(super) keys: Vec<String>,
}

pub(super) fn execute(
    args: CommandInputArgs,
    catalog: &LocalSessionCatalog,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if args.keys.len() > semantic_keys::MAX_KEYS {
        return managed_mutation_failure(
            json,
            "hmux_key_batch_limit",
            "At most 64 keys may be sent at once".into(),
            "not_written",
        );
    }
    let keys = match args
        .keys
        .iter()
        .map(|key| key.parse())
        .collect::<Result<Vec<semantic_keys::NamedKey>, _>>()
    {
        Ok(keys) => keys,
        Err(message) => {
            return managed_mutation_failure(json, "hmux_key_name_invalid", message, "not_written");
        }
    };
    let prepared = (|| -> Result<_, Box<dyn std::error::Error>> {
        let expected_fence = args
            .expected_fence_json
            .as_deref()
            .map(parse_expected_fence)
            .transpose()?;
        let session = match expected_fence.as_ref() {
            Some(expected) => {
                if args
                    .workspace
                    .as_deref()
                    .is_some_and(|workspace| workspace != expected.workspace_id)
                {
                    return Err(Box::new(ClientError::Transport {
                        code: "hmux_expected_generation_mismatch",
                        message: "--workspace does not match the expected command-input fence"
                            .into(),
                    }));
                }
                catalog.open_current_managed_for_mutation(
                    &SessionSelector::new(&args.session, Some(expected.workspace_id.clone())),
                    expected,
                )?
            }
            None => match args.workspace.as_ref() {
                Some(workspace) => catalog.open(&SessionSelector::new(
                    &args.session,
                    Some(workspace.clone()),
                ))?,
                None => resolve_readable_session(catalog, &args.session, None)?,
            },
        };
        if session.descriptor().session_class == SessionClass::Managed && expected_fence.is_none() {
            return Err(Box::new(ClientError::Transport {
                code: "hmux_expected_generation_required",
                message: "managed command input requires --expected-fence-json".into(),
            }));
        }
        let connection = session.connect_with_options(
            TerminalSurfaceAttachment::connection_options(TerminalSurfaceAccess::Writer, None),
        )?;
        let surface = TerminalSurfaceAttachment::from_connection(connection)?;
        Ok((session, surface))
    })();
    let (session, mut surface) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            let code = error
                .downcast_ref::<hmux_client::ClientError>()
                .map_or("hmux_command_input_not_started", |error| error.code());
            return managed_mutation_failure(json, code, error.to_string(), "not_written");
        }
    };
    if !keys.is_empty() {
        let mut report = semantic_keys::send_batch(&mut surface, keys);
        let _ = surface.detach();
        report["sessionId"] = session.descriptor().session_id.clone().into();
        report["workspaceId"] = session.descriptor().workspace_id.clone().into();
        if json {
            crate::output::writeln(format_args!("{}", serde_json::to_string(&report)?))?;
        }
        if report["ok"] != true {
            return Err(Box::new(CliError(format!(
                "{}: {}",
                report["error"]["code"], report["error"]["message"]
            ))));
        }
        return Ok(());
    }
    let receipt =
        match surface.send_command_input_confirmed(args.text, args.submit, Duration::from_secs(10))
        {
            Ok(receipt) => receipt,
            Err(error) => {
                return managed_mutation_failure(
                    json,
                    error.code(),
                    error.to_string(),
                    error.delivery_state(),
                );
            }
        };
    let _ = surface.detach();
    if json {
        crate::output::writeln(format_args!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "ok": true,
                "sessionName": session.descriptor().session_name,
                "sessionId": session.descriptor().session_id,
                "workspaceId": session.descriptor().workspace_id,
                "receipt": command_input_receipt_json(&receipt),
            }))?
        ))?;
    }
    Ok(())
}

fn command_input_receipt_json(receipt: &TerminalCommandInputReceipt) -> serde_json::Value {
    let record = |receipt: Option<&terminal_state_protocol::InputReceipt>| {
        receipt.map(|receipt| {
            serde_json::json!({
                "recordId": receipt.in_reply_to_record_id.to_string(),
                "state": "written_to_pty",
            })
        })
    };
    serde_json::json!({
        "terminalEpoch": receipt.terminal_epoch(),
        "text": record(receipt.text()),
        "submit": record(receipt.submit()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_batches_fail_before_resolving_any_session() {
        let root = tempfile::tempdir().unwrap();
        let catalog = LocalSessionCatalog::new(root.path());
        for (keys, code) in [
            (
                vec!["Up".into(), "InvalidKey".into()],
                "hmux_key_name_invalid",
            ),
            (vec!["Enter".into(); 65], "hmux_key_batch_limit"),
        ] {
            let args = CommandInputArgs {
                session: "absent".into(),
                workspace: None,
                expected_fence_json: None,
                text: String::new(),
                submit: false,
                keys,
            };
            assert!(
                execute(args, &catalog, false)
                    .unwrap_err()
                    .to_string()
                    .starts_with(code)
            );
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}
