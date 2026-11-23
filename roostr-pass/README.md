# Roostr Pass

The Chrome extension that brings Roostr its browser sign-ins from your own
Chrome (harness/src/pass.ts has the whole story).

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Copy the id Chrome shows on Roostr Pass's card, then from the glonOdin folder:
   `./glon-odin pass install <extension-id>`
3. Reload Roostr Pass. Its popup lists your browser logins: ✓ when connected,
   a "Sign in to …" button when Roostr needs you to sign in.

Roostr (the daemon and harness) must run on the same computer as Chrome.
