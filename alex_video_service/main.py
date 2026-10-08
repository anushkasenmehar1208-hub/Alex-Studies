"""Alex Video Service — FastAPI entry point.

Endpoints:
- POST /render          → enqueue a video; returns {job_id, status}
- GET  /status/{job_id} → poll status; returns {status, video_url?, error?}
- GET  /videos/{file}   → static MP4
- GET  /health          → liveness
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from manim_generator import GenerationError, generate_scene_code
from renderer import VIDEOS_DIR, RenderError, render_scene

load_dotenv()

app = FastAPI(title="Alex Video Service", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")

JobStatus = Literal["queued", "generating", "voicing", "rendering", "done", "error"]
JOBS: dict[str, dict] = {}


class RenderRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=200)
    prompt: str = Field("", max_length=4000)   # optional — AI builds full curriculum if empty
    style: str = Field("cinematic", max_length=60)
    use_3d: bool = False


class RenderResponse(BaseModel):
    job_id: str
    status: JobStatus


class StatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    video_url: str | None = None
    error: str | None = None
    created_at: float
    updated_at: float


def _public_video_url(job_id: str) -> str:
    base = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
    if base:
        return f"{base}/videos/{job_id}.mp4"
    return f"/videos/{job_id}.mp4"


def _set(job_id: str, **fields) -> None:
    job = JOBS.setdefault(
        job_id, {"created_at": time.time(), "updated_at": time.time()}
    )
    job.update(fields)
    job["updated_at"] = time.time()


async def _run_job(job_id: str, req: RenderRequest) -> None:
    try:
        # Phase 1: LLM generates narration + Manim code together
        _set(job_id, status="generating")
        narration, code = await generate_scene_code(
            topic=req.topic,
            prompt=req.prompt,
            style=req.style,
            use_3d=req.use_3d,
        )

        # Phase 2: Render animation + voice
        _set(job_id, status="rendering", scene_chars=len(code), narration_words=len(narration.split()))
        await render_scene(job_id, code, narration)

        _set(job_id, status="done", video_url=_public_video_url(job_id))

    except GenerationError as e:
        _set(job_id, status="error", error=f"generation: {e}")
    except RenderError as e:
        _set(job_id, status="error", error=f"render: {e}")
    except Exception as e:  # noqa: BLE001
        _set(job_id, status="error", error=f"unexpected: {e!r}")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "jobs_in_memory": len(JOBS)}


@app.post("/render", response_model=RenderResponse)
async def render(req: RenderRequest) -> RenderResponse:
    if os.getenv("ALEX_DEMO_FREE_MODE", "false").strip().lower() in ("true", "1", "yes"):
        raise HTTPException(403, "Live AI video generation is disabled in free demo mode")
    if not os.environ.get("OPENROUTER_API_KEY"):
        raise HTTPException(500, "OPENROUTER_API_KEY not configured on server")
    job_id = uuid.uuid4().hex[:16]
    _set(job_id, status="queued", topic=req.topic)
    asyncio.create_task(_run_job(job_id, req))
    return RenderResponse(job_id=job_id, status="queued")


@app.get("/status/{job_id}", response_model=StatusResponse)
async def status(job_id: str) -> StatusResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"unknown job_id: {job_id}")
    return StatusResponse(
        job_id=job_id,
        status=job.get("status", "queued"),
        video_url=job.get("video_url"),
        error=job.get("error"),
        created_at=job.get("created_at", 0.0),
        updated_at=job.get("updated_at", 0.0),
    )
