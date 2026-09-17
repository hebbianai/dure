use super::{CatalogError, LENGTH_PREFIX_BYTES};
use crate::SshFrameReader;
use std::io::{self, Read};

pub(super) fn read_document(
    reader: &mut impl Read,
    maximum: usize,
) -> Result<Option<Vec<u8>>, CatalogError> {
    let mut prefix = [0_u8; LENGTH_PREFIX_BYTES];
    let mut read = 0;
    while read < prefix.len() {
        match reader.read(&mut prefix[read..]) {
            Ok(0) if read == 0 => return Ok(None),
            Ok(0) => {
                return Err(CatalogError::Response(
                    "the gateway closed inside a catalog length prefix".into(),
                ));
            }
            Ok(count) => read += count,
            Err(error) => return Err(response_io(error)),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > maximum {
        return Err(CatalogError::Response(format!(
            "the gateway declared a {length}-byte document outside the 1..={maximum} limit"
        )));
    }
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|error| match error.kind() {
            io::ErrorKind::UnexpectedEof => {
                CatalogError::Response("the gateway closed inside a catalog document".into())
            }
            _ => response_io(error),
        })?;
    Ok(Some(payload))
}

/// Returns a complete answer immediately, or waits for the command's final
/// outcome when stdout ended without one. The reader owns the deadline.
pub(crate) fn read_answer(
    reader: &mut SshFrameReader,
    maximum: usize,
) -> Result<Option<Vec<u8>>, CatalogError> {
    if let Some(payload) = read_document(reader, maximum)? {
        return Ok(Some(payload));
    }
    let completion = reader.wait_for_completion().map_err(response_io)?;
    match completion.failure_detail() {
        Some(_) => Err(CatalogError::CommandFailed(completion)),
        None => Ok(None),
    }
}

/// Finishes a single-answer exchange after its response was consumed.
/// A failure here cannot prove that the already-answered operation never ran.
pub(crate) fn finish_answer(
    reader: &mut SshFrameReader,
    maximum: usize,
) -> Result<(), CatalogError> {
    if read_document(reader, maximum)?.is_some() {
        return Err(CatalogError::Response(
            "the gateway returned more than one response".into(),
        ));
    }
    let completion = reader.wait_for_completion().map_err(response_io)?;
    match completion.failure_detail() {
        Some(detail) => Err(CatalogError::Response(detail)),
        None => Ok(()),
    }
}

pub(super) fn response_io(error: io::Error) -> CatalogError {
    CatalogError::Response(format!("could not read the gateway response: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::ChannelEvent;
    use crate::harness::Harness;
    use std::time::{Duration, Instant};

    const ANSWER: &[u8] = b"\0\0\0\x02{}";
    const PATIENCE: Duration = Duration::from_secs(5);

    #[test]
    fn a_post_answer_exit_cannot_be_classified_as_a_command_that_never_ran() {
        let harness = Harness::new(vec![]);
        harness.send(ANSWER);
        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"fixture post-answer failure".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(127)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();
        let error = harness
            .with_reader_within(PATIENCE, |reader| {
                reader.set_absolute_deadline(Some(Instant::now() + PATIENCE));
                assert_eq!(read_answer(reader, 1024).unwrap().unwrap(), b"{}");
                finish_answer(reader, 1024)
            })
            .unwrap_err();
        assert!(matches!(error, CatalogError::Response(_)));
        assert!(error.to_string().contains("fixture post-answer failure"));
        assert_eq!(
            crate::RemoteManagedCreateError::from(error).code(),
            "hmux_remote_managed_create_outcome_unknown"
        );
    }

    #[test]
    fn the_finisher_rejects_a_second_answer() {
        let harness = Harness::new(vec![]);
        harness.send(ANSWER);
        harness.send(ANSWER);
        let error = harness
            .with_reader_within(PATIENCE, |reader| {
                read_answer(reader, 1024).unwrap().unwrap();
                finish_answer(reader, 1024)
            })
            .unwrap_err();
        assert!(error.to_string().contains("more than one response"));
    }

    #[test]
    fn a_successful_answer_ignores_profile_stderr() {
        let harness = Harness::new(vec![]);
        harness.send(ANSWER);
        harness
            .events
            .send(ChannelEvent::Diagnostic(b"login profile notice".to_vec()))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(0)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();
        harness
            .with_reader_within(PATIENCE, |reader| {
                read_answer(reader, 1024).unwrap().unwrap();
                finish_answer(reader, 1024)
            })
            .unwrap();
    }
}
