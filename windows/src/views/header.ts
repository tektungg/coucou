// The open island's header (Mochi Pop): capsule tabs with a mini Mochi on the
// left, the pill chips in the middle, round Settings / sound / mic buttons on
// the right. Its height stays 34 px: core/layout.ts places Mochi below it.

import { MIC_ICON, MIC_OFF_ICON, micBadge, micUsers, micUsersLabel } from "./shelf";
import { Bridge } from "../core/bridge";
import { h, svg, clear, face } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import type { IslandViewName } from "../core/layout";
import { PAGER_MAX_W, pagerChips, pillLabel, type PagerChip } from "./pager";
import type { ViewActions, ViewHost } from "./views";

/** Ring on a chip whose pill waits on you or just finished. */
const BADGE_RING: Record<string, string> = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" };
/** Face sizes: header tabs and pill chips. */
const TAB_FACE = 16;
const CHIP_FACE = 14;

/** The mic state the header and the collapsed island show, when the Audio pill is on. */
export function headerMicBadge(): "live" | "muted" | null {
  if (!State.tasks.some((t) => t.id === "integration_audio")) return null;
  return micBadge(State.integrations.integration_audio?.data as Record<string, unknown> | undefined);
}

type Go = (v: IslandViewName) => void;

/** Home and Chat: a face, and the label while the tab is on. "+" opens the drop zone. */
function buildTabs(go: Go) {
  const tab = (view: IslandViewName, title: string, color: string, label: string) =>
    h("button", { class: "tab ptab", title, onclick: () => go(view) }, face(color, TAB_FACE),
      h("span", { class: "tab-label", text: label }));
  const home = tab("overview", "Overview", "#ffffff", "Home");
  const chat = tab("prompt", "Ask", "var(--acc-2)", "Chat");
  const drop = h("button", { class: "tab round", title: "Drop", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  return {
    el: h("div", { class: "tabs" }, home, chat, drop),
    sync(v: IslandViewName) {
      home.classList.toggle("on", v === "overview" || v === "empty");
      chat.classList.toggle("on", v === "prompt");
      drop.classList.toggle("on", v === "upload");
    },
  };
}

/** One pill's chip; a click on an inactive chip focuses that pill. */
function chipEl(chip: PagerChip, task: AgentTask | undefined, actions: ViewActions): HTMLElement {
  const isActive = chip.label !== null;
  const el = h("button", {
    class: isActive ? "pchip on" : "pchip",
    title: task ? pillLabel(task) : "",
    onclick: () => {
      if (!isActive) actions.setFocus(chip.id);
    },
  }, face(task?.color ?? "#ffffff", CHIP_FACE));
  if (chip.label) el.append(h("span", { class: "pchip-label", text: chip.label }));
  if (chip.badge) el.style.setProperty("--ring", BADGE_RING[chip.badge]);
  return el;
}

/** The overview's pill chips: one per pill, the active one named, the rest behind "+N". */
function buildPager(actions: ViewActions) {
  const el = h("div", { class: "pager" });
  let key = "";
  function sync() {
    const tasks = State.visibleTasks;
    const focus = State.focusTask?.id ?? "";
    const show = State.view === "overview" && tasks.length > 0;
    const next = show
      ? `${focus}|${tasks.map((t) => `${t.id}:${t.color}:${t.name}:${t.pillBadge ?? ""}`).join(",")}`
      : "";
    if (next === key) return;
    key = next;
    clear(el);
    if (!show) return;
    // The open header is always 640 px wide, so the strip's room is a constant
    // (measuring it would read the island mid-animation, while it still grows).
    const layout = pagerChips(tasks.map((t) => ({ id: t.id, name: t.name, badge: t.pillBadge })), focus, PAGER_MAX_W);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const chip of layout.chips) el.append(chipEl(chip, byId.get(chip.id), actions));
    const more = layout.overflow;
    if (more) el.append(h("button", { class: "pchip more", text: `+${more.count}`, onclick: () => actions.setFocus(more.nextId) }));
  }
  return { el, sync };
}

/** Mic (while an app records), Settings and sound, as round soft buttons. */
function buildHeaderActions(actions: ViewActions, go: Go) {
  const gear = h("button", { class: "hbtn", title: "Settings", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const sound = h("button", { class: "hbtn", title: "Mute", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));
  // One click mutes or unmutes the microphone, from any pill.
  const mic = h("button", { class: "hbtn mic-btn" });
  mic.addEventListener("click", () => {
    const badge = headerMicBadge();
    if (badge) void Bridge.audioSetMute("input", badge === "live");
  });
  function syncMic() {
    const badge = headerMicBadge();
    mic.style.display = badge ? "" : "none";
    mic.classList.toggle("live", badge === "live");
    if (badge && mic.dataset.state !== badge) {
      mic.dataset.state = badge;
      clear(mic);
      mic.append(svg(badge === "live" ? MIC_ICON : MIC_OFF_ICON, 14, { stroke: 1.9 }));
    }
    const users = micUsersLabel(micUsers(State.integrations.integration_audio?.data ?? {}));
    mic.title = badge === "live" ? `${users} is using the mic. Click to mute` : `Mic muted (${users}). Click to unmute`;
  }
  return {
    el: h("div", { class: "header-actions" }, mic, gear, sound),
    sync(v: IslandViewName) {
      gear.classList.toggle("on", v === "settings");
      clear(gear);
      gear.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(sound);
      sound.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      syncMic();
    },
  };
}

export function buildHeader(actions: ViewActions): ViewHost {
  const go: Go = (v) => {
    actions.blip();
    actions.setView(v);
  };
  const tabs = buildTabs(go);
  const pager = buildPager(actions);
  const buttons = buildHeaderActions(actions, go);
  const el = h("div", { id: "header" }, tabs.el, pager.el, buttons.el);
  return {
    el,
    sync() {
      const v = State.view;
      tabs.sync(v);
      pager.sync();
      buttons.sync(v);
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}
