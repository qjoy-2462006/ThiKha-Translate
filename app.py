import os
import sys
import subprocess
import time
import json
import tempfile
from pathlib import Path

# --- Dependency Management ---
def install(package):
    lib_dir = "/tmp/python_libs"
    if not os.path.exists(lib_dir):
        os.makedirs(lib_dir)
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    
    try:
        # Try standard pip
        subprocess.run([sys.executable, "-m", "pip", "install", package, "--target", lib_dir, "--break-system-packages", "--no-cache-dir"], capture_output=True)
    except:
        # Fallback to get-pip bootstrap if needed
        pass

# Ensure Gradio and other UI dependencies are present
try:
    import gradio as gr
except ImportError:
    install("gradio")
    import gradio as gr

try:
    import fitz
except ImportError:
    install("pymupdf")
    import fitz

# Import the translation logic from translate_pdf.py
from translate_pdf import (
    detect_domain, 
    extract_pdf_blocks, 
    translate_blocks as translate_blocks_myanmar, 
    write_myanmar_pdf
)

def process_pdf(pdf_file, api_key, domain, pages_range, font_file, progress=gr.Progress()):
    if not pdf_file:
        return None, "No file uploaded.", None, None
    if not api_key:
        return None, "Gemini API Key is required.", None, None
    
    start_time = time.time()
    progress(0, desc="Initializing...")
    
    # Setup paths
    input_path = pdf_file.name
    output_dir = tempfile.mkdtemp()
    output_path = os.path.join(output_dir, f"translated_{os.path.basename(input_path)}")
    
    try:
        # Step 1: Extract
        progress(0.1, desc="Extracting PDF layout...")
        blocks, processed_pages = extract_pdf_blocks(input_path, pages_range, api_key)
        
        if not blocks:
            return None, "Extraction failed or no text found.", None, None

        # Step 2: Domain Detection
        if domain == "auto":
            progress(0.2, desc="Detecting domain...")
            domain = detect_domain(input_path, api_key)
        
        # Step 3: Translate
        progress(0.3, desc=f"Translating to Myanmar ({domain})...")
        translated_count = 0
        total_to_translate = len(blocks)
        
        for batch_done in translate_blocks_myanmar(blocks, api_key, domain):
            translated_count += batch_done
            progress(0.3 + (0.5 * (translated_count / total_to_translate)), 
                     desc=f"Translated {translated_count}/{total_to_translate} blocks...")

        # Step 4: Write
        progress(0.85, desc="Generating Myanmar PDF...")
        overflows = write_myanmar_pdf(input_path, output_path, blocks, font_file, api_key)
        
        elapsed = time.time() - start_time
        stats = {
            "Pages Processed": len(set(b["page_number"] for b in blocks)),
            "Total Blocks": len(blocks),
            "Processing Time": f"{elapsed:.1f}s",
            "Overflow Count": overflows
        }
        
        # Generate Previews
        doc = fitz.open(input_path)
        out_doc = fitz.open(output_path)
        previews = []
        for i in range(min(3, len(doc))):
            # Original
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(1, 1))
            img_path = os.path.join(output_dir, f"orig_{i}.png")
            pix.save(img_path)
            # Translated
            pix_out = out_doc[i].get_pixmap(matrix=fitz.Matrix(1, 1))
            img_out_path = os.path.join(output_dir, f"trans_{i}.png")
            pix_out.save(img_out_path)
            previews.append((img_path, img_out_path))
        
        doc.close()
        out_doc.close()

        status_msg = f"Done! {overflows} blocks overflowed slightly but were handled."
        return output_path, status_msg, stats, previews

    except Exception as e:
        import traceback
        return None, f"Error: {str(e)}\n{traceback.format_exc()}", None, None

def create_ui():
    with gr.Blocks(title="ThiKha Translate") as demo:
        gr.Markdown("# ThiKha Translate — မြန်မာဘာသာ PDF Translator")
        gr.Markdown("Translate any PDF to Myanmar Unicode while preserving the original layout.")
        
        with gr.Tabs():
            with gr.TabItem("Translation"):
                with gr.Row():
                    with gr.Column():
                        file_input = gr.File(label="Upload PDF", file_types=[".pdf"])
                        domain_input = gr.Dropdown(
                            choices=["auto", "medical", "tech", "academic", "legal", "general"],
                            value="auto",
                            label="Domain"
                        )
                        pages_input = gr.Textbox(value="all", label="Page Range (e.g., 'all' or '1-3')")
                        api_key_input = gr.Textbox(label="Gemini API Key", type="password")
                        font_input = gr.Textbox(value="Pyidaungsu.ttf", label="Font Path (Ensure font exists)")
                        
                        btn = gr.Button("Translate PDF", variant="primary")
                    
                    with gr.Column():
                        status_output = gr.Textbox(label="Log", interactive=False)
                        output_pdf = gr.File(label="Download Translated PDF")
                        stats_output = gr.JSON(label="Summary Stats")
                
                gr.Examples(
                    examples=[["", "", "auto", "all", "Pyidaungsu.ttf"]],
                    inputs=[file_input, api_key_input, domain_input, pages_input, font_input]
                )

            with gr.TabItem("Preview"):
                gr.Markdown("### Side-by-Side Comparison (First 3 Pages)")
                preview_gallery = gr.Gallery(label="Original vs Translated", columns=2)

        def on_click(pdf, key, dom, pg, font):
            out, msg, stats, prevs = process_pdf(pdf, key, dom, pg, font)
            
            # Flatten previews for gallery
            gallery_data = []
            if prevs:
                for orig, trans in prevs:
                    gallery_data.append((orig, "Original"))
                    gallery_data.append((trans, "Translated"))
            
            return out, msg, stats, gallery_data

        btn.click(
            on_click,
            inputs=[file_input, api_key_input, domain_input, pages_input, font_input],
            outputs=[output_pdf, status_output, stats_output, preview_gallery]
        )

    return demo

if __name__ == "__main__":
    demo = create_ui()
    # share=True creates a public gradio.live URL
    demo.launch(share=True)
