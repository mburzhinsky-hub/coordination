from __future__ import annotations

import pandas as pd


def _safe_ratio(numerator: pd.Series, denominator: pd.Series) -> pd.Series:
    return (numerator / denominator.replace(0, pd.NA)).fillna(0)


def workload_category(score: float, rules: dict) -> str:
    t = rules.get("workload", {}).get("thresholds", {})
    if score <= t.get("low_max", 5):
        return "Низкая загрузка"
    if score <= t.get("normal_max", 12):
        return "Нормальная загрузка"
    if score <= t.get("high_max", 20):
        return "Высокая загрузка"
    return "Перегруз"


def reliability_category(score: float) -> str:
    if score >= 80:
        return "Высокая надежность"
    if score >= 60:
        return "Нормальная надежность"
    if score >= 40:
        return "Нестабильно"
    return "Высокий операционный риск"


def availability_category(score: float) -> str:
    if score >= 75:
        return "Можно рассчитывать"
    if score >= 55:
        return "Можно рассчитывать ограниченно"
    if score >= 35:
        return "Лучше не нагружать без уточнения"
    return "Не нагружать, сначала разобрать текущие задачи"


def availability_recommendation(row: pd.Series) -> str:
    if row["overdue_tasks"] >= 3 or row["reliability_score"] < 40:
        return "Не нагружать, сначала разобрать критические просрочки"
    if row["no_deadline_tasks"] >= 5:
        return "Сначала разобрать задачи без сроков"
    if row["stale_14_tasks"] >= 5:
        return "Сначала запросить актуальные статусы по зависшим задачам"
    if row["workload_category"] == "Перегруз":
        return "Не давать новые задачи без снятия части текущих"
    if row["availability_score"] >= 75 and row["workload_category"] in ["Низкая загрузка", "Нормальная загрузка"]:
        return "Можно дать новую задачу"
    if row["availability_score"] >= 55:
        return "Можно дать короткую или срочную задачу после уточнения"
    return "Лучше не нагружать без ручной проверки"


def calculate_people_load(df: pd.DataFrame, rules: dict) -> pd.DataFrame:
    active = df[df.get("is_active", True)].copy()
    if active.empty:
        return pd.DataFrame()

    g = active.groupby("responsible", dropna=False)
    people = g.agg(
        active_tasks=("task_id", "count"),
        in_progress_tasks=("is_in_progress", "sum"),
        waiting_tasks=("is_waiting", "sum"),
        waiting_control_tasks=("is_waiting_control", "sum"),
        overdue_tasks=("is_overdue", "sum"),
        due_today_tasks=("is_due_today", "sum"),
        due_soon_tasks=("is_due_soon", "sum"),
        no_deadline_tasks=("is_no_deadline", "sum"),
        stale_7_tasks=("is_stale_7", "sum"),
        stale_14_tasks=("is_stale_14", "sum"),
        project_tasks=("has_project", "sum"),
        parented_tasks=("has_parent_task", "sum"),
        avg_overdue_days=("overdue_days", "mean"),
        max_overdue_days=("overdue_days", "max"),
        avg_risk_score=("risk_score", "mean"),
        max_risk_score=("risk_score", "max"),
    ).reset_index()

    people["non_project_tasks"] = people["active_tasks"] - people["project_tasks"]
    risk_counts = active.assign(_risk_task=active["risk_score"] >= 50).groupby("responsible", dropna=False)["_risk_task"].sum().reset_index(name="risk_tasks")
    people = people.merge(risk_counts, on="responsible", how="left")
    people["risk_tasks"] = people["risk_tasks"].fillna(0).astype(int)
    people["risk_tasks_ratio"] = people["risk_tasks"] / people["active_tasks"].replace(0, pd.NA)
    people["risk_tasks_ratio"] = people["risk_tasks_ratio"].fillna(0)

    w = rules.get("workload", {})
    people["workload_score"] = (
        people["active_tasks"] * w.get("active_task_weight", 1.0)
        + people["overdue_tasks"] * w.get("overdue_task_weight", 2.5)
        + people["due_today_tasks"] * w.get("due_today_weight", 2.0)
        + people["due_soon_tasks"] * w.get("due_soon_weight", 1.5)
        + people["in_progress_tasks"] * w.get("in_progress_weight", 1.2)
        + people["waiting_control_tasks"] * w.get("waiting_control_weight", 0.8)
        + people["no_deadline_tasks"] * w.get("no_deadline_weight", 0.7)
    ).round(1)
    people["workload_category"] = people["workload_score"].apply(lambda x: workload_category(x, rules))

    total = people["active_tasks"].replace(0, pd.NA)
    overdue_ratio = (people["overdue_tasks"] / total).fillna(0)
    stale_ratio = (people["stale_14_tasks"] / total).fillna(0)
    no_deadline_ratio = (people["no_deadline_tasks"] / total).fillna(0)
    waiting_control_old_ratio = (people["waiting_control_tasks"] / total).fillna(0)
    rel = rules.get("reliability", {})
    avg_overdue_penalty = people["avg_overdue_days"].fillna(0).clip(upper=rel.get("avg_overdue_days_penalty_limit", 10))
    people["reliability_score"] = (
        100
        - overdue_ratio * rel.get("overdue_ratio_penalty", 35)
        - stale_ratio * rel.get("stale_ratio_penalty", 25)
        - no_deadline_ratio * rel.get("no_deadline_ratio_penalty", 20)
        - waiting_control_old_ratio * rel.get("waiting_control_old_ratio_penalty", 10)
        - avg_overdue_penalty
    ).clip(lower=0, upper=100).round(0).astype(int)
    people["reliability_category"] = people["reliability_score"].apply(reliability_category)

    availability = rules.get("availability", {})
    workload_penalty_map = {
        "Низкая загрузка": availability.get("workload_penalty_low", 0),
        "Нормальная загрузка": availability.get("workload_penalty_normal", 8),
        "Высокая загрузка": availability.get("workload_penalty_high", 18),
        "Перегруз": availability.get("workload_penalty_overload", 30),
    }
    recent_activity_bonus = ((people["stale_7_tasks"] == 0) & (people["active_tasks"] > 0)).astype(int) * availability.get("recent_activity_bonus", 5)
    people["availability_score"] = (
        people["reliability_score"]
        - people["workload_category"].map(workload_penalty_map).fillna(0)
        - (people["due_today_tasks"] + people["due_soon_tasks"]) * availability.get("urgent_tasks_penalty_per_task", 2)
        - people["overdue_tasks"] * availability.get("overdue_penalty_per_task", 3)
        + recent_activity_bonus
    ).clip(lower=0, upper=100).round(0).astype(int)
    people["availability_category"] = people["availability_score"].apply(availability_category)
    people["recommendation"] = people.apply(availability_recommendation, axis=1)

    ordered = [
        "responsible", "active_tasks", "workload_score", "workload_category",
        "reliability_score", "reliability_category", "availability_score", "availability_category",
        "recommendation", "overdue_tasks", "due_today_tasks", "due_soon_tasks",
        "in_progress_tasks", "waiting_tasks", "waiting_control_tasks", "no_deadline_tasks",
        "stale_7_tasks", "stale_14_tasks", "project_tasks", "non_project_tasks",
        "risk_tasks", "risk_tasks_ratio", "avg_overdue_days", "max_overdue_days",
        "avg_risk_score", "max_risk_score",
    ]
    return people[ordered].sort_values(["availability_score", "workload_score"], ascending=[False, True])
