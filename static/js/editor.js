document.addEventListener('DOMContentLoaded', async () => {
    feather.replace();

    // Get file path from URL
    const urlParams = new URLSearchParams(window.location.search);
    const filePath = urlParams.get('file');

    // Initialize CodeMirror
    let isDirty = false;

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

    editor.on('change', () => {
        isDirty = true;
        updateTitle();
    });

    // Set initial size
    editor.setSize('100%', '100%');

    function updateTitle() {
        const baseTitle = "Text Editor - Modern File Explorer";
        if (filePath) {
            const fileName = filePath.split('/').pop();
            document.title = `${isDirty ? '*' : ''}${fileName} - ${baseTitle}`;
        } else {
            document.title = `${isDirty ? '*' : ''}Untitled - ${baseTitle}`;
        }
    }

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
                        isDirty = false;
                        updateTitle();

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
    } else {
        updateTitle();
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
        // Redirect to the file explorer in file picker mode
        window.location.href = '/?from=editor';
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

            const lastPath = sessionStorage.getItem('lastPath') || 'root';

            try {
                const response = await fetch('/api/files', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        name: fileName,
                        path: `${lastPath}/${fileName}`,
                        type: 'file',
                        parentPath: lastPath,
                        content: utf8ToBase64(content)
                    })
                });

                if (response.ok) {
                    const file = await response.json();
                    isDirty = false;
                    updateTitle();
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
                    isDirty = false;
                    updateTitle();
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

    window.addEventListener('beforeunload', (e) => {
        if (isDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // Modify the new file button to check for unsaved changes
    newFileBtn.addEventListener('click', () => {
        if (isDirty && !confirm('Are you sure you want to create a new file? Any unsaved changes will be lost.')) {
            return;
        }
        editor.setValue('');
        isDirty = false;
        updateTitle();
        window.history.replaceState({}, '', '/editor');
    });
});