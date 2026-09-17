use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(super) fn wait_for_exact_markers<const N: usize>(
    stage: &str,
    markers: [&str; N],
    nominal_wait: Duration,
    mut read: impl FnMut() -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    assert!(!stage.is_empty() && N > 0 && markers.iter().all(|marker| !marker.is_empty()));
    // Preserve the quiet polling allowance, including the first immediate read.
    // Scheduling and read work cannot spend observations that never happened.
    // Each native read retains its own existing transport deadline.
    let observations = usize::try_from(nominal_wait.as_nanos().div_ceil(POLL_INTERVAL.as_nanos()))
        .expect("fixture observation budget fits usize")
        .checked_add(1)
        .expect("fixture observation budget includes its first read");
    let started = Instant::now();
    let mut last_counts = None;
    for observation in 1..=observations {
        let snapshot = read().map_err(|detail| {
            failure(
                stage,
                "read_failed",
                observation,
                markers,
                last_counts,
                Some(&detail),
            )
        })?;
        let counts = markers.map(|marker| occurrences(&snapshot, marker.as_bytes()));
        last_counts = Some(counts);
        if counts.iter().any(|count| *count > 1) {
            return Err(failure(
                stage,
                "duplicate",
                observation,
                markers,
                last_counts,
                None,
            ));
        }
        if counts.iter().all(|count| *count == 1) {
            if std::env::var("DURE_QA_COMMAND_INPUT_CONTENTION").as_deref() == Ok("1") {
                eprintln!(
                    "hmux_marker_converged stage={stage:?} observations={observation} elapsed_ms={}",
                    started.elapsed().as_millis(),
                );
            }
            return Ok(snapshot);
        }
        if observation == observations {
            return Err(failure(
                stage,
                "missing",
                observation,
                markers,
                last_counts,
                None,
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    unreachable!("positive observation budget returns a result")
}

fn failure<const N: usize>(
    stage: &str,
    kind: &str,
    observation: usize,
    markers: [&str; N],
    counts: Option<[usize; N]>,
    detail: Option<&str>,
) -> String {
    let occurrences = markers
        .iter()
        .enumerate()
        .map(|(index, marker)| {
            let count = counts.map_or_else(
                || "unobserved".to_string(),
                |values| values[index].to_string(),
            );
            format!("{marker:?}:{count}")
        })
        .collect::<Vec<_>>()
        .join(",");
    let detail = detail.map(|value| value.chars().take(256).collect::<String>());
    format!(
        "hmux_marker_convergence_failed stage={stage:?} kind={kind} observations={observation} markers=[{occurrences}] detail={detail:?}"
    )
}

fn occurrences(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .filter(|part| *part == needle)
        .count()
}

/// Bounded CPU competition inside the observer fixture. The Host remains free
/// to publish while the observer is occupied processing an older snapshot.
pub(super) fn observer_cpu_contention(duration: Duration) {
    let deadline = Instant::now() + duration;
    let compete = || {
        while Instant::now() < deadline {
            std::hint::spin_loop();
        }
    };
    std::thread::scope(|scope| {
        scope.spawn(compete);
        compete();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_contention_does_not_spend_unmade_observations() {
        for repetition in 0..8 {
            let mut observations = 0;
            let result = wait_for_exact_markers(
                "provider_ready",
                ["READY"],
                Duration::from_millis(100),
                || {
                    observations += 1;
                    if observations == 1 {
                        observer_cpu_contention(Duration::from_millis(120));
                        Ok(Vec::new())
                    } else {
                        Ok(b"READY".to_vec())
                    }
                },
            );
            assert_eq!(result, Ok(b"READY".to_vec()), "repetition {repetition}");
            assert_eq!(observations, 2);
        }
    }

    #[test]
    fn missing_marker_reports_stage_counts_and_a_bounded_observation_count() {
        let mut reads = 0;
        let error = wait_for_exact_markers(
            "semantic_submit",
            ["FIRST", "SECOND"],
            Duration::from_millis(40),
            || {
                reads += 1;
                Ok(b"FIRST".to_vec())
            },
        )
        .unwrap_err();
        assert_eq!(reads, 3);
        assert!(error.contains("stage=\"semantic_submit\""), "{error}");
        assert!(error.contains("kind=missing"), "{error}");
        assert!(error.contains("observations=3"), "{error}");
        assert!(
            error.contains("\"FIRST\":1") && error.contains("\"SECOND\":0"),
            "{error}"
        );
    }

    #[test]
    fn duplicate_marker_fails_before_a_later_snapshot_can_hide_it() {
        let mut reads = 0;
        let error =
            wait_for_exact_markers("exactly_once", ["READY"], Duration::from_millis(40), || {
                reads += 1;
                Ok(if reads == 1 {
                    b"READY READY".to_vec()
                } else {
                    b"READY".to_vec()
                })
            })
            .expect_err("a later screen must not erase duplicate evidence");
        assert_eq!(reads, 1);
        assert!(
            error.contains("kind=duplicate") && error.contains("\"READY\":2"),
            "{error}"
        );
    }

    #[test]
    fn read_failure_reports_the_last_successful_counts() {
        let mut reads = 0;
        let error = wait_for_exact_markers(
            "read_screen",
            ["FIRST", "SECOND"],
            Duration::from_millis(40),
            || {
                reads += 1;
                if reads == 1 {
                    Ok(b"FIRST".to_vec())
                } else {
                    Err("fixture_read_failed".into())
                }
            },
        )
        .unwrap_err();
        assert_eq!(reads, 2);
        assert!(
            error.contains("kind=read_failed") && error.contains("observations=2"),
            "{error}"
        );
        assert!(
            error.contains("\"FIRST\":1") && error.contains("\"SECOND\":0"),
            "{error}"
        );
        assert!(error.contains("fixture_read_failed"), "{error}");
    }
}
