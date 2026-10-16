// Pure geometry for the desktop Mochi: no window, no OS, every function is
// same-input-same-output and covered in logic_tests.rs. The geometry half of
// DesktopMochiLogic.swift, in the y-down coordinates every PC uses.

/// A rectangle, y down, in whatever space the caller works in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, p: (f64, f64)) -> bool {
        p.0 >= self.x && p.0 < self.x + self.w && p.1 >= self.y && p.1 < self.y + self.h
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

/// A connected display: its whole area, the part windows may use (no
/// taskbar), and how many of the space's units make one logical pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub frame: Rect,
    pub work: Rect,
    pub scale: f64,
}

/// Radius of the clickable body, as a fraction of the window side.
pub const BODY_RADIUS_FRACTION: f64 = 0.24;

/// Island panel, logical pixels: dropping Mochi on it brings him home.
pub const HOME_ZONE_W: f64 = crate::island::PANEL_W;
pub const HOME_ZONE_H: f64 = crate::island::PANEL_H;

/// How far past the target the landing squash goes (the "back" ease).
pub const EASE_BACK_OVERSHOOT: f64 = 1.3;

/// The cursor has to move this far (window-logical pixels, on either axis)
/// before his eyes are told again.
pub const CURSOR_STEP: f64 = 1.0;

/// Hit test of the round body inside the square window (window-local).
pub fn is_over_body(local: (f64, f64), size: f64) -> bool {
    let c = size / 2.0;
    let r = size * BODY_RADIUS_FRACTION;
    let (dx, dy) = (local.0 - c, local.1 - c);
    dx * dx + dy * dy <= r * r
}

/// Keeps a window of side `size` inside `work`, `margin` from each edge.
pub fn clamp_origin(origin: (f64, f64), size: f64, work: Rect, margin: f64) -> (f64, f64) {
    (
        origin.0.max(work.x + margin).min(work.x + work.w - size - margin),
        origin.1.max(work.y + margin).min(work.y + work.h - size - margin),
    )
}

/// The display whose frame holds `p`, or else the one whose centre is closest.
pub fn display_near(p: (f64, f64), displays: &[Display]) -> Option<Display> {
    displays.iter().copied().find(|d| d.frame.contains(p)).or_else(|| {
        displays
            .iter()
            .copied()
            .min_by(|a, b| dist2(p, a.work.center()).total_cmp(&dist2(p, b.work.center())))
    })
}

fn dist2(a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)
}

/// Where a window dropped with its top-left at `origin` settles: inside the
/// work area of the display under its centre (or the nearest one).
pub fn settle(origin: (f64, f64), displays: &[Display], size: f64, margin: f64) -> (f64, f64) {
    let Some(first) = displays.first() else { return origin };
    let half = size * first.scale / 2.0;
    let Some(d) = display_near((origin.0 + half, origin.1 + half), displays) else {
        return origin;
    };
    clamp_origin(origin, size * d.scale, d.work, margin * d.scale)
}

/// A spot saved at an earlier launch, checked against the displays
/// connected now: `None` when none of them holds its centre any more (the
/// monitor was unplugged), and he then stays in the island. A spot that is
/// still on a display is pulled back inside its work area.
pub fn restore_spot(spot: (f64, f64), displays: &[Display], size: f64, margin: f64) -> Option<(f64, f64)> {
    displays.iter().find_map(|d| {
        let s = size * d.scale;
        let center = (spot.0 + s / 2.0, spot.1 + s / 2.0);
        d.frame.contains(center).then(|| clamp_origin(spot, s, d.work, margin * d.scale))
    })
}

/// Where a flight out lands, given his `restored` spot (`restore_spot`).
/// A spot on a display that is gone keeps him home, unless `anywhere`: the
/// user sending him out with the desktop shortcut, who then gets `corner`,
/// the first-visit spot. Otherwise one undock would leave the shortcut doing
/// nothing until he was dragged out by hand.
pub fn spot_or_corner(
    restored: Option<(f64, f64)>,
    anywhere: bool,
    corner: impl FnOnce() -> Option<(f64, f64)>,
) -> Option<(f64, f64)> {
    if anywhere {
        restored.or_else(corner)
    } else {
        restored
    }
}

/// First visit: the bottom-right corner of the work area, like the Mac.
pub fn default_spot(d: &Display, size: f64, margin: f64) -> (f64, f64) {
    let s = size * d.scale;
    let m = margin * d.scale;
    (d.work.x + d.work.w - s - m, d.work.y + d.work.h - s - m)
}

/// The island's panel: centred on the island, from the top of its display.
pub fn home_zone(island_center_x: f64, island_top: f64, scale: f64) -> Rect {
    Rect {
        x: island_center_x - HOME_ZONE_W * scale / 2.0,
        y: island_top,
        w: HOME_ZONE_W * scale,
        h: HOME_ZONE_H * scale,
    }
}

/// Top-left corner of the window when Mochi sits in the island: centred
/// under the top edge, where the flights start and end.
pub fn island_spot(island_center_x: f64, island_top: f64, size: f64, scale: f64) -> (f64, f64) {
    (island_center_x - size * scale / 2.0, island_top)
}

/// Top-left corner of a window of side `side` centred on `center`: where the
/// window goes when he hangs from the pointer by his middle.
pub fn origin_for_center(center: (f64, f64), side: f64) -> (f64, f64) {
    (center.0 - side / 2.0, center.1 - side / 2.0)
}

/// Whether the cursor moved far enough since `last` to tell his eyes again.
pub fn moved_enough(last: (f64, f64), now: (f64, f64)) -> bool {
    (now.0 - last.0).abs() >= CURSOR_STEP || (now.1 - last.1).abs() >= CURSOR_STEP
}

/// The standard cubic ease-in-out: slow start, slow end.
pub fn ease_in_out(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// Ease-out with a small overshoot: the landing squash.
pub fn ease_out_back(t: f64) -> f64 {
    let c1 = EASE_BACK_OVERSHOOT;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}

pub fn lerp(a: (f64, f64), b: (f64, f64), t: f64) -> (f64, f64) {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}
