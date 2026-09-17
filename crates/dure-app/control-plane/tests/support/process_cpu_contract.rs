use std::hint::black_box;
use std::mem::MaybeUninit;
use std::time::{Duration, Instant};

use super::{ProcessDelta, process_sample};

fn independent_cpu_nanos() -> u64 {
    let mut time = MaybeUninit::<libc::timespec>::zeroed();
    // SAFETY: the process CPU clock writes one timespec into the supplied
    // buffer. The value is read only after the call succeeds.
    let result = unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, time.as_mut_ptr()) };
    assert_eq!(
        result, 0,
        "the test's own process CPU clock must be readable"
    );
    // SAFETY: clock_gettime initialized this timespec successfully.
    let time = unsafe { time.assume_init() };
    u64::try_from(time.tv_sec).unwrap() * 1_000_000_000 + u64::try_from(time.tv_nsec).unwrap()
}

#[test]
fn native_cpu_time_matches_independent_process_clock() {
    let pid = std::process::id();
    let before_lower = independent_cpu_nanos();
    let before = process_sample(pid).expect("the test's own process must be observable");
    let before_upper = independent_cpu_nanos();

    // Use CPU time as the work budget so host scheduling does not masquerade
    // as process work. The wall deadline bounds a starved fixture.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut work = 1_u64;
    loop {
        for _ in 0..10_000 {
            work = black_box(work.wrapping_mul(6_364_136_223_846_793_005).rotate_left(7));
        }
        if independent_cpu_nanos() - before_upper >= 40_000_000 {
            break;
        }
        assert!(Instant::now() < deadline, "the CPU fixture was starved");
    }
    black_box(work);

    let after_lower = independent_cpu_nanos();
    let after = process_sample(pid).expect("the same test process must remain observable");
    let after_upper = independent_cpu_nanos();
    let delta = ProcessDelta::between(&before, &after);
    let report = serde_json::to_value(&delta).expect("the native delta must serialize");
    let reported =
        report["userCpuNanos"].as_u64().unwrap() + report["systemCpuNanos"].as_u64().unwrap();
    assert_eq!(delta.total_cpu_nanos(), Some(reported));

    // Both native reads lie inside these independent CPU-clock brackets.
    // Allow 100 us for platform accounting precision, not a percentage of
    // wall time or an assumed Mach timebase.
    let minimum = after_lower - before_upper;
    let maximum = after_upper - before_lower;
    println!(
        "native_cpu_contract pid={pid} reported_ns={reported} minimum_ns={minimum} maximum_ns={maximum}"
    );
    assert!(
        reported.saturating_add(100_000) >= minimum && reported <= maximum.saturating_add(100_000),
        "reported CPU {reported} ns must match independent bracket {minimum}..={maximum} ns"
    );
}
