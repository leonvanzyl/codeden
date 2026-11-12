import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposerBounds, toasterOffsets, useComposerBounds } from "@/lib/toast-placement";
import { useUiStore } from "@/stores/ui";

/** A composer whose box spans `left`..`right` and starts `height` px above the viewport bottom. */
const composer = (
  viewport: [number, number],
  box: { left: number; right: number; height: number },
): ComposerBounds => ({
  top: viewport[1] - box.height,
  left: box.left,
  right: box.right,
  viewportWidth: viewport[0],
  viewportHeight: viewport[1],
});

describe("toast placement around the composer", () => {
  it("keeps the default offsets without a composer on screen", () => {
    expect(toasterOffsets(null, "right")).toEqual({});
  });

  it("lifts full-width phone toasts above the composer", () => {
    // 390x844: the box (164 px tall, 12 px of padding below) starts 176 px from the bottom.
    const phone = composer([390, 844], { left: 12, right: 378, height: 176 });
    expect(toasterOffsets(phone, "right").mobileOffset).toEqual({ bottom: 184 });
  });

  it("lifts corner toasts that would cover the composer on a tablet", () => {
    // 820 wide: the toast column (440..796) overlaps the composer (66..754).
    const tablet = composer([820, 1180], { left: 66, right: 754, height: 114 });
    expect(toasterOffsets(tablet, "right").offset).toEqual({ bottom: 122 });
  });

  it("leaves corner toasts alone beside the composer on a wide window", () => {
    // 1440 wide: the composer ends at 954, the toast column starts at 1060.
    const desktop = composer([1440, 900], { left: 294, right: 954, height: 114 });
    expect(toasterOffsets(desktop, "right").offset).toBeUndefined();
    // On the left (a native browser view on screen) the column (24..380) overlaps it.
    expect(toasterOffsets(desktop, "left").offset).toEqual({ bottom: 122 });
  });

  it("never brings toasts closer to the edge than the defaults", () => {
    const offscreen = composer([390, 844], { left: 12, right: 378, height: -40 });
    expect(toasterOffsets(offscreen, "right").mobileOffset).toEqual({ bottom: 16 });
  });
});

/** A composer box that publishes its bounds. */
function Box() {
  const ref = useRef<HTMLDivElement>(null);
  useComposerBounds(ref);
  return <div ref={ref} data-testid="box" />;
}

describe("the composer's published bounds", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows the box when the layout around it moves it without resizing it", () => {
    const observers: { targets: Element[]; notify: () => void; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets: Element[] = [];
        disconnected = false;
        constructor(callback: () => void) {
          observers.push(Object.assign(this, { notify: () => callback() }));
        }
        observe(el: Element) {
          this.targets.push(el);
        }
        disconnect() {
          this.disconnected = true;
        }
      },
    );
    let rect = { top: 785, left: 360, right: 1048 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({ ...rect, bottom: rect.top + 94, width: rect.right - rect.left, height: 94 }) as DOMRect,
    );

    const view = render(
      <main data-testid="main">
        <div data-testid="thread">
          <Box />
        </div>
      </main>,
    );
    const observer = observers[0];
    // The box and the elements it sits in, whose size changes are what move it.
    for (const id of ["box", "thread", "main"]) {
      expect(observer?.targets).toContain(view.getByTestId(id));
    }
    expect(useUiStore.getState().composerBounds).toMatchObject({ top: 785, left: 360 });

    // The right panel closes: the main column widens and the capped box re-centres.
    rect = { top: 785, left: 591, right: 1279 };
    act(() => observer?.notify());
    expect(useUiStore.getState().composerBounds).toMatchObject({ left: 591, right: 1279 });
    // The terminal drawer opens: the thread column shortens and the box moves up.
    rect = { top: 524, left: 591, right: 1279 };
    act(() => observer?.notify());
    expect(useUiStore.getState().composerBounds).toMatchObject({ top: 524 });

    view.unmount();
    expect(observer?.disconnected).toBe(true);
    expect(useUiStore.getState().composerBounds).toBeNull();
  });
});
