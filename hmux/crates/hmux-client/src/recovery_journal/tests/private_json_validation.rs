use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

// Count only allocations inside the current test's explicit measurement.
// Other test threads and the harness continue to use the system allocator.
struct MeasuredAllocator;

thread_local! {
    static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) };
}

fn count_allocation() {
    let _ = ALLOCATIONS.try_with(|count| {
        if let Some(value) = count.get() {
            count.set(Some(value + 1));
        }
    });
}

// SAFETY: Every operation delegates the unchanged pointer/layout to System;
// the thread-local counter does not allocate or inspect allocated memory.
unsafe impl GlobalAlloc for MeasuredAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        // SAFETY: The caller supplies System's required allocation layout.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        // SAFETY: The caller supplies System's required allocation layout.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count_allocation();
        // SAFETY: The caller supplies the original allocation and new size.
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The caller supplies the original allocation and layout.
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: MeasuredAllocator = MeasuredAllocator;

fn allocations<T>(run: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ALLOCATIONS.set(None);
        }
    }
    assert_eq!(ALLOCATIONS.get(), None);
    ALLOCATIONS.set(Some(0));
    let reset = Reset;
    let value = run();
    let count = ALLOCATIONS.get().unwrap();
    drop(reset);
    (value, count)
}

fn checkpoint_json(count: usize, escaped: bool) -> String {
    let entry = if escaped {
        r#"{"path":"workspace\nprivate","argv":["agent","resume","conversation"],"flags":{"ready":true,"value":1.25,"empty":null}}"#
    } else {
        r#"{"path":"workspace/private","argv":["agent","resume","conversation"],"flags":{"ready":true,"value":1.25,"empty":null}}"#
    };
    format!("[{}]", vec![entry; count].join(","))
}

#[test]
fn valid_checkpoint_validation_does_not_materialize_json_trees() {
    for count in [1, 128] {
        let json = checkpoint_json(count, false);
        let (reference, reference_allocations) =
            allocations(|| serde_json::from_str::<serde_json::Value>(&json));
        assert!(reference.is_ok());
        assert!(reference_allocations > count);
        let (result, measured) = allocations(|| validate_private_json("test", &json));
        result.unwrap();
        assert_eq!(
            measured, 0,
            "allocated {measured} times for {count} records"
        );
    }
}

#[test]
fn escaped_checkpoint_validation_reuses_bounded_parser_scratch() {
    let single = checkpoint_json(1, true);
    let many = checkpoint_json(128, true);
    let (single_result, single_allocations) =
        allocations(|| validate_private_json("test", &single));
    single_result.unwrap();
    let (many_result, many_allocations) = allocations(|| validate_private_json("test", &many));
    many_result.unwrap();
    assert_eq!(many_allocations, single_allocations);
    assert!(many_allocations < 8);
}

fn assert_same_acceptance(value: &str) {
    let expected = !value.is_empty()
        && value.len() <= MAX_RECOVERY_OPERATION_PAYLOAD_BYTES
        && serde_json::from_str::<serde_json::Value>(value).is_ok();
    let actual = validate_private_json("test", value);
    assert_eq!(actual.is_ok(), expected, "different acceptance: {value:?}");
    if !expected {
        assert_eq!(
            actual.unwrap_err(),
            "hmux_recovery_journal_invalid: test is not bounded canonical JSON"
        );
    }
}

#[test]
fn checkpoint_validation_preserves_value_parser_acceptance() {
    for value in [
        "",
        " ",
        "null",
        "true",
        "false",
        "0",
        "-0",
        "1.25",
        "1e308",
        "1e309",
        "-1e999",
        "1e-999",
        "18446744073709551616",
        "-9223372036854775809",
        "01",
        "+1",
        "1.",
        "1e",
        "NaN",
        "Infinity",
        "null null",
        "true\0",
        "[1,]",
        "{\"x\":1,}",
        "{1:2}",
        "{\"x\":1,\"x\":2}",
        "{\"x\":1e999,\"x\":0}",
        "\"한글 😀\"",
        r#""\uD83D\uDE00""#,
        r#""\uD800""#,
        r#""\uDC00""#,
        r#""\u0000""#,
        r#""\x00""#,
        "\"literal\nnewline\"",
        "\"unterminated",
        "{\"nested\":[true,false,null,{\"key\":\"value\"}]}",
    ] {
        assert_same_acceptance(value);
    }
    for depth in 0..=132 {
        assert_same_acceptance(&format!("{}0{}", "[".repeat(depth), "]".repeat(depth)));
        assert_same_acceptance(&format!(
            "{}0{}",
            "{\"a\":".repeat(depth),
            "}".repeat(depth)
        ));
    }
    for length in [
        MAX_RECOVERY_OPERATION_PAYLOAD_BYTES - 2,
        MAX_RECOVERY_OPERATION_PAYLOAD_BYTES - 1,
    ] {
        assert_same_acceptance(&format!("\"{}\"", "a".repeat(length)));
    }
}

#[test]
fn checkpoint_validation_preserves_mutated_json_acceptance() {
    for seed in [
        checkpoint_json(1, true),
        r#"{"a":[-1.25e+20,"\uD83D\uDE00",false,null],"b":{}}"#.into(),
    ] {
        for index in 0..seed.len() {
            assert_same_acceptance(&seed[..index]);
            for byte in 0..=127 {
                let mut candidate = seed.as_bytes().to_vec();
                candidate[index] = byte;
                assert_same_acceptance(std::str::from_utf8(&candidate).unwrap());
            }
        }
    }
}

#[test]
fn checkpoint_validation_timing_observation() {
    let json = checkpoint_json(128, true);
    let mut samples = Vec::new();
    for _ in 0..5 {
        let started = std::time::Instant::now();
        for _ in 0..32 {
            std::hint::black_box(serde_json::from_str::<serde_json::Value>(&json).unwrap());
        }
        let reference_us = started.elapsed().as_micros();
        let started = std::time::Instant::now();
        for _ in 0..32 {
            validate_private_json("test", std::hint::black_box(&json)).unwrap();
        }
        samples.push((reference_us, started.elapsed().as_micros()));
    }
    eprintln!("checkpoint validation (Value microseconds, validation microseconds): {samples:?}");
}
