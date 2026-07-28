/**
 * spinner.ts — smooth loading animation for tool render slots.
 *
 * Mirrors pi's native `Loader` ("⠹ Working..."): the animation is driven by a
 * self-owned interval that calls `invalidate()` on a fixed cadence, NOT by the
 * tool's data-update cadence. Deriving the frame from a heartbeat makes it
 * stutter; owning the redraw loop makes it buttery, exactly like pi.
 *
 * Usage in a tool's `renderResult`:
 *
 *   const st = context.state as { spinner?: SpinnerTicker };
 *   (st.spinner ??= createSpinner(context.invalidate)).sync(running);
 *   const icon = running ? theme.fg("accent", st.spinner.frame()) : "✓";
 *
 * Store one per tool row on `context.state` so it persists across renders.
 */

// pi's DEFAULT_FRAMES / DEFAULT_INTERVAL_MS from pi-tui's Loader.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 80;

export interface SpinnerTicker {
  /** Current frame, derived from the wall clock (stable across concurrent rows). */
  frame(): string;
  /** Start/stop the self-driven redraw loop to match `running`. Idempotent. */
  sync(running: boolean): void;
  /** Stop the redraw loop. Safe to call multiple times. */
  stop(): void;
}

export function createSpinner(invalidate: () => void): SpinnerTicker {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    frame() {
      return SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
    },
    sync(running: boolean) {
      if (running && !timer) timer = setInterval(invalidate, SPINNER_INTERVAL_MS);
      else if (!running && timer) this.stop();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
