use super::*;

#[test]
fn viewport_input_and_resize_intents_cross_a_real_ssh_exec_channel() {
    let fixture = start(Grant::TerminalSurface);
    let mut surface = attach_terminal_surface_over_ssh(
        ssh_config(&fixture),
        fence(),
        TerminalSurfaceAccess::Writer,
    )
    .expect("the writable terminal surface attaches over SSH");

    let viewport = surface
        .scroll_rows_confirmed(-1, Duration::from_secs(5))
        .expect("the Host acknowledges viewport movement");
    assert_eq!(viewport.viewport().applied_intent_seq, 2);
    assert!(matches!(
        surface
            .read_event()
            .expect("an event that crossed the acknowledgement remains observable"),
        TerminalSurfaceEvent::Event(_)
    ));
    let command = surface
        .send_command_input_confirmed("echo ssh".into(), true, Duration::from_secs(5))
        .expect("the Host acknowledges semantic command input");
    assert_eq!(command.text().unwrap().in_reply_to_record_id, 2);
    assert_eq!(command.submit().unwrap().in_reply_to_record_id, 3);
    let resize = surface
        .send_resize_confirmed(120, 40, Duration::from_secs(5))
        .expect("the Host acknowledges resize input");
    let Some(resize_receipt::Outcome::AppliedToTerminal(applied)) = resize.outcome else {
        panic!("resize must return the canonical geometry");
    };
    assert_eq!((applied.columns, applied.rows), (120, 40));

    let hello = fixture
        .observed_hello
        .lock()
        .expect("hello lock")
        .clone()
        .expect("the Host saw a Hello");
    assert_eq!(
        hello.requested_mode,
        AttachMode::Observer,
        "semantic input must not acquire a controller lease"
    );
    assert!(
        hello
            .requested_capabilities
            .iter()
            .any(|capability| capability == TERMINAL_INPUT_INTENT_CAPABILITY)
    );
    assert!(
        fixture.observed_commands.lock().expect("command lock")[0]
            .ends_with("mobile-gateway --role controller"),
        "the outer SSH gateway ceiling must separately admit writes"
    );

    let observed = fixture
        .observed_terminal
        .lock()
        .expect("terminal lock")
        .clone();
    assert_eq!(observed.len(), 4);
    let viewport = decode_record(&observed[0]).expect("viewport intent decodes");
    let Some(terminal_state_record::Body::ViewportIntent(intent)) = viewport.record.body else {
        panic!("the first upstream record must be viewport intent");
    };
    assert!(matches!(
        intent.intent,
        Some(viewport_intent::Intent::ScrollRows(_))
    ));
    let input = decode_record(&observed[1]).expect("command paste intent decodes");
    let Some(terminal_state_record::Body::InputIntent(intent)) = input.record.body else {
        panic!("the second upstream record must be input intent");
    };
    let Some(input_intent::Intent::Paste(paste)) = intent.intent else {
        panic!("external command text must cross SSH as semantic paste");
    };
    assert_eq!(paste.utf8, b"echo ssh");
    let submit = decode_record(&observed[2]).expect("submit intent decodes");
    let Some(terminal_state_record::Body::InputIntent(intent)) = submit.record.body else {
        panic!("the third upstream record must be input intent");
    };
    let Some(input_intent::Intent::Key(key)) = intent.intent else {
        panic!("the third upstream record must be a semantic key");
    };
    assert_eq!((key.key.as_str(), key.code.as_str()), ("Enter", "Enter"));
    let resize = decode_record(&observed[3]).expect("resize intent decodes");
    let Some(terminal_state_record::Body::InputIntent(intent)) = resize.record.body else {
        panic!("the fourth upstream record must be input intent");
    };
    assert!(matches!(
        intent.intent,
        Some(input_intent::Intent::Resize(_))
    ));
    surface.detach().expect("surface detaches");
}
