from __future__ import annotations

import numpy as np
import pandas as pd


def compute_task_risk(df: pd.DataFrame, rules: dict) -> pd.DataFrame:
    df = df.copy()
    r = rules.get("risk_score", {})

    score = pd.Series(0, index=df.index, dtype="float")
    score += df.get("is_overdue", False).astype(int) * r.get("overdue_base", 50)
    score += df.get("overdue_days", 0).clip(upper=r.get("max_overdue_day_points", 30)).fillna(0) * r.get("per_overdue_day", 1)
    score += df.get("is_due_today", False).astype(int) * r.get("due_today", 35)
    score += df.get("is_due_soon", False).astype(int) * r.get("due_soon", 25)
    score += df.get("is_waiting_control", False).astype(int) * r.get("waiting_control", 20)
    score += df.get("is_no_deadline", False).astype(int) * r.get("no_deadline", 15)
    score += df.get("is_stale_7", False).astype(int) * r.get("stale_warning", 10)
    score += df.get("is_stale_14", False).astype(int) * r.get("stale_critical", 20)
    postponed_overdue = df.get("is_postponed", False) & df.get("is_overdue", False)
    score += postponed_overdue.astype(int) * r.get("postponed_overdue", 15)
    score += (~df.get("has_parent_task", True)).astype(int) * r.get("no_parent", 10)
    score += (~df.get("has_project", True)).astype(int) * r.get("no_project", 10)

    df["risk_score"] = score.clip(lower=0, upper=100).round(0).astype(int)
    df["risk_level"] = df["risk_score"].apply(lambda x: risk_level(x, rules))
    df["risk_color"] = df["risk_level"].map({
        "Красный": "🔴",
        "Оранжевый": "🟠",
        "Желтый": "🟡",
        "Серый": "⚪",
        "Зеленый": "🟢",
    }).fillna("⚪")
    df["recommended_action"] = df.apply(recommended_action, axis=1)
    df["system_comment"] = df.apply(system_comment, axis=1)
    return df


def risk_level(score: int | float, rules: dict) -> str:
    c = rules.get("risk_categories", {})
    if score >= c.get("red", 80):
        return "Красный"
    if score >= c.get("orange", 50):
        return "Оранжевый"
    if score >= c.get("yellow", 25):
        return "Желтый"
    if score >= c.get("gray", 1):
        return "Серый"
    return "Зеленый"


def recommended_action(row: pd.Series) -> str:
    if bool(row.get("is_postponed", False)) and bool(row.get("is_overdue", False)):
        return "Принять решение: закрыть, снять, возобновить или перепланировать"
    if bool(row.get("is_overdue", False)):
        return "Запросить результат, блокер или новый срок"
    if bool(row.get("is_waiting_control", False)):
        return "Проверить результат и закрыть или вернуть на доработку"
    if bool(row.get("is_due_today", False)):
        return "Проверить готовность сегодня"
    if bool(row.get("is_due_soon", False)):
        return "Профилактически уточнить статус до наступления срока"
    if bool(row.get("is_no_deadline", False)):
        return "Назначить крайний срок"
    if bool(row.get("is_stale_14", False)):
        return "Запросить актуальный статус"
    if not bool(row.get("has_parent_task", True)):
        return "Привязать к проекту / родительской задаче"
    return "Наблюдать"


def system_comment(row: pd.Series) -> str:
    notes: list[str] = []
    if bool(row.get("is_overdue", False)):
        notes.append(f"просрочка {int(row.get('overdue_days') or 0)} дн.")
    if bool(row.get("is_no_deadline", False)):
        notes.append("нет крайнего срока")
    if bool(row.get("is_stale_14", False)):
        notes.append("нет активности больше 14 дней")
    elif bool(row.get("is_stale_7", False)):
        notes.append("нет активности больше 7 дней")
    if not bool(row.get("has_parent_task", True)):
        notes.append("нет родительской задачи")
    if bool(row.get("is_waiting_control", False)):
        notes.append("ждёт контроля")
    return "; ".join(notes)
