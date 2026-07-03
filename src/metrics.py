from __future__ import annotations

import pandas as pd


def kpi_summary(df: pd.DataFrame) -> dict:
    active = df[df.get("is_active", True)]
    return {
        "Всего активных задач": int(active.shape[0]),
        "Просрочено": int(active.get("is_overdue", pd.Series(dtype=bool)).sum()),
        "Срок сегодня": int(active.get("is_due_today", pd.Series(dtype=bool)).sum()),
        "Срок в ближайшие 3 дня": int(active.get("is_due_soon", pd.Series(dtype=bool)).sum()),
        "Ждёт контроля": int(active.get("is_waiting_control", pd.Series(dtype=bool)).sum()),
        "Без крайнего срока": int(active.get("is_no_deadline", pd.Series(dtype=bool)).sum()),
        "Нет активности > 7 дней": int(active.get("is_stale_7", pd.Series(dtype=bool)).sum()),
        "Нет активности > 14 дней": int(active.get("is_stale_14", pd.Series(dtype=bool)).sum()),
        "Без родительской задачи": int((~active.get("has_parent_task", pd.Series(True, index=active.index))).sum()),
        "Индекс риска отдела": int(round(active.get("risk_score", pd.Series([0])).mean() if not active.empty else 0)),
    }


def push_list(df: pd.DataFrame) -> pd.DataFrame:
    active = df[df.get("is_active", True)].copy()
    cols = [
        "risk_color", "risk_level", "risk_score", "recommended_action", "responsible",
        "project_name", "task_title", "status", "deadline", "days_to_deadline",
        "overdue_days", "last_activity_at", "originator", "task_id", "task_url", "system_comment",
    ]
    existing = [c for c in cols if c in active.columns]
    return active.sort_values(["risk_score", "overdue_days"], ascending=[False, False])[existing]


def project_risk(df: pd.DataFrame) -> pd.DataFrame:
    active = df[df.get("is_active", True)].copy()
    if active.empty:
        return pd.DataFrame()
    g = active.groupby("project_name", dropna=False)
    out = g.agg(
        active_tasks=("task_id", "count"),
        overdue_tasks=("is_overdue", "sum"),
        due_today_tasks=("is_due_today", "sum"),
        due_soon_tasks=("is_due_soon", "sum"),
        waiting_control_tasks=("is_waiting_control", "sum"),
        no_deadline_tasks=("is_no_deadline", "sum"),
        stale_14_tasks=("is_stale_14", "sum"),
        responsible_count=("responsible", "nunique"),
        avg_risk_score=("risk_score", "mean"),
        max_risk_score=("risk_score", "max"),
    ).reset_index()

    main_responsible = active.groupby(["project_name", "responsible"]).size().reset_index(name="cnt")
    idx = main_responsible.groupby("project_name")["cnt"].idxmax()
    main_responsible = main_responsible.loc[idx, ["project_name", "responsible"]].rename(columns={"responsible": "main_responsible"})
    out = out.merge(main_responsible, on="project_name", how="left")
    out["project_risk_score"] = (
        out["avg_risk_score"] * 0.5 + out["max_risk_score"] * 0.5
    ).round(0).astype(int)
    out["project_status"] = out["project_risk_score"].apply(project_status)
    return out.sort_values("project_risk_score", ascending=False)


def project_status(score: int | float) -> str:
    if score >= 80:
        return "🔴 Красный"
    if score >= 50:
        return "🟠 Оранжевый"
    if score >= 25:
        return "🟡 Желтый"
    return "🟢 Зеленый"


def hygiene_issues(df: pd.DataFrame) -> pd.DataFrame:
    active = df[df.get("is_active", True)].copy()
    records = []
    checks = [
        ("Нет крайнего срока", "is_no_deadline"),
        ("Нет родительской задачи", "has_parent_task", True),
        ("Нет проекта", "has_project", True),
        ("Нет активности больше 14 дней", "is_stale_14"),
        ("Отложена, но срок прошел", None),
        ("Ждёт контроля", "is_waiting_control"),
    ]
    for title, col, invert in [(x[0], x[1], x[2] if len(x) > 2 else False) for x in checks]:
        if title == "Отложена, но срок прошел":
            mask = active.get("is_postponed", False) & active.get("is_overdue", False)
        elif invert:
            mask = ~active.get(col, True)
        else:
            mask = active.get(col, False)
        subset = active[mask]
        records.append({
            "issue": title,
            "count": int(subset.shape[0]),
            "responsibles": ", ".join(subset["responsible"].dropna().astype(str).unique()[:10]),
            "top_action": subset["recommended_action"].mode().iloc[0] if not subset.empty and "recommended_action" in subset else "",
        })
    return pd.DataFrame(records).sort_values("count", ascending=False)
