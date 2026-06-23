import { Router, Response } from "express";
import { getControlDb, newId } from "../json-db";

const router = Router();

/**
 * GET /api/templates
 * List the authenticated user's custom templates.
 */
router.get("/", async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ error: "Missing user context." });

    const db = await getControlDb();
    const templates = db.collection("user_templates").findMany(
      { user_id: userId },
      { sort: { created_at: -1 } }
    );

    return res.json(
      templates.map((t) => ({
        id: t.id,
        text: t.text,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      }))
    );
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * POST /api/templates
 * Create a new template.
 * Body: { text: string }
 */
router.post("/", async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { text } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing user context." });
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Template text is required." });
    }

    const db = await getControlDb();
    const id = newId();
    db.collection("user_templates").insertOne({
      id,
      user_id: userId,
      text: text.trim(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    return res.json({ success: true, id });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * PUT /api/templates/:id
 * Update a template's text.
 * Body: { text: string }
 */
router.put("/:id", async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { text } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing user context." });
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Template text is required." });
    }

    const db = await getControlDb();
    const tpl = db.collection("user_templates").findOne({ id, user_id: userId });
    if (!tpl) {
      return res.status(404).json({ error: "Template not found or unauthorized." });
    }

    db.collection("user_templates").updateOne(
      { id, user_id: userId },
      { $set: { text: text.trim(), updated_at: new Date().toISOString() } }
    );

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a template.
 */
router.delete("/:id", async (req: any, res: Response) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    if (!userId) return res.status(400).json({ error: "Missing user context." });

    const db = await getControlDb();
    const tpl = db.collection("user_templates").findOne({ id, user_id: userId });
    if (!tpl) {
      return res.status(404).json({ error: "Template not found or unauthorized." });
    }

    db.collection("user_templates").deleteOne({ id, user_id: userId });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
