class FileManager {
    constructor() {
        this.currentPath = 'root';
        this.clipboard = null;
        this.MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    }

    _arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    async init() {
        // No initialization needed for PostgreSQL backend
        return Promise.resolve();
    }

    async itemExists(path) {
        const items = await this.loadContent(this.currentPath);
        return items.some(item => item.path === path);
    }

    async createItem(name, type, content = null) {
        if (!name || name.includes('/')) {
            throw new Error('Invalid name');
        }

        const path = `${this.currentPath}/${name}`;
        const exists = await this.itemExists(path);
        if (exists) {
            throw new Error('Item already exists');
        }

        // If content is an ArrayBuffer, convert it to base64.
        // Otherwise, if content is plain text, encode it to base64.
        let contentToSend = null;
        if (content) {
            if (content instanceof ArrayBuffer) {
                contentToSend = this._arrayBufferToBase64(content);
            } else {
                // This branch is for creating files with text content, like from the createFile method
                contentToSend = btoa(unescape(encodeURIComponent(content)));
            }
        }

        const response = await fetch('/api/files', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path,
                name,
                type,
                parentPath: this.currentPath,
                content: contentToSend
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create item');
        }

        return response.json();
    }

    async deleteItem(path) {
        const response = await fetch(`/api/files/${encodeURIComponent(path)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error('Failed to delete item');
        }
    }

    async renameItem(oldPath, newName) {
        const response = await fetch(`/api/files/${encodeURIComponent(oldPath)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: newName })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to rename item');
        }

        return response.json();
    }

    async getItem(path) {
        const response = await fetch(`/api/files/${encodeURIComponent(path)}`);
        if (!response.ok) {
            return null;
        }
        return response.json();
    }

    async loadContent(path) {
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            throw new Error('Failed to load content');
        }
        return response.json();
    }

    async getItems(path) {
        return this.loadContent(path);
    }

    copyToClipboard(item, cut = false) {
        this.clipboard = {
            item,
            operation: cut ? 'cut' : 'copy'
        };
    }

    async paste() {
        if (!this.clipboard) {
            throw new Error('Clipboard is empty.');
        }

        const { item, operation } = this.clipboard;
        const destinationPath = this.currentPath;

        const response = await fetch('/api/files/paste', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sourcePath: item.path,
                destinationPath,
                operation, // 'cut' or 'copy'
            }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to paste item');
        }

        if (operation === 'cut') {
            this.clipboard = null;
        }

        return response.json();
    }

    async generateShareLink(item) {
        const response = await fetch('/api/share', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ path: item.path })
        });

        if (!response.ok) {
            throw new Error('Failed to generate share link');
        }

        const data = await response.json();
        return data.shareId;
    }

    async getSharedItem(shareId) {
        const response = await fetch(`/api/share/${shareId}`);
        if (!response.ok) {
            return null;
        }
        return response.json();
    }
}

export default FileManager;