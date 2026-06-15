from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Exam(Base):
    __tablename__ = "exams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    topics: Mapped[list[Topic]] = relationship("Topic", back_populates="exam", cascade="all, delete-orphan")
    questions: Mapped[list[Question]] = relationship("Question", back_populates="exam", cascade="all, delete-orphan")


class Topic(Base):
    __tablename__ = "topics"
    __table_args__ = (
        UniqueConstraint("exam_id", "external_id", name="uq_topic_exam_external"),
        Index("ix_topics_exam_external", "exam_id", "external_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), index=True)
    external_id: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(255))
    theory: Mapped[str] = mapped_column(Text, default="")
    simple_theory: Mapped[str] = mapped_column(Text, default="")

    exam: Mapped[Exam] = relationship("Exam", back_populates="topics")
    questions: Mapped[list[Question]] = relationship("Question", back_populates="topic")


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("exam_id", "external_id", name="uq_question_exam_external"),
        Index("ix_questions_exam_topic_difficulty", "exam_id", "topic_id", "difficulty"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), index=True)
    topic_id: Mapped[int] = mapped_column(ForeignKey("topics.id", ondelete="CASCADE"), index=True)
    external_id: Mapped[str] = mapped_column(String(80), index=True)
    prompt: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(20), default="mcq")
    explanation: Mapped[str] = mapped_column(Text, default="")
    theory: Mapped[str] = mapped_column(Text, default="")
    simple_theory: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(40), default="theory", index=True)
    difficulty: Mapped[str] = mapped_column(String(20), default="easy", index=True)
    correct_choice_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    answer_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    answer_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    tolerance: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    aliases_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    raw_json: Mapped[dict] = mapped_column(JSON, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)

    exam: Mapped[Exam] = relationship("Exam", back_populates="questions")
    topic: Mapped[Topic] = relationship("Topic", back_populates="questions")
    choices: Mapped[list[Choice]] = relationship("Choice", back_populates="question", cascade="all, delete-orphan", order_by="Choice.position")


class Choice(Base):
    __tablename__ = "choices"
    __table_args__ = (Index("ix_choices_question_position", "question_id", "position"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)

    question: Mapped[Question] = relationship("Question", back_populates="choices")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True, default="local")
    password_hash: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped[User] = relationship("User")


class TestSession(Base):
    __tablename__ = "test_sessions"
    __table_args__ = (Index("ix_sessions_user_started", "user_id", "started_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"), index=True)
    mode: Mapped[str] = mapped_column(String(40))
    readiness_level: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    topic_id: Mapped[Optional[int]] = mapped_column(ForeignKey("topics.id"), nullable=True)
    difficulty: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    total: Mapped[int] = mapped_column(Integer, default=20)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    items: Mapped[list[SessionQuestion]] = relationship("SessionQuestion", back_populates="session", cascade="all, delete-orphan", order_by="SessionQuestion.position")
    answers: Mapped[list[TestAnswer]] = relationship("TestAnswer", back_populates="session", cascade="all, delete-orphan")


class SessionQuestion(Base):
    __tablename__ = "session_questions"
    __table_args__ = (
        UniqueConstraint("session_id", "question_id", name="uq_session_question"),
        Index("ix_session_question_position", "session_id", "position"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("test_sessions.id", ondelete="CASCADE"), index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)

    session: Mapped[TestSession] = relationship("TestSession", back_populates="items")
    question: Mapped[Question] = relationship("Question")


class TestAnswer(Base):
    __tablename__ = "test_answers"
    __table_args__ = (
        UniqueConstraint("session_id", "question_id", name="uq_answer_session_question"),
        Index("ix_answers_question", "question_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("test_sessions.id", ondelete="CASCADE"), index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"), index=True)
    selected_index: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    input_answer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    answered_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[TestSession] = relationship("TestSession", back_populates="answers")
    question: Mapped[Question] = relationship("Question")


class ErrorReport(Base):
    __tablename__ = "error_reports"
    __table_args__ = (
        Index("ix_error_reports_created", "created_at"),
        Index("ix_error_reports_target", "target_type", "question_id", "topic_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    target_type: Mapped[str] = mapped_column(String(20), index=True)
    question_id: Mapped[Optional[int]] = mapped_column(ForeignKey("questions.id", ondelete="SET NULL"), nullable=True, index=True)
    topic_id: Mapped[Optional[int]] = mapped_column(ForeignKey("topics.id", ondelete="SET NULL"), nullable=True, index=True)
    message: Mapped[str] = mapped_column(Text)
    page_context: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="new", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    user: Mapped[Optional[User]] = relationship("User")
    question: Mapped[Optional[Question]] = relationship("Question")
    topic: Mapped[Optional[Topic]] = relationship("Topic")


class AdminNotification(Base):
    __tablename__ = "admin_notifications"
    __table_args__ = (Index("ix_admin_notifications_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)


class NotificationDismissal(Base):
    __tablename__ = "notification_dismissals"
    __table_args__ = (
        UniqueConstraint("user_id", "item_type", "item_key", name="uq_notification_dismissal"),
        Index("ix_notification_dismissals_user", "user_id", "item_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    item_type: Mapped[str] = mapped_column(String(40))
    item_key: Mapped[str] = mapped_column(String(120))
    dismissed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped[User] = relationship("User")
