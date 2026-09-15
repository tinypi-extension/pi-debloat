/**
 * Direct unit coverage for the D6 progress widget (`src/progress.ts`).
 *
 * `startProgress` is driven with a hand-rolled ctx whose `ui.setWidget` records
 * every call; the widget factory is then invoked with a stub `TUI`/`Theme` so
 * the rendered row can be asserted. No real terminal, no fake timers — the
 * `(Ns)` suffix stays at `(0s)` for the synchronous assertions, and the timer
 * test compares `process.getActiveResourcesInfo()` against a computed baseline
 * rather than hardcoding pi-tui's internal interval count.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { PROGRESS_WIDGET_KEY, startProgress, type Progress } from "../src/progress.js";

interface WidgetCall {
  key: string;
  content: unknown;
}

type ProgressFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const TUI_STUB = { requestRender() {} } as unknown as TUI;
const THEME_STUB = { fg: (_color: string, text: string) => text } as unknown as Theme;

function fakeCtx(options: { hasUI?: boolean; withSetWidget?: boolean } = {}): {
  ctx: ExtensionCommandContext;
  widgets: WidgetCall[];
} {
  const widgets: WidgetCall[] = [];
  const ui: Record<string, unknown> = {};
  if (options.withSetWidget ?? true) {
    ui.setWidget = (key: string, content: unknown): void => {
      widgets.push({ key, content });
    };
  }
  const ctx = { hasUI: options.hasUI ?? true, ui } as unknown as ExtensionCommandContext;
  return { ctx, widgets };
}

function factoryOf(widgets: WidgetCall[]): ProgressFactory {
  const content = widgets[0]?.content;
  if (typeof content !== "function") {
    throw new Error("expected the widget factory to be registered");
  }
  return content as ProgressFactory;
}

function renderText(component: Component): string {
  return component.render(80).join("\n");
}

function clearsOf(widgets: WidgetCall[]): WidgetCall[] {
  return widgets.filter(
    (widget) => widget.key === PROGRESS_WIDGET_KEY && widget.content === undefined,
  );
}

function countTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

describe("D6 progress widget (src/progress.ts)", () => {
  it("renders the initial and updated message with the elapsed suffix", () => {
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "INITIAL");
    const component = factoryOf(widgets)(TUI_STUB, THEME_STUB);

    expect(renderText(component)).toMatch(/INITIAL \(0s\)\s*$/);
    handle.update("UPDATED");
    expect(renderText(component)).toMatch(/UPDATED \(0s\)\s*$/);

    handle.stop();
  });

  it("shows the latest message when update() runs before pi invokes the factory", () => {
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "INITIAL");
    handle.update("LATEST");
    const component = factoryOf(widgets)(TUI_STUB, THEME_STUB);

    expect(renderText(component)).toMatch(/LATEST \(0s\)\s*$/);
    expect(renderText(component)).not.toContain("INITIAL");

    handle.stop();
  });

  it("does not paint a leading blank line", () => {
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "ONLY");
    const component = factoryOf(widgets)(TUI_STUB, THEME_STUB);

    expect(component.render(80)[0]).not.toBe("");
    expect(component.render(80)[0]).toContain("ONLY");

    handle.stop();
  });

  it("stop() is idempotent: exactly one clear on a double stop()", () => {
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "x");
    factoryOf(widgets)(TUI_STUB, THEME_STUB);

    handle.stop();
    handle.stop();

    expect(clearsOf(widgets)).toHaveLength(1);
  });

  it("does not clear after a pi-initiated dispose() followed by stop()", () => {
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "x");
    const component = factoryOf(widgets)(TUI_STUB, THEME_STUB);

    component.dispose?.();
    handle.stop();

    expect(clearsOf(widgets)).toHaveLength(0);
  });

  it("leaves no active timers after stop()", () => {
    const baseline = countTimeouts();
    const { ctx, widgets } = fakeCtx();
    const handle = startProgress(ctx, "x");
    factoryOf(widgets)(TUI_STUB, THEME_STUB);
    expect(countTimeouts()).toBeGreaterThan(baseline);

    handle.stop();
    expect(countTimeouts()).toBe(baseline);
  });

  it("hasUI:false yields a handle whose update/stop are safe no-ops", () => {
    const { ctx, widgets } = fakeCtx({ hasUI: false });
    const handle = startProgress(ctx, "x");

    expect(widgets).toHaveLength(0);
    expect(() => handle.update("y")).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it("a missing setWidget yields a handle whose update/stop are safe no-ops", () => {
    const { ctx, widgets } = fakeCtx({ withSetWidget: false });
    const handle = startProgress(ctx, "x");

    expect(widgets).toHaveLength(0);
    expect(() => handle.update("y")).not.toThrow();
    expect(() => handle.stop()).not.toThrow();
  });

  it("attempts to clear the row and still degrades when setWidget throws", () => {
    const calls: WidgetCall[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(key: string, content: unknown): void {
          calls.push({ key, content });
          throw new Error("boom");
        },
      },
    } as unknown as ExtensionCommandContext;

    let handle: Progress | undefined;
    expect(() => {
      handle = startProgress(ctx, "x");
    }).not.toThrow();

    // First call registers the factory; the catch retries with `undefined`.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBe(PROGRESS_WIDGET_KEY);
    expect(calls[1]).toEqual({ key: PROGRESS_WIDGET_KEY, content: undefined });
    expect(() => handle!.update("y")).not.toThrow();
    expect(() => handle!.stop()).not.toThrow();
  });
});
