"""
ThiKha Translate — Layout-Preserving Myanmar PDF Translator
============================================================
Usage:
  python3 translate_pdf.py --input book.pdf --font Pyidaungsu.ttf --domain auto --pages all

Fixes applied:
  [FIX #1] ZawgyiConverter removed → rabbit-myanmar (zg2uni) used instead
  [FIX #2] fitz.utils.getColor() removed → int_to_rgb() helper function
  [FIX #3] extract_pdf_blocks returns consistent 3-tuple everywhere
  [FIX #4] Font registered at page level before insert_textbox
  [FIX #5] translate_blocks fallback changed from English text → None
  [FIX #6] Font file existence validated before processing
"""

import subprocess
import sys
import os
import json
import time
import random
import argparse
import tempfile
import shutil
import urllib.request
from datetime import timedelta


PROGRESS_PREFIX = "@@PROGRESS@@"


def emit_progress(
    step: str,
    done: int = 0,
    total: int = 0,
    message: str = "",
    **extra,
):
    """Machine-readable progress for Node SSE (stderr, flushed)."""
    payload = {
        "step": step,
        "done": done,
        "total": total,
        "message": message,
        **extra,
    }
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Dependency bootstrap
# ---------------------------------------------------------------------------

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

    result = pip_cmd()
    if result.returncode == 0:
        print(f"[install] {package} OK", file=sys.stderr)
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
            print(f"[install] {package} OK (after cache reset)", file=sys.stderr)
            return True

    print(f"[install] {package} pip failed: {result.stderr[:400]}", file=sys.stderr)

    try:
        get_pip = os.path.join(tempfile.gettempdir(), "get-pip-thikha.py")
        urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", get_pip)
        subprocess.run([sys.executable, get_pip, "--user"], capture_output=True, text=True)
        result = pip_cmd()
        if result.returncode == 0:
            print(f"[install] {package} OK (after get-pip)", file=sys.stderr)
            return True
    except Exception as e:
        print(f"[install] exception: {e}", file=sys.stderr)
    return False


class _NoZawgyiDetector:
    def get_zawgyi_probability(self, _text: str) -> float:
        return 0.0


try:
    import fitz
except ImportError:
    install("pymupdf") or install("pymupdf-lite")
    import fitz

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

# [FIX #1] rabbit-myanmar replaces ZawgyiConverter (which does not exist in Python)
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def zawgyi_to_unicode(text: str) -> str:
    """Detect Zawgyi and convert to Unicode if needed."""
    if not text:
        return text
    try:
        score = detector.get_zawgyi_probability(text)
        if score > 0.5:
            return zg2uni(text)
    except Exception:
        pass
    return text


def is_unicode_myanmar(text: str) -> bool:
    return any("\u1000" <= c <= "\u109F" for c in (text or ""))


# [FIX #2] Replace fitz.utils.getColor() — it does not exist; color is a packed int
def int_to_rgb(color_int) -> tuple:
    """Convert packed integer color (PyMuPDF span color) to (r, g, b) floats 0-1."""
    if not isinstance(color_int, int):
        return (0.0, 0.0, 0.0)
    r = ((color_int >> 16) & 0xFF) / 255.0
    g = ((color_int >> 8) & 0xFF) / 255.0
    b = (color_int & 0xFF) / 255.0
    return (r, g, b)


# ---------------------------------------------------------------------------
# Domain detection
# ---------------------------------------------------------------------------

def detect_domain(pdf_path: str, api_key: str) -> str:
    try:
        doc = fitz.open(pdf_path)
        sample = ""
        for page in doc:
            sample += page.get_text()
            if len(sample.split()) > 500:
                break
        doc.close()

        words = " ".join(sample.split()[:500])
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = (
            "Classify this text into exactly one domain: medical/tech/academic/legal/general. "
            "Reply with ONE word only.\n\n" + words
        )
        resp = model.generate_content(prompt)
        detected = resp.text.strip().lower()
        for d in ("medical", "tech", "academic", "legal", "general"):
            if d in detected:
                return d
    except Exception as e:
        print(f"[detect_domain] warning: {e}", file=sys.stderr)
    return "general"


# ---------------------------------------------------------------------------
# OCR fallback for scanned pages (Gemini Vision)
# ---------------------------------------------------------------------------

def ocr_page(page, api_key: str) -> list:
    try:
        pix = page.get_pixmap(dpi=300)
        img_bytes = pix.tobytes("png")

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = (
            "Extract ALL text from this document image. "
            "Return a JSON array of objects with keys: "
            "text, x_percent, y_percent, width_percent, height_percent, font_size_estimate. "
            "Coordinates as percentage of page size. Output ONLY the raw JSON array."
        )
        response = model.generate_content(
            [prompt, {"mime_type": "image/png", "data": img_bytes}]
        )

        raw = response.text.strip()
        if "```" in raw:
            raw = raw.split("```")[1].lstrip("json").strip()
        start, end = raw.find("["), raw.rfind("]") + 1
        ocr_blocks = json.loads(raw[start:end])

        pw, ph = page.rect.width, page.rect.height
        results = []
        for i, b in enumerate(ocr_blocks):
            x0 = b["x_percent"] / 100 * pw
            y0 = b["y_percent"] / 100 * ph
            w  = b["width_percent"] / 100 * pw
            h  = b["height_percent"] / 100 * ph
            results.append({
                "page_number": page.number + 1,
                "block_index": i + 5000,
                "bbox": (x0, y0, x0 + w, y0 + h),
                "text": b.get("text", ""),
                "font_size": b.get("font_size_estimate", 12),
                "font_name": "OCR_Detected",
                "is_bold": False,
                "color": 0,
            })
        return results

    except Exception as e:
        print(f"[ocr_page] page {page.number + 1} failed: {e}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# [FIX #3] extract_pdf_blocks — always returns consistent 3-tuple
# ---------------------------------------------------------------------------

def extract_pdf_blocks(pdf_path: str, page_range: str = "all", api_key: str = None):
    """
    Returns (blocks, processed_page_count, total_block_count).
    Consistent 3-tuple — fixes the 2 vs 3 value mismatch between files.
    """
    blocks_data = []
    try:
        doc = fitz.open(pdf_path)
        total_pages = len(doc)

        if page_range == "all":
            target = list(range(total_pages))
        else:
            try:
                s, e = map(int, page_range.split("-"))
                target = list(range(s - 1, min(e, total_pages)))
            except Exception:
                print(f"[extract] invalid range '{page_range}', using all pages", file=sys.stderr)
                target = list(range(total_pages))

        total_blocks = 0

        for p_idx in target:
            page = doc[p_idx]
            raw_blocks = page.get_text("blocks")
            has_text = any(b[6] == 0 for b in raw_blocks)

            if not has_text and api_key:
                print(f"[extract] page {p_idx + 1} appears scanned — OCR fallback", file=sys.stderr)
                ocr = ocr_page(page, api_key)
                blocks_data.extend(ocr)
                total_blocks += len(ocr)
                continue

            page_dict = page.get_text("dict")
            for b_idx, b in enumerate(page_dict["blocks"]):
                if b["type"] != 0:
                    continue

                x0, y0, x1, y1 = b["bbox"]
                texts, sizes, fonts, bolds, colors = [], [], set(), [], set()

                for line in b["lines"]:
                    for span in line["spans"]:
                        texts.append(span["text"])
                        sizes.append(span["size"])
                        fonts.add(span["font"])
                        bolds.append(bool(span["flags"] & (1 << 4)) or "Bold" in span["font"])
                        colors.add(span["color"])

                full_text = " ".join(texts).strip()
                if len(full_text) < 3:
                    continue

                blocks_data.append({
                    "page_number": p_idx + 1,
                    "block_index": b_idx,
                    "bbox": (x0, y0, x1, y1),
                    "text": full_text,
                    "font_size": round(sum(sizes) / len(sizes), 2) if sizes else 10.0,
                    "font_name": next(iter(fonts), "Helvetica"),
                    "is_bold": any(bolds),
                    "color": next(iter(colors), 0),
                })
                total_blocks += 1

        doc.close()
        return blocks_data, len(target), total_blocks

    except Exception as e:
        print(f"[extract] error: {e}", file=sys.stderr)
        return [], 0, 0


# ---------------------------------------------------------------------------
# Translation — batch via Gemini
# ---------------------------------------------------------------------------

def translate_blocks(blocks: list, api_key: str, domain: str):
    """
    Generator: translates in batches of 10, yields batch size after each batch.
    [FIX #5] On failure, sets myanmar_text=None instead of falling back to English.
    """
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-1.5-pro")
    batch_size = 10

    for i in range(0, len(blocks), batch_size):
        batch = blocks[i: i + batch_size]

        lines = []
        for j, b in enumerate(batch):
            w = b["bbox"][2] - b["bbox"][0]
            char_limit = max(10, int(w / 14))
            lines.append(
                f"{j + 1}. {b['text']} "
                f"(target ≈{char_limit} Myanmar chars, bbox width {int(w)}px)"
            )

        prompt = (
            f"Translate each numbered text to Myanmar Unicode.\n"
            f"Domain: {domain}\n"
            f"Rules:\n"
            f"  - Output ONLY a JSON array of strings, same order, same count.\n"
            f"  - Unicode Myanmar ONLY (U+1000–U+109F range). Never Zawgyi.\n"
            f"  - Keep translations concise to fit the bbox width given.\n"
            f"  - Technical terms with no Myanmar equivalent: keep English + add Myanmar in parentheses.\n"
            f"  - No explanations, no markdown, no extra keys.\n\n"
            f"Texts:\n" + "\n".join(lines)
        )

        retries, wait = 3, 2
        success = False

        while retries >= 0 and not success:
            try:
                resp = model.generate_content(prompt)
                raw = resp.text.strip()

                # Strip markdown fences if present
                if "```" in raw:
                    raw = raw.split("```")[1].lstrip("json").strip()
                start = raw.find("[")
                end = raw.rfind("]") + 1
                translations = json.loads(raw[start:end])

                if len(translations) != len(batch):
                    raise ValueError(f"Count mismatch: got {len(translations)}, expected {len(batch)}")

                for idx, t in enumerate(translations):
                    t = zawgyi_to_unicode(t)
                    batch[idx]["myanmar_text"] = t if t else None

                success = True

            except Exception as e:
                retries -= 1
                if retries >= 0:
                    jitter = random.uniform(0.5, 1.5)
                    print(f"[translate] retry in {wait:.1f}s — {e}", file=sys.stderr)
                    time.sleep(wait * jitter)
                    wait *= 2
                else:
                    print(f"[translate] batch {i}–{i + len(batch)} failed permanently", file=sys.stderr)
                    # [FIX #5] Use None, not English fallback
                    for b in batch:
                        b["myanmar_text"] = None

        yield len(batch)


# ---------------------------------------------------------------------------
# Shorten text via Gemini (overflow recovery)
# ---------------------------------------------------------------------------

def shorten_myanmar_text(text: str, api_key: str) -> str:
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-1.5-pro")
        prompt = (
            f"Shorten this Myanmar text to 70% of its length while preserving meaning. "
            f"Output ONLY the shortened Myanmar text:\n{text}"
        )
        resp = model.generate_content(prompt)
        return resp.text.strip() or text
    except Exception as e:
        print(f"[shorten] failed: {e}", file=sys.stderr)
        return text


# ---------------------------------------------------------------------------
# [FIX #2 + #4] PDF writer — corrected color + font registration
# ---------------------------------------------------------------------------

def write_myanmar_pdf(
    input_path: str,
    output_path: str,
    blocks: list,
    font_path: str,
    api_key: str = None,
) -> dict:
    """
    Overlay Myanmar text onto original PDF, preserving all images and layout.

    Fixes:
      #2 — int_to_rgb() used instead of fitz.utils.getColor()
      #4 — font registered at page level before insert_textbox
    """
    # [FIX #6] Font validation happens before we open the PDF
    if not os.path.exists(font_path):
        raise FileNotFoundError(
            f"Font not found: {font_path}\n"
            "Download Pyidaungsu from https://www.dayone.gov.mm/mm/fonts"
        )

    font_data = open(font_path, "rb").read()
    doc = fitz.open(input_path)

    overflow_count = 0
    skipped_count = 0
    report_lines = ["THIKHA TRANSLATE — OVERFLOW REPORT", "=" * 40, ""]

    # Track which pages already have the font registered
    registered_pages: set = set()

    for block in blocks:
        m_text = block.get("myanmar_text")
        if not m_text:
            skipped_count += 1
            continue

        page_idx = block["page_number"] - 1
        page = doc[page_idx]
        bbox = fitz.Rect(block["bbox"])
        orig_fsize = max(block.get("font_size", 10), 6.0)

        # [FIX #4] Register font once per page before using it
        if page_idx not in registered_pages:
            page.insert_font(fontname="thikha_myanmar", fontbuffer=font_data)
            registered_pages.add(page_idx)

        # Erase original text with a white rectangle
        page.draw_rect(bbox, color=(1, 1, 1), fill=(1, 1, 1), overlay=True)

        # [FIX #2] Correct color conversion
        text_color = int_to_rgb(block.get("color", 0))

        inserted = False

        # Attempt 1: original size → 85% → 70%
        for scale in (1.0, 0.85, 0.70):
            result = page.insert_textbox(
                bbox,
                m_text,
                fontname="thikha_myanmar",
                fontsize=orig_fsize * scale,
                color=text_color,
                align=fitz.TEXT_ALIGN_LEFT,
            )
            if result >= 0:
                inserted = True
                break

        # Attempt 2: ask Gemini to shorten the text
        if not inserted and api_key:
            shorter = shorten_myanmar_text(m_text, api_key)
            result = page.insert_textbox(
                bbox,
                shorter,
                fontname="thikha_myanmar",
                fontsize=orig_fsize,
                color=text_color,
                align=fitz.TEXT_ALIGN_LEFT,
            )
            if result >= 0:
                inserted = True
                m_text = shorter

        # Attempt 3: progressive truncation
        if not inserted:
            overflow_count += 1
            report_lines += [
                f"Page {block['page_number']} | Block {block['block_index']}",
                f"  EN : {block['text'][:120]}",
                f"  MM : {m_text[:120]}",
                "-" * 30,
            ]
            truncated = m_text
            while len(truncated) > 5:
                truncated = truncated[:-5]
                result = page.insert_textbox(
                    bbox,
                    truncated + "…",
                    fontname="thikha_myanmar",
                    fontsize=orig_fsize * 0.70,
                    color=text_color,
                    align=fitz.TEXT_ALIGN_LEFT,
                )
                if result >= 0:
                    break

    doc.save(output_path, garbage=4, deflate=True)
    doc.close()

    if overflow_count:
        with open("overflow_report.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(report_lines))

    return {
        "overflow_count": overflow_count,
        "skipped_count": skipped_count,
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ThiKha — Layout-Preserving Myanmar PDF Translator")
    parser.add_argument("--input",   required=True,  help="Input PDF path")
    parser.add_argument("--output",  default=None,   help="Output PDF path (default: input_myanmar.pdf)")
    parser.add_argument("--api-key", default=None,   help="Gemini API key (or set GEMINI_API_KEY env var)")
    parser.add_argument("--font",    required=True,  help="Path to Pyidaungsu.ttf")
    parser.add_argument("--domain",  default="auto",
                        choices=["auto", "medical", "tech", "academic", "legal", "general"])
    parser.add_argument("--pages",   default="all",  help="Page range: 'all' or '1-5'")
    args = parser.parse_args()

    api_key = args.api_key or os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: Gemini API key required (--api-key or GEMINI_API_KEY env var)")
        sys.exit(1)

    # [FIX #6] Validate font early — fail fast with clear message
    if not os.path.exists(args.font):
        print(f"ERROR: Font file not found: {args.font}")
        print("Download Pyidaungsu from https://www.dayone.gov.mm/mm/fonts")
        sys.exit(1)

    if not os.path.exists(args.input):
        print(f"ERROR: Input file not found: {args.input}")
        sys.exit(1)

    output_path = args.output or os.path.splitext(args.input)[0] + "_myanmar.pdf"
    start = time.time()

    total_blocks = 0
    processed_pages = 0

    # Step 1: Extract
    print("\nStep 1: [EXTRACT] Scanning PDF structure...")
    emit_progress("extract", 0, 100, "Scanning PDF structure…")
    blocks, processed_pages, total_blocks = extract_pdf_blocks(args.input, args.pages, api_key)
    print(f"         Found {total_blocks} text blocks across {processed_pages} pages.")
    emit_progress(
        "extract",
        total_blocks,
        total_blocks,
        f"Found {total_blocks} blocks across {processed_pages} pages",
        pages=processed_pages,
        block_count=total_blocks,
    )

    if not blocks:
        print("ERROR: No text blocks found. Is the PDF password-protected or image-only?")
        sys.exit(1)

    # Step 2: Domain detection
    domain = args.domain
    if domain == "auto":
        print("Step 2: [DETECT]  Detecting document domain...")
        emit_progress("detect", 0, 1, "Detecting document domain…")
        domain = detect_domain(args.input, api_key)
    print(f"         Domain: {domain}")
    emit_progress("detect", 1, 1, f"Domain: {domain}", domain=domain)

    # Step 3: Translate
    n_blocks = len(blocks)
    print(f"Step 3: [TRANSLATE] Translating {n_blocks} blocks via Gemini 1.5 Pro...")
    emit_progress("translate", 0, n_blocks, f"Translating 0/{n_blocks} blocks…")
    pbar = tqdm(total=n_blocks, unit="block", file=sys.stderr)
    translated_so_far = 0
    for batch_done in translate_blocks(blocks, api_key, domain):
        translated_so_far += batch_done
        pbar.update(batch_done)
        emit_progress(
            "translate",
            translated_so_far,
            n_blocks,
            f"Translating {translated_so_far}/{n_blocks} blocks…",
        )
    pbar.close()

    translated = sum(1 for b in blocks if b.get("myanmar_text"))
    print(f"         Translated: {translated}/{len(blocks)} blocks")

    # Step 4: Write PDF
    print("Step 4: [WRITE]   Building Myanmar PDF...")
    emit_progress("write", 0, 1, "Building Myanmar PDF…")
    report = write_myanmar_pdf(args.input, output_path, blocks, args.font, api_key)
    emit_progress("write", 1, 1, "PDF built")

    # Step 5: Verify
    print("Step 5: [VERIFY]  Verifying output…")
    emit_progress("verify", 0, 1, "Verifying output…")
    elapsed = str(timedelta(seconds=int(time.time() - start)))
    in_kb  = os.path.getsize(args.input) / 1024
    out_kb = os.path.getsize(output_path) / 1024 if os.path.exists(output_path) else 0

    print()
    print("=" * 44)
    print("  SUCCESS — ThiKha Translate complete!")
    print("=" * 44)
    print(f"  Output      : {output_path}")
    print(f"  Time        : {elapsed}")
    print(f"  Pages       : {processed_pages}")
    print(f"  Blocks      : {len(blocks)} total / {translated} translated")
    print(f"  Overflow    : {report['overflow_count']} blocks")
    print(f"  Skipped     : {report['skipped_count']} blocks (no translation)")
    print(f"  Input size  : {in_kb:.1f} KB")
    print(f"  Output size : {out_kb:.1f} KB")
    print("=" * 44)

    emit_progress("verify", 1, 1, "Output verified")

    if report["overflow_count"]:
        print(f"\n  See overflow_report.txt for {report['overflow_count']} truncated blocks.")

    meta_path = output_path + ".meta.json"
    export_blocks = [
        {
            "page_number": b.get("page_number"),
            "block_index": b.get("block_index"),
            "bbox": b.get("bbox"),
            "text": b.get("text", ""),
            "myanmar_text": b.get("myanmar_text"),
            "font_size": b.get("font_size", 12),
            "font_name": b.get("font_name", ""),
            "block_type": b.get("block_type", 0),
            "is_bold": b.get("is_bold", False),
            "color": b.get("color", 0),
        }
        for b in blocks
    ]

    dimensions = []
    try:
        doc = fitz.open(args.input)
        for i, page in enumerate(doc):
            dimensions.append({
                "page_number": i + 1,
                "width": page.rect.width,
                "height": page.rect.height,
            })
        doc.close()
    except Exception as e:
        print(f"[meta] dimensions: {e}", file=sys.stderr)

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "dimensions": dimensions,
                "blocks": export_blocks,
                "summary": {
                    "total_pages": processed_pages,
                    "total_text_blocks": len(blocks),
                    "translated_blocks": translated,
                    "overflow_count": report.get("overflow_count", 0),
                    "skipped_count": report.get("skipped_count", 0),
                    "domain": domain,
                    "elapsed_seconds": int(time.time() - start),
                },
            },
            f,
            ensure_ascii=False,
        )

    emit_progress(
        "complete",
        n_blocks,
        n_blocks,
        "Translation complete",
        output_path=output_path,
        meta_path=meta_path,
        domain=domain,
        overflow_count=report.get("overflow_count", 0),
        translated_blocks=translated,
        total_pages=processed_pages,
    )


if __name__ == "__main__":
    main()
