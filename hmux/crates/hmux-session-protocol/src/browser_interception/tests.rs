use super::*;
use serde_json::json;

fn words(alphabet: &[char], length: usize) -> Vec<String> {
    let mut words = vec![String::new()];
    let mut level = words.clone();
    for _ in 0..length {
        level = level
            .iter()
            .flat_map(|prefix| alphabet.iter().map(move |ch| format!("{prefix}{ch}")))
            .collect();
        words.extend(level.clone());
    }
    words
}

#[test]
fn url_matching_agrees_with_independent_dynamic_programming() {
    for pattern in words(&['a', 'b', '*', '?'], 4)
        .into_iter()
        .filter(|word| !word.is_empty())
    {
        let parsed = BrowserUrlPattern::try_from(pattern.clone()).unwrap();
        let tokens: Vec<_> = pattern.chars().collect();
        for input in words(&['a', 'b'], 4) {
            let chars: Vec<_> = input.chars().collect();
            let mut table = vec![vec![false; chars.len() + 1]; tokens.len() + 1];
            table[0][0] = true;
            for i in 1..=tokens.len() {
                for j in 0..=chars.len() {
                    table[i][j] = if tokens[i - 1] == '*' {
                        table[i - 1][j] || (j > 0 && table[i][j - 1])
                    } else {
                        j > 0
                            && table[i - 1][j - 1]
                            && (tokens[i - 1] == '?' || tokens[i - 1] == chars[j - 1])
                    };
                }
            }
            assert_eq!(
                parsed.matches(&input),
                table[tokens.len()][chars.len()],
                "{pattern:?} {input:?}"
            );
        }
    }
}

#[test]
fn url_patterns_preserve_unicode_escapes_and_full_url_boundaries() {
    for (pattern, url, matches) in [
        ("**/한?/x*", "https://example/한글/xyz", true),
        (r"*\?q=\*", "https://example/?q=*", true),
        (r"*\?q=\*", "https://example/?q=no", false),
        ("/end", "https://example/end", false),
        ("*abc*def", "xxabczzabcdeff", false),
        ("*abc*def", "xxabczzabcdef", true),
    ] {
        let parsed: BrowserUrlPattern = serde_json::from_value(json!(pattern)).unwrap();
        assert_eq!(parsed.matches(url), matches, "{pattern} {url}");
        assert_eq!(serde_json::to_value(parsed).unwrap(), json!(pattern));
    }
    for pattern in ["", "bad\npattern", "bad\\"] {
        assert!(BrowserUrlPattern::try_from(pattern.to_owned()).is_err());
    }
}

#[test]
fn response_and_rule_boundaries_reject_ambiguous_or_unbounded_input() {
    let good = json!({"patterns":["*/one","*/two"],"resource_types":["Fetch","FETCH"],"effect":{"kind":"respond","body":"한글","status":201,"headers":{"Content-Type":"text/plain"}}});
    let parsed: BrowserRequestRule = serde_json::from_value(good.clone()).unwrap();
    assert!(parsed.matches("https://example/two", "Fetch"));
    assert!(!parsed.matches("https://example/two", "XHR"));
    assert_eq!(
        serde_json::to_value(parsed).unwrap()["resource_types"],
        json!(["fetch"])
    );
    for (field, value) in [
        ("patterns", json!([])),
        ("patterns", json!(vec!["*"; 33])),
        ("resource_types", json!(["made-up"])),
        ("resource_types", json!(["WebSocket"])),
        ("resource_types", json!(["Preflight"])),
        ("unexpected", json!(true)),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(serde_json::from_value::<BrowserRequestRule>(bad).is_err());
    }
    for (field, value) in [
        ("status", json!(199)),
        ("status", json!(204)),
        ("status", json!(600)),
        ("body", json!("a".repeat(256 * 1024 + 1))),
        ("headers", json!({"X-Test":"a\r\ninjected: b"})),
        ("headers", json!({"X":"a","x":"b"})),
        ("headers", json!({"Content-Length":"42"})),
    ] {
        let mut bad = good.clone();
        bad["effect"][field] = value;
        assert!(serde_json::from_value::<BrowserRequestRule>(bad).is_err());
    }
}

#[test]
fn removal_preserves_valid_rules_and_uses_exact_pattern_spelling() {
    let rule: BrowserRequestRule = serde_json::from_value(json!({
        "patterns":["*/한글,one","*/two","*/한글,one"],
        "resource_types":["fetch"],
        "effect":{"kind":"respond","body":"unchanged","status":201,"headers":{"X-Test":"yes"}}
    }))
    .unwrap();
    let unchanged = rule
        .clone()
        .excluding_pattern(&BrowserUrlPattern::try_from("https://x/한글,one".to_owned()).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(unchanged).unwrap(),
        serde_json::to_value(&rule).unwrap()
    );
    let remaining = rule
        .excluding_pattern(&BrowserUrlPattern::try_from("*/한글,one".to_owned()).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(&remaining).unwrap(),
        json!({
            "patterns":["*/two"],"resource_types":["fetch"],
            "effect":{"kind":"respond","body":"unchanged","status":201,"headers":{"X-Test":"yes"}}
        })
    );
    assert!(remaining
        .excluding_pattern(&BrowserUrlPattern::try_from("*/two".to_owned()).unwrap())
        .is_none());
    for invalid in [
        json!({"kind":"remove"}),
        json!({"kind":"remove","pattern":""}),
        json!({"kind":"remove","pattern":"*","unexpected":true}),
    ] {
        assert!(serde_json::from_value::<BrowserInterceptionAction>(invalid).is_err());
    }
}
