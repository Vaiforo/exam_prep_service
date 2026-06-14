from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from .database import Base, SessionLocal, engine, get_db
from .importer import seed_questions_from_json
from .models import AuthToken, Choice, Exam, Question, TestAnswer, TestSession, Topic, User
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

app = FastAPI(
    title="Numerical Methods Exam Prep",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
cors_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "*").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

ADMIN_TOKENS: set[str] = set()


class StartTestRequest(BaseModel):
    mode: str = Field(default="exam", examples=["exam", "readiness", "topic", "difficulty", "errors", "official"])
    count: int = Field(default=20, ge=1, le=1500)
    topic_id: Optional[int] = None
    topic_ids: Optional[list[int]] = None
    readiness_level: Optional[int] = Field(default=None, examples=[30, 50, 70, 90, 100])
    difficulty: Optional[str] = Field(default=None, examples=["very_easy", "easy", "medium", "hard"])
    difficulties: Optional[list[str]] = None
    restart: bool = False


class AnswerRequest(BaseModel):
    question_id: int
    selected_index: Optional[int] = None
    input_answer: Optional[str] = None


class AuthRequest(BaseModel):
    username: str = Field(min_length=3, max_length=80)
    password: str = Field(min_length=4, max_length=200)


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=300)


class AdminResetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=4, max_length=200)


def normalize_username(username: str) -> str:
    return username.strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    iterations = 120_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt}${digest}"


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        algorithm, iterations_raw, salt, expected = password_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations_raw)).hex()
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def migrate_auth_columns() -> None:
    if engine.url.get_backend_name() != "sqlite":
        return
    with engine.begin() as connection:
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(users)").fetchall()}
        if "password_hash" not in columns:
            connection.exec_driver_sql("ALTER TABLE users ADD COLUMN password_hash TEXT")


def create_auth_token(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(48)
    db.add(AuthToken(user_id=user.id, token=token))
    db.commit()
    return token


def get_current_user(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Auth required")
    token = authorization.split(" ", 1)[1].strip()
    auth = db.scalar(select(AuthToken).where(AuthToken.token == token))
    if auth is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.get(User, auth.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid user")
    return user


def admin_credentials_configured() -> bool:
    return bool(os.getenv("ADMIN_USERNAME") and os.getenv("ADMIN_PASSWORD"))


def get_admin_user(authorization: Optional[str] = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Admin auth required")
    token = authorization.split(" ", 1)[1].strip()
    if token not in ADMIN_TOKENS:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    return "admin"


def user_summary(db: Session, user: User) -> dict[str, Any]:
    stats = build_stats(db, user)
    return {
        "id": user.id,
        "username": user.username,
        "created_at": user.created_at.isoformat(),
        "has_password": bool(user.password_hash),
        "readiness": stats["readiness"],
        "accuracy": stats["accuracy"],
        "answered_unique": stats["answered_unique"],
        "wrong_answers": stats["wrong_answers"],
        "sessions_total": stats["sessions_total"],
    }


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    migrate_auth_columns()
    db = SessionLocal()
    try:
        seed_questions_from_json(db, QUESTIONS_PATH, force=False)
    finally:
        db.close()


@app.get("/admin")
def admin_page() -> FileResponse:
    return FileResponse(APP_DIR / "admin_static" / "index.html")


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginRequest) -> dict[str, Any]:
    expected_username = os.getenv("ADMIN_USERNAME", "")
    expected_password = os.getenv("ADMIN_PASSWORD", "")
    if not expected_username or not expected_password:
        raise HTTPException(status_code=503, detail="Админ-доступ не настроен в .env")
    username_ok = hmac.compare_digest(payload.username, expected_username)
    password_ok = hmac.compare_digest(payload.password, expected_password)
    if not (username_ok and password_ok):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль администратора")
    token = secrets.token_urlsafe(48)
    ADMIN_TOKENS.add(token)
    return {"token": token, "admin": {"username": expected_username}}


@app.get("/api/admin/me")
def admin_me(admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    return {"username": os.getenv("ADMIN_USERNAME", "admin")}


@app.post("/api/admin/logout")
def admin_logout(authorization: Optional[str] = Header(default=None)) -> dict[str, Any]:
    if authorization and authorization.lower().startswith("bearer "):
        ADMIN_TOKENS.discard(authorization.split(" ", 1)[1].strip())
    return {"status": "ok"}


@app.get("/api/admin/users")
def admin_users(db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> list[dict[str, Any]]:
    users = db.query(User).order_by(User.created_at.desc(), User.id.desc()).all()
    return [user_summary(db, user) for user in users]


@app.get("/api/admin/users/{user_id}/progress")
def admin_user_progress(user_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return build_stats(db, user)


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, payload: AdminResetPasswordRequest, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    user.password_hash = hash_password(payload.new_password)
    db.query(AuthToken).filter(AuthToken.user_id == user.id).delete(synchronize_session=False)
    db.commit()
    return {"status": "password_reset", "user_id": user.id}


@app.post("/api/admin/users/{user_id}/reset-progress")
def admin_reset_progress(user_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return reset_progress(db, user)


@app.post("/api/admin/users/{user_id}/delete")
def admin_delete_user(user_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    username = user.username
    reset_progress(db, user)
    db.query(AuthToken).filter(AuthToken.user_id == user.id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    return {"status": "deleted", "user_id": user_id, "username": username}


@app.post("/api/auth/register")
def register(payload: AuthRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    username = normalize_username(payload.username)
    if db.scalar(select(User).where(User.username == username)) is not None:
        raise HTTPException(status_code=400, detail="Пользователь с таким логином уже существует")
    user = User(username=username, password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_auth_token(db, user)
    return {"token": token, "user": {"id": user.id, "username": user.username}}


@app.post("/api/auth/login")
def login(payload: AuthRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    username = normalize_username(payload.username)
    user = db.scalar(select(User).where(User.username == username))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль")
    token = create_auth_token(db, user)
    return {"token": token, "user": {"id": user.id, "username": user.username}}


@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"id": user.id, "username": user.username}


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        db.query(AuthToken).filter(AuthToken.token == token).delete(synchronize_session=False)
        db.commit()
    return {"status": "ok"}


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
def topics(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict[str, Any]]:
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
    user: User = Depends(get_current_user),
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
def start_test(payload: StartTestRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        session = create_session(
            db,
            user=user,
            mode=payload.mode,
            count=payload.count,
            topic_id=payload.topic_id,
            topic_ids=payload.topic_ids,
            readiness_level=payload.readiness_level,
            difficulty=payload.difficulty,
            difficulties=payload.difficulties,
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
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    session = find_active_session(
        db,
        user=user,
        mode=mode,
        topic_id=topic_id,
        readiness_level=readiness_level,
        difficulty=difficulty,
    )
    if not session:
        return {"session": None}
    return {"session": session_payload(db, session)}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    session = db.get(TestSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_payload(db, session)


@app.post("/api/sessions/{session_id}/answer")
def answer(session_id: int, payload: AnswerRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return record_answer(
            db,
            user=user,
            session_id=session_id,
            question_id=payload.question_id,
            selected_index=payload.selected_index,
            input_answer=payload.input_answer,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/sessions/{session_id}/finish")
def finish(session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return finish_session(db, session_id, user=user)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/stats")
def stats(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return build_stats(db, user)


@app.get("/api/errors")
def errors(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict[str, Any]]:
    rows = (
        db.query(TestAnswer)
        .join(TestSession, TestSession.id == TestAnswer.session_id)
        .options(selectinload(TestAnswer.question).selectinload(Question.choices), selectinload(TestAnswer.question).selectinload(Question.topic))
        .filter(TestSession.user_id == user.id, TestAnswer.is_correct.is_(False))
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
def reset_user_progress(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    return reset_progress(db, user)


@app.get("/api/export")
def export(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> JSONResponse:
    return JSONResponse(export_progress(db, user), headers={"Content-Disposition": "attachment; filename=exam-progress.json"})


@app.post("/api/import/progress")
def import_user_progress(payload: dict[str, Any], db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    try:
        return import_progress(db, payload, user)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/import/questions")
async def import_questions(file: UploadFile = File(...), force: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    if os.getenv("ALLOW_QUESTION_IMPORT", "false").lower() not in {"1", "true", "yes"}:
        raise HTTPException(status_code=403, detail="Импорт банка вопросов отключён на сервере")
    tmp = APP_DIR / "runtime_import_questions.json"
    tmp.write_bytes(await file.read())
    try:
        return seed_questions_from_json(db, tmp, force=force)
    finally:
        tmp.unlink(missing_ok=True)


app.mount("/admin-static", StaticFiles(directory=APP_DIR / "admin_static"), name="admin-static")

# SPA must be mounted after API routes.
app.mount("/", StaticFiles(directory=APP_DIR / "static", html=True), name="static")
