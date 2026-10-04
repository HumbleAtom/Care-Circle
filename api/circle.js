// api/circle.js
// Vercel serverless function available at /api/circle
//
//   POST /api/circle          -> saves a new circle from the setup wizard, returns { id }
//   GET  /api/circle?id=UUID  -> loads a saved circle (people, items, log)

const { UUID_RE, KEY_RE, URGENCIES, HttpError, getDb, fetchCircle } = require("../lib/circle");

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TIME_RE = /^(1[0-2]|[1-9]):[0-5][0-9] (AM|PM)$/;

// Returns a trimmed string if it's 1..max characters, otherwise null.
function clean(value, max) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length >= 1 && v.length <= max ? v : null;
}

function parseSetup(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Missing request body.");

  const parentName = clean(body.parentName, 100);
  if (!parentName) throw new HttpError(400, "Please provide the name of the person being cared for.");

  if (!Array.isArray(body.people) || body.people.length < 1 || body.people.length > 20) {
    throw new HttpError(400, "Please provide between 1 and 20 people.");
  }
  const seen = new Set();
  const people = body.people.map((p, i) => {
    const key = p && typeof p.key === "string" ? p.key : "";
    const name = clean(p && p.name, 60);
    const color = p && typeof p.color === "string" ? p.color : "";
    if (!KEY_RE.test(key) || !name || !COLOR_RE.test(color) || seen.has(key)) {
      throw new HttpError(400, "One of the people has invalid details.");
    }
    seen.add(key);
    return { key, name, color, initials: Array.from(name)[0].toUpperCase(), position: i };
  });

  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    throw new HttpError(400, "Please provide between 1 and 50 items.");
  }
  const items = body.items.map((it) => {
    const title = clean(it && it.title, 200);
    const time = it && typeof it.time === "string" ? it.time : "";
    const sortKey = it ? it.sortKey : null;
    const urgency = it ? String(it.urgency) : "";
    if (
      !title ||
      !TIME_RE.test(time) ||
      !Number.isInteger(sortKey) || sortKey < 0 || sortKey > 1439 ||
      !URGENCIES.includes(urgency)
    ) {
      throw new HttpError(400, "One of the items has invalid details.");
    }
    return { title, time, sortKey, urgency };
  });

  if (typeof body.onDuty !== "string" || !seen.has(body.onDuty)) {
    throw new HttpError(400, "The person on duty must be one of the people in the circle.");
  }

  return { parentName, people, items, onDuty: body.onDuty };
}

async function createCircle(req, res, db) {
  const setup = parseSetup(req.body);

  const { data: circle, error: circleError } = await db
    .from("circles")
    .insert({ parent_name: setup.parentName, on_duty_key: setup.onDuty })
    .select("id")
    .single();
  if (circleError) throw circleError;

  try {
    const peopleResult = await db.from("people").insert(
      setup.people.map((p) => ({ circle_id: circle.id, ...p }))
    );
    if (peopleResult.error) throw peopleResult.error;

    const itemsResult = await db.from("items").insert(
      setup.items.map((it) => ({
        circle_id: circle.id,
        time_label: it.time,
        sort_key: it.sortKey,
        title: it.title,
        urgency: it.urgency,
      }))
    );
    if (itemsResult.error) throw itemsResult.error;

    const logResult = await db.from("log_entries").insert({
      circle_id: circle.id,
      person_key: setup.onDuty,
      text: "set up the Care Circle",
    });
    if (logResult.error) throw logResult.error;
  } catch (err) {
    // Don't leave a half-saved circle behind (children are removed by cascade).
    await db.from("circles").delete().eq("id", circle.id);
    throw err;
  }

  return res.status(201).json({ id: circle.id });
}

async function loadCircle(req, res, db) {
  const id = req.query && req.query.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    throw new HttpError(400, "Invalid circle id.");
  }
  const circle = await fetchCircle(db, id);
  if (!circle) throw new HttpError(404, "Circle not found.");

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(circle);
}

module.exports = async function handler(req, res) {
  try {
    const db = getDb();
    if (!db) {
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.");
      return res.status(500).json({ error: "The server is not configured yet." });
    }

    if (req.method === "POST") return await createCircle(req, res, db);
    if (req.method === "GET") return await loadCircle(req, res, db);

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("api/circle error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
