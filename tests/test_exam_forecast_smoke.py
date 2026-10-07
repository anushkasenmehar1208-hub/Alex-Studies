"""Smoke tests for the Smart Exam Forecast feature.

These are intentionally cheap: they exercise the deterministic paths
(PDF rendering, JSON parsing, similarity scoring, prompt assembly)
without hitting OpenRouter. The expensive end-to-end pipeline is left
for manual testing via the running app.

Run from repo root:
    .venv_new/bin/python -m pytest tests/test_exam_forecast_smoke.py -v
or with plain unittest:
    .venv_new/bin/python -m unittest tests.test_exam_forecast_smoke -v
"""

from __future__ import annotations

import io
import json
import os
import sys
import unittest

# Make sure we can import the package from the repo root.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from uni_app import exam_forecast as ef  # noqa: E402


class FakeResp:
    """Minimal stand-in for `_LLMTextResponse`."""

    def __init__(self, text: str):
        self.text = text


def _fake_openrouter_factory(responses_by_stage_or_model):
    """Return a fake `openrouter_complete(model, messages, ...)` that
    looks up a canned JSON string by model slug (or any substring match).
    """
    calls: list[dict] = []

    def _fake(model, messages, max_tokens=2048, temperature=None):
        calls.append({"model": model, "n_msgs": len(messages)})
        for needle, response in responses_by_stage_or_model.items():
            if needle in model:
                return FakeResp(response)
        return FakeResp('{"error": "no canned response for model ' + model + '"}')

    _fake.calls = calls  # type: ignore[attr-defined]
    return _fake


class JsonParseTests(unittest.TestCase):
    def test_strips_fences(self):
        out = ef._parse_json_loose('```json\n{"a": 1}\n```')
        self.assertEqual(out, {"a": 1})

    def test_strips_trailing_commas(self):
        out = ef._parse_json_loose('{"a": [1, 2, 3,], "b": 4,}')
        self.assertEqual(out, {"a": [1, 2, 3], "b": 4})

    def test_finds_balanced_block_with_prefix(self):
        out = ef._parse_json_loose('Here is the JSON: {"x": 99} ok bye.')
        self.assertEqual(out, {"x": 99})

    def test_raises_on_garbage(self):
        with self.assertRaises(ValueError):
            ef._parse_json_loose("not json at all")


class SimilarityScoreTests(unittest.TestCase):
    def test_perfect_match(self):
        questions = [
            {"topic": "Calc", "marks": "10", "question_type": "calculation",
             "section": "A", "difficulty": "Medium"},
            {"topic": "LA", "marks": "20", "question_type": "proof",
             "section": "B", "difficulty": "Hard"},
        ]
        score = ef.similarity_score(questions, questions)
        self.assertEqual(score["historical_backtest_score"], 100.0)

    def test_partial_match(self):
        pred = [{"topic": "Calc", "marks": "10", "question_type": "calculation",
                 "section": "A", "difficulty": "Medium"}]
        actual = [{"topic": "Stats", "marks": "10", "question_type": "calculation",
                   "section": "A", "difficulty": "Medium"}]
        score = ef.similarity_score(pred, actual)
        # Topic differs but everything else matches.
        self.assertEqual(score["score_breakdown"]["topic_overlap"], 0.0)
        self.assertEqual(score["score_breakdown"]["marks_distribution"], 100.0)
        self.assertEqual(score["score_breakdown"]["question_type_match"], 100.0)

    def test_empty_inputs(self):
        # All metrics defined as "1.0 if both empty" — overall is 100.
        score = ef.similarity_score([], [])
        self.assertEqual(score["historical_backtest_score"], 100.0)


class PdfExportTests(unittest.TestCase):
    """Render predicted-paper + answer-guide PDFs in memory.

    We don't validate the byte-perfect output (ReportLab's deterministic
    bytes change between versions); we just confirm the call doesn't
    raise and produces a non-trivial PDF.
    """

    def _sample_result(self) -> dict:
        return {
            "course_name": "Statistics II",
            "paper_title": "Predicted Mock Paper",
            "exam_pattern_summary": "Pattern follows the 2023 split: A=short, B=long.",
            "historical_backtest_score": 72.5,
            "score_breakdown": {
                "topic_overlap": 75.0,
                "marks_distribution": 80.0,
                "question_type_match": 60.0,
                "section_structure": 100.0,
                "difficulty_match": 50.0,
            },
            "likely_topics": [
                {"topic": "Hypothesis testing", "reason": "Appeared in 4/5 years",
                 "confidence": "High", "evidence_from_years": ["2020", "2021", "2022", "2023"]},
                {"topic": "Regression", "reason": "Rotates with ANOVA",
                 "confidence": "Medium", "evidence_from_years": ["2021", "2023"]},
            ],
            "marks_distribution": {
                "summary": "Section A: 40 marks, Section B: 60 marks",
                "predicted_sections": [],
            },
            "predicted_paper": [
                {"section": "A", "question_number": "1",
                 "question": "Define the central limit theorem and state its assumptions.",
                 "marks": "10", "topic": "Sampling",
                 "question_type": "theory", "reason": "Frequent opener",
                 "confidence": "High"},
                {"section": "A", "question_number": "2",
                 "question": "A normal distribution has mean 12 and SD 3...",
                 "marks": "10", "topic": "Probability",
                 "question_type": "calculation", "reason": "Annual pattern",
                 "confidence": "Medium"},
            ],
            "answer_guide": [
                {"question_ref": "Q1",
                 "answer_outline": "Define CLT.\n- State the iid assumption.\n- Sample size threshold.",
                 "marking_notes": "Award 4 for definition, 6 for assumptions."},
            ],
            "examiner_style_notes": "Terse phrasing; prefers 'Discuss' over 'Explain'.",
            "confidence_notes": "Section A predictions are stronger than Section B.",
            "disclaimer": ef.DISCLAIMER,
        }

    def test_predicted_paper_pdf(self):
        buf = io.BytesIO()
        ef.export_predicted_paper_pdf(self._sample_result(), buf)
        data = buf.getvalue()
        # Real PDFs always start with '%PDF-' and end with '%%EOF'.
        self.assertTrue(data.startswith(b"%PDF-"), "missing PDF magic header")
        self.assertGreater(len(data), 1000, "PDF too small to be real")
        self.assertIn(b"%%EOF", data[-1024:], "missing PDF trailer")

    def test_answer_guide_pdf(self):
        buf = io.BytesIO()
        ef.export_answer_guide_pdf(self._sample_result(), buf)
        data = buf.getvalue()
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertGreater(len(data), 500)
        self.assertIn(b"%%EOF", data[-1024:])

    def test_pdf_does_not_break_on_html_chars_in_user_data(self):
        """Predicted text containing <, >, & must not break PDF rendering."""
        result = self._sample_result()
        result["predicted_paper"][0]["question"] = (
            "Evaluate <if x > 5 & y < 3>: write the answer in <b>bold</b>."
        )
        buf = io.BytesIO()
        ef.export_predicted_paper_pdf(result, buf)
        self.assertTrue(buf.getvalue().startswith(b"%PDF-"))


class PipelineOrchestrationTests(unittest.TestCase):
    """End-to-end orchestration test with a faked openrouter_complete.

    Confirms that ``run_pipeline`` correctly threads structured data
    through all 7 stages and produces a final result with the right
    schema fields.
    """

    def test_pipeline_runs_with_fake_models(self):
        # Canned responses keyed by model slug substring.
        structure_json = json.dumps({
            "year_hint": "2023",
            "course_or_module": "Statistics II",
            "section_structure": "A: 4 short, B: 2 long",
            "questions": [
                {"section": "A", "question_number": "1",
                 "question": "Define CLT.", "marks": "10",
                 "topic": "Sampling", "subtopic": "",
                 "difficulty": "Medium", "question_type": "theory",
                 "repeated_pattern_signal": "annual opener",
                 "has_diagram": False, "has_table": False,
                 "examiner_wording_style": "terse"},
            ],
        })
        corpus_json = json.dumps({
            "course_name": "Statistics II",
            "years_covered": ["2023"],
            "section_structure_summary": "A short / B long",
            "marks_distribution_summary": "100 marks total",
            "question_type_balance": {"theory": 1, "calculation": 0,
                                       "derivation": 0, "proof": 0,
                                       "coding": 0, "case_study": 0, "mixed": 0},
            "topic_frequency": [{"topic": "Sampling", "appearances": 1,
                                  "years": ["2023"]}],
            "repeated_topics": ["Sampling"],
            "ignored_or_skipped_topics": [],
            "topic_rotation_notes": "",
            "weakly_tested_topics_likely_to_appear": [],
            "examiner_style_notes": "terse",
            "syllabus_coverage_assessment": "",
        })
        prediction_json = json.dumps({
            "course_name": "Statistics II",
            "paper_title": "Predicted Mock Paper",
            "exam_pattern_summary": "Similar to 2023.",
            "likely_topics": [{"topic": "Sampling", "subtopics": [],
                                "reason": "frequent", "confidence": "High",
                                "evidence_from_years": ["2023"]}],
            "marks_distribution": {"summary": "100 marks",
                                    "predicted_sections": []},
            "predicted_paper": [{"section": "A", "question_number": "1",
                                  "question": "Define CLT.",
                                  "marks": "10", "topic": "Sampling",
                                  "question_type": "theory",
                                  "reason": "annual opener",
                                  "confidence": "High"}],
            "examiner_style_notes": "terse",
        })
        consensus_json = json.dumps({
            "course_name": "Statistics II",
            "paper_title": "Predicted Mock Paper",
            "exam_pattern_summary": "Similar to 2023.",
            "likely_topics": [{"topic": "Sampling", "subtopics": [],
                                "reason": "frequent", "confidence": "High",
                                "evidence_from_years": ["2023"]}],
            "marks_distribution": {"summary": "100 marks",
                                    "predicted_sections": []},
            "predicted_paper": [{"section": "A", "question_number": "1",
                                  "question": "Define CLT.",
                                  "marks": "10", "topic": "Sampling",
                                  "question_type": "theory",
                                  "reason": "annual opener",
                                  "confidence": "High"}],
            "answer_guide": [{"question_ref": "Q1",
                               "answer_outline": "Define CLT then state assumptions.",
                               "marking_notes": "4+6"}],
            "examiner_style_notes": "terse",
            "consensus_notes": "both models agreed",
        })
        judge_json = json.dumps({
            "matches_past_paper_style": True,
            "marks_are_realistic": True,
            "questions_too_generic_count": 0,
            "topics_overrepresented": [],
            "syllabus_topics_missing": [],
            "feels_like_next_paper": True,
            "overall_quality": "Good",
            "improvement_suggestions": [],
        })
        polish_json = json.dumps({
            "course_name": "Statistics II",
            "paper_title": "Predicted Mock Paper",
            "exam_pattern_summary": "Similar to 2023.",
            "historical_backtest_score": None,
            "score_breakdown": {
                "topic_overlap": None, "marks_distribution": None,
                "question_type_match": None, "section_structure": None,
                "difficulty_match": None,
            },
            "likely_topics": [{"topic": "Sampling", "subtopics": [],
                                "reason": "frequent", "confidence": "High",
                                "evidence_from_years": ["2023"]}],
            "marks_distribution": {"summary": "100 marks",
                                    "predicted_sections": []},
            "predicted_paper": [{"section": "A", "question_number": "1",
                                  "question": "Define CLT.",
                                  "marks": "10", "topic": "Sampling",
                                  "question_type": "theory",
                                  "reason": "annual opener",
                                  "confidence": "High"}],
            "answer_guide": [{"question_ref": "Q1",
                               "answer_outline": "Define CLT then state assumptions.",
                               "marking_notes": "4+6"}],
            "examiner_style_notes": "terse",
            "confidence_notes": "",
            "disclaimer": ef.DISCLAIMER,
        })

        # Map model substrings to canned JSON. We use OpenRouter slug
        # substrings so all 7 stages pick up the right response regardless
        # of whether the user overrides via env vars at test time.
        # ORDER MATTERS: "opus" must be checked before "gpt" etc — we use
        # explicit substrings for each provider+role.
        fake = _fake_openrouter_factory({
            "gpt-5.5-pro": prediction_json,  # default extraction/rival/judge
            "gemini-3.1": corpus_json,       # long-context
            "claude-opus": polish_json,      # pattern/consensus/polish
        })
        # Distinct responses per stage: route by message-count heuristic.
        # The cleanest way is to override _complete_json directly. Easier
        # for this smoke test: monkey-patch each stage helper.

        # Override extraction & judge responses (they share gpt-5.5-pro
        # but want different JSON shapes).
        # We'll just inspect call sequence and confirm the pipeline returns
        # the expected fields.
        # For this smoke test, accept that ALL gpt-5.5-pro calls return
        # `prediction_json` — the pipeline will still hit the polish stage
        # and pull `polish_json` from claude-opus, which produces the final
        # result with the right schema fields.

        def _fake_extract(file_bytes: bytes) -> str:
            return "Q1. Define CLT. [10 marks]\nQ2. Calculate probability..."

        # Run with 3 fake "papers" (no backtest -- needs >=4 to trigger).
        papers = [
            ("paper_2021.pdf", b"fake-pdf-bytes-1"),
            ("paper_2022.pdf", b"fake-pdf-bytes-2"),
            ("paper_2023.pdf", b"fake-pdf-bytes-3"),
        ]

        # The default mock returns the SAME json for every gpt-5.5-pro call,
        # which means the structure/rival/judge stages all get prediction_json.
        # The structure stage expects {"questions": [...]} shape -- prediction_json
        # has predicted_paper not questions. So the corpus stage will see an empty
        # questions list. That's actually OK for testing the orchestration path.
        # Override fake to return structure_json for the FIRST 3 calls (one per
        # paper), then switch to prediction_json/etc.
        call_log: list[str] = []
        original_fake = fake

        def _smart_fake(model, messages, max_tokens=2048, temperature=None):
            call_log.append(model)
            # First 3 calls per the pipeline = structure stage (one per paper).
            stage_idx = len(call_log)
            if stage_idx <= 3:
                return FakeResp(structure_json)
            if stage_idx == 4:
                return FakeResp(corpus_json)
            if stage_idx in (5, 6):
                return FakeResp(prediction_json)
            if stage_idx == 7:
                return FakeResp(consensus_json)
            if stage_idx == 8:
                return FakeResp(judge_json)
            if stage_idx == 9:
                return FakeResp(polish_json)
            return FakeResp(polish_json)

        progress: list[str] = []
        result = ef.run_pipeline(
            openrouter_complete=_smart_fake,
            pdf_extractor=_fake_extract,
            past_papers=papers,
            syllabus=None,
            marking_schemes=None,
            run_backtest=False,  # 3 papers can't backtest (need >=4)
            progress_cb=progress.append,
        )

        # Required schema fields present
        for key in ["course_name", "paper_title", "exam_pattern_summary",
                    "likely_topics", "marks_distribution", "predicted_paper",
                    "answer_guide", "disclaimer", "score_breakdown",
                    "historical_backtest_score"]:
            self.assertIn(key, result, f"missing field: {key}")

        # Disclaimer is pinned to the canonical string
        self.assertEqual(result["disclaimer"], ef.DISCLAIMER)

        # Predicted paper survived all stages
        self.assertGreaterEqual(len(result["predicted_paper"]), 1)
        self.assertGreaterEqual(len(result["answer_guide"]), 1)

        # Progress was emitted
        self.assertGreater(len(progress), 4)

        # Total LLM calls: 3 structure + 1 corpus + 2 predictions (pattern + rival)
        # + 1 consensus + 1 judge + 1 polish = 9
        self.assertEqual(len(call_log), 9)


class ModelSlugConfigurationTests(unittest.TestCase):
    def test_slug_summary_has_all_stages(self):
        slugs = ef.model_slug_summary()
        for stage in ("extraction", "long_context", "pattern", "rival",
                      "consensus", "judge", "final_polish"):
            self.assertIn(stage, slugs)
            self.assertTrue(slugs[stage], f"empty slug for {stage}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
