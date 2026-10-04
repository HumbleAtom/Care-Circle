// api/action.js
// Vercel serverless function available at /api/action
//
//   POST /api/action   body: { circleId, type, ...details }
//
// type can be:
//   "confirm"  { itemId }                 -> the person on duty confirms an item is done
//   "help"     { itemId }                 -> the person on duty asks the family for help
//   "pickup"   { itemId }                 -> someone else steps in and completes an item
//   "duty"     { personKey }              -> hand over the "on duty" role
//   "urgency"  { itemId, urgency }        -> change how soon we worry ("0", "20" or "60")
//
// Every action saves the change plus a line in the family log,
// then returns the whole updated circle so the screen can refresh itself.

const { UUID_RE, KEY_RE, URGENCIES, HttpError, getDb, fetchCircle } = require("../lib/circle");

const TYPES = ["confirm", "help", "pickup", "duty", "urgency"];

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new HttpError(405, "Method not allowed.");
    }

    const db = getDb();
    if (!db) {
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.");
      throw new HttpError(500, "The server is not configured yet.");
    }

    const body = req.body;
    if (!body || typeof body !== "object") throw new HttpError(400, "Missing request body.");

    const { circleId, type } = body;
    if (typeof circleId !== "string" || !UUID_RE.test(circleId)) {
      throw new HttpError(400, "Invalid circle id.");
    }
    if (!TYPES.includes(type)) throw new HttpError(400, "Unknown action.");

    const circle = await fetchCircle(db, circleId);
    if (!circle) throw new HttpError(404, "Circle not found.");

    const nameOf = (key) => (circle.people.find((p) => p.key === key) || {}).name || "Someone";

    async function addLog(personKey, text) {
      const { error } = await db
        .from("log_entries")
        .insert({ circle_id: circleId, person_key: personKey, text });
      if (error) throw error;
    }

    function findItem() {
      const itemId = body.itemId;
      if (!Number.isInteger(itemId) || itemId < 1) throw new HttpError(400, "Invalid item.");
      const item = circle.items.find((i) => i.id === itemId);
      if (!item) throw new HttpError(404, "Item not found.");
      return item;
    }

    // Updates one item, but only if it's still in one of the allowed states.
    // This stops two people clicking at the same moment from saving twice.
    // Returns true if a row was actually changed.
    async function updateItem(itemId, changes, { onlyStatus, notStatus }) {
      let q = db.from("items").update(changes).eq("id", itemId).eq("circle_id", circleId);
      if (onlyStatus) q = q.eq("status", onlyStatus);
      if (notStatus) q = q.neq("status", notStatus);
      const { data, error } = await q.select("id");
      if (error) throw error;
      return data.length > 0;
    }

    if (type === "confirm") {
      const item = findItem();
      const actor = circle.onDuty;
      const changed = await updateItem(
        item.id,
        { status: "done", done_by_key: actor, done_at: new Date().toISOString(), note: null },
        { notStatus: "done" }
      );
      if (changed) await addLog(actor, `confirmed ${item.title.toLowerCase()}`);
    }

    if (type === "help") {
      const item = findItem();
      const actor = circle.onDuty;
      const changed = await updateItem(
        item.id,
        { status: "attention", note: `${nameOf(actor)} asked for help — texting the family` },
        { onlyStatus: "upcoming" }
      );
      if (changed) await addLog(actor, `asked for help with ${item.title.toLowerCase()}`);
    }

    if (type === "pickup") {
      const item = findItem();
      // Same rule as the prototype: the first person who isn't on duty steps in.
      const helper = (circle.people.find((p) => p.key !== circle.onDuty) || {}).key || circle.onDuty;
      const changed = await updateItem(
        item.id,
        { status: "done", done_by_key: helper, done_at: new Date().toISOString(), note: null },
        { notStatus: "done" }
      );
      if (changed) await addLog(helper, `stepped in and gave ${item.title.toLowerCase()}`);
    }

    if (type === "duty") {
      const newKey = body.personKey;
      if (typeof newKey !== "string" || !KEY_RE.test(newKey) || !circle.people.some((p) => p.key === newKey)) {
        throw new HttpError(400, "That person isn't in this circle.");
      }
      const prevKey = circle.onDuty;
      if (newKey !== prevKey) {
        const { data, error } = await db
          .from("circles")
          .update({ on_duty_key: newKey })
          .eq("id", circleId)
          .eq("on_duty_key", prevKey)
          .select("id");
        if (error) throw error;
        if (data.length > 0) await addLog(newKey, `took over as on duty from ${nameOf(prevKey)}`);
      }
    }

    if (type === "urgency") {
      const item = findItem();
      const urgency = String(body.urgency);
      if (!URGENCIES.includes(urgency)) throw new HttpError(400, "Invalid urgency.");
      await updateItem(item.id, { urgency }, { onlyStatus: "upcoming" });
    }

    const updated = await fetchCircle(db, circleId);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(updated);
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error("api/action error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
