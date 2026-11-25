import { AppearanceSettings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { canonical, reconcile } from "@/lib/theme/sync";

const a = (over: unknown = {}) => canonical(AppearanceSettings.parse(over));
const DEFAULT = a();

describe("theme sync", () => {
  it("compares appearance whatever the key order of the colours", () => {
    const one = a({ custom: { dark: { tokens: { primary: "#ff0000", background: "#000000" } } } });
    const two = a({ custom: { dark: { tokens: { background: "#000000", primary: "#ff0000" } } } });
    expect(one).toBe(two);
    expect(one).not.toBe(DEFAULT);
  });

  it("adopts a change saved in another window, and ignores its own echo", () => {
    const mine = a({ darkTheme: "hearth" });
    const theirs = a({ darkTheme: "dusk" });
    expect(reconcile(mine, mine, mine)).toBe("none");
    expect(reconcile(mine, theirs, mine)).toBe("adopt");
    // The server still has what this window last saw: nothing new there.
    expect(reconcile(theirs, mine, mine)).toBe("none");
  });

  it("on first sync, keeps a theme chosen here only while the server has none", () => {
    const local = a({ theme: "light" });
    const server = a({ darkTheme: "dusk" });
    // A fresh window (the desktop app's first start) takes the shared theme.
    expect(reconcile(DEFAULT, server, null)).toBe("adopt");
    // A browser that chose light before themes were saved keeps it and saves it.
    expect(reconcile(local, DEFAULT, null)).toBe("push");
    // Both chose: the shared one wins.
    expect(reconcile(local, server, null)).toBe("adopt");
    expect(reconcile(local, local, null)).toBe("none");
  });
});
