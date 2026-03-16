import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

# 单一入口的数据库配置模块。
# 通过环境变量 DB_URL 控制底层数据库，实现在 SQLite / PostgreSQL 之间一键切换。

DB_URL = os.getenv("DB_URL", "sqlite:////data/app.db")

# SQLite 需要特殊的 connect_args；PostgreSQL 等不需要。
connect_args = {}
if DB_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(DB_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

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

