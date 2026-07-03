from __future__ import annotations

from pathlib import Path
import pandas as pd

from src.load_bitrix_export import latest_export, read_bitrix_export, read_all_exports
from src.normalize_tasks import normalize_tasks
from src.risk_rules import compute_task_risk
from src.workload import calculate_people_load
from src.metrics import push_list, project_risk, hygiene_issues
from src.utils import load_yaml, save_dataframe, project_root


def main() -> None:
    root = project_root()
    raw_dir = root / "data" / "raw"
    processed_dir = root / "data" / "processed"
    reports_dir = root / "reports"
    rules = load_yaml(root / "config" / "dashboard_rules.yaml")

    latest = latest_export(raw_dir)
    if not latest:
        raise SystemExit("В data/raw нет выгрузок Bitrix. Добавьте .xls файл.")

    raw_latest = read_bitrix_export(latest, filename=latest.name)
    tasks_latest = compute_task_risk(normalize_tasks(raw_latest), rules)
    latest_path = save_dataframe(tasks_latest, processed_dir / "tasks_latest")

    raw_all = read_all_exports(raw_dir)
    if not raw_all.empty:
        frames = []
        for source_file, part in raw_all.groupby("source_file", dropna=False):
            frames.append(compute_task_risk(normalize_tasks(part), rules))
        history = pd.concat(frames, ignore_index=True, sort=False)
        history_path = save_dataframe(history, processed_dir / "tasks_history")
    else:
        history_path = None

    reports_dir.mkdir(parents=True, exist_ok=True)
    push_list(tasks_latest).to_csv(reports_dir / "latest_push_list.csv", index=False, encoding="utf-8-sig")
    calculate_people_load(tasks_latest, rules).to_csv(reports_dir / "latest_people_load.csv", index=False, encoding="utf-8-sig")
    project_risk(tasks_latest).to_csv(reports_dir / "latest_project_risk.csv", index=False, encoding="utf-8-sig")
    hygiene_issues(tasks_latest).to_csv(reports_dir / "latest_hygiene_issues.csv", index=False, encoding="utf-8-sig")

    print(f"OK: обработана последняя выгрузка {latest.name}")
    print(f"latest: {latest_path}")
    if history_path:
        print(f"history: {history_path}")
    print("reports: reports/*.csv")


if __name__ == "__main__":
    main()
