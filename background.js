// Zyraena Web Control: the browser half of Zyraena's web tools.
//
// The extension connects to Zyraena on this PC (ws://127.0.0.1:PORT, nothing else) and runs
// the commands she sends. Zyraena only accepts this extension's own origin, so web pages can't
// talk to her, and she asks the owner (PC popup + Telegram) before sending any command.
// The command list below is fixed: nothing here evaluates code that arrives over the socket.
// Page work is done by the functions in page.js, injected into the tab when a command needs them.

const PORT = 47821; // must match PORT in Zyraena's web_control.py
const PING_SECONDS = 20; // socket traffic keeps the service worker alive
const RECONNECT_ALARM = "reconnect";
const LOAD_TIMEOUT_MS = 20000;

let socket = null;
let pingTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  socket = ws;
  ws.onopen = () => {
    showState(true);
    send({ type: "hello", version: chrome.runtime.getManifest().version });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: "ping" }), PING_SECONDS * 1000);
  };
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = () => {
    if (socket === ws) socket = null;
    clearInterval(pingTimer);
    showState(false);
  };
  ws.onerror = () => {}; // Zyraena isn't running; the alarm retries
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function showState(connected) {
  chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#1f9d55" });
  chrome.action.setTitle({ title: `Zyraena Web Control: ${connected ? "connected" : "not connected"}` });
}

async function handle(message) {
  const { id, cmd, args } = message;
  if (id === undefined) return;
  const command = COMMANDS[cmd];
  try {
    if (!command) throw new Error(`unknown command '${cmd}'`);
    send({ id, ok: true, result: await command(args || {}) });
  } catch (error) {
    send({ id, ok: false, error: String(error?.message || error) });
  }
}

// --- commands ---------------------------------------------------------------------------

const COMMANDS = {
  tabs: async () => {
    const focused = await focusedWindowId();
    return (await chrome.tabs.query({})).map((tab) => tabInfo(tab, focused));
  },

  // One tab by id, or the active tab of the focused window.
  tab: async ({ tab }) => {
    if (tab !== undefined && tab !== null) return tabInfo(await chrome.tabs.get(tab));
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) throw new Error("no open tab");
    return tabInfo(active);
  },

  open: async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) addresses can be opened");
    const tab = await chrome.tabs.create({ url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(await loaded(tab.id));
  },

  close: async ({ tab }) => {
    await chrome.tabs.remove(tab);
    return true;
  },

  switch: async ({ tab }) => {
    const updated = await chrome.tabs.update(tab, { active: true });
    await chrome.windows.update(updated.windowId, { focused: true });
    return tabInfo(updated);
  },

  // Runs one of page.js's functions in the tab.
  page: async ({ tab, name, args }) => inPage(tab, name, args || []),

  download: async ({ url, timeout }) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) addresses can be downloaded this way");
    const id = await chrome.downloads.download({ url, conflictAction: "uniquify", saveAs: false });
    return finished(id, timeout);
  },

  // The video in a tab: "state", "loop" (on: true/false, or toggle), "volume" (0-100), "mute"
  // (on: true/false, or toggle). Runs videoControl in the page's own world, so YouTube's player
  // API can be used. (Fullscreen can't be done from here: browsers allow it only after a real key
  // press or click, so Zyraena presses YouTube's "f" for that.)
  video: async ({ tab, action, on, volume }) => {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab },
      world: "MAIN",
      args: [action, on ?? null, volume ?? null],
      func: videoControl,
    });
    const outcome = injection?.result;
    if (!outcome) throw new Error("the page didn't answer (it may still be loading)");
    if (outcome.error) throw new Error(outcome.error);
    return outcome;
  },
};

// Runs inside the page (main world). Picks the page's main video (YouTube's player first, then
// a playing one), does `action` and returns the video's state afterwards.
function videoControl(action, on, volume) {
  const videos = [...document.querySelectorAll("video")];
  const video =
    document.querySelector("video.html5-main-video") ||
    videos.find((v) => !v.paused) ||
    videos.find((v) => v.duration > 0) ||
    videos[0];
  if (!video) return { found: false };
  const player = document.getElementById("movie_player");
  const youtube = !!(player && typeof player.setVolume === "function");
  const state = () => ({
    found: true,
    youtube,
    loop: video.loop,
    volume: youtube ? player.getVolume() : Math.round(video.volume * 100),
    muted: youtube ? player.isMuted() : video.muted,
    paused: video.paused,
  });
  if (action === "loop") {
    // the same as YouTube's right-click "Loop"
    video.loop = on === null ? !video.loop : !!on;
  } else if (action === "volume") {
    const level = Math.max(0, Math.min(100, Math.round(Number(volume))));
    if (Number.isNaN(level)) return { error: "give the volume as a number from 0 to 100" };
    if (youtube) {
      player.setVolume(level);
      if (level > 0) player.unMute(); else player.mute();
    } else {
      video.volume = level / 100;
      video.muted = level === 0;
    }
  } else if (action === "mute") {
    const muted = youtube ? player.isMuted() : video.muted;
    const want = on === null ? !muted : !!on;
    if (youtube) (want ? player.mute() : player.unMute());
    else video.muted = want;
  } else if (action !== "state") {
    return { error: `unknown video action '${action}'` };
  }
  return state();
}

// --- helpers --------------------------------------------------------------------------------

async function focusedWindowId() {
  try {
    return (await chrome.windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

function tabInfo(tab, focusedWindow) {
  return {
    id: tab.id,
    title: tab.title || "",
    url: tab.url || tab.pendingUrl || "",
    active: tab.active,
    focused: focusedWindow === undefined ? undefined : tab.active && tab.windowId === focusedWindow,
    pinned: tab.pinned,
    audible: tab.audible,
    window: tab.windowId,
  };
}

function loaded(tabId) {
  return new Promise((resolve) => {
    const done = async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(await chrome.tabs.get(tabId).catch(() => ({ id: tabId })));
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
  });
}

async function inPage(tabId, name, args) {
  const target = { tabId };
  await chrome.scripting.executeScript({ target, files: ["page.js"] });
  const [injection] = await chrome.scripting.executeScript({
    target,
    args: [name, args],
    func: async (fn, fnArgs) => {
      const api = globalThis.__zyraena;
      if (!api || typeof api[fn] !== "function") return { error: `unknown page function '${fn}'` };
      try {
        return { value: await api[fn](...fnArgs) };
      } catch (error) {
        return { error: String(error?.message || error) };
      }
    },
  });
  const outcome = injection?.result;
  if (!outcome) throw new Error("the page didn't answer (it may still be loading)");
  if (outcome.error) throw new Error(outcome.error);
  return outcome.value;
}

// Waits until the download completes or fails, or `timeout` seconds pass (then it's still running).
function finished(id, timeout = 600) {
  return new Promise((resolve) => {
    const report = async () => {
      const [item] = await chrome.downloads.search({ id });
      return {
        state: item?.state || "unknown",
        filename: item?.filename || "",
        bytes: item?.bytesReceived || 0,
        total: item?.totalBytes || 0,
        error: item?.error || "",
      };
    };
    const done = async () => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(await report());
    };
    const listener = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") done();
    };
    chrome.downloads.onChanged.addListener(listener);
    const timer = setTimeout(done, timeout * 1000);
    report().then((item) => {
      if (item.state !== "in_progress") done();
    });
  });
}

// --- staying connected ------------------------------------------------------------------------

chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
showState(false);
connect();
