import { Router, Response, Request } from "express";
import multer from "multer";
import { parse as csvParse } from "csv-parse/sync";
import path from "path";
import fs from "fs";
import { DATA_DIR, newId } from "../json-db";

const router = Router();

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  try {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  } catch (err) {
    console.warn(`Warning: Could not create uploads directory at ${UPLOADS_DIR}:`, err);
  }
}

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req, file, cb) => {
    const allowed = [".csv", ".json"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv and .json files are allowed"));
    }
  },
});

/**
 * POST /api/upload/data
 * Upload a CSV or JSON file. Returns uploadId, columns, rowCount, and sample rows.
 */
router.post("/data", upload.single("file"), async (req: any, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded." });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileContent = req.file.buffer.toString("utf-8");

    let rows: any[] = [];
    let columns: string[] = [];

    if (ext === ".csv") {
      const parsed = csvParse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        cast: true,
      });
      rows = parsed as any[];
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    } else if (ext === ".json") {
      const parsed = JSON.parse(fileContent);
      if (Array.isArray(parsed)) {
        rows = parsed;
      } else if (typeof parsed === "object" && parsed !== null) {
        // Try to find an array value in the object
        const arrayVal = Object.values(parsed).find((v) => Array.isArray(v));
        rows = arrayVal ? (arrayVal as any[]) : [parsed];
      }
      columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    }

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: "File contains no data rows." });
    }

    // Save full dataset to uploads directory
    const uploadId = newId();
    const uploadFile = path.join(UPLOADS_DIR, `${uploadId}.json`);
    fs.writeFileSync(
      uploadFile,
      JSON.stringify({ uploadId, fileName: req.file.originalname, columns, rows }, null, 2),
      "utf-8"
    );

    return res.json({
      success: true,
      uploadId,
      fileName: req.file.originalname,
      columns,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 10),
    });
  } catch (err: any) {
    console.error("Upload Error:", err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

/**
 * GET /api/upload/:uploadId
 * Retrieve upload data by ID (for AI analysis).
 */
router.get("/:uploadId", async (req: any, res: Response) => {
  try {
    const { uploadId } = req.params;
    const uploadFile = path.join(UPLOADS_DIR, `${uploadId}.json`);

    if (!fs.existsSync(uploadFile)) {
      return res.status(404).json({ success: false, error: "Upload not found." });
    }

    const data = JSON.parse(fs.readFileSync(uploadFile, "utf-8"));
    return res.json({ success: true, ...data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

export default router;
