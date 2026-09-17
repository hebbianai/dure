//! Consent resolution for anonymous usage telemetry — the one place that
//! decides whether an event may leave this machine.
//!
//! The order is fixed by the founder decision of 2026-09-17 and mirrors
//! Orca: a build without a key can never send; `DO_NOT_TRACK` and
//! `DURE_TELEMETRY_DISABLED` beat everything stored; CI never reports; only
//! then does the person's own recorded choice count, and no choice means no
//! transmission. Environment variables never overwrite the stored choice —
//! unsetting them restores whatever the person decided.

use std::ffi::OsStr;

pub(crate) const DO_NOT_TRACK_ENV: &str = "DO_NOT_TRACK";
pub(crate) const DISABLED_ENV: &str = "DURE_TELEMETRY_DISABLED";
/// The variables continuous-integration hosts set; any one of them set to a
/// truthy value marks this process as automation, never a person.
pub(crate) const CI_ENVS: [&str; 8] = [
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "TRAVIS",
    "BUILDKITE",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
];

/// The person's recorded answer to the notice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Choice {
    Accepted,
    Declined,
}

/// Why nothing is sent; the Settings page names it next to the disabled switch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DisabledReason {
    /// This build carries no project key, so there is nowhere to send to.
    NoKey,
    DoNotTrack,
    EnvDisabled,
    Ci,
    Declined,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effective {
    Enabled,
    /// No answer yet: nothing is transmitted, the notice is shown.
    Pending,
    Disabled(DisabledReason),
}

/// The process environment as the resolver sees it, captured once per
/// decision so tests inject values without touching the real environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EnvSnapshot {
    do_not_track: bool,
    disabled: bool,
    ci: bool,
}

impl EnvSnapshot {
    pub(crate) fn from_process() -> Self {
        Self::from_lookup(|name| std::env::var_os(name).is_some_and(|value| flag_is_set(&value)))
    }

    /// `lookup(name)` reports whether that variable is set to a truthy value.
    pub(crate) fn from_lookup(lookup: impl Fn(&str) -> bool) -> Self {
        Self {
            do_not_track: lookup(DO_NOT_TRACK_ENV),
            disabled: lookup(DISABLED_ENV),
            ci: CI_ENVS.iter().any(|name| lookup(name)),
        }
    }
}

/// An environment flag counts as set for every non-empty value except an
/// explicit negative. Fail closed: `DO_NOT_TRACK=yes` or `=on` is somebody
/// asking not to be tracked, and a value the convention never defined is
/// still not permission.
pub(crate) fn flag_is_set(value: &OsStr) -> bool {
    let Some(text) = value.to_str() else {
        return true;
    };
    let text = text.trim();
    !(text.is_empty()
        || ["0", "false", "no", "off"]
            .iter()
            .any(|negative| text.eq_ignore_ascii_case(negative)))
}

pub(crate) fn effective(env: &EnvSnapshot, stored: Option<Choice>, key_present: bool) -> Effective {
    if !key_present {
        return Effective::Disabled(DisabledReason::NoKey);
    }
    if env.do_not_track {
        return Effective::Disabled(DisabledReason::DoNotTrack);
    }
    if env.disabled {
        return Effective::Disabled(DisabledReason::EnvDisabled);
    }
    if env.ci {
        return Effective::Disabled(DisabledReason::Ci);
    }
    match stored {
        Some(Choice::Accepted) => Effective::Enabled,
        Some(Choice::Declined) => Effective::Disabled(DisabledReason::Declined),
        None => Effective::Pending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(values: &[(&str, &str)]) -> EnvSnapshot {
        let map: HashMap<&str, &str> = values.iter().copied().collect();
        EnvSnapshot::from_lookup(|name| {
            map.get(name)
                .is_some_and(|value| flag_is_set(OsStr::new(value)))
        })
    }

    #[test]
    fn no_choice_is_pending_and_a_choice_is_honoured() {
        assert_eq!(effective(&env(&[]), None, true), Effective::Pending);
        assert_eq!(
            effective(&env(&[]), Some(Choice::Accepted), true),
            Effective::Enabled
        );
        assert_eq!(
            effective(&env(&[]), Some(Choice::Declined), true),
            Effective::Disabled(DisabledReason::Declined)
        );
    }

    #[test]
    fn a_build_without_a_key_never_sends_whatever_was_chosen() {
        assert_eq!(
            effective(&env(&[]), Some(Choice::Accepted), false),
            Effective::Disabled(DisabledReason::NoKey)
        );
        assert_eq!(
            effective(&env(&[]), None, false),
            Effective::Disabled(DisabledReason::NoKey)
        );
    }

    #[test]
    fn do_not_track_beats_a_stored_accept_and_the_other_variables() {
        let all = env(&[
            ("DO_NOT_TRACK", "1"),
            ("DURE_TELEMETRY_DISABLED", "1"),
            ("CI", "true"),
        ]);
        assert_eq!(
            effective(&all, Some(Choice::Accepted), true),
            Effective::Disabled(DisabledReason::DoNotTrack)
        );
    }

    #[test]
    fn the_app_variable_beats_ci_and_the_stored_choice() {
        let both = env(&[("DURE_TELEMETRY_DISABLED", "1"), ("GITHUB_ACTIONS", "true")]);
        assert_eq!(
            effective(&both, Some(Choice::Accepted), true),
            Effective::Disabled(DisabledReason::EnvDisabled)
        );
    }

    #[test]
    fn every_ci_variable_disables_without_touching_the_choice() {
        for name in CI_ENVS {
            let value = if name == "JENKINS_URL" {
                "https://ci.example.test/"
            } else {
                "1"
            };
            assert_eq!(
                effective(&env(&[(name, value)]), Some(Choice::Accepted), true),
                Effective::Disabled(DisabledReason::Ci),
                "{name}"
            );
            assert_eq!(
                effective(&env(&[(name, value)]), None, true),
                Effective::Disabled(DisabledReason::Ci),
                "{name}"
            );
        }
    }

    #[test]
    fn unrecognised_values_count_as_set_and_explicit_negatives_do_not() {
        for set in ["1", "true", "yes", "on", "TRUE", " 1 ", "anything"] {
            assert!(flag_is_set(OsStr::new(set)), "{set:?}");
        }
        for unset in ["", "0", "false", "FALSE", "no", "off", "  "] {
            assert!(!flag_is_set(OsStr::new(unset)), "{unset:?}");
        }
        assert_eq!(
            effective(&env(&[("DO_NOT_TRACK", "yes")]), Some(Choice::Accepted), true),
            Effective::Disabled(DisabledReason::DoNotTrack)
        );
        assert_eq!(
            effective(&env(&[("CI", "false")]), Some(Choice::Accepted), true),
            Effective::Enabled
        );
    }
}
