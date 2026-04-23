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
    const count = tabs.filter((t) => isCapturableUrl(t.url || "")).length;

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

// ─── Screenshot cache (via chrome.debugger) ──────────────────────────────────

const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SCREENSHOT_CACHE_ENTRIES = 24;
const MAX_SCREENSHOT_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_SCREENSHOT_CHARS = 750000;
const SCREENSHOT_FORMAT = "jpeg";
const SCREENSHOT_QUALITY = 28;
const SCREENSHOT_FRESH_MS = 60 * 1000;
const CAPTURE_RETRY_DELAYS_MS = [0, 500, 1500];
const SCREENSHOT_STATUS_READY = "ready";
const SCREENSHOT_STATUS_FAILED = "failed";

let captureAllTabsPromise = null;
const inFlightCaptures = new Map();
const lastActiveTabByWindow = new Map();

function isCapturableUrl(url = "") {
  return (
    url &&
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("about:") &&
    !url.startsWith("edge://") &&
    !url.startsWith("brave://")
  );
}

async function getScreenshotCache() {
  const { screenshots = {} } = await chrome.storage.local.get("screenshots");
  return screenshots;
}

async function setScreenshotCache(screenshots) {
  await chrome.storage.local.set({ screenshots });
}

function logCapture(event, details = {}) {
  if (!globalThis.TAB_OUT_DEBUG_CAPTURE) return;
  console.log(`[tab-out][capture] ${event}`, details);
}

function estimateCacheBytes(screenshots) {
  try {
    return new TextEncoder().encode(JSON.stringify(screenshots)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function trimScreenshotsForQuota(screenshots, preserveUrl = "") {
  const sorted = Object.entries(screenshots).sort(
    ([, a], [, b]) => (b?.capturedAt || 0) - (a?.capturedAt || 0),
  );
  const trimmed = Object.fromEntries(sorted);

  const removeOldest = () => {
    const oldestRemovable = Object.entries(trimmed)
      .sort(([, a], [, b]) => (a?.capturedAt || 0) - (b?.capturedAt || 0))
      .find(([url]) => url !== preserveUrl);

    if (!oldestRemovable) return false;
    delete trimmed[oldestRemovable[0]];
    return true;
  };

  while (Object.keys(trimmed).length > MAX_SCREENSHOT_CACHE_ENTRIES) {
    if (!removeOldest()) break;
  }

  while (estimateCacheBytes(trimmed) > MAX_SCREENSHOT_CACHE_BYTES) {
    if (!removeOldest()) break;
  }

  return trimmed;
}

function shouldRefreshScreenshot(entry, force = false) {
  if (force) return true;
  if (!entry || !entry.capturedAt) return true;
  if (entry.status === SCREENSHOT_STATUS_FAILED) return true;
  if (entry.status !== SCREENSHOT_STATUS_READY || !entry.dataUrl) return true;
  return Date.now() - entry.capturedAt >= SCREENSHOT_FRESH_MS;
}

async function persistScreenshotEntry(url, entry) {
  const screenshots = await getScreenshotCache();
  screenshots[url] = entry;

  let candidate = trimScreenshotsForQuota(screenshots, url);
  try {
    await setScreenshotCache(candidate);
    return true;
  } catch (error) {
    logCapture("cache-write-error", {
      url,
      message: error?.message || String(error),
      bytes: estimateCacheBytes(candidate),
      entries: Object.keys(candidate).length,
    });
  }

  while (Object.keys(candidate).length > 1) {
    const oldestRemovable = Object.entries(candidate)
      .sort(([, a], [, b]) => (a?.capturedAt || 0) - (b?.capturedAt || 0))
      .find(([candidateUrl]) => candidateUrl !== url);

    if (!oldestRemovable) break;
    delete candidate[oldestRemovable[0]];

    try {
      await setScreenshotCache(candidate);
      logCapture("cache-write-recovered", {
        url,
        entries: Object.keys(candidate).length,
        bytes: estimateCacheBytes(candidate),
      });
      return true;
    } catch (error) {
      logCapture("cache-write-retry-failed", {
        url,
        message: error?.message || String(error),
        entries: Object.keys(candidate).length,
        bytes: estimateCacheBytes(candidate),
      });
    }
  }

  return false;
}

async function markScreenshotFailure(url, reason = "unknown") {
  await persistScreenshotEntry(url, {
    status: SCREENSHOT_STATUS_FAILED,
    reason,
    capturedAt: Date.now(),
  });
}

function buildScreenshotClip(metrics = {}) {
  const cssViewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  const layoutViewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const rawWidth = Math.round(
    cssViewport.clientWidth || layoutViewport.clientWidth || 1280,
  );
  const rawHeight = Math.round(
    cssViewport.clientHeight || layoutViewport.clientHeight || 720,
  );
  const width = Math.max(320, rawWidth);
  const height = Math.max(180, rawHeight);
  const targetWidth = 720;
  const scale = Math.min(1, targetWidth / width);

  return {
    x: Math.max(0, Math.round(cssViewport.pageX || 0)),
    y: Math.max(0, Math.round(cssViewport.pageY || 0)),
    width,
    height,
    scale,
  };
}

/**
 * captureTabViaDebugger(tabId, url)
 *
 * Uses Chrome DevTools Protocol to capture a screenshot of ANY tab
 * (including background tabs) without activating it.
 * Attaches debugger, captures screenshot, then detaches immediately.
 */
async function captureTabViaDebugger(tabId, url) {
  const captureKey = `${tabId}:${url}`;
  if (inFlightCaptures.has(captureKey)) return inFlightCaptures.get(captureKey);

  const target = { tabId };
  logCapture("start", { tabId, url });

  const capturePromise = (async () => {
    try {
      await chrome.debugger.attach(target, "1.3");
      logCapture("attached", { tabId, url });

      await chrome.debugger.sendCommand(target, "Page.enable");
      logCapture("page-enabled", { tabId, url });

      // Give the page a brief moment to paint before capture.
      await new Promise((resolve) => setTimeout(resolve, 180));

      const metrics = await chrome.debugger.sendCommand(
        target,
        "Page.getLayoutMetrics",
      );
      const clip = buildScreenshotClip(metrics);
      logCapture("clip", { tabId, url, clip });

      const response = await chrome.debugger.sendCommand(
        target,
        "Page.captureScreenshot",
        {
          format: SCREENSHOT_FORMAT,
          quality: SCREENSHOT_QUALITY,
          fromSurface: true,
          clip,
        },
      );

      if (!response || !response.data) {
        logCapture("empty-response", { tabId, url, response });
        await markScreenshotFailure(url, "empty");
        return false;
      }

      const dataUrl = `data:image/${SCREENSHOT_FORMAT};base64,${response.data}`;
      if (dataUrl.length > MAX_SINGLE_SCREENSHOT_CHARS) {
        logCapture("too-large", {
          tabId,
          url,
          chars: dataUrl.length,
          limit: MAX_SINGLE_SCREENSHOT_CHARS,
        });
        await markScreenshotFailure(url, `too_large:${dataUrl.length}`);
        return false;
      }

      const persisted = await persistScreenshotEntry(url, {
        status: SCREENSHOT_STATUS_READY,
        dataUrl,
        capturedAt: Date.now(),
      });

      if (!persisted) {
        await markScreenshotFailure(url, "quota_write_failed");
        return false;
      }

      logCapture("success", {
        tabId,
        url,
        bytes: response.data.length,
        chars: dataUrl.length,
      });
      return true;
    } catch (error) {
      // Some pages don't allow debugging or may not be ready yet.
      logCapture("error", {
        tabId,
        url,
        message: error?.message || String(error),
      });
      await markScreenshotFailure(url, error?.message || "debugger");
      return false;
    } finally {
      try {
        await chrome.debugger.detach(target);
        logCapture("detached", { tabId, url });
      } catch {}
      inFlightCaptures.delete(captureKey);
    }
  })();

  inFlightCaptures.set(captureKey, capturePromise);
  return capturePromise;
}

/**
 * captureAllTabs()
 *
 * Captures screenshots of all open web tabs in the background.
 * Called when the Tab Out new tab page opens.
 */
async function captureAllTabs() {
  if (captureAllTabsPromise) return captureAllTabsPromise;

  captureAllTabsPromise = (async () => {
    try {
      const tabs = await chrome.tabs.query({});
      const webTabs = tabs.filter((t) => isCapturableUrl(t.url || ""));
      const screenshots = await getScreenshotCache();
      logCapture("capture-all", {
        totalTabs: tabs.length,
        webTabs: webTabs.length,
        cached: Object.keys(screenshots).length,
      });

      // Process one at a time to avoid overwhelming the browser
      for (const tab of webTabs) {
        if (!tab.id || !tab.url) continue;
        if (tab.active) {
          logCapture("skip-active-tab", {
            tabId: tab.id,
            url: tab.url,
            reason: "capture-all",
          });
          continue;
        }

        const existing = screenshots[tab.url];
        if (!shouldRefreshScreenshot(existing)) {
          logCapture("skip-fresh", { tabId: tab.id, url: tab.url });
          continue;
        }

        await captureTabViaDebugger(tab.id, tab.url);

        // Small delay between captures
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (error) {
      logCapture("capture-all-error", {
        message: error?.message || String(error),
      });
    } finally {
      captureAllTabsPromise = null;
    }
  })();

  return captureAllTabsPromise;
}

async function scheduleCaptureForTab(
  tab,
  { force = false, delayMs = 0, allowActive = false } = {},
) {
  if (!tab?.id || !isCapturableUrl(tab.url || "")) return;

  if (tab.active && !allowActive) {
    logCapture("skip-active-tab", {
      tabId: tab.id,
      url: tab.url,
      force,
    });
    return;
  }

  logCapture("schedule", {
    tabId: tab.id,
    url: tab.url,
    force,
    delayMs,
  });

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  for (const retryDelayMs of CAPTURE_RETRY_DELAYS_MS) {
    let liveTab;
    try {
      liveTab = await chrome.tabs.get(tab.id);
    } catch {
      return;
    }

    if (!isCapturableUrl(liveTab.url || "")) return;

    const screenshots = await getScreenshotCache();
    const entry = screenshots[liveTab.url];
    if (!shouldRefreshScreenshot(entry, force)) {
      logCapture("skip-refresh", {
        tabId: liveTab.id,
        url: liveTab.url,
        force,
        status: entry?.status,
      });
      return;
    }

    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    logCapture("attempt", {
      tabId: liveTab.id,
      url: liveTab.url,
      retryDelayMs,
    });

    const captured = await captureTabViaDebugger(liveTab.id, liveTab.url);
    if (captured) return;
  }

  logCapture("failed-after-retries", {
    tabId: tab.id,
    url: tab.url,
  });
}

async function hydrateLastActiveTabs() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) {
      if (typeof tab.windowId === "number" && typeof tab.id === "number") {
        lastActiveTabByWindow.set(tab.windowId, tab.id);
      }
    }
  } catch {}
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
        Date.now() - (entry?.capturedAt || 0) > MAX_CACHE_AGE_MS ||
        !openUrls.has(url)
      ) {
        delete screenshots[url];
        changed = true;
      }
    }

    const trimmed = trimScreenshotsForQuota(screenshots);
    if (
      changed ||
      Object.keys(trimmed).length !== Object.keys(screenshots).length
    ) {
      await setScreenshotCache(trimmed);
      logCapture("cleanup", {
        remaining: Object.keys(trimmed).length,
        bytes: estimateCacheBytes(trimmed),
      });
    }
  } catch (error) {
    logCapture("cleanup-error", {
      message: error?.message || String(error),
    });
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
chrome.tabs.onCreated.addListener((tab) => {
  updateBadge();
  scheduleCaptureForTab(tab, { delayMs: 600 }).catch(() => {});
});

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

// Update badge and refresh screenshots when tab content changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  updateBadge();

  if (changeInfo.status === "complete") {
    scheduleCaptureForTab(tab, { force: true, delayMs: 300 }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const previousTabId = lastActiveTabByWindow.get(windowId);
  lastActiveTabByWindow.set(windowId, tabId);

  if (!previousTabId || previousTabId === tabId) return;

  try {
    const previousTab = await chrome.tabs.get(previousTabId);
    await scheduleCaptureForTab(previousTab, {
      force: true,
      delayMs: 120,
      allowActive: false,
    });
  } catch (error) {
    logCapture("activate-previous-tab-miss", {
      tabId: previousTabId,
      windowId,
      message: error?.message || String(error),
    });
  }
});

// Respond to explicit capture requests from the new tab page
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "captureAllTabs") {
    captureAllTabs()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "captureTab" && msg.tabId && msg.url) {
    chrome.tabs
      .get(msg.tabId)
      .then((tab) =>
        scheduleCaptureForTab(tab, { force: true, allowActive: false }),
      )
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        logCapture("capture-tab-message-error", {
          tabId: msg.tabId,
          url: msg.url,
          message: error?.message || String(error),
        });
        sendResponse({ ok: false });
      });
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
hydrateLastActiveTabs();
updateBadge();
