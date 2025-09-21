import os
from flask import Flask, render_template, send_from_directory, abort, jsonify, request, redirect, url_for, session
from datetime import datetime, timedelta
import uuid
import base64
import mimetypes
import logging
from auth import login_required, validate_pin
from extensions import db
from logger import setup_logging

# Set up logging
setup_logging()
logger = logging.getLogger(__name__)

# create the app
app = Flask(__name__, static_url_path='/static', static_folder='static')

# Setup configuration
app.config.from_object('config.Config')

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
    """
    Retrieves a list of files and folders from the specified parent path.
    If no path is provided, it defaults to the root directory.
    """
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
    """
    Creates a new file or folder.
    Expects a JSON payload with file metadata.
    """
    from models import File
    data = request.json

    # Check if a file with the same path already exists
    if File.query.filter_by(path=data['path']).first():
        logger.warning(f"Attempted to create a file that already exists: {data['path']}")
        return jsonify({'error': 'File already exists'}), 409

    try:
        # Decode content if it exists
        content = base64.b64decode(data['content']) if data.get('content') else None

        # Create a new File object
        new_file = File(
            name=data['name'],
            path=data['path'],
            type=data['type'],
            parent_path=data['parentPath'],
            content=content,
            size=len(content) if content else 0
        )

        db.session.add(new_file)
        db.session.commit()

        logger.info(f"File or folder created: {new_file.path}")

        # Return the newly created file's data
        return jsonify({
            'path': new_file.path,
            'name': new_file.name,
            'type': new_file.type,
            'parentPath': new_file.parent_path,
            'content': f'data:{mimetypes.guess_type(new_file.name)[0] or "application/octet-stream"};base64,{base64.b64encode(new_file.content).decode("utf-8")}' if new_file.content else None,
            'created': new_file.created_at.isoformat(),
            'modified': new_file.modified_at.isoformat(),
            'size': new_file.size
        })
    except Exception as e:
        db.session.rollback()
        logger.error(f"Failed to create file at path: {data.get('path')}", exc_info=True)
        return jsonify({'error': 'An unexpected error occurred.'}), 500


@app.route('/api/files/<path:file_path>', methods=['GET', 'DELETE'])
@login_required
def handle_file(file_path):
    """
    Handles retrieving (GET) or deleting (DELETE) a specific file or folder.
    """
    from models import File
    file = File.query.filter_by(path=file_path).first_or_404()

    if request.method == 'GET':
        logger.info(f"Retrieved file: {file.path}")
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

    if request.method == 'DELETE':
        try:
            # If it's a folder, delete all its children first
            if file.type == 'folder':
                File.query.filter(File.path.startswith(f"{file_path}/")).delete(synchronize_session=False)
                logger.info(f"Deleted all children of folder: {file_path}")

            db.session.delete(file)
            db.session.commit()
            logger.info(f"Deleted file or folder: {file_path}")
            return '', 204
        except Exception as e:
            db.session.rollback()
            logger.error(f"Failed to delete: {file_path}", exc_info=True)
            return jsonify({'error': 'An unexpected error occurred during deletion.'}), 500


@app.route('/api/files/<path:file_path>', methods=['PUT'])
@login_required
def update_file(file_path):
    """
    Updates a file's name or content.
    """
    from models import File
    file = File.query.filter_by(path=file_path).first_or_404()
    data = request.json

    try:
        if 'name' in data:
            new_path = f"{file.parent_path}/{data['name']}"
            # Check if a file with the new name already exists
            if File.query.filter_by(path=new_path).first():
                logger.warning(f"Attempted to rename to an existing file name: {new_path}")
                return jsonify({'error': 'A file with this name already exists'}), 409

            logger.info(f"Renaming file from {file.path} to {new_path}")
            file.name = data['name']
            file.path = new_path

        if 'content' in data:
            logger.info(f"Updating content for file: {file.path}")
            file.content = base64.b64decode(data['content'])
            file.size = len(file.content)

        file.modified_at = datetime.utcnow()
        db.session.commit()

        logger.info(f"File updated successfully: {file.path}")
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
        logger.error(f"Failed to update file: {file_path}", exc_info=True)
        return jsonify({'error': 'An unexpected error occurred during the update.'}), 500


@app.route('/api/files/paste', methods=['POST'])
@login_required
def paste_file():
    """
    Pastes a file or folder to a new destination.
    This handles both 'copy' and 'cut' (move) operations.
    """
    from models import File
    data = request.json
    source_path = data['sourcePath']
    destination_path = data['destinationPath']
    operation = data['operation']

    source_file = File.query.filter_by(path=source_path).first_or_404()

    new_name = source_file.name
    new_path = f"{destination_path}/{new_name}"

    # Check if a file with the same name already exists at the destination
    if File.query.filter_by(path=new_path).first():
        # If it's a copy, we can add a suffix. For a move, this is an error.
        if operation == 'copy':
            new_name = f"{source_file.name.split('.')[0]}_copy.{source_file.name.split('.')[-1]}" if '.' in source_file.name else f"{source_file.name}_copy"
            new_path = f"{destination_path}/{new_name}"
        else:
            return jsonify({'error': 'A file with the same name already exists at the destination.'}), 409

    try:
        if operation == 'cut':
            # Move operation: just update the path
            logger.info(f"Moving file from {source_path} to {new_path}")
            source_file.path = new_path
            source_file.parent_path = destination_path
            source_file.name = new_name
            db.session.commit()
            return jsonify({'message': 'File moved successfully.'}), 200

        elif operation == 'copy':
            # Copy operation: create a new file
            logger.info(f"Copying file from {source_path} to {new_path}")
            new_file = File(
                name=new_name,
                path=new_path,
                type=source_file.type,
                parent_path=destination_path,
                content=source_file.content,
                size=source_file.size
            )
            db.session.add(new_file)
            db.session.commit()
            return jsonify({'message': 'File copied successfully.'}), 201

    except Exception as e:
        db.session.rollback()
        logger.error(f"Failed to paste file from {source_path} to {destination_path}", exc_info=True)
        return jsonify({'error': 'An unexpected error occurred during the paste operation.'}), 500


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


@app.route('/api/shares', methods=['GET'])
@login_required
def get_shared_files():
    """
    Retrieves a list of all shared files.
    """
    from models import SharedFile
    shared_files = SharedFile.query.all()
    return jsonify([{
        'share_id': sf.share_id,
        'file_name': sf.file.name,
        'created_at': sf.created_at.isoformat(),
        'expires_at': sf.expires_at.isoformat(),
    } for sf in shared_files])


@app.route('/static/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

# Add new password manager route
@app.route('/password-manager')
@login_required
def password_manager():
    return render_template('password_manager.html')

@app.route('/shared-files')
@login_required
def shared_files():
    return render_template('shared_files.html')

@app.route('/document-chat')
@login_required
def document_chat():
    return render_template('document_chat.html')

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

@app.route('/health')
def health_check():
    """
    Performs a health check of the application.
    Currently, it only checks the database connection.
    """
    try:
        # Try to execute a simple query against the database
        db.session.execute('SELECT 1')
        logger.info("Health check successful.")
        return jsonify({'status': 'ok'}), 200
    except Exception as e:
        logger.error("Health check failed.", exc_info=True)
        return jsonify({'status': 'error', 'reason': str(e)}), 503


with app.app_context():
    import models  # noqa: F401
    db.create_all()