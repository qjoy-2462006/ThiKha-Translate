/**
 * ThiKha Translate — Express API + Vite dev server
 * Features: multi-model, custom glossary, custom font, HITL finalize,
 *           side-by-side preview, auto-cleanup (node-cron)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();
import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { spawn, spawnSync, ChildProcess } from "child_process";
import fs from "fs";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import cron from "node-cron";

const PROGRESS_PREFIX = "@@PROGRESS@@";
const PYTHON_TIMEOUT_MS = 30 * 60 * 1000;
const API_KEY_HEADER = "x-gemini-api-key";

// ---------------------------------------------------------------------------
// Python executable
// ---------------------------------------------------------------------------

interface PythonCmd { exe: string; argsPrefix: string[] }
let pythonResolved: PythonCmd | null = null;

function resolvePythonCmd(): PythonCmd {
  if (pythonResolved) return pythonResolved;
  const raw = process.env.PYTHON_BIN?.trim();
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower.startsWith("py ") || lower === "py") {
      const parts = raw.split(/\s+/);
      const rest = parts.slice(1);
      pythonResolved = { exe: "py", argsPrefix: rest.length ? rest : ["-3"] };
      return pythonResolved;
    }
    if (raw.includes(" ") && (lower.endsWith("python.exe") || lower.endsWith("python3.exe"))) {
      pythonResolved = { exe: raw, argsPrefix: [] };
      return pythonResolved;
    }
    const parts = raw.split(/\s+/);
    pythonResolved = { exe: parts[0]!, argsPrefix: parts.slice(1) };
    return pythonResolved;
  }
  if (process.platform === "win32") {
    const ok = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
    if (ok("python", ["--version"])) { pythonResolved = { exe: "python", argsPrefix: [] }; return pythonResolved; }
    if (ok("py", ["-3", "--version"])) { pythonResolved = { exe: "py", argsPrefix: ["-3"] }; return pythonResolved; }
    pythonResolved = { exe: "python", argsPrefix: [] };
    return pythonResolved;
  }
  pythonResolved = { exe: "python3", argsPrefix: [] };
  return pythonResolved;
}

function pythonDisplayString(): string {
  const { exe, argsPrefix } = resolvePythonCmd();
  return [exe, ...argsPrefix].join(" ");
}

// ---------------------------------------------------------------------------
// Font path
// ---------------------------------------------------------------------------

function resolveFontPath(): string {
  if (process.env.MYANMAR_FONT_PATH?.trim()) return process.env.MYANMAR_FONT_PATH.trim();
  const root = process.cwd();
  const candidates = [path.join(root, "Pyidaungsu.ttf"), path.join(root, "pyidaungsu.ttf")];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return candidates[0]!;
}

// ---------------------------------------------------------------------------
// API key resolver
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
// Job store
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
  inputPath?: string;
  fontPath?: string;
  outputPath?: string;
  metaPath?: string;
  blocksPath?: string;
  summary?: Record<string, unknown>;
  listeners: Set<(payload: object) => void>;
}

const jobs = new Map<string, JobRecord>();

function broadcast(job: JobRecord, payload: object) {
  for (const fn of job.listeners) { try { fn(payload); } catch { /* ignore */ } }
}

function updateJob(job: JobRecord, patch: Partial<JobRecord>) {
  Object.assign(job, patch);
  broadcast(job, {
    status: job.status, step: job.step, done: job.done, total: job.total,
    message: job.message, domain: job.domain, error: job.error, summary: job.summary,
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
    const { exe, argsPrefix } = resolvePythonCmd();
    const proc: ChildProcess = spawn(exe, [...argsPrefix, scriptPath, ...args], { env });

    let stdout = "", stderr = "", stderrBuf = "";
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Timed out — try a smaller page range")); }, PYTHON_TIMEOUT_MS);

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
      if (code !== 0) return reject(new Error(`Command failed (exit ${code}): ${stderr.slice(-500)}`));
      resolve(stdout);
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

function parseProgressLine(line: string): Record<string, unknown> | null {
  const idx = line.indexOf(PROGRESS_PREFIX);
  if (idx === -1) return null;
  try { return JSON.parse(line.slice(idx + PROGRESS_PREFIX.length)) as Record<string, unknown>; }
  catch { return null; }
}

function deleteFile(p: string | undefined) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function normalizeDomain(domain: string): string {
  if (domain === "technical") return "tech";
  return domain;
}

function cleanupJob(job: JobRecord) {
  deleteFile(job.inputPath);
  deleteFile(job.outputPath);
  deleteFile(job.metaPath);
  deleteFile(job.blocksPath);
  if (job.fontPath && job.fontPath !== resolveFontPath()) deleteFile(job.fontPath);
  jobs.delete(job.id);
}

// ---------------------------------------------------------------------------
// Auto-cleanup: delete stale files (>24h) in uploads/ and outputs/
// ---------------------------------------------------------------------------

function scheduleAutoCleanup() {
  cron.schedule("0 * * * *", () => {
    const now = Date.now();
    const MAX_AGE = 24 * 60 * 60 * 1000;
    for (const dir of ["uploads", "outputs"]) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          try {
            const stat = fs.statSync(full);
            if (now - stat.mtimeMs > MAX_AGE) {
              fs.unlinkSync(full);
              console.log(`[cleanup] deleted stale file: ${full}`);
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    // Also prune completed/errored jobs from memory that have no files
    for (const [id, job] of jobs.entries()) {
      if (job.status === "complete" || job.status === "error") {
        const hasFiles = (job.outputPath && fs.existsSync(job.outputPath)) ||
                         (job.inputPath && fs.existsSync(job.inputPath));
        if (!hasFiles) jobs.delete(id);
      }
    }
  });
  console.log("[cleanup] auto-cleanup scheduled (hourly, max-age 24h)");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 5000;

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: "Rate limit exceeded (10 requests per hour)" },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      if (process.env.NODE_ENV !== "production") return true;
      const url = (req.originalUrl ?? req.url ?? "").split("?")[0];
      if (req.method === "GET" && url === "/api/health") return true;
      if (req.method === "GET" && /^\/api\/jobs\/[^/]+\/(progress|meta|download|preview|original|blocks)$/.test(url)) return true;
      if (req.method === "POST" && url === "/api/inspect") return true;
      return false;
    },
  });
  app.use("/api/", limiter);

  fs.mkdirSync("uploads", { recursive: true });
  fs.mkdirSync("outputs", { recursive: true });

  // Single-file upload (for inspect / extract / translate legacy)
  const upload = multer({
    dest: "uploads/",
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "application/pdf") cb(null, true);
      else cb(new Error("Only PDF files are allowed"));
    },
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  // Multi-field upload for /api/jobs (pdf + optional fontFile)
  const uploadJob = multer({
    dest: "uploads/",
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "application/pdf" || file.fieldname === "fontFile") cb(null, true);
      else cb(new Error("Invalid file type"));
    },
    limits: { fileSize: 100 * 1024 * 1024 },
  }).fields([
    { name: "pdf",      maxCount: 1 },
    { name: "fontFile", maxCount: 1 },
  ]);

  const cwd = process.cwd();
  const PYTHON_EXTRACT = path.join(cwd, "pdf_processor.py");
  const PYTHON_TRANSLATE = path.join(cwd, "translate_pdf.py");
  const PYTHON_RENDER = path.join(cwd, "pdf_render.py");
  const FONT_PATH = resolveFontPath();

  if (!fs.existsSync(PYTHON_EXTRACT)) {
    console.error(`[startup] pdf_processor.py not found at ${PYTHON_EXTRACT}`);
  }

  scheduleAutoCleanup();

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      font_exists: fs.existsSync(FONT_PATH),
      font_path: FONT_PATH,
      python: pythonDisplayString(),
      api_key_from_env: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/inspect
  // -------------------------------------------------------------------------
  app.post("/api/inspect", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    const filePath = req.file.path;
    try {
      const stdout = await runPython(PYTHON_EXTRACT, ["--inspect", filePath]);
      res.json(JSON.parse(stdout));
    } catch (err) {
      res.status(500).json({ error: "Inspect failed", details: err instanceof Error ? err.message : String(err) });
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
    if (!apiKey) { deleteFile(req.file.path); return res.status(401).json({ error: "API key required" }); }
    const filePath = req.file.path;
    const translate = req.query.translate === "true";
    const domain = normalizeDomain((req.query.domain as string) || "auto");
    const model = (req.query.model as string) || "gemini-2.0-flash";
    try {
      const stdout = await runPython(PYTHON_EXTRACT, [filePath, domain, String(translate), model], { GEMINI_API_KEY: apiKey });
      res.json(JSON.parse(stdout));
    } catch (err) {
      console.error("[/api/extract]", err);
      res.status(500).json({ error: "Extraction failed", details: err instanceof Error ? err.message : String(err) });
    } finally {
      deleteFile(filePath);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/jobs — async translation + SSE progress
  // -------------------------------------------------------------------------
  app.post("/api/jobs", (req, res, next) => {
    uploadJob(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const pdfFiles = files?.["pdf"];
      const fontFiles = files?.["fontFile"];

      if (!pdfFiles || pdfFiles.length === 0) return res.status(400).json({ error: "No PDF uploaded" });

      const apiKey = resolveApiKey(req);
      if (!apiKey) {
        deleteFile(pdfFiles[0].path);
        if (fontFiles?.[0]) deleteFile(fontFiles[0].path);
        return res.status(401).json({ error: "API key required (set in UI)" });
      }

      // Determine font path
      const customFontPath = fontFiles?.[0]?.path;
      const activeFontPath = customFontPath || FONT_PATH;

      if (!fs.existsSync(activeFontPath)) {
        deleteFile(pdfFiles[0].path);
        if (customFontPath) deleteFile(customFontPath);
        return res.status(500).json({
          error: "Myanmar font not found",
          details: `Copy Pyidaungsu.ttf to project root or upload a custom font. Expected: ${FONT_PATH}`,
        });
      }

      const inputPath = pdfFiles[0].path;
      const domain = normalizeDomain((req.query.domain as string) || "auto");
      const pages = (req.query.pages as string) || "all";
      const model = (req.query.model as string) || "gemini-2.0-flash";
      const glossaryRaw = (req.query.glossary as string) || req.body?.glossary || "";
      const outputName = `translated_${Date.now()}.pdf`;
      const outputPath = path.join("outputs", outputName);

      const job: JobRecord = {
        id: randomUUID(),
        status: "queued",
        step: "queued",
        done: 0,
        total: 100,
        message: "Queued…",
        inputPath,
        fontPath: activeFontPath,
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
              try { const meta = JSON.parse(fs.readFileSync(job.metaPath, "utf-8")); job.summary = meta.summary; }
              catch { /* ignore */ }
            }
          }
        };

        const pythonArgs = [
          "--input",  inputPath,
          "--output", outputPath,
          "--font",   activeFontPath,
          "--domain", domain,
          "--pages",  pages,
          "--model",  model,
        ];
        if (glossaryRaw) pythonArgs.push("--glossary", glossaryRaw);

        try {
          await runPython(PYTHON_TRANSLATE, pythonArgs, { GEMINI_API_KEY: apiKey }, onStderrLine);

          if (!fs.existsSync(outputPath)) throw new Error("Output PDF was not created");

          job.outputPath = outputPath;
          if (!job.metaPath && fs.existsSync(outputPath + ".meta.json")) {
            job.metaPath = outputPath + ".meta.json";
            try { const meta = JSON.parse(fs.readFileSync(job.metaPath, "utf-8")); job.summary = meta.summary; }
            catch { /* ignore */ }
          }

          updateJob(job, { status: "complete", step: "complete", done: job.total || 1, message: "Translation complete" });
          broadcast(job, { event: "complete", jobId: job.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          updateJob(job, { status: "error", step: "error", error: msg, message: msg });
          broadcast(job, { event: "error", error: msg });
          deleteFile(outputPath);
          deleteFile(outputPath + ".meta.json");
          // Keep inputPath in job for finalize on retry
        }
        // NOTE: do NOT delete inputPath here — needed for side-by-side preview + HITL finalize
      })();
    });
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

    const send = (payload: object) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ status: job.status, step: job.step, done: job.done, total: job.total, message: job.message, domain: job.domain, error: job.error });

    if (job.status === "complete" || job.status === "error") {
      send({ event: job.status, error: job.error });
      return res.end();
    }

    const listener = (payload: object) => send(payload);
    job.listeners.add(listener);
    req.on("close", () => job.listeners.delete(listener));
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/meta — block metadata
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
  // GET /api/jobs/:id/blocks — return editable blocks (same as meta.blocks)
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/blocks", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.metaPath || !fs.existsSync(job.metaPath)) {
      return res.status(404).json({ error: "Blocks not available" });
    }
    try {
      const meta = JSON.parse(fs.readFileSync(job.metaPath, "utf-8"));
      res.json({ blocks: meta.blocks || [] });
    } catch {
      res.status(500).json({ error: "Failed to read blocks" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/jobs/:id/finalize — HITL: re-render PDF with edited blocks
  // -------------------------------------------------------------------------
  app.post("/api/jobs/:id/finalize", async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (!job.inputPath || !fs.existsSync(job.inputPath)) {
      return res.status(400).json({ error: "Original PDF no longer available" });
    }

    const { blocks } = req.body as { blocks?: unknown[] };
    if (!blocks || !Array.isArray(blocks)) {
      return res.status(400).json({ error: "blocks array required in body" });
    }

    const fontPath = job.fontPath || FONT_PATH;
    if (!fs.existsSync(fontPath)) {
      return res.status(500).json({ error: "Font not found" });
    }

    // Write edited blocks to temp file
    const blocksPath = path.join("outputs", `blocks_${job.id}.json`);
    const newOutputPath = path.join("outputs", `finalized_${Date.now()}.pdf`);

    try {
      fs.writeFileSync(blocksPath, JSON.stringify(blocks), "utf-8");
      job.blocksPath = blocksPath;

      const stdout = await runPython(PYTHON_RENDER, [
        "--input",  job.inputPath,
        "--output", newOutputPath,
        "--font",   fontPath,
        "--blocks", blocksPath,
      ]);

      const result = JSON.parse(stdout);
      if (!result.ok) throw new Error(result.error || "Render failed");
      if (!fs.existsSync(newOutputPath)) throw new Error("Output PDF not created");

      // Replace output
      if (job.outputPath) deleteFile(job.outputPath);
      job.outputPath = newOutputPath;

      deleteFile(blocksPath);
      job.blocksPath = undefined;

      res.json({ ok: true, overflow_count: result.overflow_count });
    } catch (err) {
      deleteFile(blocksPath);
      deleteFile(newOutputPath);
      res.status(500).json({ error: "Finalize failed", details: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/preview — serve translated PDF (without deleting)
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/preview", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: "Translated PDF not ready" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(job.outputPath).pipe(res);
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/original — serve original PDF (without deleting)
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/original", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.inputPath || !fs.existsSync(job.inputPath)) {
      return res.status(404).json({ error: "Original PDF not available" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    fs.createReadStream(job.inputPath).pipe(res);
  });

  // -------------------------------------------------------------------------
  // GET /api/jobs/:id/download — download + cleanup
  // -------------------------------------------------------------------------
  app.get("/api/jobs/:id/download", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job?.outputPath || !fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: "PDF not ready" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="thikha_translated_${Date.now()}.pdf"`);
    const stream = fs.createReadStream(job.outputPath);
    stream.pipe(res);
    stream.on("close", () => cleanupJob(job));
  });

  // -------------------------------------------------------------------------
  // POST /api/translate — sync download (legacy)
  // -------------------------------------------------------------------------
  app.post("/api/translate", upload.single("pdf"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded" });
    const apiKey = resolveApiKey(req);
    if (!apiKey) { deleteFile(req.file.path); return res.status(401).json({ error: "API key required" }); }

    const inputPath = req.file.path;
    const domain = normalizeDomain((req.query.domain as string) || "auto");
    const pages = (req.query.pages as string) || "all";
    const model = (req.query.model as string) || "gemini-2.0-flash";
    const outputName = `translated_${Date.now()}.pdf`;
    const outputPath = path.join("outputs", outputName);

    if (!fs.existsSync(FONT_PATH)) {
      deleteFile(inputPath);
      return res.status(500).json({ error: "Myanmar font not found", details: `Expected at: ${FONT_PATH}` });
    }

    try {
      await runPython(PYTHON_TRANSLATE, [
        "--input", inputPath, "--output", outputPath, "--font", FONT_PATH,
        "--domain", domain, "--pages", pages, "--model", model,
      ], { GEMINI_API_KEY: apiKey });
      if (!fs.existsSync(outputPath)) throw new Error("translate_pdf.py ran but output PDF was not created");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="thikha_translated_${Date.now()}.pdf"`);
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on("close", () => { deleteFile(inputPath); deleteFile(outputPath); deleteFile(outputPath + ".meta.json"); });
    } catch (err) {
      console.error("[/api/translate]", err);
      deleteFile(inputPath); deleteFile(outputPath);
      res.status(500).json({ error: "Translation failed", details: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Vite / static
  // -------------------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\nThiKha Translate → http://localhost:${PORT}`);
    console.log(`Python    : ${pythonDisplayString()}`);
    console.log(`Font      : ${FONT_PATH} (exists: ${fs.existsSync(FONT_PATH)})`);
    console.log(`API key   : UI header "${API_KEY_HEADER}" or optional GEMINI_API_KEY in .env.local\n`);
  });
}

startServer().catch(console.error);
