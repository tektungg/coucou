// Files dropped on the island: Mochi turns into a box, swallows the file and
// offers to answer questions about it, or the Shelf pill keeps every file.
// Split out of island.ts; the island hands it what it needs (FileDropHost).

import { Bridge } from "../core/bridge";
import type { IslandViewName } from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { BotEngine } from "../mochi/engine";
import { USC, UploadSeq } from "../upload/sequence";
import { shelfDragActive, showShelfTab } from "../views/personal";

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;
/** How long an error note stays before the island goes back to its usual view. */
const NOTE_MS = 2400;
const SHELF_ID = "integration_shelf";

export interface DragDropEvent {
  type: string;
  paths?: string[];
}

/** What the drop flow drives on the island. */
export interface FileDropHost {
  readonly engine: BotEngine;
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
  /** An alert stopped waiting: the island may auto-close again. */
  dropPin(): void;
  ensureRunning(): void;
}

export class FileDrop {
  private readonly host: FileDropHost;
  /** What the last drop held, as dropped (the chat works on an inbox copy). */
  private lastDropPaths: string[] = [];
  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(host: FileDropHost) {
    this.host = host;
  }

  onDragDrop(e: DragDropEvent) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    // A file dragged out of the shelf crossing back over the island is not a drop.
    if (shelfDragActive()) return;
    // On the Shelf pill a drop goes straight onto the shelf, every file of it.
    if (State.focusTask?.id === SHELF_ID && this.shelfDrop(e)) return;
    switch (e.type) {
      case "enter":
      case "over":
        this.dragIn();
        break;
      case "leave":
        this.dragOut();
        break;
      case "drop":
        this.dropped(e.paths ?? []);
        break;
    }
  }

  private dragIn() {
    if (State.fileDragOver) return;
    State.fileDragOver = true;
    this.host.engine.animateMorph(1);
    // enterZone must run before the island expands, so the sequence is
    // already active by the time the view becomes `upload`.
    UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
    this.host.alert("upload");
  }

  private dragOut() {
    if (!State.fileDragOver) return;
    State.fileDragOver = false;
    this.host.engine.animateMorph(0);
    // The island deliberately stays open: the drag session is still alive.
    UploadSeq.exitZone();
    State.notify();
  }

  private dropped(paths: string[]) {
    State.fileDragOver = false;
    this.lastDropPaths = paths;
    const path = paths[0];
    if (!path) {
      this.host.engine.animateMorph(0);
      this.host.setView(State.defaultView());
      return;
    }
    this.swallow(path);
  }

  /** The choose card's "Keep on shelf": the original files, by reference. */
  keepOnShelf() {
    const paths = this.lastDropPaths.length ? this.lastDropPaths : State.droppedFile ? [State.droppedFile.path] : [];
    if (paths.length) pinOnShelf(paths);
    if (State.tasks.some((t) => t.id === SHELF_ID)) {
      showShelfTab("pinned");
      State.setFocus(SHELF_ID);
    }
    this.host.setView("overview");
  }

  /**
   * A drag over the island while the Shelf pill has the focus: the open card
   * lights up and the drop keeps every file. False lets the usual drop run.
   */
  private shelfDrop(e: DragDropEvent): boolean {
    switch (e.type) {
      case "enter":
      case "over":
        if (!document.body.classList.contains("shelf-drop")) {
          document.body.classList.add("shelf-drop");
          if (State.mode !== "expanded" || State.view !== "overview") this.host.alert("overview");
        }
        return true;
      case "leave":
        document.body.classList.remove("shelf-drop");
        return true;
      case "drop": {
        document.body.classList.remove("shelf-drop");
        const paths = e.paths ?? [];
        if (paths.length) {
          showShelfTab("pinned");
          pinOnShelf(paths);
        }
        // The alert pinned the island open: let it close on its own again.
        this.host.dropPin();
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation (same as FileDropHandler on macOS).
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.chatHistory = [];
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    const engine = this.host.engine;
    engine.gulp();
    Sound.play("approve");
    engine.triggerEmote("happy");
    engine.animateMorph(0);

    State.uploadProgress = 0;
    this.host.setView("uploading");
    this.host.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => this.ingestFailed(err));
  }

  private ingestFailed(err: unknown) {
    UploadSeq.deactivate();
    State.noteMessage = String(err).replace(/^Error:\s*/, "");
    this.host.engine.animateMorph(0);
    this.host.setView("note");
    Sound.play("error");
    window.setTimeout(() => this.host.setView(State.defaultView()), NOTE_MS);
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.host.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.host.setView("choose");
    }
  }
}

function pinOnShelf(paths: string[]) {
  void Bridge.shelfPin(paths).then(() => Sound.play("finish"), () => Sound.play("error"));
}
