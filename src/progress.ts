/**
 * D6 — progress row above the editor.
 *
 * Both one-shot commands (`/checkpoint-make`, `/compact-checkpoint`) run while
 * the agent is idle, *before* pi's streaming lifecycle, so the built-in working
 * spinner (`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator`)
 * never shows anything. Progress is therefore surfaced as a widget above the
 * text input, built from the `Loader` component in `@earendil-works/pi-tui`.
 *
 * Everything here is best-effort: a progress row is never worth failing a
 * command. Guarded by `ctx.hasUI`, wrapped in `try/catch`, never throws, and no
 * timer outlives `stop()` / the component's `dispose()`.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

/** One shared key so the two commands can never stack rows. */
export const PROGRESS_WIDGET_KEY = "debloat-progress";

/** A live progress handle; both methods are best-effort and safe to call twice. */
export interface Progress {
  /** Replace the displayed message (the `(Ns)` suffix is maintained internally). */
  update(message: string): void;
  /** Clear the widget and its timers. Idempotent. */
  stop(): void;
}

type ProgressComponent = Component & { dispose?(): void };

function noop(): Progress {
  return {
    update(): void {},
    stop(): void {},
  };
}

/**
 * Show a progress row above the editor and return a handle. Never throws:
 * without a UI (or without `setWidget`) it degrades to a no-op. `stop()` is
 * idempotent and safe even when the widget factory was never invoked.
 */
export function startProgress(ctx: ExtensionCommandContext, message: string): Progress {
  if (ctx.hasUI !== true) return noop();
  const ui = ctx.ui;
  if (ui === undefined || typeof ui.setWidget !== "function") return noop();

  let current = message;
  let stopped = false;
  let loader: Loader | undefined;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();

  const display = (): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `${current} (${seconds}s)`;
  };

  const clearElapsedTimer = (): void => {
    if (elapsedTimer !== undefined) {
      clearInterval(elapsedTimer);
      elapsedTimer = undefined;
    }
  };

  const factory = (tui: TUI, theme: Theme): ProgressComponent => {
    let created: Loader | undefined;
    try {
      created = new Loader(
        tui,
        (text) => theme.fg("accent", text),
        (text) => theme.fg("muted", text),
        display(),
      );
      loader = created;
      elapsedTimer = setInterval(() => {
        if (stopped) return;
        try {
          loader?.setMessage(display());
        } catch {
          // best-effort
        }
      }, 1000);
    } catch {
      created = undefined;
    }
    return {
      render(width: number): string[] {
        if (stopped || created === undefined) return [];
        try {
          // `Loader.render` prepends a blank line, and pi already inserts a
          // `Spacer(1)` above widget rows — drop it so there is only one gap.
          const lines = created.render(width);
          return lines[0] === "" ? lines.slice(1) : lines;
        } catch {
          return [];
        }
      },
      invalidate(): void {
        try {
          created?.invalidate();
        } catch {
          // best-effort
        }
      },
      dispose(): void {
        stopped = true;
        clearElapsedTimer();
        try {
          created?.stop();
        } catch {
          // best-effort
        }
      },
    };
  };

  try {
    ui.setWidget(PROGRESS_WIDGET_KEY, factory);
  } catch {
    stopped = true;
    clearElapsedTimer();
    try {
      loader?.stop();
    } catch {
      // best-effort
    }
    // A pi that stored the component before throwing must not leave a stale row.
    try {
      ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
    } catch {
      // best-effort
    }
    return noop();
  }

  return {
    update(next: string): void {
      if (stopped) return;
      current = next;
      try {
        loader?.setMessage(display());
      } catch {
        // best-effort
      }
    },
    stop: function stop(): void {
      if (stopped) return;
      stopped = true;
      clearElapsedTimer();
      try {
        loader?.stop();
      } catch {
        // best-effort
      }
      try {
        ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
      } catch {
        // best-effort
      }
    },
  };
}
