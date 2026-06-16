from __future__ import annotations

import json
import random
import re
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .models import Choice, Exam, Question, SessionQuestion, TestAnswer, TestSession, Topic, User

DIFFICULTY_ORDER = ["very_easy", "easy", "medium", "hard"]

EXAM_DIFFICULTY_RATIOS: dict[str, float] = {"very_easy": 0.10, "easy": 0.30, "medium": 0.50, "hard": 0.10}


def ratio_counts(total: int, ratios: dict[str, float]) -> dict[str, int]:
    """Convert difficulty ratios into exact integer counts.

    For the real-exam simulation this gives 2/6/10/2 for 20 questions.
    For custom counts it preserves the requested total using largest remainders.
    """
    total = max(0, int(total))
    raw = {key: total * float(ratio) for key, ratio in ratios.items()}
    counts = {key: int(value) for key, value in raw.items()}
    remainder = total - sum(counts.values())
    order = sorted(ratios, key=lambda key: (raw[key] - counts[key], ratios[key]), reverse=True)
    for key in order[:remainder]:
        counts[key] += 1
    return counts


READINESS_RATIOS: dict[int, dict[str, float]] = {
    30: {"very_easy": 0.70, "easy": 0.30, "medium": 0.00, "hard": 0.00},
    50: {"very_easy": 0.40, "easy": 0.40, "medium": 0.20, "hard": 0.00},
    70: {"very_easy": 0.20, "easy": 0.35, "medium": 0.35, "hard": 0.10},
    90: {"very_easy": 0.10, "easy": 0.25, "medium": 0.40, "hard": 0.25},
    100: {"very_easy": 0.05, "easy": 0.20, "medium": 0.35, "hard": 0.40},
}


def get_default_exam(db: Session) -> Exam:
    exam = db.scalar(select(Exam).where(Exam.slug == "numerical_methods"))
    if exam is None:
        exam = db.scalar(select(Exam).limit(1))
    if exam is None:
        raise ValueError("No exams found. Import questions first.")
    return exam


def get_default_user(db: Session) -> User:
    user = db.scalar(select(User).where(User.username == "local"))
    if user is None:
        user = User(username="local")
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def question_public(q: Question, include_answer: bool = False) -> dict[str, Any]:
    choices = [{"index": c.position, "text": c.text} for c in q.choices]
    if len(choices) > 1:
        random.shuffle(choices)
    payload = {
        "id": q.id,
        "external_id": q.external_id,
        "topic_id": q.topic_id,
        "topic_external_id": q.topic.external_id if q.topic else None,
        "topic_title": q.topic.title if q.topic else None,
        "prompt": q.prompt,
        "kind": q.kind,
        "choices": choices,
        "source": q.source,
        "difficulty": q.difficulty,
        "simple_theory": q.simple_theory or (q.topic.simple_theory if q.topic else ""),
    }
    if include_answer:
        payload.update(answer_payload(q))
        payload["ai_prompt"] = ai_prompt(q)
    return payload




def choice_text(q: Question, index: int | None) -> str | None:
    if index is None:
        return None
    for choice in q.choices:
        if choice.position == index:
            return choice.text
    return None


def session_display_title(session: TestSession) -> str:
    labels = {"very_easy": "самые простые", "easy": "простые", "medium": "средние", "hard": "сложные"}
    if session.mode == "custom":
        topic_nums = []
        seen = set()
        for item in session.items:
            topic = item.question.topic
            if topic and topic.external_id not in seen:
                seen.add(topic.external_id)
                topic_nums.append(topic.external_id)
        topic_nums = sorted(topic_nums)
        suffix = ", ".join(map(str, topic_nums[:8]))
        if len(topic_nums) > 8:
            suffix += ", ..."
        return f"Поток: темы {suffix}" if suffix else "Конструктор потока"
    if session.mode == "topic":
        topic = None
        if session.items:
            topic = session.items[0].question.topic
        return f"Тема {topic.external_id}. {topic.title}" if topic else "Тема"
    if session.mode == "difficulty":
        return f"Все вопросы: {labels.get(session.difficulty or '', session.difficulty or 'сложность')}"
    if session.mode == "readiness":
        return f"Готовность {session.readiness_level}%"
    if session.mode == "official":
        return "Образец"
    if session.mode == "errors":
        return "Ошибки"
    return "Экзамен"


def answer_payload(q: Question) -> dict[str, Any]:
    if q.kind == "mcq":
        correct_text = choice_text(q, q.correct_choice_index)
        return {
            "correct_choice_index": q.correct_choice_index,
            "correct_answer": correct_text,
            "explanation": q.explanation,
            "theory": q.theory or (q.topic.theory if q.topic else ""),
            "simple_theory": q.simple_theory or (q.topic.simple_theory if q.topic else ""),
        }
    return {
        "correct_choice_index": None,
        "correct_answer": q.answer_text,
        "explanation": q.explanation,
        "theory": q.theory or (q.topic.theory if q.topic else ""),
        "simple_theory": q.simple_theory or (q.topic.simple_theory if q.topic else ""),
    }


def normalize_text(value: str | None) -> str:
    if value is None:
        return ""
    value = value.strip().lower().replace("ё", "е")
    value = value.replace("−", "-")
    value = re.sub(r"\s+", " ", value)
    return value


def parse_float(value: str | None) -> float | None:
    if value is None:
        return None
    s = value.strip().replace(" ", "").replace("{,}", ".").replace(",", ".").replace("−", "-")
    s = re.sub(r"[^0-9eE+\-.]", "", s)
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def evaluate_answer(q: Question, selected_index: int | None = None, input_answer: str | None = None) -> bool:
    if q.kind == "mcq":
        return selected_index is not None and selected_index == q.correct_choice_index

    expected = q.answer_value
    user_value = parse_float(input_answer)
    if expected is not None and user_value is not None:
        tolerance = q.tolerance if q.tolerance is not None else max(abs(expected) * 1e-6, 1e-6)
        return abs(user_value - expected) <= tolerance

    user_text = normalize_text(input_answer)
    acceptable = [q.answer_text or ""] + list(q.aliases_json or [])
    return user_text in {normalize_text(x) for x in acceptable if x is not None}


def ai_prompt(q: Question) -> str:
    choices = "\n".join([f"{idx + 1}) {c.text}" for idx, c in enumerate(q.choices)]) or "Вопрос с вводом ответа."
    answer = answer_payload(q)["correct_answer"]
    theory = q.theory or (q.topic.theory if q.topic else "")
    return f"""Разбери вопрос по численным методам максимально понятно.

Вопрос:
{q.prompt}

Варианты ответа:
{choices}

Правильный ответ:
{answer}

Краткое объяснение из тренажёра:
{q.explanation}

Краткая теория по теме:
{theory}

Пожалуйста:
1. Объясни, почему правильный ответ именно такой.
2. Разбери, почему остальные варианты неверны или менее точны.
3. Дай необходимую теорию простыми словами.
4. Приведи 1–2 аналогичных примера.
5. Сформулируй короткую памятку, как отвечать на такие вопросы на экзамене.
""".strip()


def answer_stats(db: Session, user_id: int) -> dict[int, dict[str, int]]:
    rows = db.execute(
        select(TestAnswer.question_id, TestAnswer.is_correct, func.count(TestAnswer.id))
        .join(TestSession, TestSession.id == TestAnswer.session_id)
        .where(TestSession.user_id == user_id)
        .group_by(TestAnswer.question_id, TestAnswer.is_correct)
    ).all()
    stats: dict[int, dict[str, int]] = {}
    for qid, is_correct, count in rows:
        stats.setdefault(qid, {"correct": 0, "wrong": 0})
        stats[qid]["correct" if is_correct else "wrong"] += int(count)
    return stats


def weighted_pick(candidates: list[Question], count: int, stats: dict[int, dict[str, int]]) -> list[Question]:
    if not candidates:
        return []
    shuffled = list(candidates)
    random.shuffle(shuffled)

    def key(q: Question) -> tuple[float, float]:
        s = stats.get(q.id, {"correct": 0, "wrong": 0})
        attempts = s["correct"] + s["wrong"]
        weak_score = s["wrong"] * 3 - s["correct"]
        unseen_bonus = 2 if attempts == 0 else 0
        return (weak_score + unseen_bonus + random.random(), random.random())

    shuffled.sort(key=key, reverse=True)
    return shuffled[:count]


def base_query(db: Session, exam_id: int):
    return (
        db.query(Question)
        .options(selectinload(Question.choices), selectinload(Question.topic))
        .filter(Question.exam_id == exam_id, Question.is_active.is_(True))
    )


def generate_questions(
    db: Session,
    *,
    exam: Exam,
    user: User,
    mode: str = "exam",
    count: int = 20,
    topic_id: int | None = None,
    topic_ids: list[int] | None = None,
    readiness_level: int | None = None,
    difficulty: str | None = None,
    difficulties: list[str] | None = None,
) -> list[Question]:
    count = max(1, min(int(count), 1500))
    stats = answer_stats(db, user.id)
    query = base_query(db, exam.id)

    if mode != "official":
        query = query.filter(Question.source != "official")

    if mode == "official":
        candidates = query.filter(Question.source == "official").all()
        return weighted_pick(candidates, min(count, len(candidates)), stats)

    if mode == "custom":
        custom_query = query
        clean_topic_ids = [int(x) for x in (topic_ids or []) if x is not None]
        clean_difficulties = [x for x in (difficulties or []) if x in DIFFICULTY_ORDER]
        if clean_topic_ids:
            custom_query = custom_query.filter(Question.topic_id.in_(clean_topic_ids))
        if clean_difficulties:
            custom_query = custom_query.filter(Question.difficulty.in_(clean_difficulties))
        candidates = custom_query.all()
        return weighted_pick(candidates, min(count, len(candidates)), stats)

    if mode == "topic" and topic_id:
        candidates = query.filter(Question.topic_id == topic_id).all()
        return weighted_pick(candidates, count, stats)

    if mode == "difficulty" and difficulty:
        candidates = query.filter(Question.difficulty == difficulty).all()
        return weighted_pick(candidates, count, stats)

    if mode == "errors":
        wrong_ids = [qid for qid, s in stats.items() if s["wrong"] > 0]
        if not wrong_ids:
            return []
        candidates = query.filter(Question.id.in_(wrong_ids)).all()
        return weighted_pick(candidates, min(count, len(candidates)), stats)

    if mode == "readiness":
        level = readiness_level if readiness_level in READINESS_RATIOS else 50
        picked: list[Question] = []
        used: set[int] = set()
        ratios = READINESS_RATIOS[level]
        for diff, ratio in ratios.items():
            part_count = int(round(count * ratio))
            if part_count <= 0:
                continue
            candidates = query.filter(Question.difficulty == diff).all()
            part = [q for q in weighted_pick(candidates, part_count, stats) if q.id not in used]
            picked.extend(part)
            used.update(q.id for q in part)
        if len(picked) < count:
            fill = [q for q in query.all() if q.id not in used]
            picked.extend(weighted_pick(fill, count - len(picked), stats))
        random.shuffle(picked)
        return picked[:count]

    # Real-exam simulation: 10/30/50/10 for very_easy/easy/medium/hard.
    # For the default 20-question exam this gives 2/6/10/2.
    picked: list[Question] = []
    used: set[int] = set()
    target_counts = ratio_counts(count, EXAM_DIFFICULTY_RATIOS)
    for diff in DIFFICULTY_ORDER:
        part_count = target_counts.get(diff, 0)
        if part_count <= 0:
            continue
        candidates = query.filter(Question.difficulty == diff).all()
        part = []
        for q in weighted_pick(candidates, part_count, stats):
            if q.id not in used:
                part.append(q)
                used.add(q.id)
        picked.extend(part)

    if len(picked) < count:
        fill = [q for q in query.all() if q.id not in used]
        picked.extend(weighted_pick(fill, count - len(picked), stats))

    random.shuffle(picked)
    return picked[:count]


def matching_active_sessions_query(
    db: Session,
    *,
    user_id: int,
    exam_id: int,
    mode: str,
    topic_id: int | None = None,
    readiness_level: int | None = None,
    difficulty: str | None = None,
):
    query = db.query(TestSession).filter(
        TestSession.user_id == user_id,
        TestSession.exam_id == exam_id,
        TestSession.mode == mode,
        TestSession.status == "active",
    )
    if mode == "topic":
        query = query.filter(TestSession.topic_id == topic_id)
    else:
        query = query.filter(TestSession.topic_id.is_(None))

    if mode == "readiness":
        query = query.filter(TestSession.readiness_level == readiness_level)
    else:
        query = query.filter(TestSession.readiness_level.is_(None))

    if mode == "difficulty":
        query = query.filter(TestSession.difficulty == difficulty)
    else:
        query = query.filter(TestSession.difficulty.is_(None))
    return query


def find_active_session(
    db: Session,
    *,
    user: User | None = None,
    mode: str,
    topic_id: int | None = None,
    readiness_level: int | None = None,
    difficulty: str | None = None,
) -> TestSession | None:
    exam = get_default_exam(db)
    user = user or get_default_user(db)
    return (
        matching_active_sessions_query(
            db,
            user_id=user.id,
            exam_id=exam.id,
            mode=mode,
            topic_id=topic_id,
            readiness_level=readiness_level,
            difficulty=difficulty,
        )
        .order_by(TestSession.started_at.desc(), TestSession.id.desc())
        .first()
    )


def abandon_matching_active_sessions(
    db: Session,
    *,
    user_id: int,
    exam_id: int,
    mode: str,
    topic_id: int | None = None,
    readiness_level: int | None = None,
    difficulty: str | None = None,
) -> int:
    rows = matching_active_sessions_query(
        db,
        user_id=user_id,
        exam_id=exam_id,
        mode=mode,
        topic_id=topic_id,
        readiness_level=readiness_level,
        difficulty=difficulty,
    ).all()
    for session in rows:
        session.status = "abandoned"
        session.finished_at = datetime.utcnow()
    return len(rows)


def create_session(
    db: Session,
    *,
    user: User | None = None,
    mode: str,
    count: int,
    topic_id: int | None = None,
    topic_ids: list[int] | None = None,
    readiness_level: int | None = None,
    difficulty: str | None = None,
    difficulties: list[str] | None = None,
    restart: bool = False,
) -> TestSession:
    exam = get_default_exam(db)
    user = user or get_default_user(db)
    if restart:
        abandon_matching_active_sessions(
            db,
            user_id=user.id,
            exam_id=exam.id,
            mode=mode,
            topic_id=topic_id,
            readiness_level=readiness_level,
            difficulty=difficulty,
        )
    questions = generate_questions(
        db,
        exam=exam,
        user=user,
        mode=mode,
        count=count,
        topic_id=topic_id,
        topic_ids=topic_ids,
        readiness_level=readiness_level,
        difficulty=difficulty,
        difficulties=difficulties,
    )
    session = TestSession(
        user_id=user.id,
        exam_id=exam.id,
        mode=mode,
        readiness_level=readiness_level,
        topic_id=topic_id,
        difficulty=difficulty,
        total=len(questions),
    )
    db.add(session)
    db.flush()
    for idx, q in enumerate(questions):
        db.add(SessionQuestion(session_id=session.id, question_id=q.id, position=idx))
    db.commit()
    db.refresh(session)
    return session




def session_restart_payload(session: TestSession) -> dict[str, Any]:
    payload: dict[str, Any] = {"mode": session.mode, "count": session.total, "restart": True}
    if session.mode == "topic" and session.topic_id:
        payload["topic_id"] = session.topic_id
    if session.mode == "readiness" and session.readiness_level is not None:
        payload["readiness_level"] = session.readiness_level
    if session.mode == "difficulty" and session.difficulty:
        payload["difficulty"] = session.difficulty
    if session.mode == "custom":
        topic_ids = []
        topic_seen = set()
        difficulties = []
        difficulty_seen = set()
        for item in session.items:
            question = item.question
            if question.topic_id not in topic_seen:
                topic_seen.add(question.topic_id)
                topic_ids.append(question.topic_id)
            if question.difficulty and question.difficulty not in difficulty_seen:
                difficulty_seen.add(question.difficulty)
                difficulties.append(question.difficulty)
        payload["topic_ids"] = topic_ids
        payload["difficulties"] = difficulties
    return payload


def session_payload(db: Session, session: TestSession, reveal_answered: bool = True) -> dict[str, Any]:
    answers = {a.question_id: a for a in session.answers}
    items = []
    for item in session.items:
        q = item.question
        payload = question_public(q, include_answer=reveal_answered)
        answer = answers.get(q.id)
        if answer:
            payload["user_answer"] = {
                "selected_index": answer.selected_index,
                "input_answer": answer.input_answer,
                "is_correct": answer.is_correct,
                "answer_text": choice_text(q, answer.selected_index) if q.kind == "mcq" else answer.input_answer,
            }
        items.append({"position": item.position, "question": payload})
    return {
        "id": session.id,
        "title": session_display_title(session),
        "mode": session.mode,
        "readiness_level": session.readiness_level,
        "topic_id": session.topic_id,
        "difficulty": session.difficulty,
        "status": session.status,
        "started_at": session.started_at.isoformat(),
        "finished_at": session.finished_at.isoformat() if session.finished_at else None,
        "total": session.total,
        "answered": len(answers),
        "correct_count": sum(1 for a in answers.values() if a.is_correct),
        "restart_payload": session_restart_payload(session),
        "questions": items,
    }


def record_answer(
    db: Session,
    *,
    user: User | None = None,
    session_id: int,
    question_id: int,
    selected_index: int | None = None,
    input_answer: str | None = None,
) -> dict[str, Any]:
    session = db.get(TestSession, session_id)
    if not session:
        raise ValueError("Session not found")
    if user is not None and session.user_id != user.id:
        raise ValueError("Session not found")
    q = db.get(Question, question_id)
    if not q:
        raise ValueError("Question not found")
    is_correct = evaluate_answer(q, selected_index, input_answer)
    existing = db.scalar(select(TestAnswer).where(TestAnswer.session_id == session_id, TestAnswer.question_id == question_id))
    if existing:
        existing.selected_index = selected_index
        existing.input_answer = input_answer
        existing.is_correct = is_correct
        existing.answered_at = datetime.utcnow()
    else:
        db.add(TestAnswer(session_id=session_id, question_id=question_id, selected_index=selected_index, input_answer=input_answer, is_correct=is_correct))
    db.flush()
    session.correct_count = db.query(TestAnswer).filter(TestAnswer.session_id == session.id, TestAnswer.is_correct.is_(True)).count()
    if db.query(TestAnswer).filter(TestAnswer.session_id == session.id).count() >= session.total:
        session.status = "finished"
        session.finished_at = datetime.utcnow()
    db.commit()
    db.refresh(q)
    payload = answer_payload(q)
    payload.update({"is_correct": is_correct, "ai_prompt": ai_prompt(q)})
    return payload


def finish_session(db: Session, session_id: int, user: User | None = None) -> dict[str, Any]:
    session = db.get(TestSession, session_id)
    if not session:
        raise ValueError("Session not found")
    if user is not None and session.user_id != user.id:
        raise ValueError("Session not found")
    session.status = "finished"
    session.finished_at = datetime.utcnow()
    session.correct_count = db.query(TestAnswer).filter(TestAnswer.session_id == session.id, TestAnswer.is_correct.is_(True)).count()
    db.commit()
    return session_payload(db, session)


def build_stats(db: Session, user: User | None = None) -> dict[str, Any]:
    user = user or get_default_user(db)
    exam = get_default_exam(db)
    total_questions = db.query(Question).filter(Question.exam_id == exam.id, Question.source != "official").count()
    answers = (
        db.query(TestAnswer)
        .join(TestSession, TestSession.id == TestAnswer.session_id)
        .filter(TestSession.user_id == user.id)
        .all()
    )
    answered_question_ids = {a.question_id for a in answers}
    correct = sum(1 for a in answers if a.is_correct)
    wrong = sum(1 for a in answers if not a.is_correct)
    sessions = db.query(TestSession).filter(TestSession.user_id == user.id).order_by(TestSession.started_at.desc()).all()

    topic_stats = []
    for topic in db.query(Topic).filter(Topic.exam_id == exam.id).order_by(Topic.external_id).all():
        qids = [q.id for q in topic.questions if q.source != "official"]
        topic_answers = [a for a in answers if a.question_id in qids]
        topic_stats.append({
            "topic_id": topic.id,
            "external_id": topic.external_id,
            "title": topic.title,
            "questions": len(qids),
            "answered": len({a.question_id for a in topic_answers}),
            "correct": sum(1 for a in topic_answers if a.is_correct),
            "wrong": sum(1 for a in topic_answers if not a.is_correct),
        })

    difficulty_stats = []
    for diff in DIFFICULTY_ORDER:
        qids = [row[0] for row in db.query(Question.id).filter(Question.exam_id == exam.id, Question.source != "official", Question.difficulty == diff).all()]
        diff_answers = [a for a in answers if a.question_id in qids]
        difficulty_stats.append({
            "difficulty": diff,
            "questions": len(qids),
            "answered": len({a.question_id for a in diff_answers}),
            "correct": sum(1 for a in diff_answers if a.is_correct),
            "wrong": sum(1 for a in diff_answers if not a.is_correct),
        })

    unique_correct = len({a.question_id for a in answers if a.is_correct})
    coverage = unique_correct / total_questions if total_questions else 0
    accuracy = correct / (correct + wrong) if correct + wrong else 0
    readiness = round(min(100, (coverage * 0.55 + accuracy * 0.45) * 100), 1)

    return {
        "user": user.username,
        "total_questions": total_questions,
        "answered_unique": len(answered_question_ids),
        "correct_answers": correct,
        "wrong_answers": wrong,
        "accuracy": round(accuracy * 100, 1),
        "coverage": round(coverage * 100, 1),
        "readiness": readiness,
        "sessions_total": len(sessions),
        "recent_sessions": [
            {"id": s.id, "mode": s.mode, "total": s.total, "correct_count": s.correct_count, "started_at": s.started_at.isoformat(), "status": s.status}
            for s in sessions[:20]
        ],
        "topics": topic_stats,
        "difficulties": difficulty_stats,
    }


def export_progress(db: Session, user: User | None = None) -> dict[str, Any]:
    user = user or get_default_user(db)
    sessions = db.query(TestSession).filter(TestSession.user_id == user.id).order_by(TestSession.started_at).all()
    answers = (
        db.query(TestAnswer)
        .join(TestSession, TestSession.id == TestAnswer.session_id)
        .filter(TestSession.user_id == user.id)
        .order_by(TestAnswer.answered_at)
        .all()
    )
    return {
        "format": "exam-prep-progress-v1",
        "exported_at": datetime.utcnow().isoformat(),
        "user": {"username": user.username},
        "stats": build_stats(db, user),
        "sessions": [
            {
                "id": s.id,
                "mode": s.mode,
                "readiness_level": s.readiness_level,
                "topic_id": s.topic_id,
                "topic_external_id": db.get(Topic, s.topic_id).external_id if s.topic_id else None,
                "difficulty": s.difficulty,
                "status": s.status,
                "total": s.total,
                "correct_count": s.correct_count,
                "started_at": s.started_at.isoformat(),
                "finished_at": s.finished_at.isoformat() if s.finished_at else None,
                "question_external_ids": [item.question.external_id for item in s.items],
            }
            for s in sessions
        ],
        "answers": [
            {
                "session_id": a.session_id,
                "question_external_id": a.question.external_id,
                "selected_index": a.selected_index,
                "input_answer": a.input_answer,
                "is_correct": a.is_correct,
                "answered_at": a.answered_at.isoformat(),
            }
            for a in answers
        ],
        "errors": [
            {"question_external_id": a.question.external_id, "prompt": a.question.prompt, "topic": a.question.topic.title, "answered_at": a.answered_at.isoformat()}
            for a in answers
            if not a.is_correct
        ],
    }




def reset_progress(db: Session, user: User | None = None) -> dict[str, Any]:
    user = user or get_default_user(db)
    sessions = db.query(TestSession).filter(TestSession.user_id == user.id).all()
    session_ids = [s.id for s in sessions]
    answers_deleted = 0
    session_questions_deleted = 0
    sessions_deleted = 0
    if session_ids:
        answers_deleted = db.query(TestAnswer).filter(TestAnswer.session_id.in_(session_ids)).delete(synchronize_session=False)
        session_questions_deleted = db.query(SessionQuestion).filter(SessionQuestion.session_id.in_(session_ids)).delete(synchronize_session=False)
        sessions_deleted = db.query(TestSession).filter(TestSession.id.in_(session_ids)).delete(synchronize_session=False)
    db.commit()
    return {
        "status": "reset",
        "answers_deleted": answers_deleted,
        "session_questions_deleted": session_questions_deleted,
        "sessions_deleted": sessions_deleted,
    }


def import_progress(db: Session, payload: dict[str, Any], user: User | None = None) -> dict[str, Any]:
    if payload.get("format") != "exam-prep-progress-v1":
        raise ValueError("Unsupported progress format")
    user = user or get_default_user(db)
    exam = get_default_exam(db)
    question_by_ext = {q.external_id: q for q in db.query(Question).filter(Question.exam_id == exam.id).all()}
    topic_by_ext = {t.external_id: t for t in db.query(Topic).filter(Topic.exam_id == exam.id).all()}
    # Import is treated as a full restore for the current user, not as a merge.
    # This avoids duplicated active sessions and unique constraint conflicts when
    # the same progress file is imported more than once or over existing progress.
    existing_session_ids = list(db.scalars(select(TestSession.id).where(TestSession.user_id == user.id)).all())
    if existing_session_ids:
        db.query(TestAnswer).filter(TestAnswer.session_id.in_(existing_session_ids)).delete(synchronize_session=False)
        db.query(SessionQuestion).filter(SessionQuestion.session_id.in_(existing_session_ids)).delete(synchronize_session=False)
        db.query(TestSession).filter(TestSession.id.in_(existing_session_ids)).delete(synchronize_session=False)
        db.flush()

    restored_sessions = 0
    restored_answers = 0
    session_map: dict[int, int] = {}
    session_question_seen: set[tuple[int, int]] = set()
    for s in payload.get("sessions", []):
        topic = topic_by_ext.get(s.get("topic_external_id")) if s.get("topic_external_id") is not None else None
        session = TestSession(
            user_id=user.id,
            exam_id=exam.id,
            mode=s.get("mode", "imported"),
            readiness_level=s.get("readiness_level"),
            topic_id=topic.id if topic else None,
            difficulty=s.get("difficulty"),
            status=s.get("status", "finished"),
            total=s.get("total", 0),
            correct_count=s.get("correct_count", 0),
            started_at=datetime.fromisoformat(s["started_at"]) if s.get("started_at") else datetime.utcnow(),
            finished_at=datetime.fromisoformat(s["finished_at"]) if s.get("finished_at") else None,
        )
        db.add(session)
        db.flush()
        if s.get("id") is not None:
            session_map[int(s["id"])] = session.id
        seen_questions: set[int] = set()
        next_position = 0
        for ext in s.get("question_external_ids", []):
            q = question_by_ext.get(ext)
            if q and q.id not in seen_questions:
                db.add(SessionQuestion(session_id=session.id, question_id=q.id, position=next_position))
                seen_questions.add(q.id)
                session_question_seen.add((session.id, q.id))
                next_position += 1
        restored_sessions += 1
    fallback_session: TestSession | None = None
    answer_seen: set[tuple[int, int]] = set()
    for idx, a in enumerate(payload.get("answers", [])):
        q = question_by_ext.get(a.get("question_external_id"))
        if not q:
            continue
        old_session_id = a.get("session_id")
        target_session_id = session_map.get(int(old_session_id)) if old_session_id is not None else None
        if target_session_id is None:
            if fallback_session is None:
                fallback_session = TestSession(user_id=user.id, exam_id=exam.id, mode="imported_answers", status="finished", total=len(payload.get("answers", [])))
                db.add(fallback_session)
                db.flush()
                restored_sessions += 1
            target_session_id = fallback_session.id
        sq_key = (target_session_id, q.id)
        if sq_key not in session_question_seen:
            db.add(SessionQuestion(session_id=target_session_id, question_id=q.id, position=idx))
            session_question_seen.add(sq_key)
        if sq_key in answer_seen:
            continue
        db.add(TestAnswer(
            session_id=target_session_id,
            question_id=q.id,
            selected_index=a.get("selected_index"),
            input_answer=a.get("input_answer"),
            is_correct=bool(a.get("is_correct")),
            answered_at=datetime.fromisoformat(a["answered_at"]) if a.get("answered_at") else datetime.utcnow(),
        ))
        answer_seen.add(sq_key)
        restored_answers += 1
    db.commit()
    return {"restored_sessions": restored_sessions, "restored_answers": restored_answers}
