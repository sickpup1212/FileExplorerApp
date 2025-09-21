document.addEventListener('DOMContentLoaded', async () => {
    feather.replace();

    // Get file path from URL
    const urlParams = new URLSearchParams(window.location.search);
    const filePath = urlParams.get('file');

    // Initialize CodeMirror
    const editor = CodeMirror.fromTextArea(document.getElementById('editor'), {
        lineNumbers: true,
        theme: 'monokai',
        mode: 'javascript',
        indentUnit: 4,
        autoCloseBrackets: true,
        matchBrackets: true,
        lineWrapping: true,
        tabSize: 4,
        extraKeys: {
            "Ctrl-S": function(cm) {
                saveFile();
            }
        }
    });

    // Set initial size
    editor.setSize('100%', '100%');

    const sidebar = document.getElementById('sidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const sidebarClose = document.getElementById('sidebarClose');

    sidebarToggle.addEventListener('click', () => {
        sidebar.classList.add('show');
    });

    sidebarClose.addEventListener('click', () => {
        sidebar.classList.remove('show');
    });

    // Load file content if path provided
    if (filePath) {
        try {
            const response = await fetch(`/api/files/${encodeURIComponent(filePath)}`);
            if (response.ok) {
                const file = await response.json();
                if (file.content) {
                    // Extract content from data URL
                    const contentParts = file.content.split(',');
                    if (contentParts.length > 1) {
                        const content = atob(contentParts[1]);
                        editor.setValue(content);

                        // Set mode based on file extension
                        const extension = file.name.split('.').pop().toLowerCase();
                        const modeMap = {
                            'js': 'javascript',
                            'py': 'python',
                            'html': 'xml',
                            'css': 'css',
                            'json': 'javascript'
                        };
                        editor.setOption('mode', modeMap[extension] || 'text');
                    }
                }
            }
        } catch (error) {
            console.error('Error loading file:', error);
        }
    }

    // File operations
    const newFileBtn = document.getElementById('newFileBtn');
    const openFileBtn = document.getElementById('openFileBtn');
    const saveFileBtn = document.getElementById('saveFileBtn');

    newFileBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to create a new file? Any unsaved changes will be lost.')) {
            editor.setValue('');
        }
    });

    openFileBtn.addEventListener('click', () => {
        // Redirect to the file explorer
        window.location.href = '/?action=open';
    });

    // Helper function to safely encode content to base64
    function utf8ToBase64(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }

    async function saveFile() {
        const content = editor.getValue();
        if (!filePath) {
            const fileName = prompt('Enter file name:', 'untitled.txt');
            if (!fileName) return;

            try {
                const response = await fetch('/api/files', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        name: fileName,
                        path: `root/${fileName}`,
                        type: 'file',
                        parentPath: 'root',
                        content: utf8ToBase64(content)
                    })
                });

                if (response.ok) {
                    const file = await response.json();
                    window.location.href = `/editor?file=${encodeURIComponent(file.path)}`;
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to save file');
                }
            } catch (error) {
                console.error('Error saving file:', error);
                alert('Failed to save file');
            }
        } else {
            try {
                const response = await fetch(`/api/files/${encodeURIComponent(filePath)}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        content: utf8ToBase64(content)
                    })
                });

                if (response.ok) {
                    alert('File saved successfully!');
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to save file');
                }
            } catch (error) {
                console.error('Error saving file:', error);
                alert('Failed to save file');
            }
        }
    }

    // Add save file function to the button
    saveFileBtn.addEventListener('click', saveFile);
});