import { describe, expect, it, vi } from "vitest";
import { type ClipboardEnv, copyText } from "@/lib/clipboard";

function env(over: Partial<ClipboardEnv> = {}) {
  const writeText = vi.fn(async (_text: string) => {});
  const fallback = vi.fn((_text: string) => true);
  return {
    writeText,
    fallback,
    env: { isSecureContext: true, clipboard: { writeText }, fallback, ...over },
  };
}

describe("copyText", () => {
  it("uses the Clipboard API in a secure context", async () => {
    const t = env();
    expect(await copyText("hi", t.env)).toBe(true);
    expect(t.writeText).toHaveBeenCalledWith("hi");
    expect(t.fallback).not.toHaveBeenCalled();
  });

  it("falls back to the copy command on an insecure origin", async () => {
    const t = env({ isSecureContext: false, clipboard: undefined });
    expect(await copyText("hi", t.env)).toBe(true);
    expect(t.fallback).toHaveBeenCalledWith("hi");
  });

  it("falls back when the Clipboard API rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const t = env({ clipboard: { writeText } });
    expect(await copyText("hi", t.env)).toBe(true);
    expect(t.fallback).toHaveBeenCalledWith("hi");
  });

  it("resolves false when both ways fail", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    const fallback = vi.fn(() => {
      throw new Error("no copy command");
    });
    expect(
      await copyText("hi", { isSecureContext: true, clipboard: { writeText }, fallback }),
    ).toBe(false);
    expect(
      await copyText("hi", { isSecureContext: false, clipboard: undefined, fallback: () => false }),
    ).toBe(false);
  });
});
