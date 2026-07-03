from __future__ import annotations

from pathlib import Path
import os
import pandas as pd
import streamlit as st

from src.load_bitrix_export import latest_export, read_bitrix_export, read_all_exports
from src.normalize_tasks import normalize_tasks
from src.risk_rules import compute_task_risk
from src.workload import calculate_people_load
from src.metrics import kpi_summary, push_list, project_risk, hygiene_issues
from src.history import latest_two_exports, compare_exports
from src.charts import (
    bar_people_workload,
    bar_people_availability,
    bar_project_risk,
    status_distribution,
    risk_distribution,
)
from src.utils import load_yaml, project_root

ROOT = project_root()
RAW_DIR = ROOT / "data" / "raw"
RULES = load_yaml(ROOT / "config" / "dashboard_rules.yaml")

st.set_page_config(
    page_title="Контроль задач ИТО",
    page_icon="📊",
    layout="wide",
)


def prepare_tasks(raw: pd.DataFrame) -> pd.DataFrame:
    tasks = normalize_tasks(raw)
    tasks = compute_task_risk(tasks, RULES)
    base_url = ""
    try:
        base_url = st.secrets.get("BITRIX_TASK_BASE_URL", "")
    except Exception:
        base_url = os.environ.get("BITRIX_TASK_BASE_URL", "")
    if base_url:
        base = base_url.rstrip("/")
        tasks["task_url"] = tasks["task_id"].apply(lambda x: f"{base}/{int(x)}/" if pd.notna(x) else "")
    return tasks


@st.cache_data(show_spinner=False)
def load_latest_from_disk() -> tuple[pd.DataFrame, str]:
    latest = latest_export(RAW_DIR)
    if latest is None:
        return pd.DataFrame(), ""
    raw = read_bitrix_export(latest, filename=latest.name)
    return prepare_tasks(raw), latest.name


@st.cache_data(show_spinner=False)
def load_history_from_disk() -> pd.DataFrame:
    raw_all = read_all_exports(RAW_DIR)
    if raw_all.empty:
        return pd.DataFrame()
    frames = []
    for source_file, part in raw_all.groupby("source_file", dropna=False):
        frames.append(prepare_tasks(part))
    return pd.concat(frames, ignore_index=True, sort=False) if frames else pd.DataFrame()


def ru_date(x):
    if pd.isna(x) or x == "":
        return ""
    try:
        return pd.to_datetime(x).strftime("%d.%m.%Y %H:%M")
    except Exception:
        return str(x)


def display_table(df: pd.DataFrame, height: int = 520):
    shown = df.copy()
    for col in ["deadline", "last_activity_at", "created_at", "changed_at"]:
        if col in shown.columns:
            shown[col] = shown[col].apply(ru_date)
    st.dataframe(shown, use_container_width=True, height=height)


def apply_sidebar_filters(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    with st.sidebar:
        st.header("Фильтры")
        responsible = st.multiselect("Ответственный", sorted(df["responsible"].dropna().unique()))
        project = st.multiselect("Проект / родительская задача", sorted(df["project_name"].dropna().unique()))
        status = st.multiselect("Статус", sorted(df["status"].dropna().unique()))
        risk = st.multiselect("Риск", ["Красный", "Оранжевый", "Желтый", "Серый", "Зеленый"], default=[])
        only_today_actions = st.checkbox("Только требующие действия", value=False)
        only_my_tasks = st.checkbox(f"Только задачи постановщика {RULES.get('app', {}).get('coordinator_name', 'Максим Буржинский')}", value=False)

    out = df.copy()
    if responsible:
        out = out[out["responsible"].isin(responsible)]
    if project:
        out = out[out["project_name"].isin(project)]
    if status:
        out = out[out["status"].isin(status)]
    if risk:
        out = out[out["risk_level"].isin(risk)]
    if only_today_actions:
        out = out[(out["risk_score"] >= 25) | out["is_waiting_control"] | out["is_no_deadline"]]
    if only_my_tasks:
        coordinator = RULES.get("app", {}).get("coordinator_name", "Максим Буржинский")
        out = out[out["originator"].eq(coordinator)]
    return out


def render_kpis(df: pd.DataFrame):
    kpis = kpi_summary(df)
    keys = list(kpis.keys())
    for i in range(0, len(keys), 5):
        cols = st.columns(min(5, len(keys) - i))
        for col, key in zip(cols, keys[i:i + 5]):
            col.metric(key, kpis[key])


def page_control_today(df: pd.DataFrame):
    st.subheader("Контроль сегодня")
    render_kpis(df)
    st.divider()
    st.markdown("### Пуш-лист")
    pl = push_list(df)
    display_table(pl, height=560)
    st.download_button(
        "Скачать пуш-лист CSV",
        data=pl.to_csv(index=False, encoding="utf-8-sig"),
        file_name="latest_push_list.csv",
        mime="text/csv",
    )


def page_people(df: pd.DataFrame):
    st.subheader("Загрузка людей и доступность")
    people = calculate_people_load(df, RULES)
    if people.empty:
        st.info("Нет данных по сотрудникам.")
        return
    c1, c2 = st.columns(2)
    with c1:
        fig = bar_people_workload(people)
        if fig:
            st.plotly_chart(fig, use_container_width=True)
    with c2:
        fig = bar_people_availability(people)
        if fig:
            st.plotly_chart(fig, use_container_width=True)
    st.markdown("### Таблица доступности")
    display_table(people, height=620)
    st.download_button(
        "Скачать загрузку людей CSV",
        data=people.to_csv(index=False, encoding="utf-8-sig"),
        file_name="latest_people_load.csv",
        mime="text/csv",
    )


def page_projects(df: pd.DataFrame):
    st.subheader("Проекты / родительские задачи")
    projects = project_risk(df)
    if projects.empty:
        st.info("Нет проектных данных.")
        return
    fig = bar_project_risk(projects)
    if fig:
        st.plotly_chart(fig, use_container_width=True)
    display_table(projects, height=520)
    selected = st.selectbox("Открыть задачи проекта", [""] + projects["project_name"].tolist())
    if selected:
        display_table(push_list(df[df["project_name"].eq(selected)]), height=420)


def page_waiting_control(df: pd.DataFrame):
    st.subheader("Ждёт контроля")
    wc = df[df["is_waiting_control"]].copy().sort_values("risk_score", ascending=False)
    st.metric("Задач на контроле", wc.shape[0])
    display_table(push_list(wc), height=620)


def page_hygiene(df: pd.DataFrame):
    st.subheader("Гигиена задач")
    issues = hygiene_issues(df)
    display_table(issues, height=260)
    st.divider()
    issue = st.selectbox("Показать задачи по нарушению", issues["issue"].tolist() if not issues.empty else [])
    mask = pd.Series(False, index=df.index)
    if issue == "Нет крайнего срока":
        mask = df["is_no_deadline"]
    elif issue == "Нет родительской задачи":
        mask = ~df["has_parent_task"]
    elif issue == "Нет проекта":
        mask = ~df["has_project"]
    elif issue == "Нет активности больше 14 дней":
        mask = df["is_stale_14"]
    elif issue == "Отложена, но срок прошел":
        mask = df["is_postponed"] & df["is_overdue"]
    elif issue == "Ждёт контроля":
        mask = df["is_waiting_control"]
    if issue:
        display_table(push_list(df[mask]), height=520)


def page_dynamics(df: pd.DataFrame):
    st.subheader("Динамика между выгрузками")
    hist = load_history_from_disk()
    if hist.empty or hist["source_file"].nunique() < 2:
        st.info("Для динамики нужно минимум две выгрузки. Добавьте следующую выгрузку в data/raw/.")
        return
    latest, previous = latest_two_exports(hist)
    cmp = compare_exports(latest, previous)
    cols = st.columns(5)
    cols[0].metric("Новые задачи", cmp["new_tasks"].shape[0])
    cols[1].metric("Исчезли из выгрузки", cmp["removed_tasks"].shape[0])
    cols[2].metric("Сменился срок", cmp["changed_deadline"].shape[0])
    cols[3].metric("Сменился ответственный", cmp["changed_responsible"].shape[0])
    cols[4].metric("Новые просрочки", cmp["new_overdue"].shape[0])

    section = st.selectbox("Что показать", list(cmp.keys()))
    display_table(cmp[section], height=520)

    trend = hist.groupby("source_file", dropna=False).agg(
        active_tasks=("task_id", "count"),
        avg_risk=("risk_score", "mean"),
        overdue=("is_overdue", "sum"),
        no_deadline=("is_no_deadline", "sum"),
    ).reset_index()
    st.markdown("### Тренд по выгрузкам")
    st.line_chart(trend.set_index("source_file")[["avg_risk", "overdue", "no_deadline"]])


def page_analytics(df: pd.DataFrame):
    st.subheader("Аналитика")
    c1, c2 = st.columns(2)
    with c1:
        fig = risk_distribution(df)
        if fig:
            st.plotly_chart(fig, use_container_width=True)
    with c2:
        fig = status_distribution(df)
        if fig:
            st.plotly_chart(fig, use_container_width=True)


def main():
    st.title("📊 Контроль задач инженерно-технического отдела")
    st.caption("Битрикс24 → выгрузка задач → риск, загрузка людей, доступность и управленческий пуш-лист")

    with st.sidebar:
        st.markdown("## Источник данных")
        uploaded = st.file_uploader("Загрузить свежую выгрузку .xls", type=["xls", "xlsx", "html", "csv"])

    if uploaded is not None:
        raw = read_bitrix_export(uploaded, filename=uploaded.name)
        df = prepare_tasks(raw)
        source_name = uploaded.name
    else:
        df, source_name = load_latest_from_disk()

    if df.empty:
        st.error("Не найдены данные. Положите выгрузку Битрикс24 в data/raw/ или загрузите файл через панель слева.")
        st.stop()

    st.success(f"Загружена выгрузка: {source_name}. Активных задач: {int(df['is_active'].sum())}")
    filtered = apply_sidebar_filters(df)

    with st.sidebar:
        page = st.radio(
            "Раздел",
            [
                "Контроль сегодня",
                "Загрузка людей",
                "Проекты",
                "Ждёт контроля",
                "Гигиена задач",
                "Динамика",
                "Аналитика",
            ],
        )

    if page == "Контроль сегодня":
        page_control_today(filtered)
    elif page == "Загрузка людей":
        page_people(filtered)
    elif page == "Проекты":
        page_projects(filtered)
    elif page == "Ждёт контроля":
        page_waiting_control(filtered)
    elif page == "Гигиена задач":
        page_hygiene(filtered)
    elif page == "Динамика":
        page_dynamics(filtered)
    elif page == "Аналитика":
        page_analytics(filtered)


if __name__ == "__main__":
    main()
