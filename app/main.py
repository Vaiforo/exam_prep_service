from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import time
import uuid
import zipfile
from html import escape as html_escape
from xml.etree import ElementTree as ET
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session, selectinload

from .database import Base, SessionLocal, engine, get_db
from .importer import seed_questions_from_json
from .models import AdminNotification, AuthToken, ChatDialogHidden, ChatMessage, ChatReadState, ChatRoom, ChatRoomMember, Choice, ErrorReport, Exam, NotificationDismissal, Question, QuestionOverride, SessionQuestion, TestAnswer, TestSession, Topic, User
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
    session_display_title,
    session_payload,
    session_restart_payload,
)

APP_DIR = Path(__file__).resolve().parent
QUESTIONS_PATH = APP_DIR / "app_data" / "questions.json"
PATCH_NOTES_PATH = APP_DIR / "app_data" / "patch_notes.json"
APP_VERSION = os.getenv("APP_VERSION", "76-question-admin")
CHAT_MEDIA_DIR = Path(os.getenv("CHAT_MEDIA_DIR", str(APP_DIR.parent / "runtime" / "chat_media")))
CHAT_MAX_UPLOAD_MB = int(os.getenv("CHAT_MAX_UPLOAD_MB", "25"))
CHAT_MAX_UPLOAD_BYTES = CHAT_MAX_UPLOAD_MB * 1024 * 1024

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
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)



def render_versioned_html(path: Path) -> HTMLResponse:
    html = path.read_text(encoding="utf-8").replace("__APP_VERSION__", APP_VERSION)
    return HTMLResponse(
        html,
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.middleware("http")
async def no_cache_for_ui_assets(request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - started) * 1000
    path = request.url.path

    METRICS["requests_total"] += 1
    METRICS["last_response_ms"] = round(duration_ms, 2)
    REQUEST_DURATIONS_MS.append(duration_ms)
    if path.startswith("/api/"):
        METRICS["api_requests_total"] += 1
    else:
        METRICS["static_requests_total"] += 1
    if response.status_code >= 500:
        METRICS["errors_total"] += 1

    if path in {"/", "/admin", "/index.html"} or path.endswith((".html", ".css", ".js")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    response.headers["X-Response-Time-Ms"] = str(round(duration_ms, 2))
    return response


ADMIN_TOKENS: set[str] = set()

STARTED_AT = datetime.utcnow()
REQUEST_DURATIONS_MS: deque[float] = deque(maxlen=5000)
PAGE_LOAD_DURATIONS_MS: deque[float] = deque(maxlen=1000)
METRICS: dict[str, Any] = {
    "requests_total": 0,
    "api_requests_total": 0,
    "static_requests_total": 0,
    "errors_total": 0,
    "last_response_ms": 0.0,
}

def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    idx = min(len(values) - 1, max(0, int(round((len(values) - 1) * p))))
    return round(values[idx], 2)

def average(values) -> float:
    values = list(values)
    return round(sum(values) / len(values), 2) if values else 0.0


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


class ErrorReportRequest(BaseModel):
    target_type: str = Field(pattern="^(question|theory)$")
    question_id: Optional[int] = None
    topic_id: Optional[int] = None
    message: str = Field(min_length=5, max_length=2000)
    page_context: dict[str, Any] = Field(default_factory=dict)


class AdminReportStatusRequest(BaseModel):
    status: str = Field(pattern="^(new|reviewed|resolved)$")


class AdminQuestionOverrideRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    kind: str = Field(pattern="^(mcq|input)$")
    difficulty: str = Field(pattern="^(very_easy|easy|medium|hard)$")
    source: str = Field(default="manual", max_length=40)
    choices: list[str] = Field(default_factory=list)
    correct_choice_index: Optional[int] = None
    answer_text: Optional[str] = Field(default=None, max_length=1000)
    answer_value: Optional[float] = None
    tolerance: Optional[float] = None
    explanation: str = Field(default="", max_length=20000)


class PageLoadMetricRequest(BaseModel):
    duration_ms: float = Field(ge=0, le=120000)
    page: str = Field(default="main", max_length=80)
    route: str = Field(default="/", max_length=200)


class NotificationDismissRequest(BaseModel):
    item_type: str = Field(pattern="^(patch|notification)$")
    item_key: str = Field(min_length=1, max_length=120)


class AdminNotificationRequest(BaseModel):
    title: str = Field(min_length=3, max_length=255)
    message: str = Field(min_length=3, max_length=3000)


class AdminPatchNotesUpdateRequest(BaseModel):
    title: str = Field(default="Сайт обновился", min_length=3, max_length=255)
    changes: list[str] = Field(default_factory=list, max_length=100)


class ChatMessageUpdateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class ChatReadRequest(BaseModel):
    chat_type: str = Field(default="group", pattern="^(saved|group|direct|room)$")
    peer: Optional[str] = Field(default=None, max_length=80)
    room_id: Optional[int] = Field(default=None, ge=1)
    last_message_id: int = Field(default=0, ge=0)




class ChatRoomCreateRequest(BaseModel):
    title: str = Field(min_length=2, max_length=160)
    usernames: list[str] = Field(default_factory=list, max_length=50)


class ChatForwardRequest(BaseModel):
    chat_type: str = Field(default="group", pattern="^(saved|group|direct|room)$")
    peer: Optional[str] = Field(default=None, max_length=80)
    room_id: Optional[int] = Field(default=None, ge=1)
    text: str = Field(default="", max_length=5000)




def read_patch_notes() -> dict[str, Any]:
    if not PATCH_NOTES_PATH.exists():
        return {"active": [], "archive": []}
    try:
        data = json.loads(PATCH_NOTES_PATH.read_text(encoding="utf-8"))
        return {"active": list(data.get("active", [])), "archive": list(data.get("archive", []))}
    except Exception:
        return {"active": [], "archive": []}


def write_patch_notes(data: dict[str, Any]) -> None:
    PATCH_NOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    PATCH_NOTES_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def seed_current_patch_note() -> None:
    # Патч-ноуты намеренно не создаются автоматически.
    # Файл app/app_data/patch_notes.json остаётся пустым, пока админ сам не заполнит его через панель.
    return


def patch_note_key(item: dict[str, Any], archived: bool = False) -> str:
    base = str(item.get("id") or "site-update-current")
    if archived:
        return f"{base}:archive:{item.get('cleared_at') or item.get('created_at') or 'old'}"
    return f"{base}:app-version:{APP_VERSION}"


def patch_note_public(item: dict[str, Any], archived: bool = False) -> dict[str, Any]:
    return {
        "type": "patch",
        "key": patch_note_key(item, archived=archived),
        "id": str(item.get("id", "")),
        "app_version": APP_VERSION if not archived else None,
        "title": item.get("title") or "Сайт обновился",
        "message": "\n".join(item.get("changes", [])),
        "changes": item.get("changes", []),
        "created_at": item.get("created_at"),
        "archived": archived,
        "cleared_at": item.get("cleared_at"),
    }


def notification_public(item: AdminNotification) -> dict[str, Any]:
    return {
        "type": "notification",
        "key": str(item.id),
        "id": item.id,
        "title": item.title,
        "message": item.message,
        "changes": [],
        "created_at": item.created_at.isoformat(),
        "archived": not item.is_active,
    }


def dismissed_keys(db: Session, user: User) -> set[tuple[str, str]]:
    rows = db.query(NotificationDismissal).filter(NotificationDismissal.user_id == user.id).all()
    return {(row.item_type, row.item_key) for row in rows}


def hidden_keys(db: Session, user: User) -> set[tuple[str, str]]:
    rows = db.query(NotificationDismissal).filter(
        NotificationDismissal.user_id == user.id,
        NotificationDismissal.item_type.in_(["hidden_patch", "hidden_notification"]),
    ).all()
    return {(row.item_type, row.item_key) for row in rows}

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
        if "last_seen_at" not in columns:
            connection.exec_driver_sql("ALTER TABLE users ADD COLUMN last_seen_at DATETIME")


def migrate_simple_theory_columns() -> None:
    if engine.url.get_backend_name() != "sqlite":
        return
    with engine.begin() as connection:
        topic_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(topics)").fetchall()}
        if "simple_theory" not in topic_columns:
            connection.exec_driver_sql("ALTER TABLE topics ADD COLUMN simple_theory TEXT DEFAULT ''")
        question_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(questions)").fetchall()}
        if "simple_theory" not in question_columns:
            connection.exec_driver_sql("ALTER TABLE questions ADD COLUMN simple_theory TEXT DEFAULT ''")


def migrate_chat_message_columns() -> None:
    if engine.url.get_backend_name() != "sqlite":
        return
    with engine.begin() as connection:
        tables = {row[0] for row in connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        if "chat_messages" not in tables:
            return
        columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(chat_messages)").fetchall()}
        if "edited_at" not in columns:
            connection.exec_driver_sql("ALTER TABLE chat_messages ADD COLUMN edited_at DATETIME")
        if "deleted_at" not in columns:
            connection.exec_driver_sql("ALTER TABLE chat_messages ADD COLUMN deleted_at DATETIME")
        if "room_id" not in columns:
            connection.exec_driver_sql("ALTER TABLE chat_messages ADD COLUMN room_id INTEGER")
        if "chat_read_states" in tables:
            read_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(chat_read_states)").fetchall()}
            if "room_id" not in read_columns:
                connection.exec_driver_sql("ALTER TABLE chat_read_states ADD COLUMN room_id INTEGER")


def create_auth_token(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(48)
    user.last_seen_at = datetime.utcnow()
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



def get_user_by_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    auth = db.scalar(select(AuthToken).where(AuthToken.token == token.strip()))
    if auth is None:
        return None
    user = db.get(User, auth.user_id)
    if user is not None:
        user.last_seen_at = datetime.utcnow()
        db.commit()
        db.refresh(user)
    return user


def get_current_user_from_optional_token(
    authorization: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
) -> User:
    raw_token = token
    if not raw_token and authorization and authorization.lower().startswith("bearer "):
        raw_token = authorization.split(" ", 1)[1].strip()
    user = get_user_by_token(db, raw_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Auth required")
    return user


class ChatConnectionManager:
    def __init__(self) -> None:
        self.active: dict[int, set[WebSocket]] = {}

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        sockets = self.active.get(user_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self.active.pop(user_id, None)

    async def send_to_user(self, user_id: int, payload: dict[str, Any]) -> None:
        sockets = list(self.active.get(user_id, set()))
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:
                self.disconnect(user_id, socket)

    async def broadcast_group(self, payload: dict[str, Any]) -> None:
        for user_id in list(self.active.keys()):
            await self.send_to_user(user_id, payload)


CHAT_MANAGER = ChatConnectionManager()


def normalize_chat_type(value: str | None) -> str:
    if value == "saved":
        return "saved"
    if value == "direct":
        return "direct"
    if value == "room":
        return "room"
    return "group"


def get_room_member(db: Session, user: User, room_id: int | None) -> ChatRoomMember | None:
    if not room_id:
        return None
    return db.scalar(select(ChatRoomMember).where(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == user.id))

def require_chat_room_member(db: Session, user: User, room_id: int | None) -> ChatRoom:
    if not room_id:
        raise HTTPException(status_code=400, detail="Укажи групповой чат")
    room = db.get(ChatRoom, room_id)
    if room is None or get_room_member(db, user, room_id) is None:
        raise HTTPException(status_code=404, detail="Групповой чат не найден")
    return room


def can_user_see_chat_message(user: User, message: ChatMessage, db: Session | None = None) -> bool:
    if message.chat_type == "saved":
        return message.sender_id == user.id
    if message.chat_type == "group":
        return True
    if message.chat_type == "direct":
        return message.sender_id == user.id or message.recipient_id == user.id
    if message.chat_type == "room" and db is not None:
        return get_room_member(db, user, message.room_id) is not None
    return False


def can_modify_chat_message(user: User, message: ChatMessage) -> bool:
    if message.sender_id != user.id or message.deleted_at is not None:
        return False
    return datetime.utcnow() - message.created_at <= timedelta(hours=24)


def attachment_kind_for(filename: str, content_type: str | None) -> tuple[str, str]:
    name = filename.lower().strip()
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    suffix = Path(name).suffix.lower()
    if mime.startswith("image/") or suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            suffix = ".png"
        if not mime or mime == "application/octet-stream":
            mime = mimetypes.types_map.get(suffix, "image/png")
        return "image", mime
    if suffix == ".txt" or mime == "text/plain":
        return "text", "text/plain"
    if suffix == ".md" or mime in {"text/markdown", "text/x-markdown"}:
        return "markdown", "text/markdown"
    if suffix == ".ipynb" or mime in {"application/x-ipynb+json", "application/json"}:
        return "notebook", "application/x-ipynb+json"
    if suffix == ".docx" or mime == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if suffix == ".pdf" or mime == "application/pdf":
        return "pdf", "application/pdf"
    raise HTTPException(status_code=400, detail="Можно отправлять только изображения, pdf, txt, md, ipynb и docx")


def safe_file_extension(kind: str, filename: str, mime: str) -> str:
    suffix = Path(filename.lower()).suffix
    if kind == "image" and suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return suffix
    if kind == "text":
        return ".txt"
    if kind == "markdown":
        return ".md"
    if kind == "notebook":
        return ".ipynb"
    if kind == "docx":
        return ".docx"
    if kind == "pdf":
        return ".pdf"
    return mimetypes.guess_extension(mime) or ".bin"




def remove_chat_media_if_unused(db: Session, message: ChatMessage) -> bool:
    storage_path = message.attachment_storage_path
    if not storage_path:
        return False
    other_refs = db.query(ChatMessage.id).filter(
        ChatMessage.id != message.id,
        ChatMessage.deleted_at.is_(None),
        ChatMessage.attachment_storage_path == storage_path,
    ).first()
    if other_refs:
        return False
    path = (CHAT_MEDIA_DIR / storage_path).resolve()
    root = CHAT_MEDIA_DIR.resolve()
    if root in path.parents and path.exists():
        try:
            path.unlink()
            return True
        except OSError:
            return False
    return False

def admin_chat_message_public(message: ChatMessage) -> dict[str, Any]:
    attachment = chat_attachment_public(message) if message.deleted_at is None else None
    return {
        "id": message.id,
        "chat_type": message.chat_type,
        "text": message.text or "",
        "created_at": message.created_at.isoformat(),
        "edited_at": message.edited_at.isoformat() if message.edited_at else None,
        "sender": {"id": message.sender.id, "username": message.sender.username} if message.sender else {"id": message.sender_id, "username": "user"},
        "recipient": {"id": message.recipient.id, "username": message.recipient.username} if message.recipient else None,
        "attachment": attachment,
    }

def admin_chat_conversation_title(kind: str, left: User | None = None, right: User | None = None) -> str:
    if kind == "group":
        return "Общий чат"
    return f"ЛС: {left.username if left else '?'} ↔ {right.username if right else '?'}"

def admin_chat_conversation_key(kind: str, left_id: int | None = None, right_id: int | None = None) -> str:
    if kind == "group":
        return "group"
    a, b = sorted([int(left_id or 0), int(right_id or 0)])
    return f"direct:{a}:{b}"

def chat_attachment_public(message: ChatMessage) -> dict[str, Any] | None:
    if not message.attachment_storage_path:
        return None
    return {
        "url": f"/api/chat/attachments/{message.id}",
        "preview_url": f"/api/chat/attachments/{message.id}/preview",
        "original_name": message.attachment_original_name or "file",
        "mime_type": message.attachment_mime_type or "application/octet-stream",
        "size": message.attachment_size or 0,
        "kind": message.attachment_kind or "file",
    }


def chat_message_public(message: ChatMessage, current_user: User | None = None) -> dict[str, Any]:
    deleted = message.deleted_at is not None
    can_modify = bool(current_user and can_modify_chat_message(current_user, message))
    return {
        "id": message.id,
        "chat_type": message.chat_type,
        "text": "" if deleted else (message.text or ""),
        "created_at": message.created_at.isoformat(),
        "edited_at": message.edited_at.isoformat() if message.edited_at else None,
        "deleted_at": message.deleted_at.isoformat() if message.deleted_at else None,
        "is_deleted": deleted,
        "can_edit": bool(can_modify and not message.attachment_storage_path),
        "can_delete": can_modify,
        "read_info": getattr(message, "_read_info", None),
        "sender": {"id": message.sender.id, "username": message.sender.username} if message.sender else {"id": message.sender_id, "username": "user"},
        "recipient": {"id": message.recipient.id, "username": message.recipient.username} if message.recipient else None,
        "room": {"id": message.room.id, "title": message.room.title} if getattr(message, "room", None) else None,
        "room_id": message.room_id,
        "is_own": bool(current_user and message.sender_id == current_user.id),
        "attachment": None if deleted else chat_attachment_public(message),
    }


def resolve_direct_recipient(db: Session, sender: User, username: str | None) -> User:
    peer_username = normalize_username(username or "")
    if not peer_username:
        raise HTTPException(status_code=400, detail="Укажи логин собеседника")
    peer = db.scalar(select(User).where(User.username == peer_username))
    if peer is None:
        raise HTTPException(status_code=404, detail="Пользователь с таким логином не найден")
    if peer.id == sender.id:
        raise HTTPException(status_code=400, detail="Нельзя открыть ЛС с самим собой")
    return peer


async def broadcast_chat_event(db: Session, message: ChatMessage, event_type: str = "message") -> None:
    db.refresh(message)
    payload = {"type": event_type, "message": chat_message_public(message)}
    if message.chat_type == "saved":
        await CHAT_MANAGER.send_to_user(message.sender_id, payload)
        return
    if message.chat_type == "group":
        await CHAT_MANAGER.broadcast_group(payload)
        return
    if message.chat_type == "room" and message.room_id:
        user_ids = {row[0] for row in db.query(ChatRoomMember.user_id).filter(ChatRoomMember.room_id == message.room_id).all()}
    else:
        user_ids = {message.sender_id}
        if message.recipient_id:
            user_ids.add(message.recipient_id)
    for user_id in user_ids:
        await CHAT_MANAGER.send_to_user(user_id, payload)


async def broadcast_chat_message(db: Session, message: ChatMessage) -> None:
    await broadcast_chat_event(db, message, "message")


def read_text_attachment(path: Path, max_chars: int = 200_000) -> str:
    data = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "cp1251"):
        try:
            return data.decode(encoding)[:max_chars]
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")[:max_chars]


def markdown_to_safe_html(text: str) -> str:
    safe = html_escape(text)
    safe = re.sub(r"^###\s+(.+)$", r"<h3>\1</h3>", safe, flags=re.MULTILINE)
    safe = re.sub(r"^##\s+(.+)$", r"<h2>\1</h2>", safe, flags=re.MULTILINE)
    safe = re.sub(r"^#\s+(.+)$", r"<h1>\1</h1>", safe, flags=re.MULTILINE)
    safe = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", safe)
    safe = re.sub(r"`([^`]+)`", r"<code>\1</code>", safe)
    lines = safe.splitlines()
    output = []
    in_list = False
    for line in lines:
        m = re.match(r"^[-*]\s+(.+)$", line)
        if m:
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{m.group(1)}</li>")
            continue
        if in_list:
            output.append("</ul>")
            in_list = False
        if line.startswith("<h") or not line.strip():
            output.append(line or "")
        else:
            output.append(f"<p>{line}</p>")
    if in_list:
        output.append("</ul>")
    return "\n".join(output)


def notebook_to_safe_html(text: str) -> str:
    try:
        nb = json.loads(text)
    except Exception:
        return f"<pre>{html_escape(text)}</pre>"
    cells = nb.get("cells", []) if isinstance(nb, dict) else []
    html = ["<div class='chat-preview-notebook'>"]
    for idx, cell in enumerate(cells[:80], start=1):
        cell_type = cell.get("cell_type", "cell") if isinstance(cell, dict) else "cell"
        source = cell.get("source", "") if isinstance(cell, dict) else ""
        if isinstance(source, list):
            source = "".join(source)
        source = str(source)
        html.append(f"<section class='notebook-cell notebook-{html_escape(cell_type)}'><div class='notebook-label'>Ячейка {idx} · {html_escape(cell_type)}</div>")
        if cell_type == "markdown":
            html.append(markdown_to_safe_html(source))
        else:
            html.append(f"<pre><code>{html_escape(source)}</code></pre>")
        html.append("</section>")
    if len(cells) > 80:
        html.append(f"<p class='muted'>Показаны первые 80 ячеек из {len(cells)}.</p>")
    html.append("</div>")
    return "\n".join(html)


def docx_to_safe_html(path: Path) -> str:
    try:
        with zipfile.ZipFile(path) as docx:
            xml = docx.read("word/document.xml")
        root = ET.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        paragraphs = []
        for para in root.findall(".//w:body/w:p", ns):
            parts = []
            for node in para.findall(".//w:t", ns):
                parts.append(node.text or "")
            text = "".join(parts).strip()
            if text:
                paragraphs.append(f"<p>{html_escape(text)}</p>")
        if not paragraphs:
            return "<p class='muted'>В документе не найден текст для предпросмотра.</p>"
        return "<div class='chat-preview-docx'>" + "\n".join(paragraphs[:300]) + "</div>"
    except Exception as exc:
        return f"<p class='muted'>Не удалось открыть DOCX онлайн: {html_escape(str(exc))}</p>"

def admin_credentials_configured() -> bool:
    return bool(os.getenv("ADMIN_USERNAME") and os.getenv("ADMIN_PASSWORD"))


def get_admin_user(authorization: Optional[str] = Header(default=None), admin_token: Optional[str] = Query(default=None)) -> str:
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
    elif admin_token:
        token = admin_token.strip()
    if not token:
        raise HTTPException(status_code=401, detail="Admin auth required")
    if token not in ADMIN_TOKENS:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    return "admin"


def user_summary(db: Session, user: User) -> dict[str, Any]:
    stats = build_stats(db, user)
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    is_online = bool(user.last_seen_at and datetime.utcnow() - user.last_seen_at <= timedelta(seconds=online_timeout))
    return {
        "id": user.id,
        "username": user.username,
        "created_at": user.created_at.isoformat(),
        "last_seen_at": user.last_seen_at.isoformat() if user.last_seen_at else None,
        "is_online": is_online,
        "status": "online" if is_online else "offline",
        "has_password": bool(user.password_hash),
        "readiness": stats["readiness"],
        "accuracy": stats["accuracy"],
        "coverage": stats["coverage"],
        "answered_unique": stats["answered_unique"],
        "total_questions": stats["total_questions"],
        "correct_answers": stats["correct_answers"],
        "wrong_answers": stats["wrong_answers"],
        "sessions_total": stats["sessions_total"],
    }


def report_summary(report: ErrorReport) -> dict[str, Any]:
    question_payload = None
    if report.question is not None:
        question_payload = {
            "id": report.question.id,
            "external_id": report.question.external_id,
            "prompt": report.question.prompt,
            "kind": report.question.kind,
            "difficulty": report.question.difficulty,
            "source": report.question.source,
            "correct_choice_index": report.question.correct_choice_index,
            "answer_text": report.question.answer_text,
            "answer_value": report.question.answer_value,
            "tolerance": report.question.tolerance,
            "topic_title": report.question.topic.title if report.question.topic else None,
            "topic_external_id": report.question.topic.external_id if report.question.topic else None,
            "choices": [
                {
                    "id": choice.id,
                    "index": choice.position,
                    "text": choice.text,
                    "is_correct": choice.is_correct,
                }
                for choice in sorted(report.question.choices, key=lambda item: item.position)
            ],
        }
    topic_payload = None
    topic = report.topic or (report.question.topic if report.question is not None else None)
    if topic is not None:
        topic_payload = {"id": topic.id, "external_id": topic.external_id, "title": topic.title}
    return {
        "id": report.id,
        "target_type": report.target_type,
        "message": report.message,
        "page_context": report.page_context or {},
        "status": report.status,
        "created_at": report.created_at.isoformat(),
        "resolved_at": report.resolved_at.isoformat() if report.resolved_at else None,
        "sender": {"id": report.user.id, "username": report.user.username} if report.user else None,
        "question": question_payload,
        "topic": topic_payload,
    }

def normalize_question_external_id(value: str) -> str:
    return str(value or "").strip().upper()


def question_admin_payload(question: Question, override: QuestionOverride | None = None) -> dict[str, Any]:
    return {
        "id": question.id,
        "external_id": question.external_id,
        "prompt": question.prompt,
        "kind": question.kind,
        "difficulty": question.difficulty,
        "source": question.source,
        "correct_choice_index": question.correct_choice_index,
        "answer_text": question.answer_text,
        "answer_value": question.answer_value,
        "tolerance": question.tolerance,
        "explanation": question.explanation,
        "topic": {"id": question.topic.id, "external_id": question.topic.external_id, "title": question.topic.title} if question.topic else None,
        "choices": [
            {"index": choice.position, "text": choice.text, "is_correct": choice.is_correct}
            for choice in sorted(question.choices, key=lambda item: item.position)
        ],
        "has_override": override is not None,
        "override_updated_at": override.updated_at.isoformat() if override else None,
    }


def normalize_question_override_payload(payload: AdminQuestionOverrideRequest | dict[str, Any]) -> dict[str, Any]:
    raw = payload.model_dump() if isinstance(payload, AdminQuestionOverrideRequest) else dict(payload or {})
    kind = str(raw.get("kind") or "mcq").strip()
    difficulty = str(raw.get("difficulty") or "easy").strip()
    source = str(raw.get("source") or "manual").strip()[:40] or "manual"
    prompt = str(raw.get("prompt") or "").strip()
    explanation = str(raw.get("explanation") or "").strip()
    choices = [str(item).strip() for item in (raw.get("choices") or []) if str(item).strip()]
    correct_choice_index = raw.get("correct_choice_index")
    answer_text = raw.get("answer_text")
    answer_text = str(answer_text).strip() if answer_text is not None and str(answer_text).strip() else None
    answer_value = raw.get("answer_value")
    tolerance = raw.get("tolerance")

    if not prompt:
        raise HTTPException(status_code=400, detail="Текст вопроса не может быть пустым")
    if kind == "mcq":
        if len(choices) < 2:
            raise HTTPException(status_code=400, detail="Для вопроса с вариантами нужно минимум два варианта ответа")
        if correct_choice_index is None:
            raise HTTPException(status_code=400, detail="Укажи номер правильного варианта")
        correct_choice_index = int(correct_choice_index)
        if correct_choice_index < 0 or correct_choice_index >= len(choices):
            raise HTTPException(status_code=400, detail="Правильный вариант выходит за пределы списка")
        answer_text = None
        answer_value = None
        tolerance = None
    else:
        choices = []
        correct_choice_index = None
        if answer_text is None and answer_value is None:
            raise HTTPException(status_code=400, detail="Для ручного ввода укажи answer_text или answer_value")
        if tolerance is not None and float(tolerance) < 0:
            raise HTTPException(status_code=400, detail="Допуск не может быть отрицательным")

    return {
        "prompt": prompt,
        "kind": kind,
        "difficulty": difficulty,
        "source": source,
        "choices": choices,
        "correct_choice_index": correct_choice_index,
        "answer_text": answer_text,
        "answer_value": answer_value,
        "tolerance": tolerance,
        "explanation": explanation,
    }


def apply_question_payload(db: Session, question: Question, payload: dict[str, Any]) -> None:
    clean = normalize_question_override_payload(payload)
    question.prompt = clean["prompt"]
    question.kind = clean["kind"]
    question.difficulty = clean["difficulty"]
    question.source = clean["source"]
    question.correct_choice_index = clean["correct_choice_index"]
    question.answer_text = clean["answer_text"]
    question.answer_value = clean["answer_value"]
    question.tolerance = clean["tolerance"]
    question.explanation = clean["explanation"]
    question.raw_json = {**(question.raw_json or {}), **clean, "override_applied": True}
    db.query(Choice).filter(Choice.question_id == question.id).delete(synchronize_session=False)
    db.flush()
    for idx, text in enumerate(clean["choices"]):
        db.add(Choice(question_id=question.id, position=idx, text=text, is_correct=(idx == clean["correct_choice_index"])))


def apply_question_overrides(db: Session) -> int:
    rows = db.query(QuestionOverride).all()
    applied = 0
    for item in rows:
        external_id = normalize_question_external_id(item.external_id)
        question = db.scalar(select(Question).where(Question.external_id == external_id))
        if question is None:
            continue
        apply_question_payload(db, question, item.payload_json or {})
        applied += 1
    db.commit()
    return applied


def find_bundled_question_payload(external_id: str) -> dict[str, Any] | None:
    target = normalize_question_external_id(external_id)
    payload = json.loads(QUESTIONS_PATH.read_text(encoding="utf-8"))
    for item in list(payload.get("questions", [])) + list(payload.get("official_sample", [])):
        if normalize_question_external_id(item.get("external_id")) == target:
            choices = list(item.get("choices") or [])
            return {
                "prompt": item.get("prompt") or "",
                "kind": item.get("kind") or "mcq",
                "difficulty": item.get("difficulty") or "easy",
                "source": item.get("source") or "manual",
                "choices": choices,
                "correct_choice_index": item.get("correct_choice_index"),
                "answer_text": item.get("answer_text"),
                "answer_value": item.get("answer_value"),
                "tolerance": item.get("tolerance"),
                "explanation": item.get("explanation") or "",
            }
    return None



@app.on_event("startup")
def startup() -> None:
    CHAT_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    seed_current_patch_note()
    migrate_auth_columns()
    migrate_simple_theory_columns()
    migrate_chat_message_columns()
    db = SessionLocal()
    try:
        seed_questions_from_json(db, QUESTIONS_PATH, force=False)
        apply_question_overrides(db)
    finally:
        db.close()


@app.get("/")
def index_page() -> HTMLResponse:
    return render_versioned_html(APP_DIR / "static" / "index.html")


@app.get("/admin")
def admin_page() -> HTMLResponse:
    return render_versioned_html(APP_DIR / "admin_static" / "index.html")




@app.get("/api/notifications")
def user_notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    dismissed = dismissed_keys(db, user)
    hidden = hidden_keys(db, user)
    notes = read_patch_notes()
    items: list[dict[str, Any]] = []
    for item in notes.get("active", []):
        key = patch_note_key(item, archived=False)
        if key and ("patch", key) not in dismissed and ("hidden_patch", key) not in hidden:
            items.append(patch_note_public(item, archived=False))
    notifications = db.query(AdminNotification).filter(AdminNotification.is_active.is_(True)).order_by(AdminNotification.created_at.desc()).limit(20).all()
    for notification in notifications:
        key = str(notification.id)
        if ("notification", key) not in dismissed and ("hidden_notification", key) not in hidden:
            items.append(notification_public(notification))
    return {"items": items}


@app.get("/api/notifications/history")
def notification_history(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    dismissed = dismissed_keys(db, user)
    hidden = hidden_keys(db, user)
    notes = read_patch_notes()
    patch_items = [patch_note_public(item, archived=False) for item in notes.get("active", [])]
    patch_items += [patch_note_public(item, archived=True) for item in notes.get("archive", [])]
    patch_items = [item for item in patch_items if ("hidden_patch", str(item["key"])) not in hidden]
    notifications = db.query(AdminNotification).order_by(AdminNotification.created_at.desc()).limit(100).all()
    notification_items = [notification_public(item) for item in notifications if ("hidden_notification", str(item.id)) not in hidden]
    for item in patch_items + notification_items:
        item["dismissed"] = (item["type"], str(item["key"])) in dismissed
    return {"items": sorted(patch_items + notification_items, key=lambda x: str(x.get("created_at") or ""), reverse=True)}


@app.post("/api/notifications/dismiss")
def dismiss_notification(payload: NotificationDismissRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    existing = db.scalar(select(NotificationDismissal).where(
        NotificationDismissal.user_id == user.id,
        NotificationDismissal.item_type == payload.item_type,
        NotificationDismissal.item_key == payload.item_key,
    ))
    if existing is None:
        db.add(NotificationDismissal(user_id=user.id, item_type=payload.item_type, item_key=payload.item_key))
        db.commit()
    return {"status": "dismissed"}


@app.post("/api/notifications/clear-all")
def clear_all_notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    notes = read_patch_notes()
    pairs: list[tuple[str, str]] = []
    for item in notes.get("active", []):
        key = patch_note_key(item, archived=False)
        if key:
            pairs.append(("hidden_patch", key))
    for item in notes.get("archive", []):
        key = patch_note_key(item, archived=True)
        if key:
            pairs.append(("hidden_patch", key))
    for notification in db.query(AdminNotification).all():
        pairs.append(("hidden_notification", str(notification.id)))
    created = 0
    for item_type, item_key in pairs:
        exists = db.scalar(select(NotificationDismissal).where(
            NotificationDismissal.user_id == user.id,
            NotificationDismissal.item_type == item_type,
            NotificationDismissal.item_key == item_key,
        ))
        if exists is None:
            db.add(NotificationDismissal(user_id=user.id, item_type=item_type, item_key=item_key))
            created += 1
    db.commit()
    return {"status": "cleared", "hidden": created}




def chat_preview_text(message: ChatMessage | None) -> str:
    if message is None:
        return "Сообщений пока нет"
    text = (message.text or "").strip()
    if text:
        return text[:120]
    if message.attachment_original_name:
        return f"📎 {message.attachment_original_name}"
    return "Сообщение"



def chat_scope_peer_id(user: User, chat_type: str, peer: User | None = None) -> int | None:
    return peer.id if chat_type == "direct" and peer is not None else None

def chat_scope_room_id(chat_type: str, room: ChatRoom | None = None, room_id: int | None = None) -> int | None:
    if chat_type != "room":
        return None
    return room.id if room is not None else room_id

def get_chat_read_state(db: Session, user: User, chat_type: str, peer: User | None = None, room: ChatRoom | None = None, room_id: int | None = None) -> ChatReadState | None:
    return db.scalar(select(ChatReadState).where(
        ChatReadState.user_id == user.id,
        ChatReadState.chat_type == chat_type,
        ChatReadState.peer_user_id == chat_scope_peer_id(user, chat_type, peer),
        ChatReadState.room_id == chat_scope_room_id(chat_type, room, room_id),
    ))

def set_chat_read_state(db: Session, user: User, chat_type: str, peer: User | None, last_message_id: int, room: ChatRoom | None = None) -> ChatReadState:
    state = get_chat_read_state(db, user, chat_type, peer, room=room)
    if state is None:
        state = ChatReadState(user_id=user.id, chat_type=chat_type, peer_user_id=chat_scope_peer_id(user, chat_type, peer), room_id=chat_scope_room_id(chat_type, room), last_read_message_id=0)
        db.add(state)
    state.last_read_message_id = max(int(state.last_read_message_id or 0), int(last_message_id or 0))
    state.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(state)
    return state

def apply_message_read_info(db: Session, current_user: User, messages: list[ChatMessage]) -> None:
    for message in messages:
        read_info: dict[str, Any] | None = None
        if message.sender_id == current_user.id and message.deleted_at is None:
            if message.chat_type == "direct" and message.recipient_id:
                state = db.scalar(select(ChatReadState).where(
                    ChatReadState.user_id == message.recipient_id,
                    ChatReadState.chat_type == "direct",
                    ChatReadState.peer_user_id == current_user.id,
                    ChatReadState.room_id.is_(None),
                ))
                read_info = {"kind": "direct", "read": bool(state and state.last_read_message_id >= message.id)}
            elif message.chat_type == "group":
                count = db.query(ChatReadState).filter(
                    ChatReadState.chat_type == "group",
                    ChatReadState.room_id.is_(None),
                    ChatReadState.user_id != current_user.id,
                    ChatReadState.last_read_message_id >= message.id,
                ).count()
                read_info = {"kind": "group", "read_count": count}
            elif message.chat_type == "room" and message.room_id:
                count = db.query(ChatReadState).filter(
                    ChatReadState.chat_type == "room",
                    ChatReadState.room_id == message.room_id,
                    ChatReadState.user_id != current_user.id,
                    ChatReadState.last_read_message_id >= message.id,
                ).count()
                read_info = {"kind": "group", "read_count": count}
        setattr(message, "_read_info", read_info)


def chat_message_public_for_user(db: Session, message: ChatMessage, current_user: User) -> dict[str, Any]:
    apply_message_read_info(db, current_user, [message])
    return chat_message_public(message, current_user=current_user)


def unread_count_for_scope(db: Session, user: User, chat_type: str, peer: User | None = None, room: ChatRoom | None = None) -> int:
    if chat_type == "saved":
        return 0
    state = get_chat_read_state(db, user, chat_type, peer, room=room)
    last_id = int(state.last_read_message_id or 0) if state else 0
    query = db.query(ChatMessage).filter(ChatMessage.id > last_id, ChatMessage.sender_id != user.id, ChatMessage.deleted_at.is_(None))
    if chat_type == "group":
        query = query.filter(ChatMessage.chat_type == "group")
    elif chat_type == "direct":
        if peer is None:
            return 0
        query = query.filter(
            ChatMessage.chat_type == "direct",
            (((ChatMessage.sender_id == user.id) & (ChatMessage.recipient_id == peer.id)) | ((ChatMessage.sender_id == peer.id) & (ChatMessage.recipient_id == user.id))),
        )
    elif chat_type == "room":
        if room is None:
            return 0
        query = query.filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id)
    return query.count()

def chat_conversation_public(kind: str, title: str, last_message: ChatMessage | None, peer: User | None = None, unread_count: int = 0, room: ChatRoom | None = None) -> dict[str, Any]:
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    is_online = bool(peer and peer.last_seen_at and datetime.utcnow() - peer.last_seen_at <= timedelta(seconds=online_timeout))
    return {
        "type": kind,
        "peer": peer.username if peer else None,
        "room_id": room.id if room else None,
        "title": title,
        "updated_at": last_message.created_at.isoformat() if last_message else None,
        "last_message": chat_preview_text(last_message),
        "last_sender": last_message.sender.username if last_message and last_message.sender else None,
        "has_attachment": bool(last_message and last_message.attachment_storage_path and last_message.deleted_at is None),
        "unread_count": unread_count,
        "is_online": is_online,
        "last_seen_at": peer.last_seen_at.isoformat() if peer and peer.last_seen_at else None,
    }




@app.post("/api/chat/rooms")
def create_chat_room(payload: ChatRoomCreateRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    title = payload.title.strip()[:160]
    usernames = []
    seen_names: set[str] = set()
    for raw in payload.usernames:
        name = normalize_username(raw)
        if name and name not in seen_names and name != user.username:
            usernames.append(name)
            seen_names.add(name)
    if not usernames:
        raise HTTPException(status_code=400, detail="Добавь хотя бы одного участника")
    users = db.query(User).filter(User.username.in_(usernames)).all()
    found = {item.username for item in users}
    missing = [name for name in usernames if name not in found]
    if missing:
        raise HTTPException(status_code=404, detail=f"Пользователь не найден: {missing[0]}")
    room = ChatRoom(title=title, creator_id=user.id)
    db.add(room)
    db.flush()
    db.add(ChatRoomMember(room_id=room.id, user_id=user.id))
    for member in users:
        db.add(ChatRoomMember(room_id=room.id, user_id=member.id))
    db.commit()
    db.refresh(room)
    return {"room": {"id": room.id, "title": room.title, "members": [user.username] + [member.username for member in users]}}


@app.get("/api/chat/conversations")
def chat_conversations(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    saved_last = (
        db.query(ChatMessage)
        .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
        .filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == user.id, ChatMessage.deleted_at.is_(None))
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .first()
    )
    group_last = (
        db.query(ChatMessage)
        .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
        .filter(ChatMessage.chat_type == "group", ChatMessage.deleted_at.is_(None))
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .first()
    )
    direct_rows = (
        db.query(ChatMessage)
        .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
        .filter(
            ChatMessage.chat_type == "direct",
            ChatMessage.deleted_at.is_(None),
            ((ChatMessage.sender_id == user.id) | (ChatMessage.recipient_id == user.id)),
        )
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(500)
        .all()
    )
    room_items: list[dict[str, Any]] = []
    memberships = (
        db.query(ChatRoomMember)
        .options(selectinload(ChatRoomMember.room))
        .filter(ChatRoomMember.user_id == user.id)
        .order_by(ChatRoomMember.created_at.desc())
        .all()
    )
    for membership in memberships:
        room = membership.room
        if room is None:
            continue
        last = (
            db.query(ChatMessage)
            .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room))
            .filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id, ChatMessage.deleted_at.is_(None))
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .first()
        )
        room_items.append(chat_conversation_public("room", room.title, last, unread_count=unread_count_for_scope(db, user, "room", room=room), room=room))
    hidden_direct = {
        row.peer_user_id: int(row.last_hidden_message_id or 0)
        for row in db.query(ChatDialogHidden).filter(ChatDialogHidden.user_id == user.id, ChatDialogHidden.chat_type == "direct").all()
        if row.peer_user_id
    }
    direct_items: list[dict[str, Any]] = []
    seen_peer_ids: set[int] = set()
    for message in direct_rows:
        peer = message.recipient if message.sender_id == user.id else message.sender
        if peer is None or peer.id in seen_peer_ids:
            continue
        if int(hidden_direct.get(peer.id, 0)) >= int(message.id or 0):
            continue
        seen_peer_ids.add(peer.id)
        direct_items.append(chat_conversation_public("direct", f"ЛС с {peer.username}", message, peer=peer, unread_count=unread_count_for_scope(db, user, "direct", peer)))
    items = [chat_conversation_public("saved", "Избранное", saved_last), chat_conversation_public("group", "Общий чат", group_last, unread_count=unread_count_for_scope(db, user, "group"))] + room_items + direct_items
    total_unread = sum(int(item.get("unread_count") or 0) for item in items)
    return {"items": items, "unread_total": total_unread}




@app.get("/api/chat/users/search")
def chat_user_search(q: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    term = normalize_username(q)
    if len(term) < 1:
        return {"items": []}
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    users = (
        db.query(User)
        .filter(User.id != user.id, User.username.ilike(f"%{term}%"))
        .order_by(User.username.asc())
        .limit(8)
        .all()
    )
    return {
        "items": [
            {
                "id": item.id,
                "username": item.username,
                "is_online": bool(item.last_seen_at and datetime.utcnow() - item.last_seen_at <= timedelta(seconds=online_timeout)),
            }
            for item in users
        ]
    }

@app.get("/api/chat/unread-count")
def chat_unread_count(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    data = chat_conversations(db=db, user=user)
    return {"unread_total": data.get("unread_total", 0), "items": data.get("items", [])}


@app.post("/api/chat/read")
async def chat_mark_read(payload: ChatReadRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    chat_type = normalize_chat_type(payload.chat_type)
    peer_user = resolve_direct_recipient(db, user, payload.peer) if chat_type == "direct" else None
    room = require_chat_room_member(db, user, payload.room_id) if chat_type == "room" else None
    last_id = payload.last_message_id
    if last_id <= 0:
        query = db.query(ChatMessage.id).filter(ChatMessage.deleted_at.is_(None))
        if chat_type == "saved":
            query = query.filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == user.id)
        elif chat_type == "group":
            query = query.filter(ChatMessage.chat_type == "group")
        elif chat_type == "direct":
            query = query.filter(
                ChatMessage.chat_type == "direct",
                (((ChatMessage.sender_id == user.id) & (ChatMessage.recipient_id == peer_user.id)) | ((ChatMessage.sender_id == peer_user.id) & (ChatMessage.recipient_id == user.id))),
            )
        else:
            query = query.filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id)
        last_id = query.order_by(ChatMessage.id.desc()).limit(1).scalar() or 0
    state = set_chat_read_state(db, user, chat_type, peer_user, last_id, room=room)
    event = {
        "type": "read_state",
        "chat_type": chat_type,
        "peer": peer_user.username if peer_user else None,
        "room_id": room.id if room else None,
        "reader": {"id": user.id, "username": user.username},
        "last_read_message_id": state.last_read_message_id,
    }
    if chat_type == "saved":
        await CHAT_MANAGER.send_to_user(user.id, event)
    elif chat_type == "group":
        await CHAT_MANAGER.broadcast_group(event)
    elif chat_type == "room":
        user_ids = {row[0] for row in db.query(ChatRoomMember.user_id).filter(ChatRoomMember.room_id == room.id).all()}
        for user_id in user_ids:
            await CHAT_MANAGER.send_to_user(user_id, event)
    else:
        await CHAT_MANAGER.send_to_user(user.id, event)
        await CHAT_MANAGER.send_to_user(peer_user.id, event)
    return {"status": "ok", "last_read_message_id": state.last_read_message_id}






@app.get("/api/chat/rooms/{room_id}")
def chat_room_detail(room_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    room = require_chat_room_member(db, user, room_id)
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    members = []
    rows = db.query(ChatRoomMember).options(selectinload(ChatRoomMember.user)).filter(ChatRoomMember.room_id == room.id).order_by(ChatRoomMember.created_at.asc()).all()
    for membership in rows:
        member = membership.user
        if not member:
            continue
        is_online = bool(member.last_seen_at and datetime.utcnow() - member.last_seen_at <= timedelta(seconds=online_timeout))
        members.append({
            "id": member.id,
            "username": member.username,
            "is_online": is_online,
            "last_seen_at": member.last_seen_at.isoformat() if member.last_seen_at else None,
        })
    return {"room": {"id": room.id, "title": room.title, "created_at": room.created_at.isoformat()}, "members": members}


@app.delete("/api/chat/dialogs/direct/{username}")
def chat_hide_direct_dialog(username: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    peer = resolve_direct_recipient(db, user, username)
    last_id = db.query(ChatMessage.id).filter(
        ChatMessage.chat_type == "direct",
        ChatMessage.deleted_at.is_(None),
        (((ChatMessage.sender_id == user.id) & (ChatMessage.recipient_id == peer.id)) | ((ChatMessage.sender_id == peer.id) & (ChatMessage.recipient_id == user.id))),
    ).order_by(ChatMessage.id.desc()).limit(1).scalar() or 0
    hidden = db.scalar(select(ChatDialogHidden).where(
        ChatDialogHidden.user_id == user.id,
        ChatDialogHidden.chat_type == "direct",
        ChatDialogHidden.peer_user_id == peer.id,
    ))
    if hidden is None:
        hidden = ChatDialogHidden(user_id=user.id, chat_type="direct", peer_user_id=peer.id, last_hidden_message_id=int(last_id or 0))
        db.add(hidden)
    else:
        hidden.last_hidden_message_id = max(int(hidden.last_hidden_message_id or 0), int(last_id or 0))
        hidden.hidden_at = datetime.utcnow()
    db.commit()
    return {"status": "hidden", "peer": peer.username, "last_hidden_message_id": int(last_id or 0)}


@app.delete("/api/chat/rooms/{room_id}/leave")
def chat_leave_room(room_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    room = db.get(ChatRoom, room_id)
    membership = get_room_member(db, user, room_id)
    if room is None or membership is None:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    db.delete(membership)
    db.commit()
    return {"status": "left", "room_id": room_id}


@app.post("/api/chat/messages/{message_id}/forward")
async def chat_forward_message(
    message_id: int,
    payload: ChatForwardRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    original = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    if original is None or original.deleted_at is not None or not can_user_see_chat_message(user, original, db):
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    chat_type = normalize_chat_type(payload.chat_type)
    recipient = resolve_direct_recipient(db, user, payload.peer) if chat_type == "direct" else None
    room = require_chat_room_member(db, user, payload.room_id) if chat_type == "room" else None
    prefix = f"Переслано от {original.sender.username if original.sender else 'пользователя'}"
    source_text = (original.text or "").strip()
    extra_text = (payload.text or "").strip()
    text_parts = [prefix]
    if source_text:
        text_parts.append(source_text)
    if extra_text:
        text_parts.append(extra_text)
    message = ChatMessage(
        chat_type=chat_type,
        sender_id=user.id,
        recipient_id=recipient.id if recipient else None,
        room_id=room.id if room else None,
        text="\n\n".join(text_parts)[:5000],
        attachment_original_name=original.attachment_original_name,
        attachment_storage_path=original.attachment_storage_path,
        attachment_mime_type=original.attachment_mime_type,
        attachment_size=original.attachment_size,
        attachment_kind=original.attachment_kind,
    )
    db.add(message)
    db.commit()
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room)).get(message.id)
    await broadcast_chat_message(db, message)
    return {"message": chat_message_public_for_user(db, message, user)}

@app.get("/api/chat/history")
def chat_history(
    chat_type: str = "group",
    peer: Optional[str] = None,
    room_id: Optional[int] = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    chat_type = normalize_chat_type(chat_type)
    query = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room))
    if chat_type == "saved":
        query = query.filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == user.id, ChatMessage.deleted_at.is_(None))
        chat_title = "Избранное"
    elif chat_type == "group":
        query = query.filter(ChatMessage.chat_type == "group", ChatMessage.deleted_at.is_(None))
        chat_title = "Общий чат"
    elif chat_type == "direct":
        peer_user = resolve_direct_recipient(db, user, peer)
        query = query.filter(
            ChatMessage.chat_type == "direct",
            ChatMessage.deleted_at.is_(None),
            (
                ((ChatMessage.sender_id == user.id) & (ChatMessage.recipient_id == peer_user.id)) |
                ((ChatMessage.sender_id == peer_user.id) & (ChatMessage.recipient_id == user.id))
            ),
        )
        chat_title = f"ЛС с {peer_user.username}"
    else:
        room = require_chat_room_member(db, user, room_id)
        query = query.filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id, ChatMessage.deleted_at.is_(None))
        chat_title = room.title
    rows = query.order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc()).limit(min(max(limit, 1), 300)).all()
    rows.reverse()
    apply_message_read_info(db, user, rows)
    return {"chat_type": chat_type, "peer": peer, "title": chat_title, "items": [chat_message_public(row, current_user=user) for row in rows]}


@app.post("/api/chat/upload")
async def chat_upload(
    chat_type: str = Form(default="group"),
    recipient_username: Optional[str] = Form(default=None),
    room_id: Optional[int] = Form(default=None),
    text: str = Form(default=""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    chat_type = normalize_chat_type(chat_type)
    recipient = resolve_direct_recipient(db, user, recipient_username) if chat_type == "direct" else None
    room = require_chat_room_member(db, user, room_id) if chat_type == "room" else None
    original_name = Path(file.filename or "file").name[:255] or "file"
    kind, mime = attachment_kind_for(original_name, file.content_type)
    content = await file.read(CHAT_MAX_UPLOAD_BYTES + 1)
    if len(content) > CHAT_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Файл слишком большой. Лимит: {CHAT_MAX_UPLOAD_MB} МБ")
    if not content:
        raise HTTPException(status_code=400, detail="Файл пустой")
    today = datetime.utcnow()
    extension = safe_file_extension(kind, original_name, mime)
    rel_dir = Path(str(today.year), f"{today.month:02d}", f"{today.day:02d}")
    target_dir = CHAT_MEDIA_DIR / rel_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{extension}"
    target_path = target_dir / stored_name
    target_path.write_bytes(content)
    message = ChatMessage(
        chat_type=chat_type,
        sender_id=user.id,
        recipient_id=recipient.id if recipient else None,
        room_id=room.id if room else None,
        text=(text or "").strip()[:5000],
        attachment_original_name=original_name,
        attachment_storage_path=str((rel_dir / stored_name).as_posix()),
        attachment_mime_type=mime,
        attachment_size=len(content),
        attachment_kind=kind,
    )
    db.add(message)
    db.commit()
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room)).get(message.id)
    await broadcast_chat_message(db, message)
    return {"message": chat_message_public_for_user(db, message, user)}


@app.patch("/api/chat/messages/{message_id}")
async def chat_update_message(
    message_id: int,
    payload: ChatMessageUpdateRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    if message is None or not can_user_see_chat_message(user, message, db):
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    if not can_modify_chat_message(user, message):
        raise HTTPException(status_code=403, detail="Редактировать сообщение можно только в течение суток")
    message.text = payload.text.strip()[:5000]
    message.edited_at = datetime.utcnow()
    db.commit()
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    await broadcast_chat_event(db, message, "message_updated")
    return {"message": chat_message_public_for_user(db, message, user)}


@app.delete("/api/chat/messages/{message_id}")
async def chat_delete_message(
    message_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    if message is None or not can_user_see_chat_message(user, message, db):
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    if not can_modify_chat_message(user, message):
        raise HTTPException(status_code=403, detail="Удалить сообщение можно только в течение суток")
    message.deleted_at = datetime.utcnow()
    message.text = ""
    db.commit()
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    await broadcast_chat_event(db, message, "message_deleted")
    return {"message": chat_message_public_for_user(db, message, user)}


@app.get("/api/chat/attachments/{message_id}")
def chat_attachment(
    message_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_from_optional_token),
) -> FileResponse:
    message = db.get(ChatMessage, message_id)
    if message is None or message.deleted_at is not None or not message.attachment_storage_path or not can_user_see_chat_message(user, message, db):
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = (CHAT_MEDIA_DIR / message.attachment_storage_path).resolve()
    root = CHAT_MEDIA_DIR.resolve()
    if root not in path.parents and path != root:
        raise HTTPException(status_code=404, detail="Файл не найден")
    if not path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден на диске")
    disposition = "inline" if (message.attachment_kind in {"image", "text", "markdown", "notebook", "docx", "pdf"}) else "attachment"
    return FileResponse(
        path,
        media_type=message.attachment_mime_type or "application/octet-stream",
        filename=message.attachment_original_name or path.name,
        content_disposition_type=disposition,
    )


@app.get("/api/chat/attachments/{message_id}/preview")
def chat_attachment_preview(
    message_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user_from_optional_token),
) -> HTMLResponse:
    message = db.get(ChatMessage, message_id)
    if message is None or message.deleted_at is not None or not message.attachment_storage_path or not can_user_see_chat_message(user, message, db):
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = (CHAT_MEDIA_DIR / message.attachment_storage_path).resolve()
    root = CHAT_MEDIA_DIR.resolve()
    if root not in path.parents and path != root or not path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден")
    title = html_escape(message.attachment_original_name or "Файл")
    kind = message.attachment_kind or "file"
    if kind == "text":
        body = f"<pre>{html_escape(read_text_attachment(path))}</pre>"
    elif kind == "markdown":
        body = markdown_to_safe_html(read_text_attachment(path))
    elif kind == "notebook":
        body = notebook_to_safe_html(read_text_attachment(path, max_chars=1_000_000))
    elif kind == "docx":
        body = docx_to_safe_html(path)
    elif kind == "pdf":
        pdf_url = f"/api/chat/attachments/{message.id}?token={html_escape(user_token_for_preview(db, user))}"
        body = f"<iframe class='preview-pdf' src='{pdf_url}' title='{title}'></iframe>"
    elif kind == "image":
        body = f"<img class='preview-image' src='/api/chat/attachments/{message.id}?token={html_escape(user_token_for_preview(db, user))}' alt='{title}'>"
    else:
        body = "<p>Онлайн-просмотр для этого файла недоступен.</p>"
    html = f"""<!doctype html><html lang='ru'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>{title}</title><style>
    body{{margin:0;background:#f4f7fb;color:#172033;font-family:Inter,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;line-height:1.6}}
    main{{width:min(980px,calc(100% - 24px));margin:20px auto;background:#fff;border:1px solid #d9e0ea;border-radius:18px;padding:20px;box-shadow:0 10px 28px rgba(20,33,61,.08)}}
    h1{{font-size:24px;margin:0 0 14px}} pre{{white-space:pre-wrap;overflow:auto;background:#0f172a;color:#e2e8f0;border-radius:14px;padding:14px}} code{{background:#eef2ff;border-radius:6px;padding:2px 5px}} .preview-image{{max-width:100%;height:auto;border-radius:14px}} .preview-pdf{{width:100%;height:78vh;border:1px solid #d9e0ea;border-radius:14px}} .notebook-cell{{border:1px solid #d9e0ea;border-radius:14px;margin:12px 0;padding:12px;background:#fbfdff}} .notebook-label{{font-weight:800;color:#667085;margin-bottom:8px}} p{{margin:8px 0}}
    </style></head><body><main><h1>{title}</h1>{body}</main></body></html>"""
    return HTMLResponse(html)


def user_token_for_preview(db: Session, user: User) -> str:
    token = db.scalar(select(AuthToken.token).where(AuthToken.user_id == user.id).order_by(AuthToken.created_at.desc()))
    return token or ""


@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket, token: Optional[str] = None) -> None:
    db = SessionLocal()
    user = get_user_by_token(db, token)
    if user is None:
        await websocket.close(code=1008)
        db.close()
        return
    await CHAT_MANAGER.connect(user.id, websocket)
    await websocket.send_json({"type": "connected", "user": {"id": user.id, "username": user.username}})
    try:
        while True:
            data = await websocket.receive_json()
            event_type = data.get("type")
            if event_type != "message":
                continue
            user.last_seen_at = datetime.utcnow()
            db.commit()
            db.refresh(user)
            text_value = str(data.get("text") or "").strip()
            if not text_value:
                await websocket.send_json({"type": "error", "message": "Нельзя отправить пустое сообщение"})
                continue
            if len(text_value) > 5000:
                await websocket.send_json({"type": "error", "message": "Сообщение слишком длинное"})
                continue
            chat_type = normalize_chat_type(data.get("chat_type"))
            recipient = resolve_direct_recipient(db, user, data.get("recipient_username")) if chat_type == "direct" else None
            room = require_chat_room_member(db, user, data.get("room_id")) if chat_type == "room" else None
            message = ChatMessage(
                chat_type=chat_type,
                sender_id=user.id,
                recipient_id=recipient.id if recipient else None,
                room_id=room.id if room else None,
                text=text_value,
            )
            db.add(message)
            db.commit()
            message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room)).get(message.id)
            await broadcast_chat_message(db, message)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.send_json({"type": "error", "message": "Ошибка чата"})
        except Exception:
            pass
    finally:
        CHAT_MANAGER.disconnect(user.id, websocket)
        db.close()

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






@app.get("/api/admin/notifications")
def admin_notifications(db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    notes = read_patch_notes()
    notifications = db.query(AdminNotification).order_by(AdminNotification.created_at.desc()).limit(200).all()
    return {
        "patch_notes": notes,
        "notifications": [notification_public(item) for item in notifications],
    }


@app.post("/api/admin/notifications")
def admin_create_notification(payload: AdminNotificationRequest, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    item = AdminNotification(title=payload.title.strip(), message=payload.message.strip())
    db.add(item)
    db.commit()
    db.refresh(item)
    return notification_public(item)


@app.post("/api/admin/notifications/{notification_id}/disable")
def admin_disable_notification(notification_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    item = db.get(AdminNotification, notification_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    item.is_active = False
    db.commit()
    db.refresh(item)
    return notification_public(item)


@app.post("/api/admin/notifications/{notification_id}/delete")
def admin_delete_notification(notification_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    item = db.get(AdminNotification, notification_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    db.delete(item)
    db.query(NotificationDismissal).filter(
        NotificationDismissal.item_type.in_(["notification", "hidden_notification"]),
        NotificationDismissal.item_key == str(notification_id),
    ).delete(synchronize_session=False)
    db.commit()
    return {"status": "deleted", "id": notification_id}


@app.post("/api/admin/patch-notes/update")
def admin_update_patch_notes(payload: AdminPatchNotesUpdateRequest, admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    notes = read_patch_notes()
    clean_changes = [item.strip() for item in payload.changes if item and item.strip()]
    if not clean_changes:
        raise HTTPException(status_code=400, detail="Добавь хотя бы одно изменение")
    active = notes.get("active", [])
    current = active[0] if active else {}
    notes["active"] = [{
        "id": current.get("id") or "site-update",
        "title": payload.title.strip() or "Сайт обновился",
        "created_at": current.get("created_at") or datetime.utcnow().isoformat(),
        "changes": clean_changes,
    }]
    write_patch_notes(notes)
    return {"status": "updated", "patch_notes": notes}


@app.post("/api/admin/patch-notes/clear")
def admin_clear_patch_notes(admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    notes = read_patch_notes()
    active = notes.get("active", [])
    cleared_at = datetime.utcnow().isoformat()
    batch_id = f"clear-{int(datetime.utcnow().timestamp())}"
    archived = []
    for item in active:
        copied = dict(item)
        copied["cleared_at"] = cleared_at
        copied["archive_batch"] = batch_id
        archived.append(copied)
    notes["archive"] = archived + list(notes.get("archive", []))
    notes["active"] = []
    write_patch_notes(notes)
    return {"status": "cleared", "moved": len(archived), "batch_id": batch_id}


@app.get("/api/admin/metrics")
def admin_metrics(db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    now = datetime.utcnow()
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    online_since = now - timedelta(seconds=online_timeout)
    users_total = db.query(User).count()
    online_users = db.query(User).filter(User.last_seen_at.isnot(None), User.last_seen_at >= online_since).count()
    reports_total = db.query(ErrorReport).count()
    reports_new = db.query(ErrorReport).filter(ErrorReport.status == "new").count()
    reports_reviewed = db.query(ErrorReport).filter(ErrorReport.status == "reviewed").count()
    reports_resolved = db.query(ErrorReport).filter(ErrorReport.status == "resolved").count()
    active_sessions = db.query(TestSession).filter(TestSession.status == "active").count()
    questions_total = db.query(Question).count()
    topics_total = db.query(Topic).count()
    request_values = list(REQUEST_DURATIONS_MS)
    page_values = list(PAGE_LOAD_DURATIONS_MS)
    return {
        "timestamp": now.isoformat(),
        "uptime_seconds": int((now - STARTED_AT).total_seconds()),
        "requests_total": METRICS["requests_total"],
        "api_requests_total": METRICS["api_requests_total"],
        "static_requests_total": METRICS["static_requests_total"],
        "errors_total": METRICS["errors_total"],
        "avg_response_ms": average(request_values),
        "p95_response_ms": percentile(request_values, 0.95),
        "last_response_ms": METRICS["last_response_ms"],
        "page_load_count": len(page_values),
        "avg_page_load_ms": average(page_values),
        "p95_page_load_ms": percentile(page_values, 0.95),
        "last_page_load_ms": round(page_values[-1], 2) if page_values else 0.0,
        "users_total": users_total,
        "online_users": online_users,
        "offline_users": max(users_total - online_users, 0),
        "reports_total": reports_total,
        "reports_new": reports_new,
        "reports_reviewed": reports_reviewed,
        "reports_resolved": reports_resolved,
        "active_sessions": active_sessions,
        "questions_total": questions_total,
        "topics_total": topics_total,
    }


@app.post("/api/metrics/page-load")
def record_page_load(payload: PageLoadMetricRequest, user: User = Depends(get_current_user)) -> dict[str, Any]:
    PAGE_LOAD_DURATIONS_MS.append(float(payload.duration_ms))
    return {"status": "ok"}


def admin_active_session_summary(db: Session, user: User) -> dict[str, Any] | None:
    session = (
        db.query(TestSession)
        .options(
            selectinload(TestSession.items).selectinload(SessionQuestion.question).selectinload(Question.topic),
            selectinload(TestSession.answers),
        )
        .filter(TestSession.user_id == user.id, TestSession.status == "active")
        .order_by(TestSession.started_at.desc(), TestSession.id.desc())
        .first()
    )
    if session is None:
        return None
    answered_ids = {answer.question_id for answer in session.answers}
    topics = []
    topic_seen = set()
    difficulties = []
    difficulty_seen = set()
    current_question = None
    for item in session.items:
        question = item.question
        if question.topic and question.topic.external_id not in topic_seen:
            topic_seen.add(question.topic.external_id)
            topics.append({"id": question.topic.id, "external_id": question.topic.external_id, "title": question.topic.title})
        if question.difficulty and question.difficulty not in difficulty_seen:
            difficulty_seen.add(question.difficulty)
            difficulties.append(question.difficulty)
        if current_question is None and question.id not in answered_ids:
            current_question = {
                "position": item.position + 1,
                "id": question.id,
                "external_id": question.external_id,
                "prompt": question.prompt,
                "topic_external_id": question.topic.external_id if question.topic else None,
                "topic_title": question.topic.title if question.topic else None,
                "difficulty": question.difficulty,
            }
    if current_question is None and session.items:
        item = session.items[-1]
        question = item.question
        current_question = {
            "position": item.position + 1,
            "id": question.id,
            "external_id": question.external_id,
            "prompt": question.prompt,
            "topic_external_id": question.topic.external_id if question.topic else None,
            "topic_title": question.topic.title if question.topic else None,
            "difficulty": question.difficulty,
        }
    return {
        "id": session.id,
        "mode": session.mode,
        "status": session.status,
        "started_at": session.started_at.isoformat(),
        "answered": len(answered_ids),
        "total": session.total,
        "topic_id": session.topic_id,
        "readiness_level": session.readiness_level,
        "difficulty": session.difficulty,
        "topics": sorted(topics, key=lambda item: int(item.get("external_id") or 0)),
        "difficulties": difficulties,
        "current_question": current_question,
    }




@app.get("/api/admin/chat/conversations")
def admin_chat_conversations(db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    group_last = (
        db.query(ChatMessage)
        .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
        .filter(ChatMessage.chat_type == "group", ChatMessage.deleted_at.is_(None))
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .first()
    )
    group_count = db.query(ChatMessage.id).filter(ChatMessage.chat_type == "group", ChatMessage.deleted_at.is_(None)).count()
    items.append({
        "key": "group",
        "type": "group",
        "title": "Общий чат",
        "count": group_count,
        "updated_at": group_last.created_at.isoformat() if group_last else None,
        "last_message": chat_preview_text(group_last),
        "last_sender": group_last.sender.username if group_last and group_last.sender else None,
    })
    saved_users = (
        db.query(User)
        .join(ChatMessage, ChatMessage.sender_id == User.id)
        .filter(ChatMessage.chat_type == "saved", ChatMessage.deleted_at.is_(None))
        .distinct()
        .order_by(User.username.asc())
        .all()
    )
    for saved_user in saved_users:
        last = (
            db.query(ChatMessage)
            .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
            .filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == saved_user.id, ChatMessage.deleted_at.is_(None))
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .first()
        )
        count = db.query(ChatMessage.id).filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == saved_user.id, ChatMessage.deleted_at.is_(None)).count()
        items.append({
            "key": f"saved:{saved_user.id}",
            "type": "saved",
            "title": f"Избранное: {saved_user.username}",
            "users": [saved_user.username],
            "count": count,
            "updated_at": last.created_at.isoformat() if last else None,
            "last_message": chat_preview_text(last),
            "last_sender": saved_user.username,
        })
    for room in db.query(ChatRoom).order_by(ChatRoom.created_at.desc(), ChatRoom.id.desc()).all():
        last = (
            db.query(ChatMessage)
            .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient), selectinload(ChatMessage.room))
            .filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id, ChatMessage.deleted_at.is_(None))
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .first()
        )
        count = db.query(ChatMessage.id).filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id, ChatMessage.deleted_at.is_(None)).count()
        member_names = [row[0] for row in db.query(User.username).join(ChatRoomMember, ChatRoomMember.user_id == User.id).filter(ChatRoomMember.room_id == room.id).order_by(User.username.asc()).all()]
        items.append({
            "key": f"room:{room.id}",
            "type": "room",
            "title": f"Группа: {room.title}",
            "users": member_names,
            "count": count,
            "updated_at": (last.created_at if last else room.created_at).isoformat(),
            "last_message": chat_preview_text(last),
            "last_sender": last.sender.username if last and last.sender else None,
        })

    rows = (
        db.query(ChatMessage)
        .options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient))
        .filter(ChatMessage.chat_type == "direct", ChatMessage.deleted_at.is_(None))
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(2000)
        .all()
    )
    seen: set[tuple[int, int]] = set()
    for message in rows:
        if not message.sender or not message.recipient:
            continue
        a, b = sorted([message.sender_id, message.recipient_id])
        key_pair = (a, b)
        if key_pair in seen:
            continue
        seen.add(key_pair)
        left = message.sender if message.sender_id == a else message.recipient
        right = message.recipient if message.sender_id == a else message.sender
        count = db.query(ChatMessage.id).filter(
            ChatMessage.chat_type == "direct",
            ChatMessage.deleted_at.is_(None),
            (((ChatMessage.sender_id == a) & (ChatMessage.recipient_id == b)) | ((ChatMessage.sender_id == b) & (ChatMessage.recipient_id == a))),
        ).count()
        items.append({
            "key": admin_chat_conversation_key("direct", a, b),
            "type": "direct",
            "title": admin_chat_conversation_title("direct", left, right),
            "users": [left.username if left else str(a), right.username if right else str(b)],
            "count": count,
            "updated_at": message.created_at.isoformat(),
            "last_message": chat_preview_text(message),
            "last_sender": message.sender.username if message.sender else None,
        })
    return {"items": items}


@app.get("/api/admin/chat/messages")
def admin_chat_messages(chat_key: str = "group", limit: int = 200, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    query = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).filter(ChatMessage.deleted_at.is_(None))
    title = "Общий чат"
    members: list[dict[str, Any]] = []
    room_for_actions: ChatRoom | None = None
    if chat_key == "group":
        query = query.filter(ChatMessage.chat_type == "group")
    elif chat_key.startswith("saved:"):
        try:
            saved_user_id = int(chat_key.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный чат")
        saved_user = db.get(User, saved_user_id)
        if saved_user is None:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        title = f"Избранное: {saved_user.username}"
        query = query.filter(ChatMessage.chat_type == "saved", ChatMessage.sender_id == saved_user.id)
    elif chat_key.startswith("room:"):
        try:
            room_id = int(chat_key.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный чат")
        room = db.get(ChatRoom, room_id)
        if room is None:
            raise HTTPException(status_code=404, detail="Чат не найден")
        title = f"Группа: {room.title}"
        room_for_actions = room
        members = [
            {"id": member.user.id, "username": member.user.username}
            for member in db.query(ChatRoomMember).options(selectinload(ChatRoomMember.user)).filter(ChatRoomMember.room_id == room.id).order_by(ChatRoomMember.created_at.asc()).all()
            if member.user
        ]
        query = query.filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room.id)
    elif chat_key.startswith("direct:"):
        try:
            _, raw_a, raw_b = chat_key.split(":", 2)
            a, b = int(raw_a), int(raw_b)
        except ValueError:
            raise HTTPException(status_code=400, detail="Некорректный чат")
        left = db.get(User, a)
        right = db.get(User, b)
        title = admin_chat_conversation_title("direct", left, right)
        query = query.filter(
            ChatMessage.chat_type == "direct",
            (((ChatMessage.sender_id == a) & (ChatMessage.recipient_id == b)) | ((ChatMessage.sender_id == b) & (ChatMessage.recipient_id == a))),
        )
    else:
        raise HTTPException(status_code=400, detail="Некорректный чат")
    rows = query.order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc()).limit(min(max(limit, 1), 500)).all()
    rows.reverse()
    return {"chat_key": chat_key, "title": title, "room_id": room_for_actions.id if room_for_actions else None, "members": members, "items": [admin_chat_message_public(row) for row in rows]}


@app.delete("/api/admin/chat/messages/{message_id}")
async def admin_chat_delete_message(message_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    if message is None or message.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    media_deleted = remove_chat_media_if_unused(db, message)
    message.deleted_at = datetime.utcnow()
    message.text = ""
    message.attachment_storage_path = None
    message.attachment_original_name = None
    message.attachment_mime_type = None
    message.attachment_size = None
    message.attachment_kind = None
    db.commit()
    message = db.query(ChatMessage).options(selectinload(ChatMessage.sender), selectinload(ChatMessage.recipient)).get(message_id)
    await broadcast_chat_event(db, message, "message_deleted")
    return {"status": "deleted", "message_id": message_id, "media_deleted": media_deleted}




@app.delete("/api/admin/chat/rooms/{room_id}/members/{user_id}")
def admin_chat_remove_room_member(room_id: int, user_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    room = db.get(ChatRoom, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    membership = db.scalar(select(ChatRoomMember).where(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="Участник не найден")
    db.delete(membership)
    db.commit()
    return {"status": "removed", "room_id": room_id, "user_id": user_id}


@app.delete("/api/admin/chat/rooms/{room_id}")
async def admin_chat_delete_room(room_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    room = db.get(ChatRoom, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    member_ids = [row[0] for row in db.query(ChatRoomMember.user_id).filter(ChatRoomMember.room_id == room_id).all()]
    messages = db.query(ChatMessage).filter(ChatMessage.chat_type == "room", ChatMessage.room_id == room_id).all()
    media_deleted = 0
    for message in messages:
        if message.attachment_storage_path and remove_chat_media_if_unused(db, message):
            media_deleted += 1
        db.delete(message)
    db.query(ChatReadState).filter(ChatReadState.chat_type == "room", ChatReadState.room_id == room_id).delete(synchronize_session=False)
    db.query(ChatRoomMember).filter(ChatRoomMember.room_id == room_id).delete(synchronize_session=False)
    db.delete(room)
    db.commit()
    event = {"type": "room_deleted", "room_id": room_id}
    for member_id in member_ids:
        await CHAT_MANAGER.send_to_user(member_id, event)
    return {"status": "deleted", "room_id": room_id, "messages_deleted": len(messages), "media_deleted": media_deleted}


@app.get("/api/admin/chat/attachments/{message_id}")
def admin_chat_attachment(message_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> FileResponse:
    message = db.get(ChatMessage, message_id)
    if message is None or message.deleted_at is not None or not message.attachment_storage_path:
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = (CHAT_MEDIA_DIR / message.attachment_storage_path).resolve()
    root = CHAT_MEDIA_DIR.resolve()
    if root not in path.parents and path != root or not path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден")
    disposition = "inline" if (message.attachment_kind in {"image", "text", "markdown", "notebook", "docx", "pdf"}) else "attachment"
    return FileResponse(
        path,
        media_type=message.attachment_mime_type or "application/octet-stream",
        filename=message.attachment_original_name or path.name,
        content_disposition_type=disposition,
    )


@app.get("/api/admin/chat/attachments/{message_id}/preview")
def admin_chat_attachment_preview(message_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user), admin_token: Optional[str] = Query(default=None)) -> HTMLResponse:
    message = db.get(ChatMessage, message_id)
    if message is None or message.deleted_at is not None or not message.attachment_storage_path:
        raise HTTPException(status_code=404, detail="Файл не найден")
    path = (CHAT_MEDIA_DIR / message.attachment_storage_path).resolve()
    root = CHAT_MEDIA_DIR.resolve()
    if root not in path.parents and path != root or not path.exists():
        raise HTTPException(status_code=404, detail="Файл не найден")
    title = html_escape(message.attachment_original_name or "Файл")
    kind = message.attachment_kind or "file"
    token_param = html_escape(admin_token or "")
    if kind == "text":
        body = f"<pre>{html_escape(read_text_attachment(path))}</pre>"
    elif kind == "markdown":
        body = markdown_to_safe_html(read_text_attachment(path))
    elif kind == "notebook":
        body = notebook_to_safe_html(read_text_attachment(path, max_chars=1_000_000))
    elif kind == "docx":
        body = docx_to_safe_html(path)
    elif kind == "pdf":
        pdf_url = f"/api/admin/chat/attachments/{message.id}?admin_token={token_param}"
        body = f"<iframe class='preview-pdf' src='{pdf_url}' title='{title}'></iframe>"
    elif kind == "image":
        body = f"<img class='preview-image' src='/api/admin/chat/attachments/{message.id}?admin_token={token_param}' alt='{title}'>"
    else:
        body = "<p>Онлайн-просмотр для этого файла недоступен.</p>"
    html = f"""<!doctype html><html lang='ru'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>{title}</title><style>
    body{{margin:0;background:#f4f7fb;color:#172033;font-family:Inter,system-ui,-apple-system,'Segoe UI',Arial,sans-serif;line-height:1.6}}
    main{{width:min(980px,calc(100% - 24px));margin:20px auto;background:#fff;border:1px solid #d9e0ea;border-radius:18px;padding:20px;box-shadow:0 10px 28px rgba(20,33,61,.08)}}
    h1{{font-size:24px;margin:0 0 14px}} pre{{white-space:pre-wrap;overflow:auto;background:#0f172a;color:#e2e8f0;border-radius:14px;padding:14px}} code{{background:#eef2ff;border-radius:6px;padding:2px 5px}} .preview-image{{max-width:100%;height:auto;border-radius:14px}} .preview-pdf{{width:100%;height:78vh;border:1px solid #d9e0ea;border-radius:14px}} .notebook-cell{{border:1px solid #d9e0ea;border-radius:14px;margin:12px 0;padding:12px;background:#fbfdff}} .notebook-label{{font-weight:800;color:#667085;margin-bottom:8px}} p{{margin:8px 0}}
    </style></head><body><main><h1>{title}</h1>{body}</main></body></html>"""
    return HTMLResponse(html)


@app.get("/api/admin/users")
def admin_users(status: Optional[str] = None, q: Optional[str] = None, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> list[dict[str, Any]]:
    query = db.query(User)
    if q:
        query = query.filter(User.username.ilike(f"%{q.strip().lower()}%"))
    users = query.order_by(User.created_at.desc(), User.id.desc()).all()
    summaries = [user_summary(db, user) for user in users]
    if status in {"online", "offline"}:
        summaries = [item for item in summaries if item["status"] == status]
    return summaries


@app.get("/api/admin/users/{user_id}/progress")
def admin_user_progress(user_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    stats = build_stats(db, user)
    online_timeout = int(os.getenv("ONLINE_TIMEOUT_SECONDS", "60"))
    stats["user_id"] = user.id
    stats["username"] = user.username
    stats["created_at"] = user.created_at.isoformat()
    stats["last_seen_at"] = user.last_seen_at.isoformat() if user.last_seen_at else None
    stats["is_online"] = bool(user.last_seen_at and datetime.utcnow() - user.last_seen_at <= timedelta(seconds=online_timeout))
    stats["has_password"] = bool(user.password_hash)
    stats["active_session"] = admin_active_session_summary(db, user)
    return stats


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


@app.get("/api/admin/questions/{external_id}")
def admin_get_question(external_id: str, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    qid = normalize_question_external_id(external_id)
    question = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).filter(Question.external_id == qid).first()
    if question is None:
        raise HTTPException(status_code=404, detail="Вопрос с таким ID не найден")
    override = db.scalar(select(QuestionOverride).where(QuestionOverride.external_id == qid))
    return {"question": question_admin_payload(question, override), "override": override.payload_json if override else None}


@app.put("/api/admin/questions/{external_id}/override")
def admin_save_question_override(external_id: str, payload: AdminQuestionOverrideRequest, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    qid = normalize_question_external_id(external_id)
    question = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).filter(Question.external_id == qid).first()
    if question is None:
        raise HTTPException(status_code=404, detail="Вопрос с таким ID не найден")
    clean = normalize_question_override_payload(payload)
    override = db.scalar(select(QuestionOverride).where(QuestionOverride.external_id == qid))
    if override is None:
        override = QuestionOverride(external_id=qid, payload_json=clean)
        db.add(override)
    else:
        override.payload_json = clean
        override.updated_at = datetime.utcnow()
    apply_question_payload(db, question, clean)
    db.commit()
    db.refresh(question)
    question = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).get(question.id)
    return {"status": "saved", "question": question_admin_payload(question, override)}


@app.delete("/api/admin/questions/{external_id}/override")
def admin_delete_question_override(external_id: str, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    qid = normalize_question_external_id(external_id)
    question = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).filter(Question.external_id == qid).first()
    if question is None:
        raise HTTPException(status_code=404, detail="Вопрос с таким ID не найден")
    override = db.scalar(select(QuestionOverride).where(QuestionOverride.external_id == qid))
    if override is not None:
        db.delete(override)
        db.flush()
    bundled = find_bundled_question_payload(qid)
    if bundled is not None:
        apply_question_payload(db, question, bundled)
    db.commit()
    question = db.query(Question).options(selectinload(Question.choices), selectinload(Question.topic)).get(question.id)
    return {"status": "reset", "question": question_admin_payload(question, None)}


@app.get("/api/admin/reports")
def admin_reports(status: Optional[str] = None, limit: int = 100, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> list[dict[str, Any]]:
    query = db.query(ErrorReport).options(
        selectinload(ErrorReport.user),
        selectinload(ErrorReport.question).selectinload(Question.topic),
        selectinload(ErrorReport.question).selectinload(Question.choices),
        selectinload(ErrorReport.topic),
    )
    if status in {"new", "reviewed", "resolved"}:
        query = query.filter(ErrorReport.status == status)
    rows = query.order_by(ErrorReport.created_at.desc(), ErrorReport.id.desc()).limit(min(max(limit, 1), 300)).all()
    return [report_summary(row) for row in rows]


@app.post("/api/admin/reports/{report_id}/status")
def admin_report_status(report_id: int, payload: AdminReportStatusRequest, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    report = db.get(ErrorReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    report.status = payload.status
    report.resolved_at = datetime.utcnow() if payload.status == "resolved" else None
    db.commit()
    db.refresh(report)
    return report_summary(report)

@app.delete("/api/admin/reports/{report_id}")
def admin_delete_report(report_id: int, db: Session = Depends(get_db), admin: str = Depends(get_admin_user)) -> dict[str, Any]:
    report = db.get(ErrorReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Report not found")
    db.delete(report)
    db.commit()
    return {"status": "deleted", "report_id": report_id}


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


@app.post("/api/auth/ping")
def auth_ping(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    user.last_seen_at = datetime.utcnow()
    db.commit()
    db.refresh(user)
    return {"status": "ok", "last_seen_at": user.last_seen_at.isoformat() if user.last_seen_at else None}


@app.post("/api/auth/logout")
def logout(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> dict[str, Any]:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        auth = db.scalar(select(AuthToken).where(AuthToken.token == token))
        user_id = auth.user_id if auth else None
        db.query(AuthToken).filter(AuthToken.token == token).delete(synchronize_session=False)
        if user_id is not None:
            remaining_tokens = db.query(AuthToken).filter(AuthToken.user_id == user_id).count()
            if remaining_tokens == 0:
                user = db.get(User, user_id)
                if user is not None:
                    user.last_seen_at = None
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
            "simple_theory": t.simple_theory,
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



def result_summary_payload(session: TestSession) -> dict[str, Any]:
    title = session_display_title(session)
    accuracy = round((session.correct_count / session.total) * 100, 1) if session.total else 0
    return {
        "id": session.id,
        "mode": session.mode,
        "title": title,
        "total": session.total,
        "correct_count": session.correct_count,
        "wrong_count": max(0, session.total - session.correct_count),
        "accuracy": accuracy,
        "started_at": session.started_at.isoformat(),
        "finished_at": session.finished_at.isoformat() if session.finished_at else None,
        "status": session.status,
        "restart_payload": session_restart_payload(session),
    }


@app.get("/api/results")
def results(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    rows = (
        db.query(TestSession)
        .options(selectinload(TestSession.items).selectinload(SessionQuestion.question).selectinload(Question.topic))
        .filter(TestSession.user_id == user.id, TestSession.status == "finished")
        .order_by(TestSession.finished_at.desc().nullslast(), TestSession.started_at.desc())
        .limit(100)
        .all()
    )
    return {"items": [result_summary_payload(session) for session in rows]}


@app.get("/api/results/{session_id}")
def result_details(session_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    session = db.get(TestSession, session_id)
    if not session or session.user_id != user.id or session.status != "finished":
        raise HTTPException(status_code=404, detail="Result not found")
    return session_payload(db, session, reveal_answered=True)


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
        .limit(1000)
        .all()
    )
    latest_by_question: dict[int, TestAnswer] = {}
    for answer in rows:
        if answer.question_id not in latest_by_question:
            latest_by_question[answer.question_id] = answer
        if len(latest_by_question) >= 300:
            break
    return [
        {
            "answered_at": a.answered_at.isoformat(),
            "selected_index": a.selected_index,
            "input_answer": a.input_answer,
            "question": question_public(a.question, include_answer=True),
        }
        for a in latest_by_question.values()
    ]




@app.post("/api/reports")
def create_error_report(payload: ErrorReportRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    message = payload.message.strip()
    if len(message) < 5:
        raise HTTPException(status_code=400, detail="Опишите ошибку чуть подробнее")
    question = None
    topic = None
    if payload.target_type == "question":
        if not payload.question_id:
            raise HTTPException(status_code=400, detail="Не указан вопрос")
        question = db.get(Question, payload.question_id)
        if question is None:
            raise HTTPException(status_code=404, detail="Question not found")
        topic = question.topic
    else:
        if not payload.topic_id:
            raise HTTPException(status_code=400, detail="Не указана тема")
        topic = db.get(Topic, payload.topic_id)
        if topic is None:
            raise HTTPException(status_code=404, detail="Topic not found")

    cooldown_seconds = int(os.getenv("REPORT_COOLDOWN_SECONDS", "60"))
    recent = (
        db.query(ErrorReport)
        .filter(ErrorReport.user_id == user.id)
        .order_by(ErrorReport.created_at.desc(), ErrorReport.id.desc())
        .first()
    )
    if recent and datetime.utcnow() - recent.created_at < timedelta(seconds=cooldown_seconds):
        remaining = cooldown_seconds - int((datetime.utcnow() - recent.created_at).total_seconds())
        raise HTTPException(status_code=429, detail=f"Жалобу можно отправлять не чаще одного раза в минуту. Подождите {max(1, remaining)} сек.")

    context = payload.page_context or {}
    safe_context = {str(k)[:80]: str(v)[:500] for k, v in context.items()}
    report = ErrorReport(
        user_id=user.id,
        target_type=payload.target_type,
        question_id=question.id if question is not None else None,
        topic_id=topic.id if topic is not None else None,
        message=message,
        page_context=safe_context,
        status="new",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return {"status": "created", "report_id": report.id}


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
