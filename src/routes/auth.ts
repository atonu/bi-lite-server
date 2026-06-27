import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { getControlDb, newId } from "../json-db";
import { ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY } from "../constants";
import { getFrontendUrl } from "../utils";

const router = Router();

const BACKEND_SECRET = process.env.BACKEND_SECRET || "bi-lite-backend-secret-key-super-secure-87654321";
const REFRESH_SECRET = process.env.REFRESH_SECRET || "bi-lite-refresh-secret-key";

// Setup Nodemailer transporter (for dev we log to console if no credentials)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: parseInt(process.env.SMTP_PORT || "587"),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, prospectId } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Email, password, and name are required." });
    }

    const db = await getControlDb();
    const usersColl = db.collection("users");
    const orgsColl = db.collection("organizations");

    const existingUser = usersColl.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const orgId = newId();
    const userId = newId();

    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const slug = `${baseSlug || "org"}-${Math.random().toString(36).substring(2, 6)}`;

    orgsColl.insertOne({
      id: orgId,
      name: `${name}'s Workspace`,
      slug,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    usersColl.insertOne({
      id: userId,
      email: email.toLowerCase(),
      name,
      hashed_password: hashedPassword,
      role: "MEMBER",
      organization_id: orgId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Clean up prospect user if this was an onboarding flow
    if (prospectId) {
      db.collection("prospect_users").deleteOne({ id: prospectId });
    }

    res.json({ success: true, message: "User registered successfully." });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required." });
    }

    const db = await getControlDb();
    const usersColl = db.collection("users");
    const user = usersColl.findOne({ email: email.toLowerCase() });

    if (!user || !user.hashed_password) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const isValid = await bcrypt.compare(password, user.hashed_password);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    const tokenPayload = {
      id: user.id,
      role: user.role,
      organizationId: user.organization_id,
    };

    const accessToken = jwt.sign(tokenPayload, BACKEND_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = jwt.sign(tokenPayload, REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });

    usersColl.updateOne(
      { id: user.id },
      { $set: { refresh_token: refreshToken } }
    );

    // Set refresh token as http-only cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({
      success: true,
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

router.post("/refresh-token", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ error: "No refresh token provided." });
    }

    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;

    const db = await getControlDb();
    const usersColl = db.collection("users");
    const user = usersColl.findOne({ id: decoded.id, refresh_token: refreshToken });

    if (!user) {
      return res.status(401).json({ error: "Invalid refresh token." });
    }

    const tokenPayload = {
      id: user.id,
      role: user.role,
      organizationId: user.organization_id,
    };

    const accessToken = jwt.sign(tokenPayload, BACKEND_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

    res.json({ success: true, accessToken });
  } catch (error) {
    console.error("Refresh Error:", error);
    res.status(401).json({ error: "Invalid or expired refresh token." });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const db = await getControlDb();
    const usersColl = db.collection("users");
    const user = usersColl.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Don't leak whether user exists or not
      return res.json({ success: true, message: "If the email is registered, a reset link was sent." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    usersColl.updateOne(
      { id: user.id },
      { $set: { reset_token: resetToken, reset_token_expiry: resetTokenExpiry } }
    );

    const resetLink = `${getFrontendUrl(req)}/reset-password?token=${resetToken}`;

    if (process.env.SMTP_USER) {
      await transporter.sendMail({
        from: '"BI-Lite" <noreply@bilite.com>',
        to: user.email,
        subject: "Password Reset Request",
        text: `You requested a password reset. Click this link to reset your password: ${resetLink}`,
      });
    } else {
      console.log(`\n\n[DEV] Forgot Password Link for ${user.email}:\n${resetLink}\n\n`);
    }

    res.json({ success: true, message: "If the email is registered, a reset link was sent." });
  } catch (error) {
    console.error("Forgot Password Error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: "Token and new password are required." });
    }

    const db = await getControlDb();
    const usersColl = db.collection("users");

    const now = new Date().toISOString();
    const user = usersColl.findOne({ reset_token: token });

    if (!user || !user.reset_token_expiry || user.reset_token_expiry <= now) {
      return res.status(400).json({ error: "Invalid or expired reset token." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    usersColl.updateOne(
      { id: user.id },
      {
        $set: { hashed_password: hashedPassword },
        $unset: { reset_token: "", reset_token_expiry: "" },
      }
    );

    res.json({ success: true, message: "Password has been successfully reset." });
  } catch (error) {
    console.error("Reset Password Error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as any;
      const db = await getControlDb();
      db.collection("users").updateOne(
        { id: decoded.id },
        { $unset: { refresh_token: "" } }
      );
    }

    res.clearCookie("refreshToken");
    res.json({ success: true, message: "Logged out." });
  } catch (error) {
    res.clearCookie("refreshToken");
    res.json({ success: true, message: "Logged out." });
  }
});

// Middleware for protected auth routes (using access token)
export const requireAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, BACKEND_SECRET) as any;
    req.user = decoded;
    
    // Normalize user ID to ensure id is always present
    if (req.user && !req.user.id && req.user.userId) {
      req.user.id = req.user.userId;
    }
    
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

router.put("/user", requireAuth, async (req: any, res: any) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Name is required" });
    }

    const db = await getControlDb();
    db.collection("users").updateOne(
      { id: req.user.id },
      { $set: { name: name.trim() } }
    );

    res.json({ success: true, name: name.trim() });
  } catch (error) {
    console.error("Update User Error:", error);
    res.status(500).json({ error: "Internal server error." });
  }
});

export default router;
