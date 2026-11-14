//! xeet: a browserless renderer for X post previews.
//!
//! The crate is a pure function from a post description to pixels and a
//! report. It performs no I/O: no network, no filesystem, no clock.

#![forbid(unsafe_code)]

pub mod blink_ascii;
pub mod cards;
pub mod color;
pub mod display;
pub mod fonts;
pub mod frame;
pub mod inline;
pub mod limits;
pub mod linebreak;
pub mod model;
pub mod paint;
pub mod render;
pub mod rules;
pub mod script;
pub mod shape;
pub mod tokens;
