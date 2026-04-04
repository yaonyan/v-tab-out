// server/routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Express API routes for Mission Control.
//
// Think of this file as the "front desk" of the app's backend. The browser
// sends requests here, and these routes figure out what data to fetch or what
// action to take, then send back a JSON response.
//
// Every endpoint path starts with /api/, so:
//   - The browser asks  →  GET /api/missions
//   - This file handles →  router.get('/missions', ...)
//   - The main server (index.js) mounts this router at /api
//
// All "prepared statements" from db.js follow the better-sqlite3 pattern:
//   - .all()    → returns an array of rows (for SELECT queries)
//   - .run()    → executes a write (INSERT / UPDATE / DELETE)
//   - .get()    → returns a single row or undefined
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

// Pull in the database prepared statements we need
const {
  getMissions,
  getMissionUrls,
  dismissMission,
  archiveMission,
  getMeta,
  db,
} = require('./db');

// Pull in the AI clustering function that reads Chrome history and creates missions
const { analyzeBrowsingHistory } = require('./clustering');

// An Express Router is like a mini-app: it holds a group of related routes.
// We export it and mount it on the main Express app in index.js.
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Refresh lock
//
// analyzeBrowsingHistory() can take 5-30 seconds (it calls an AI API).
// If the user clicks "Refresh" twice quickly, we don't want two simultaneous
// AI calls running at once — that would waste money and could corrupt the DB.
//
// This flag works like a "busy" sign on a bathroom door. If it's already
// flipped to true, new refresh requests get a 429 (Too Many Requests) response.
// ─────────────────────────────────────────────────────────────────────────────
let isRefreshing = false;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/missions
//
// Returns all non-dismissed missions, each with their URLs attached.
//
// The database stores missions and URLs in separate tables (a "one-to-many"
// relationship). This endpoint joins them together in JavaScript — we first
// fetch all missions, then for each mission, fetch its URLs and attach them
// as a `urls` property on the mission object.
//
// Response shape:
//   [
//     {
//       id: "abc123",
//       name: "Planning Tokyo Trip",
//       summary: "...",
//       status: "active",
//       last_activity: "2024-01-15T10:00:00Z",
//       urls: [
//         { id: 1, mission_id: "abc123", url: "https://...", title: "...", visit_count: 3 },
//         ...
//       ]
//     },
//     ...
//   ]
// ─────────────────────────────────────────────────────────────────────────────
router.get('/missions', (req, res) => {
  try {
    // Fetch all non-dismissed missions (ordered by status priority, then recency)
    const missions = getMissions.all();

    // For each mission, fetch its associated URLs and attach them
    const missionsWithUrls = missions.map(mission => ({
      ...mission,                                    // spread all mission fields
      urls: getMissionUrls.all({ id: mission.id }),  // attach urls array
    }));

    res.json(missionsWithUrls);
  } catch (err) {
    console.error('[routes] GET /missions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch missions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/refresh
//
// Triggers a fresh analysis of the user's Chrome browsing history.
// This calls DeepSeek AI and can take several seconds.
//
// Concurrency protection: if a refresh is already running (isRefreshing = true),
// we return HTTP 429 (Too Many Requests) immediately.
//
// Response: { success: true, count: <number of missions created> }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/refresh', async (req, res) => {
  // ── Concurrency guard ──────────────────────────────────────────────────────
  if (isRefreshing) {
    return res.status(429).json({
      error: 'A refresh is already in progress. Please wait.',
    });
  }

  // Flip the busy flag on before doing any async work
  isRefreshing = true;

  try {
    // Run the full analysis pipeline:
    //   1. Read Chrome history
    //   2. Filter + deduplicate URLs
    //   3. Call DeepSeek AI to cluster into missions
    //   4. Save missions + URLs to the SQLite database
    // Returns the array of mission objects that were saved
    const missions = await analyzeBrowsingHistory();

    res.json({ success: true, count: missions.length });
  } catch (err) {
    console.error('[routes] POST /missions/refresh failed:', err.message);
    res.status(500).json({ error: 'Refresh failed: ' + err.message });
  } finally {
    // Always flip the busy flag back off, even if an error occurred.
    // Without `finally`, a crash would leave isRefreshing = true forever,
    // blocking all future refreshes until the server restarts.
    isRefreshing = false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/dismiss
//
// Soft-deletes a mission by marking it dismissed = 1 in the database.
// The mission data is kept (for history) but it won't appear in the main list.
//
// :id is a URL parameter — e.g. POST /api/missions/abc123/dismiss
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/dismiss', (req, res) => {
  try {
    const { id } = req.params; // extract the mission ID from the URL

    // Run the UPDATE query: sets dismissed = 1 for this mission id
    dismissMission.run({ id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/dismiss failed:', err.message);
    res.status(500).json({ error: 'Failed to dismiss mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/archive
//
// Saves a snapshot of the mission into the archives table, then dismisses it.
// Archiving is "dismiss + save a record". It's useful for reviewing what you
// worked on in the past — the archive keeps the name and URLs even after dismiss.
//
// Steps:
//   1. Find the mission by id (return 404 if not found)
//   2. Fetch its associated URLs
//   3. Insert a row into the archives table (mission + urls as JSON)
//   4. Dismiss the mission (soft-delete it from the active list)
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/archive', (req, res) => {
  try {
    const { id } = req.params;

    // ── Step 1: Find the mission ───────────────────────────────────────────────
    // db.prepare().get() returns a single row object or undefined.
    // We need to check if the mission actually exists before archiving it.
    const mission = db
      .prepare('SELECT * FROM missions WHERE id = ? AND dismissed = 0')
      .get(id);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found or already dismissed' });
    }

    // ── Step 2: Fetch the mission's URLs ───────────────────────────────────────
    const urls = getMissionUrls.all({ id: mission.id });

    // ── Step 3: Insert into archives ───────────────────────────────────────────
    // We store the URLs as a JSON string (urls_json) because the archives table
    // only needs to display them as a list — we don't need to query individual
    // archived URLs. Storing as JSON keeps the archives table simple.
    archiveMission.run({
      mission_id:   mission.id,
      mission_name: mission.name,
      urls_json:    JSON.stringify(urls),      // array of URL objects → JSON string
      archived_at:  new Date().toISOString(),  // ISO timestamp of when archived
    });

    // ── Step 4: Dismiss the mission ────────────────────────────────────────────
    // This soft-deletes it from the active list (dismissed = 1).
    // We do this after archiving so we don't lose data if the archive insert fails.
    dismissMission.run({ id: mission.id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/archive failed:', err.message);
    res.status(500).json({ error: 'Failed to archive mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stats
//
// Returns summary statistics about the current state of missions.
// Used by the dashboard header to show things like "14 missions, 3 abandoned".
//
// Response:
//   {
//     totalMissions:    14,   // non-dismissed missions
//     totalUrls:        87,   // total URLs across all active missions
//     abandonedMissions: 3,   // missions with status = 'abandoned'
//     lastAnalysis:     "2024-01-15T10:30:00Z"  // ISO timestamp (or null)
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    // Count total non-dismissed missions
    // .get() returns a single row — here it's { count: 14 }
    const { count: totalMissions } = db
      .prepare('SELECT COUNT(*) as count FROM missions WHERE dismissed = 0')
      .get();

    // Count total URLs across all active (non-dismissed) missions
    // We join mission_urls to missions to only count URLs from active missions
    const { count: totalUrls } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   mission_urls mu
        JOIN   missions m ON mu.mission_id = m.id
        WHERE  m.dismissed = 0
      `)
      .get();

    // Count missions with status = 'abandoned' (non-dismissed only)
    const { count: abandonedMissions } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   missions
        WHERE  dismissed = 0
          AND  status    = 'abandoned'
      `)
      .get();

    // Get last_analysis timestamp from the meta key-value store
    // getMeta.get() returns { value: "2024-01-15T..." } or undefined if never run
    const metaRow = getMeta.get({ key: 'last_analysis' });
    const lastAnalysis = metaRow ? metaRow.value : null;

    res.json({
      totalMissions,
      totalUrls,
      abandonedMissions,
      lastAnalysis,
    });
  } catch (err) {
    console.error('[routes] GET /stats failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
//
// The main Express app (index.js) does:
//   const routes = require('./routes');
//   app.use('/api', routes);
//
// That mounts all of our router.get('/missions') etc. at /api/missions.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
