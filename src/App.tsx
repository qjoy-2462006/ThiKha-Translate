/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  FileUp, FileText, Layout, Type, Maximize2, Info, Loader2,
  CheckCircle2, AlertCircle, Download, KeyRound, Plus, Trash2,
  BookOpen, ChevronDown, ChevronUp, Upload, Pencil, Eye,
  SplitSquareHorizontal, ArrowLeft, ArrowRight, Lock,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

const API_KEY_HEADER = "x-gemini-api-key";
const CRYPTO_KEY_SESSION = "thikha_enc_key";
const CRYPTO_DATA_LOCAL  = "thikha_enc_data_v2";

const AI_MODELS = [
  { value: "gemini-2.0-flash",          label: "Gemini 2.0 Flash",    provider: "Google",    keyLink: "https://aistudio.google.com/apikey" },
  { value: "gemini-1.5-pro",            label: "Gemini 1.5 Pro",      provider: "Google",    keyLink: "https://aistudio.google.com/apikey" },
  { value: "gpt-4o-mini",               label: "GPT-4o mini",         provider: "OpenAI",    keyLink: "https://platform.openai.com/api-keys" },
  { value: "gpt-4o",                    label: "GPT-4o",              provider: "OpenAI",    keyLink: "https://platform.openai.com/api-keys" },
  { value: "claude-3-haiku-20240307",   label: "Claude 3 Haiku",      provider: "Anthropic", keyLink: "https://console.anthropic.com/settings/keys" },
  { value: "claude-3-5-sonnet-20241022",label: "Claude 3.5 Sonnet",   provider: "Anthropic", keyLink: "https://console.anthropic.com/settings/keys" },
];

// ---------------------------------------------------------------------------
// Web Crypto — AES-GCM encrypted API key storage
// enc key lives in sessionStorage (tab-lifetime); ciphertext in localStorage
// ---------------------------------------------------------------------------

async function _getOrCreateEncKey(): Promise<CryptoKey | null> {
  try {
    const stored = sessionStorage.getItem(CRYPTO_KEY_SESSION);
    if (stored) {
      const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
      return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    sessionStorage.setItem(CRYPTO_KEY_SESSION, btoa(String.fromCharCode(...raw)));
    return key;
  } catch { return null; }
}

async function encryptApiKey(value: string): Promise<void> {
  try {
    if (!value.trim()) { localStorage.removeItem(CRYPTO_DATA_LOCAL); return; }
    const key = await _getOrCreateEncKey();
    if (!key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    const payload = JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), ct: btoa(String.fromCharCode(...new Uint8Array(enc))) });
    localStorage.setItem(CRYPTO_DATA_LOCAL, payload);
  } catch { /* ignore */ }
}

async function decryptApiKey(): Promise<string | null> {
  try {
    const stored = localStorage.getItem(CRYPTO_DATA_LOCAL);
    if (!stored) return null;
    const { iv, ct } = JSON.parse(stored) as { iv: string; ct: string };
    const key = await _getOrCreateEncKey();
    if (!key) return null;
    const ivArr = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
    const ctArr = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
    const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivArr }, key, ctArr);
    return new TextDecoder().decode(dec);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PDFBlock {
  page_number: number;
  block_index: number;
  bbox: [number, number, number, number];
  text: string;
  myanmar_text?: string | null;
  font_size: number;
  font_name: string;
  block_type?: number;
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

type Screen = "upload" | "progress" | "review" | "result";

interface InspectInfo { pages: number; size_bytes: number }
interface ProgressPayload { status?: string; step?: string; done?: number; total?: number; message?: string; domain?: string; error?: string; event?: string }
interface GlossaryEntry { id: string; source: string; target: string }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const REVIEW_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [screen, setScreen] = useState<Screen>("upload");
  const [apiKey, setApiKey] = useState("");
  const [aiModel, setAiModel] = useState("gemini-2.0-flash");
  const [file, setFile] = useState<File | null>(null);
  const [domain, setDomain] = useState("auto");
  const [pages, setPages] = useState("all");
  const [pdfUrl, setPdfUrl] = useState("");

  // Glossary
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  // Custom font upload
  const [fontFile, setFontFile] = useState<File | null>(null);
  const [fontOpen, setFontOpen] = useState(false);

  // Inspect
  const [inspect, setInspect] = useState<InspectInfo | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // Job / progress
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState({ step: "", done: 0, total: 100, message: "" });
  const [result, setResult] = useState<ExtractionResult | null>(null);

  // Review (HITL)
  const [reviewBlocks, setReviewBlocks] = useState<PDFBlock[]>([]);
  const [reviewEdits, setReviewEdits] = useState<Map<string, string>>(new Map());
  const [reviewPageIdx, setReviewPageIdx] = useState(0);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // Side-by-side preview
  const [showSideBySide, setShowSideBySide] = useState(false);

  // General
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const progressDoneRef = useRef(false);

  // Load encrypted API key on mount
  useEffect(() => {
    decryptApiKey().then(k => { if (k) setApiKey(k); });
  }, []);

  const persistApiKey = useCallback((key: string) => {
    encryptApiKey(key.trim());
  }, []);

  // -------------------------------------------------------------------------
  // Glossary helpers
  // -------------------------------------------------------------------------
  const addGlossaryRow = () =>
    setGlossary(g => [...g, { id: Math.random().toString(36).slice(2), source: "", target: "" }]);

  const updateGlossaryRow = (id: string, field: "source" | "target", val: string) =>
    setGlossary(g => g.map(e => e.id === id ? { ...e, [field]: val } : e));

  const removeGlossaryRow = (id: string) =>
    setGlossary(g => g.filter(e => e.id !== id));

  const buildGlossaryJson = (): string => {
    const obj: Record<string, string> = {};
    for (const e of glossary) {
      if (e.source.trim() && e.target.trim()) obj[e.source.trim()] = e.target.trim();
    }
    return Object.keys(obj).length ? JSON.stringify(obj) : "";
  };

  // -------------------------------------------------------------------------
  // Inspect
  // -------------------------------------------------------------------------
  const runInspect = useCallback(async (f: File) => {
    setInspectLoading(true); setInspectError(null); setInspect(null);
    const fd = new FormData(); fd.append("pdf", f);
    try {
      const res = await fetch(new URL("/api/inspect", window.location.origin), { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || "Inspect failed");
      setInspect({ pages: data.pages, size_bytes: data.size_bytes });
    } catch (e) { setInspectError(e instanceof Error ? e.message : "Inspect failed"); }
    finally { setInspectLoading(false); }
  }, []);

  const handleFileChange = (f: File | null) => {
    setFile(f); setError(null); setInspect(null); setInspectError(null);
    if (f) void runInspect(f);
  };

  const tryLoadPdfFromUrl = async () => {
    const url = pdfUrl.trim(); if (!url) return;
    setError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) throw new Error("Not a PDF");
      const name = url.split("/").pop()?.split("?")[0] || "document.pdf";
      handleFileChange(new File([blob], name.endsWith(".pdf") ? name : `${name}.pdf`, { type: "application/pdf" }));
    } catch { setError("Could not load PDF from URL (often blocked by CORS). Upload the file instead."); }
  };

  // -------------------------------------------------------------------------
  // Job flow
  // -------------------------------------------------------------------------
  const loadMeta = async (id: string) => {
    try {
      const res = await fetch(`${window.location.origin}/api/jobs/${id}/meta`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load results");
      setResult({
        dimensions: data.dimensions || [],
        blocks: data.blocks || [],
        summary: data.summary || { total_pages: 0, total_text_blocks: 0 },
      });
      // Go to review screen (HITL)
      setReviewBlocks(data.blocks || []);
      setReviewEdits(new Map());
      setReviewPageIdx(0);
      setFinalizeError(null);
      setScreen("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load results");
      setScreen("upload");
    }
  };

  const subscribeProgress = (id: string) => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    const es = new EventSource(`${window.location.origin}/api/jobs/${id}/progress`);
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as ProgressPayload;
        if (data.event === "error" || data.status === "error") {
          progressDoneRef.current = false;
          setError(data.error || "Translation failed");
          setScreen("upload"); es.close(); return;
        }
        if (data.event === "complete" || data.status === "complete" || data.step === "complete") {
          if (progressDoneRef.current) return;
          progressDoneRef.current = true;
          setProgress(p => ({ ...p, step: "complete", done: p.total || 100, message: "Translation complete" }));
          void loadMeta(id).finally(() => es.close());
          return;
        }
        setProgress({ step: data.step || "", done: data.done ?? 0, total: Math.max(1, data.total ?? 100), message: data.message || "" });
      } catch { /* ignore malformed */ }
    };
    es.onerror = () => es.close();
  };

  const startTranslate = async () => {
    if (!file) return;
    const key = apiKey.trim();
    if (!key) { setError("Enter your API key in the field below."); return; }
    persistApiKey(key);
    setError(null); setDownloadError(null);
    setScreen("progress"); progressDoneRef.current = false;
    setProgress({ step: "starting", done: 0, total: 100, message: "Starting…" });

    const fd = new FormData();
    fd.append("pdf", file);
    if (fontFile) fd.append("fontFile", fontFile);

    const url = new URL("/api/jobs", window.location.origin);
    url.searchParams.set("domain", domain);
    url.searchParams.set("pages", pages.trim() || "all");
    url.searchParams.set("model", aiModel);
    const glossaryJson = buildGlossaryJson();
    if (glossaryJson) url.searchParams.set("glossary", glossaryJson);

    try {
      const res = await fetch(url.toString(), { method: "POST", headers: { [API_KEY_HEADER]: key }, body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || "Failed to start job");
      const id = data.jobId as string;
      setJobId(id); subscribeProgress(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start translation");
      setScreen("upload");
    }
  };

  // -------------------------------------------------------------------------
  // HITL Finalize
  // -------------------------------------------------------------------------
  const handleFinalize = async () => {
    if (!jobId) return;
    setFinalizing(true); setFinalizeError(null);

    // Merge edits into blocks
    const edited = reviewBlocks.map((b, i) => {
      const key = `${i}`;
      return reviewEdits.has(key) ? { ...b, myanmar_text: reviewEdits.get(key) } : b;
    });

    // Only finalize if any edits were made
    const hasEdits = reviewEdits.size > 0;
    if (hasEdits) {
      try {
        const res = await fetch(`${window.location.origin}/api/jobs/${jobId}/finalize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocks: edited }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.details || data.error || "Finalize failed");
      } catch (e) {
        setFinalizeError(e instanceof Error ? e.message : "Finalize failed");
        setFinalizing(false); return;
      }
    }
    setShowSideBySide(false);
    setScreen("result");
    setFinalizing(false);
  };

  const handleDownload = async () => {
    if (!jobId || !file) return;
    setDownloading(true); setDownloadError(null);
    try {
      const res = await fetch(`${window.location.origin}/api/jobs/${jobId}/download`);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || err.details || `Download failed (${res.status})`); }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `thikha_${file.name.replace(/\.pdf$/i, "")}_myanmar.pdf`;
      a.click(); URL.revokeObjectURL(a.href);
      setJobId(null);
    } catch (e) { setDownloadError(e instanceof Error ? e.message : "Download failed"); }
    finally { setDownloading(false); }
  };

  const resetFlow = () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    progressDoneRef.current = false;
    setScreen("upload"); setFile(null); setResult(null); setJobId(null);
    setInspect(null); setError(null); setDownloadError(null); setPdfUrl("");
    setReviewBlocks([]); setReviewEdits(new Map()); setFinalizeError(null);
    setShowSideBySide(false);
  };

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  const stepLabel = (() => {
    const s = progress.step;
    if (s === "extract") return "Step 1: Extract structure";
    if (s === "detect")  return "Step 2: Domain detection";
    if (s === "translate") return "Step 3: Translating blocks";
    if (s === "write")   return "Step 4: Building PDF";
    if (s === "verify")  return "Step 5: Verifying output";
    if (s === "complete") return "Complete";
    return progress.message || "Working…";
  })();

  const reviewTotalPages = Math.ceil(reviewBlocks.length / REVIEW_PAGE_SIZE);
  const reviewPageBlocks = reviewBlocks.slice(reviewPageIdx * REVIEW_PAGE_SIZE, (reviewPageIdx + 1) * REVIEW_PAGE_SIZE);
  const editedCount = reviewEdits.size;
  const currentModelMeta = AI_MODELS.find(m => m.value === aiModel);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
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
          {result && (screen === "result" || screen === "review") && (
            <div className="flex gap-4 text-sm font-medium text-gray-500">
              <div className="flex items-center gap-1"><FileText className="w-4 h-4" /><span>{result.summary.total_pages} Pages</span></div>
              <div className="flex items-center gap-1"><Type className="w-4 h-4" /><span>{result.summary.total_text_blocks} Blocks</span></div>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <AnimatePresence mode="wait">

          {/* ================================================================ */}
          {/* UPLOAD SCREEN                                                    */}
          {/* ================================================================ */}
          {screen === "upload" && (
            <motion.div key="upload" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} className="max-w-xl mx-auto space-y-5">

              {/* Drop zone */}
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
                <p className="text-gray-500 text-sm mb-4">Drag and drop, or click to browse. PDF only, max 100 MB.</p>
                <input type="file" ref={fileInputRef} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileChange(f); }} accept=".pdf,application/pdf" className="hidden" />
                {file && (
                  <div className="mt-4 text-left bg-white p-4 rounded-xl border border-blue-100" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <CheckCircle2 className="text-green-500 w-5 h-5 shrink-0" />
                        <span className="text-sm font-medium truncate">{file.name}</span>
                      </div>
                      <button type="button" onClick={() => handleFileChange(null)} className="text-xs text-gray-400 hover:text-red-500 font-medium shrink-0">Remove</button>
                    </div>
                    {inspectLoading && <p className="text-xs text-gray-500 mt-2 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Reading PDF…</p>}
                    {inspect && !inspectLoading && <p className="text-xs text-gray-600 mt-2">{inspect.pages} pages · {formatBytes(inspect.size_bytes)}</p>}
                    {inspectError && <p className="text-xs text-amber-600 mt-2">{inspectError}</p>}
                  </div>
                )}
              </div>

              {/* PDF URL */}
              <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-wider">Optional — PDF URL</p>
                <div className="flex gap-2">
                  <input type="url" value={pdfUrl} onChange={(e) => setPdfUrl(e.target.value)} placeholder="https://…/document.pdf" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500" />
                  <button type="button" onClick={() => void tryLoadPdfFromUrl()} className="px-3 py-2 text-sm font-medium bg-gray-100 rounded-lg hover:bg-gray-200">Load</button>
                </div>
                <p className="text-[11px] text-gray-400">Many sites block cross-origin downloads; uploading a local file is most reliable.</p>
              </div>

              {/* AI Model + API Key + Domain + Pages */}
              <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-4">
                {/* Model selector */}
                <div>
                  <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-2">AI Model</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {AI_MODELS.map((m) => (
                      <button key={m.value} type="button" onClick={() => setAiModel(m.value)}
                        className={`text-left px-3 py-2 rounded-lg border text-xs font-medium transition-all ${aiModel === m.value ? "border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-400" : "border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50"}`}
                      >
                        <div className="font-semibold truncate">{m.label}</div>
                        <div className="text-[10px] opacity-60 mt-0.5">{m.provider}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* API Key */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800">
                      <KeyRound className="w-4 h-4 text-blue-600" />
                      {currentModelMeta?.provider ?? "AI"} API Key
                      <Lock className="w-3 h-3 text-gray-400" title="Encrypted with AES-GCM in localStorage" />
                    </div>
                    <a href={currentModelMeta?.keyLink} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline">Get key ↗</a>
                  </div>
                  <input
                    type="password" autoComplete="off" value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); persistApiKey(e.target.value); }}
                    placeholder="Paste your API key (AES-encrypted locally)"
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Encrypted locally (AES-GCM) — sent only to your local server.</p>
                </div>

                {/* Domain + Pages */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">Domain</label>
                    <select value={domain} onChange={(e) => setDomain(e.target.value)} className="w-full text-sm bg-gray-50 border border-gray-200 rounded-lg p-2.5 outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="auto">Auto-detect</option>
                      <option value="medical">Medical</option>
                      <option value="tech">Technology</option>
                      <option value="academic">Academic</option>
                      <option value="legal">Legal</option>
                      <option value="general">General</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">Page range</label>
                    <input value={pages} onChange={(e) => setPages(e.target.value)} placeholder="all or 1-5" className="w-full text-sm border border-gray-200 rounded-lg p-2.5 outline-none focus:ring-1 focus:ring-blue-500" />
                  </div>
                </div>
              </div>

              {/* Custom Glossary */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <button type="button" onClick={() => setGlossaryOpen(o => !o)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                    <BookOpen className="w-4 h-4 text-purple-500" />
                    Custom Glossary
                    {glossary.filter(e => e.source.trim() && e.target.trim()).length > 0 && (
                      <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 font-medium">
                        {glossary.filter(e => e.source.trim() && e.target.trim()).length} terms
                      </span>
                    )}
                  </div>
                  {glossaryOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                <AnimatePresence>
                  {glossaryOpen && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="px-5 pb-4 space-y-3 border-t border-gray-100">
                        <p className="text-[11px] text-gray-400 pt-3">Define exact translations for specific terms. The AI will always use these.</p>
                        {glossary.map((entry) => (
                          <div key={entry.id} className="flex gap-2 items-center">
                            <input
                              value={entry.source} onChange={(e) => updateGlossaryRow(entry.id, "source", e.target.value)}
                              placeholder="Source term (e.g. Server)"
                              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-purple-400"
                            />
                            <span className="text-gray-400 text-sm font-medium shrink-0">→</span>
                            <input
                              value={entry.target} onChange={(e) => updateGlossaryRow(entry.id, "target", e.target.value)}
                              placeholder="Myanmar (e.g. ဆာဗာ)"
                              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-purple-400"
                            />
                            <button type="button" onClick={() => removeGlossaryRow(entry.id)} className="shrink-0 text-gray-300 hover:text-red-500 transition-colors"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        ))}
                        <button type="button" onClick={addGlossaryRow} className="flex items-center gap-1.5 text-sm text-purple-600 hover:text-purple-700 font-medium">
                          <Plus className="w-4 h-4" /> Add term
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Custom Font Upload */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <button type="button" onClick={() => setFontOpen(o => !o)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                    <Upload className="w-4 h-4 text-amber-500" />
                    Custom Myanmar Font
                    {fontFile && <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 font-medium truncate max-w-[120px]">{fontFile.name}</span>}
                  </div>
                  {fontOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                <AnimatePresence>
                  {fontOpen && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="px-5 pb-4 border-t border-gray-100 pt-3 space-y-3">
                        <p className="text-[11px] text-gray-400">Upload a Myanmar .ttf font (Padauk, Myanmar Text, etc.). Leave blank to use the default Pyidaungsu font.</p>
                        <div className="flex gap-2 items-center">
                          <button type="button" onClick={() => fontInputRef.current?.click()}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-amber-50 border border-amber-200 text-amber-700 rounded-lg hover:bg-amber-100 transition-colors"
                          >
                            <Upload className="w-4 h-4" />
                            {fontFile ? "Change font" : "Choose .ttf font"}
                          </button>
                          {fontFile && (
                            <button type="button" onClick={() => setFontFile(null)} className="text-xs text-gray-400 hover:text-red-500">Remove</button>
                          )}
                          <input type="file" ref={fontInputRef} accept=".ttf,.otf" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) setFontFile(f); }}
                          />
                        </div>
                        {fontFile && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-1.5">{fontFile.name} ({formatBytes(fontFile.size)})</p>}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex gap-3 text-red-700 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <div><p className="font-semibold">Something went wrong</p><p className="opacity-90">{error}</p></div>
                </div>
              )}

              <button type="button" onClick={() => void startTranslate()} disabled={!file || !apiKey.trim()}
                className={`w-full py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${file && apiKey.trim() ? "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200" : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
              >
                Translate PDF
              </button>
            </motion.div>
          )}

          {/* ================================================================ */}
          {/* PROGRESS SCREEN                                                  */}
          {/* ================================================================ */}
          {screen === "progress" && (
            <motion.div key="progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="max-w-lg mx-auto py-16">
              <div className="bg-white rounded-2xl border border-gray-200 p-8 shadow-sm">
                <div className="flex flex-col items-center text-center mb-6">
                  <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
                  <p className="text-lg font-semibold text-gray-900">{stepLabel}</p>
                  <p className="text-sm text-gray-500 mt-1">{progress.message}</p>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all duration-300 rounded-full" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-center text-xs text-gray-400 mt-2">{pct}%</p>
                {progress.step === "translate" && (
                  <p className="text-center text-[11px] text-gray-400 mt-3">Large PDFs may take several minutes…</p>
                )}
              </div>
            </motion.div>
          )}

          {/* ================================================================ */}
          {/* REVIEW SCREEN (Human-in-the-Loop)                               */}
          {/* ================================================================ */}
          {screen === "review" && (
            <motion.div key="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="max-w-5xl mx-auto space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                    <Pencil className="w-5 h-5 text-blue-600" />
                    Review Translations
                  </h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {reviewBlocks.length} blocks · {result?.summary.total_pages} pages
                    {editedCount > 0 && <span className="ml-2 text-blue-600 font-medium">· {editedCount} edited</span>}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={resetFlow} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    Start Over
                  </button>
                  <button type="button" onClick={() => void handleFinalize()} disabled={finalizing}
                    className="px-5 py-2 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 transition-colors"
                  >
                    {finalizing ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</> : <><CheckCircle2 className="w-4 h-4" /> {editedCount > 0 ? "Apply Edits & Export" : "Export PDF"}</>}
                  </button>
                </div>
              </div>

              {finalizeError && (
                <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex gap-3 text-red-700 text-sm">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <div><p className="font-semibold">Finalize failed</p><p>{finalizeError}</p></div>
                </div>
              )}

              {/* Blocks table */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200 text-left">
                        <th className="px-4 py-3 text-[10px] uppercase font-bold text-gray-400 tracking-wider w-12">Pg</th>
                        <th className="px-4 py-3 text-[10px] uppercase font-bold text-gray-400 tracking-wider w-1/2">Original Text</th>
                        <th className="px-4 py-3 text-[10px] uppercase font-bold text-gray-400 tracking-wider">Myanmar Translation</th>
                        <th className="px-4 py-3 text-[10px] uppercase font-bold text-gray-400 tracking-wider w-16">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {reviewPageBlocks.map((block, localIdx) => {
                        const globalIdx = reviewPageIdx * REVIEW_PAGE_SIZE + localIdx;
                        const key = `${globalIdx}`;
                        const currentTranslation = reviewEdits.has(key) ? reviewEdits.get(key)! : (block.myanmar_text ?? "");
                        const isEdited = reviewEdits.has(key);
                        const hasTranslation = !!block.myanmar_text;
                        return (
                          <tr key={`${block.page_number}-${block.block_index}`} className={isEdited ? "bg-blue-50/40" : ""}>
                            <td className="px-4 py-3 text-xs text-gray-400 font-mono align-top">{block.page_number}</td>
                            <td className="px-4 py-3 align-top">
                              <p className="text-gray-700 text-xs leading-relaxed line-clamp-3">{block.text}</p>
                            </td>
                            <td className="px-4 py-3 align-top">
                              <textarea
                                value={currentTranslation}
                                onChange={(e) => {
                                  const newMap = new Map(reviewEdits);
                                  if (e.target.value === (block.myanmar_text ?? "")) newMap.delete(key);
                                  else newMap.set(key, e.target.value);
                                  setReviewEdits(newMap);
                                }}
                                rows={2}
                                placeholder="No translation"
                                className={`w-full text-xs border rounded-lg px-2 py-1.5 outline-none resize-y font-sans leading-relaxed transition-colors ${isEdited ? "border-blue-300 bg-white focus:ring-1 focus:ring-blue-400" : "border-gray-200 bg-gray-50 focus:border-blue-300 focus:bg-white focus:ring-1 focus:ring-blue-300"}`}
                              />
                            </td>
                            <td className="px-4 py-3 align-top">
                              {isEdited ? (
                                <span className="inline-block text-[10px] bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">Edited</span>
                              ) : hasTranslation ? (
                                <span className="inline-block text-[10px] bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">Done</span>
                              ) : (
                                <span className="inline-block text-[10px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">Skipped</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Pagination */}
              {reviewTotalPages > 1 && (
                <div className="flex items-center justify-between">
                  <button type="button" onClick={() => setReviewPageIdx(p => Math.max(0, p - 1))} disabled={reviewPageIdx === 0}
                    className="flex items-center gap-1 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" /> Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {reviewPageIdx + 1} of {reviewTotalPages} · blocks {reviewPageIdx * REVIEW_PAGE_SIZE + 1}–{Math.min((reviewPageIdx + 1) * REVIEW_PAGE_SIZE, reviewBlocks.length)}
                  </span>
                  <button type="button" onClick={() => setReviewPageIdx(p => Math.min(reviewTotalPages - 1, p + 1))} disabled={reviewPageIdx >= reviewTotalPages - 1}
                    className="flex items-center gap-1 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                  >
                    Next <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {/* ================================================================ */}
          {/* RESULT SCREEN                                                    */}
          {/* ================================================================ */}
          {screen === "result" && result && (
            <motion.div key="result" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="max-w-4xl mx-auto space-y-6">

              {/* Summary card */}
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                    <CheckCircle2 className="w-6 h-6 text-green-600" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold">Translation Complete</h2>
                    <p className="text-sm text-gray-500">
                      {result.summary.translated_blocks ?? 0} of {result.summary.total_text_blocks} blocks translated
                      {result.summary.domain && ` · domain: ${result.summary.domain}`}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                  {[
                    { label: "Pages", value: result.summary.total_pages },
                    { label: "Blocks", value: result.summary.total_text_blocks },
                    { label: "Translated", value: result.summary.translated_blocks ?? 0 },
                    { label: "Time", value: result.summary.elapsed_seconds ? `${result.summary.elapsed_seconds}s` : "—" },
                  ].map((stat) => (
                    <div key={stat.label} className="bg-gray-50 rounded-xl p-3 text-center">
                      <p className="text-2xl font-bold text-gray-900">{stat.value}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-3">
                  <button type="button" onClick={() => void handleDownload()} disabled={downloading || !jobId}
                    className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-md shadow-blue-100"
                  >
                    {downloading ? <><Loader2 className="w-5 h-5 animate-spin" /> Downloading…</> : <><Download className="w-5 h-5" /> Download PDF</>}
                  </button>
                  <button type="button" onClick={() => { setScreen("review"); }} disabled={!jobId}
                    className="flex items-center gap-2 px-5 py-3 border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 disabled:opacity-40 transition-colors"
                  >
                    <Pencil className="w-4 h-4" /> Back to Review
                  </button>
                  {jobId && (
                    <button type="button" onClick={() => setShowSideBySide(s => !s)}
                      className={`flex items-center gap-2 px-5 py-3 border rounded-xl font-medium transition-colors ${showSideBySide ? "border-blue-400 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-700 hover:bg-gray-50"}`}
                    >
                      <SplitSquareHorizontal className="w-4 h-4" />
                      {showSideBySide ? "Hide" : "Side-by-Side"} Preview
                    </button>
                  )}
                  <button type="button" onClick={resetFlow} className="px-5 py-3 border border-gray-200 text-gray-500 font-medium rounded-xl hover:bg-gray-50 transition-colors ml-auto">
                    Translate Another
                  </button>
                </div>

                {downloadError && (
                  <div className="mt-4 bg-red-50 border border-red-100 p-3 rounded-lg flex gap-2 text-red-700 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>{downloadError}</p>
                  </div>
                )}
              </div>

              {/* Side-by-Side Viewer */}
              <AnimatePresence>
                {showSideBySide && jobId && (
                  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
                    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
                        <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                          <SplitSquareHorizontal className="w-4 h-4 text-blue-500" />
                          Side-by-Side Preview
                        </div>
                        <p className="text-[11px] text-gray-400">Scroll each panel independently</p>
                      </div>
                      <div className="grid grid-cols-2 divide-x divide-gray-200" style={{ height: "80vh" }}>
                        <div className="flex flex-col">
                          <div className="bg-gray-50 px-4 py-2 border-b border-gray-100 flex items-center gap-2">
                            <Eye className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Original</span>
                          </div>
                          <iframe
                            src={`/api/jobs/${jobId}/original`}
                            title="Original PDF"
                            className="flex-1 w-full border-0"
                          />
                        </div>
                        <div className="flex flex-col">
                          <div className="bg-blue-50 px-4 py-2 border-b border-blue-100 flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
                            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Translated</span>
                          </div>
                          <iframe
                            src={`/api/jobs/${jobId}/preview`}
                            title="Translated PDF"
                            className="flex-1 w-full border-0"
                          />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Block summary table */}
              {result.blocks.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800 text-sm">Translation Summary</h3>
                    <span className="text-xs text-gray-400">First 50 blocks shown</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b border-gray-100">
                          <th className="px-4 py-2.5 text-left text-[10px] uppercase font-bold text-gray-400 tracking-wider w-12">Pg</th>
                          <th className="px-4 py-2.5 text-left text-[10px] uppercase font-bold text-gray-400 tracking-wider">Original</th>
                          <th className="px-4 py-2.5 text-left text-[10px] uppercase font-bold text-gray-400 tracking-wider">Myanmar</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {result.blocks.slice(0, 50).map((b, i) => (
                          <tr key={i} className="hover:bg-gray-50/50">
                            <td className="px-4 py-2.5 text-xs text-gray-400 font-mono align-top">{b.page_number}</td>
                            <td className="px-4 py-2.5 text-xs text-gray-600 align-top max-w-[200px]">
                              <span className="line-clamp-2">{b.text}</span>
                            </td>
                            <td className="px-4 py-2.5 text-xs align-top max-w-[200px]">
                              {b.myanmar_text ? (
                                <span className="text-gray-800 line-clamp-2">{b.myanmar_text}</span>
                              ) : (
                                <span className="text-gray-300 italic">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
