from datetime import datetime
from app import db

class File(db.Model):
    __tablename__ = 'files'
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    path = db.Column(db.String(1024), nullable=False, unique=True)
    type = db.Column(db.String(50), nullable=False)  # 'file' or 'folder'
    parent_path = db.Column(db.String(1024))
    content = db.Column(db.LargeBinary, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    modified_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    size = db.Column(db.Integer, default=0)  # Size in bytes
