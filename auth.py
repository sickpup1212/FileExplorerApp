from functools import wraps
from flask import session, redirect, url_for
from models import User
from extensions import db

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def validate_pin(pin):
    # This is a placeholder - in production, you'd want to validate against a user's stored PIN
    # For now, we'll use a simple check against a default user
    user = User.query.filter_by(username='admin').first()
    if not user:
        # Create default admin user if not exists
        user = User(username='admin', email='admin@example.com')
        user.set_password(pin)
        db.session.add(user)
        db.session.commit()
        return True
    return user.check_password(pin)