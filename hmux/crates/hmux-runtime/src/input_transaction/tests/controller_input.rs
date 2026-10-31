use super::*;

#[test]
fn accepted_submit_does_not_invent_provider_activity() {
    for input in [b"/resume\r".as_slice(), b"\r", b"continue\r"] {
        let mut host = ready_host(false);
        let before = host
            .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
            .unwrap();
        let transaction = apply_input_transaction(
            &mut host,
            &fence(),
            &mut SubmitScanner::default(),
            PtyInput::Bytes(input),
            ControllerInputEffect::DraftCapable,
            InputAdmission::Ordinary,
            |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
        )
        .unwrap();
        assert_eq!(transaction.outcome, InputTransactionOutcome::Written);
        let after = host
            .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
            .unwrap();
        assert_eq!(
            after.agent_runtime_state, before.agent_runtime_state,
            "a PTY submit is not evidence that a provider turn started"
        );
        assert_eq!(
            after.provider_conversation_identity,
            before.provider_conversation_identity
        );
        let waiting = before.agent_runtime_state.unwrap();
        assert!(
            !host
                .matches_agent_runtime_quiescence(
                    &fence(),
                    &hmux_host::local_protocol::ManagedProviderStopQuiescenceFence {
                        terminal_epoch: waiting.terminal_epoch,
                        runtime_revision: waiting.revision,
                        observed_through_output_seq: waiting.observed_through_output_seq,
                    },
                )
                .unwrap(),
            "unchanged Waiting does not authorize replacement of pending input"
        );
    }
}

#[test]
fn provider_without_semantic_reports_keeps_its_bounded_input_estimate() {
    let mut host = host(false);
    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProcessLifecycle),
    )
    .unwrap();
    let transaction = apply_input_transaction(
        &mut host,
        &fence(),
        &mut SubmitScanner::default(),
        PtyInput::Bytes(b"run\r"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
        |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
    )
    .unwrap();
    let working = transaction.runtime_state.unwrap();
    assert_eq!(working.activity, AgentRuntimeActivity::Working);
    assert_eq!(working.source, AgentRuntimeStateSource::ControllerInput);
    let expired = host
        .expire_agent_runtime_state(
            &fence(),
            std::time::Instant::now() + Duration::from_secs(31),
        )
        .unwrap()
        .unwrap();
    assert_eq!(expired.activity, AgentRuntimeActivity::Waiting);
}

#[test]
fn existing_conversation_written_submit_commits_then_rearms_one_idle_turn() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let input = existing_prompt(b"continue", "conversation-1");
    let writes = std::cell::Cell::new(0);

    let apply = |host: &mut SessionHost, scanner: &mut SubmitScanner| {
        apply_input_transaction(
            host,
            &fence(),
            scanner,
            PtyInput::Structured(&input),
            ControllerInputEffect::DraftCapable,
            admission(&input),
            |bytes| {
                writes.set(writes.get() + 1);
                PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(()))
            },
        )
        .unwrap()
    };

    let first = apply(&mut host, &mut scanner);
    assert_eq!(first.outcome, InputTransactionOutcome::Written);
    let admitted_revision = first
        .admitted_agent_runtime_revision
        .expect("written prompt keeps its pre-write waiting revision");
    assert!(first.runtime_state.is_none());
    let waiting = host
        .current_snapshot(hmux_host::local_protocol::ScreenSnapshotProfile::Full)
        .unwrap()
        .agent_runtime_state
        .unwrap();
    assert_eq!(waiting.activity, AgentRuntimeActivity::Waiting);
    assert_eq!(waiting.source, AgentRuntimeStateSource::ProviderEvent);
    assert_eq!(waiting.revision, admitted_revision);

    let repeated = apply(&mut host, &mut scanner);
    assert_eq!(
        repeated.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
    assert_eq!(writes.get(), 1);

    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();
    let next_turn = apply(&mut host, &mut scanner);
    assert_eq!(next_turn.outcome, InputTransactionOutcome::Written);
    assert_eq!(writes.get(), 2);
}

#[test]
fn ordinary_partial_write_consumes_fresh_prompt_authority() {
    let mut host = ready_host(false);
    let mut scanner = SubmitScanner::default();
    let ordinary = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Bytes(b"run\rtrailing"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
        |bytes| {
            PtyWriteOutcome::from_progress(
                bytes.len(),
                4,
                Err(OperationReceiptReason::PtyWriteFailed),
            )
        },
    )
    .unwrap();
    assert_eq!(
        ordinary.outcome,
        InputTransactionOutcome::Failed(OperationReceiptReason::PtyWriteFailed)
    );
    assert!(ordinary.runtime_state.is_none());
    host.observe_agent_runtime_state(
        &fence(),
        AgentRuntimeObservation::waiting(AgentRuntimeStateSource::ProviderEvent),
    )
    .unwrap();

    let initial = fresh_prompt(b"must not write");
    let refused = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&initial),
        ControllerInputEffect::DraftCapable,
        admission(&initial),
        |_| panic!("prior ordinary input must refuse before the writer"),
    )
    .unwrap();
    assert_eq!(
        refused.outcome,
        InputTransactionOutcome::NotWritten(OperationReceiptReason::AgentRuntimeChanged)
    );
}

const SHIFT: u32 = 1;
const ALT: u32 = 2;
const CONTROL: u32 = 4;
const CAPS_LOCK: u32 = 16;

fn key(key: &str, code: &str, modifiers: u32) -> InputIntent {
    InputIntent {
        intent: Some(input_intent::Intent::Key(
            terminal_state_protocol::KeyInputIntent {
                key: key.into(),
                code: code.into(),
                modifiers,
                repeat: false,
            },
        )),
    }
}

/// Keys that move the cursor, delete, switch a TUI mode or interrupt. None of
/// them can put text into an empty line editor.
fn non_inserting_keys() -> Vec<InputIntent> {
    vec![
        key("Tab", "Tab", SHIFT),
        key("Tab", "Tab", SHIFT | CAPS_LOCK),
        key("ArrowLeft", "ArrowLeft", 0),
        key("ArrowRight", "ArrowRight", 0),
        key("ArrowLeft", "ArrowLeft", SHIFT),
        key("ArrowRight", "ArrowRight", CONTROL),
        key("Home", "Home", 0),
        key("End", "End", 0),
        key("Backspace", "Backspace", 0),
        key("Backspace", "Backspace", CONTROL),
        key("Delete", "Delete", 0),
        key("Insert", "Insert", 0),
        key("F1", "F1", 0),
        key("F12", "F12", 0),
        key("c", "KeyC", CONTROL),
        key("Escape", "Escape", 0),
        // A software keyboard names the key without a physical code.
        key("ArrowLeft", "", 0),
    ]
}

/// Legacy byte chunks for the same keys, in both cursor-key modes.
const NON_INSERTING_KEY_BYTES: &[&[u8]] = &[
    b"\x1b[Z",
    b"\x1b[C",
    b"\x1b[D",
    b"\x1bOC",
    b"\x1bOD",
    b"\x1b[H",
    b"\x1b[F",
    b"\x1bOH",
    b"\x1bOF",
    b"\x1b[1~",
    b"\x1b[4~",
    b"\x1b[3~",
    b"\x1b[2~",
    b"\x7f",
    b"\x08",
    b"\x03",
    b"\x1bOP",
    b"\x1bOS",
    b"\x1b[15~",
    b"\x1b[24~",
    b"\x1b",
];

enum KeyPress {
    Structured(InputIntent),
    Bytes(&'static [u8]),
}

// Input intents deliberately have no Debug: it would print typed text.
impl std::fmt::Debug for KeyPress {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Structured(InputIntent {
                intent: Some(input_intent::Intent::Key(key)),
                ..
            }) => write!(
                formatter,
                "key {:?}/{:?}/{:#x}",
                key.key, key.code, key.modifiers
            ),
            Self::Structured(InputIntent {
                intent: Some(input_intent::Intent::Text(text)),
                ..
            }) => write!(formatter, "text of {} bytes", text.utf8.len()),
            Self::Structured(InputIntent {
                intent: Some(input_intent::Intent::Paste(paste)),
                ..
            }) => write!(formatter, "paste of {} bytes", paste.utf8.len()),
            Self::Structured(_) => formatter.write_str("structured input"),
            Self::Bytes(bytes) => write!(formatter, "bytes \"{}\"", bytes.escape_ascii()),
        }
    }
}

impl KeyPress {
    fn non_inserting() -> impl Iterator<Item = Self> {
        non_inserting_keys()
            .into_iter()
            .map(Self::Structured)
            .chain(NON_INSERTING_KEY_BYTES.iter().copied().map(Self::Bytes))
    }

    /// Applies the press as ingress does: a structured key carries the
    /// semantic effect parsed from its intent, legacy bytes are draft-capable
    /// until the byte fold classifies them.
    fn apply(&self, host: &mut SessionHost, scanner: &mut SubmitScanner) {
        let (input, effect) = match self {
            Self::Structured(intent) => (
                PtyInput::Structured(intent),
                ControllerInputEffect::from_non_resize_structured(intent.intent.as_ref().unwrap())
                    .unwrap(),
            ),
            Self::Bytes(bytes) => (PtyInput::Bytes(bytes), ControllerInputEffect::DraftCapable),
        };
        let written = apply_input_transaction(
            host,
            &fence(),
            scanner,
            input,
            effect,
            InputAdmission::Ordinary,
            |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
        )
        .unwrap();
        assert_eq!(written.outcome, InputTransactionOutcome::Written);
    }
}

/// Presses the keys in order at an idle prompt and reports whether both a
/// guarded `dure send` and an inbox wake prompt are admitted afterwards.
fn prompt_open_after(presses: &[KeyPress]) -> bool {
    let mut host = ready_host(true);
    let mut scanner = SubmitScanner::default();
    for press in presses {
        press.apply(&mut host, &mut scanner);
    }
    let draft = host.has_unsubmitted_controller_draft(&fence()).unwrap();
    let report = draft_guarded(b"lane report", true);
    let sent = apply_recorded(
        &mut host,
        &mut scanner,
        PtyInput::Structured(&report),
        guarded_admission(&report),
        &mut Vec::new(),
    );

    let mut host = ready_host(true);
    let mut scanner = SubmitScanner::default();
    for press in presses {
        press.apply(&mut host, &mut scanner);
    }
    let wake = existing_prompt(b"read your inbox", "conversation-1");
    let woke = apply_input_transaction(
        &mut host,
        &fence(),
        &mut scanner,
        PtyInput::Structured(&wake),
        ControllerInputEffect::DraftCapable,
        admission(&wake),
        |bytes| PtyWriteOutcome::from_progress(bytes.len(), bytes.len(), Ok(())),
    )
    .unwrap()
    .outcome;

    let admitted = sent == InputTransactionOutcome::Written;
    assert_eq!(
        woke == InputTransactionOutcome::Written,
        admitted,
        "{presses:?}: the wake prompt and the guarded send share one draft fact"
    );
    assert_eq!(draft, !admitted, "{presses:?}");
    admitted
}

#[test]
fn keys_that_cannot_insert_text_leave_an_idle_prompt_open_to_guarded_input() {
    for press in KeyPress::non_inserting() {
        assert!(
            prompt_open_after(std::slice::from_ref(&press)),
            "{press:?} must not hold the draft guard on an empty prompt"
        );
    }
}

#[test]
fn keys_that_cannot_insert_text_never_release_an_earlier_draft() {
    for press in KeyPress::non_inserting() {
        let mut host = ready_host(true);
        let mut scanner = SubmitScanner::default();
        let mut writes = Vec::new();
        apply_recorded(
            &mut host,
            &mut scanner,
            PtyInput::Bytes(b"half typed"),
            InputAdmission::Ordinary,
            &mut writes,
        );
        press.apply(&mut host, &mut scanner);
        let report = draft_guarded(b"lane report", true);
        assert_eq!(
            apply_recorded(
                &mut host,
                &mut scanner,
                PtyInput::Structured(&report),
                guarded_admission(&report),
                &mut writes,
            ),
            InputTransactionOutcome::NotWritten(OperationReceiptReason::UnsubmittedDraft),
            "{press:?} must preserve the person's draft"
        );
    }
}

#[test]
fn keys_that_can_insert_text_still_hold_the_draft_guard() {
    let structured = [
        // Completion, history recall and readline yanks insert text.
        key("Tab", "Tab", 0),
        key("ArrowUp", "ArrowUp", 0),
        key("ArrowDown", "ArrowDown", 0),
        key("PageUp", "PageUp", 0),
        key("PageDown", "PageDown", 0),
        key("r", "KeyR", CONTROL),
        key("y", "KeyY", CONTROL),
        // A digit can answer a selection prompt or start a draft.
        key("1", "Digit1", 0),
        key("ArrowLeft", "ArrowLeft", ALT),
        key("Insert", "Insert", SHIFT),
    ]
    .into_iter()
    .map(KeyPress::Structured);
    let legacy = [
        b"\t".as_slice(),
        b"\x1b[A",
        b"\x1b[B",
        b"\x1b[5~",
        b"\x1b[6~",
        b"\x12",
        b"\x19",
        b"1",
        b"\x1bb",
        b"\x1b[1;3D",
        b"\x1b[2;2~",
        b"\x7fx",
        b"\x1b[200~\x7f\x1b[201~",
    ]
    .into_iter()
    .map(KeyPress::Bytes);
    for press in structured.chain(legacy) {
        assert!(
            !prompt_open_after(std::slice::from_ref(&press)),
            "{press:?} may put text into the prompt and must hold the guard"
        );
    }
}

fn typed(text: &str) -> KeyPress {
    KeyPress::Structured(InputIntent {
        intent: Some(input_intent::Intent::Text(
            terminal_state_protocol::TextInputIntent {
                utf8: text.as_bytes().to_vec(),
            },
        )),
    })
}

fn pasted(text: &str) -> KeyPress {
    KeyPress::Structured(InputIntent {
        intent: Some(input_intent::Intent::Paste(
            terminal_state_protocol::PasteInputIntent {
                utf8: text.as_bytes().to_vec(),
            },
        )),
    })
}

fn pressed(name: &str, code: &str, modifiers: u32) -> KeyPress {
    KeyPress::Structured(key(name, code, modifiers))
}

fn backspace() -> KeyPress {
    pressed("Backspace", "Backspace", 0)
}

/// The Host counts the characters it wrote and the Backspaces that erase
/// them, so a draft typed and then erased again without Enter stops holding
/// the guard.
#[test]
fn text_typed_and_then_erased_again_leaves_the_prompt_open_to_automated_input() {
    let sequences = [
        vec![typed("ab"), backspace(), backspace()],
        vec![
            typed("ab"),
            KeyPress::Bytes(b"\x7f"),
            KeyPress::Bytes(b"\x08"),
        ],
        // Key repeat can batch Backspaces into one frame.
        vec![KeyPress::Bytes(b"ab"), KeyPress::Bytes(b"\x7f\x7f")],
        // Characters, not bytes: one Backspace erases one syllable.
        vec![typed("한글"), backspace(), backspace()],
        vec![typed("a"), typed("b"), backspace(), backspace()],
        // Pasted text is counted too, structured or as a bracketed paste.
        vec![pasted("ab"), backspace(), backspace()],
        vec![
            KeyPress::Bytes(b"\x1b[200~a\nb\x1b[201~"),
            backspace(),
            backspace(),
            backspace(),
        ],
        // Backspace on an empty prompt erases nothing.
        vec![
            backspace(),
            backspace(),
            typed("ab"),
            backspace(),
            backspace(),
        ],
        vec![typed("ab"), backspace(), backspace(), backspace()],
        // Keys that cannot insert text do not disturb the count...
        vec![
            typed("ab"),
            pressed("Escape", "Escape", 0),
            pressed("ArrowRight", "ArrowRight", 0),
            pressed("End", "End", 0),
            pressed("Delete", "Delete", 0),
            KeyPress::Bytes(b"\x1b[C"),
            pressed("Backspace", "Backspace", SHIFT),
            backspace(),
        ],
        // ...and editing an empty line leaves it empty.
        vec![
            typed("ab"),
            backspace(),
            backspace(),
            pressed("ArrowLeft", "ArrowLeft", 0),
            KeyPress::Bytes(b"\x1b[D"),
            pressed("Backspace", "Backspace", CONTROL),
        ],
    ];
    for presses in sequences {
        assert!(
            prompt_open_after(&presses),
            "{presses:?} leaves an empty prompt and must not hold the draft guard"
        );
    }
}

#[test]
fn a_draft_the_host_cannot_count_as_erased_still_holds_the_guard() {
    let sequences = [
        vec![typed("ab"), backspace()],
        vec![typed("ab"), backspace(), backspace(), typed("c")],
        // The cursor moved into the line: later Backspaces may erase nothing.
        vec![
            typed("ab"),
            pressed("ArrowLeft", "ArrowLeft", 0),
            backspace(),
            backspace(),
        ],
        vec![
            typed("ab"),
            KeyPress::Bytes(b"\x1b[D"),
            backspace(),
            backspace(),
        ],
        vec![
            typed("ab"),
            pressed("Home", "Home", 0),
            backspace(),
            backspace(),
        ],
        // A word erase has no countable length.
        vec![typed("ab"), pressed("Backspace", "Backspace", CONTROL)],
        // Completion, history recall and escape sequences insert text the
        // Host cannot count, so only a submit clears them.
        vec![
            pressed("Tab", "Tab", 0),
            backspace(),
            backspace(),
            backspace(),
        ],
        vec![
            KeyPress::Bytes(b"\x1b[A"),
            backspace(),
            backspace(),
            backspace(),
        ],
        vec![
            typed("ab\t"),
            backspace(),
            backspace(),
            backspace(),
            backspace(),
        ],
        vec![
            typed("ab"),
            KeyPress::Bytes(b"\x1b\r"),
            backspace(),
            backspace(),
            backspace(),
        ],
    ];
    for presses in sequences {
        assert!(
            !prompt_open_after(&presses),
            "{presses:?} may leave text in the prompt and must hold the guard"
        );
    }
}

/// A key sequence the PTY accepted one byte at a time is still that key, not
/// typed text: an Up arrow recalls history the Host cannot count.
#[test]
fn a_key_sequence_split_across_pty_writes_is_not_typed_text() {
    let mut host = ready_host(true);
    let mut scanner = SubmitScanner::default();
    let mut prepared = PreparedInput::new(
        &mut host,
        &fence(),
        PtyInput::Bytes(b"\x1b[A"),
        ControllerInputEffect::DraftCapable,
        InputAdmission::Ordinary,
    )
    .unwrap();
    let first = prepared
        .advance(&mut host, &fence(), &mut scanner, |_| PtyWriteOutcome {
            bytes_written: 1,
            outcome: Ok(()),
            pending: true,
        })
        .unwrap();
    assert!(matches!(first, InputStep::Pending(None)));
    let second = prepared
        .advance(&mut host, &fence(), &mut scanner, |rest| {
            PtyWriteOutcome::from_progress(rest.len(), rest.len(), Ok(()))
        })
        .unwrap();
    assert!(matches!(
        second,
        InputStep::Complete(InputTransaction {
            outcome: InputTransactionOutcome::Written,
            ..
        })
    ));

    for _ in 0..3 {
        backspace().apply(&mut host, &mut scanner);
    }
    assert!(
        host.has_unsubmitted_controller_draft(&fence()).unwrap(),
        "the recalled line has no countable length"
    );
}
