from __future__ import annotations

import pandas as pd


def latest_two_exports(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    if df.empty or "source_file" not in df.columns:
        return df, pd.DataFrame()
    # source_file is more stable than export_at if filename parsing fails.
    files = list(df["source_file"].dropna().astype(str).unique())
    if len(files) < 2:
        return df[df["source_file"].eq(files[-1])] if files else df, pd.DataFrame()
    # Prefer export_at ordering when available.
    order = (
        df[["source_file", "export_at"]]
        .drop_duplicates()
        .assign(export_at_parsed=lambda x: pd.to_datetime(x["export_at"], errors="coerce"))
        .sort_values(["export_at_parsed", "source_file"])
    )
    files = order["source_file"].tolist()
    latest = df[df["source_file"].eq(files[-1])]
    prev = df[df["source_file"].eq(files[-2])]
    return latest, prev


def compare_exports(latest: pd.DataFrame, previous: pd.DataFrame) -> dict:
    if latest.empty or previous.empty:
        return {
            "new_tasks": pd.DataFrame(),
            "removed_tasks": pd.DataFrame(),
            "changed_deadline": pd.DataFrame(),
            "changed_responsible": pd.DataFrame(),
            "new_overdue": pd.DataFrame(),
        }

    l = latest.copy()
    p = previous.copy()
    l["task_id_str"] = l["task_id"].astype(str)
    p["task_id_str"] = p["task_id"].astype(str)
    latest_ids = set(l["task_id_str"])
    prev_ids = set(p["task_id_str"])

    new = l[l["task_id_str"].isin(latest_ids - prev_ids)]
    removed = p[p["task_id_str"].isin(prev_ids - latest_ids)]

    joined = l.merge(
        p[["task_id_str", "deadline", "responsible", "is_overdue"]],
        on="task_id_str",
        how="inner",
        suffixes=("", "_prev"),
    )
    changed_deadline = joined[
        pd.to_datetime(joined["deadline"], errors="coerce").astype(str)
        != pd.to_datetime(joined["deadline_prev"], errors="coerce").astype(str)
    ]
    changed_responsible = joined[joined["responsible"].astype(str) != joined["responsible_prev"].astype(str)]
    new_overdue = joined[(joined["is_overdue"] == True) & (joined["is_overdue_prev"] != True)]

    return {
        "new_tasks": new,
        "removed_tasks": removed,
        "changed_deadline": changed_deadline,
        "changed_responsible": changed_responsible,
        "new_overdue": new_overdue,
    }
