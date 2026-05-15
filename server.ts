/**
 * ThiKha Translate — Express server
 *
 * Fixes applied:
 *   [FIX #5] GEMINI_API_KEY passed via process env, not CLI arg (security)
 *   [FIX #6] /api/translate endpoint added — runs translate_pdf.py and
 *            returns the completed Myanmar PDF as a file download
 *   [FIX #7] Font path validated before spawning Python
 *   [FIX #8] Temp files cleaned up reliably in finally blocks
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { spawn } from "child_process";
import fs from "fs";
import cors from "cors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a Python script and capture stdout/stderr.
 *  [FIX #5] API key is injected via env, not as a CLI argument. */
function runPython(
  scriptPath: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const proc = spawn("python3", [scriptPath, ...args], { env });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      if (stderr) console.warn("[python stderr]", stderr.slice(-2000));
      if (code !== 0) {
        return reject(new Error(`Command failed (exit ${code}): ${stderr.slice(-500)}`));
      }
      resolve(stdout);
    });

    proc.on("error", reject);
  });
}

function deleteFile(p: string) {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Multer — accept only PDFs, store in uploads/
  fs.mkdirSync("uploads", { recursive: true });
  fs.mkdirSync("outputs", { recursive: true });

  const upload = multer({
    dest: "uploads/",
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "application/pdf") {
        cb(null, true);
      } else {
        cb(new Error("Only PDF files are allowed"));
      }
    },
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB cap
  });

  const PYTHON_EXTRACT   = path.join(process.cwd(), "pdf_processor.py");
  const PYTHON_TRANSLATE = path.join(process.cwd(), "translate_pdf.py");

  // [FIX #7] Font path — configurable via env or fallback to project root
  const FONT_PATH = process.env.MYANMAR_FONT_PATH
    ?? path.join(process.cwd(), "Pyidaungsu.ttf");

  // ---------------------------------------------------------------------------
  // GET /api/health
  // ---------------------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      font_exists: fs.existsSync(FONT_PATH),
      font_path: FONT_PATH,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/extract
  // Extract text blocks (with optional translation) → JSON response
  // ---------------------------------------------------------------------------
  app.post("/api/extract", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const filePath = req.file.path;
    const translate = req.query.translate === "true";
    const domain    = (req.query.domain as string) || "auto";

    // [FIX #5] API key from env only — never from client or CLI arg
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      deleteFile(filePath);
      return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
    }

    try {
      const stdout = await runPython(
        PYTHON_EXTRACT,
        [
          filePath,
          domain,
          String(translate),
          // No API key in args — passed via env below
        ],
        { GEMINI_API_KEY: apiKey }          // [FIX #5] env injection
      );

      const result = JSON.parse(stdout);
      res.json(result);
    } catch (err) {
      console.error("[/api/extract]", err);
      res.status(500).json({
        error: "Extraction failed",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      deleteFile(filePath);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/translate
  // [FIX #6] NEW endpoint — full pipeline → returns translated PDF download
  // ---------------------------------------------------------------------------
  app.post("/api/translate", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const inputPath  = req.file.path;
    const domain     = (req.query.domain as string) || "auto";
    const pages      = (req.query.pages  as string) || "all";
    const outputName = `translated_${Date.now()}.pdf`;
    const outputPath = path.join("outputs", outputName);

    // [FIX #5] API key from server env only
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      deleteFile(inputPath);
      return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
    }

    // [FIX #7] Validate font before starting expensive translation
    if (!fs.existsSync(FONT_PATH)) {
      deleteFile(inputPath);
      return res.status(500).json({
        error: "Myanmar font not found on server",
        details: `Expected at: ${FONT_PATH}. Set MYANMAR_FONT_PATH env var or copy Pyidaungsu.ttf to project root.`,
      });
    }

    try {
      // Run full translate_pdf.py pipeline
      await runPython(
        PYTHON_TRANSLATE,
        [
          "--input",  inputPath,
          "--output", outputPath,
          "--font",   FONT_PATH,
          "--domain", domain,
          "--pages",  pages,
          // No --api-key arg — key comes via env [FIX #5]
        ],
        { GEMINI_API_KEY: apiKey }          // [FIX #5] env injection
      );

      if (!fs.existsSync(outputPath)) {
        throw new Error("translate_pdf.py ran but output PDF was not created");
      }

      // Stream the completed PDF back to the client
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="thikha_translated_${Date.now()}.pdf"`
      );
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      stream.on("close", () => {
        // Clean up temp files after streaming
        deleteFile(inputPath);
        deleteFile(outputPath);
      });

    } catch (err) {
      console.error("[/api/translate]", err);
      deleteFile(inputPath);
      deleteFile(outputPath);
      res.status(500).json({
        error: "Translation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Vite dev middleware / static production build
  // ---------------------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\nThiKha Translate server running → http://localhost:${PORT}`);
    console.log(`Font path : ${FONT_PATH} (exists: ${fs.existsSync(FONT_PATH)})`);
    console.log(`API key   : ${process.env.GEMINI_API_KEY ? "SET" : "MISSING ⚠"}\n`);
  });
}

startServer().catch(console.error);
