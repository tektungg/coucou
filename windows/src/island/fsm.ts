// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "coucou";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /**
   * home → petit delay, seconds: the auto-close preference. Changing it while a
   * countdown runs starts that countdown again with the new delay, so an edit in
   * Settings applies at once (upstream 62e43c6, as on macOS).
   */
  get homeToPetitDelay(): number {
    return this.homeDelay;
  }
  set homeToPetitDelay(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds === this.homeDelay) return;
    this.homeDelay = seconds;
    if (this.state === "home" && this.homeCollapse != null && this.homeCollapseWindowS == null) {
      this.scheduleHomeCollapse();
    }
  }
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;
  /** coucou → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** coucou → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;
  /**
   * Hovering the compact (or hidden) island opens it, no click needed
   * (Settings → General → Open on hover). Off: a hover only shows the compact
   * island and a click opens it.
   */
  hoverOpens = true;
  /**
   * When the open island will fold, on the performance.now() clock, while a
   * countdown runs; null otherwise. The island draws its countdown bar from it.
   */
  homeCollapseDueAt: number | null = null;
  /** Seconds the bar spans for a glance (collapseAfter); null for the usual auto-close. */
  homeCollapseWindowS: number | null = null;
  /**
   * Asked when the compact island's hide delay runs out: true keeps it up
   * for another delay (a song's lyrics are on it). May answer later, after
   * a fullscreen check; the island hides only if nothing moved meanwhile.
   */
  keepPetit: () => boolean | Promise<boolean> = () => false;

  private homeDelay = 15;
  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  /**
   * Whether a hover now would show the island (open it, or bring up the
   * compact one). The island checks for a fullscreen app before letting it.
   */
  get hoverWouldShow(): boolean {
    return this.state === "hidden" || (this.state === "petit" && this.hoverOpens);
  }

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("coucou");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition(this.hoverOpens ? "home" : "petit");
        break;
      case "petit":
        if (this.hoverOpens) {
          this.cancelTimers();
          this.transition("home");
        } else {
          this.clear("petitHide");
        }
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "coucou":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  /**
   * `immediate`: the pointer really left, so an open island closes right away
   * (unless pinned). Without it the island waits `homeToPetitDelay`, which is
   * what the chat and anything opened without a hover (an alert) get.
   */
  mouseLeft(immediate = false) {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        if (immediate && !this.pinned) {
          this.cancelTimers();
          this.transition("petit");
        } else {
          this.scheduleHomeCollapse();
        }
        break;
      case "coucou":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "coucou") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /**
   * Open now, but only for a glance: back to compact after `seconds` unless
   * the pointer comes in (mouseEntered cancels it) or an alert pins it.
   */
  collapseAfter(seconds: number) {
    if (this.state !== "home") return;
    this.clear("homeCollapse");
    if (this.pinned) return;
    this.startHomeCollapse(seconds);
    this.homeCollapseWindowS = seconds;
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private schedulePetitHide() {
    this.clear("petitHide");
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state !== "petit") return;
      const decide = (keep: boolean) => {
        // Something else happened while asking (a hover, an alert): it decides.
        if (this.state !== "petit" || this.petitHide != null) return;
        if (keep) this.schedulePetitHide();
        else this.transition("hidden");
      };
      const keep = this.keepPetit();
      if (typeof keep === "boolean") decide(keep);
      else keep.then(decide, () => decide(false));
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned) return;
    this.startHomeCollapse(this.homeDelay);
  }

  /** Folds the open island after `seconds`, and says when (homeCollapseDueAt). */
  private startHomeCollapse(seconds: number) {
    const ms = seconds * 1000;
    this.homeCollapseDueAt = performance.now() + ms;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      this.homeCollapseDueAt = null;
      this.homeCollapseWindowS = null;
      // An alert pinned while the countdown ran keeps the island open.
      if (this.state === "home" && !this.pinned) this.transition("petit");
    }, ms);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "coucou") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
    if (which === "homeCollapse") {
      this.homeCollapseDueAt = null;
      this.homeCollapseWindowS = null;
    }
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
