"""
ThiKha Translate — Standalone PDF Renderer for Human-in-the-Loop Finalize
Usage:
  python3 pdf_render.py --input original.pdf --output final.pdf \\
                        --font Pyidaungsu.ttf --blocks edited_blocks.json
"""
import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from translate_pdf import write_myanmar_pdf


def main():
    parser = argparse.ArgumentParser(description="Re-render PDF from edited block JSON")
    parser.add_argument("--input",  required=True, help="Original (source) PDF path")
    parser.add_argument("--output", required=True, help="Output PDF path")
    parser.add_argument("--font",   required=True, help="Myanmar font path (.ttf)")
    parser.add_argument("--blocks", required=True, help="JSON file containing edited blocks array")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(json.dumps({"ok": False, "error": f"Input PDF not found: {args.input}"}))
        sys.exit(1)
    if not os.path.exists(args.font):
        print(json.dumps({"ok": False, "error": f"Font not found: {args.font}"}))
        sys.exit(1)
    if not os.path.exists(args.blocks):
        print(json.dumps({"ok": False, "error": f"Blocks file not found: {args.blocks}"}))
        sys.exit(1)

    with open(args.blocks, "r", encoding="utf-8") as f:
        blocks = json.load(f)

    try:
        report = write_myanmar_pdf(args.input, args.output, blocks, args.font)
        print(json.dumps({"ok": True, **report}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
