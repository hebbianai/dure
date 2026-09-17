use hmux_client::TerminalSurfaceAttachment;
use serde_json::{Value, json};
use std::str::FromStr;
use std::time::{Duration, Instant};
use terminal_state_protocol::input_receipt;

pub(super) const CAPABILITY: &str = "semantic_key_input_v1";
pub(super) const MAX_KEYS: usize = 64;

/// CLI spelling only. The Host remains the terminal-mode/byte-encoding authority.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct NamedKey {
    key: String,
    code: String,
    modifiers: u32,
}

impl FromStr for NamedKey {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() > 128 {
            return Err("key name exceeds 128 bytes".into());
        }
        let mut name = value;
        let mut modifiers = 0;
        // KeyInputIntent's protocol bit layout: shift=1, alt=2, control=4.
        loop {
            let prefix = [
                ("Ctrl+", 4),
                ("C-", 4),
                ("Alt+", 2),
                ("M-", 2),
                ("Shift+", 1),
                ("S-", 1),
            ]
            .into_iter()
            .find(|(prefix, _)| name.starts_with(prefix));
            let Some((prefix, bit)) = prefix else { break };
            if modifiers & bit != 0 {
                return Err("duplicate key modifier".into());
            }
            modifiers |= bit;
            name = &name[prefix.len()..];
        }
        let code = match name {
            "Enter" | "Tab" | "Backspace" | "Home" | "End" | "PageUp" | "PageDown" | "Insert"
            | "Delete" => name.to_string(),
            "Esc" | "Escape" => "Escape".into(),
            "Up" | "ArrowUp" => "ArrowUp".into(),
            "Down" | "ArrowDown" => "ArrowDown".into(),
            "Left" | "ArrowLeft" => "ArrowLeft".into(),
            "Right" | "ArrowRight" => "ArrowRight".into(),
            "Space" => "Space".into(),
            "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11"
            | "F12" => name.to_string(),
            _ if name.len() == 1 && name.as_bytes()[0].is_ascii_alphabetic() => {
                format!("Key{}", name.to_ascii_uppercase())
            }
            _ if name.len() == 1 && name.as_bytes()[0].is_ascii_digit() => format!("Digit{name}"),
            _ => {
                return Err(format!(
                    "unsupported key {value:?}; use --text for literal input"
                ));
            }
        };
        let key = if code == "Space" {
            " ".into()
        } else if name.len() == 1 {
            if modifiers & 1 != 0 {
                name.to_ascii_uppercase()
            } else {
                name.into()
            }
        } else {
            code.clone()
        };
        Ok(Self {
            key,
            code,
            modifiers,
        })
    }
}

pub(super) fn send_batch(surface: &mut TerminalSurfaceAttachment, keys: Vec<NamedKey>) -> Value {
    let terminal_epoch = surface.current_frame().terminal_epoch().to_string();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut receipts = Vec::with_capacity(keys.len());
    let mut error = None;
    for (index, key) in keys.into_iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let failure = if remaining.is_zero() {
            Some((
                "hmux_terminal_input_deadline_exhausted".to_string(),
                "Key batch deadline elapsed before this key was sent".to_string(),
                "not_written",
            ))
        } else {
            match surface.send_key_confirmed(key.key, key.code, key.modifiers, false, remaining) {
                Ok(receipt) => match receipt.outcome {
                    Some(input_receipt::Outcome::WrittenToPty(_)) => {
                        receipts.push(json!({"recordId": receipt.in_reply_to_record_id.to_string(), "state": "written_to_pty"}));
                        None
                    }
                    Some(input_receipt::Outcome::Refused(reason)) => Some((
                        "hmux_terminal_input_refused".into(),
                        format!("Host refused key input ({})", reason.reason),
                        "not_written",
                    )),
                    Some(input_receipt::Outcome::Failed(reason)) => Some((
                        "hmux_terminal_input_failed".into(),
                        format!("Host failed key input ({})", reason.reason),
                        "outcome_unknown",
                    )),
                    None => Some((
                        "hmux_terminal_input_receipt_invalid".into(),
                        "Host returned no final key outcome".into(),
                        "outcome_unknown",
                    )),
                },
                Err(error) => Some((
                    error.code().to_string(),
                    error.to_string(),
                    "outcome_unknown",
                )),
            }
        };
        if let Some((code, message, key_delivery_state)) = failure {
            error = Some(json!({"code": code, "message": message, "keyIndex": index,
                "keyDeliveryState": key_delivery_state,
                "deliveryState": if key_delivery_state == "not_written" && !receipts.is_empty() { "partial" } else { key_delivery_state }}));
            break;
        }
    }
    let mut report = json!({"schemaVersion": 1, "ok": error.is_none(),
        "receipt": {"terminalEpoch": terminal_epoch, "keys": receipts}});
    if let Some(error) = error {
        report["error"] = error;
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_names_and_modifier_combinations_without_encoding_bytes() {
        for (name, key, code, modifiers) in [
            ("C-c", "c", "KeyC", 4),
            ("Ctrl+c", "c", "KeyC", 4),
            ("Ctrl+Shift+c", "C", "KeyC", 5),
            ("M-S-Left", "ArrowLeft", "ArrowLeft", 3),
            ("Up", "ArrowUp", "ArrowUp", 0),
            ("Esc", "Escape", "Escape", 0),
            ("Enter", "Enter", "Enter", 0),
            ("Shift+Tab", "Tab", "Tab", 1),
            ("C-Space", " ", "Space", 4),
            ("F12", "F12", "F12", 0),
        ] {
            assert_eq!(
                name.parse::<NamedKey>().unwrap(),
                NamedKey {
                    key: key.into(),
                    code: code.into(),
                    modifiers
                }
            );
        }
    }

    #[test]
    fn rejects_ambiguous_literal_and_incomplete_names() {
        for name in [
            "", "C-", "Ctrl+", "Ctrl+C-c", "hello", "F13", "\x1b[A", "Cmd+c",
        ] {
            assert!(name.parse::<NamedKey>().is_err(), "accepted {name:?}");
        }
    }
}
