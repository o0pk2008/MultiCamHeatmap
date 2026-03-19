import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy import event as sa_event
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# 单一入口的数据库配置模块。
# 通过环境变量 DB_URL 控制底层数据库，实现在 SQLite / PostgreSQL 之间一键切换。

DB_URL = os.getenv("DB_URL", "sqlite:////data/app.db")

# SQLite 需要特殊的 connect_args；PostgreSQL 等不需要。
connect_args = {}
if DB_URL.startswith("sqlite"):
    # timeout: SQLite 等待写锁的时间（秒），避免高并发写入时立刻抛 "database is locked"
    connect_args = {"check_same_thread": False, "timeout": 30}

engine = create_engine(DB_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# SQLite 并发优化：WAL + busy_timeout（仅对 sqlite 生效）
if DB_URL.startswith("sqlite"):
    @sa_event.listens_for(engine, "connect")
    def _sqlite_on_connect(dbapi_connection, connection_record):  # type: ignore[no-untyped-def]
        try:
            cur = dbapi_connection.cursor()
            # WAL 允许读写并发（仍然单写者，但锁冲突明显减少）
            cur.execute("PRAGMA journal_mode=WAL;")
            # 写入性能/稳定性折中
            cur.execute("PRAGMA synchronous=NORMAL;")
            # 连接级等待时间（ms）
            cur.execute("PRAGMA busy_timeout=30000;")
            cur.close()
        except Exception:
            pass

# 所有 ORM model 都应该继承自 Base。
Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI 依赖注入用的 Session 生成器。
    使用方式：db: Session = Depends(get_db)
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

