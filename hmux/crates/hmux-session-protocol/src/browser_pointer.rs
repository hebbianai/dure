//! Neutral pointer proposals and the Host's held-contact projection.

use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserMouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

impl BrowserMouseButton {
    pub fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Right => 2,
            Self::Middle => 4,
            Self::Back => 8,
            Self::Forward => 16,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(try_from = "PointerAction")]
pub struct BrowserPointerAction(PointerAction);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PointerAction {
    Move {
        x: f64,
        y: f64,
    },
    Down {
        #[serde(default)]
        button: BrowserMouseButton,
        x: Option<f64>,
        y: Option<f64>,
    },
    Up {
        #[serde(default)]
        button: BrowserMouseButton,
        x: Option<f64>,
        y: Option<f64>,
    },
    Wheel {
        x: Option<f64>,
        y: Option<f64>,
        #[serde(default)]
        delta_x: f64,
        delta_y: f64,
    },
}

impl TryFrom<PointerAction> for BrowserPointerAction {
    type Error = &'static str;
    fn try_from(value: PointerAction) -> Result<Self, Self::Error> {
        let position = |x, y| match (x, y) {
            (Some(x), Some(y)) => Ok([x, y]),
            (None, None) => Ok([0.0, 0.0]),
            _ => Err("browser_mouse_invalid"),
        };
        let (coordinates, deltas) = match value {
            PointerAction::Move { x, y } => ([x, y], [0.0, 0.0]),
            PointerAction::Wheel {
                x,
                y,
                delta_x,
                delta_y,
            } => (position(x, y)?, [delta_x, delta_y]),
            PointerAction::Down { x, y, .. } | PointerAction::Up { x, y, .. } => {
                (position(x, y)?, [0.0, 0.0])
            }
        };
        let numbers = [coordinates[0], coordinates[1], deltas[0], deltas[1]];
        if numbers
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 1_000_000.0)
        {
            return Err("browser_mouse_invalid");
        }
        Ok(Self(value))
    }
}

impl BrowserPointerAction {
    pub fn action(self) -> PointerAction {
        self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPointerContact {
    pub page: BrowserPageIdentity,
    pub buttons: u8,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(try_from = "TouchAction")]
pub struct BrowserTouchAction(TouchAction);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TouchAction {
    Start { x: f64, y: f64 },
    Move { x: f64, y: f64 },
    End {},
    Cancel {},
}

impl TryFrom<TouchAction> for BrowserTouchAction {
    type Error = &'static str;
    fn try_from(value: TouchAction) -> Result<Self, Self::Error> {
        if let TouchAction::Start { x, y } | TouchAction::Move { x, y } = value {
            if [x, y]
                .iter()
                .any(|v| !v.is_finite() || v.abs() > 1_000_000.0)
            {
                return Err("browser_touch_invalid");
            }
        }
        Ok(Self(value))
    }
}

impl BrowserTouchAction {
    pub fn action(self) -> TouchAction {
        self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserTouchContact {
    pub page: BrowserPageIdentity,
}

#[cfg(test)]
mod pointer_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wheel_positions_are_optional_pairs_with_bounded_coordinates_and_deltas() {
        for value in [
            json!({"kind":"wheel","delta_y":10}),
            json!({"kind":"wheel","x":-10.5,"y":1000000,"delta_x":-2,"delta_y":10}),
        ] {
            assert!(serde_json::from_value::<BrowserPointerAction>(value).is_ok());
        }
        for value in [
            json!({"kind":"wheel","x":1,"delta_y":10}),
            json!({"kind":"wheel","y":1,"delta_y":10}),
            json!({"kind":"wheel","x":1000001,"y":1,"delta_y":10}),
            json!({"kind":"wheel","x":1,"y":2,"delta_y":1000001}),
            json!({"kind":"wheel","x":1,"y":2,"delta_y":10,"target":"other"}),
        ] {
            assert!(serde_json::from_value::<BrowserPointerAction>(value).is_err());
        }
        for (x, y, delta_x, delta_y) in [
            (f64::NAN, 0.0, 0.0, 1.0),
            (0.0, f64::INFINITY, 0.0, 1.0),
            (0.0, 0.0, f64::NAN, 1.0),
            (0.0, 0.0, 0.0, f64::INFINITY),
        ] {
            assert!(BrowserPointerAction::try_from(PointerAction::Wheel {
                x: Some(x),
                y: Some(y),
                delta_x,
                delta_y
            })
            .is_err());
        }
    }
}

#[cfg(test)]
mod touch_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn touch_proposals_validate_coordinates_and_cannot_supply_another_target() {
        for value in [
            json!({"kind":"start","x":20.5,"y":-10}),
            json!({"kind":"move","x":0,"y":1000000}),
            json!({"kind":"end"}),
            json!({"kind":"cancel"}),
        ] {
            assert!(serde_json::from_value::<BrowserTouchAction>(value).is_ok());
        }
        for value in [
            json!({"kind":"start","x":20}),
            json!({"kind":"start","x":1000001,"y":0}),
            json!({"kind":"move","x":"1","y":2}),
            json!({"kind":"end","x":20}),
            json!({"kind":"start","x":1,"y":2,"target":"peer"}),
        ] {
            assert!(serde_json::from_value::<BrowserTouchAction>(value).is_err());
        }
        assert!(BrowserTouchAction::try_from(TouchAction::Start {
            x: f64::NAN,
            y: 0.0
        })
        .is_err());
        assert!(BrowserTouchAction::try_from(TouchAction::Move {
            x: 0.0,
            y: f64::INFINITY
        })
        .is_err());
    }
}
