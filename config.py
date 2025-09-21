import os

class Config:
    SECRET_KEY = os.environ.get("FLASK_SECRET_key", "dev_key_only")
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL")
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_recycle": 300,
        "pool_pre_ping": True,
    }
