// What the desktop Mochi is doing right now, and the pure decisions that follow
// from it: whether the cursor poll runs, whether his window lets clicks through
// (Windows), and which part of it takes the mouse (Linux). window.rs applies
// them; the tests below pin them down.

use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use serde::Serialize;

use super::{logic, SIZE};
use crate::island::PollGate;
use crate::platform::{DesktopMode, MouseShape};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// Dragged out of the island.
    Island,
    /// Picked up where he sat on the desktop.
    Desktop,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Carry {
    /// Cursor minus the window's top-left at pick-up, physical (Poll mode).
    pub grab: (f64, f64),
    pub from: Source,
}

#[derive(Default, Debug)]
pub(super) struct Inner {
    /// The window is on screen.
    pub shown: bool,
    /// Sitting on the desktop, taking pokes (not flying, not carried).
    pub landed: bool,
    pub asleep: bool,
    pub carry: Option<Carry>,
    /// Layer mode: the surface covers the display while it is dragged.
    pub overlay: bool,
    /// Top-left corner, in the mode's space.
    pub pos: (f64, f64),
    /// Layer mode: logical size of the display he lives on.
    pub display: Option<(f64, f64)>,
    /// Poll mode: the click-through state last applied.
    pub ignoring: Option<bool>,
}

impl Inner {
    /// Neither sitting, nor carried, nor asleep: what a flight starts from.
    pub fn ground(&mut self) {
        self.landed = false;
        self.carry = None;
        self.asleep = false;
    }

    /// Off screen, or in the air between two places: nothing takes the mouse.
    fn out_of_reach(&self) -> bool {
        !self.shown || (!self.landed && self.carry.is_none())
    }

    /// The cursor poll runs only while he is carried, or awake on the desktop.
    pub fn poll_active(&self) -> bool {
        self.shown && (self.carry.is_some() || (self.landed && !self.asleep))
    }

    /// Poll mode: `Some(flag)` is decided here; `None` leaves it to the poll,
    /// which hit-tests his body every tick.
    pub fn click_through(&self) -> Option<bool> {
        if self.out_of_reach() {
            return Some(true);
        }
        if let Some(c) = self.carry {
            // Out of the island, the button is still held over the island:
            // the window must not swallow its release.
            return Some(c.from == Source::Island);
        }
        // Asleep, nothing polls: the whole little window takes the mouse and
        // acts as his own wake area. The first move over it wakes him, and the
        // poll gives the rest back right away.
        self.asleep.then_some(false)
    }

    /// Linux: the part of the window that takes the mouse.
    pub fn mouse_shape(&self) -> MouseShape {
        if self.out_of_reach() {
            MouseShape::Empty
        } else if self.overlay {
            MouseShape::Whole
        } else if matches!(self.carry, Some(Carry { from: Source::Island, .. })) {
            MouseShape::Empty
        } else {
            body_disc()
        }
    }

    /// His top-left corner when a drag on him may start: sitting, not carried.
    pub fn draggable_pos(&self) -> Option<(f64, f64)> {
        (self.landed && self.carry.is_none()).then_some(self.pos)
    }
}

/// His round body, in window-logical pixels.
pub(super) fn body_disc() -> MouseShape {
    MouseShape::Disc { cx: SIZE / 2.0, cy: SIZE / 2.0, r: SIZE * logic::BODY_RADIUS_FRACTION }
}

pub struct Desktop {
    pub mode: DesktopMode,
    pub(super) gate: PollGate,
    pub(super) inner: Mutex<Inner>,
    /// Bumped by every flight: an older one still running stops moving him.
    pub(super) flight: AtomicU64,
}

impl Desktop {
    pub(super) fn new(mode: DesktopMode) -> Self {
        Self { mode, gate: PollGate::new(), inner: Mutex::new(Inner::default()), flight: AtomicU64::new(0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landed() -> Inner {
        Inner { shown: true, landed: true, ..Inner::default() }
    }

    fn carried(from: Source) -> Inner {
        Inner { shown: true, carry: Some(Carry { grab: (60.0, 60.0), from }), ..Inner::default() }
    }

    #[test]
    fn hidden_or_flying_he_takes_no_mouse_and_nothing_polls() {
        let hidden = Inner::default();
        let flying = Inner { shown: true, ..Inner::default() };
        for i in [hidden, flying] {
            assert!(!i.poll_active());
            assert_eq!(i.click_through(), Some(true));
            assert_eq!(i.mouse_shape(), MouseShape::Empty);
            assert_eq!(i.draggable_pos(), None);
        }
    }

    #[test]
    fn awake_on_the_desktop_the_poll_decides_from_his_body() {
        let i = landed();
        assert!(i.poll_active());
        assert_eq!(i.click_through(), None, "left to the per-tick hit test");
        assert_eq!(i.mouse_shape(), body_disc());
        assert_eq!(i.draggable_pos(), Some((0.0, 0.0)));
    }

    #[test]
    fn asleep_the_whole_window_is_his_wake_area_and_nothing_polls() {
        let i = Inner { asleep: true, ..landed() };
        assert!(!i.poll_active(), "0 % CPU while he sleeps");
        assert_eq!(i.click_through(), Some(false));
    }

    #[test]
    fn dragged_out_of_the_island_the_release_goes_to_the_island() {
        let i = carried(Source::Island);
        assert!(i.poll_active());
        assert_eq!(i.click_through(), Some(true));
        assert_eq!(i.mouse_shape(), MouseShape::Empty);
        assert_eq!(i.draggable_pos(), None, "already carried");
    }

    #[test]
    fn picked_up_from_the_desktop_he_keeps_the_mouse() {
        let i = carried(Source::Desktop);
        assert!(i.poll_active());
        assert_eq!(i.click_through(), Some(false));
        assert_eq!(i.mouse_shape(), body_disc());
    }

    #[test]
    fn a_layer_drag_overlay_takes_the_whole_window() {
        let i = Inner { overlay: true, ..landed() };
        assert_eq!(i.mouse_shape(), MouseShape::Whole);
    }

    #[test]
    fn ground_clears_everything_a_flight_must_not_inherit() {
        let mut i = Inner { asleep: true, carry: Some(Carry { grab: (1.0, 1.0), from: Source::Desktop }), ..landed() };
        i.ground();
        assert!(!i.landed && !i.asleep && i.carry.is_none());
        assert!(i.shown, "grounding is not hiding");
    }

    #[test]
    fn the_drop_source_is_named_for_the_page_in_camel_case() {
        assert_eq!(serde_json::to_value(Source::Island).unwrap(), "island");
        assert_eq!(serde_json::to_value(Source::Desktop).unwrap(), "desktop");
    }
}
