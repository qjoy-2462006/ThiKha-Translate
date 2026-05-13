"""
Usage Example:
python3 translate_pdf.py --input sample.pdf --api-key YOUR_KEY --font Pyidaungsu.ttf --domain auto --pages all

This script:
1. Extracts text blocks and metadata from PDF.
2. Detects domain (medical/tech/legal/etc).
3. Translates text to Myanmar Unicode using Gemini-1.5-pro.
4. Generates a new PDF with translated text at original coordinates.
"""

import subprocess
import sys
import os
import json
import time
import random
import argparse
from datetime import timedelta

# --- Dependency Management ---
def install(package):
    # Writable directory is mandatory in cloud run environments
    lib_dir = "/tmp/python_libs"
    if not os.path.exists(lib_dir):
        os.makedirs(lib_dir)
    
    # Ensure it's at the front of the path
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)

    print(f"Attempting to install {package} to {lib_dir}...", file=sys.stderr)
    
    # Try 1: Standard pip install
    try:
        cmd = [sys.executable, "-m", "pip", "install", package, "--target", lib_dir, "--break-system-packages", "--no-cache-dir", "--only-binary=:all:"]
        print(f"Trying: {' '.join(cmd)}", file=sys.stderr)
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            print(f"Successfully installed {package}", file=sys.stderr)
            return
        print(f"Pip install failed: {result.stderr}", file=sys.stderr)
    except Exception as e:
        print(f"Error during pip install: {e}", file=sys.stderr)

    # Try 2: If pip is missing, try ensurepip
    try:
        print("Trying ensurepip...", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "ensurepip", "--default-pip"], capture_output=True)
        # Try install again
        cmd = [sys.executable, "-m", "pip", "install", package, "--target", lib_dir, "--break-system-packages"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return
    except:
        pass

    # Try 3: get-pip.py fallback
    try:
        print("Trying get-pip.py fallback...", file=sys.stderr)
        get_pip_path = "/tmp/get-pip.py"
        if not os.path.exists(get_pip_path):
            subprocess.run(["curl", "https://bootstrap.pypa.io/get-pip.py", "-o", get_pip_path], check=True)
        
        # Install pip first (to --user space)
        subprocess.run([sys.executable, get_pip_path, "--user", "--break-system-packages"], capture_output=True)
        
        # Then try installing package using the newly installed pip
        subprocess.run([sys.executable, "-m", "pip", "install", package, "--target", lib_dir, "--break-system-packages"], check=True)
        print(f"Successfully bootstrapped {package}", file=sys.stderr)
    except Exception as e:
        print(f"All install attempts failed for {package}: {e}", file=sys.stderr)

try:
    import fitz  # PyMuPDF
except (ImportError, ModuleNotFoundError):
    try:
        install("pymupdf")
        import fitz
    except:
        try:
            print("Standard pymupdf failed. Trying pymupdf-lite...", file=sys.stderr)
            install("pymupdf-lite")
            import fitz
        except Exception as e:
            print(f"PyMuPDF installation failed: {e}", file=sys.stderr)
            raise ImportError(f"PyMuPDF (fitz) is not installed and could not be bootstrapped: {e}")

try:
    import google.generativeai as genai
except ImportError:
    install("google-generativeai")
    import google.generativeai as genai

try:
    from tqdm import tqdm
except ImportError:
    install("tqdm")
    from tqdm import tqdm

try:
    from myanmar_tools import ZawgyiDetector, ZawgyiConverter
except ImportError:
    install("myanmar-tools")
    from myanmar_tools import ZawgyiDetector, ZawgyiConverter

def is_valid_unicode_myanmar(text):
    if not text: return False
    myanmar_chars = [c for c in text if '\u1000' <= c <= '\u109F']
    return len(myanmar_chars) > 0

detector = ZawgyiDetector()
converter = ZawgyiConverter()

# --- Core Functions ---

def detect_domain(pdf_path, api_key):
    """Scan first 500 words and detect domain using Gemini."""
    try:
        doc = fitz.open(pdf_path)
        sample_text = ""
        for page in doc:
            sample_text += page.get_text()
            if len(sample_text.split()) > 500:
                break
        doc.close()
        
        words = " ".join(sample_text.split()[:500])
        
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        
        prompt = f"Classify this text domain: medical/tech/academic/legal/general. One word answer only.\n\nText: {words}"
        response = model.generate_content(prompt)
        domain = response.text.strip().lower()
        
        valid_domains = ["medical", "tech", "academic", "legal", "general"]
        for d in valid_domains:
            if d in domain:
                return d
        return "general"
    except Exception as e:
        print(f"Warning: Domain detection failed ({e}). Defaulting to 'general'.")
        return "general"

def ocr_page(page, api_key):
    """Performs OCR on a page using Gemini 1.5 Pro Vision."""
    if not api_key:
        return []
    
    try:
        # Render page to image
        pix = page.get_pixmap(dpi=300)
        img_bytes = pix.tobytes("png")
        
        # Configure Gemini
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        
        # Request OCR
        prompt = "Extract ALL text from this document image. Return as JSON array of objects: {text, x_percent, y_percent, width_percent, height_percent, font_size_estimate}. Coordinates as percentage of page size. Output ONLY the raw JSON array."
        
        response = model.generate_content([
            prompt,
            {"mime_type": "image/png", "data": img_bytes}
        ])
        
        # Parse response
        text_resp = response.text.strip()
        # Clean markdown
        if "```json" in text_resp:
            text_resp = text_resp.split("```json")[1].split("```")[0].strip()
        elif "[" in text_resp and "]" in text_resp:
            start = text_resp.find("[")
            end = text_resp.rfind("]") + 1
            text_resp = text_resp[start:end]
            
        ocr_blocks = json.loads(text_resp)
        
        # Convert percentages back to pixels
        page_width = page.rect.width
        page_height = page.rect.height
        
        processed_blocks = []
        for i, b in enumerate(ocr_blocks):
            # Calculate pixel bbox
            x0 = (b["x_percent"] / 100) * page_width
            y0 = (b["y_percent"] / 100) * page_height
            w = (b["width_percent"] / 100) * page_width
            h = (b["height_percent"] / 100) * page_height
            
            processed_blocks.append({
                "page_number": page.number + 1,
                "block_index": i + 5000, 
                "bbox": (x0, y0, x0 + w, y0 + h),
                "text": b["text"],
                "font_size": b.get("font_size_estimate", 12),
                "font_name": "OCR_Detected",
                "is_bold": False,
                "color": 0
            })
        return processed_blocks
    except Exception as e:
        print(f"Warning: OCR fallback failed for page {page.number + 1} ({e})")
        return []

def extract_pdf_blocks(pdf_path, page_range="all", api_key=None):
    """Extracts text blocks with metadata. Falls back to OCR for scanned pages."""
    blocks_data = []
    try:
        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        
        # Parse page range
        target_pages = []
        if page_range == "all":
            target_pages = list(range(total_pages))
        else:
            try:
                start, end = map(int, page_range.split("-"))
                target_pages = list(range(start - 1, min(end, total_pages)))
            except:
                print(f"Invalid page range: {page_range}. Using all pages.")
                target_pages = list(range(total_pages))

        total_blocks = 0
        for p_idx in target_pages:
            page = doc[p_idx]
            
            # Check if page has text
            page_blocks = page.get_text("blocks")
            has_text = any(b[6] == 0 for b in page_blocks)
            
            if not has_text and api_key:
                print(f"Page {p_idx+1} appears scanned. Using Gemini OCR fallback...")
                ocr_results = ocr_page(page, api_key)
                blocks_data.extend(ocr_results)
                total_blocks += len(ocr_results)
                continue

            # Standard extraction
            page_dict = page.get_text("dict")
            
            for b_idx, b in enumerate(page_dict["blocks"]):
                if b["type"] != 0: continue
                
                x0, y0, x1, y1 = b["bbox"]
                text_content = []
                font_sizes = []
                font_names = set()
                is_bold_flags = []
                colors = set()
                
                for line in b["lines"]:
                    for span in line["spans"]:
                        text_content.append(span["text"])
                        font_sizes.append(span["size"])
                        font_names.add(span["font"])
                        is_bold = bool(span["flags"] & 2**4) or "Bold" in span["font"]
                        is_bold_flags.append(is_bold)
                        colors.add(span["color"])
                
                full_text = " ".join(text_content).strip()
                if len(full_text) < 3: continue # Skip small noise
                
                avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 10
                main_font = next(iter(font_names)) if font_names else "Helvetica"
                
                blocks_data.append({
                    "page_number": p_idx + 1,
                    "block_index": b_idx,
                    "bbox": (x0, y0, x1, y1),
                    "text": full_text,
                    "font_size": avg_font_size,
                    "font_name": main_font,
                    "is_bold": any(is_bold_flags),
                    "color": next(iter(colors)) if colors else 0
                })
                total_blocks += 1
                
        doc.close()
        return blocks_data, len(target_pages)
    except Exception as e:
        print(f"Error extracting blocks: {e}")
        return [], 0

def translate_blocks(blocks, api_key, domain):
    """Batch translate blocks using Gemini."""
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-1.5-pro")
    
    batch_size = 10
    translated_count = 0
    
    for i in range(0, len(blocks), batch_size):
        batch = blocks[i : i + batch_size]
        
        prompt = f"""Translate each numbered text to Myanmar Unicode. Output ONLY a JSON array of translated strings in the same order. No explanations.
Domain: {domain}
Instructions: Keep translations concise. This text must fit in given bbox widths.
CRITICAL: Output MUST be Unicode Myanmar (Unicode 5.1+). NOT Zawgyi. First character of Myanmar text must be in range U+1000 to U+109F.
Texts to translate:
"""
        for j, b in enumerate(batch):
            width = b['bbox'][2] - b['bbox'][0]
            char_limit = int(width / 14)
            prompt += f"{j+1}. {b['text']} (Target: ~{char_limit} Myan chars, Width: {int(width)}px)\n"
            
        retries = 3
        while retries >= 0:
            try:
                response = model.generate_content(prompt)
                text_resp = response.text.strip()
                
                # Basic JSON cleaning
                if "```json" in text_resp:
                    text_resp = text_resp.split("```json")[1].split("```")[0].strip()
                elif "```" in text_resp:
                    text_resp = text_resp.split("```")[1].split("```")[0].strip()
                
                translations = json.loads(text_resp)
                if len(translations) == len(batch):
                    for idx, t in enumerate(translations):
                        # Zawgyi detection and conversion
                        if t:
                            score = detector.get_zawgyi_probability(t)
                            if score > 0.5:
                                t = converter.convert(t, "unicode")
                        batch[idx]["myanmar_text"] = t
                    translated_count += len(batch)
                    break
                else:
                    raise ValueError("Batch mismatch")
            except Exception as e:
                retries -= 1
                if retries < 0:
                    for b in batch: b["myanmar_text"] = b["text"] # Fallback
                else:
                    time.sleep(2 * (3 - retries))
        
        yield len(batch)

def shorten_myanmar_text(text, api_key):
    """Fallback to Gemini to shorten text if it overflows."""
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = f"Shorten this Myanmar text to 70% length while keeping meaning: {text}. Output ONLY the shortened text."
        response = model.generate_content(prompt)
        return response.text.strip()
    except Exception as e:
        print(f"Warning: Shortening text failed ({e})")
        return text

def write_myanmar_pdf(input_path, output_path, blocks, font_path, api_key=None):
    """Creates a new PDF with translated text overlaid with overflow handling."""
    try:
        doc = fitz.open(input_path)
        overflow_count = 0
        report_path = "overflow_report.txt"
        
        with open(report_path, "w", encoding="utf-8") as report:
            report.write("PDF OVERFLOW REPORT\n")
            report.write("="*20 + "\n\n")

            for block in blocks:
                page = doc[block["page_number"] - 1]
                bbox = block["bbox"]
                m_text = block.get("myanmar_text", "")
                if not m_text: continue
                
                original_font_size = block["font_size"]
                
                # Covers old text
                page.draw_rect(bbox, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)
                
                success = False
                # Try 1: Original
                # Try 2: 85%
                # Try 3: 70%
                for scale in [1.0, 0.85, 0.70]:
                    fs = original_font_size * scale
                    result = page.insert_textbox(
                        bbox, m_text, fontsize=fs, fontname="pyidaungsu", fontfile=font_path,
                        color=fitz.utils.getColor(block["color"]) if isinstance(block["color"], int) else (0,0,0),
                        align=fitz.TEXT_ALIGN_LEFT
                    )
                    if result >= 0:
                        success = True
                        break
                
                # Try 4: Shorten text via Gemini
                if not success and api_key:
                    short_text = shorten_myanmar_text(m_text, api_key)
                    result = page.insert_textbox(
                        bbox, short_text, fontsize=original_font_size, fontname="pyidaungsu", fontfile=font_path,
                        color=fitz.utils.getColor(block["color"]) if isinstance(block["color"], int) else (0,0,0),
                        align=fitz.TEXT_ALIGN_LEFT
                    )
                    if result >= 0:
                        success = True
                        m_text = short_text # Update for logging
                
                # Try 5: Truncate
                if not success:
                    overflow_count += 1
                    report.write(f"Page: {block['page_number']}, Block: {block['block_index']}\n")
                    report.write(f"EN: {block['text']}\n")
                    report.write(f"MM Attempt: {m_text}\n")
                    report.write("-" * 10 + "\n")
                    
                    # Absolute fallback: insert whatever fits or truncate string
                    # Since we don't know exactly what fits, we'll try binary-like truncation
                    truncated = m_text
                    while len(truncated) > 5 and page.insert_textbox(bbox, truncated + "...", fontsize=original_font_size * 0.7, fontname="pyidaungsu", fontfile=font_path) < 0:
                        truncated = truncated[:-5]
                    
                    page.insert_textbox(
                        bbox, truncated + "...", fontsize=original_font_size * 0.7, fontname="pyidaungsu", fontfile=font_path,
                        color=fitz.utils.getColor(block["color"]) if isinstance(block["color"], int) else (0,0,0),
                        align=fitz.TEXT_ALIGN_LEFT
                    )
                    
        doc.save(output_path)
        doc.close()
        return overflow_count
    except Exception as e:
        print(f"Error writing PDF: {e}")
        return 0

def main():
    parser = argparse.ArgumentParser(description="PDF Layout-Preserving Myanmar Translator")
    parser.add_argument("--input", required=True, help="Input PDF path")
    parser.add_argument("--output", help="Output PDF path")
    parser.add_argument("--api-key", help="Gemini API Key")
    parser.add_argument("--font", required=True, help="Path to Pyidaungsu.ttf")
    parser.add_argument("--domain", default="auto", choices=["auto", "medical", "tech", "academic", "legal", "general"])
    parser.add_argument("--pages", default="all", help="Page range (e.g., 1-5 or all)")
    
    args = parser.parse_args()
    
    api_key = args.api_key or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("Error: Gemini API Key is required (via --api-key or GEMINI_API_KEY env var).")
        return

    if not os.path.exists(args.font):
        print(f"Error: Font file not found at {args.font}")
        return

    start_time = time.time()
    output_path = args.output or f"{os.path.splitext(args.input)[0]}_myanmar.pdf"

    # Step 1: EXTRACT
    print("Step 1: [EXTRACT] Scanning PDF structure...")
    blocks, processed_pages = extract_pdf_blocks(args.input, args.pages, api_key)
    print(f"Found {len(blocks)} text blocks across {processed_pages} pages.")

    # Step 2: DETECT
    domain = args.domain
    if domain == "auto":
        print("Step 2: [DETECT] Analyzing document domain...")
        domain = detect_domain(args.input, api_key)
    else:
        print(f"Step 2: [DETECT] Domain set to: {domain}")
    print(f"Target Domain: {domain}")

    # Step 3: TRANSLATE
    print(f"Step 3: [TRANSLATE] Translating {len(blocks)} blocks via Gemini...")
    pbar = tqdm(total=len(blocks), unit="block")
    for batch_done in translate_blocks(blocks, api_key, domain):
        pbar.update(batch_done)
    pbar.close()

    # Step 4: WRITE
    print("Step 4: [WRITE] Building Myanmar PDF...")
    overflows = write_myanmar_pdf(args.input, output_path, blocks, args.font, api_key)

    # Step 5: VERIFY
    print("Step 5: [VERIFY] Verifying output...")
    if os.path.exists(output_path):
        duration = str(timedelta(seconds=int(time.time() - start_time)))
        in_size = os.path.getsize(args.input) / 1024
        out_size = os.path.getsize(output_path) / 1024
        
        print("\n" + "="*40)
        print("SUCCESS: Myanmar PDF saved!")
        print(f"Path: {output_path}")
        print("-" * 40)
        print(f"Total Time:      {duration}")
        print(f"Pages:           {processed_pages}")
        print(f"Blocks:          {len(blocks)}")
        print(f"Overflow Alerts: {overflows}")
        print(f"Input Size:      {in_size:.2f} KB")
        print(f"Output Size:     {out_size:.2f} KB")
        print("="*40)
    else:
        print("Error: Output file was not generated.")

if __name__ == "__main__":
    main()
