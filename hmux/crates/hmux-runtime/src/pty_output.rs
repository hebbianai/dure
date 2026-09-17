use super::*;

pub(super) fn output_loop(
    mut reader: Box<dyn Read + Send>,
    pty_fd: RawFd,
    state: Arc<ServerState>,
) {
    const READ_POLL_INTERVAL: Duration = Duration::from_millis(100);
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut terminal_mutation_available = true;
    loop {
        // Avoid spinning on POLLOUT while a compound user frame owns the
        // writer. A new input frame also drains earlier replies itself.
        let replies_ready = pty_io::try_lock_input(&state.pty_input_serial).is_some()
            && lock_pty_writer_preserving_liveness(&state.pty_writer, "reply readiness")
                .has_replies();
        match poll_fd(
            pty_fd,
            libc::POLLIN
                | libc::POLLHUP
                | libc::POLLERR
                | if replies_ready { libc::POLLOUT } else { 0 },
            READ_POLL_INTERVAL,
        ) {
            Ok(false) => continue,
            Ok(true) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
        // Sampling bytes and applying them to the Host is one terminal I/O
        // transaction. Resize takes the same lock across its kernel and Host
        // mutations, so bytes read at one geometry cannot be interpreted at
        // another geometry.
        let input = pty_io::try_lock_input(&state.pty_input_serial);
        let mut pty_writer = lock_pty_writer_preserving_liveness(&state.pty_writer, "output");
        if input.is_some() {
            flush_replies(&mut pty_writer);
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                #[cfg(feature = "terminal-state-stream")]
                let output_observed_at = Instant::now();
                if !terminal_mutation_available {
                    drop(pty_writer);
                    continue;
                }
                if pause_after_pty_read_before_ingest_for_test().is_err() {
                    break;
                }
                // Collect terminal replies in the bounded I/O queue. They
                // share controller-input ordering, but never stop this reader
                // on a full PTY or perform I/O under the terminal-state lock.
                let Ok(mut host) = state.host.lock() else {
                    break;
                };
                let injected_failure = fail_terminal_mutation_for_test().unwrap_or(false);
                let ingested = match if injected_failure {
                    Err(SessionHostError::TerminalReplay(
                        TerminalReplayError::TerminalStateRevisionExhausted,
                    ))
                } else {
                    host.ingest_output(&state.fence, &buffer[..count])
                } {
                    Ok(ingested) => ingested,
                    Err(error) => {
                        let output_sequence = host.current_output_seq();
                        eprintln!("hmux-runtime: terminal output mutation failed: {error}");
                        drop(host);
                        drop(pty_writer);
                        state.diagnostics.record(
                            RuntimeDiagnosticEvent::TerminalPresentationDegraded,
                            RuntimeDiagnosticFields::terminal_presentation_degraded(
                                "terminal_mutation",
                                output_sequence,
                            ),
                        );
                        #[cfg(feature = "terminal-state-stream")]
                        {
                            let retired = state.retire_terminal_viewport_attachments(
                                &format!("the terminal mutation authority stopped: {error}"),
                                // Final: terminal_mutation_available stays false
                                // for the rest of this provider epoch, so a
                                // successor attach can never receive a frame.
                                ViewportRetirement::Final,
                            );
                            eprintln!(
                                "hmux-runtime: terminal mutation authority stopped; retired {retired} viewport attachment(s), preserved the provider, and kept draining PTY output"
                            );
                        }
                        // The terminal model cannot safely resume in this
                        // provider epoch, but presentation failure must never
                        // apply backpressure to the provider. Keep consuming
                        // the PTY without creating a second model authority.
                        terminal_mutation_available = false;
                        continue;
                    }
                };
                #[cfg(feature = "terminal-state-stream")]
                let ingested_output_sequence = ingested.delta.output_seq;
                #[cfg(feature = "terminal-state-stream")]
                let terminal_records = ingested.terminal_records;
                #[cfg(feature = "terminal-state-stream")]
                let terminal_event_overflow = ingested.terminal_event_overflow;
                let broadcasts = [FrameBody::OutputDelta(ingested.delta)];
                #[cfg(feature = "terminal-state-stream")]
                let presentation_degradation = ingested.presentation_degradation;
                #[cfg(feature = "terminal-state-stream")]
                let history_degradation = ingested.history_degradation;
                drop(host);

                if ingested.pty_reply_overflow || !pty_writer.enqueue_replies(&ingested.pty_replies)
                {
                    eprintln!(
                        "hmux-runtime: terminal-generated PTY reply budget exhausted; dropping the reply batch"
                    );
                } else if input.is_some() {
                    flush_replies(&mut pty_writer);
                }
                drop(pty_writer);
                drop(input);
                #[cfg(feature = "terminal-state-stream")]
                if terminal_event_overflow {
                    eprintln!(
                        "hmux-runtime: terminal event budget exhausted; dropped the oversized event"
                    );
                }
                let Ok(_publish_order) = state.publish_order.lock() else {
                    break;
                };
                for body in broadcasts {
                    state.broadcast_ordered(body);
                }
                #[cfg(feature = "terminal-state-stream")]
                let mut terminal_publication_failed = false;
                #[cfg(feature = "terminal-state-stream")]
                for record in terminal_records {
                    terminal_publication_failed |= !state.broadcast_terminal_record_ordered(record);
                }
                #[cfg(feature = "terminal-state-stream")]
                let viewport_publication_failed = presentation_degradation.is_none()
                    && !state
                        .viewport_publication
                        .mark_output_dirty(ingested_output_sequence, output_observed_at);
                drop(_publish_order);
                #[cfg(feature = "terminal-state-stream")]
                if let Some(degradation) = history_degradation {
                    let code = terminal_history_degradation_code(&degradation);
                    state.diagnostics.record(
                        RuntimeDiagnosticEvent::TerminalHistoryDegraded,
                        RuntimeDiagnosticFields::terminal_presentation_degraded(
                            code,
                            ingested_output_sequence,
                        ),
                    );
                    eprintln!(
                        "hmux-runtime: cold terminal history disabled after {code}; preserving the provider and viewport attachment"
                    );
                }
                #[cfg(feature = "terminal-state-stream")]
                if terminal_publication_failed {
                    let retired = state.retire_terminal_viewport_attachments(
                        "terminal event publication is unavailable",
                        ViewportRetirement::Retryable,
                    );
                    if retired > 0 {
                        eprintln!(
                            "hmux-runtime: retired {retired} viewport attachment(s) because terminal event publication is unavailable"
                        );
                    }
                } else if let Some(degradation) = presentation_degradation {
                    let code = terminal_presentation_degradation_code(degradation);
                    state.diagnostics.record(
                        RuntimeDiagnosticEvent::TerminalPresentationDegraded,
                        RuntimeDiagnosticFields::terminal_presentation_degraded(
                            code,
                            ingested_output_sequence,
                        ),
                    );
                    let retired = state.retire_terminal_viewport_attachments(
                        &format!("terminal presentation degraded after committed output ({code})"),
                        ViewportRetirement::Retryable,
                    );
                    eprintln!(
                        "hmux-runtime: terminal presentation degraded after committed output; retired {retired} viewport attachment(s) and preserved the provider"
                    );
                } else if viewport_publication_failed {
                    let retired = state.retire_terminal_viewport_attachments(
                        "terminal viewport publication is unavailable",
                        // Final: mark_dirty only reports false once the
                        // publication is closed, poisoned, or its generation
                        // overflowed — none of which a reattach undoes.
                        ViewportRetirement::Final,
                    );
                    if retired > 0 {
                        eprintln!(
                            "hmux-runtime: retired {retired} viewport attachment(s) because publication is unavailable"
                        );
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
    }
}

fn flush_replies(writer: &mut pty_io::PtyIo) {
    if writer.flush_replies().is_err() {
        eprintln!(
            "hmux-runtime: terminal-generated PTY reply write failed; preserving the provider"
        );
    }
}
