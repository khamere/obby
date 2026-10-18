// Minimal service worker for the hosted-PWA build mode. Its only jobs:
//   1. Satisfy the browser's PWA install criteria (must have a registered
//      SW with a fetch handler).
//   2. Cache the navigation response so the chrome reloads without the
//      network when the user opens the installed PWA offline.
//
// Hashed asset bundles get their own cache identity automatically since
// the URL changes on every deploy; we never serve a stale asset, just
// fall back to whatever's cached when fetch fails. The HTML cache is
// trimmed to the single latest navigation entry to avoid unbounded
// growth.

const NAV_CACHE = "obby-hosted-nav-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name !== NAV_CACHE).map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (req.mode === "navigate") {
    // Network-first: always try the live network so a fresh deploy is
    // picked up immediately. Cache the response for the offline path.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(NAV_CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() =>
          caches
            .open(NAV_CACHE)
            .then((c) => c.match("/").then((r) => r || Response.error())),
        ),
    );
    return;
  }
});

function parseIrcPushPayload(raw) {
  let rest = raw.trim();
  if (!rest) return null;

  let msgid = "";
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    const tagsPart = rest.slice(1, sp);
    for (const tag of tagsPart.split(";")) {
      const eq = tag.indexOf("=");
      if (eq !== -1 && tag.slice(0, eq) === "msgid") {
        msgid = tag.slice(eq + 1);
      }
    }
    rest = rest.slice(sp + 1).trimStart();
  }

  let sender = "";
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return null;
    const prefix = rest.slice(1, sp);
    sender = prefix.split("!")[0] || prefix;
    rest = rest.slice(sp + 1).trimStart();
  }

  const cmdSp = rest.indexOf(" ");
  if (cmdSp === -1) return null;
  const command = rest.slice(0, cmdSp).toUpperCase();
  if (command !== "PRIVMSG" && command !== "NOTICE") return null;

  const afterCmd = rest.slice(cmdSp + 1).trimStart();
  const targetSp = afterCmd.indexOf(" ");
  if (targetSp === -1) return null;
  const rawTarget = afterCmd.slice(0, targetSp);
  const target = rawTarget.replace(/^[@+%~]+/, "");
  let body = afterCmd.slice(targetSp + 1).trimStart();
  if (body.startsWith(":")) body = body.slice(1);

  if (body.startsWith("\x01")) {
    if (body.startsWith("\x01ACTION ")) {
      body = `* ${sender} ${body.slice(8).replace(/\x01$/, "")}`;
    } else {
      return null;
    }
  }

  // Strip IRC formatting control codes
  body = body.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: IRC control codes
    /[\x02\x0f\x16\x1d\x1e\x1f]|\x03\d{0,2}(?:,\d{0,2})?|\x04[0-9a-fA-F]{0,6}(?:,[0-9a-fA-F]{0,6})?/g,
    "",
  );

  const isChannel =
    target.startsWith("#") ||
    target.startsWith("&") ||
    target.startsWith("^") ||
    target.startsWith("$");
  const title = isChannel
    ? `${sender} mentioned you in ${target}`
    : `DM from ${sender}`;

  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tag = msgid ? `obby-msg-${msgid}` : `push-${target}-${uniqueSuffix}`;
  return { title, body, tag, hasMsgId: Boolean(msgid) };
}

self.addEventListener("push", (event) => {
  const raw = event.data ? event.data.text() : "";
  if (!raw) return;

  const parsed = parseIrcPushPayload(raw);
  if (!parsed) return;

  event.waitUntil(
    Promise.all([
      self.clients.matchAll({ type: "window", includeUncontrolled: true }),
      parsed.hasMsgId && self.registration.getNotifications
        ? self.registration.getNotifications({ tag: parsed.tag })
        : Promise.resolve([]),
    ]).then(([clientList, existingNotifications]) => {
      if (
        clientList.some((c) => c.focused && c.visibilityState === "visible")
      ) {
        return;
      }
      if (existingNotifications && existingNotifications.length > 0) {
        return;
      }
      return self.registration.showNotification(parsed.title, {
        body: parsed.body,
        icon: "/images/obby.png",
        badge: "/pwa/icon-192.png",
        tag: parsed.tag,
        renotify: true,
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow("/");
        }
      }),
  );
});
