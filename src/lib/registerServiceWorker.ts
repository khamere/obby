import { isTauri } from "./platformUtils";

// Register the service worker on web builds so PWA caching, mobile browser
// notifications, and soju.im/webpush background notifications work.
// Registration is deferred to the "load" event so the SW download doesn't
// race the initial bundle parse.
export function registerHostedServiceWorker(): void {
  if (isTauri()) return;
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
      console.warn("[PWA] service worker registration failed:", err);
    });
  });
}
