import argparse
import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from ..db import SessionLocal
from ..db import engine
from .. import models


def build_rel_path(row: models.FootfallFaceCapture) -> str:
    ts = float(row.ts or 0.0)
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    day = dt.strftime("%Y-%m-%d")
    return (
        f"{day}/fp{int(row.floor_plan_id)}_vv{int(row.virtual_view_id)}"
        f"_t{int(ts * 1000)}_s{int(row.stable_id or -1)}_k{int(row.track_id or -1)}.jpg"
    )


def run(target_dir: str, clear_base64: bool = False, limit: int = 0) -> dict:
    # Compatibility migration for old DB: add image_path column if missing.
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE footfall_face_captures ADD COLUMN image_path TEXT")
    except Exception:
        # Column may already exist; ignore.
        pass
    os.makedirs(target_dir, exist_ok=True)
    scanned = 0
    migrated = 0
    skipped = 0
    cleared_base64 = 0
    with SessionLocal() as db:
        q = db.query(models.FootfallFaceCapture).order_by(models.FootfallFaceCapture.id.asc())
        if limit > 0:
            q = q.limit(int(limit))
        rows = q.all()
        for row in rows:
            scanned += 1
            image_path = str(getattr(row, "image_path", "") or "").strip()
            if image_path:
                if clear_base64 and str(getattr(row, "image_base64", "") or "").strip():
                    row.image_base64 = ""
                    cleared_base64 += 1
                skipped += 1
                continue
            raw_b64 = str(getattr(row, "image_base64", "") or "").strip()
            if not raw_b64:
                skipped += 1
                continue
            try:
                jpg = base64.b64decode(raw_b64)
            except Exception:
                skipped += 1
                continue
            rel = build_rel_path(row)
            abs_path = os.path.join(target_dir, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "wb") as f:
                f.write(jpg)
            row.image_path = rel
            if clear_base64:
                row.image_base64 = ""
                cleared_base64 += 1
            migrated += 1
        db.commit()
    return {
        "status": "ok",
        "scanned": int(scanned),
        "migrated": int(migrated),
        "skipped": int(skipped),
        "cleared_base64": int(cleared_base64),
        "target_dir": str(target_dir),
        "clear_base64": bool(clear_base64),
        "limit": int(limit),
    }


def _default_target_dir() -> str:
    docker_dir = "/data/face-captures"
    if os.path.isdir("/data"):
        return docker_dir
    repo_root = Path(__file__).resolve().parents[3]
    return str(repo_root / "data" / "face-captures")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate footfall face captures from base64-in-DB to image files.")
    parser.add_argument("--target-dir", default=os.environ.get("FACE_CAPTURE_DIR", _default_target_dir()))
    parser.add_argument("--clear-base64", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--report-path", default="migration_report.json")
    args = parser.parse_args()
    db_url = os.environ.get("DB_URL", "sqlite:////data/app.db")
    print(f"[migrate] DB_URL={db_url}")
    print(f"[migrate] target_dir={args.target_dir}")
    try:
        result = run(target_dir=str(args.target_dir), clear_base64=bool(args.clear_base64), limit=int(args.limit))
        report_path = str(args.report_path)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=True, indent=2)
        print(f"[migrate] report_path={report_path}")
        print(
            f"face-capture migration done: scanned={result['scanned']}, migrated={result['migrated']}, "
            f"skipped={result['skipped']}, cleared_base64={result['cleared_base64']}, "
            f"clear_base64={result['clear_base64']}"
        )
    except Exception as e:
        report_path = str(args.report_path)
        try:
            with open(report_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "status": "error",
                        "error_type": type(e).__name__,
                        "error": str(e),
                        "target_dir": str(args.target_dir),
                        "limit": int(args.limit),
                    },
                    f,
                    ensure_ascii=True,
                    indent=2,
                )
        except Exception:
            pass
        print(f"[migrate] failed: {type(e).__name__}: {e}")
        raise


if __name__ == "__main__":
    main()
