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
    """
    Validates the given PIN against the admin user's stored PIN.
    If the admin user does not exist, it creates one with the given PIN.
    """
    user = User.query.filter_by(username='admin').first()
    if not user:
        # Create a default admin user if one doesn't exist
        user = User(username='admin')
        user.set_pin(pin)
        db.session.add(user)
        db.session.commit()
        return True

    # Check the provided PIN against the stored hash
    return user.check_pin(pin)