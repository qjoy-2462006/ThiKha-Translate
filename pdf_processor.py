import subprocess
import sys
import os
import json
import time
import random
import tempfile
import shutil
import urllib.request


def install(package):
    """Best-effort pip install into a temp --target dir (Windows + Linux)."""
    lib_dir = os.path.join(tempfile.gettempdir(), "thikha_python_libs")
    os.makedirs(lib_dir, exist_ok=True)
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)

    def pip_cmd():
        cmd = [
            sys.executable,
            "-m",
            "pip",
            "install",
            package,
            "--target",
            lib_dir,
            "--upgrade",
            "--no-cache-dir",
        ]
        if sys.platform != "win32":
            cmd.append("--break-system-packages")
        return subprocess.run(cmd, capture_output=True, text=True)

    print(f"Attempting to install {package} to {lib_dir}...", file=sys.stderr)
    result = pip_cmd()
    if result.returncode == 0:
        print(f"Successfully installed {package}", file=sys.stderr)
        return True

    err = (result.stderr or "") + (result.stdout or "")
    if sys.platform == "win32" and ("183" in err or "already exists" in err.lower()):
        try:
            shutil.rmtree(lib_dir, ignore_errors=True)
            os.makedirs(lib_dir, exist_ok=True)
        except OSError:
            pass
        result = pip_cmd()
        if result.returncode == 0:
            print(f"Successfully installed {package} (after cache reset)", file=sys.stderr)
            return True

    print(f"Pip install failed: {result.stderr}", file=sys.stderr)

    try:
        print("Trying get-pip bootstrap (urllib, no curl)...", file=sys.stderr)
        get_pip_path = os.path.join(tempfile.gettempdir(), "get-pip-thikha.py")
        urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", get_pip_path)
        subprocess.run([sys.executable, get_pip_path, "--user"], capture_output=True, text=True)
        result = pip_cmd()
        if result.returncode == 0:
            print(f"Successfully bootstrapped {package}", file=sys.stderr)
            return True
    except Exception as e:
        print(f"get-pip fallback failed: {e}", file=sys.stderr)

    return False


class _NoZawgyiDetector:
    """Fallback when myanmar-tools cannot be installed (e.g. exotic Python)."""

    def get_zawgyi_probability(self, _text: str) -> float:
        return 0.0

try:
    import fitz
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
    from google import genai
    from google.genai import types as genai_types
except ImportError:
    install("google-genai")
    from google import genai
    from google.genai import types as genai_types

try:
    from tqdm import tqdm
except ImportError:
    install("tqdm")
    from tqdm import tqdm

try:
    from myanmar_tools import ZawgyiDetector

    detector = ZawgyiDetector()
except ImportError:
    if install("myanmar-tools"):
        try:
            from myanmar_tools import ZawgyiDetector

            detector = ZawgyiDetector()
        except ImportError:
            print(
                "[thikha] myanmar-tools still unavailable — Zawgyi detection off. "
                "Run: pip install myanmar-tools",
                file=sys.stderr,
            )
            detector = _NoZawgyiDetector()
    else:
        print(
            "[thikha] myanmar-tools install failed — Zawgyi detection off. "
            "Run: pip install -r requirements.txt",
            file=sys.stderr,
        )
        detector = _NoZawgyiDetector()

try:
    from rabbit import zg2uni
except ImportError:
    try:
        install("rabbit-myanmar")
        from rabbit import zg2uni
    except Exception:
        print(
            "[thikha] rabbit-myanmar unavailable — Zawgyi→Unicode conversion off.",
            file=sys.stderr,
        )
        def zg2uni(text: str) -> str:  # type: ignore[misc]
            return text

def is_valid_unicode_myanmar(text):
    if not text: return False
    myanmar_chars = [c for c in text if '\u1000' <= c <= '\u109F']
    return len(myanmar_chars) > 0

def get_page_dimensions(pdf_path):
    """Returns [(page_num, width, height)] for each page."""
    dimensions = []
    try:
        doc = fitz.open(pdf_path)
        for i, page in enumerate(doc):
            dimensions.append({
                "page_number": i + 1,
                "width": page.rect.width,
                "height": page.rect.height
            })
        doc.close()
    except Exception as e:
        print(f"Error reading dimensions: {e}", file=sys.stderr)
        return []
    return dimensions

def ocr_page(page, api_key):
    """Performs OCR on a page using Gemini 1.5 Pro Vision."""
    if not api_key:
        return []
    
    try:
        print(f"Page {page.number + 1} appears to be scanned. Running Gemini OCR...", file=sys.stderr)
        # 1. Render page to image
        pix = page.get_pixmap(dpi=300)
        img_bytes = pix.tobytes("png")
        
        # 2. Configure Gemini
        client = genai.Client(api_key=api_key)
        
        # 3. Request OCR
        prompt = "Extract ALL text from this document image. Return as JSON array of objects: {text, x_percent, y_percent, width_percent, height_percent, font_size_estimate}. Coordinates as percentage of page size. Output ONLY the raw JSON array."
        
        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[prompt, genai_types.Part.from_bytes(data=img_bytes, mime_type="image/png")],
        )
        
        # 4. Parse response
        text_resp = response.text.strip()
        # Clean markdown
        if "```json" in text_resp:
            text_resp = text_resp.split("```json")[1].split("```")[0].strip()
        elif "[" in text_resp and "]" in text_resp:
            start = text_resp.find("[")
            end = text_resp.rfind("]") + 1
            text_resp = text_resp[start:end]
            
        ocr_blocks = json.loads(text_resp)
        
        # 5. Convert percentages back to pixels
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
                "block_index": i + 5000, # Offset to avoid collision with native blocks
                "bbox": (x0, y0, x0 + w, y0 + h),
                "text": b["text"],
                "font_size": b.get("font_size_estimate", 12),
                "font_name": "OCR_Detected",
                "block_type": 0,
                "is_bold": False,
                "color": 0
            })
        return processed_blocks
    except Exception as e:
        print(f"OCR failed for page {page.number + 1}: {e}", file=sys.stderr)
        return []

def extract_pdf_blocks(pdf_path, api_key=None):
    """
    Extracts all text blocks from every page with metadata.
    Skips image blocks (type == 1). Falls back to OCR if no text found.
    """
    blocks_data = []
    try:
        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        total_text_blocks = 0
        
        for page_num in range(total_pages):
            page = doc[page_num]
            # Extract basic text blocks to check if page is empty/scanned
            page_blocks = page.get_text("blocks")
            
            # Check if we have any valid text blocks of type 0
            has_text = any(b[6] == 0 for b in page_blocks)
            
            if not has_text and api_key:
                # Page looks scanned, use OCR
                ocr_results = ocr_page(page, api_key)
                blocks_data.extend(ocr_results)
                total_text_blocks += len(ocr_results)
                continue

            # Native extraction for standard PDFs
            page_dict = page.get_text("dict")
            for b_idx, b in enumerate(page_dict["blocks"]):
                if b["type"] != 0:  # Skip non-text blocks
                    continue
                
                # Bounding box
                x0, y0, x1, y1 = b["bbox"]
                
                # Aggregate text and metadata from spans
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
                if not full_text:
                    continue
                    
                avg_font_size = sum(font_sizes) / len(font_sizes) if font_sizes else 0
                main_font = next(iter(font_names)) if font_names else "Unknown"
                
                blocks_data.append({
                    "page_number": page_num + 1,
                    "block_index": b_idx,
                    "bbox": (x0, y0, x1, y1),
                    "text": full_text,
                    "font_size": round(avg_font_size, 2),
                    "font_name": main_font,
                    "block_type": b["type"],
                    "is_bold": any(is_bold_flags),
                    "color": next(iter(colors)) if colors else 0
                })
                total_text_blocks += 1
                
        doc.close()
        return blocks_data, total_pages, total_text_blocks
    except Exception as e:
        print(f"Error processing PDF: {e}", file=sys.stderr)
        return [], 0, 0

def translate_blocks_to_myanmar(blocks, api_key, domain="auto"):
    """
    Translates block text to Myanmar using Gemini-1.5-pro.
    Groups in batches of 10.
    """
    if not api_key:
        print("API Key required for translation", file=sys.stderr)
        return blocks

    client = genai.Client(api_key=api_key)
    
    # Filter blocks: skip < 3 chars
    translate_indices = [i for i, b in enumerate(blocks) if len(b["text"].strip()) >= 3]
    
    # Progress
    total_to_translate = len(translate_indices)
    if total_to_translate == 0:
        return blocks

    print(f"Starting translation of {total_to_translate} blocks...", file=sys.stderr)
    
    batch_size = 10
    # Use tqdm if available for visual progress in console, else just print
    try:
        pbar = tqdm(total=total_to_translate, file=sys.stderr)
    except:
        pbar = None

    for i in range(0, total_to_translate, batch_size):
        batch_indices = translate_indices[i : i + batch_size]
        batch = [blocks[idx] for idx in batch_indices]
        
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
            
        success = False
        retries = 3
        wait_time = 2
        
        while not success and retries >= 0:
            try:
                # Actual print for logging
                print(f"Translating blocks {i + 1} to {min(i + batch_size, total_to_translate)} of {total_to_translate}...", file=sys.stderr)
                
                response = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
                
                # Extract JSON array
                text_resp = response.text.strip()
                # Clean markdown
                if text_resp.startswith("```json"):
                    # Find first [ and last ]
                    start = text_resp.find("[")
                    end = text_resp.rfind("]") + 1
                    text_resp = text_resp[start:end]
                elif "```" in text_resp:
                    start = text_resp.find("[")
                    end = text_resp.rfind("]") + 1
                    text_resp = text_resp[start:end]
                
                translations = json.loads(text_resp)
                
                if isinstance(translations, list) and len(translations) == len(batch):
                    for idx_in_batch, translation in enumerate(translations):
                        # Zawgyi detection and conversion
                        if translation:
                            try:
                                score = detector.get_zawgyi_probability(translation)
                                if score > 0.5:
                                    translation = zg2uni(translation)
                            except Exception:
                                pass
                            
                            # Final validation - if no myanmar chars at all, something is wrong
                            if not is_valid_unicode_myanmar(translation) and any('\u1000' <= c <= '\u109F' for c in translation) == False:
                                # We might have technical terms only, which is fine
                                pass

                        blocks[batch_indices[idx_in_batch]]["myanmar_text"] = translation
                    success = True
                else:
                    raise ValueError(f"Batch size mismatch: expected {len(batch)}, got {len(translations)}")
                    
            except Exception as e:
                print(f"Error in batch transition: {e}. Retries left: {retries}", file=sys.stderr)
                retries -= 1
                if retries >= 0:
                    time.sleep(wait_time)
                    wait_time *= (2 + random.uniform(0, 1))
                else:
                    # Final failure for this batch
                    for idx in batch_indices:
                        blocks[idx]["myanmar_text"] = None
        
        if pbar:
            pbar.update(len(batch))
            
    if pbar:
        pbar.close()
        
    return blocks

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--inspect":
        inspect_path = sys.argv[2]
        if not os.path.exists(inspect_path):
            print(json.dumps({"error": f"File not found: {inspect_path}"}))
            sys.exit(1)
        try:
            doc = fitz.open(inspect_path)
            pages = len(doc)
            doc.close()
            print(json.dumps({"pages": pages, "size_bytes": os.path.getsize(inspect_path)}))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
        sys.exit(0)

    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf_path", help="Path to PDF file")
    parser.add_argument("domain", nargs="?", default="auto", help="Domain for translation")
    parser.add_argument("translate_flag", nargs="?", default="false", help="Should translate")
    args = parser.parse_args()

    pdf_file = args.pdf_path
    domain = args.domain
    should_translate = args.translate_flag.lower() == "true"
    
    api_key = os.getenv("GEMINI_API_KEY")
    
    if not os.path.exists(pdf_file):
        print(f"File not found: {pdf_file}")
        sys.exit(1)
        
    dims = get_page_dimensions(pdf_file)
    blocks, pages, total_blocks = extract_pdf_blocks(pdf_file, api_key)
    
    if api_key and should_translate:
        blocks = translate_blocks_to_myanmar(blocks, api_key, domain)
    
    output = {
        "dimensions": dims,
        "blocks": blocks,
        "summary": {
            "total_pages": pages,
            "total_text_blocks": total_blocks,
            "translated_blocks": len([b for b in blocks if "myanmar_text" in b and b["myanmar_text"]])
        }
    }
    
    print(json.dumps(output, indent=2))
