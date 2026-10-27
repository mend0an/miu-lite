// Everything that touches Win32 directly, behind one set of names.
//
// The prototype targets Windows 11 only (PRD 1.2); the Linux backend inherited
// from Coucou was removed.

mod drop_target;
mod windows;
pub use self::windows::*;

/// Wall-clock time in the user's time zone, for log lines.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}
