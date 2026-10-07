"""Smart Exam Forecast — multi-model OpenRouter pipeline for predicted papers.

Public API (called from uni_app.py):
    extract_pdf_text(file_bytes, filename) -> str
    parse_past_paper_questions(text, year_hint) -> dict
    analyze_corpus_patterns(structured_papers, syllabus_text, marking_texts) -> dict
    run_pipeline(papers, syllabus, marking_schemes, *, run_backtest, progress_cb) -> dict
    similarity_score(predicted_questions, actual_questions) -> dict
    export_predicted_paper_pdf(result, out_path) -> None
    export_answer_guide_pdf(result, out_path) -> None

Design notes
------------
- All OpenRouter calls go through ``_openrouter_complete`` (defined in uni_app.py)
  to keep auth headers, error handling, and timeouts consistent with the rest of
  the app. We pass it in via dependency injection (``openrouter_complete=...``)
  so this module stays import-cheap and unit-testable.
- Every model slug is environment-overridable. Defaults match the user spec.
- If a model is unavailable, the pipeline fails fast with the model slug in the
  error so the operator can override via env without code changes.
- All prompts request strict JSON output. We retry once on JSON parse failure
  with an explicit "your previous reply was not valid JSON" instruction.
- No user content (paper text, results) is logged. Only stage names, durations,
  and error summaries.
- PDF generation uses ReportLab (deterministic; no AI in the layout step).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from io import BytesIO
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# ─── Model constants (env-overridable; never silently downgraded) ───────────
EXAM_FORECAST_EXTRACTION_MODEL = (
    os.getenv("EXAM_FORECAST_EXTRACTION_MODEL", "").strip() or "openai/gpt-5.5-pro"
)
EXAM_FORECAST_LONG_CONTEXT_MODEL = (
    os.getenv("EXAM_FORECAST_LONG_CONTEXT_MODEL", "").strip()
    or "google/gemini-3.1-pro-preview"
)
EXAM_FORECAST_PATTERN_MODEL = (
    os.getenv("EXAM_FORECAST_PATTERN_MODEL", "").strip() or "anthropic/claude-opus-4.7"
)
EXAM_FORECAST_RIVAL_MODEL = (
    os.getenv("EXAM_FORECAST_RIVAL_MODEL", "").strip() or "openai/gpt-5.5-pro"
)
EXAM_FORECAST_CONSENSUS_MODEL = (
    os.getenv("EXAM_FORECAST_CONSENSUS_MODEL", "").strip()
    or "anthropic/claude-opus-4.7"
)
EXAM_FORECAST_JUDGE_MODEL = (
    os.getenv("EXAM_FORECAST_JUDGE_MODEL", "").strip() or "openai/gpt-5.5-pro"
)
EXAM_FORECAST_FINAL_POLISH_MODEL = (
    os.getenv("EXAM_FORECAST_FINAL_POLISH_MODEL", "").strip()
    or "anthropic/claude-opus-4.7"
)

# Per-stage temperature (matches user spec).
TEMP_EXTRACT = 0.1
TEMP_PATTERN = 0.2
TEMP_PREDICT = 0.2
TEMP_JUDGE = 0.1
TEMP_POLISH = 0.2

# Per-stage token caps. Generous because predicted-paper outputs can be long.
MAX_TOKENS_STRUCTURE = 6000
MAX_TOKENS_CORPUS = 6000
MAX_TOKENS_PREDICT = 8000
MAX_TOKENS_JUDGE = 4000
MAX_TOKENS_POLISH = 8000

DISCLAIMER = (
    "This is a pattern-based mock paper, not a guaranteed future exam paper."
)

# ─── Errors ─────────────────────────────────────────────────────────────────


class ExamForecastError(Exception):
    """Raised when a pipeline stage fails fatally (e.g. model unavailable)."""

    def __init__(self, stage: str, model: str, detail: str = ""):
        self.stage = stage
        self.model = model
        self.detail = detail
        super().__init__(
            f"[{stage}] model {model!r} failed: {detail or 'no detail'}"
        )


# ─── JSON helpers ───────────────────────────────────────────────────────────


_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)


def _strip_code_fences(text: str) -> str:
    """Remove ```json ... ``` fences if a model wraps its output."""
    if not text:
        return ""
    return _JSON_FENCE_RE.sub("", text.strip()).strip()


def _find_balanced_json(text: str) -> str:
    """Find the first balanced top-level JSON object or array in *text*.

    Models sometimes prefix the JSON with commentary even when asked not to.
    This walks the string and returns the first balanced ``{...}`` or
    ``[...]`` block.
    """
    if not text:
        return ""
    text = _strip_code_fences(text)
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start < 0:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
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
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        return text[start : i + 1]
    return text


def _parse_json_loose(text: str) -> Any:
    """Parse JSON tolerantly: strip fences, trim, allow trailing commas."""
    raw = _find_balanced_json(text)
    if not raw:
        raise ValueError("empty model output")
    # Strip trailing commas before } or ] — a common LLM mistake.
    cleaned = re.sub(r",(\s*[}\]])", r"\1", raw)
    return json.loads(cleaned)


# ─── Single-stage completion with JSON retry ────────────────────────────────


def _complete_json(
    *,
    openrouter_complete: Callable[..., Any],
    stage: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
) -> Any:
    """Call OpenRouter and parse the response as JSON, retrying once on failure.

    Raises ``ExamForecastError`` if the call returns an error string (model
    unavailable, rate-limited, etc.) or if both attempts fail to parse.
    """
    started = time.monotonic()
    resp = openrouter_complete(
        model, messages, max_tokens=max_tokens, temperature=temperature
    )
    text = (getattr(resp, "text", "") or "").strip()
    logger.info(
        "exam_forecast stage=%s model=%s duration=%.1fs out_chars=%d",
        stage,
        model,
        time.monotonic() - started,
        len(text),
    )
    if not text:
        raise ExamForecastError(stage, model, "empty response")
    if _looks_like_error_message(text):
        raise ExamForecastError(stage, model, text[:200])
    try:
        return _parse_json_loose(text)
    except Exception as exc:
        # Retry once with an explicit corrective instruction.
        retry_msgs = list(messages) + [
            {
                "role": "assistant",
                "content": text[:4000],
            },
            {
                "role": "user",
                "content": (
                    "Your previous reply was not valid JSON. "
                    "Reply now with ONLY a single JSON object (or array if asked), "
                    "no commentary, no markdown code fences."
                ),
            },
        ]
        retry = openrouter_complete(
            model, retry_msgs, max_tokens=max_tokens, temperature=temperature
        )
        retry_text = (getattr(retry, "text", "") or "").strip()
        if not retry_text or _looks_like_error_message(retry_text):
            raise ExamForecastError(
                stage, model, f"JSON parse failed twice: {exc}"
            ) from exc
        try:
            return _parse_json_loose(retry_text)
        except Exception as exc2:
            raise ExamForecastError(
                stage, model, f"JSON parse failed twice: {exc2}"
            ) from exc2


_ERROR_HINTS = (
    "API not ready",
    "OpenRouter API key missing",
    "I'm taking a short break",
    "Alex had a small error",
)


def _looks_like_error_message(text: str) -> bool:
    """Detect the friendly error strings returned by ``_openrouter_complete``.

    These come back as ``_LLMTextResponse(text=...)`` instead of a real
    completion, so they parse as plain text rather than JSON. We treat them
    as fatal so the pipeline fails fast with the model slug in the error.
    """
    t = text.lower()
    if any(hint.lower() in t for hint in _ERROR_HINTS):
        return True
    # 4xx/5xx status messages from _friendly_openrouter_http_error.
    if re.match(r"^(http|status|error|rate)\b", t):
        return True
    return False


# ─── PDF text extraction (delegated to uni_app's existing helper) ───────────


def extract_pdf_text(
    file_bytes: bytes,
    filename: str,
    *,
    pdf_extractor: Callable[[bytes], str],
) -> str:
    """Extract text from one PDF using the host app's existing extractor.

    The extractor (``_extract_pdf_text`` in uni_app.py) handles digital PDFs
    via PyMuPDF and falls back to vision OCR for scanned papers. We accept it
    as a parameter to keep this module decoupled and unit-testable.
    """
    if not file_bytes:
        return ""
    text = pdf_extractor(file_bytes) or ""
    return text.strip()


# ─── Stage 2: structure raw paper text into question JSON ───────────────────


_STRUCTURE_SYSTEM = """You are an exam-paper structuring engine. You receive the raw text of one university past paper. Your job is to extract every question into clean structured JSON.

Output ONLY one JSON object, no markdown, no commentary. Schema:

{
  "year_hint": "<year string from paper if present, else empty>",
  "course_or_module": "<course/module title or code if present, else empty>",
  "section_structure": "<short string e.g. 'A: 5 short, B: 3 long' or empty>",
  "questions": [
    {
      "section": "",
      "question_number": "",
      "question": "<full question text, preserve sub-parts (a)(b)(c) inline with newlines>",
      "marks": "",
      "topic": "<your best inference of the topic>",
      "subtopic": "<finer-grained subtopic if clear, else empty>",
      "difficulty": "Easy | Medium | Hard",
      "question_type": "theory | calculation | derivation | proof | coding | case_study | mixed",
      "repeated_pattern_signal": "<short note if the wording or structure suggests a recurring examiner pattern, else empty>",
      "has_diagram": false,
      "has_table": false,
      "examiner_wording_style": "<short note on phrasing style if distinctive, else empty>"
    }
  ]
}

Rules:
- Preserve every sub-part. If question 3 has (a)(b)(c), include them all in the question text with explicit "(a)", "(b)", "(c)" prefixes.
- If marks are written like "[10]" or "(10 marks)", normalize to just the integer string, e.g. "10".
- Never invent questions. If the input text is partial or OCR-garbled, extract only what is clearly present.
- If the paper has section headings (Section A / Section B), put them in the section field.
- Empty string fields are preferred over omitted keys.
"""


def parse_past_paper_questions(
    *,
    openrouter_complete: Callable[..., Any],
    paper_text: str,
    year_hint: str = "",
) -> dict[str, Any]:
    """Structure one past paper's text into question JSON via the extraction model."""
    if not paper_text.strip():
        return {
            "year_hint": year_hint,
            "course_or_module": "",
            "section_structure": "",
            "questions": [],
        }
    user_msg = (
        f"Year hint: {year_hint or '(none)'}\n\n"
        f"Paper text follows. Extract questions as JSON.\n\n"
        f"---\n{paper_text}\n---"
    )
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage="structure_questions",
        model=EXAM_FORECAST_EXTRACTION_MODEL,
        messages=[
            {"role": "system", "content": _STRUCTURE_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        max_tokens=MAX_TOKENS_STRUCTURE,
        temperature=TEMP_EXTRACT,
    )


# ─── Stage 3: long-context corpus review ────────────────────────────────────


_CORPUS_SYSTEM = """You are an examiner-style pattern auditor reviewing a corpus of past papers (plus any syllabus, marking schemes, and optional student-provided exam context) for one university module.

Output ONLY one JSON object, schema:

{
  "course_name": "",
  "years_covered": [],
  "section_structure_summary": "",
  "marks_distribution_summary": "",
  "question_type_balance": {
    "theory": 0,
    "calculation": 0,
    "derivation": 0,
    "proof": 0,
    "coding": 0,
    "case_study": 0,
    "mixed": 0
  },
  "topic_frequency": [
    {"topic": "", "appearances": 0, "years": []}
  ],
  "repeated_topics": [],
  "ignored_or_skipped_topics": [],
  "topic_rotation_notes": "",
  "weakly_tested_topics_likely_to_appear": [],
  "examiner_style_notes": "",
  "syllabus_coverage_assessment": ""
}

Rules:
- Only count topics that actually appear in the structured paper data — never invent.
- ignored_or_skipped_topics: topics present in syllabus but missing from past papers (only valid if syllabus is provided).
- weakly_tested_topics_likely_to_appear: topics appearing once across the corpus; flag as candidates for the next paper.
- Do not produce a predicted paper here — only analysis.
"""


def analyze_corpus_patterns(
    *,
    openrouter_complete: Callable[..., Any],
    structured_papers: list[dict[str, Any]],
    syllabus_text: str = "",
    marking_texts: Optional[list[str]] = None,
    exam_details: str = "",
) -> dict[str, Any]:
    """Run the long-context corpus review pass.

    ``exam_details`` is optional free-text context supplied by the student
    (university, module name, professor, exam type, topics emphasized, etc.).
    It's treated as additional grounding — empty strings are fine and the
    rest of the pipeline behaves identically.
    """
    marking_texts = marking_texts or []
    corpus_payload = {
        "structured_past_papers": structured_papers,
        "syllabus_text_excerpt": _trim(syllabus_text, 18000),
        "marking_schemes_text_excerpt": [_trim(t, 6000) for t in marking_texts],
        "student_provided_exam_context": _trim(exam_details, 4000),
    }
    user_msg = (
        "Review this corpus and produce the JSON analysis described in the system message.\n"
        "If `student_provided_exam_context` is present, use it to disambiguate the course, "
        "professor style, or emphasized topics — but never invent facts that aren't in the papers.\n\n"
        f"{json.dumps(corpus_payload, ensure_ascii=False)}"
    )
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage="corpus_review",
        model=EXAM_FORECAST_LONG_CONTEXT_MODEL,
        messages=[
            {"role": "system", "content": _CORPUS_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        max_tokens=MAX_TOKENS_CORPUS,
        temperature=TEMP_PATTERN,
    )


# ─── Stages 4 & 5: independent predictions (pattern + rival) ────────────────


_PATTERN_SYSTEM = """You are a senior university examiner predicting the next exam paper for a single module, using only the structured past-paper data and the corpus analysis below.

Output ONLY one JSON object, schema:

{
  "course_name": "",
  "paper_title": "",
  "exam_pattern_summary": "",
  "likely_topics": [
    {
      "topic": "",
      "subtopics": [],
      "reason": "",
      "confidence": "High | Medium | Low",
      "evidence_from_years": []
    }
  ],
  "marks_distribution": {
    "summary": "",
    "predicted_sections": [
      {"section": "", "marks": "", "question_count": 0}
    ]
  },
  "predicted_paper": [
    {
      "section": "",
      "question_number": "",
      "question": "",
      "marks": "",
      "topic": "",
      "question_type": "",
      "reason": "",
      "confidence": "High | Medium | Low"
    }
  ],
  "examiner_style_notes": ""
}

Reasoning rules:
- Prefer topics with the highest historical appearance frequency AND topics flagged as "weakly tested but likely".
- Mirror the historical section structure and marks distribution exactly unless the corpus shows a clear rotation pattern.
- Mirror the examiner's wording style (terse vs. verbose, "Discuss" vs "Derive" vs "Calculate").
- Confidence:
  - High = strong, multi-year direct evidence.
  - Medium = inferred from rotation, syllabus weight, or single-year evidence.
  - Low = informed guess; flag honestly rather than overclaim.
- Never invent a topic that is not in the corpus or syllabus.
- Predicted paper length must match the historical paper length (same total marks, same question count, same section split).
"""


_RIVAL_SYSTEM = (
    _PATTERN_SYSTEM
    + "\n\nAdditional instructions for this independent prediction pass:\n"
    "- Do not assume any specific other model's reasoning.\n"
    "- Bias toward topics with the strongest multi-year evidence even if obvious.\n"
    "- Produce your own independent prediction without reference to any prior reply."
)


def _build_prediction_payload(
    structured_papers: list[dict[str, Any]],
    corpus_analysis: dict[str, Any],
    syllabus_text: str,
    exam_details: str = "",
) -> str:
    payload = {
        "structured_past_papers": structured_papers,
        "corpus_analysis": corpus_analysis,
        "syllabus_text_excerpt": _trim(syllabus_text, 12000),
        "student_provided_exam_context": _trim(exam_details, 4000),
    }
    return json.dumps(payload, ensure_ascii=False)


def _generate_prediction(
    *,
    openrouter_complete: Callable[..., Any],
    stage: str,
    model: str,
    system_prompt: str,
    structured_papers: list[dict[str, Any]],
    corpus_analysis: dict[str, Any],
    syllabus_text: str,
    exam_details: str = "",
) -> dict[str, Any]:
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage=stage,
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    "Produce the predicted-paper JSON now. If `student_provided_exam_context` "
                    "is non-empty, use it to ground your prediction (course, professor style, "
                    "topics emphasized) but never invent facts not in the papers.\n\n"
                    + _build_prediction_payload(
                        structured_papers, corpus_analysis, syllabus_text, exam_details
                    )
                ),
            },
        ],
        max_tokens=MAX_TOKENS_PREDICT,
        temperature=TEMP_PREDICT,
    )


# ─── Stage 6: consensus merge ───────────────────────────────────────────────


_CONSENSUS_SYSTEM = """You are merging two independent predicted-paper drafts (Prediction A and Prediction B) into one final consensus prediction.

Output ONLY one JSON object, same schema as the input predictions plus an "answer_guide" array:

{
  "course_name": "",
  "paper_title": "",
  "exam_pattern_summary": "",
  "likely_topics": [...],
  "marks_distribution": {...},
  "predicted_paper": [...],
  "answer_guide": [
    {
      "question_ref": "",
      "answer_outline": "",
      "marking_notes": ""
    }
  ],
  "examiner_style_notes": "",
  "consensus_notes": ""
}

Merge rules:
- Where A and B propose the same topic for the same section/slot, keep it with confidence raised one level (Low->Medium, Medium->High).
- Where they disagree, pick the option with stronger evidence_from_years and confidence; lower the confidence one level to honestly reflect uncertainty.
- Preserve the historical marks distribution and section count exactly.
- Generate one answer_guide entry per predicted_paper question. Outlines are concise (3-6 bullet points worth of content as a single string with "\\n- " separators).
- Add consensus_notes explaining where A and B agreed and where they didn't.
- Never invent topics that neither A nor B mentioned.
"""


def _merge_predictions(
    *,
    openrouter_complete: Callable[..., Any],
    pattern_prediction: dict[str, Any],
    rival_prediction: dict[str, Any],
    corpus_analysis: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "prediction_A": pattern_prediction,
        "prediction_B": rival_prediction,
        "corpus_analysis": corpus_analysis,
    }
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage="consensus",
        model=EXAM_FORECAST_CONSENSUS_MODEL,
        messages=[
            {"role": "system", "content": _CONSENSUS_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Merge the two predictions into a single consensus prediction now.\n\n"
                    + json.dumps(payload, ensure_ascii=False)
                ),
            },
        ],
        max_tokens=MAX_TOKENS_POLISH,
        temperature=TEMP_PREDICT,
    )


# ─── Stage 7: examiner judge ────────────────────────────────────────────────


_JUDGE_SYSTEM = """You are a strict university examiner reviewing a proposed mock exam paper.

You are given:
- the proposed predicted_paper (with answer_guide),
- the corpus_analysis of the historical past papers.

Output ONLY one JSON object, schema:

{
  "matches_past_paper_style": true,
  "marks_are_realistic": true,
  "questions_too_generic_count": 0,
  "topics_overrepresented": [],
  "syllabus_topics_missing": [],
  "feels_like_next_paper": true,
  "overall_quality": "Excellent | Good | Fair | Poor",
  "improvement_suggestions": [
    {"target": "<section/question_number or 'global'>", "issue": "", "fix": ""}
  ]
}

Be strict but honest. If everything is fine, improvement_suggestions can be empty.
"""


def _judge_prediction(
    *,
    openrouter_complete: Callable[..., Any],
    consensus_prediction: dict[str, Any],
    corpus_analysis: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "predicted_paper_draft": consensus_prediction,
        "corpus_analysis": corpus_analysis,
    }
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage="judge",
        model=EXAM_FORECAST_JUDGE_MODEL,
        messages=[
            {"role": "system", "content": _JUDGE_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Review the draft and produce the judge JSON now.\n\n"
                    + json.dumps(payload, ensure_ascii=False)
                ),
            },
        ],
        max_tokens=MAX_TOKENS_JUDGE,
        temperature=TEMP_JUDGE,
    )


# ─── Stage 8: final polish ──────────────────────────────────────────────────


_POLISH_SYSTEM = """You apply judge feedback to the consensus predicted paper and produce the final shipping JSON.

Output ONLY one JSON object, this exact final schema:

{
  "course_name": "",
  "paper_title": "",
  "exam_pattern_summary": "",
  "historical_backtest_score": null,
  "score_breakdown": {
    "topic_overlap": null,
    "marks_distribution": null,
    "question_type_match": null,
    "section_structure": null,
    "difficulty_match": null
  },
  "likely_topics": [
    {
      "topic": "",
      "subtopics": [],
      "reason": "",
      "confidence": "High | Medium | Low",
      "evidence_from_years": []
    }
  ],
  "marks_distribution": {
    "summary": "",
    "predicted_sections": [
      {"section": "", "marks": "", "question_count": 0}
    ]
  },
  "predicted_paper": [
    {
      "section": "",
      "question_number": "",
      "question": "",
      "marks": "",
      "topic": "",
      "question_type": "",
      "reason": "",
      "confidence": "High | Medium | Low"
    }
  ],
  "answer_guide": [
    {
      "question_ref": "",
      "answer_outline": "",
      "marking_notes": ""
    }
  ],
  "examiner_style_notes": "",
  "confidence_notes": "",
  "disclaimer": "This is a pattern-based mock paper, not a guaranteed future exam paper."
}

Rules:
- Leave historical_backtest_score and score_breakdown values as null. They are computed deterministically downstream.
- Apply every judge improvement_suggestions item. If a suggestion is global, address it across the paper.
- Keep predicted_paper length and section structure identical to the consensus draft unless the judge explicitly flagged it.
- Confidence levels should reflect both the consensus draft and the judge's verdict honestly. Do not raise confidence beyond what evidence supports.
- The disclaimer string MUST be the exact text shown above.
"""


def _final_polish(
    *,
    openrouter_complete: Callable[..., Any],
    consensus_prediction: dict[str, Any],
    judge_report: dict[str, Any],
) -> dict[str, Any]:
    payload = {
        "consensus_prediction": consensus_prediction,
        "judge_report": judge_report,
    }
    return _complete_json(
        openrouter_complete=openrouter_complete,
        stage="final_polish",
        model=EXAM_FORECAST_FINAL_POLISH_MODEL,
        messages=[
            {"role": "system", "content": _POLISH_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Apply judge feedback and produce the final shipping JSON now.\n\n"
                    + json.dumps(payload, ensure_ascii=False)
                ),
            },
        ],
        max_tokens=MAX_TOKENS_POLISH,
        temperature=TEMP_POLISH,
    )


# ─── Similarity scoring (deterministic, no AI) ──────────────────────────────


def _norm_topic(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _topic_overlap(
    predicted: list[dict[str, Any]], actual: list[dict[str, Any]]
) -> float:
    p = {_norm_topic(q.get("topic", "")) for q in predicted if q.get("topic")}
    a = {_norm_topic(q.get("topic", "")) for q in actual if q.get("topic")}
    return _jaccard(p, a)


def _to_int_marks(value: Any) -> int:
    try:
        m = re.search(r"\d+", str(value or ""))
        return int(m.group(0)) if m else 0
    except Exception:
        return 0


def _marks_distribution_similarity(
    predicted: list[dict[str, Any]], actual: list[dict[str, Any]]
) -> float:
    """Compare marks histograms; 1.0 means identical, 0.0 means no overlap."""
    p_marks = sorted(_to_int_marks(q.get("marks")) for q in predicted)
    a_marks = sorted(_to_int_marks(q.get("marks")) for q in actual)
    if not p_marks and not a_marks:
        return 1.0
    if not p_marks or not a_marks:
        return 0.0
    # Bucket by mark value: similarity = sum(min counts) / sum(max counts).
    def hist(xs: list[int]) -> dict[int, int]:
        h: dict[int, int] = {}
        for x in xs:
            h[x] = h.get(x, 0) + 1
        return h

    hp, ha = hist(p_marks), hist(a_marks)
    keys = set(hp) | set(ha)
    if not keys:
        return 0.0
    num = sum(min(hp.get(k, 0), ha.get(k, 0)) for k in keys)
    den = sum(max(hp.get(k, 0), ha.get(k, 0)) for k in keys)
    return num / den if den else 0.0


def _question_type_match(
    predicted: list[dict[str, Any]], actual: list[dict[str, Any]]
) -> float:
    p = {(q.get("question_type") or "").strip().lower() for q in predicted}
    a = {(q.get("question_type") or "").strip().lower() for q in actual}
    p.discard("")
    a.discard("")
    return _jaccard(p, a)


def _section_structure_match(
    predicted: list[dict[str, Any]], actual: list[dict[str, Any]]
) -> float:
    p = {(q.get("section") or "").strip().lower() for q in predicted}
    a = {(q.get("section") or "").strip().lower() for q in actual}
    p.discard("")
    a.discard("")
    if not p and not a:
        return 1.0
    return _jaccard(p, a)


_DIFF_RANK = {"easy": 0, "medium": 1, "hard": 2}


def _difficulty_match(
    predicted: list[dict[str, Any]], actual: list[dict[str, Any]]
) -> float:
    """Mean absolute difference between sorted difficulty ranks, normalized."""

    def ranks(xs: list[dict[str, Any]]) -> list[int]:
        return sorted(
            _DIFF_RANK.get((q.get("difficulty") or "").strip().lower(), 1) for q in xs
        )

    pr, ar = ranks(predicted), ranks(actual)
    if not pr and not ar:
        return 1.0
    if not pr or not ar:
        return 0.0
    # Align lengths by truncation/padding to shorter list.
    n = min(len(pr), len(ar))
    if n == 0:
        return 0.0
    diffs = [abs(pr[i] - ar[i]) for i in range(n)]
    # Max possible diff per slot is 2 (easy<->hard). Normalize.
    return 1.0 - (sum(diffs) / (2 * n))


def similarity_score(
    predicted_questions: list[dict[str, Any]],
    actual_questions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compute a deterministic similarity score for backtest evidence.

    Weights are conservative and explained in the result. We never claim
    the predicted paper IS the actual paper — these are pattern-overlap
    metrics on uploaded historical data only.
    """
    topic = _topic_overlap(predicted_questions, actual_questions)
    marks = _marks_distribution_similarity(predicted_questions, actual_questions)
    qtype = _question_type_match(predicted_questions, actual_questions)
    section = _section_structure_match(predicted_questions, actual_questions)
    difficulty = _difficulty_match(predicted_questions, actual_questions)
    # Weights: topic and marks are highest signal.
    overall = (
        0.35 * topic
        + 0.25 * marks
        + 0.15 * qtype
        + 0.15 * section
        + 0.10 * difficulty
    )
    return {
        "historical_backtest_score": round(overall * 100, 1),
        "score_breakdown": {
            "topic_overlap": round(topic * 100, 1),
            "marks_distribution": round(marks * 100, 1),
            "question_type_match": round(qtype * 100, 1),
            "section_structure": round(section * 100, 1),
            "difficulty_match": round(difficulty * 100, 1),
        },
    }


# ─── Pipeline orchestrator ──────────────────────────────────────────────────


def _trim(text: str, max_chars: int) -> str:
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rsplit(" ", 1)[0] + "\n[truncated]"


def _normalize_final(result: dict[str, Any]) -> dict[str, Any]:
    """Ensure required keys exist; never raise."""
    result.setdefault("course_name", "")
    result.setdefault("paper_title", "")
    result.setdefault("exam_pattern_summary", "")
    result.setdefault("historical_backtest_score", None)
    result.setdefault(
        "score_breakdown",
        {
            "topic_overlap": None,
            "marks_distribution": None,
            "question_type_match": None,
            "section_structure": None,
            "difficulty_match": None,
        },
    )
    result.setdefault("likely_topics", [])
    result.setdefault(
        "marks_distribution",
        {"summary": "", "predicted_sections": []},
    )
    result.setdefault("predicted_paper", [])
    result.setdefault("answer_guide", [])
    result.setdefault("examiner_style_notes", "")
    result.setdefault("confidence_notes", "")
    result["disclaimer"] = DISCLAIMER
    return result


def run_pipeline(
    *,
    openrouter_complete: Callable[..., Any],
    pdf_extractor: Callable[[bytes], str],
    past_papers: list[tuple[str, bytes]],
    syllabus: Optional[tuple[str, bytes]] = None,
    marking_schemes: Optional[list[tuple[str, bytes]]] = None,
    exam_details: str = "",
    run_backtest: bool = True,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> dict[str, Any]:
    """Run the full Smart Exam Forecast pipeline.

    Parameters
    ----------
    openrouter_complete
        Injected callable that wraps OpenRouter chat completions. Must return
        an object with a ``.text`` string attribute. Signature:
        ``(model, messages, max_tokens=N, temperature=T) -> obj``.
    pdf_extractor
        Injected callable that takes PDF bytes and returns extracted text
        (``_extract_pdf_text`` from uni_app.py — handles digital + scanned).
    past_papers
        List of (filename, bytes) tuples. 3-5 required; UI enforces.
    syllabus, marking_schemes
        Optional inputs.
    exam_details
        Optional free-text context from the student — university, module name,
        professor, exam type, emphasized topics, notes. Empty string is fine.
        Threaded into corpus review + both prediction passes + backtest.
    run_backtest
        If True and >=4 past papers, runs a leave-one-out backtest first.
    progress_cb
        Optional callable for progress messages ("Extracting…", "Analyzing…",
        etc.). Called between stages.

    Returns
    -------
    dict matching the final schema (see ``_normalize_final``).
    """
    marking_schemes = marking_schemes or []

    def _progress(msg: str) -> None:
        if progress_cb:
            try:
                progress_cb(msg)
            except Exception:
                pass

    # ── Stage 1: extract text from every PDF ───────────────────────────
    _progress("Reading past papers…")
    paper_texts: list[tuple[str, str]] = []
    for filename, file_bytes in past_papers:
        text = extract_pdf_text(file_bytes, filename, pdf_extractor=pdf_extractor)
        paper_texts.append((filename, text))

    syllabus_text = ""
    if syllabus is not None:
        s_name, s_bytes = syllabus
        syllabus_text = extract_pdf_text(s_bytes, s_name, pdf_extractor=pdf_extractor)

    marking_texts: list[str] = []
    for name, data in marking_schemes:
        t = extract_pdf_text(data, name, pdf_extractor=pdf_extractor)
        if t:
            marking_texts.append(t)

    # Sanity: at least one paper must produce text.
    if not any(t for _, t in paper_texts):
        raise ExamForecastError(
            "extract_pdf_text",
            "PyMuPDF/vision-ocr",
            "no readable text extracted from any uploaded paper",
        )

    # ── Stage 2: structure each paper to JSON ──────────────────────────
    structured_papers: list[dict[str, Any]] = []
    extractable = [(fn, tx) for fn, tx in paper_texts if tx]
    total_papers = len(extractable)
    for i, (filename, text) in enumerate(extractable, start=1):
        _progress(f"Structuring questions ({i}/{total_papers})…")
        year_hint = _guess_year(filename, text)
        structured = parse_past_paper_questions(
            openrouter_complete=openrouter_complete,
            paper_text=_trim(text, 24000),
            year_hint=year_hint,
        )
        structured.setdefault("source_filename", filename)
        structured.setdefault("year_hint", year_hint)
        structured_papers.append(structured)

    if not structured_papers:
        raise ExamForecastError(
            "structure_questions",
            EXAM_FORECAST_EXTRACTION_MODEL,
            "no papers could be structured",
        )

    # ── Optional backtest: leave the most-recent year out, predict it ─
    backtest_score: Optional[dict[str, Any]] = None
    if run_backtest and len(structured_papers) >= 4:
        _progress("Running leave-one-out backtest on uploaded papers…")
        try:
            backtest_score = _run_backtest_inner(
                openrouter_complete=openrouter_complete,
                structured_papers=structured_papers,
                syllabus_text=syllabus_text,
                marking_texts=marking_texts,
                exam_details=exam_details,
            )
        except ExamForecastError as exc:
            # Backtest failure must not kill the main forecast — note and continue.
            logger.warning(
                "backtest unavailable stage=%s model=%s detail=%s",
                exc.stage,
                exc.model,
                exc.detail,
            )
            backtest_score = None

    # ── Stage 3: corpus review ─────────────────────────────────────────
    _progress("Analyzing corpus patterns…")
    corpus_analysis = analyze_corpus_patterns(
        openrouter_complete=openrouter_complete,
        structured_papers=structured_papers,
        syllabus_text=syllabus_text,
        marking_texts=marking_texts,
        exam_details=exam_details,
    )

    # ── Stages 4 & 5: independent predictions ──────────────────────────
    _progress("Generating primary prediction (Claude-tier)…")
    pattern_prediction = _generate_prediction(
        openrouter_complete=openrouter_complete,
        stage="pattern_prediction",
        model=EXAM_FORECAST_PATTERN_MODEL,
        system_prompt=_PATTERN_SYSTEM,
        structured_papers=structured_papers,
        corpus_analysis=corpus_analysis,
        syllabus_text=syllabus_text,
        exam_details=exam_details,
    )

    _progress("Generating rival prediction (GPT-tier)…")
    rival_prediction = _generate_prediction(
        openrouter_complete=openrouter_complete,
        stage="rival_prediction",
        model=EXAM_FORECAST_RIVAL_MODEL,
        system_prompt=_RIVAL_SYSTEM,
        structured_papers=structured_papers,
        corpus_analysis=corpus_analysis,
        syllabus_text=syllabus_text,
        exam_details=exam_details,
    )

    # ── Stage 6: consensus merge ───────────────────────────────────────
    _progress("Merging consensus prediction…")
    consensus = _merge_predictions(
        openrouter_complete=openrouter_complete,
        pattern_prediction=pattern_prediction,
        rival_prediction=rival_prediction,
        corpus_analysis=corpus_analysis,
    )

    # ── Stage 7: judge ─────────────────────────────────────────────────
    _progress("Examiner judge reviewing draft…")
    judge_report = _judge_prediction(
        openrouter_complete=openrouter_complete,
        consensus_prediction=consensus,
        corpus_analysis=corpus_analysis,
    )

    # ── Stage 8: final polish ──────────────────────────────────────────
    _progress("Applying judge feedback and finalizing…")
    final = _final_polish(
        openrouter_complete=openrouter_complete,
        consensus_prediction=consensus,
        judge_report=judge_report,
    )

    final = _normalize_final(final)

    # Attach deterministic backtest result if we have one.
    if backtest_score is not None:
        final["historical_backtest_score"] = backtest_score[
            "historical_backtest_score"
        ]
        final["score_breakdown"] = backtest_score["score_breakdown"]

    # Always pin the canonical disclaimer.
    final["disclaimer"] = DISCLAIMER

    _progress("Done.")
    return final


def _run_backtest_inner(
    *,
    openrouter_complete: Callable[..., Any],
    structured_papers: list[dict[str, Any]],
    syllabus_text: str,
    marking_texts: list[str],
    exam_details: str = "",
) -> dict[str, Any]:
    """Leave-one-out: use all-but-last to predict the last, then score."""
    held_out = structured_papers[-1]
    held_in = structured_papers[:-1]
    if not held_in:
        raise ExamForecastError("backtest", "n/a", "not enough papers")

    # Reuse the same prediction pipeline, but only run pattern + consensus
    # (skip rival + judge + polish) to keep backtest cost ~half of the main run.
    held_in_corpus = analyze_corpus_patterns(
        openrouter_complete=openrouter_complete,
        structured_papers=held_in,
        syllabus_text=syllabus_text,
        marking_texts=marking_texts,
        exam_details=exam_details,
    )
    held_in_prediction = _generate_prediction(
        openrouter_complete=openrouter_complete,
        stage="backtest_pattern",
        model=EXAM_FORECAST_PATTERN_MODEL,
        system_prompt=_PATTERN_SYSTEM,
        structured_papers=held_in,
        corpus_analysis=held_in_corpus,
        syllabus_text=syllabus_text,
        exam_details=exam_details,
    )
    predicted_questions = held_in_prediction.get("predicted_paper") or []
    actual_questions = held_out.get("questions") or []
    return similarity_score(predicted_questions, actual_questions)


_YEAR_RE = re.compile(r"(20\d{2})")


def _guess_year(filename: str, text: str) -> str:
    """Best-effort year extraction from filename then first 1500 chars of text."""
    fn_match = _YEAR_RE.search(filename or "")
    if fn_match:
        return fn_match.group(1)
    head = (text or "")[:1500]
    t_match = _YEAR_RE.search(head)
    return t_match.group(1) if t_match else ""


# ─── PDF export (ReportLab — deterministic, no AI) ──────────────────────────


def _build_pdf(out: Any, title: str, sections: list[tuple[str, list[Any]]]) -> None:
    """Render a list of (heading, flowable-content) sections to *out*.

    ``out`` may be a filesystem path (str) OR any writable binary file-like
    object (e.g. ``io.BytesIO``). ReportLab's ``SimpleDocTemplate`` accepts
    both — this lets us generate PDFs in memory without touching disk.

    Each item in ``sections[i][1]`` is either a string (rendered as a
    ReportLab Paragraph; the string may contain a small XML subset including
    ``<b>``/``<i>``/``<br/>``, with user-supplied substrings already escaped
    via ``_p_safe``) or a ``reportlab.platypus.Flowable`` instance.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib.colors import HexColor
    from reportlab.platypus import (
        SimpleDocTemplate,
        Paragraph,
        Spacer,
        PageBreak,
        Flowable,
    )

    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=title,
    )
    base = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "AlexTitle",
        parent=base["Title"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=HexColor("#0a0a0c"),
        spaceAfter=6,
    )
    subtitle_style = ParagraphStyle(
        "AlexSubtitle",
        parent=base["Normal"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=HexColor("#475569"),
        spaceAfter=12,
    )
    heading_style = ParagraphStyle(
        "AlexHeading",
        parent=base["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=16,
        textColor=HexColor("#0a0a0c"),
        spaceBefore=10,
        spaceAfter=6,
    )
    body_style = ParagraphStyle(
        "AlexBody",
        parent=base["BodyText"],
        fontName="Helvetica",
        fontSize=10.5,
        leading=14,
        textColor=HexColor("#1f2937"),
        spaceAfter=4,
    )
    disclaimer_style = ParagraphStyle(
        "AlexDisclaimer",
        parent=base["BodyText"],
        fontName="Helvetica-Oblique",
        fontSize=9,
        leading=12,
        textColor=HexColor("#6b7280"),
        spaceBefore=16,
    )

    # Strings passed in `sections` are treated as ReportLab Paragraph markup
    # (a tiny XML subset including <b>, <i>, <br/>). Callers MUST escape any
    # untrusted user-supplied substrings with ``_p_safe()`` before embedding
    # them inside formatted strings — see export_predicted_paper_pdf below.
    story: list[Any] = [
        Paragraph(_p_safe(title), title_style),
        Paragraph(
            "Smart Exam Forecast — pattern-based mock paper generated by Alex Studies",
            subtitle_style,
        ),
    ]
    for heading, items in sections:
        if heading:
            story.append(Paragraph(_p_safe(heading), heading_style))
        for item in items:
            if isinstance(item, Flowable):
                story.append(item)
            elif isinstance(item, str):
                # `item` is expected to already contain safe-escaped substrings
                # plus optional <b>/<i>/<br/> markup. Convert literal newlines
                # to <br/> for paragraph line breaks.
                story.append(Paragraph(item.replace("\n", "<br/>"), body_style))
            elif item is None:
                story.append(Spacer(1, 4 * mm))
            # else: silently skip unknown types
    story.append(Paragraph(_p_safe(DISCLAIMER), disclaimer_style))
    doc.build(story)


_HTML_ESCAPE = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
}


def _p_safe(s: Any) -> str:
    """Escape `&`, `<`, `>` for safe embedding inside a ReportLab Paragraph.

    Use this on every untrusted substring before concatenating it into a
    formatted string that contains ``<b>...</b>``/``<i>...</i>`` markup.
    """
    out = "" if s is None else str(s)
    for k, v in _HTML_ESCAPE.items():
        out = out.replace(k, v)
    return out


def export_predicted_paper_pdf(result: dict[str, Any], out: Any) -> None:
    """Render the predicted mock paper to a PDF.

    ``out`` may be a filesystem path (str) OR a writable binary file-like
    object (e.g. ``io.BytesIO``).
    """
    course = result.get("course_name") or "Predicted Paper"
    paper_title = result.get("paper_title") or "Predicted Mock Paper"
    title = f"{paper_title} — {course}" if course else paper_title

    sections: list[tuple[str, list[Any]]] = []

    pattern_summary = result.get("exam_pattern_summary") or ""
    if pattern_summary:
        sections.append(("Exam pattern summary", [_p_safe(pattern_summary)]))

    marks_dist = result.get("marks_distribution") or {}
    md_summary = marks_dist.get("summary") if isinstance(marks_dist, dict) else ""
    if md_summary:
        sections.append(("Marks distribution", [_p_safe(md_summary)]))

    questions = result.get("predicted_paper") or []
    q_lines: list[Any] = []
    current_section = None
    for q in questions:
        sec = (q.get("section") or "").strip()
        if sec and sec != current_section:
            q_lines.append(f"<b>Section {_p_safe(sec)}</b>")
            current_section = sec
        qn = (q.get("question_number") or "").strip()
        marks_raw = q.get("marks")
        marks = marks_raw.strip() if isinstance(marks_raw, str) else str(marks_raw or "")
        text = q.get("question") or ""
        head = (f"<b>Q{_p_safe(qn)}.</b> " if qn else "<b>Q.</b> ") + _p_safe(text)
        if marks:
            head += f"  [{_p_safe(marks)} marks]"
        q_lines.append(head)
    if q_lines:
        sections.append(("Predicted questions", q_lines))

    likely = result.get("likely_topics") or []
    if likely:
        topic_lines: list[str] = []
        for t in likely:
            topic = (t.get("topic") or "").strip()
            conf = (t.get("confidence") or "").strip()
            reason = (t.get("reason") or "").strip()
            line = f"• <b>{_p_safe(topic)}</b>"
            if conf:
                line += f"  ({_p_safe(conf)} confidence)"
            if reason:
                line += f"\n  {_p_safe(reason)}"
            topic_lines.append(line)
        sections.append(("Most likely topics", topic_lines))

    score = result.get("historical_backtest_score")
    if score is not None:
        bd = result.get("score_breakdown") or {}
        score_lines = [
            f"<b>Overall:</b> {_p_safe(score)}/100",
            f"Topic overlap: {_p_safe(bd.get('topic_overlap'))}/100",
            f"Marks distribution: {_p_safe(bd.get('marks_distribution'))}/100",
            f"Question type match: {_p_safe(bd.get('question_type_match'))}/100",
            f"Section structure: {_p_safe(bd.get('section_structure'))}/100",
            f"Difficulty match: {_p_safe(bd.get('difficulty_match'))}/100",
        ]
        sections.append(("Historical backtest score (leave-one-out on uploaded papers)", score_lines))

    confidence = result.get("confidence_notes") or ""
    if confidence:
        sections.append(("Confidence notes", [_p_safe(confidence)]))

    _build_pdf(out, title, sections)


def export_answer_guide_pdf(result: dict[str, Any], out: Any) -> None:
    """Render the answer guide / marking guide to a PDF.

    ``out`` may be a filesystem path (str) OR a writable binary file-like
    object (e.g. ``io.BytesIO``).
    """
    course = result.get("course_name") or ""
    paper_title = result.get("paper_title") or "Predicted Mock Paper"
    title = f"Answer Guide — {paper_title}" + (f" ({course})" if course else "")
    sections: list[tuple[str, list[Any]]] = []

    guide = result.get("answer_guide") or []
    if not guide:
        sections.append(
            (
                "Answer guide",
                ["No answer guide generated for this run."],
            )
        )
    else:
        items: list[str] = []
        for g in guide:
            ref = (g.get("question_ref") or "").strip()
            outline = (g.get("answer_outline") or "").strip()
            notes = (g.get("marking_notes") or "").strip()
            chunk = f"<b>{_p_safe(ref) or 'Question'}</b>\n{_p_safe(outline)}"
            if notes:
                chunk += f"\n\n<i>Marking notes:</i> {_p_safe(notes)}"
            items.append(chunk)
        sections.append(("Answer guide", items))

    _build_pdf(out, title, sections)


# ─── Module self-check (cheap import-time sanity) ───────────────────────────


def model_slug_summary() -> dict[str, str]:
    """Return current model slugs for the operator/logs."""
    return {
        "extraction": EXAM_FORECAST_EXTRACTION_MODEL,
        "long_context": EXAM_FORECAST_LONG_CONTEXT_MODEL,
        "pattern": EXAM_FORECAST_PATTERN_MODEL,
        "rival": EXAM_FORECAST_RIVAL_MODEL,
        "consensus": EXAM_FORECAST_CONSENSUS_MODEL,
        "judge": EXAM_FORECAST_JUDGE_MODEL,
        "final_polish": EXAM_FORECAST_FINAL_POLISH_MODEL,
    }
