# Phones, tablets and network access

CodeDen runs on your computer, but you can open it from your phone or tablet: answer an approval from the sofa, check on an agent from the kitchen, or talk to the orchestrator while you're out, over your own VPN. **Network access is off by default.** Until you turn it on, CodeDen only answers on this computer (`127.0.0.1`) and nothing changes.

## Turn it on

1. On the computer running CodeDen, open **Settings › Network access**.
2. **Set a password.** It needs at least 15 characters. A short sentence or a few random words works well; very common passwords, repeated characters and simple sequences (`abcdef…`, `12345…`, `qwerty…`) are refused. Or press **Generate**: CodeDen makes up a five-word passphrase such as `maple-river-quiet-orbit-candle` and shows it **once**, with a copy button. Save it in your password manager: CodeDen keeps only a scrambled copy (a salted scrypt hash) and can't show it again.
3. Switch on **Allow network access**. CodeDen moves its web server from `127.0.0.1` to all of the computer's network addresses, on the same port. Agents, the runner and your open CodeDen window carry on; nothing restarts.

From a terminal (handy on a headless machine):

```
codeden password             # type a password (or pipe one in)
codeden password --generate  # make one up and print it once
codeden network on           # or: codeden network off
codeden network              # show whether it's on, and the addresses
```

These work whether CodeDen is running or not. Changing the password signs out every phone and tablet.

> **Windows:** the first time CodeDen listens on the network, Windows Defender Firewall may ask whether to allow Node.js (or CodeDen) on private networks. Allow **private** networks only.

## Open it on your phone

**Settings › Network access** lists every address CodeDen answers on, each with a **QR code**:

- **This computer** (`http://localhost:4317`): only works on the computer itself.
- **Your local network** (Wi-Fi or Ethernet), e.g. `http://192.168.1.20:4317`.
- **Your VPN**, e.g. Tailscale's `http://100.101.102.103:4317` (any address in `100.64.0.0/10`, or an interface named like a VPN).

Point your phone's camera at the QR code (or type the address into its browser). You get a sign-in page: enter the password once and the phone stays signed in for **90 days**. The terminal also prints the same addresses when CodeDen starts with network access on.

The phone and the computer must be on the same network, or both on your VPN. Guest Wi-Fi networks often keep devices apart; use your main network.

## Add it to your home screen

CodeDen can sit on your home screen like an app and open full screen, without the browser's address bar.

- **iPhone and iPad (Safari):** open CodeDen, tap **Share**, then **Add to Home Screen**, then **Add**.
- **Android (Chrome):** open CodeDen, tap the **⋮** menu, then **Add to Home screen** (or **Install app**), then **Add**.

## Away from home: your own VPN

CodeDen doesn't need anything extra to work away from home: put your phone and your computer on the same private network with a VPN you control, and use the VPN address from **Settings › Network access**.

- **Tailscale** is the easiest: install it on the computer and the phone and sign in to the same tailnet. The computer's Tailscale address (`100.x.y.z`) shows up in the list with its own QR code. Keep Tailscale's own sharing features (Funnel) **off** for CodeDen: it is meant for your devices only.
- **WireGuard** or your router's VPN work the same way: the computer's VPN address shows up in the list.

Never forward CodeDen's port on your router to the internet.

## What a plain http address can't do

Network access serves CodeDen over plain `http://` (there's no certificate for an address like `192.168.1.20`). Phones only allow some features on secure (`https://`) pages, so on a phone or tablet:

- **No notifications.** You won't get push notifications or desktop-style alerts; the inbox count and the in-app cues still work while CodeDen is open.
- **No microphone.** Dictation needs a secure page, so the voice button can't record. Type, or use your keyboard's own dictation.
- **No offline mode.** CodeDen needs the computer to be on and reachable; there's no offline copy on the phone.

Everything else works: the orchestrator and PM chats, sessions and their transcripts, approvals and questions, the inbox, projects, automations and settings.

## HTTPS through Tailscale Serve

A plain `http://100.x.y.z:4317` address can't give a phone notifications or dictation. If the computer runs Tailscale, **Tailscale Serve** can put HTTPS in front of CodeDen on a name like `https://<machine>.<tailnet>.ts.net:8445`. That unlocks **notifications**, **dictation** and **installing to the home screen** as a real app. Serve must run on the same computer as CodeDen.

1. Set a password (once): `codeden password`.
2. Tell CodeDen the address to trust: `codeden network origin add https://<machine>.<tailnet>.ts.net:8445`. Only `https://<host name>[:port]` is accepted (no path, no IP address). Check them with `codeden network origin list`.
3. Turn network access on and keep CodeDen on `127.0.0.1`, so the proxy is the only way in: `codeden network on --loopback-only`. The same choice is **Settings › Network access › Listen on this computer only**. Without `--loopback-only`, `network on` listens on every interface as before.
4. Start the proxy: `tailscale serve --bg --https=8445 http://127.0.0.1:4317`.

On the phone (on your tailnet), open `https://<machine>.<tailnet>.ts.net:8445`, sign in with the password and allow notifications. Without a session, or while network access is off, that address answers 401 or 403; `ss -ltn` shows CodeDen only on `127.0.0.1`.

Keep **Tailscale Funnel off** for CodeDen: Funnel puts it on the public internet and isn't supported. Only a proxy on this computer, which you named with `origin add`, is trusted; a proxy on another machine isn't supported. Turning network access off, or removing the origin, ends access through it at once.

How CodeDen treats a request for a trusted address: it counts as coming from another device even though the proxy connects from this computer, so it needs the password session, never the install token, and `/mcp` answers 404. CodeDen does not log anyone in from Tailscale's identity headers (`Tailscale-User-Login` and others): any program on this computer could send those itself. The proxy's `X-Forwarded-For` is used only to tell devices apart for sign-in throttling and to show an address (marked *reported by proxy*) in Signed-in devices and the log.

## Signed-in devices

**Settings › Network access › Signed-in devices** lists each phone or tablet with its browser, address and when it was last seen. **Sign out** removes one; **Sign out all** removes them all. Changing the password signs out every device too. A signed-out device goes back to the sign-in page at once.

## Security model

- **Off by default, and only with a password.** CodeDen refuses to listen beyond `127.0.0.1` unless network access is switched on *and* a password is set, including at startup.
- **Only a hash is stored.** The password is kept as a salted scrypt hash in `~/.codeden/remote-access.json` (readable only by you where the OS supports file modes). Each device's 90-day session token is random; only its SHA-256 hash is stored, with the device's browser name and when it was last seen.
- **Session cookie.** A signed-in device holds the token in an `HttpOnly`, `SameSite=Lax` cookie (also `Secure` when CodeDen is served over HTTPS, including through a trusted origin).
- **Who is remote** is decided by the connection's own address: anything other than this computer's loopback (`127.0.0.0/8`, `::1`, and their IPv4-mapped forms) is remote. `X-Forwarded-For` and similar headers are never trusted, so they grant nothing. The one addition is a trusted origin (above): a request naming its host is also remote, which only ever demands more.
- **Remote devices sign in with the password; the install token doesn't work for them.** This computer keeps using the install token exactly as before, so `npx codeden` and the desktop app are unaffected.
- **Guessing is throttled.** Only failed sign-ins count, per address. After three wrong passwords each try has to wait 1 s, then 2 s, 4 s … up to 30 s; ten failures within 15 minutes lock that address out for 15 minutes. Other devices keep working. Failed sign-ins are logged with their address (never the password) in `~/.codeden/logs/remote-access.log`.
- **What a signed-in device can reach:** the web UI, its HTTP API and its WebSockets (live updates, the terminal and browser panels), the same things you can do at the computer.
- **What is never reachable from the network, even when it's on:** the agents' MCP endpoint (`/mcp`, which answers 404), the runner (it keeps listening on `127.0.0.1` only, as does its MCP proxy), and changing network access itself: the switch and the password can only be changed on the computer running CodeDen (or with the CLI there). A phone can see the settings and sign devices out.
- **Request checks still apply.** `Host` must be a loopback name or, while network access is on, one of this computer's own LAN or VPN addresses on CodeDen's port. `Origin`, when present, must be CodeDen's own: other websites, `null` origins and other ports on the same address are refused.
- **Turning it off** moves CodeDen back to `127.0.0.1` and drops every connection from other devices. Their sessions stay on the list until they expire or you sign them out, so turning it on again doesn't make you sign in everywhere again.

See also [Security](security.md).
