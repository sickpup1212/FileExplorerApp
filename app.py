import os
from flask import Flask, render_template, send_from_directory, abort, jsonify, request, redirect, url_for, session
from datetime import datetime, timedelta
import uuid
import base64
import mimetypes
from auth import login_required, validate_pin
from extensions import db

# create the app
app = Flask(__name__, static_url_path='/static', static_folder='static')

# Setup configuration
app.config["SECRET_KEY"] = os.environ.get("FLASK_SECRET_KEY", "dev_key_only")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL")
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {
    "pool_recycle": 300,
    "pool_pre_ping": True,
}

# Initialize the database with the app
db.init_app(app)

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        pin = request.form.get('pin')
        if validate_pin(pin):
            session['user_id'] = 1  # Set user session
            return redirect(url_for('index'))
        return render_template('login.html', error='Invalid PIN')
    return render_template('login.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.route('/')
@login_required
def index():
    return render_template('index.html')


@app.route('/editor')
@login_required
def editor():
    file_path = request.args.get('file')
    return render_template('editor.html', file_path=file_path)


@app.route('/api/files', methods=['GET'])
@login_required
def get_files():
    from models import File
    parent_path = request.args.get('path', 'root')
    files = File.query.filter_by(parent_path=parent_path).all()
    return jsonify([{
        'path': f.path,
        'name': f.name,
        'type': f.type,
        'parentPath': f.parent_path,
        'content': f'data:{mimetypes.guess_type(f.name)[0] or "application/octet-stream"};base64,{base64.b64encode(f.content).decode("utf-8")}' if f.content else None,
        'created': f.created_at.isoformat(),
        'modified': f.modified_at.isoformat(),
        'size': f.size
    } for f in files])


@app.route('/api/files', methods=['POST'])
@login_required
def create_file():
    from models import File
    data = request.json

    # Check if file already exists
    existing = File.query.filter_by(path=data['path']).first()
    if existing:
        return jsonify({'error': 'File already exists'}), 409

    try:
        content = base64.b64decode(data['content']) if data.get('content') else None
        file = File(
            name=data['name'],
            path=data['path'],
            type=data['type'],
            parent_path=data['parentPath'],
            content=content,
            size=len(content) if content else 0
        )
        db.session.add(file)
        db.session.commit()

        return jsonify({
            'path': file.path,
            'name': file.name,
            'type': file.type,
            'parentPath': file.parent_path,
            'content': f'data:{mimetypes.guess_type(file.name)[0] or "application/octet-stream"};base64,{base64.b64encode(file.content).decode("utf-8")}' if file.content else None,
            'created': file.created_at.isoformat(),
            'modified': file.modified_at.isoformat(),
            'size': file.size
        })
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500


@app.route('/api/files/<path:file_path>', methods=['GET', 'DELETE'])
@login_required
def handle_file(file_path):
    from models import File
    if request.method == 'GET':
        file = File.query.filter_by(path=file_path).first_or_404()
        return jsonify({
            'path': file.path,
            'name': file.name,
            'type': file.type,
            'parentPath': file.parent_path,
            'content': f'data:{mimetypes.guess_type(file.name)[0] or "application/octet-stream"};base64,{base64.b64encode(file.content).decode("utf-8")}' if file.content else None,
            'created': file.created_at.isoformat(),
            'modified': file.modified_at.isoformat(),
            'size': file.size
        })

    # Handle DELETE
    file = File.query.filter_by(path=file_path).first_or_404()

    # If it's a folder, delete all children
    if file.type == 'folder':
        File.query.filter(File.path.startswith(f"{file_path}/")).delete()

    db.session.delete(file)
    db.session.commit()
    return '', 204


@app.route('/api/files/<path:file_path>', methods=['PUT'])
@login_required
def update_file(file_path):
    from models import File
    file = File.query.filter_by(path=file_path).first_or_404()
    data = request.json

    if 'name' in data:
        new_path = f"{file.parent_path}/{data['name']}"
        if File.query.filter_by(path=new_path).first():
            return jsonify({'error': 'A file with this name already exists'}), 409
        file.name = data['name']
        file.path = new_path

    if 'content' in data:
        file.content = base64.b64decode(data['content'])
        file.size = len(file.content)

    file.modified_at = datetime.utcnow()
    db.session.commit()

    return jsonify({
        'path': file.path,
        'name': file.name,
        'type': file.type,
        'parentPath': file.parent_path,
        'content': f'data:{mimetypes.guess_type(file.name)[0] or "application/octet-stream"};base64,{base64.b64encode(file.content).decode("utf-8")}' if file.content else None,
        'created': file.created_at.isoformat(),
        'modified': file.modified_at.isoformat(),
        'size': file.size
    })


@app.route('/share/<share_id>')
def shared_file(share_id):
    return render_template('shared.html', share_id=share_id)


@app.route('/api/share/<share_id>')
def get_shared_file(share_id):
    from models import SharedFile
    shared = SharedFile.query.filter_by(share_id=share_id).first()

    if not shared or shared.expires_at < datetime.utcnow():
        return jsonify({'error': 'Shared file not found or expired'}), 404

    file = shared.file
    return jsonify({
        'name': file.name,
        'type': file.type,
        'content': f'data:{mimetypes.guess_type(file.name)[0] or "application/octet-stream"};base64,{base64.b64encode(file.content).decode("utf-8")}' if file.content else None,
        'created': shared.created_at.isoformat()
    })


@app.route('/api/share', methods=['POST'])
@login_required
def create_share():
    from models import File, SharedFile
    data = request.json
    file = File.query.filter_by(path=data['path']).first_or_404()

    share_id = str(uuid.uuid4())
    shared = SharedFile(
        share_id=share_id,
        file_id=file.id,
        expires_at=datetime.utcnow() + timedelta(days=7)
    )
    db.session.add(shared)
    db.session.commit()

    return jsonify({'shareId': share_id})


@app.route('/static/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

# Add new password manager route
@app.route('/password-manager')
@login_required
def password_manager():
    return render_template('password_manager.html')

@app.route('/document-chat')
@login_required
def document_chat():
    return render_template('chatai.html')

@app.route('/api/doc-chat/add-file', methods=['POST'])
@login_required
def add_doc_chat_file():
    from models import File
    data = request.json
    source_path = data['path']

    # Get the source file
    source_file = File.query.filter_by(path=source_path).first_or_404()

    # Only allow text or image files
    mime_type = mimetypes.guess_type(source_file.name)[0]
    if not (mime_type and (mime_type.startswith('text/') or mime_type.startswith('image/'))):
        return jsonify({'error': 'Only text and image files are supported'}), 400

    return jsonify({
        'name': source_file.name,
        'type': source_file.type,
        'content': f'data:{mime_type};base64,{base64.b64encode(source_file.content).decode("utf-8")}' if source_file.content else None,
        'size': source_file.size
    })

@app.route('/api/doc-chat/get-text-content', methods=['POST'])
@login_required
def get_doc_chat_text():
    from models import File
    data = request.json
    file_path = data['path']

    # Get the file
    file = File.query.filter_by(path=file_path).first_or_404()

    # Only allow text files
    mime_type = mimetypes.guess_type(file.name)[0]
    if not (mime_type and mime_type.startswith('text/')):
        return jsonify({'error': 'Only text files are supported'}), 400

    # Return the text content
    return jsonify({
        'content': file.content.decode('utf-8') if file.content else ''
    })

with app.app_context():
    import models  # noqa: F401
    db.create_all()