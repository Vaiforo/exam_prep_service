#!/usr/bin/env python3
"""Extract question data from provided HTML trainers into a structured JSON file.

Supports two formats used in this project:
1. `const DATA = {...};` — big trainer with 1000 questions.
2. `const TESTS = [...]` — old 44x10 theoretical trainer.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


def extract_js_value(text: str, marker: str, open_char: str, close_char: str):
    start = text.find(marker)
    if start == -1:
        return None
    value_start = text.find(open_char, start)
    depth = 0
    in_str = False
    esc = False
    for i, ch in enumerate(text[value_start:], value_start):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == open_char:
                depth += 1
            elif ch == close_char:
                depth -= 1
                if depth == 0:
                    return json.loads(text[value_start:i + 1])
    raise ValueError(f"Cannot parse JavaScript value after {marker}")


def parse_big_html(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    data = extract_js_value(text, "const DATA =", "{", "}")
    if data is None:
        raise ValueError("No const DATA found")
    return data


def parse_tests_html(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    tests = extract_js_value(text, "const TESTS =", "[", "]")
    if tests is None:
        raise ValueError("No const TESTS found")
    topics = [{"id": t["id"], "title": t["title"]} for t in tests]
    bank = []
    for test in tests:
        for q in test["questions"]:
            bank.append({
                "id": f"LEGACY_{test['id']:02d}_{q['number']:02d}",
                "topic_idx": test["id"],
                "topic": test["title"],
                "prompt": q["prompt"],
                "kind": "mcq",
                "options": [o["text"] for o in q["options"]],
                "answer": next(i for i, o in enumerate(q["options"]) if o["id"] == q["correctId"]),
                "explanation": q.get("explanation", ""),
                "source": "legacy_theory",
                "difficulty": 1,
            })
    return {"topics": topics, "bank": bank, "official": [], "meta": {"total": len(bank)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("html", type=Path)
    parser.add_argument("-o", "--output", type=Path, default=Path("questions_raw.json"))
    args = parser.parse_args()
    text = args.html.read_text(encoding="utf-8")
    if "const DATA =" in text:
        data = parse_big_html(args.html)
    elif "const TESTS =" in text:
        data = parse_tests_html(args.html)
    else:
        raise SystemExit("Unsupported HTML format")
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
