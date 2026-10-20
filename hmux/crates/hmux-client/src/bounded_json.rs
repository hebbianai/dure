//! Linear byte fitting for compact JSON documents with one bounded array.
//!
//! Bounded catalog producers drop trailing array elements until the whole
//! document fits a byte budget. Re-serializing the complete document after
//! each dropped element costs one full encoding per drop, which grows with the
//! square of the catalog and can consume a caller's whole wall-clock budget
//! before any result is returned. These helpers encode every element once and
//! derive each candidate document length exactly.

use serde::Serialize;
use std::io;

/// Exact byte length of `value` in `serde_json`'s compact encoding, measured
/// without materializing the encoded bytes.
pub fn compact_json_len<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<usize> {
    let mut counter = ByteCounter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

/// Largest retained prefix of one array whose enclosing compact JSON document
/// fits `max_bytes`.
///
/// Compact JSON writes an array as `[`, its elements joined by `,`, and `]`,
/// and an element's encoding does not depend on its position. The document
/// carrying the first `n` elements is therefore exactly its empty-array
/// envelope, plus those elements' encodings, plus `n - 1` separators.
/// `element_bytes[i]` is [`compact_json_len`] of element `i`, and
/// `envelope_bytes(n)` is the budgeted length of the same document with the
/// metadata for `n` retained elements and an empty array.
///
/// Returns the largest `n <= element_bytes.len()` that fits, never fewer than
/// `minimum`; `None` means even `minimum` retained elements exceed the budget.
pub fn longest_fitting_json_prefix<E>(
    element_bytes: &[usize],
    minimum: usize,
    max_bytes: usize,
    mut envelope_bytes: impl FnMut(usize) -> Result<usize, E>,
) -> Result<Option<usize>, E> {
    let mut retained = element_bytes.len();
    let mut retained_bytes = element_bytes
        .iter()
        .fold(0_usize, |total, bytes| total.saturating_add(*bytes));
    loop {
        let document_bytes = envelope_bytes(retained)?
            .saturating_add(retained_bytes)
            .saturating_add(retained.saturating_sub(1));
        if document_bytes <= max_bytes {
            return Ok(Some(retained));
        }
        if retained <= minimum {
            return Ok(None);
        }
        retained -= 1;
        retained_bytes = retained_bytes.saturating_sub(element_bytes[retained]);
    }
}

struct ByteCounter(usize);

impl io::Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Element {
        name: String,
        labels: Vec<String>,
        attributes: BTreeMap<String, Option<u64>>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Document<'a> {
        schema_version: u16,
        elements: &'a [Element],
        truncated: bool,
        omitted_count: usize,
    }

    /// The document for `retained` of `total` elements. The metadata width
    /// changes with `retained`, so envelopes must be measured per candidate.
    fn document(elements: &[Element], retained: usize, total: usize) -> Document<'_> {
        Document {
            schema_version: 1,
            elements,
            truncated: retained < total,
            omitted_count: total - retained,
        }
    }

    fn elements() -> Vec<Element> {
        (0..24)
            .map(|index| Element {
                // Escapes, multi-byte text, and growing widths must all be
                // counted exactly as the final encoding writes them.
                name: format!(
                    "element-{index}-\"quoted\"\\\n\u{1}-\u{d55c}\u{ae00}-{}",
                    "x".repeat(index)
                ),
                labels: (0..index % 5)
                    .map(|label| format!("label-{label}"))
                    .collect(),
                attributes: (0..index % 3)
                    .map(|key| (format!("key-{key}"), (key % 2 == 0).then_some(index as u64)))
                    .collect(),
            })
            .collect()
    }

    fn element_bytes(elements: &[Element]) -> Vec<usize> {
        elements
            .iter()
            .map(|element| compact_json_len(element).unwrap())
            .collect()
    }

    fn materialized_len(elements: &[Element], retained: usize) -> usize {
        serde_json::to_vec(&document(&elements[..retained], retained, elements.len()))
            .unwrap()
            .len()
    }

    #[test]
    fn compact_length_matches_the_materialized_encoding() {
        for element in elements() {
            assert_eq!(
                compact_json_len(&element).unwrap(),
                serde_json::to_vec(&element).unwrap().len()
            );
        }
    }

    #[test]
    fn every_planned_prefix_length_is_exact() {
        let elements = elements();
        let total = elements.len();
        let element_bytes = element_bytes(&elements);
        for retained in 0..=total {
            let exact = materialized_len(&elements, retained);
            let plan = |budget| {
                longest_fitting_json_prefix(&element_bytes[..retained], 0, budget, |kept| {
                    compact_json_len(&document(&[], kept, total))
                })
                .unwrap()
            };
            // A budget of exactly this document admits it, and one byte less
            // does not, so the derived length is neither over nor under.
            assert_eq!(plan(exact), Some(retained));
            if retained > 0 {
                assert!(plan(exact - 1).is_some_and(|kept| kept < retained));
            }
        }
    }

    #[test]
    fn the_longest_fitting_prefix_matches_repeated_full_serialization() {
        let elements = elements();
        let total = elements.len();
        let element_bytes = element_bytes(&elements);
        let materialized = (0..=total)
            .map(|retained| materialized_len(&elements, retained))
            .collect::<Vec<_>>();
        // Every boundary where some prefix starts or stops fitting.
        let budgets = materialized
            .iter()
            .flat_map(|bytes| [bytes - 1, *bytes, bytes + 1])
            .chain([0]);
        for budget in budgets {
            for minimum in [0, 3, total] {
                // Reference: drop one element at a time and re-serialize.
                let mut expected = Some(total);
                while let Some(retained) = expected {
                    if materialized[retained] <= budget {
                        break;
                    }
                    expected = (retained > minimum).then(|| retained - 1);
                }
                let actual = longest_fitting_json_prefix(&element_bytes, minimum, budget, |kept| {
                    compact_json_len(&document(&[], kept, total))
                })
                .unwrap();
                assert_eq!(actual, expected, "budget={budget} minimum={minimum}");
            }
        }
    }
}
