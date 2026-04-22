/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter((t) => {
      const url = t.url || "";
      return (
        !url.startsWith("chrome://") &&
        !url.startsWith("chrome-extension://") &&
        !url.startsWith("about:") &&
        !url.startsWith("edge://") &&
        !url.startsWith("brave://")
      );
    }).length;

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });

    if (count === 0) return;

    // Pick badge color based on workload level
    let color;
    if (count <= 10) {
      color = "#3d7a4a"; // Green — you're in control
    } else if (count <= 20) {
      color = "#b8892e"; // Amber — things are piling up
    } else {
      color = "#b35a5a"; // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: "" });
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

// ─── Screenshot cache (via chrome.debugger) ──────────────────────────────────

const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCREENSHOT_FORMAT = "jpeg";
const SCREENSHOT_QUALITY = 50;

/**
 * captureTabViaDebugger(tabId, url)
 *
 * Uses Chrome DevTools Protocol to capture a screenshot of ANY tab
 * (including background tabs) without activating it.
 * Attaches debugger, captures screenshot, then detaches immediately.
 */
async function captureTabViaDebugger(tabId, url) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
    const response = await chrome.debugger.sendCommand(
      target,
      "Page.captureScreenshot",
      {
        format: SCREENSHOT_FORMAT,
        quality: SCREENSHOT_QUALITY,
        fromSurface: true,
      },
    );
    await chrome.debugger.detach(target);

    if (!response || !response.data) return;

    const dataUrl = `data:image/${SCREENSHOT_FORMAT};base64,${response.data}`;
    const { screenshots = {} } = await chrome.storage.local.get("screenshots");
    screenshots[url] = { dataUrl, capturedAt: Date.now() };
    await chrome.storage.local.set({ screenshots });
  } catch {
    // Some pages (chrome://, chrome-extension://, etc.) don't allow debugging.
    // Ignore silently.
    try {
      await chrome.debugger.detach(target);
    } catch {}
  }
}

/**
 * captureAllTabs()
 *
 * Captures screenshots of all open web tabs in the background.
 * Called when the Tab Out new tab page opens.
 */
async function captureAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const webTabs = tabs.filter((t) => {
      const url = t.url || "";
      return (
        !url.startsWith("chrome://") &&
        !url.startsWith("chrome-extension://") &&
        !url.startsWith("about:") &&
        !url.startsWith("edge://") &&
        !url.startsWith("brave://")
      );
    });

    // Process one at a time to avoid overwhelming the browser
    for (const tab of webTabs) {
      if (!tab.id || !tab.url) continue;
      // Check if we already have a recent screenshot
      const { screenshots = {} } =
        await chrome.storage.local.get("screenshots");
      const existing = screenshots[tab.url];
      if (existing && Date.now() - existing.capturedAt < 60000) continue; // skip if < 1 min old
      await captureTabViaDebugger(tab.id, tab.url);
      // Small delay between captures
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // Ignore errors
  }
}

/**
 * cleanupOldScreenshots()
 */
async function cleanupOldScreenshots() {
  try {
    const [{ screenshots = {} }, tabs] = await Promise.all([
      chrome.storage.local.get("screenshots"),
      chrome.tabs.query({}),
    ]);
    const openUrls = new Set(tabs.map((t) => t.url).filter(Boolean));
    let changed = false;
    for (const [url, entry] of Object.entries(screenshots)) {
      if (
        Date.now() - (entry.capturedAt || 0) > MAX_CACHE_AGE_MS ||
        !openUrls.has(url)
      ) {
        delete screenshots[url];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ screenshots });
  } catch {}
}

// Respond to explicit capture-all request from the new tab page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "captureAllTabs") {
    captureAllTabs()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Periodic cleanup
chrome.alarms?.create?.("screenshot-cleanup", { periodInMinutes: 60 });
chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  if (alarm.name === "screenshot-cleanup") cleanupOldScreenshots();
});

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge();
