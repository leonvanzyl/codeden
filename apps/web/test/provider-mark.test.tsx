import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderMark } from "@/components/common/bits";

function markOf(provider: string, className?: string) {
  const { container } = render(<ProviderMark provider={provider} className={className} />);
  const mark = container.firstElementChild as HTMLElement;
  return { mark, logo: mark.querySelector("svg") };
}

describe("ProviderMark", () => {
  it("shows the Claude logo in its brand orange", () => {
    const { mark, logo } = markOf("claude");
    expect(logo?.getAttribute("data-provider-logo")).toBe("claude");
    expect(logo?.querySelector("path")?.getAttribute("fill")).toBe("#D97757");
    expect(mark.textContent).toBe("");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.className).toContain("size-4");
  });

  it("shows the Codex logo in the theme's text colour", () => {
    const { mark, logo } = markOf("codex");
    expect(logo?.getAttribute("data-provider-logo")).toBe("codex");
    expect(logo?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(mark.className).toContain("text-foreground");
    expect(mark.textContent).toBe("");
  });

  it("shows the OpenCode logo in the theme's text colour", () => {
    const { mark, logo } = markOf("opencode");
    expect(logo?.getAttribute("data-provider-logo")).toBe("opencode");
    expect(logo?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(mark.textContent).toBe("");
  });

  it("keeps the caller's size", () => {
    const { mark } = markOf("codex", "size-6");
    expect(mark.className).toContain("size-6");
    expect(mark.className).not.toContain("size-4");
  });

  it.each([
    ["mystery", "m"],
    ["fake", "f"],
    ["constructor", "c"],
  ])("falls back to the letter tile for %s", (provider, letter) => {
    const { mark, logo } = markOf(provider);
    expect(logo).toBeNull();
    expect(mark.textContent).toBe(letter);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
  });
});
