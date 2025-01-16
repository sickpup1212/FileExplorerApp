// FileManager module for handling file operations
class FileManager {
    constructor() {
        this.db = null;
        this.currentPath = 'root';
        this.clipboard = null;
        this.MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

        this.init();
    }

    async init() {
        try {
            const request = indexedDB.open('FileExplorerDB', 2);

            request.onerror = (event) => {
                console.error('Database error:', event.target.error);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('files')) {
                    const store = db.createObjectStore('files', { keyPath: 'path' });
                    store.createIndex('parentPath', 'parentPath', { unique: false });
                    store.add({
                        path: 'root',
                        name: 'Root',
                        type: 'folder',
                        parentPath: null,
                        content: null,
                        created: new Date(),
                        modified: new Date(),
                        size: 0
                    });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.loadContent('root');
            };
        } catch (error) {
            console.error('Initialization error:', error);
        }
    }

    async loadContent(path) {
        return new Promise((resolve, reject) => {
            try {
                const transaction = this.db.transaction(['files'], 'readonly');
                const store = transaction.objectStore('files');
                const index = store.index('parentPath');
                const request = index.getAll(path);

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            } catch (error) {
                reject(error);
            }
        });
    }

    async createItem(name, type, content = null) {
        if (!name || name.includes('/')) {
            throw new Error('Invalid name');
        }

        const path = `${this.currentPath}/${name}`;
        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');

        const exists = await this.itemExists(path);
        if (exists) {
            throw new Error('Item already exists');
        }

        const item = {
            path,
            name,
            type,
            parentPath: this.currentPath,
            content,
            created: new Date(),
            modified: new Date(),
            size: content ? content.length : 0
        };

        return new Promise((resolve, reject) => {
            const request = store.add(item);
            request.onsuccess = () => resolve(item);
            request.onerror = () => reject(request.error);
        });
    }

    async deleteItem(path) {
        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');
        const item = await this.getItem(path);

        if (item.type === 'folder') {
            const children = await this.loadContent(path);
            for (const child of children) {
                await this.deleteItem(child.path);
            }
        }

        return new Promise((resolve, reject) => {
            const request = store.delete(path);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async renameItem(oldPath, newName) {
        const item = await this.getItem(oldPath);
        const newPath = `${item.parentPath}/${newName}`;

        if (await this.itemExists(newPath)) {
            throw new Error('An item with this name already exists');
        }

        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');

        item.name = newName;
        item.path = newPath;
        item.modified = new Date();

        await this.deleteItem(oldPath);
        return new Promise((resolve, reject) => {
            const request = store.add(item);
            request.onsuccess = () => resolve(item);
            request.onerror = () => reject(request.error);
        });
    }

    async itemExists(path) {
        return new Promise((resolve) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const request = store.get(path);
            request.onsuccess = () => resolve(!!request.result);
        });
    }

    async getItem(path) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const request = store.get(path);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async getItems(path) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const index = store.index('parentPath');
            const request = index.getAll(path);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
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

    async moveItem(oldPath, newPath) {
        const item = await this.getItem(oldPath);
        item.path = newPath;
        item.parentPath = this.currentPath;
        item.modified = new Date();

        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');

        await this.deleteItem(oldPath);
        return new Promise((resolve, reject) => {
            const request = store.add(item);
            request.onsuccess = () => resolve(item);
            request.onerror = () => reject(request.error);
        });
    }

    async copyItem(oldPath, newPath) {
        const item = await this.getItem(oldPath);
        const newItem = {
            ...item,
            path: newPath,
            parentPath: this.currentPath,
            created: new Date(),
            modified: new Date()
        };

        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');

        return new Promise((resolve, reject) => {
            const request = store.add(newItem);
            request.onsuccess = () => resolve(newItem);
            request.onerror = () => reject(request.error);
        });
    }
}

export default FileManager;