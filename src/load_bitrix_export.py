from __future__ import annotations

from pathlib import Path
from typing import BinaryIO, Iterable
import pandas as pd

from .utils import clean_text, parse_export_datetime_from_filename


def find_raw_exports(raw_dir: str | Path) -> list[Path]:
    raw = Path(raw_dir)
    patterns = ["*.xls", "*.xlsx", "*.html", "*.htm", "*.csv"]
    files: list[Path] = []
    for pattern in patterns:
        files.extend(raw.glob(pattern))
    return sorted(files, key=lambda p: p.stat().st_mtime)


def latest_export(raw_dir: str | Path) -> Path | None:
    files = find_raw_exports(raw_dir)
    return files[-1] if files else None


def _read_as_html(source) -> pd.DataFrame:
    dfs = pd.read_html(source)
    if not dfs:
        raise ValueError("В файле не найдены HTML-таблицы")
    # Usually Bitrix exports a single table. If there are several, use the largest.
    return max(dfs, key=lambda x: x.shape[0] * max(1, x.shape[1]))


def read_bitrix_export(source: str | Path | BinaryIO, filename: str | None = None) -> pd.DataFrame:
    """Read a Bitrix task export.

    Bitrix often produces an HTML table with .xls extension, therefore HTML parsing
    is attempted first. Excel and CSV readers are used as fallback.
    """
    source_name = filename or getattr(source, "name", "uploaded_export")

    try:
        df = _read_as_html(source)
    except Exception:
        if hasattr(source, "seek"):
            source.seek(0)
        try:
            df = pd.read_excel(source)
        except Exception:
            if hasattr(source, "seek"):
                source.seek(0)
            df = pd.read_csv(source, sep=None, engine="python")

    df = normalize_raw_columns(df)
    export_at = parse_export_datetime_from_filename(source_name)
    df["source_file"] = Path(source_name).name
    df["export_at"] = export_at
    return df


def normalize_raw_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [clean_text(c) for c in df.columns]
    df = df.dropna(how="all")
    # Remove completely unnamed columns from accidental exports.
    df = df[[c for c in df.columns if c and not c.startswith("Unnamed")]]
    return df


def read_all_exports(raw_dir: str | Path) -> pd.DataFrame:
    frames = []
    for path in find_raw_exports(raw_dir):
        try:
            frames.append(read_bitrix_export(path, filename=path.name))
        except Exception as exc:
            print(f"Не удалось прочитать {path}: {exc}")
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True, sort=False)
