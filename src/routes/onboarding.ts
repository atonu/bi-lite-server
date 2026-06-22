import { Router } from "express";
import { getControlDb, newId } from "../json-db";

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

/**
 * POST /api/onboard
 * Public API for external systems to onboard users.
 * Body: { name: string, email: string }
 * Response:
 *   - New user:      { setPasswordUrl: "<FRONTEND_URL>/set-password/<guid>" }
 *   - Existing user: { loginUrl: "<FRONTEND_URL>/signin?email=<encoded>" }
 */
router.post("/", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const db = await getControlDb();
    const usersColl = db.collection("users");

    // Check if user already exists
    const existingUser = usersColl.findOne({ email: normalizedEmail });
    if (existingUser) {
      const loginUrl = `${FRONTEND_URL}/signin?email=${encodeURIComponent(normalizedEmail)}`;
      return res.json({
        existingUser: true,
        loginUrl,
        message: "User already exists. Use the login URL to authenticate.",
      });
    }

    // Check if there's already a pending prospect for this email
    const prospectsColl = db.collection("prospect_users");
    const existingProspect = prospectsColl.findOne({ email: normalizedEmail });

    let prospectId: string;
    if (existingProspect) {
      prospectId = existingProspect.id;
      // Update the name in case it changed
      prospectsColl.updateOne({ id: prospectId }, { $set: { name } });
    } else {
      prospectId = newId();
      prospectsColl.insertOne({
        id: prospectId,
        name,
        email: normalizedEmail,
        created_at: new Date().toISOString(),
      });
    }

    const setPasswordUrl = `${FRONTEND_URL}/set-password/${prospectId}`;
    return res.json({
      existingUser: false,
      setPasswordUrl,
      message: "Prospect user created. Use the set-password URL to complete registration.",
    });
  } catch (err: any) {
    console.error("Onboard Error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/onboard/prospect/:id
 * Returns prospect user info (name + email) for the set-password page.
 * Public — no sensitive data exposed.
 */
router.get("/prospect/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getControlDb();
    const prospect = db.collection("prospect_users").findOne({ id });

    if (!prospect) {
      return res.status(404).json({ error: "Prospect user not found or link has expired." });
    }

    // Don't expose created_at or internal fields
    return res.json({ name: prospect.name, email: prospect.email });
  } catch (err: any) {
    console.error("Prospect lookup error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

export default router;
