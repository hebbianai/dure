pub mod terminal {
    pub mod state {
        pub mod common {
            pub mod v1 {
                include!("generated/terminal.state.common.v1.rs");
            }
        }
        pub mod events {
            pub mod v1 {
                include!("generated/terminal.state.events.v1.rs");
            }
        }
        pub mod history {
            pub mod v1 {
                include!("generated/terminal.state.history.v1.rs");
            }
        }
        pub mod input {
            pub mod v1 {
                include!("generated/terminal.state.input.v1.rs");
            }
        }
        pub mod model {
            pub mod v1 {
                include!("generated/terminal.state.model.v1.rs");
            }
        }
        pub mod projection {
            pub mod v1 {
                include!("generated/terminal.state.projection.v1.rs");
            }
        }
        pub mod envelope {
            pub mod v1 {
                include!("generated/terminal.state.envelope.v1.rs");
            }
        }
    }
}

pub use terminal::state::common::v1::*;
pub use terminal::state::envelope::v1::*;
pub use terminal::state::events::v1::*;
pub use terminal::state::history::v1::*;
pub use terminal::state::input::v1::*;
pub use terminal::state::model::v1::*;
pub use terminal::state::projection::v1::*;
