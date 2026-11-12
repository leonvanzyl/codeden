import { describe, expect, it } from "vitest";
import { type ComposerBounds, toasterOffsets } from "@/lib/toast-placement";

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
