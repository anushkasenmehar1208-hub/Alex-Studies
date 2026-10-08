"""Alex routing, cost control, response quality, cache, output safety, and request logging.

Used by uni_app.send_message — keep free of AppState to avoid import cycles.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict, deque
from difflib import SequenceMatcher
from typing import Any

from .ai_provider import CONFIG as AI_CONFIG
from .alex_openrouter_prompts import ALEX_ROUTER_JSON_PROMPT_V1, ALEX_ROUTER_REFINEMENT_SUFFIX_V1

PREMIUM_FRACTION_MAX = float(os.getenv("ALEX_PREMIUM_GLOBAL_FRACTION_MAX", "0.03"))
PREMIUM_PER_USER_DAILY_MAX = max(0, int(os.getenv("ALEX_PREMIUM_PER_USER_DAILY", "15")))
MAX_QUALITY_RETRIES = 2  # at most 2 extra generations after the first
MAX_VERIFICATION_STREAMS = 1  # one extra model pass if lightweight verify fails

LOG_REQUEST_PERSISTED = os.getenv("ALEX_LOG_REQUEST_PERSISTED", "").strip().lower() in ("1", "true", "yes")
REQUEST_LOG_DB = (
    os.getenv("ALEX_REQUEST_LOG_DB", "").strip()
    or os.path.join(os.path.dirname(__file__), "..", "data", "alex_request_log.sqlite")
)
ROLLING_WINDOW_S = float(os.getenv("ALEX_ROLLING_WINDOW_SECONDS", "3600"))
PREMIUM_ROLLING_1H_MAX = max(0, int(os.getenv("ALEX_PREMIUM_ROLLING_1H_MAX", "120")))
USER_REQUESTS_ROLLING_1H_MAX = max(0, int(os.getenv("ALEX_USER_REQUESTS_ROLLING_1H_MAX", "0")))
EMERGENCY_COST_MODE = os.getenv("ALEX_EMERGENCY_COST_MODE", "").strip().lower() in ("1", "true", "yes")

_REQ_LOG = logging.getLogger("alex.request")

_ROUTING_LOCK = threading.Lock()
_routing_total = 0
_routing_premium = 0

_USER_PREM_LOCK = threading.Lock()
_user_premium_by_day: dict[str, dict[int, int]] = {}

_CACHE_LOCK = threading.Lock()
_ANSWER_CACHE: OrderedDict[tuple[int, str, str], dict[str, Any]] = OrderedDict()
_CACHE_MAX_KEYS = 400

_DECISION_LOCK = threading.Lock()
_RECENT_DECISIONS: deque[dict[str, Any]] = deque(maxlen=500)

_ROLL_LOCK = threading.Lock()
# (timestamp,) per user for request counts
_USER_REQ_1H: dict[int, deque[float]] = {}
# (timestamp, user_id) for global premium calls in window
_GLOBAL_PREM_1H: deque[tuple[float, int]] = deque()

_PERSIST_LOCK = threading.Lock()
_EMERGENCY_SPIKE_LOGGED = False

DEFAULT_ROUTE: dict[str, Any] = {
    "difficulty": "MEDIUM",
    "subject": "general",
    "task_type": "explanation",
    "reasoning_required": False,
    "recommended_model": "teacher",
    "confidence": 0.85,
}

_MODEL_NAME_PATTERNS = re.compile(
    r"(?i)\b("
    r"openrouter|deepseek|anthropic|claude|opus|sonnet|haiku|gpt-4|gpt4|gpt-3\.5|o1|o3|"
    r"llama[\w.-]*|meta[\s-]*ai|mistral|gemini|qwen|grok|cohere|perplexity"
    r")\b"
)


def _today_ymd() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _prune_old_premium_days() -> None:
    k = _today_ymd()
    for d in list(_user_premium_by_day.keys()):
        if d < k:
            _user_premium_by_day.pop(d, None)


def user_premium_count_today(user_id: int) -> int:
    if user_id < 0:
        return 0
    with _USER_PREM_LOCK:
        _prune_old_premium_days()
        return int(_user_premium_by_day.get(_today_ymd(), {}).get(user_id, 0))


def premium_budget_remaining(user_id: int) -> int:
    """Premium calls remaining today for this user under the per-user quota.

    If ``ALEX_PREMIUM_PER_USER_DAILY`` is 0 or negative, per-user cap is disabled (only the
    global premium fraction applies); returns a large sentinel so dashboards read as “unlimited”.
    """
    if user_id < 0:
        return 0
    if PREMIUM_PER_USER_DAILY_MAX <= 0:
        return 999_999 if premium_budget_allows_next() else 0
    used = user_premium_count_today(user_id)
    return max(0, PREMIUM_PER_USER_DAILY_MAX - used)


def premium_budget_allows_next() -> bool:
    """If the next routed request used premium, would rolling global share stay at or under the limit?"""
    with _ROUTING_LOCK:
        tot = _routing_total
        prem = _routing_premium
    return (prem + 1) / max(tot + 1, 1) <= PREMIUM_FRACTION_MAX + 1e-12


def _prune_ts_deque(d: deque[float], now: float) -> None:
    while d and now - d[0] > ROLLING_WINDOW_S:
        d.popleft()


def _prune_prem_deque(now: float) -> None:
    while _GLOBAL_PREM_1H and now - _GLOBAL_PREM_1H[0][0] > ROLLING_WINDOW_S:
        _GLOBAL_PREM_1H.popleft()


def record_rolling_chat_event(user_id: int, used_premium: bool) -> None:
    """Count completed chat turns for rolling-window observability and spike detection."""
    now = time.time()
    with _ROLL_LOCK:
        if user_id >= 0:
            uq = _USER_REQ_1H.setdefault(user_id, deque())
            uq.append(now)
            _prune_ts_deque(uq, now)
        if used_premium and user_id >= 0:
            _GLOBAL_PREM_1H.append((now, user_id))
            _prune_prem_deque(now)


def rolling_1h_usage_tracker(user_id: int) -> int:
    if user_id < 0:
        return 0
    now = time.time()
    with _ROLL_LOCK:
        uq = _USER_REQ_1H.setdefault(user_id, deque())
        _prune_ts_deque(uq, now)
        return len(uq)


def rolling_1h_premium_usage_global() -> int:
    now = time.time()
    with _ROLL_LOCK:
        _prune_prem_deque(now)
        return len(_GLOBAL_PREM_1H)


def premium_rolling_spike_active() -> bool:
    if PREMIUM_ROLLING_1H_MAX <= 0:
        return False
    return rolling_1h_premium_usage_global() >= PREMIUM_ROLLING_1H_MAX


def emergency_cost_mode_active() -> bool:
    """Manual kill-switch or automatic spike / rolling premium pressure."""
    if EMERGENCY_COST_MODE:
        return True
    return premium_rolling_spike_active()


def user_request_rate_throttled(user_id: int) -> bool:
    if USER_REQUESTS_ROLLING_1H_MAX <= 0 or user_id < 0:
        return False
    return rolling_1h_usage_tracker(user_id) >= USER_REQUESTS_ROLLING_1H_MAX


def _maybe_log_emergency_spike() -> None:
    global _EMERGENCY_SPIKE_LOGGED
    if not premium_rolling_spike_active() or EMERGENCY_COST_MODE:
        _EMERGENCY_SPIKE_LOGGED = False
        return
    if premium_rolling_spike_active() and not EMERGENCY_COST_MODE:
        with _ROLL_LOCK:
            if not _EMERGENCY_SPIKE_LOGGED:
                _EMERGENCY_SPIKE_LOGGED = True
                log_request(
                    {
                        "user_id": -1,
                        "request_type": "shortcut",
                        "model_used": "n/a",
                        "cache_status": "none",
                        "tokens_estimated": 0,
                        "premium_used": False,
                        "response_quality_flag": "degraded",
                        "note": "emergency_cost_spike_rolling_premium",
                        "rolling_1h_premium": rolling_1h_premium_usage_global(),
                    }
                )


def can_use_premium(user_id: int) -> bool:
    """Hard gate: emergency / rolling spike, global share, and optional per-user daily cap."""
    if user_id < 0:
        return False
    if emergency_cost_mode_active():
        return False
    if not premium_budget_allows_next():
        return False
    if PREMIUM_PER_USER_DAILY_MAX > 0 and user_premium_count_today(user_id) >= PREMIUM_PER_USER_DAILY_MAX:
        return False
    return True


def _bump_user_premium(user_id: int) -> None:
    if PREMIUM_PER_USER_DAILY_MAX <= 0:
        return
    with _USER_PREM_LOCK:
        _prune_old_premium_days()
        day = _today_ymd()
        if day not in _user_premium_by_day:
            _user_premium_by_day[day] = {}
        cur = _user_premium_by_day[day]
        cur[user_id] = cur.get(user_id, 0) + 1


def routing_record(used_premium: bool, user_id: int = -1) -> None:
    global _routing_total, _routing_premium
    with _ROUTING_LOCK:
        _routing_total += 1
        if used_premium:
            _routing_premium += 1
    if used_premium and user_id >= 0:
        _bump_user_premium(user_id)
    record_rolling_chat_event(user_id, used_premium)
    _maybe_log_emergency_spike()


def estimate_tokens(*parts: str) -> int:
    total = sum(len(p or "") for p in parts)
    return max(1, total // 4)


def _request_log_db_path() -> str:
    return os.path.abspath(REQUEST_LOG_DB)


def _persist_request_row(payload: dict[str, Any]) -> None:
    if not LOG_REQUEST_PERSISTED:
        return
    path = _request_log_db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    rid = str(payload.get("request_id") or uuid.uuid4())
    row = dict(payload)
    row["request_id"] = rid
    blob = json.dumps(row, default=str)
    with _PERSIST_LOCK:
        try:
            con = sqlite3.connect(path, timeout=30.0, isolation_level=None)
            try:
                con.execute("PRAGMA journal_mode=WAL;")
                con.execute(
                    """CREATE TABLE IF NOT EXISTS alex_request_log (
                        request_id TEXT PRIMARY KEY,
                        payload_json TEXT NOT NULL,
                        created_at REAL NOT NULL
                    )"""
                )
                # Idempotent: same request_id on retry does not duplicate rows
                con.execute(
                    "INSERT OR IGNORE INTO alex_request_log (request_id, payload_json, created_at) VALUES (?,?,?)",
                    (rid, blob, time.time()),
                )
            finally:
                con.close()
        except Exception as e:
            _REQ_LOG.warning("alex_request_persist_failed %s", e)


def log_request(payload: dict[str, Any]) -> None:
    """Structured production log line for every chat-related action."""
    row = dict(payload)
    row.setdefault("request_id", str(uuid.uuid4()))
    row["log_request_persisted"] = bool(LOG_REQUEST_PERSISTED)
    try:
        _REQ_LOG.info("alex_request %s", json.dumps(row, default=str))
    except Exception:
        _REQ_LOG.info("alex_request %r", row)
    _persist_request_row(row)


def record_decision_trace(trace: dict[str, Any]) -> None:
    """Internal debug ring buffer only — never shown to students."""
    row = dict(trace)
    row["ts"] = time.time()
    with _DECISION_LOCK:
        _RECENT_DECISIONS.append(row)


def get_recent_decision_traces(limit: int = 50) -> list[dict[str, Any]]:
    with _DECISION_LOCK:
        return list(_RECENT_DECISIONS)[-limit:]


def model_tier(model_id: str, teacher_m: str, reasoning_m: str, premium_m: str) -> int:
    if model_id == premium_m:
        return 2
    if model_id == reasoning_m:
        return 1
    return 0


def model_slot_name(model_id: str, teacher_m: str, reasoning_m: str, premium_m: str) -> str:
    t = model_tier(model_id, teacher_m, reasoning_m, premium_m)
    return ("teacher", "reasoning", "premium")[t]


def enforce_premium_hard_gate(
    model_id: str,
    teaching_mode: str,
    *,
    user_id: int,
    teacher_m: str,
    reasoning_m: str,
    premium_m: str,
) -> tuple[str, str, bool]:
    """If premium is selected but disallowed, force reasoning. Never call premium when this returns downgrade."""
    if model_id != premium_m:
        return model_id, teaching_mode, False
    if can_use_premium(user_id):
        return premium_m, teaching_mode, True
    return reasoning_m, "r1", False


def _normalize_task_type(raw: str) -> str:
    t = (raw or "").strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "advanced": "advanced_problem_solving",
        "advanced_problem": "advanced_problem_solving",
        "problem": "problem_solving",
        "code": "coding",
        "derive": "derivation",
    }
    return aliases.get(t, t)


def _normalize_difficulty(raw: str) -> str:
    u = (raw or "").upper().strip().replace(" ", "_")
    for lab in ("VERY_HARD", "HARD", "MEDIUM", "EASY"):
        if lab in u or u == lab:
            return lab
    m = re.search(r"\b(VERY_HARD|HARD|MEDIUM|EASY)\b", u)
    return m.group(1) if m else "MEDIUM"


def parse_router_json(content: str) -> dict[str, Any]:
    """Parse router JSON; return normalized route or DEFAULT_ROUTE."""
    raw = (content or "").strip()
    if not raw:
        return dict(DEFAULT_ROUTE)
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*```\s*$", "", raw)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start >= 0 and end > start:
            try:
                data = json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                return dict(DEFAULT_ROUTE)
        else:
            return dict(DEFAULT_ROUTE)
    if not isinstance(data, dict):
        return dict(DEFAULT_ROUTE)
    out = dict(DEFAULT_ROUTE)
    diff = _normalize_difficulty(str(data.get("difficulty", "")))
    if diff in ("EASY", "MEDIUM", "HARD", "VERY_HARD"):
        out["difficulty"] = diff
    subj = str(data.get("subject", "general")).strip().lower()
    if subj in ("physics", "math", "cs", "general"):
        out["subject"] = subj
    else:
        out["subject"] = "general"
    out["task_type"] = _normalize_task_type(str(data.get("task_type", "explanation")))
    rr = data.get("reasoning_required", False)
    out["reasoning_required"] = bool(rr) if isinstance(rr, bool) else str(rr).lower() in ("true", "1", "yes")
    rm = str(data.get("recommended_model", "teacher")).strip().lower()
    if rm in ("teacher", "reasoning", "premium"):
        out["recommended_model"] = rm
    try:
        c = float(data.get("confidence", out.get("confidence", 0.85)))
        out["confidence"] = max(0.0, min(1.0, c))
    except (TypeError, ValueError):
        out["confidence"] = 0.85
    return out


def premium_route_eligible(route: dict[str, Any]) -> bool:
    if not route.get("reasoning_required"):
        return False
    if str(route.get("difficulty", "")).upper() != "VERY_HARD":
        return False
    tt = _normalize_task_type(str(route.get("task_type", "")))
    return tt in ("derivation", "advanced_problem_solving")


def select_model_from_route(
    route: dict[str, Any],
    *,
    premium_budget_allows: bool,
    teacher_model: str,
    reasoning_model: str,
    premium_model: str,
) -> tuple[str, str, bool]:
    """Return (openrouter_model_id, teaching_mode, used_premium_this_choice)."""
    tt = _normalize_task_type(str(route.get("task_type", "")))
    diff = str(route.get("difficulty", "MEDIUM")).upper()
    rr = bool(route.get("reasoning_required"))

    if tt in ("definition", "explanation"):
        return teacher_model, "core", False

    if not rr:
        return teacher_model, "core", False

    if diff != "VERY_HARD":
        return reasoning_model, "r1", False

    if premium_route_eligible(route) and premium_budget_allows:
        return premium_model, "core", True

    return reasoning_model, "r1", False


def _ensure_min_reasoning(
    m: str,
    mode: str,
    up: bool,
    teacher_m: str,
    reasoning_m: str,
    premium_m: str,
) -> tuple[str, str, bool]:
    if model_tier(m, teacher_m, reasoning_m, premium_m) == 0:
        return reasoning_m, "r1", False
    return m, mode, up


def _escalate_one_tier(
    m: str,
    mode: str,
    up: bool,
    route: dict[str, Any],
    premium_ok: bool,
    teacher_m: str,
    reasoning_m: str,
    premium_m: str,
) -> tuple[str, str, bool]:
    t = model_tier(m, teacher_m, reasoning_m, premium_m)
    if t == 0:
        return reasoning_m, "r1", False
    if t == 1:
        if premium_route_eligible(route) and premium_ok:
            return premium_m, "core", True
        return reasoning_m, "r1", False
    return m, mode, up


def apply_confidence_to_model(
    route: dict[str, Any],
    m: str,
    mode: str,
    up: bool,
    *,
    premium_ok: bool,
    teacher_m: str,
    reasoning_m: str,
    premium_m: str,
) -> tuple[str, str, bool]:
    """Adjust model tier from router confidence: <0.5 reasoning minimum; <0.7 +1 tier."""
    conf = float(route.get("confidence", 0.85))
    conf = max(0.0, min(1.0, conf))
    if conf < 0.5:
        m, mode, up = _ensure_min_reasoning(m, mode, up, teacher_m, reasoning_m, premium_m)
    if conf < 0.7:
        m, mode, up = _escalate_one_tier(m, mode, up, route, premium_ok, teacher_m, reasoning_m, premium_m)
    return m, mode, up


def next_escalation(
    current_model: str,
    *,
    teacher_m: str,
    reasoning_m: str,
    premium_m: str,
    route: dict[str, Any],
    premium_ok: bool,
) -> tuple[str, str] | None:
    """Next stronger model for quality retry; None if no escalation left."""
    if AI_CONFIG.uses_groq:
        return None
    tier = model_tier(current_model, teacher_m, reasoning_m, premium_m)
    if tier == 0:
        return reasoning_m, "r1"
    if tier == 1:
        if premium_route_eligible(route) and premium_ok:
            return premium_m, "core"
        return None
    return None


def answer_needs_escalation(
    answer: str,
    user_msg: str,
    route: dict[str, Any],
    *,
    visual_only: bool,
    is_indepth: bool,
) -> bool:
    if visual_only or is_indepth:
        return False
    a = (answer or "").strip()
    q = (user_msg or "").strip()
    if len(a) < 80 and len(q) > 35:
        return True
    diff = str(route.get("difficulty", "")).upper()
    tt = _normalize_task_type(str(route.get("task_type", "")))
    low = a.lower()
    if diff in ("HARD", "VERY_HARD") and tt in ("derivation", "problem_solving", "advanced_problem_solving"):
        has_structure = bool(
            re.search(r"(?:^|\n)\s*(?:\d+[\).]|\*\*|#{1,3}\s|step\s*\d)", a, re.IGNORECASE | re.MULTILINE)
        )
        has_reason = any(k in low for k in ("because", "therefore", "thus", "hence", "step", "first", "next"))
        if not (has_structure or has_reason) and len(a) < 450:
            return True
    if tt == "coding" and "```" not in a and len(q) > 25:
        return True
    if len(a.split()) < 25 and len(q.split()) > 12 and diff in ("HARD", "VERY_HARD"):
        return True
    # Clarity / completeness heuristics
    sentences = [s for s in re.split(r"[.!?]+", a) if s.strip()]
    if len(q) > 40 and len(sentences) < 2 and len(a) > 50:
        return True
    if len(q) > 60 and len(a) < 120:
        return True
    vague = ("as mentioned", "as above", "obviously", "clearly", "you know")
    if any(v in low for v in vague) and len(a) < 200 and len(q) > 30:
        return True
    return False


def response_quality_flag(
    final_answer: str,
    user_msg: str,
    route: dict[str, Any],
    *,
    visual_only: bool,
    is_indepth: bool,
    retries_done: int,
) -> str:
    if retries_done > 0:
        return "retry"
    if answer_needs_escalation(
        final_answer, user_msg, route, visual_only=visual_only, is_indepth=is_indepth
    ):
        return "degraded"
    return "good"


def verify_teaching_answer(
    answer: str,
    user_msg: str,
    route: dict[str, Any],
    *,
    visual_only: bool,
    is_indepth: bool,
) -> tuple[bool, str, str]:
    """Lightweight structure check. Returns (passed, reason, cache_quality_flag good|weak|rejected)."""
    if visual_only or is_indepth:
        return True, "skipped_visual_or_indepth", "good"
    a = (answer or "").strip()
    if len(a) < 40:
        return False, "too_short", "rejected"
    if answer_needs_escalation(a, user_msg, route, visual_only=False, is_indepth=False):
        return False, "heuristic_incomplete", "rejected"
    low = a.lower()
    has_step = bool(
        re.search(r"(?:^|\n)\s*(?:\d+[\).]|\*\*|#{1,3}\s|step\s*\d|[-*]\s)", a, re.IGNORECASE | re.MULTILINE)
    )
    has_example = any(
        k in low for k in ("for example", "e.g.", "example:", "consider ", "suppose ", "imagine ")
    )
    q = (user_msg or "").strip()
    if len(q) > 50 and not has_step and len(a) > 200:
        return False, "missing_step_structure", "weak"
    if _normalize_task_type(str(route.get("task_type", ""))) in (
        "explanation",
        "definition",
        "problem_solving",
        "derivation",
    ) and len(q) > 35:
        if not has_example and len(a) < 500:
            return False, "missing_example", "weak"
    return True, "ok", "good"


def sanitize_student_answer(text: str) -> str:
    """Strip vendor/model references from text shown to students."""
    if not text:
        return text
    t = _MODEL_NAME_PATTERNS.sub("the tutor", text)
    t = re.sub(r"(?i)\bthe tutor\s+the tutor\b", "the tutor", t)
    # Internal routing / meta (avoid false positives with statistical "confidence interval")
    t = re.sub(
        r"(?i)\b(confidence score|routing engine|model tier|premium tier|token budget)\b",
        "this lesson",
        t,
    )
    return t


def normalize_teaching_output(text: str) -> str:
    """Final student-visible normalization (no LLM): tidy spacing; keep content."""
    if not text:
        return text
    t = sanitize_student_answer(text)
    t = re.sub(r"\n{4,}", "\n\n\n", t)
    return t.strip()


def _norm_q_key(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").lower().strip())[:480]


def _trigrams(s: str) -> frozenset[str]:
    """Character-level trigram set for cheap similarity pre-filtering."""
    if len(s) < 3:
        return frozenset((s,)) if s else frozenset()
    return frozenset(s[i : i + 3] for i in range(len(s) - 2))


def _trigram_overlap(a: frozenset[str], b: frozenset[str]) -> float:
    """Jaccard-like overlap ratio — cheap O(min(|a|,|b|)) check."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def cache_lookup(
    uid: int,
    scope: str,
    user_msg: str,
    route: dict[str, Any],
) -> str | None:
    if uid < 0:
        return None
    nq = _norm_q_key(user_msg)
    if len(nq) < 12:
        return None
    subj = str(route.get("subject", "general"))
    diff = str(route.get("difficulty", "MEDIUM"))
    key = (uid, scope, nq)
    with _CACHE_LOCK:
        hit = _ANSWER_CACHE.get(key)
        if hit and hit.get("answer"):
            if hit.get("subject") == subj and hit.get("difficulty") == diff:
                _ANSWER_CACHE.move_to_end(key)  # LRU: mark as recently used
                return str(hit["answer"])
        # Trigram pre-filter: only run expensive SequenceMatcher on entries
        # whose trigram overlap suggests they could be similar (Jaccard >= 0.35).
        nq_tri = _trigrams(nq)
        best_ratio = 0.0
        best_ans = None
        best_key = None
        for k, v in _ANSWER_CACHE.items():
            if k[0] != uid or k[1] != scope:
                continue
            cached_tri = v.get("_trigrams")
            if cached_tri is not None and _trigram_overlap(nq_tri, cached_tri) < 0.35:
                continue  # cheap skip — can't be similar enough
            prev_q = v.get("norm_q") or ""
            r = SequenceMatcher(None, nq, prev_q).ratio()
            if r > best_ratio:
                best_ratio = r
                best_ans = v.get("answer")
                best_key = k
            if r >= 0.91 and v.get("subject") == subj and v.get("difficulty") == diff and v.get("answer"):
                _ANSWER_CACHE.move_to_end(k)  # LRU
                return str(v["answer"])
        if best_ratio >= 0.88 and best_ans:
            if best_key:
                _ANSWER_CACHE.move_to_end(best_key)  # LRU
            return str(best_ans)
    return None


def cache_store(
    uid: int,
    scope: str,
    user_msg: str,
    route: dict[str, Any],
    answer: str,
    *,
    cache_quality_flag: str = "good",
    used_premium: bool = False,
    min_router_confidence: float = 0.70,
) -> None:
    if uid < 0 or not (answer or "").strip():
        return
    if used_premium:
        return
    try:
        conf = float(route.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    if conf < min_router_confidence:
        return
    if cache_quality_flag not in ("good",):
        return
    nq = _norm_q_key(user_msg)
    if len(nq) < 12:
        return
    key = (uid, scope, nq)
    entry = {
        "answer": answer.strip(),
        "ts": time.time(),
        "subject": str(route.get("subject", "general")),
        "difficulty": str(route.get("difficulty", "MEDIUM")),
        "norm_q": nq,
        "cache_quality_flag": cache_quality_flag,
        "_trigrams": _trigrams(nq),
    }
    with _CACHE_LOCK:
        if key in _ANSWER_CACHE:
            _ANSWER_CACHE.move_to_end(key)  # refresh position
        elif len(_ANSWER_CACHE) >= _CACHE_MAX_KEYS:
            # LRU eviction: pop from front (least recently used) — O(1) per pop
            n_drop = max(1, _CACHE_MAX_KEYS // 10)
            for _ in range(min(n_drop, len(_ANSWER_CACHE))):
                _ANSWER_CACHE.popitem(last=False)
        _ANSWER_CACHE[key] = entry


def compress_chat_transcript(recent_text: str, max_lines: int = 10) -> str:
    lines = [ln for ln in (recent_text or "").splitlines() if ln.strip()]
    if len(lines) <= max_lines:
        return recent_text or ""
    return "\n".join(lines[-max_lines:])


def compress_semantic_memory(
    combined_memory: str,
    adaptive_profile: str,
    user_msg: str,
    max_bullets: int = 10,
) -> str:
    """At most max_bullets bullet lines; relevance-filtered when possible. No raw dumps."""
    bullets: list[str] = []
    for block in (combined_memory or "", adaptive_profile or ""):
        for ln in block.splitlines():
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith(("- ", "* ", "• ")):
                bullets.append("- " + s.lstrip("-*• ").strip()[:220])
            elif len(s) > 2:
                bullets.append("- " + s[:220])
    qtok = {w.lower() for w in re.findall(r"[A-Za-z]{4,}", user_msg or "")}
    if qtok and len(bullets) > 4:
        rel = [b for b in bullets if any(t in b.lower() for t in qtok)]
        if len(rel) >= 3:
            bullets = rel
    return "\n".join(bullets[:max_bullets])[:2800]


def compress_memory_block(
    memory_summary: str,
    adaptive_profile: str,
    user_msg: str,
    max_total: int = 1200,
) -> str:
    """Legacy wrapper: semantic bullets + short profile tail."""
    core = compress_semantic_memory(memory_summary, "", user_msg, max_bullets=10)
    prof = (adaptive_profile or "").strip()
    prof_short = prof[:500] if prof else ""
    if prof_short:
        return (core + "\n\nAdaptive profile (compressed):\n" + prof_short)[:max_total]
    return core[:max_total]


def compress_plan_today(plan: list[dict[str, Any]] | None, day: int) -> str:
    if not plan:
        return ""
    for entry in plan:
        try:
            if int(entry.get("day", -1)) == int(day):
                topics = entry.get("topics") or []
                subj = entry.get("subject", "")
                unit = entry.get("unit", "")
                return (
                    f"Today (Day {day}/110): subject={subj} | unit={unit} | "
                    f"topics={', '.join(str(t) for t in topics[:8])}"
                )[:1800]
        except (TypeError, ValueError):
            continue
    return f"Day {day}/110 (plan entry not found in compressed view)"


def router_json_prompt_for_question(user_question: str, refinement: str | None = None) -> str:
    base = ALEX_ROUTER_JSON_PROMPT_V1.replace("{{USER_INPUT}}", (user_question or "")[:12000])
    if refinement and (r := refinement.strip()):
        base += ALEX_ROUTER_REFINEMENT_SUFFIX_V1.replace("{{REFINEMENT}}", r[:2000])
    return base


def decision_trace_extras(
    uid: int,
    *,
    retries_done: int,
    cache_hit: bool | None,
    premium_allowed: bool,
) -> dict[str, Any]:
    return {
        "retry_count": retries_done,
        "cache_hit_miss": "hit" if cache_hit is True else ("miss" if cache_hit is False else "n/a"),
        "rolling_1h_user_requests": rolling_1h_usage_tracker(uid),
        "rolling_1h_premium_global": rolling_1h_premium_usage_global(),
        "premium_allowed": premium_allowed,
        "emergency_cost_mode": emergency_cost_mode_active(),
        "log_request_persisted": LOG_REQUEST_PERSISTED,
    }
