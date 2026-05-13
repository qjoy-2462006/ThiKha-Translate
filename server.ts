import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import cors from "cors";

const execPromise = promisify(exec);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Configure Multer for PDF uploads
  const upload = multer({ 
    dest: "uploads/",
    fileFilter: (req, file, cb) => {
      if (file.mimetype === "application/pdf") {
        cb(null, true);
      } else {
        cb(new Error("Only PDF files are allowed"));
      }
    }
  });

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

  // API Route: Extract PDF Data
  app.post("/api/extract", upload.single("pdf"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { translate, domain } = req.query;
    const filePath = req.file.path;
    const pythonScript = path.join(process.cwd(), "pdf_processor.py");
    const apiKey = process.env.GEMINI_API_KEY;

    try {
      // Pass file, api_key, domain, and translate_flag
      // If apiKey is missing, we pass "NONE" so the python script can still handle positional args
      const apiParam = apiKey || "NONE";
      const transParam = translate === "true" ? "true" : "false";
      let command = `python3 ${pythonScript} ${filePath} "${apiParam}" "${domain || "auto"}" "${transParam}"`;

      console.log(`Executing: ${command.replace(apiKey || "NONE", "REDACTED")}`);
      
      const { stdout, stderr } = await execPromise(command);
      
      if (stderr) {
        console.warn("Python Logs:", stderr);
      }
      
      if (!stdout) {
        throw new Error(stderr || "Python script produced no output");
      }

      const result = JSON.parse(stdout);
      res.json(result);
    } catch (error) {
      console.error("Extraction Error:", error);
      res.status(500).json({ 
        error: "Failed to process PDF", 
        details: error instanceof Error ? error.message : String(error) 
      });
    } finally {
      // Clean up uploaded file
      fs.unlink(filePath, (err) => {
        if (err) console.error("Failed to delete temp file:", err);
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
