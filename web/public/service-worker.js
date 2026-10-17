// Ensemble operator push worker, served at /app/service-worker.js (scope /app/).
// It has no fetch handler and keeps no cache, so an update can never serve a stale app.
// A push shows a notification and a click opens the exact Inbox selection; nothing else.
const FALLBACK_TITLE = "Ensemble needs you";
const FALLBACK_URL = "/app/inbox";
const BODY = "Open Ensemble to respond.";

// The server only ever sends an Inbox link or the Settings link; anything else is ignored.
const safeUrl = (url) =>
  typeof url === "string" &&
  url.length <= 600 &&
  /^[\x21-\x7e]+$/.test(url) &&
  (url.startsWith("/app/inbox?") || url === "/app/settings#notifications");

const accepted = (payload) =>
  payload !== null &&
  typeof payload === "object" &&
  payload.v === 1 &&
  typeof payload.title === "string" &&
  payload.title.length >= 1 &&
  payload.title.length <= 200 &&
  typeof payload.tag === "string" &&
  payload.tag.length >= 1 &&
  payload.tag.length <= 256 &&
  safeUrl(payload.url);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let note = { title: FALLBACK_TITLE, url: FALLBACK_URL, tag: undefined };
  try {
    const payload = event.data.json();
    if (accepted(payload)) note = payload;
  } catch {
    // An unreadable payload still shows the fixed notification: browsers require one per push.
  }
  event.waitUntil(
    self.registration.showNotification(note.title, {
      tag: note.tag,
      data: { url: note.url },
      body: BODY,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const url = data && safeUrl(data.url) ? data.url : FALLBACK_URL;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = windows.find((client) => {
        try {
          const address = new URL(client.url);
          return (
            address.origin === self.location.origin &&
            address.pathname.startsWith("/app/")
          );
        } catch {
          return false;
        }
      });
      if (target) {
        try {
          await target.focus();
          await target.navigate(url);
          return;
        } catch {
          // A window the worker does not control cannot be navigated; open one instead.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
