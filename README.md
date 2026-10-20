# Zyraena Web Control

An Opera GX extension that gives [Zyraena](../AI_Agent_ProjectZyraena) hands in the browser.
Through it she can:

- list, open, close and switch tabs
- read a page: its text and a numbered list of links, buttons, fields, drop areas and pictures
- click, type (including picking from a dropdown and submitting a form)
- download a link, a picture or a file (with Opera's own logins), and upload a file from the PC
- control the video in a tab (YouTube or any site): loop on/off, its own volume, mute, and tell
  its state (since 1.2; this replaced the old "Zyraena Video Controls" shortcut extension)

WhatsApp isn't part of this extension any more: Zyraena reads and sends WhatsApp messages
through the WhatsApp Desktop app (`whatsapp_tools.py`), so WhatsApp Web doesn't need to be open.

**She asks before every step, reading included**, on the PC (a popup) and on Telegram at the
same time. Whichever you answer first counts, and no answer within 10 minutes counts as no.
The questions are asked by Zyraena, not by the extension, so they work while you're away.
The video controls are the exception (the owner's choice): they only touch the video player.

Fullscreen isn't done here: browsers allow it only after a real key press or click, so Zyraena
presses YouTube's own `f` key for it.

## Install

1. Open `opera://extensions` in Opera GX.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → pick this folder (`Documents\Projects\Web_ControlExtention`).
4. Optional: pin the extension. Its badge shows **ON** while it's connected to Zyraena.

After changing the files here, press the reload button on the extension's card. Opera loads the
extension from this folder every time, so **if the folder moves, remove the extension and load it
again from the new place**. Zyraena checks this (Opera's own list of loaded extensions, the version
the extension reports when it connects, and whether it connects at all while Opera runs) and tells
you on the PC and on Telegram when something is wrong, including other extensions whose folder is gone.

## How it works

```
Zyraena (web_control.py)  ⇄  ws://127.0.0.1:47821  ⇄  background.js  →  page.js in the tab
```

- `background.js` connects to Zyraena and runs the commands she sends. The command list is fixed;
  nothing that arrives over the socket is run as code. When Zyraena isn't running it retries
  every 30 seconds.
- `page.js` is injected into a tab only when a command needs it. It numbers elements with a
  `data-zyraena-ref` attribute, so Zyraena can say "click 12".
- Zyraena listens on `127.0.0.1` only and accepts only this extension's origin
  (`chrome-extension://jkjagcjnhockldeegpcpepaehhepdehp`). The ID is fixed by the `key` in
  `manifest.json`, so don't remove or change it, or Zyraena will refuse the connection
  (the ID would then change and `EXTENSION_ID` in `web_control.py` would have to change with it).
- Files go both ways in 3 MB pieces. Uploads are limited to 200 MB and only from Zyraena's allowed
  folders; secrets (`.env`, keys, password stores, `.ssh` ...) are never uploaded.

## Limits

- Clicks and typing are synthetic events. Most sites accept them, but some (captchas, a few
  banking sites) ignore them on purpose.
- Only the page's top frame is read; content inside iframes isn't listed.
- `opera://` pages and the add-ons store can't be read or clicked (the browser forbids it).
