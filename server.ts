/**
 * ThiKha Translate — Express API + Vite dev server (localhost)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();
import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";

const PROGRESS_PREFIX = "@@PROGRESS@@";
const PYTHON_TIMEOUT_MS = 30 * 60 * 1000;
const API_KEY_HEADER = "x-gemini-api-key";

// ---------------------------------------------------------------------------
// Python executable (Windows: python, Unix: python3)
// ---------------------------------------------------------------------------

function getPythonBin(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  return process.platform === "win32" ? "python" : "python3";
}

// ---------------------------------------------------------------------------
// API key: UI header → optional server .env fallback (local dev)
// ---------------------------------------------------------------------------

function resolveApiKey(req: Request): string | null {
  const header = req.headers[API_KEY_HEADER];
  if (typeof header === "string" && header.trim()) return header.trim();
  const bodyKey = req.body?.apiKey;
  if (typeof bodyKey === "string" && bodyKey.trim()) return bodyKey.trim();
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey?.trim()) return envKey.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Job store (in-memory — localhost; progress lost on restart)
// ---------------------------------------------------------------------------

type JobStatus = "queued" | "running" | "complete" | "error";

interface JobRecord {
  id: string;
  status: JobStatus;
  step: string;
  done: number;
  total: number;
  message: string;
  domain?: string;
  error?: string;
  outputPath?: string;
  metaPath?: string;
  summary?: Record<string, unknown>;
  listeners: Set<(payload: object) => void>;
}

const jobs = new Map<string, JobRecord>();

function broadcast(job: JobRecord, payload: object) {
  for (const fn of job.listeners) {
    try {
      fn(payload);
    } catch {
      /* ignore */
    }
  }
}

function updateJob(job: JobRecord, patch: Partial<JobRecord>) {
  Object.assign(job, patch);
  broadcast(job, {
    status: job.status,
    step: job.step,
    done: job.done,
    total: job.total,
    message: job.message,
    domain: job.domain,
    error: job.error,
    summary: job.summary,
  });
}

// ---------------------------------------------------------------------------
// Python runner
// ---------------------------------------------------------------------------

function runPython(
  scriptPath: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  onStderrLine?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const proc: ChildProcess = spawn(getPythonBin(), [scriptPath, ...args], { env });

    let stdout = "";
    let stderr = "";
    let stderrBuf = "";

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Timed out — try a smaller page range"));
    }, PYTHON_TIMEOUT_MS);

    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (onStderrLine) {
        stderrBuf += chunk;
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) onStderrLine(line);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stderrBuf && onStderrLine) onStderrLine(stderrBuf);
      if (stderr) console.warn("[python stderr]", stderr.slice(-2000));
      if (code !== 0) {
        return reject(new Error(`Command failed (exit ${code}): ${stderr.slice(-500)}`));
      }
      resolve(stdout);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseProgressLine(line: string): Record<string, unknown> | null {
  const idx = line.indexOf(PROGRESS_PREFIX);
  if (idx === -1) return null;
  try {
    return JSON.parse(line.slice(idx + PROGRESS_PREFIX.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deleteFile(p: string) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function normalizeDomain(domain: string): string {
  if (domain === "technical") return "tech";
  return domain;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: "Rate limit exceeded (10 requests per hour)" },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      if (req.method === "GET" && req.path === "/api/health") return true;
      if (req.method === "GET" && /^\/api\/jobs\/[^/]+\/(progress|meta|download)$/.test(req.path))
        return true;
      if (req.method === "POST" && req.path === "/api/inspect") return true;
      return false;
    },
  });
  app.use("/api/", limiter);

  fs.mkdirSync("uploads", { recursive: true });
  fs.mkdirSync("outputs", { recursive: true });

  const upload = multer({
    dest: "uploads/",
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "application/pdf") cb(null, true);
      else cb(new Error("Only PDF files are allowed"));
    },
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  const PYTHON_EXTRACT = path.join(process.cwd(), "pdf_processor.py");
  const PYTHON_TRANSLATE = path.join(process.cwd(), "translate_pdf.py");
  const FONT_PATH =
    process.env.MYANMAR_FONT_PATH ?? path.join(process.cwd(), "Pyidaungsu.ttf");

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      font_exists: fs.existsSync(FONT_PATH),
      font_path: FONT_PATH,
      python: getPythonBin(),
      api_key_from_env: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/inspect — page count (no API key)
  // -------------------------------------------------------------------------
  app.post("/api/inspect", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    const filePath = req.file.path;
    try {
      const stdout = await runPython(PYTHON_EXTRACT, ["--inspect", filePath]);
      res.json(JSON.parse(stdout));
    } catch (err) {
      res.status(500).json({
        error: "Inspect failed",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      deleteFile(filePath);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/extract
  // -------------------------------------------------------------------------
  app.post("/api/extract", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      deleteFile(req.file.path);
      return res.status(401).json({ error: "Gemini API key required (set in UI or server env)" });
    }

    const filePath = req.file.path;
    const translate = req.query.translate === "true";
    const domain = normalizeDomain((req.query.domain as string) || "auto");

    try {
      const stdout = await runPython(
        PYTHON_EXTRACT,
        [filePath, domain, String(translate)],
        { GEMINI_API_KEY: apiKey }
      );
      res.json(JSON.parse(stdout));
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

  // -------------------------------------------------------------------------
  // POST /api/jobs — async translation + SSE progress
  // -------------------------------------------------------------------------
  app.post("/api/jobs", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      deleteFile(req.file.path);
      return res.status(401).json({ error: "Gemini API key required (set in UI)" });
    }

    if (!fs.existsSync(FONT_PATH)) {
      deleteFile(req.file.path);
      return res.status(500).json({
        error: "Myanmar font not found",
        details: `Copy Pyidaungsu.ttf to project root or set MYANMAR_FONT_PATH. Expected: ${FONT_PATH}`,
      });
    }

    const inputPath = req.file.path;
    const domain = normalizeDomain((req.query.domain as string) || "auto");
    const pages = (req.query.pages as string) || "all";
    const outputName = `translated_${Date.now()}.pdf`;
    const outputPath = path.join("outputs", outputName);

    const job: JobRecord = {
      id: randomUUID(),
      status: "queued",
      step: "queued",
      done: 0,
      total: 100,
      message: "Queued…",
      listeners: new Set(),
    };
    jobs.set(job.id, job);
    res.json({ jobId: job.id });

    (async () => {
      updateJob(job, { status: "running", step: "starting", message: "Starting translation…" });

      const onStderrLine = (line: string) => {
        const prog = parseProgressLine(line);
        if (!prog) return;
        const step = String(prog.step ?? job.step);
        const done = Number(prog.done ?? job.done);
        const total = Number(prog.total ?? job.total) || 1;
        const message = String(prog.message ?? job.message);
        const patch: Partial<JobRecord> = { step, done, total, message };
        if (prog.domain) patch.domain = String(prog.domain);
        updateJob(job, patch);

        if (step === "complete") {
          job.outputPath = String(prog.output_path ?? outputPath);
          job.metaPath = String(prog.meta_path ?? outputPath + ".meta.json");
          if (fs.existsSync(job.metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(job.metaPath, "utf-8"));
              job.summary = meta.summary;
            } catch {
              /* ignore */
            }
          }
        }
      };

      try {
        await runPython(
          PYTHON_TRANSLATE,
          [
            "--input",
            inputPath,
            "--output",
            outputPath,
            "--font",
            FONT_PATH,
            "--domain",
            domain,
            "--pages",
            pages,
          ],
          { GEMINI_API_KEY: apiKey },
          onStderrLine
        );

        if (!fs.existsSync(outputPath)) {
          throw new Error("Output PDF was not created");
        }

        job.outputPath = outputPath;
        if (!job.metaPath && fs.existsSync(outputPath + ".meta.json")) {
          job.metaPath = outputPath + ".meta.json";
          try {
            const meta = JSON.parse(fs.readFileSync(job.metaPath, "utf-8"));
            job.summary = meta.summary;
          } catch {
            /* ignore */
          }
        }

        updateJob(job, {
          status: "complete",
          step: "complete",
          done: job.total || 1,
          message: "Translation complete",
        });
        broadcast(job, { event: "complete", jobId: job.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updateJob(job, { status: "error", step: "error", error: msg, message: msg });
        broadcast(job, { event: "error", error: msg });
        deleteFile(outputPath);
        deleteFile(outputPath + ".meta.json");
      } finally {
        deleteFile(inputPath);
      }
    })();
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/progress — SSE
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/progress", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({
      status: job.status,
      step: job.step,
      done: job.done,
      total: job.total,
      message: job.message,
      domain: job.domain,
      error: job.error,
    });

    if (job.status === "complete" || job.status === "error") {
      send({ event: job.status, error: job.error });
      return res.end();
    }

    const listener = (payload: object) => send(payload);
    job.listeners.add(listener);

    req.on("close", () => {
      job.listeners.delete(listener);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/meta — block list for result screen
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/meta", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.metaPath || !fs.existsSync(job.metaPath)) {
      return res.status(404).json({ error: "Metadata not available yet" });
    }
    res.type("json").send(fs.readFileSync(job.metaPath, "utf-8"));
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/download
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/download", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: "PDF not ready" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="thikha_translated_${Date.now()}.pdf"`
    );
    const stream = fs.createReadStream(job.outputPath);
    stream.pipe(res);
    stream.on("close", () => {
      deleteFile(job.outputPath!);
      if (job.metaPath) deleteFile(job.metaPath);
      jobs.delete(job.id);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/translate — sync download (legacy)
  // -------------------------------------------------------------------------
  app.post("/api/translate", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });

    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      deleteFile(req.file.path);
      return res.status(401).json({ error: "Gemini API key required (set in UI)" });
    }

    const inputPath = req.file.path;
    const domain = normalizeDomain((req.query.domain as string) || "auto");
    const pages = (req.query.pages as string) || "all";
    const outputName = `translated_${Date.now()}.pdf`;
    const outputPath = path.join("outputs", outputName);

    if (!fs.existsSync(FONT_PATH)) {
      deleteFile(inputPath);
      return res.status(500).json({
        error: "Myanmar font not found on server",
        details: `Expected at: ${FONT_PATH}`,
      });
    }

    try {
      await runPython(
        PYTHON_TRANSLATE,
        [
          "--input",
          inputPath,
          "--output",
          outputPath,
          "--font",
          FONT_PATH,
          "--domain",
          domain,
          "--pages",
          pages,
        ],
        { GEMINI_API_KEY: apiKey }
      );

      if (!fs.existsSync(outputPath)) {
        throw new Error("translate_pdf.py ran but output PDF was not created");
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="thikha_translated_${Date.now()}.pdf"`
      );
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("close", () => {
        deleteFile(inputPath);
        deleteFile(outputPath);
        deleteFile(outputPath + ".meta.json");
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

  // -------------------------------------------------------------------------
  // Vite / static
  // -------------------------------------------------------------------------
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
    console.log(`\nThiKha Translate → http://localhost:${PORT}`);
    console.log(`Python    : ${getPythonBin()}`);
    console.log(`Font      : ${FONT_PATH} (exists: ${fs.existsSync(FONT_PATH)})`);
    console.log(
      `API key   : UI header "${API_KEY_HEADER}" or optional GEMINI_API_KEY in .env.local\n`
    );
  });
}

startServer().catch(console.error);
