from datetime import datetime
from extensions import db
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash


class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False)
    pin_hash = db.Column(db.String(256))

    def set_pin(self, pin):
        self.pin_hash = generate_password_hash(pin)

    def check_pin(self, pin):
        return check_password_hash(self.pin_hash, pin)


class File(db.Model):
    __tablename__ = 'files'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    path = db.Column(db.String(1024), nullable=False, unique=True)
    type = db.Column(db.String(50), nullable=False)  # 'file' or 'folder'
    parent_path = db.Column(db.String(1024))
    content = db.Column(db.LargeBinary, nullable=True)  # NULL for folders
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    modified_at = db.Column(db.DateTime, 
                          default=datetime.utcnow, 
                          onupdate=datetime.utcnow)
    size = db.Column(db.Integer, default=0)


class SharedFile(db.Model):
    __tablename__ = 'shared_files'
    id = db.Column(db.Integer, primary_key=True)
    share_id = db.Column(db.String(64), unique=True, nullable=False)
    file_id = db.Column(db.Integer, db.ForeignKey('files.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    expires_at = db.Column(db.DateTime, nullable=False)

    # Relationship to get file details
    file = db.relationship('File', backref=db.backref('shares', lazy=True))