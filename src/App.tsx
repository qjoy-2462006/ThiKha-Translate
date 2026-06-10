import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  FileUp, Loader2, CheckCircle2, AlertCircle, Download,
  KeyRound, Plus, Trash2, BookOpen, Upload, Pencil,
  SplitSquareHorizontal, ArrowLeft, ArrowRight, X,
  ExternalLink, SkipForward, ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_KEY_HEADER  = "x-gemini-api-key";
const CRYPTO_KEY_SESS = "thikha_enc_key";
const CRYPTO_DATA_LOC = "thikha_enc_data_v2";
const GLOSSARY_LOC    = "thikha_glossary_v1";

const AI_MODELS = [
  { value: "gemini-2.0-flash",           label: "Gemini 2.0 Flash",   provider: "Google",    keyLink: "https://aistudio.google.com/apikey" },
  { value: "gemini-1.5-pro",             label: "Gemini 1.5 Pro",     provider: "Google",    keyLink: "https://aistudio.google.com/apikey" },
  { value: "gpt-4o-mini",                label: "GPT-4o mini",        provider: "OpenAI",    keyLink: "https://platform.openai.com/api-keys" },
  { value: "gpt-4o",                     label: "GPT-4o",             provider: "OpenAI",    keyLink: "https://platform.openai.com/api-keys" },
  { value: "claude-3-haiku-20240307",    label: "Claude 3 Haiku",     provider: "Anthropic", keyLink: "https://console.anthropic.com/settings/keys" },
  { value: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet",  provider: "Anthropic", keyLink: "https://console.anthropic.com/settings/keys" },
];

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
async function _encKey(): Promise<CryptoKey | null> {
  try {
    const s = sessionStorage.getItem(CRYPTO_KEY_SESS);
    if (s) return crypto.subtle.importKey("raw", Uint8Array.from(atob(s), c => c.charCodeAt(0)), "AES-GCM", false, ["encrypt","decrypt"]);
    const k = await crypto.subtle.generateKey({ name:"AES-GCM", length:256 }, true, ["encrypt","decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", k));
    sessionStorage.setItem(CRYPTO_KEY_SESS, btoa(String.fromCharCode(...raw)));
    return k;
  } catch { return null; }
}
async function encryptKey(v: string) {
  try {
    if (!v.trim()) { localStorage.removeItem(CRYPTO_DATA_LOC); return; }
    const k = await _encKey(); if (!k) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, k, new TextEncoder().encode(v));
    localStorage.setItem(CRYPTO_DATA_LOC, JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), ct: btoa(String.fromCharCode(...new Uint8Array(ct))) }));
  } catch {}
}
async function decryptKey(): Promise<string | null> {
  try {
    const s = localStorage.getItem(CRYPTO_DATA_LOC); if (!s) return null;
    const { iv, ct } = JSON.parse(s) as { iv: string; ct: string };
    const k = await _encKey(); if (!k) return null;
    const dec = await crypto.subtle.decrypt({ name:"AES-GCM", iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)) }, k, Uint8Array.from(atob(ct), c => c.charCodeAt(0)));
    return new TextDecoder().decode(dec);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PDFBlock {
  page_number: number; block_index: number;
  bbox: [number,number,number,number]; text: string;
  myanmar_text?: string | null; font_size: number;
  font_name: string; block_type?: number; is_bold: boolean; color: number;
}
interface Summary {
  total_pages: number; total_text_blocks: number;
  translated_blocks?: number; overflow_count?: number;
  skipped_count?: number; domain?: string; elapsed_seconds?: number;
}
interface JobResult { dimensions: unknown[]; blocks: PDFBlock[]; summary: Summary }
type Screen = "upload" | "progress" | "review" | "result";
type ReviewFilter = "all" | "translated" | "skipped" | "edited";
interface GlossaryEntry { id: string; source: string; target: string }

function fmt(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1048576).toFixed(1)} MB`;
}
const RPAGE = 20;

// ---------------------------------------------------------------------------
// Shared style tokens
// ---------------------------------------------------------------------------
const inp  = "w-full text-sm bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors";
const lbl  = "block text-xs font-medium text-zinc-500 mb-1.5";

// Accordion panel
function Accordion({ open, onToggle, icon, title, badge, children }: {
  open: boolean; onToggle: () => void; icon: React.ReactNode;
  title: string; badge?: string; children: React.ReactNode;
}) {
  return (
    <div className="border border-zinc-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-zinc-400">{icon}</span>
          <span>{title}</span>
          {badge && <span className="text-xs font-normal text-zinc-400">{badge}</span>}
        </div>
        <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-zinc-100 px-4 py-4">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [screen, setScreen]         = useState<Screen>("upload");
  const [apiKey, setApiKey]         = useState("");
  const [keyWarn, setKeyWarn]       = useState(false);
  const [aiModel, setAiModel]       = useState("gemini-2.0-flash");
  const [file, setFile]             = useState<File | null>(null);
  const [domain, setDomain]         = useState("auto");
  const [pages, setPages]           = useState("all");
  const [fontFile, setFontFile]     = useState<File | null>(null);
  const [glossary, setGlossary]     = useState<GlossaryEntry[]>([]);

  const [inspect, setInspect]       = useState<{ pages:number; size_bytes:number } | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const [jobId, setJobId]           = useState<string | null>(null);
  const [progress, setProgress]     = useState({ step:"", done:0, total:100, message:"" });
  const [result, setResult]         = useState<JobResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError]           = useState<string|null>(null);

  const [reviewBlocks, setReviewBlocks] = useState<PDFBlock[]>([]);
  const [reviewEdits, setReviewEdits]   = useState<Map<string,string>>(new Map());
  const [reviewPage, setReviewPage]     = useState(0);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [finalizing, setFinalizing]     = useState(false);
  const [finalErr, setFinalErr]         = useState<string|null>(null);

  const [sideBySide, setSideBySide] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlError, setDlError]       = useState<string|null>(null);

  const [settingsOpen, setSettingsOpen] = useState(true);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [fontOpen, setFontOpen]         = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const fontRef = useRef<HTMLInputElement>(null);
  const esRef   = useRef<EventSource|null>(null);
  const doneRef = useRef(false);

  // Load saved data on mount
  useEffect(() => {
    const hasCt = !!localStorage.getItem(CRYPTO_DATA_LOC);
    decryptKey().then(k => { if (k) setApiKey(k); else if (hasCt) setKeyWarn(true); });
    try { const g = localStorage.getItem(GLOSSARY_LOC); if (g) setGlossary(JSON.parse(g)); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(GLOSSARY_LOC, JSON.stringify(glossary)); } catch {}
  }, [glossary]);

  const saveKey = useCallback((k: string) => {
    encryptKey(k);
    if (k.trim()) setKeyWarn(false);
  }, []);

  // Glossary
  const addRow    = () => setGlossary(g => [...g, { id: Math.random().toString(36).slice(2), source:"", target:"" }]);
  const updateRow = (id:string, f:"source"|"target", v:string) => setGlossary(g => g.map(e => e.id===id ? {...e,[f]:v} : e));
  const removeRow = (id:string) => setGlossary(g => g.filter(e => e.id!==id));
  const glossaryJson = () => {
    const obj: Record<string,string> = {};
    for (const e of glossary) if (e.source.trim()&&e.target.trim()) obj[e.source.trim()] = e.target.trim();
    return Object.keys(obj).length ? JSON.stringify(obj) : "";
  };

  // PDF inspect
  const runInspect = useCallback(async (f: File) => {
    setInspecting(true); setInspect(null);
    const fd = new FormData(); fd.append("pdf", f);
    try {
      const r = await fetch("/api/inspect", { method:"POST", body:fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setInspect(d);
    } catch {}
    setInspecting(false);
  }, []);

  const setFile_ = (f: File|null) => {
    setFile(f); setError(null); setInspect(null);
    if (f) void runInspect(f);
  };

  // Job lifecycle
  const loadMeta = async (id: string) => {
    const r = await fetch(`/api/jobs/${id}/meta`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    setResult({ dimensions: d.dimensions||[], blocks: d.blocks||[], summary: d.summary||{} });
    setReviewBlocks(d.blocks||[]);
    setReviewEdits(new Map()); setReviewPage(0); setReviewFilter("all");
    setFinalErr(null); setScreen("review");
  };

  const subscribeProgress = (id: string) => {
    esRef.current?.close();
    const es = new EventSource(`/api/jobs/${id}/progress`);
    esRef.current = es;
    es.onmessage = ev => {
      try {
        const d = JSON.parse(ev.data);
        if (d.event==="error"||d.status==="error") {
          setError(d.error||"Translation failed"); setScreen("upload"); es.close(); return;
        }
        if (d.event==="complete"||d.status==="complete"||d.step==="complete") {
          if (doneRef.current) return;
          doneRef.current = true;
          loadMeta(id).catch(e => { setError(e.message); setScreen("upload"); }).finally(() => es.close());
          return;
        }
        setProgress({ step:d.step||"", done:d.done??0, total:Math.max(1,d.total??100), message:d.message||"" });
      } catch {}
    };
    es.onerror = () => es.close();
  };

  const startTranslate = async () => {
    if (!file) return;
    const key = apiKey.trim();
    if (!key) { setError("API key is required."); return; }
    saveKey(key);
    setError(null); setDlError(null);
    setScreen("progress"); doneRef.current = false;
    setProgress({ step:"starting", done:0, total:100, message:"Starting…" });

    const fd = new FormData();
    fd.append("pdf", file);
    if (fontFile) fd.append("fontFile", fontFile);

    const url = new URL("/api/jobs", location.origin);
    url.searchParams.set("domain", domain);
    url.searchParams.set("pages", pages.trim()||"all");
    url.searchParams.set("model", aiModel);
    const gj = glossaryJson(); if (gj) url.searchParams.set("glossary", gj);

    try {
      const r = await fetch(url.toString(), { method:"POST", headers:{ [API_KEY_HEADER]:key }, body:fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.details||d.error);
      setJobId(d.jobId); subscribeProgress(d.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start"); setScreen("upload");
    }
  };

  const cancelJob = async () => {
    if (!jobId) { reset(); return; }
    setCancelling(true);
    esRef.current?.close(); esRef.current = null;
    try { await fetch(`/api/jobs/${jobId}`, { method:"DELETE" }); } catch {}
    setCancelling(false); reset();
  };

  const handleFinalize = async () => {
    if (!jobId) return;
    setFinalizing(true); setFinalErr(null);
    if (reviewEdits.size > 0) {
      const edited = reviewBlocks.map((b,i) => reviewEdits.has(`${i}`) ? {...b, myanmar_text:reviewEdits.get(`${i}`)} : b);
      try {
        const r = await fetch(`/api/jobs/${jobId}/finalize`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({blocks:edited}) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.details||d.error);
      } catch (e) { setFinalErr(e instanceof Error ? e.message : "Failed"); setFinalizing(false); return; }
    }
    setSideBySide(false); setScreen("result"); setFinalizing(false);
  };

  const handleDownload = async () => {
    if (!jobId||!file) return;
    setDownloading(true); setDlError(null);
    try {
      const r = await fetch(`/api/jobs/${jobId}/download`);
      if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error||`HTTP ${r.status}`); }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `thikha_${file.name.replace(/\.pdf$/i,"")}_myanmar.pdf`;
      a.click(); URL.revokeObjectURL(a.href);
      setJobId(null);
    } catch (e) { setDlError(e instanceof Error ? e.message : "Failed"); }
    setDownloading(false);
  };

  const reset = () => {
    esRef.current?.close(); esRef.current = null;
    doneRef.current = false;
    setScreen("upload"); setFile(null); setResult(null); setJobId(null);
    setInspect(null); setError(null); setDlError(null);
    setReviewBlocks([]); setReviewEdits(new Map()); setFinalErr(null);
    setSideBySide(false); setReviewFilter("all"); setCancelling(false);
  };

  // Derived values
  const pct       = Math.min(100, Math.round((progress.done / Math.max(1,progress.total)) * 100));
  const stepLabel = ({ extract:"Extracting text", detect:"Detecting domain", translate:"Translating", write:"Building PDF", verify:"Verifying", complete:"Done" } as Record<string,string>)[progress.step] ?? "Working…";
  const modelMeta = AI_MODELS.find(m => m.value===aiModel);
  const glossaryCount = glossary.filter(e => e.source.trim()&&e.target.trim()).length;

  const filtered = reviewBlocks.filter((b,i) => {
    if (reviewFilter==="edited")     return reviewEdits.has(`${i}`);
    if (reviewFilter==="translated") return !!b.myanmar_text && !reviewEdits.has(`${i}`);
    if (reviewFilter==="skipped")    return !b.myanmar_text && !reviewEdits.has(`${i}`);
    return true;
  });
  const totalReviewPages = Math.ceil(filtered.length / RPAGE);
  const pageBlocks       = filtered.slice(reviewPage*RPAGE, (reviewPage+1)*RPAGE);
  const editedCount      = reviewEdits.size;
  const translatedCount  = reviewBlocks.filter(b => !!b.myanmar_text).length;
  const qualityPct       = result ? Math.round(((result.summary.translated_blocks??0)/Math.max(1,result.summary.total_text_blocks))*100) : 0;

  // =========================================================================
  return (
    <div className="min-h-screen bg-white text-zinc-900" style={{ fontFamily:"system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>

      {/* ------------------------------------------------------------------ */}
      {/* HEADER                                                              */}
      {/* ------------------------------------------------------------------ */}
      <header className="border-b border-zinc-100 h-14 flex items-center px-4 sm:px-6 sticky top-0 bg-white/95 backdrop-blur-sm z-10">
        <div className="max-w-2xl mx-auto w-full flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <svg width="28" height="28" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
              <rect width="30" height="30" rx="8" fill="#09090b"/>
              <line x1="6" y1="11" x2="12" y2="11" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
              <line x1="6" y1="15" x2="12" y2="15" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
              <line x1="6" y1="19" x2="9.5" y2="19" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
              <path d="M14 15H16" stroke="white" strokeWidth="1.4" strokeLinecap="round"/>
              <path d="M15.5 13.5L17 15L15.5 16.5" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="19" y1="11" x2="24" y2="11" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
              <path d="M19 15 Q21 13.5 24 15" stroke="white" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
              <line x1="20.5" y1="19" x2="24" y2="19" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            <span className="font-semibold text-sm sm:text-base tracking-tight">ThiKha Translate</span>
          </div>
          {result && (screen==="review"||screen==="result") && (
            <span className="text-xs sm:text-sm text-zinc-400 tabular-nums">
              {result.summary.total_pages}p · {qualityPct}%
            </span>
          )}
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* MAIN                                                                */}
      {/* ------------------------------------------------------------------ */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10 pb-safe">
        <AnimatePresence mode="wait">

          {/* ============================================================== */}
          {/* UPLOAD SCREEN                                                   */}
          {/* ============================================================== */}
          {screen==="upload" && (
            <motion.div key="upload"
              initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-6}}
              transition={{duration:0.18}}
              className="space-y-4 sm:space-y-5"
            >
              {/* Drop zone */}
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0];
                  if (f?.type==="application/pdf") setFile_(f);
                  else setError("PDF files only.");
                }}
                className="border-2 border-dashed border-zinc-200 rounded-2xl cursor-pointer hover:border-zinc-400 hover:bg-zinc-50/60 active:bg-zinc-100/60 transition-all group select-none"
              >
                <input type="file" ref={fileRef} accept=".pdf,application/pdf" className="hidden"
                  onChange={e => { const f=e.target.files?.[0]; if(f) setFile_(f); e.target.value=""; }} />

                {!file ? (
                  <div className="flex flex-col items-center justify-center py-10 sm:py-14 px-4 text-center">
                    <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-zinc-100 flex items-center justify-center mb-4 group-hover:bg-zinc-200 transition-colors">
                      <FileUp className="w-5 h-5 sm:w-6 sm:h-6 text-zinc-500" />
                    </div>
                    <p className="font-medium text-zinc-900 text-sm sm:text-base mb-1">Drop a PDF here</p>
                    <p className="text-xs sm:text-sm text-zinc-400">or tap to browse · max 100 MB</p>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-4 sm:px-5 sm:py-5" onClick={e => e.stopPropagation()}>
                    <div className="w-9 h-9 sm:w-10 sm:h-10 bg-blue-50 rounded-lg flex items-center justify-center shrink-0">
                      <CheckCircle2 className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-zinc-900 truncate">{file.name}</p>
                      {inspecting && (
                        <p className="text-xs text-zinc-400 flex items-center gap-1 mt-0.5">
                          <Loader2 className="w-3 h-3 animate-spin"/>Reading…
                        </p>
                      )}
                      {inspect && (
                        <p className="text-xs text-zinc-400 mt-0.5">{inspect.pages} pages · {fmt(inspect.size_bytes)}</p>
                      )}
                    </div>
                    <button
                      onClick={() => setFile_(null)}
                      className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Settings accordion */}
              <Accordion
                open={settingsOpen} onToggle={() => setSettingsOpen(o=>!o)}
                icon={<KeyRound className="w-4 h-4" />} title="Settings"
              >
                <div className="space-y-4">
                  {/* API Key */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className={lbl + " mb-0"}>{modelMeta?.provider ?? "AI"} API Key</label>
                      <a href={modelMeta?.keyLink} target="_blank" rel="noopener noreferrer"
                        className="text-[11px] text-blue-500 hover:underline">
                        Get key ↗
                      </a>
                    </div>
                    {keyWarn && (
                      <div className="mb-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 leading-relaxed">
                        Saved key found but can't decrypt in this tab — please re-enter.
                      </div>
                    )}
                    <input type="password" autoComplete="off" value={apiKey}
                      onChange={e => { setApiKey(e.target.value); saveKey(e.target.value); }}
                      placeholder="Paste API key (AES-encrypted locally)"
                      className={inp + " font-mono text-xs"}
                    />
                  </div>

                  {/* Model */}
                  <div>
                    <label className={lbl}>Model</label>
                    <select value={aiModel} onChange={e => setAiModel(e.target.value)} className={inp}>
                      {AI_MODELS.map(m => (
                        <option key={m.value} value={m.value}>{m.label} — {m.provider}</option>
                      ))}
                    </select>
                  </div>

                  {/* Domain + Pages — stacks on mobile */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className={lbl}>Domain</label>
                      <select value={domain} onChange={e => setDomain(e.target.value)} className={inp}>
                        <option value="auto">Auto-detect</option>
                        <option value="medical">Medical</option>
                        <option value="tech">Technology</option>
                        <option value="academic">Academic</option>
                        <option value="legal">Legal</option>
                        <option value="general">General</option>
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>Pages</label>
                      <input value={pages} onChange={e => setPages(e.target.value)}
                        placeholder="all  or  1-5, 7" className={inp} />
                    </div>
                  </div>
                </div>
              </Accordion>

              {/* Glossary accordion */}
              <Accordion
                open={glossaryOpen} onToggle={() => setGlossaryOpen(o=>!o)}
                icon={<BookOpen className="w-4 h-4" />} title="Glossary"
                badge={glossaryCount > 0 ? `${glossaryCount} terms` : undefined}
              >
                <div className="space-y-3">
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    These terms will always be translated exactly as specified.
                  </p>
                  {glossary.map(e => (
                    <div key={e.id} className="flex flex-col sm:flex-row gap-2">
                      <input value={e.source} onChange={ev => updateRow(e.id,"source",ev.target.value)}
                        placeholder="Source term" className={inp + " flex-1"} />
                      <div className="flex gap-2 items-center">
                        <span className="hidden sm:block text-zinc-300 text-sm shrink-0">→</span>
                        <input value={e.target} onChange={ev => updateRow(e.id,"target",ev.target.value)}
                          placeholder="မြန်မာ" className={inp + " flex-1"} />
                        <button onClick={() => removeRow(e.id)}
                          className="shrink-0 w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center rounded-lg text-zinc-300 hover:text-red-400 hover:bg-red-50 transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  <button onClick={addRow}
                    className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 py-1 transition-colors">
                    <Plus className="w-4 h-4" /> Add term
                  </button>
                </div>
              </Accordion>

              {/* Custom Font accordion */}
              <Accordion
                open={fontOpen} onToggle={() => setFontOpen(o=>!o)}
                icon={<Upload className="w-4 h-4" />} title="Custom Font"
                badge={fontFile ? fontFile.name : undefined}
              >
                <div className="space-y-3">
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Upload a Myanmar .ttf font. Defaults to Pyidaungsu if not set.
                  </p>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button onClick={() => fontRef.current?.click()}
                      className="text-sm px-3 py-2 border border-zinc-200 rounded-lg text-zinc-600 hover:bg-zinc-50 active:bg-zinc-100 transition-colors">
                      {fontFile ? "Change font" : "Choose .ttf"}
                    </button>
                    {fontFile && (
                      <>
                        <button onClick={() => setFontFile(null)}
                          className="text-xs text-zinc-400 hover:text-red-400 transition-colors">Remove</button>
                        <span className="text-xs text-zinc-300">{fmt(fontFile.size)}</span>
                      </>
                    )}
                    <input type="file" ref={fontRef} accept=".ttf,.otf" className="hidden"
                      onChange={e => { const f=e.target.files?.[0]; if(f) setFontFile(f); }} />
                  </div>
                </div>
              </Accordion>

              {/* Error */}
              {error && (
                <div className="flex items-start gap-2.5 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="leading-relaxed">{error}</p>
                </div>
              )}

              {/* CTA */}
              <button
                onClick={() => void startTranslate()}
                disabled={!file || !apiKey.trim()}
                className="w-full py-3 sm:py-3.5 rounded-xl text-sm font-semibold transition-all
                  disabled:opacity-30 disabled:cursor-not-allowed
                  bg-zinc-900 text-white hover:bg-zinc-700 active:scale-[0.99]"
              >
                Translate PDF
              </button>
            </motion.div>
          )}

          {/* ============================================================== */}
          {/* PROGRESS SCREEN                                                 */}
          {/* ============================================================== */}
          {screen==="progress" && (
            <motion.div key="progress"
              initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
              className="flex flex-col items-center justify-center min-h-[65vh] text-center gap-7 px-4"
            >
              <Loader2 className="w-8 h-8 text-zinc-400 animate-spin" />

              <div className="space-y-1.5">
                <p className="font-medium text-zinc-900">{stepLabel}</p>
                <p className="text-sm text-zinc-400 max-w-xs">{progress.message || "Please wait…"}</p>
                <p className="text-xs text-zinc-300">{modelMeta?.label ?? aiModel}</p>
              </div>

              <div className="w-full max-w-xs space-y-1.5">
                <div className="h-1 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-zinc-900 rounded-full transition-all duration-500"
                    style={{width:`${pct}%`}}
                  />
                </div>
                <p className="text-xs text-zinc-400 text-right tabular-nums">{pct}%</p>
              </div>

              <button
                onClick={() => void cancelJob()} disabled={cancelling}
                className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-red-500 disabled:opacity-50 transition-colors py-2 px-3 rounded-lg"
              >
                {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <X className="w-3.5 h-3.5"/>}
                {cancelling ? "Cancelling…" : "Cancel"}
              </button>
            </motion.div>
          )}

          {/* ============================================================== */}
          {/* REVIEW SCREEN                                                   */}
          {/* ============================================================== */}
          {screen==="review" && (
            <motion.div key="review"
              initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
              className="space-y-4 sm:space-y-5"
            >
              {/* Title + action bar */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-0 sm:justify-between">
                <div>
                  <h2 className="font-semibold text-zinc-900">Review Translations</h2>
                  <p className="text-sm text-zinc-400 mt-0.5">
                    {translatedCount} of {reviewBlocks.length} blocks
                    {editedCount > 0 && ` · ${editedCount} edited`}
                  </p>
                </div>
                {/* Action buttons — scrollable row on mobile */}
                <div className="flex items-center gap-2 overflow-x-auto pb-0.5 sm:pb-0 shrink-0">
                  <button onClick={reset}
                    className="whitespace-nowrap text-sm text-zinc-400 hover:text-zinc-700 transition-colors px-3 py-2 rounded-lg hover:bg-zinc-50 shrink-0">
                    Start over
                  </button>
                  <button onClick={() => { setSideBySide(false); setScreen("result"); }}
                    className="whitespace-nowrap flex items-center gap-1.5 text-sm text-zinc-500 border border-zinc-200 rounded-lg px-3 py-2 hover:bg-zinc-50 transition-colors shrink-0">
                    <SkipForward className="w-3.5 h-3.5" />Skip
                  </button>
                  <button onClick={() => void handleFinalize()} disabled={finalizing}
                    className="whitespace-nowrap text-sm font-semibold bg-zinc-900 text-white rounded-lg px-4 py-2 hover:bg-zinc-700 disabled:opacity-50 flex items-center gap-1.5 transition-colors shrink-0">
                    {finalizing
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin"/>Generating…</>
                      : (editedCount>0 ? "Apply & Export" : "Export PDF")}
                  </button>
                </div>
              </div>

              {finalErr && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 shrink-0"/>{finalErr}
                </div>
              )}

              {/* Filter pills */}
              <div className="flex gap-1.5 flex-wrap">
                {(["all","translated","edited","skipped"] as ReviewFilter[]).map(f => {
                  const count = f==="all" ? reviewBlocks.length
                    : f==="edited" ? editedCount
                    : f==="translated" ? reviewBlocks.filter((_b,i)=>!!reviewBlocks[i].myanmar_text&&!reviewEdits.has(`${i}`)).length
                    : reviewBlocks.filter((_b,i)=>!reviewBlocks[i].myanmar_text&&!reviewEdits.has(`${i}`)).length;
                  return (
                    <button key={f} onClick={() => { setReviewFilter(f); setReviewPage(0); }}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                        ${reviewFilter===f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"}`}>
                      {f.charAt(0).toUpperCase()+f.slice(1)} · {count}
                    </button>
                  );
                })}
              </div>

              {/* Blocks: CARD on mobile, TABLE on sm+ */}
              {pageBlocks.length===0 ? (
                <div className="border border-zinc-200 rounded-xl py-14 text-center text-sm text-zinc-400">
                  No blocks match this filter.
                </div>
              ) : (
                <>
                  {/* Mobile cards (hidden on sm+) */}
                  <div className="flex flex-col gap-3 sm:hidden">
                    {pageBlocks.map(block => {
                      const gi  = reviewBlocks.indexOf(block);
                      const key = `${gi}`;
                      const cur = reviewEdits.has(key) ? reviewEdits.get(key)! : (block.myanmar_text??"");
                      const isEdited = reviewEdits.has(key);
                      return (
                        <div key={`${block.page_number}-${block.block_index}-${gi}`}
                          className={`border rounded-xl overflow-hidden ${isEdited?"border-blue-200 bg-blue-50/20":"border-zinc-200"}`}>
                          <div className="flex items-center justify-between px-3.5 py-2 border-b border-zinc-100 bg-zinc-50/50">
                            <span className="text-[11px] font-mono text-zinc-400">Page {block.page_number}</span>
                            {isEdited ? (
                              <span className="text-[10px] text-blue-600 font-medium bg-blue-100 px-2 py-0.5 rounded-full">Edited</span>
                            ) : block.myanmar_text ? (
                              <span className="text-[10px] text-emerald-600 font-medium bg-emerald-50 px-2 py-0.5 rounded-full">Translated</span>
                            ) : (
                              <span className="text-[10px] text-zinc-400 bg-zinc-100 px-2 py-0.5 rounded-full">Skipped</span>
                            )}
                          </div>
                          <div className="px-3.5 py-3 space-y-2.5">
                            <p className="text-xs text-zinc-500 leading-relaxed line-clamp-3">{block.text}</p>
                            <div className="h-px bg-zinc-100" />
                            <textarea
                              value={cur}
                              onChange={e => {
                                const m = new Map(reviewEdits);
                                if (e.target.value===(block.myanmar_text??"")) m.delete(key); else m.set(key,e.target.value);
                                setReviewEdits(m);
                              }}
                              rows={3}
                              placeholder="Myanmar translation…"
                              className="w-full text-xs border border-zinc-200 rounded-lg px-3 py-2 outline-none resize-none bg-white focus:ring-1 focus:ring-blue-400 focus:border-blue-300 transition-colors"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop table (hidden on mobile) */}
                  <div className="hidden sm:block border border-zinc-200 rounded-xl overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-zinc-100 bg-zinc-50/50">
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium w-10">Pg</th>
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium w-[42%]">Original</th>
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium">Myanmar</th>
                          <th className="px-4 py-2.5 w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-50">
                        {pageBlocks.map(block => {
                          const gi  = reviewBlocks.indexOf(block);
                          const key = `${gi}`;
                          const cur = reviewEdits.has(key) ? reviewEdits.get(key)! : (block.myanmar_text??"");
                          const isEdited = reviewEdits.has(key);
                          return (
                            <tr key={`${block.page_number}-${block.block_index}-${gi}`}
                              className={isEdited?"bg-blue-50/20":""}>
                              <td className="px-4 py-3 text-xs text-zinc-400 align-top font-mono">{block.page_number}</td>
                              <td className="px-4 py-3 align-top">
                                <p className="text-xs text-zinc-600 leading-relaxed line-clamp-3">{block.text}</p>
                              </td>
                              <td className="px-4 py-3 align-top">
                                <textarea value={cur}
                                  onChange={e => {
                                    const m = new Map(reviewEdits);
                                    if (e.target.value===(block.myanmar_text??"")) m.delete(key); else m.set(key,e.target.value);
                                    setReviewEdits(m);
                                  }}
                                  rows={2} placeholder="—"
                                  className="w-full text-xs border border-zinc-200 rounded-lg px-2 py-1.5 outline-none resize-y bg-white focus:ring-1 focus:ring-blue-400 focus:border-blue-300 transition-colors"
                                />
                              </td>
                              <td className="px-4 py-3 align-top text-right">
                                {isEdited ? (
                                  <span className="text-[10px] text-blue-600 font-medium">Edited</span>
                                ) : block.myanmar_text ? (
                                  <span className="text-[10px] text-emerald-600">Done</span>
                                ) : (
                                  <span className="text-[10px] text-zinc-300">Skip</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Pagination */}
              {totalReviewPages > 1 && (
                <div className="flex items-center justify-between">
                  <button onClick={() => setReviewPage(p=>Math.max(0,p-1))} disabled={reviewPage===0}
                    className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors py-2 px-3 rounded-lg hover:bg-zinc-50">
                    <ArrowLeft className="w-4 h-4"/>Prev
                  </button>
                  <span className="text-xs text-zinc-400 tabular-nums">
                    {reviewPage+1} / {totalReviewPages}
                  </span>
                  <button onClick={() => setReviewPage(p=>Math.min(totalReviewPages-1,p+1))} disabled={reviewPage>=totalReviewPages-1}
                    className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-700 disabled:opacity-30 transition-colors py-2 px-3 rounded-lg hover:bg-zinc-50">
                    Next<ArrowRight className="w-4 h-4"/>
                  </button>
                </div>
              )}
            </motion.div>
          )}

          {/* ============================================================== */}
          {/* RESULT SCREEN                                                   */}
          {/* ============================================================== */}
          {screen==="result" && result && (
            <motion.div key="result"
              initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} exit={{opacity:0}}
              transition={{duration:0.18}}
              className="space-y-5 sm:space-y-6"
            >
              {/* Stats card */}
              <div className="border border-zinc-200 rounded-xl p-5 sm:p-6 space-y-4 sm:space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="font-semibold text-zinc-900">Translation complete</h2>
                    <p className="text-sm text-zinc-400 mt-0.5 leading-relaxed">
                      {result.summary.translated_blocks??0} of {result.summary.total_text_blocks} blocks
                      {result.summary.domain && ` · ${result.summary.domain}`}
                      {result.summary.elapsed_seconds && ` · ${result.summary.elapsed_seconds}s`}
                    </p>
                  </div>
                  <span className="text-2xl sm:text-3xl font-bold text-zinc-900 tabular-nums shrink-0">{qualityPct}%</span>
                </div>

                <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                  <div className="h-full bg-zinc-900 rounded-full transition-all" style={{width:`${qualityPct}%`}}/>
                </div>

                <div className="grid grid-cols-3 gap-3 sm:gap-4 pt-1">
                  {[
                    { label:"Pages",    value:result.summary.total_pages },
                    { label:"Blocks",   value:result.summary.total_text_blocks },
                    { label:"Overflow", value:result.summary.overflow_count??0 },
                  ].map(s => (
                    <div key={s.label} className="text-center">
                      <p className="text-lg sm:text-xl font-semibold text-zinc-900 tabular-nums">{s.value}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action buttons — stack on mobile, row on sm+ */}
              <div className="flex flex-col sm:flex-row gap-2.5">
                <button onClick={() => void handleDownload()} disabled={downloading||!jobId}
                  className="flex items-center justify-center gap-2 px-5 py-3 sm:py-2.5 bg-zinc-900 text-white text-sm font-semibold rounded-xl hover:bg-zinc-700 disabled:opacity-40 transition-colors">
                  {downloading
                    ? <><Loader2 className="w-4 h-4 animate-spin"/>Downloading…</>
                    : <><Download className="w-4 h-4"/>Download PDF</>}
                </button>
                <div className="flex gap-2.5 sm:contents">
                  <button onClick={() => setScreen("review")} disabled={!jobId}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-3 sm:py-2.5 border border-zinc-200 text-sm text-zinc-600 rounded-xl hover:bg-zinc-50 disabled:opacity-40 transition-colors">
                    <Pencil className="w-4 h-4"/>Review
                  </button>
                  {jobId && (
                    <button onClick={() => setSideBySide(s=>!s)}
                      className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-4 py-3 sm:py-2.5 border text-sm rounded-xl transition-colors
                        ${sideBySide?"border-zinc-900 bg-zinc-50 text-zinc-900":"border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}>
                      <SplitSquareHorizontal className="w-4 h-4"/>Compare
                    </button>
                  )}
                </div>
                <button onClick={reset}
                  className="sm:ml-auto text-sm text-zinc-400 hover:text-zinc-700 py-2 px-2 transition-colors text-center sm:text-left">
                  Translate another →
                </button>
              </div>

              {dlError && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3">
                  <AlertCircle className="w-4 h-4 shrink-0"/>{dlError}
                </div>
              )}

              {/* Side-by-side comparison */}
              <AnimatePresence>
                {sideBySide && jobId && (
                  <motion.div
                    initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:8}}
                    className="border border-zinc-200 rounded-xl overflow-hidden"
                  >
                    <div className="border-b border-zinc-100 px-4 py-2.5 flex items-center justify-between bg-zinc-50/50">
                      <p className="text-xs font-medium text-zinc-500">Side-by-side comparison</p>
                      <p className="text-[11px] text-zinc-300 hidden sm:block">If PDF doesn't load, use Open links</p>
                    </div>
                    {/* Stack on mobile, side-by-side on md+ */}
                    <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-zinc-100">
                      {[
                        { label:"Original",   href:`/api/jobs/${jobId}/original`, src:`/api/jobs/${jobId}/original` },
                        { label:"Translated", href:`/api/jobs/${jobId}/preview`,  src:`/api/jobs/${jobId}/preview` },
                      ].map((p, idx) => (
                        <div key={p.label} className={`flex flex-col ${idx===0?"border-b md:border-b-0":""} border-zinc-100`}>
                          <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 border-b border-zinc-100">
                            <span className="text-[11px] font-medium text-zinc-500">{p.label}</span>
                            <a href={p.href} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 text-[11px] text-blue-500 hover:underline">
                              <ExternalLink className="w-3 h-3"/>Open ↗
                            </a>
                          </div>
                          <iframe
                            src={p.src} title={p.label}
                            className="w-full border-0"
                            style={{height:"50vh", minHeight:"320px"}}
                          />
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Block preview table */}
              {result.blocks.length > 0 && (
                <div className="border border-zinc-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 bg-zinc-50/50">
                    <p className="text-sm font-medium text-zinc-700">Block preview</p>
                    <p className="text-xs text-zinc-400">first 30 shown</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[480px]">
                      <thead>
                        <tr className="border-b border-zinc-50">
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium w-10">Pg</th>
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium">Original</th>
                          <th className="text-left px-4 py-2.5 text-xs text-zinc-400 font-medium">Myanmar</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-50">
                        {result.blocks.slice(0,30).map((b,i) => (
                          <tr key={i} className="hover:bg-zinc-50/50">
                            <td className="px-4 py-2.5 text-xs text-zinc-300 font-mono align-top">{b.page_number}</td>
                            <td className="px-4 py-2.5 text-xs text-zinc-600 align-top max-w-[200px]">
                              <span className="line-clamp-2">{b.text}</span>
                            </td>
                            <td className="px-4 py-2.5 text-xs align-top max-w-[200px]">
                              {b.myanmar_text
                                ? <span className="text-zinc-900 line-clamp-2">{b.myanmar_text}</span>
                                : <span className="text-zinc-200">—</span>}
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
