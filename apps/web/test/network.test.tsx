import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { qrPath } from "@/components/common/qr-code";
import { deviceName, NetworkSettings } from "@/components/settings/sections-network";
import { SignInScreen } from "@/components/shell/sign-in";
import type { CodeDenClient } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { SignInFailure } from "@/lib/api/network-api";
import { viewportFrom } from "@/lib/viewport";
import { renderWithClient } from "./utils";

const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled;

describe("Settings › Network access", () => {
  it("needs a password before it can be switched on, then lists addresses with QR codes", async () => {
    const user = userEvent.setup();
    renderWithClient(<NetworkSettings />);
    const toggle = await screen.findByTestId("network-toggle");
    expect(isDisabled(toggle)).toBe(true);
    expect(screen.getByText("Set a password below first.")).toBeTruthy();

    // The rules are explained, and a weak password is refused as you type.
    const input = screen.getByTestId("network-password-input");
    await user.type(input, "password1234567");
    expect(screen.getByRole("alert").textContent).toMatch(/common password/);
    expect(isDisabled(screen.getByRole("button", { name: /Set password/ }))).toBe(true);
    await user.clear(input);
    await user.type(input, "my cat sleeps on the router");
    await user.click(screen.getByRole("button", { name: /Set password/ }));
    await waitFor(() => expect(isDisabled(screen.getByTestId("network-toggle"))).toBe(false));

    await user.click(screen.getByTestId("network-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("network-toggle").getAttribute("data-state")).toBe("checked"),
    );
    const addresses = screen.getAllByTestId("network-address");
    expect(addresses.map((a) => within(a).getByRole("button").textContent)).toEqual([
      "http://localhost:4317",
      "http://192.168.1.20:4317",
      "http://100.101.102.103:4317",
    ]);
    // A QR code for each address a phone can use (not for localhost).
    const codes = screen.getAllByTestId("qr-code");
    expect(codes.map((c) => c.getAttribute("data-value"))).toEqual([
      "http://192.168.1.20:4317",
      "http://100.101.102.103:4317",
    ]);
  });

  it("keeps the listener on this computer when asked, and lists trusted origins", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    const status = await client.network.status();
    const withOrigin: CodeDenClient = {
      ...client,
      network: {
        ...client.network,
        status: async () => ({ ...status, trustedOrigins: ["https://box.ts.net:8445"] }),
      },
    };
    renderWithClient(<NetworkSettings />, withOrigin);
    expect((await screen.findByTestId("network-trusted-origin")).textContent).toBe(
      "https://box.ts.net:8445",
    );
    const toggle = screen.getByTestId("network-loopback-only");
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("data-state")).toBe("checked"));
  });

  it("shows a generated password once, with a copy button", async () => {
    const user = userEvent.setup();
    renderWithClient(<NetworkSettings />);
    await user.click(await screen.findByRole("button", { name: /Generate/ }));
    const box = await screen.findByTestId("generated-password");
    expect(box.querySelector("code")?.textContent).toMatch(/^[a-z]+(-[a-z]+){4}$/);
    expect(within(box).getByRole("button", { name: /Copy/ })).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: /saved it/ }));
    expect(screen.queryByTestId("generated-password")).toBeNull();
  });

  it("signs out one device or all of them", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    renderWithClient(<NetworkSettings />, client);
    const device = await screen.findByTestId("network-device");
    expect(device.textContent).toMatch("iPhone · Safari");
    await user.click(within(device).getByRole("button", { name: /Sign out/ }));
    await screen.findByText("No devices signed in.");
  });

  it("is read-only on a remote device", async () => {
    const client = createMockClient();
    const status = await client.network.status();
    const remote: CodeDenClient = {
      ...client,
      network: { ...client.network, status: async () => ({ ...status, remote: true }) },
    };
    renderWithClient(<NetworkSettings />, remote);
    expect((await screen.findAllByText(/computer running CodeDen/)).length).toBeGreaterThan(0);
    expect(isDisabled(screen.getByTestId("network-toggle"))).toBe(true);
    expect(isDisabled(screen.getByTestId("network-loopback-only"))).toBe(true);
    expect(screen.queryByTestId("network-password-input")).toBeNull();
  });

  it("names devices from their user agent", () => {
    expect(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140 Mobile Safari")).toBe(
      "Android phone · Chrome",
    );
    expect(deviceName("Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) Safari/605")).toBe(
      "iPad · Safari",
    );
    expect(deviceName("curl/8.0")).toBe("Device");
  });
});

describe("QR codes", () => {
  it("encode an address into a square of dark modules", () => {
    const { d, size } = qrPath("http://192.168.1.20:4317");
    // Version 2 (25 modules) plus a 2-module quiet zone on each side.
    expect(size).toBe(29);
    expect(d).toMatch(/^M\d+ \d+h1v1h-1z/);
    // The top-left finder pattern starts right after the quiet zone.
    expect(d.startsWith("M2 2h1v1h-1z")).toBe(true);
    expect(qrPath("http://100.101.102.103:4317").d).not.toBe(d);
  });
});

describe("sign-in page", () => {
  function clientWith(signIn: (password: string) => Promise<void>): CodeDenClient {
    const client = createMockClient();
    return { ...client, auth: { ...client.auth, signIn } };
  }

  it("signs in with the password", async () => {
    const user = userEvent.setup();
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    renderWithClient(<SignInScreen onSignedIn={onSignedIn} />, clientWith(signIn));
    expect(screen.getByRole("heading", { name: "Sign in to CodeDen" })).toBeTruthy();
    const field = screen.getByLabelText("Password");
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("current-password");
    await user.type(field, "maple-river-quiet-orbit-candle");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(signIn).toHaveBeenCalledWith("maple-river-quiet-orbit-candle");
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it("explains a wrong password and makes you wait when throttled", async () => {
    const user = userEvent.setup();
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(
        new SignInFailure("invalid_password", "That password is not right.", null),
      )
      .mockRejectedValueOnce(new SignInFailure("rate_limited", "Wait 4 s before trying again.", 4));
    renderWithClient(<SignInScreen onSignedIn={() => {}} />, clientWith(signIn));
    await user.type(screen.getByLabelText("Password"), "nope nope nope nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch("That password is not right.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    await user.type(screen.getByLabelText("Password"), "still wrong, sorry");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch("Wait 4 s");
    expect(isDisabled(screen.getByRole("button", { name: /Try again in \d s/ }))).toBe(true);
  });
});

describe("responsive layout modes", () => {
  it("uses a drawer below 1024 px and a rail on touch tablets in landscape", () => {
    const phone = viewportFrom({ phone: true, narrow: true, medium: true, coarse: true });
    expect(phone).toEqual({ phone: true, drawerNav: true, railNav: false, sheetPanels: true });
    const portrait = viewportFrom({ phone: false, narrow: true, medium: true, coarse: true });
    expect(portrait).toMatchObject({ drawerNav: true, sheetPanels: true });
    const landscape = viewportFrom({ phone: false, narrow: false, medium: true, coarse: true });
    expect(landscape).toMatchObject({ drawerNav: false, railNav: true, sheetPanels: true });
    // Narrow desktop windows with a mouse keep the desktop layout.
    for (const narrow of [true, false]) {
      const desktop = viewportFrom({ phone: false, narrow, medium: true, coarse: false });
      expect(desktop).toMatchObject({ drawerNav: false, railNav: false, sheetPanels: false });
    }
  });
});
