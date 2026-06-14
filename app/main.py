from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, selectinload

from .database import Base, SessionLocal, engine, get_db
from .importer import seed_questions_from_json
from .models import Choice, Exam, Question, TestAnswer, TestSession, Topic
from .services import (
    answer_payload,
    build_stats,
    create_session,
    export_progress,
    find_active_session,
    finish_session,
    get_default_exam,
    import_progress,
    question_public,
    record_answer,
    reset_progress,
    session_payload,
)

APP_DIR = Path(__file__).resolve().parent
QUESTIONS_PATH = APP_DIR / "app_data" / "questions.json"

app = FastAPI(title="Numerical Methods Exam Prep", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartTestRequest(BaseModel):
    mode: str = Field(default="exam", examples=["exam", "readiness", "topic", "difficulty", "errors", "official"])
    count: int = Field(default=20, ge=1, le=1500)
    topic_id: Optional[int] = None
    readiness_level: Optional[int] = Field(default=None, examples=[30, 50, 70, 90, 100])
    difficulty: Optional[str] = Field(default=None, examples=["very_easy", "easy", "medium", "hard"])
    restart: bool = False


class AnswerRequest(BaseModel):
    question_id: int
    selected_index: Optional[int] = None
    input_answer: Optional[str] = None


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_questions_from_json(db, QUESTIONS_PATH, force=False)
    finally:
        db.close()


@app.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, Any]:
    exam_count = db.query(Exam).count()
    question_count = db.query(Question).count()
    return {"status": "ok", "exams": exam_count, "questions": question_count}


@app.get("/api/meta")
def meta() -> dict[str, Any]:
    payload = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    return payload.get("meta", {})


@app.get("/api/topics")
def topics(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    exam = get_default_exam(db)
    rows = db.query(Topic).filter(Topic.exam_id == exam.id).order_by(Topic.external_id).all()
    return [
        {
            "id": t.id,
            "external_id": t.external_id,
            "title": t.title,
            "theory": t.theory,
            "questions_count": db.query(Question).filter(Question.topic_id == t.id, Question.source != "official").count(),
        }
        for t in rows
    ]


@app.get("/api/questions")
def questions(
    topic_id: Optional[int] = None,
    difficulty: Optional[str] = None,
    source: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    exam = get_default_exam(db)
    query = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).filter(Question.exam_id == exam.id)
    if topic_id:
        query = query.filter(Question.topic_id == topic_id)
    if difficulty:
        query = query.filter(Question.difficulty == difficulty)
    if source:
        query = query.filter(Question.source == source)
    rows = query.limit(min(limit, 500)).all()
    return [question_public(q, include_answer=False) for q in rows]


@app.post("/api/tests/start")
def start_test(payload: StartTestRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        session = create_session(
            db,
            mode=payload.mode,
            count=payload.count,
            topic_id=payload.topic_id,
            readiness_level=payload.readiness_level,
            difficulty=payload.difficulty,
            restart=payload.restart,
        )
        session = db.get(TestSession, session.id)
        return session_payload(db, session, reveal_answered=False)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc




@app.get("/api/sessions/active")
def get_active_session(
    mode: str,
    topic_id: Optional[int] = None,
    readiness_level: Optional[int] = None,
    difficulty: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    session = find_active_session(
        db,
        mode=mode,
        topic_id=topic_id,
        readiness_level=readiness_level,
        difficulty=difficulty,
    )
    if not session:
        return {"session": None}
    return {"session": session_payload(db, session)}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    session = db.get(TestSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_payload(db, session)


@app.post("/api/sessions/{session_id}/answer")
def answer(session_id: int, payload: AnswerRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return record_answer(
            db,
            session_id=session_id,
            question_id=payload.question_id,
            selected_index=payload.selected_index,
            input_answer=payload.input_answer,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/sessions/{session_id}/finish")
def finish(session_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return finish_session(db, session_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/stats")
def stats(db: Session = Depends(get_db)) -> dict[str, Any]:
    return build_stats(db)


@app.get("/api/errors")
def errors(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = (
        db.query(TestAnswer)
        .options(selectinload(TestAnswer.question).selectinload(Question.choices), selectinload(TestAnswer.question).selectinload(Question.topic))
        .filter(TestAnswer.is_correct.is_(False))
        .order_by(TestAnswer.answered_at.desc())
        .limit(300)
        .all()
    )
    return [
        {
            "answered_at": a.answered_at.isoformat(),
            "selected_index": a.selected_index,
            "input_answer": a.input_answer,
            "question": question_public(a.question, include_answer=True),
        }
        for a in rows
    ]




@app.post("/api/progress/reset")
def reset_user_progress(db: Session = Depends(get_db)) -> dict[str, Any]:
    return reset_progress(db)


@app.get("/api/export")
def export(db: Session = Depends(get_db)) -> JSONResponse:
    return JSONResponse(export_progress(db), headers={"Content-Disposition": "attachment; filename=exam-progress.json"})


@app.post("/api/import/progress")
def import_user_progress(payload: dict[str, Any], db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return import_progress(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/import/questions")
async def import_questions(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db)) -> dict[str, Any]:
    tmp = APP_DIR / "runtime_import_questions.json"
    tmp.write_bytes(await file.read())
    try:
        return seed_questions_from_json(db, tmp, force=force)
    finally:
        tmp.unlink(missing_ok=True)


# SPA must be mounted after API routes.
app.mount("/", StaticFiles(directory=APP_DIR / "static", html=True), name="static")
