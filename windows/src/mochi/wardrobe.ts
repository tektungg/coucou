// Mochi's wardrobe: the pure logic, port of NotchBuddy/Sources/CoucouKit/MochiWardrobe.swift
// from upstream (Louis-CFM/coucou 23c09b9, c97dec1). What Mochi wears is picked
// in the wardrobe view (right-click on Mochi, or the tray menu) and stored in
// the preferences as `mochiOutfit`. The drawing lives in ./outfits.ts.
//
// This build defaults to "none", not "auto": Mochi looks as he always has
// until an outfit (or "auto", the seasons) is chosen.

/** Every outfit, plus "auto" (dress for the season) and "none". Order of the wardrobe. */
export const OUTFIT_SELECTIONS = [
  "auto", "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
] as const;

/** What can be stored in the preferences. The raw values are the Mac's, keep them stable. */
export type OutfitSelection = (typeof OUTFIT_SELECTIONS)[number];

/** What Mochi actually wears: a selection with "auto" resolved. */
export type Outfit = Exclude<OutfitSelection, "auto">;

export const DEFAULT_OUTFIT: OutfitSelection = "none";

// ── User-visible strings ──────────────────────────────────────────────────────

export const OUTFIT_LABELS: Record<OutfitSelection, string> = {
  auto: "Auto (seasons)",
  none: "None",
  partyHat: "Party hat",
  beanie: "Beanie",
  crown: "Crown",
  sunglasses: "Sunglasses",
  roundGlasses: "Round glasses",
  bow: "Bow",
  scarf: "Scarf",
  witchHat: "Witch hat",
  pumpkin: "Pumpkin",
  santaHat: "Santa hat",
  bunnyEars: "Bunny ears",
};

export const WARDROBE_STRINGS = {
  title: "Wardrobe",
  autoBadge: "AUTO",
  autoNow: (current: string) => `Auto · ${current}`,
  autoHover: (current: string) => `Auto · follows the seasons (now: ${current})`,
};

// ── Logic ─────────────────────────────────────────────────────────────────────

const SELECTION_SET: ReadonlySet<string> = new Set(OUTFIT_SELECTIONS);

/**
 * A stored preference → a selection. Anything unknown (a value from a newer or
 * older build, such as the Mac's removed "topHat", or garbage) means the
 * default, "none" here (the Mac's `Outfit.stored` falls back to "auto").
 */
export function parseOutfit(raw: unknown): OutfitSelection {
  return typeof raw === "string" && SELECTION_SET.has(raw) ? (raw as OutfitSelection) : DEFAULT_OUTFIT;
}

/** Easter Sunday of `year` (Meeus/Jones/Butcher), as [month 1–12, day]. */
export function easterDate(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

const DAY_MS = 86_400_000;

/** A local calendar day: month 1–12. */
interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/**
 * Two days before Easter to the day after. Calendar days counted in UTC so a
 * daylight-saving change in between can't shift the count.
 */
function nearEaster({ year, month, day }: CalendarDay): boolean {
  const [em, ed] = easterDate(year);
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, em - 1, ed)) / DAY_MS);
  return delta >= -2 && delta <= 1;
}

/** Each season's window, by priority: party hat > Santa hat > witch hat > bunny ears > sunglasses. */
const SEASONS: [Outfit, (d: CalendarDay) => boolean][] = [
  // Dec 31 – Jan 2
  ["partyHat", ({ month, day }) => (month === 12 && day === 31) || (month === 1 && day <= 2)],
  // Dec 1–26
  ["santaHat", ({ month, day }) => month === 12 && day <= 26],
  // Oct 1 – Nov 1
  ["witchHat", ({ month, day }) => month === 10 || (month === 11 && day === 1)],
  ["bunnyEars", nearEaster],
  // Jun 21 – Aug 31
  ["sunglasses", ({ month, day }) => (month === 6 && day >= 21) || month === 7 || month === 8],
];

/** The seasonal outfit for `date`, read in the user's local calendar; "none" out of season. */
export function seasonalOutfit(date: Date): Outfit {
  const d = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  return SEASONS.find(([, inSeason]) => inSeason(d))?.[0] ?? "none";
}

/** "auto" → the season's outfit; anything else is worn as chosen. */
export function resolveOutfit(selection: OutfitSelection, date: Date): Outfit {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

/**
 * The grey text at the right of the wardrobe header: the hovered outfit,
 * otherwise the current choice — WardrobeView.headerRight on macOS.
 */
export function wardrobeHeader(
  hovered: OutfitSelection | null,
  selection: OutfitSelection,
  date: Date,
): string {
  const season = OUTFIT_LABELS[seasonalOutfit(date)];
  if (hovered) return hovered === "auto" ? WARDROBE_STRINGS.autoHover(season) : OUTFIT_LABELS[hovered];
  return selection === "auto" ? WARDROBE_STRINGS.autoNow(season) : OUTFIT_LABELS[selection];
}

/** Same as resolveOutfit, remembered for the day — it is asked every frame. */
export class SeasonCache {
  private key = "";
  private value: Outfit = "none";

  get(selection: OutfitSelection, date = new Date()): Outfit {
    if (selection !== "auto") return selection;
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key !== this.key) {
      this.key = key;
      this.value = seasonalOutfit(date);
    }
    return this.value;
  }
}
