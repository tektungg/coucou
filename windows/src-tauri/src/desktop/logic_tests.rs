// Tests of desktop/logic.rs. Mirrors tests/DesktopMochiTests.swift (isOverBody,
// clampOrigin), in the y-down coordinates every PC uses. Ported from upstream
// (Louis-CFM/coucou 64bb85e), plus the helpers this port split out.

use super::logic::*;

#[test]
fn is_over_body_hits_the_round_body_only() {
    let s = 120.0;
    let r = s * BODY_RADIUS_FRACTION; // 28.8
    assert!(is_over_body((60.0, 60.0), s), "center must be inside body");
    assert!(is_over_body((60.0 + r - 0.5, 60.0), s), "inside radius must hit");
    assert!(!is_over_body((60.0 + r + 0.5, 60.0), s), "outside radius must miss");
    assert!(!is_over_body((0.0, 0.0), s), "corner must miss");
    let diag = r / 2f64.sqrt() - 0.5;
    assert!(is_over_body((60.0 + diag, 60.0 + diag), s), "diagonal inside must hit");
    assert!(is_over_body((60.0 - diag, 60.0 + diag), s), "every quadrant");
}

#[test]
fn clamp_origin_keeps_him_inside_the_work_area() {
    // A 1440x900 display with a 40 px taskbar at the bottom.
    let work = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 860.0 };
    let (s, m) = (120.0, 24.0);
    assert_eq!(clamp_origin((600.0, 400.0), s, work, m), (600.0, 400.0), "in-bounds origin must be unchanged");
    assert_eq!(clamp_origin((-50.0, 400.0), s, work, m).0, work.x + m, "too-left");
    assert_eq!(clamp_origin((2000.0, 400.0), s, work, m).0, work.x + work.w - s - m, "too-right");
    assert_eq!(clamp_origin((400.0, -50.0), s, work, m).1, work.y + m, "too-high");
    assert_eq!(clamp_origin((400.0, 2000.0), s, work, m).1, work.y + work.h - s - m, "too-low: above the taskbar");
}

fn two_displays() -> Vec<Display> {
    // A 1920x1080 laptop at 100 %, and a 4K monitor at 200 % on its right,
    // physical pixels; both with a 48 px taskbar at the bottom.
    let a = Rect { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0 };
    let b = Rect { x: 1920.0, y: -200.0, w: 3840.0, h: 2160.0 };
    vec![
        Display { frame: a, work: Rect { h: 1032.0, ..a }, scale: 1.0 },
        Display { frame: b, work: Rect { h: 2064.0, ..b }, scale: 2.0 },
    ]
}

#[test]
fn a_spot_on_a_connected_display_is_kept() {
    let d = two_displays();
    assert_eq!(restore_spot((800.0, 600.0), &d, 120.0, 24.0), Some((800.0, 600.0)));
    // On the second display, sized in its own scale.
    assert_eq!(restore_spot((3000.0, 1000.0), &d, 120.0, 24.0), Some((3000.0, 1000.0)));
}

#[test]
fn a_spot_on_a_display_that_is_gone_brings_him_home() {
    let d = two_displays();
    // Left of the laptop: a monitor that has been unplugged.
    assert_eq!(restore_spot((-1500.0, 300.0), &d, 120.0, 24.0), None);
    // Nothing connected at all.
    assert_eq!(restore_spot((800.0, 600.0), &[], 120.0, 24.0), None);
    // Only the first display left: the spot on the second is gone.
    assert_eq!(restore_spot((3000.0, 1000.0), &d[..1], 120.0, 24.0), None);
}

#[test]
fn a_spot_that_a_taller_taskbar_now_covers_moves_up() {
    let d = two_displays();
    let (x, y) = restore_spot((800.0, 1000.0), &d, 120.0, 24.0).unwrap();
    assert_eq!(x, 800.0);
    assert_eq!(y, 1032.0 - 120.0 - 24.0);
    // The 200 % display clamps with its own scale.
    let (_, y) = restore_spot((3000.0, 1700.0), &d, 120.0, 24.0).unwrap();
    assert_eq!(y, -200.0 + 2064.0 - 240.0 - 48.0);
}

#[test]
fn a_drop_settles_on_the_display_under_him() {
    let d = two_displays();
    // Dropped against the right edge of the laptop: stays on the laptop.
    assert_eq!(settle((1800.0, 500.0), &d, 120.0, 24.0), (1920.0 - 120.0 - 24.0, 500.0));
    // His centre already over the next display: he moves onto it.
    assert_eq!(settle((1870.0, 500.0), &d, 120.0, 24.0), (1920.0 + 48.0, 500.0));
    // Dropped in the gap above the laptop, next to the taller monitor:
    // nearest display.
    assert_eq!(settle((1000.0, -150.0), &d, 120.0, 24.0), (1000.0, 24.0));
}

#[test]
fn a_drop_with_no_display_stays_where_it_fell() {
    assert_eq!(settle((1000.0, -150.0), &[], 120.0, 24.0), (1000.0, -150.0));
}

#[test]
fn first_visit_is_the_bottom_right_corner() {
    let d = two_displays();
    assert_eq!(default_spot(&d[0], 120.0, 24.0), (1920.0 - 144.0, 1032.0 - 144.0));
    assert_eq!(default_spot(&d[1], 120.0, 24.0), (1920.0 + 3840.0 - 288.0, -200.0 + 2064.0 - 288.0));
}

#[test]
fn the_island_panel_is_home() {
    // Island centred on a 1920 px display at 150 %.
    let zone = home_zone(960.0, 0.0, 1.5);
    assert!(zone.contains((960.0, 10.0)), "on the island");
    assert!(zone.contains((960.0 - 359.0 * 1.5, 300.0 * 1.5)), "inside the panel");
    assert!(!zone.contains((960.0, 330.0 * 1.5)), "below the panel");
    assert!(!zone.contains((100.0, 10.0)), "top-left corner of the screen");
}

#[test]
fn he_leaves_and_returns_under_the_top_centre() {
    assert_eq!(island_spot(960.0, 0.0, 120.0, 1.0), (900.0, 0.0));
    assert_eq!(island_spot(2880.0, -200.0, 120.0, 2.0), (2760.0, -200.0));
}

#[test]
fn flights_start_and_end_where_asked() {
    for ease in [ease_in_out as fn(f64) -> f64, ease_out_back] {
        assert!(ease(0.0).abs() < 1e-9);
        assert!((ease(1.0) - 1.0).abs() < 1e-9);
    }
    assert!(ease_out_back(0.7) > 1.0, "the landing overshoots a little");
    assert_eq!(lerp((0.0, 10.0), (100.0, 20.0), 0.5), (50.0, 15.0));
}

#[test]
fn a_carried_window_hangs_from_his_middle() {
    assert_eq!(origin_for_center((500.0, 300.0), 120.0), (440.0, 240.0));
    // At 200 % the side is in physical pixels, twice as long.
    assert_eq!(origin_for_center((500.0, 300.0), 240.0), (380.0, 180.0));
}

#[test]
fn his_eyes_only_hear_about_whole_pixel_moves() {
    assert!(!moved_enough((10.0, 10.0), (10.4, 10.9)), "sub-pixel jitter is ignored");
    assert!(moved_enough((10.0, 10.0), (11.0, 10.0)), "one pixel across");
    assert!(moved_enough((10.0, 10.0), (10.0, 9.0)), "one pixel up");
    assert!(moved_enough((f64::MIN, f64::MIN), (0.0, 0.0)), "the first reading always counts");
}
