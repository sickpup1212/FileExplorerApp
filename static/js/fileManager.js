// FileManager module for handling file operations
class FileManager {
    constructor() {
        this.db = null;
        this.currentPath = 'root';
        this.clipboard = null;
        this.MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    }

    async init() {
        try {
            await new Promise((resolve, reject) => {
                const request = indexedDB.open('FileExplorerDB', 3); // Increment version for new store

                request.onerror = () => reject(request.error);

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;

                    // Create files store if it doesn't exist
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

                    // Create shares store if it doesn't exist
                    if (!db.objectStoreNames.contains('shares')) {
                        const sharesStore = db.createObjectStore('shares', { keyPath: 'shareId' });
                        sharesStore.createIndex('expires', 'expires', { unique: false });
                    }
                };

                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve();
                };
            });
        } catch (error) {
            console.error('Initialization error:', error);
            throw error;
        }
    }

    async itemExists(path) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const request = store.get(path);

            request.onsuccess = () => resolve(!!request.result);
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async createItem(name, type, content = null) {
        if (!name || name.includes('/')) {
            throw new Error('Invalid name');
        }

        const path = `${this.currentPath}/${name}`;

        // Check if item exists
        const exists = await this.itemExists(path);
        if (exists) {
            throw new Error('Item already exists');
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');

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

            const request = store.add(item);
            request.onsuccess = () => resolve(item);
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async deleteItem(path) {
        const item = await this.getItem(path);
        if (!item) return;

        if (item.type === 'folder') {
            const children = await this.loadContent(path);
            const transaction = this.db.transaction(['files'], 'readwrite');
            const store = transaction.objectStore('files');

            return new Promise((resolve, reject) => {
                transaction.onerror = () => reject(transaction.error);

                // Delete all children and the folder itself in one transaction
                const deleteRequests = [...children, item].map(item => {
                    return store.delete(item.path);
                });

                transaction.oncomplete = () => resolve();
            });
        } else {
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction(['files'], 'readwrite');
                const store = transaction.objectStore('files');
                const request = store.delete(path);

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                transaction.onerror = () => reject(transaction.error);
            });
        }
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

    async moveItem(sourcePath, targetPath) {
        // Prevent moving a folder into its own subfolder
        if (targetPath.startsWith(sourcePath + '/')) {
            throw new Error('Cannot move a folder into its own subfolder');
        }

        const sourceItem = await this.getItem(sourcePath);
        if (!sourceItem) {
            throw new Error('Source item not found');
        }

        const transaction = this.db.transaction(['files'], 'readwrite');
        const store = transaction.objectStore('files');

        return new Promise((resolve, reject) => {
            const newItem = {
                ...sourceItem,
                path: targetPath,
                parentPath: this.currentPath,
                modified: new Date()
            };

            const deleteRequest = store.delete(sourcePath);
            deleteRequest.onsuccess = () => {
                const addRequest = store.add(newItem);
                addRequest.onsuccess = () => resolve(newItem);
                addRequest.onerror = () => reject(addRequest.error);
            };
            deleteRequest.onerror = () => reject(deleteRequest.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getItem(path) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const request = store.get(path);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async loadContent(path) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['files'], 'readonly');
            const store = transaction.objectStore('files');
            const index = store.index('parentPath');
            const request = index.getAll(path);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
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

    async generateShareLink(item) {
        const shareId = Math.random().toString(36).substring(2) + Date.now().toString(36);

        const sharedItem = {
            shareId,
            originalPath: item.path,
            name: item.name,
            type: item.type,
            content: item.content,
            created: new Date(),
            expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days expiry
        };

        // Store shared item in IndexedDB
        const transaction = this.db.transaction(['shares'], 'readwrite');
        const store = transaction.objectStore('shares');

        return new Promise((resolve, reject) => {
            const request = store.add(sharedItem);
            request.onsuccess = () => resolve(shareId);
            request.onerror = () => reject(request.error);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async getSharedItem(shareId) {
        const transaction = this.db.transaction(['shares'], 'readonly');
        const store = transaction.objectStore('shares');

        return new Promise((resolve, reject) => {
            const request = store.get(shareId);
            request.onsuccess = () => {
                const item = request.result;
                if (!item || new Date(item.expires) < new Date()) {
                    resolve(null);
                } else {
                    resolve(item);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
}

export default FileManager;