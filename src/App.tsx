/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from "react";
import { 
  FileUp, 
  FileText, 
  Layout, 
  Type, 
  Maximize2, 
  Info, 
  Loader2, 
  CheckCircle2,
  AlertCircle
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface PDFBlock {
  page_number: number;
  block_index: number;
  bbox: [number, number, number, number];
  text: string;
  myanmar_text?: string;
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
  };
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [shouldTranslate, setShouldTranslate] = useState(false);
  const [domain, setDomain] = useState("auto");
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
    }
  };

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append("pdf", file);

    try {
      const url = new URL("/api/extract", window.location.origin);
      if (shouldTranslate) {
        url.searchParams.append("translate", "true");
        url.searchParams.append("domain", domain);
      }

      const response = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.details || data.error || "Failed to extract PDF data");
      }

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

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
          {result && (
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
          {!result && !loading && (
            <motion.div 
              key="upload"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-xl mx-auto"
            >
              <div 
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    setFile(e.dataTransfer.files[0]);
                  }
                }}
                className="border-2 border-dashed border-gray-300 rounded-2xl p-12 text-center hover:border-blue-500 hover:bg-blue-50/30 transition-all cursor-pointer group"
              >
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:scale-110 transition-transform">
                  <FileUp className="w-8 h-8 text-blue-600" />
                </div>
                <h2 className="text-xl font-semibold mb-2">Upload PDF to analyze</h2>
                <p className="text-gray-500 mb-6">Drag and drop your file here, or click to browse</p>
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".pdf"
                  className="hidden"
                />
                {file && (
                  <div className="mt-6 space-y-4 text-left bg-white p-4 rounded-xl border border-blue-100">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="text-green-500 w-5 h-5 flex-shrink-0" />
                        <span className="text-sm font-medium truncate max-w-[200px]">{file.name}</span>
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); setFile(null); }}
                        className="text-xs text-gray-400 hover:text-red-500 font-medium"
                      >
                        Remove
                      </button>
                    </div>
                    
                    <div className="pt-4 border-t border-gray-100">
                      <label className="flex items-center gap-3 cursor-pointer group">
                        <div className={`w-10 h-5 rounded-full transition-colors relative ${shouldTranslate ? 'bg-blue-600' : 'bg-gray-200'}`}>
                          <input 
                            type="checkbox" 
                            className="sr-only" 
                            checked={shouldTranslate}
                            onChange={(e) => setShouldTranslate(e.target.checked)}
                          />
                          <div className={`absolute top-1 left-1 bg-white w-3 h-3 rounded-full transition-transform ${shouldTranslate ? 'translate-x-5' : ''}`} />
                        </div>
                        <span className="text-sm font-medium text-gray-700">Translate to Myanmar Unicode</span>
                      </label>
                      
                      {shouldTranslate && (
                        <div className="mt-3">
                          <label className="block text-[10px] uppercase font-bold text-gray-400 tracking-wider mb-1">Domain</label>
                          <select 
                            value={domain}
                            onChange={(e) => setDomain(e.target.value)}
                            className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-2 focus:ring-1 focus:ring-blue-500 outline-none"
                          >
                            <option value="auto">Auto-detect</option>
                            <option value="medical">Medical</option>
                            <option value="technical">Technology</option>
                            <option value="academic">Academic</option>
                            <option value="legal">Legal</option>
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={handleUpload}
                disabled={!file}
                className={`w-full mt-6 py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2 ${
                  file 
                  ? "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200" 
                  : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
              >
                Translate PDF
              </button>
            </motion.div>
          )}

          {loading && (
            <motion.div 
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-24"
            >
              <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
              <p className="text-lg font-medium text-gray-700">Translating your document...</p>
              <p className="text-sm text-gray-500">Gemini & PyMuPDF are processing document layout and language</p>
            </motion.div>
          )}

          {error && (
            <motion.div 
              key="error"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-xl mx-auto mt-8 bg-red-50 border border-red-100 p-4 rounded-xl flex gap-3 text-red-700"
            >
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <div>
                <p className="font-semibold">Extraction Failed</p>
                <p className="text-sm opacity-90">{error}</p>
                <button 
                  onClick={() => { setError(null); setFile(null); }}
                  className="mt-2 text-xs font-bold underline"
                >
                  Try Again
                </button>
              </div>
            </motion.div>
          )}

          {result && (
            <motion.div 
              key="result"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start"
            >
              <div className="lg:col-span-2 space-y-6">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                  <Maximize2 className="w-6 h-6 text-blue-600" />
                  Extracted Text Blocks
                </h2>
                
                <div className="space-y-4">
                  {result.blocks.map((block, i) => (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(i * 0.05, 1) }}
                      key={`${block.page_number}-${block.block_index}`}
                      className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-md transition-shadow group relative overflow-hidden"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex gap-2">
                          <span className="px-2 py-0.5 bg-gray-100 text-gray-600 text-[10px] uppercase font-bold rounded tracking-wider">
                            Page {block.page_number}
                          </span>
                          <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] uppercase font-bold rounded tracking-wider">
                            Block {block.block_index}
                          </span>
                        </div>
                        <div className="text-[10px] text-gray-400 font-mono">
                          [{block.bbox.map(n => Math.round(n)).join(", ")}]
                        </div>
                      </div>
                      
                      <p 
                        className={`text-md leading-relaxed ${block.is_bold ? "font-semibold" : "font-normal"}`} 
                        style={{ color: block.color !== 0 ? `#${block.color.toString(16).padStart(6, '0')}` : undefined }}
                      >
                        {block.text}
                      </p>

                      {block.myanmar_text && (
                        <div className="mt-4 p-3 bg-blue-50/50 rounded-lg border-l-4 border-blue-500">
                          <p className="text-sm font-medium text-blue-900 leading-relaxed myanmar-font">
                            {block.myanmar_text}
                          </p>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-xs text-gray-500 border-t border-gray-50 mt-4 pt-3">
                        <div className="flex items-center gap-1">
                          <Info className="w-3 h-3" />
                          <span>Font: <span className="text-gray-900 font-medium">{block.font_name}</span></span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Maximize2 className="w-3 h-3" />
                          <span>Size: <span className="text-gray-900 font-medium">{block.font_size}pt</span></span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>

              <aside className="space-y-6 sticky top-24">
                <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
                  <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" />
                    Document Overview
                  </h3>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-sm text-gray-500">Total Pages</span>
                      <span className="font-semibold text-lg">{result.summary.total_pages}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 border-b border-gray-50">
                      <span className="text-sm text-gray-500">Text Blocks Identified</span>
                      <span className="font-semibold text-lg">{result.summary.total_text_blocks}</span>
                    </div>
                    {result.summary.translated_blocks !== undefined && (
                      <div className="flex justify-between items-center py-2 border-b border-gray-50 text-blue-600">
                        <span className="text-sm">Translated to Myanmar</span>
                        <span className="font-semibold text-lg">{result.summary.translated_blocks}</span>
                      </div>
                    )}
                  </div>

                  <div className="mt-8">
                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Page Geometry</h4>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-2 custom-scrollbar">
                      {result.dimensions.map(dim => (
                        <div key={dim.page_number} className="text-xs bg-gray-50 rounded-lg p-2 border border-gray-100 flex justify-between">
                          <span className="text-gray-500 font-medium">Page {dim.page_number}</span>
                          <span className="font-mono text-blue-600">{Math.round(dim.width)}×{Math.round(dim.height)} px</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button 
                    onClick={() => { setResult(null); setFile(null); }}
                    className="w-full mt-8 py-3 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors font-medium text-sm flex items-center justify-center gap-2"
                  >
                    Analyze New PDF
                  </button>
                </div>

                <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-2xl p-6 text-white shadow-xl shadow-blue-100">
                  <h3 className="font-bold mb-2 flex items-center gap-2">
                    <Layout className="w-5 h-5" />
                    Layout Preservation
                  </h3>
                  <p className="text-sm text-blue-100 opacity-90 leading-relaxed">
                    Extraction successful. Metadata includes precise pixel coordinates, font weights, and color indices suitable for high-fidelity translation reconstruction.
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
