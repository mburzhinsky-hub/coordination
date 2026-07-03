from __future__ import annotations

from pathlib import Path
from typing import Any, Dict
import re
import yaml
import pandas as pd


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_yaml(path: str | Path) -> Dict[str, Any]:
    p = Path(path)
    if not p.is_absolute():
        p = project_root() / p
    if not p.exists():
        return {}
    with p.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def clean_text(value: Any) -> str:
    if pd.isna(value):
        return ""
    text = str(value).replace("\xa0", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return text


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_dataframe(df: pd.DataFrame, path_without_ext: str | Path) -> Path:
    """Save as parquet when pyarrow is available, otherwise as CSV.

    Returns the actual written path.
    """
    base = Path(path_without_ext)
    base.parent.mkdir(parents=True, exist_ok=True)
    try:
        out = base.with_suffix(".parquet")
        df.to_parquet(out, index=False)
        return out
    except Exception:
        out = base.with_suffix(".csv")
        df.to_csv(out, index=False, encoding="utf-8-sig")
        return out


def read_saved_dataframe(path_without_ext: str | Path) -> pd.DataFrame:
    base = Path(path_without_ext)
    pq = base.with_suffix(".parquet")
    csv = base.with_suffix(".csv")
    if pq.exists():
        return pd.read_parquet(pq)
    if csv.exists():
        return pd.read_csv(csv)
    return pd.DataFrame()


def parse_export_datetime_from_filename(path: str | Path) -> pd.Timestamp | pd.NaT:
    name = Path(path).name
    match = re.search(r"(20\d{2}-\d{2}-\d{2})[_-](\d{2})[-:](\d{2})(?:[-:](\d{2}))?", name)
    if not match:
        return pd.NaT
    date, hh, mm, ss = match.groups()
    ss = ss or "00"
    return pd.to_datetime(f"{date} {hh}:{mm}:{ss}", errors="coerce")
