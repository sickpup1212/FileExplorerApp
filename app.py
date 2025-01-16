import os
from flask import Flask, render_template, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

db = SQLAlchemy(model_class=Base)
app = Flask(__name__, static_folder='.')

# Setup configuration
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "dev_key_only")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///explorer.db")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

db.init_app(app)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

# Serve static files
@app.route('/<path:path>')
def serve_file(path):
    return send_from_directory('.', path)

with app.app_context():
    import models  # noqa: F401
    db.create_all()
