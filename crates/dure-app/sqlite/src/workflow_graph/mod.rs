//! Definition storage. Run/Task/Dispatch execution is stored by the canonical
//! workflow adapter; these tables hold draft and immutable source versions only.

mod definitions;
mod effects;
pub(crate) mod execution_schema;
mod runs;
pub(crate) mod schema;

#[cfg(test)]
mod tests;
