from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Choice, Exam, Question, Topic, User


def ensure_default_user(db: Session) -> User:
    user = db.scalar(select(User).where(User.username == "local"))
    if user is None:
        user = User(username="local")
        db.add(user)
        db.commit()
        db.refresh(user)
    return user




def migrate_question_metadata(db: Session, exam: Exam, payload: dict[str, Any] | None = None) -> None:
    """Small in-place migration for users who already ran an older zip.

    It keeps progress/history untouched, but updates metadata needed by newer
    preparation modes: four-level difficulty scale and official sample source.
    """
    db.query(Question).filter(
        Question.exam_id == exam.id,
        Question.source == "theory",
        Question.difficulty == "easy",
    ).update({Question.difficulty: "very_easy"}, synchronize_session=False)
    db.query(Question).filter(
        Question.exam_id == exam.id,
        Question.source == "exam_sample",
    ).update({Question.source: "official"}, synchronize_session=False)

    # Refresh theory text in already-created databases when a newer bundled
    # questions.json improves formatting or fixes formulas.
    if payload is not None:
        topic_theory = {int(t["external_id"]): t.get("theory", "") for t in payload.get("topics", [])}
        for topic in db.query(Topic).filter(Topic.exam_id == exam.id).all():
            if topic.external_id in topic_theory:
                topic.theory = topic_theory[topic.external_id]

        question_theory = {q["external_id"]: q.get("theory", "") for q in list(payload.get("questions", [])) + list(payload.get("official_sample", []))}
        for question in db.query(Question).filter(Question.exam_id == exam.id).all():
            if question.external_id in question_theory and question_theory[question.external_id]:
                question.theory = question_theory[question.external_id]

    db.commit()


def seed_questions_from_json(db: Session, json_path: str | Path, force: bool = False) -> dict[str, Any]:
    path = Path(json_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    exam_data = payload["exam"]

    exam = db.scalar(select(Exam).where(Exam.slug == exam_data["slug"]))
    if exam and not force:
        existing = db.query(Question).filter(Question.exam_id == exam.id).count()
        if existing > 0:
            ensure_default_user(db)
            migrate_question_metadata(db, exam, payload)
            return {"status": "skipped", "questions": existing, "reason": "database already seeded"}

    if exam is None:
        exam = Exam(slug=exam_data["slug"], title=exam_data["title"], description=exam_data.get("description", ""))
        db.add(exam)
        db.flush()
    else:
        exam.title = exam_data["title"]
        exam.description = exam_data.get("description", "")
        if force:
            db.query(Choice).filter(Choice.question_id.in_(db.query(Question.id).filter(Question.exam_id == exam.id))).delete(synchronize_session=False)
            db.query(Question).filter(Question.exam_id == exam.id).delete(synchronize_session=False)
            db.query(Topic).filter(Topic.exam_id == exam.id).delete(synchronize_session=False)
            db.flush()

    topic_map: dict[int, Topic] = {}
    for t in payload.get("topics", []):
        topic = Topic(
            exam_id=exam.id,
            external_id=int(t["external_id"]),
            title=t["title"],
            theory=t.get("theory", ""),
        )
        db.add(topic)
        db.flush()
        topic_map[topic.external_id] = topic

    imported = 0
    all_questions = list(payload.get("questions", [])) + list(payload.get("official_sample", []))
    for q in all_questions:
        topic = topic_map.get(int(q["topic_external_id"]))
        if topic is None:
            continue
        question = Question(
            exam_id=exam.id,
            topic_id=topic.id,
            external_id=q["external_id"],
            prompt=q["prompt"],
            kind=q.get("kind", "mcq"),
            explanation=q.get("explanation", ""),
            theory=q.get("theory") or topic.theory,
            source=q.get("source") or "theory",
            difficulty=q.get("difficulty") or "easy",
            correct_choice_index=q.get("correct_choice_index"),
            answer_text=q.get("answer_text"),
            answer_value=q.get("answer_value"),
            tolerance=q.get("tolerance"),
            aliases_json=q.get("aliases") or [],
            raw_json=q.get("raw") or q,
        )
        db.add(question)
        db.flush()
        for idx, text in enumerate(q.get("choices") or []):
            db.add(Choice(question_id=question.id, position=idx, text=text, is_correct=(idx == q.get("correct_choice_index"))))
        imported += 1

    ensure_default_user(db)
    db.commit()
    return {"status": "imported", "exam": exam.slug, "questions": imported, "topics": len(topic_map)}
