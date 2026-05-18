/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  FileUp,
  FileText,
  Layout,
  Type,
  Maximize2,
  Info,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  KeyRound,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

const API_KEY_HEADER = "x-gemini-api-key";
const SESSION_KEY = "thikha_gemini_api_key";

interface PDFBlock {
  page_number: number;
  block_index: number;
  bbox: [number, number, number, number];
  text: string;
  myanmar_text?: string | null;
  font_size: number;
  font_name: string;
  block_type: number;
  is_bold: boolean;
  color: number;
}

interface ExtractionResult {
  dimensions: Array<{ page_number: number; width: number; height: number }>;
  blocks: PDFBlock[];
  summary: {
    total_pages: number;
    total_text_blocks: number;
    translated_blocks?: number;
    overflow_count?: number;
    skipped_count?: number;
    domain?: string;
    elapsed_seconds?: number;
  };
}

type Screen = "upload" | "progress" | "result";

interface InspectInfo {
  pages: number;
  size_bytes: number;
}

interface ProgressPayload {
  status?: string;
  step?: string;
  done?: number;
  total?: number;
  message?: string;
  domain?: string;
  error?: string;
  event?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("upload");
  const [apiKey, setApiKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [domain, setDomain] = useState("auto");
  const [pages, setPages] = useState("all");
  const [pdfUrl, setPdfUrl] = useState("");

  const [inspect, setInspect] = useState<InspectInfo | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ step: "", done: 0, total: 100, message: "" });
  const [result, setResult] = useState<ExtractionResult | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const progressDoneRef = useRef(false);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (saved) setApiKey(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const persistApiKey = useCallback((key: string) => {
    try {
      if (key.trim()) sessionStorage.setItem(SESSION_KEY, key.trim());
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const runInspect = useCallback(async (f: File) => {
    setInspectLoading(true);
    setInspectError(null);
    setInspect(null);
    const fd = new FormData();
    fd.append("pdf", f);
    try {
      const res = await fetch(new URL("/api/inspect", window.location.origin), {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || "Inspect failed");
      if (data.error) throw new Error(data.error);
      setInspect({ pages: data.pages, size_bytes: data.size_bytes });
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : "Inspect failed");
    } finally {
      setInspectLoading(false);
    }
  }, []);

  const handleFileChange = (f: File | null) => {
    setFile(f);
    setError(null);
    setInspect(null);
    setInspectError(null);
    if (f) void runInspect(f);
  };

  const tryLoadPdfFromUrl = async () => {
    const url = pdfUrl.trim();
    if (!url) return;
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) {
        throw new Error("Response does not look like a PDF");
      }
      const name = url.split("/").pop()?.split("?")[0] || "document.pdf";
      const f = new File([blob], name.endsWith(".pdf") ? name : `${name}.pdf`, {
        type: "application/pdf",
      });
      handleFileChange(f);
    } catch {
      setError(
        "Could not load PDF from URL (often blocked by CORS). Download the file and upload it instead."
      );
    }
  };

  const loadMeta = async (id: string) => {
    try {
      const res = await fetch(`${window.location.origin}/api/jobs/${id}/meta`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load results");
      setResult({
        dimensions: data.dimensions || [],
        blocks: data.blocks || [],
        summary: data.summary || {
          total_pages: 0,
          total_text_blocks: 0,
        },
      });
      setScreen("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load results");
      setScreen("upload");
    }
  };

  const subscribeProgress = (id: string) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const es = new EventSource(`${window.location.origin}/api/jobs/${id}/progress`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ProgressPayload;
        if (data.event === "error" || data.status === "error") {
          progressDoneRef.current = false;
          setError(data.error || "Translation failed");
          setScreen("upload");
          es.close();
          return;
        }
        if (
          data.event === "complete" ||
          data.status === "complete" ||
          data.step === "complete"
        ) {
          if (progressDoneRef.current) return;
          progressDoneRef.current = true;
          setProgress((p) => ({
            ...p,
            step: "complete",
            done: p.total || 100,
            message: "Translation complete",
          }));
          void loadMeta(id).finally(() => es.close());
          return;
        }
        setProgress({
          step: data.step || "",
          done: data.done ?? 0,
          total: Math.max(1, data.total ?? 100),
          message: data.message || "",
        });
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      es.close();
    };
  };

  const startTranslate = async () => {
    if (!file) return;
    const key = apiKey.trim();
    if (!key) {
      setError("Enter your Gemini API key in the field below.");
      return;
    }
    persistApiKey(key);
    setError(null);
    setDownloadError(null);
    setScreen("progress");
    progressDoneRef.current = false;
    setProgress({ step: "starting", done: 0, total: 100, message: "Starting…" });

    const fd = new FormData();
    fd.append("pdf", file);

    const url = new URL("/api/jobs", window.location.origin);
    url.searchParams.set("domain", domain);
    url.searchParams.set("pages", pages.trim() || "all");

    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { [API_KEY_HEADER]: key },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || "Failed to start job");
      const id = data.jobId as string;
      setJobId(id);
      subscribeProgress(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start translation");
      setScreen("upload");
    }
  };

  const handleDownload = async () => {
    if (!jobId || !file) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(`${window.location.origin}/api/jobs/${jobId}/download`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.details || `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `thikha_${file.name.replace(/\.pdf$/i, "")}_myanmar.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
      setJobId(null);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const resetFlow = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    progressDoneRef.current = false;
    setScreen("upload");
    setFile(null);
    setResult(null);
    setJobId(null);
    setInspect(null);
    setError(null);
    setDownloadError(null);
    setPdfUrl("");
  };

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  const stepLabel = (() => {
    const s = progress.step;
    if (s === "extract") return "Step 1: Extract structure";
    if (s === "detect") return "Step 2: Domain detection";
    if (s === "translate") return "Step 3: Translating blocks";
    if (s === "write") return "Step 4: Building PDF";
    if (s === "verify") return "Step 5: Verifying output";
    if (s === "complete") return "Complete";
    return progress.message || "Working…";
  })();

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans selection:bg-blue-100 selection:text-blue-900">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Layout className="text-white w-5 h-5" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">ThiKha Translate</h1>
          </div>
          {result && screen === "result" && (
            <div className="flex gap-4 text-sm font-medium text-gray-500">
              <div className="flex items-center gap-1">
                <FileText className="w-4 h-4" />
                <span>{result.summary.total_pages} Pages</span>
              </div>
              <div className="flex items-center gap-1">
                <Type className="w-4 h-4" />
                <span>{result.summary.total_text_blocks} Blocks</span>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <AnimatePresence mode="wait">
          {screen === "upload" && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="max-w-xl mx-auto space-y-6"
            >
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f?.type === "application/pdf") handleFileChange(f);
                  else setError("Please drop a PDF file.");
                }}
                className="border-2 border-dashed border-gray-300 rounded-2xl p-10 text-center hover:border-blue-500 hover:bg-blue-50/30 transition-all cursor-pointer group"
              >
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                  <FileUp className="w-8 h-8 text-blue-600" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Upload PDF</h2>
                <p className="text-gray-500 text-sm mb-4">
                  Drag and drop, or click to browse. PDF only, max 100 MB.
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileChange(f);
                  }}
                  accept=".pdf,application/pdf"
                  className="hidden"
                />
                {file && (
                  <div
                    className="mt-4 text-left bg-white p-4 rounded-xl border border-blue-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className="text-green-500 w-5 h-5 shrink-0" />
                        <span className="text-sm font-medium truncate">{file.name}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleFileChange(null)}
                        className="text-xs text-gray-400 hover:text-red-500 font-medium shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                    {inspectLoading && (
                      <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Reading PDF…
                      </p>
                    )}
                    {inspect && !inspectLoading && (
                      <p className="text-xs text-gray-600 mt-2">
                        {inspect.pages} pages · {formatBytes(inspect.size_bytes)}
                      </p>
                    )}
                    {inspectError && (
                      <p className="text-xs text-amber-600 mt-2">{inspectError}</p>
                    )}
                  </div>
                )}
              </div>

              <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  Optional — PDF URL
                </p>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={pdfUrl}
                    onChange={(e) => setPdfUrl(e.target.value)}
                    placeholder="https://…/document.pdf"
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => void tryLoadPdfFromUrl()}
                    className="px-3 py-2 text-sm font-medium bg-gray-100 rounded-lg hover:bg-gray-200"
                  >
                    Load
                  </button>
                </div>
                <p className="text-[11px] text-gray-400">
                  Many sites block cross-origin downloads; uploading a local file is most reliable.
                </p>
              </div>

              <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <KeyRound className="w-4 h-4 text-blue-600" />
                  Gemini API key
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    persistApiKey(e.target.value);
                  }}
                  placeholder="Paste your API key (stored in this browser tab only)"
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[11px] text-gray-500">
                  Sent to your local server only via the{" "}
                  <code className="text-[10px] bg-gray-100 px-1 rounded">{API_KEY_HEADER}</code>{" "}
                  header — not embedded in the page bundle. Optional: set{" "}
                  <code className="text-[10px] bg-gray-100 px-1 rounded">GEMINI_API_KEY</code> in{" "}
                  <code className="text-[10px] bg-gray-100 px-1 rounded">.env.local</code> instead.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">
                      Domain
                    </label>
                    <select
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg p-2.5 outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="auto">Auto-detect</option>
                      <option value="medical">Medical</option>
                      <option value="tech">Technology</option>
                      <option value="academic">Academic</option>
                      <option value="legal">Legal</option>
                      <option value="general">General</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">
                      Page range
                    </label>
                    <input
                      value={pages}
                      onChange={(e) => setPages(e.target.value)}
                      placeholder="all or 1-5"
                      className="w-full text-sm border border-gray-200 rounded-lg p-2.5 outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex gap-3 text-red-700 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <div>
                    <p className="font-semibold">Something went wrong</p>
                    <p className="opacity-90">{error}</p>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => void startTranslate()}
                disabled={!file || !apiKey.trim()}
                className={`w-full py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
                  file && apiKey.trim()
                    ? "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
              >
                Translate PDF
              </button>
            </motion.div>
          )}

          {screen === "progress" && (
            <motion.div
              key="progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="max-w-lg mx-auto py-16"
            >
              <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
                <div className="flex flex-col items-center text-center mb-6">
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
                  <p className="text-lg font-semibold text-gray-900">{stepLabel}</p>
                  <p className="text-sm text-gray-500 mt-1">{progress.message}</p>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300 rounded-full"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-center text-xs text-gray-400 mt-2">{pct}%</p>
                <p className="text-center text-xs text-amber-600 mt-6">
                  Large PDFs can take several minutes. Keep this tab open.
                </p>
              </div>
            </motion.div>
          )}

          {screen === "result" && result && (
            <motion.div
              key="result"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 items-start"
            >
              <div className="lg:col-span-2 space-y-4 order-2 lg:order-1">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
                    <Maximize2 className="w-6 h-6 text-blue-600 shrink-0" />
                    Blocks (review)
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleDownload()}
                      disabled={downloading || !jobId}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                    >
                      {downloading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Download className="w-4 h-4" />
                      )}
                      Download Myanmar PDF
                    </button>
                    <button
                      type="button"
                      onClick={resetFlow}
                      className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Translate new PDF
                    </button>
                  </div>
                </div>
                {downloadError && (
                  <p className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {downloadError}
                  </p>
                )}
                {!jobId && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    Download link expired after a previous download. Run translation again to
                    regenerate the PDF.
                  </p>
                )}

                <div className="space-y-3 sm:space-y-4 max-h-[70vh] overflow-y-auto pr-1 custom-scrollbar">
                  {result.blocks.map((block, i) => {
                    const needsReview = !block.myanmar_text;
                    return (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.02, 0.6) }}
                        key={`${block.page_number}-${block.block_index}`}
                        className={`bg-white border rounded-xl p-4 sm:p-5 transition-shadow ${
                          needsReview
                            ? "border-amber-200 ring-1 ring-amber-100"
                            : "border-gray-200 hover:shadow-md"
                        }`}
                      >
                        <div className="flex items-start justify-between mb-2 gap-2">
                          <div className="flex flex-wrap gap-2">
                            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] uppercase font-bold rounded">
                              Page {block.page_number}
                            </span>
                            <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] uppercase font-bold rounded">
                              Block {block.block_index}
                            </span>
                            {needsReview && (
                              <span className="px-2 py-0.5 bg-amber-50 text-amber-800 text-[10px] uppercase font-bold rounded">
                                Needs review
                              </span>
                            )}
                          </div>
                        </div>
                        <p
                          className={`text-sm leading-relaxed ${block.is_bold ? "font-semibold" : ""}`}
                          style={{
                            color:
                              block.color !== 0
                                ? `#${block.color.toString(16).padStart(6, "0")}`
                                : undefined,
                          }}
                        >
                          {block.text}
                        </p>
                        {block.myanmar_text && (
                          <div className="mt-3 p-3 bg-blue-50/50 rounded-lg border-l-4 border-blue-500">
                            <p className="text-[15px] leading-[1.9] text-blue-950 myanmar-font">
                              {block.myanmar_text}
                            </p>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 border-t border-gray-50 mt-3 pt-3">
                          <span className="flex items-center gap-1">
                            <Info className="w-3 h-3 shrink-0" />
                            {block.font_name}
                          </span>
                          <span className="flex items-center gap-1">
                            <Maximize2 className="w-3 h-3 shrink-0" />
                            {block.font_size}pt
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>

              <aside className="space-y-4 lg:space-y-6 order-1 lg:order-2 lg:sticky lg:top-24">
                <div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm">
                  <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    Summary
                  </h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex justify-between py-2 border-b border-gray-50">
                      <span className="text-gray-500">Pages</span>
                      <span className="font-semibold">{result.summary.total_pages}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-50">
                      <span className="text-gray-500">Blocks</span>
                      <span className="font-semibold">{result.summary.total_text_blocks}</span>
                    </div>
                    {result.summary.translated_blocks != null && (
                      <div className="flex justify-between py-2 border-b border-gray-50 text-blue-600">
                        <span>Translated</span>
                        <span className="font-semibold">{result.summary.translated_blocks}</span>
                      </div>
                    )}
                    {result.summary.overflow_count != null && (
                      <div className="flex justify-between py-2 border-b border-gray-50">
                        <span className="text-gray-500">Overflow</span>
                        <span className="font-semibold">{result.summary.overflow_count}</span>
                      </div>
                    )}
                    {result.summary.domain && (
                      <div className="flex justify-between py-2 border-b border-gray-50">
                        <span className="text-gray-500">Domain</span>
                        <span className="font-semibold capitalize">{result.summary.domain}</span>
                      </div>
                    )}
                    {result.summary.elapsed_seconds != null && (
                      <div className="flex justify-between py-2">
                        <span className="text-gray-500">Time</span>
                        <span className="font-semibold">{result.summary.elapsed_seconds}s</span>
                      </div>
                    )}
                  </div>
                </div>

                {result.dimensions.length > 0 && (
                  <div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm">
                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">
                      Page geometry
                    </h4>
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar text-xs">
                      {result.dimensions.map((dim) => (
                        <div
                          key={dim.page_number}
                          className="bg-gray-50 rounded-lg p-2 border border-gray-100 flex justify-between gap-2"
                        >
                          <span className="text-gray-500 font-medium">Page {dim.page_number}</span>
                          <span className="font-mono text-blue-600 shrink-0">
                            {Math.round(dim.width)}×{Math.round(dim.height)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-2xl p-5 sm:p-6 text-white shadow-xl shadow-blue-100">
                  <h3 className="font-bold mb-2 flex items-center gap-2">
                    <Layout className="w-5 h-5 shrink-0" />
                    Layout preservation
                  </h3>
                  <p className="text-sm text-blue-100 leading-relaxed">
                    Output PDF keeps the original layout; blocks listed here match what was written
                    into the file.
                  </p>
                </div>
              </aside>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
