class FileManager {
    constructor() {
        this.currentPath = 'root';
        this.clipboard = null;
        this.MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
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

        // If content is already a base64 string (from file upload), use it directly
        // Otherwise, encode it to base64
        const contentToSend = content?.startsWith('data:') ? 
            content.split(',')[1] : 
            content ? btoa(content) : null;

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

    async moveItem(sourcePath, targetPath) {
        const item = await this.getItem(sourcePath);
        if (!item) {
            throw new Error('Source item not found');
        }

        // Create new item at target location
        const newItem = await this.createItem(
            item.name,
            item.type,
            item.content
        );

        // Delete the original item
        await this.deleteItem(sourcePath);

        return newItem;
    }

    async getItem(path) {
        const items = await this.loadContent(this.currentPath);
        return items.find(item => item.path === path);
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
        if (!this.clipboard) return;

        const { item, operation } = this.clipboard;
        const newName = item.name;
        const newPath = `${this.currentPath}/${newName}`;

        if (operation === 'cut') {
            await this.moveItem(item.path, newPath);
        } else {
            await this.copyItem(item.path, newPath);
        }

        if (operation === 'cut') {
            this.clipboard = null;
        }
    }

    async copyItem(oldPath, newPath) {
        const item = await this.getItem(oldPath);
        if (!item) {
            throw new Error('Source item not found');
        }

        return this.createItem(
            item.name,
            item.type,
            item.content
        );
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