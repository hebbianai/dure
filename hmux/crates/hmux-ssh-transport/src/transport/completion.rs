use super::{ChannelCompletion, SshFrameReader};
use std::io;
use std::time::Instant;

impl SshFrameReader {
    pub(crate) fn wait_for_completion(&self) -> io::Result<ChannelCompletion> {
        let phase_deadline = self.completion_timeout.and_then(|timeout| {
            self.frame_started
                .unwrap_or_else(Instant::now)
                .checked_add(timeout)
        });
        let deadline = match (self.absolute_deadline, phase_deadline) {
            (Some(absolute), Some(phase)) => Some(absolute.min(phase)),
            (absolute, phase) => absolute.or(phase),
        };
        self.session.shared().inbound.wait_for_completion(deadline)
    }
}

#[cfg(test)]
mod tests {
    use crate::catalog::read_answer;
    use crate::channel::ChannelEvent;
    use crate::harness::{Harness, codec};
    use hmux_session_protocol::transport::{FrameReader, TransportInterrupt};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    const PATIENCE: Duration = Duration::from_secs(5);

    #[test]
    fn detach_interrupts_a_wait_after_stdout_eof() {
        let harness = Harness::new(vec![]);
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.with_reader(|reader| reader.wait_readable(Some(PATIENCE)).unwrap());
        let interrupt = harness.interrupt.clone();
        let detach = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            interrupt.interrupt();
        });
        let result = harness.with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()));
        detach.join().unwrap();
        assert!(matches!(
            result,
            Err(hmux_session_protocol::transport::TransportError::Interrupted)
        ));
    }

    #[test]
    fn command_completion_uses_the_remaining_absolute_budget() {
        let harness = Harness::new(vec![]);
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        let result = harness.with_reader_within(PATIENCE, |reader| {
            reader.set_completion_timeout(Some(Duration::from_secs(60)));
            reader.set_absolute_deadline(Some(Instant::now() + Duration::from_millis(30)));
            reader.read_frame(&codec())
        });
        let hmux_session_protocol::transport::TransportError::Io { source, .. } =
            result.unwrap_err()
        else {
            panic!("completion did not report its deadline");
        };
        assert_eq!(source.kind(), std::io::ErrorKind::TimedOut);
    }

    #[test]
    fn frame_eof_waits_for_the_late_command_status() {
        let harness = Harness::new(vec![]);
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.with_reader(|reader| reader.wait_readable(Some(PATIENCE)).unwrap());
        let (done, results) = mpsc::sync_channel(1);
        let (premature, result) = thread::scope(|scope| {
            scope.spawn(|| {
                let result = harness.with_reader(|reader| reader.read_frame(&codec()));
                let _ = done.send(result);
            });
            let premature = results.recv_timeout(Duration::from_millis(100)).ok();
            harness
                .events
                .send(ChannelEvent::Diagnostic(
                    b"hmux: command not found\n".to_vec(),
                ))
                .unwrap();
            harness.events.send(ChannelEvent::Exited(127)).unwrap();
            harness.events.send(ChannelEvent::Ended).unwrap();
            let returned_early = premature.is_some();
            let result = premature.or_else(|| results.recv_timeout(PATIENCE).ok());
            if result.is_none() {
                harness.interrupt.interrupt();
            }
            (returned_early, result)
        });
        assert!(!premature, "data EOF was mistaken for command completion");
        let error = result
            .expect("completion must wake the reader")
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("127"), "{message}");
        assert!(message.contains("command not found"), "{message}");
    }

    #[test]
    fn completion_timeout_keeps_the_buffered_stderr() {
        let harness = Harness::new(vec![]);
        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"fixture startup stalled\n".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        let deadline = Instant::now() + Duration::from_millis(50);
        let error = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_answer(reader, 1024)
            })
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("deadline"), "{message}");
        assert!(message.contains("fixture startup stalled"), "{message}");
    }

    #[test]
    fn successful_completion_ignores_profile_stderr() {
        let harness = Harness::new(vec![]);
        harness
            .events
            .send(ChannelEvent::Diagnostic(b"login profile notice\n".to_vec()))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(0)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();
        let result = harness.with_reader_within(PATIENCE, |reader| reader.read_frame(&codec()));
        assert!(matches!(result, Ok(None)), "{result:?}");
    }
}
