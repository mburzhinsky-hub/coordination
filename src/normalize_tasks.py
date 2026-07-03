from __future__ import annotations

from datetime import date
import pandas as pd

from .utils import clean_text

DATE_COLUMNS = [
    "Последняя активность",
    "Крайний срок",
    "Дата создания",
    "Дата начала работы",
    "Дата изменения",
    "Дата закрытия",
    "Планируемая дата начала",
    "Планируемая дата окончания",
]

CLOSED_STATUSES = {"завершена", "завершено", "закрыта", "закрыто", "completed"}
WAITING_CONTROL_STATUSES = {"ждёт контроля", "ждет контроля", "waiting for control"}
IN_PROGRESS_STATUSES = {"выполняется", "в работе", "in progress"}
WAITING_STATUSES = {"ждёт выполнения", "ждет выполнения", "новая", "new", "pending"}
POSTPONED_STATUSES = {"отложена", "отложено", "deferred"}


def _ensure_column(df: pd.DataFrame, name: str, default="") -> None:
    if name not in df.columns:
        df[name] = default


def _parse_datetime(series: pd.Series) -> pd.Series:
    # Bitrix exports Russian dates as DD.MM.YYYY HH:MM:SS.
    return pd.to_datetime(series, dayfirst=True, errors="coerce")


def _status_norm(s: object) -> str:
    return clean_text(s).lower().replace("ё", "е")


def normalize_tasks(raw: pd.DataFrame, current_dt: pd.Timestamp | None = None) -> pd.DataFrame:
    df = raw.copy()

    for col in [
        "ID", "Название", "Описание", "Последняя активность", "Крайний срок",
        "Постановщик", "Исполнитель", "Соисполнители", "Наблюдатели", "Статус",
        "Проект", "Дата создания", "Дата изменения", "Дата закрытия",
        "ID базовой задачи", "Название базовой задачи", "Оценка", "Затрачено",
        "Планируемая длительность",
    ]:
        _ensure_column(df, col)

    for col in DATE_COLUMNS:
        if col in df.columns:
            df[col] = _parse_datetime(df[col])

    if current_dt is None:
        # Prefer export date, otherwise today's date.
        if "export_at" in df.columns and df["export_at"].notna().any():
            current_dt = pd.to_datetime(df["export_at"].dropna().max())
        else:
            current_dt = pd.Timestamp.now().normalize()
    current_dt = pd.to_datetime(current_dt)
    current_day = current_dt.normalize()

    df["task_id"] = pd.to_numeric(df["ID"], errors="coerce").astype("Int64")
    df["task_title"] = df["Название"].map(clean_text)
    df["task_description"] = df["Описание"].map(clean_text)
    df["responsible"] = df["Исполнитель"].map(clean_text).replace("", "Не назначен")
    df["creator"] = df["Создатель"].map(clean_text) if "Создатель" in df.columns else ""
    df["originator"] = df["Постановщик"].map(clean_text).replace("", "Не указан")
    df["status"] = df["Статус"].map(clean_text).replace("", "Без статуса")
    df["status_norm"] = df["status"].map(_status_norm)

    parent_name = df["Название базовой задачи"].map(clean_text)
    project_name = df["Проект"].map(clean_text)
    df["project_name"] = parent_name.where(parent_name.ne(""), project_name)
    df["project_name"] = df["project_name"].replace("", "Без проекта / без родительской задачи")

    parent_id = pd.to_numeric(df["ID базовой задачи"], errors="coerce")
    df["parent_task_id"] = parent_id.astype("Int64")
    df["has_parent_task"] = df["parent_task_id"].notna() | parent_name.ne("")
    df["has_project"] = df["project_name"].ne("Без проекта / без родительской задачи")

    df["deadline"] = df["Крайний срок"]
    df["created_at"] = df["Дата создания"]
    df["changed_at"] = df["Дата изменения"]
    df["closed_at"] = df["Дата закрытия"]
    df["last_activity_at"] = df["Последняя активность"].combine_first(df["Дата изменения"])

    df["is_closed"] = df["status_norm"].isin(CLOSED_STATUSES) | df["closed_at"].notna()
    df["is_active"] = ~df["is_closed"]
    df["is_waiting_control"] = df["status_norm"].isin(WAITING_CONTROL_STATUSES)
    df["is_in_progress"] = df["status_norm"].isin(IN_PROGRESS_STATUSES)
    df["is_waiting"] = df["status_norm"].isin(WAITING_STATUSES)
    df["is_postponed"] = df["status_norm"].isin(POSTPONED_STATUSES)

    df["has_deadline"] = df["deadline"].notna()
    df["deadline_date"] = df["deadline"].dt.normalize()
    df["days_to_deadline"] = (df["deadline_date"] - current_day).dt.days
    df["is_overdue"] = df["is_active"] & df["has_deadline"] & (df["deadline"] < current_dt)
    df["overdue_days"] = (current_day - df["deadline_date"]).dt.days.where(df["is_overdue"], 0).clip(lower=0)
    df["is_due_today"] = df["is_active"] & df["has_deadline"] & df["days_to_deadline"].eq(0)
    df["is_due_soon"] = df["is_active"] & df["has_deadline"] & df["days_to_deadline"].between(1, 3)
    df["is_no_deadline"] = df["is_active"] & ~df["has_deadline"]

    last_activity_day = df["last_activity_at"].dt.normalize()
    df["days_since_activity"] = (current_day - last_activity_day).dt.days
    df["is_stale_7"] = df["is_active"] & df["days_since_activity"].ge(7).fillna(False)
    df["is_stale_14"] = df["is_active"] & df["days_since_activity"].ge(14).fillna(False)

    # Optional URL: set BITRIX_TASK_BASE_URL in Streamlit secrets or environment later.
    df["task_url"] = ""

    df["export_date"] = current_day.date().isoformat()
    return df
