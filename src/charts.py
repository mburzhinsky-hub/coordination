from __future__ import annotations

import pandas as pd
import plotly.express as px


def bar_people_workload(people: pd.DataFrame):
    if people.empty:
        return None
    return px.bar(
        people.sort_values("workload_score", ascending=True),
        x="workload_score",
        y="responsible",
        orientation="h",
        title="Индекс загрузки сотрудников",
        labels={"workload_score": "Индекс загрузки", "responsible": "Сотрудник"},
        text="workload_score",
    )


def bar_people_availability(people: pd.DataFrame):
    if people.empty:
        return None
    return px.bar(
        people.sort_values("availability_score", ascending=True),
        x="availability_score",
        y="responsible",
        orientation="h",
        title="На кого можно рассчитывать: индекс доступности",
        labels={"availability_score": "Индекс доступности", "responsible": "Сотрудник"},
        text="availability_score",
    )


def bar_project_risk(projects: pd.DataFrame):
    if projects.empty:
        return None
    return px.bar(
        projects.head(20).sort_values("project_risk_score", ascending=True),
        x="project_risk_score",
        y="project_name",
        orientation="h",
        title="Риск по проектам / родительским задачам",
        labels={"project_risk_score": "Индекс риска", "project_name": "Проект"},
        text="project_risk_score",
    )


def status_distribution(df: pd.DataFrame):
    if df.empty:
        return None
    data = df.groupby("status", dropna=False).size().reset_index(name="tasks")
    return px.pie(data, names="status", values="tasks", title="Распределение задач по статусам")


def risk_distribution(df: pd.DataFrame):
    if df.empty:
        return None
    data = df.groupby("risk_level", dropna=False).size().reset_index(name="tasks")
    order = ["Красный", "Оранжевый", "Желтый", "Серый", "Зеленый"]
    data["risk_level"] = pd.Categorical(data["risk_level"], categories=order, ordered=True)
    data = data.sort_values("risk_level")
    return px.bar(data, x="risk_level", y="tasks", title="Распределение задач по риску", text="tasks")
