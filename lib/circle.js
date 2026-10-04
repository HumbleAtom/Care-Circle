// lib/circle.js
// Shared helpers used by api/circle.js and api/action.js.
// (This lives outside the api/ folder on purpose, so Vercel doesn't turn it into its own endpoint.)

const { createClient } = require("@supabase/supabase-js");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9_]{1,40}$/;
const URGENCIES = ["0", "20", "60"];

// An error that carries the HTTP status code to send back to the browser.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Loads a whole circle (people, items, log) in the shape the frontend expects.
// Returns null if the circle doesn't exist.
async function fetchCircle(db, id) {
  const [circleR, peopleR, itemsR, logR] = await Promise.all([
    db.from("circles").select("id, parent_name, on_duty_key").eq("id", id).maybeSingle(),
    db.from("people").select("key, name, initials, color").eq("circle_id", id).order("position"),
    db
      .from("items")
      .select("id, time_label, sort_key, title, urgency, status, note, done_by_key, done_at")
      .eq("circle_id", id)
      .order("sort_key")
      .order("id"),
    db.from("log_entries").select("person_key, text, created_at").eq("circle_id", id).order("id"),
  ]);

  for (const r of [circleR, peopleR, itemsR, logR]) if (r.error) throw r.error;
  if (!circleR.data) return null;

  return {
    id: circleR.data.id,
    parentName: circleR.data.parent_name,
    onDuty: circleR.data.on_duty_key,
    people: peopleR.data,
    items: itemsR.data.map((it) => ({
      id: it.id,
      time: it.time_label,
      sortKey: it.sort_key,
      title: it.title,
      urgency: it.urgency,
      status: it.status,
      note: it.note,
      doneBy: it.done_by_key,
      doneAt: it.done_at,
    })),
    log: logR.data.map((l) => ({ person: l.person_key, text: l.text, createdAt: l.created_at })),
  };
}

module.exports = { UUID_RE, KEY_RE, URGENCIES, HttpError, getDb, fetchCircle };
