use super::*;

#[test]
fn qa_status_observation_does_not_wait_for_an_idle_pull() {
    let manager = Arc::new(HmuxManager::default());
    let installed = install_test_attachment(
        &manager,
        "observer-idle",
        "pane-idle",
        Arc::new(AtomicBool::new(false)),
        |_, _| {
            StructuredTerminalUpstream::with_writer(
                Arc::new(SinkWriter),
                Arc::new(|| {}),
                2,
                2,
            )
        },
    );
    // next_record retains this mutex while the downstream stream is idle.
    let idle_pull = installed.pull.state.lock().unwrap();
    let observer = Arc::clone(&manager);
    let (entered_tx, entered_rx) = std_mpsc::channel();
    let (observed_tx, observed_rx) = std_mpsc::channel();
    let worker = std::thread::spawn(move || {
        entered_tx.send(()).unwrap();
        observed_tx
            .send(observer.structured_terminal_count())
            .unwrap();
    });
    let entered = entered_rx.recv_timeout(Duration::from_secs(1));
    let observed = observed_rx.recv_timeout(Duration::from_millis(200));
    // Release and join even on RED so the test cannot leave a blocked worker.
    drop(idle_pull);
    worker.join().unwrap();
    entered.expect("QA observation worker should start");
    assert_eq!(
        observed
            .expect("QA status must respond while a terminal pull waits for output")
            .expect("QA status observation should succeed"),
        1,
    );
    installed.stop.store(true, Ordering::Release);
    assert_eq!(manager.structured_terminal_count().unwrap(), 0);
}
