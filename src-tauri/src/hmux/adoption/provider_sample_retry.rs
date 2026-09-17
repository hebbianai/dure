use std::io;
use std::time::Duration;

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(25),
    Duration::from_millis(75),
    Duration::from_millis(150),
];

#[derive(Debug)]
pub(super) enum Failure {
    GenerationChanged,
    Observation,
}

pub(super) fn observe<T, Sample, SameGeneration, Pause>(
    mut sample: Sample,
    mut same_generation: SameGeneration,
    mut pause: Pause,
) -> Result<T, Failure>
where
    Sample: FnMut() -> io::Result<T>,
    SameGeneration: FnMut() -> bool,
    Pause: FnMut(Duration),
{
    let mut delays = RETRY_DELAYS.into_iter();
    loop {
        if !same_generation() {
            return Err(Failure::GenerationChanged);
        }
        match sample() {
            Ok(value) => return Ok(value),
            Err(error) if is_transient(error.kind()) => {
                let Some(delay) = delays.next() else {
                    return Err(Failure::Observation);
                };
                pause(delay);
            }
            Err(_) => return Err(Failure::Observation),
        }
    }
}

fn is_transient(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted | io::ErrorKind::TimedOut
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn transient_observations_retry_on_the_same_generation() {
        let attempts = Cell::new(0);
        let mut pauses = Vec::new();

        let observed = observe(
            || {
                let attempt = attempts.get() + 1;
                attempts.set(attempt);
                if attempt < 3 {
                    Err(io::Error::new(io::ErrorKind::WouldBlock, "busy"))
                } else {
                    Ok(41)
                }
            },
            || true,
            |delay| pauses.push(delay),
        )
        .unwrap();

        assert_eq!(observed, 41);
        assert_eq!(attempts.get(), 3);
        assert_eq!(pauses, RETRY_DELAYS[..2]);
    }

    #[test]
    fn persistent_transient_observation_exhausts_the_fixed_budget() {
        let attempts = Cell::new(0);
        let error = observe::<(), _, _, _>(
            || {
                attempts.set(attempts.get() + 1);
                Err(io::Error::new(io::ErrorKind::WouldBlock, "busy"))
            },
            || true,
            |_| {},
        )
        .unwrap_err();

        assert!(matches!(error, Failure::Observation));
        assert_eq!(attempts.get(), RETRY_DELAYS.len() + 1);
    }

    #[test]
    fn permanent_error_and_generation_change_never_retry() {
        let permanent_attempts = Cell::new(0);
        let permanent = observe::<(), _, _, _>(
            || {
                permanent_attempts.set(permanent_attempts.get() + 1);
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            },
            || true,
            |_| panic!("permanent observation must not pause"),
        )
        .unwrap_err();
        assert!(matches!(permanent, Failure::Observation));
        assert_eq!(permanent_attempts.get(), 1);

        let generation_attempts = Cell::new(0);
        let generation = observe::<(), _, _, _>(
            || {
                generation_attempts.set(generation_attempts.get() + 1);
                Ok(())
            },
            || false,
            |_| panic!("changed generation must not pause"),
        )
        .unwrap_err();
        assert!(matches!(generation, Failure::GenerationChanged));
        assert_eq!(generation_attempts.get(), 0);
    }
}
