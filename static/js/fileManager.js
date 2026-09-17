/**
 * FileManager talks to the Flask REST API.
 *
 * It previously stored every byte in browser IndexedDB, which meant files were
 * trapped in one browser on one device.  The storage backend is now the server,
 * so the same library is visible from a phone and a desktop at the same time.
 */

export class AuthRequiredError extends Error {
    constructor(message = 'Authentication required') {
        super(message);
        this.name = 'AuthRequiredError';
        this.authRequired = true;
    }
}

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

/** Fetch a URL with the session cookie and non-2xx responses turned into throws. */
async function apiFetch(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });

    if (response.status === 401) {
        const body = await response.json().catch(() => ({}));
        if (body.auth_required) throw new AuthRequiredError(body.error);
    }

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
    }

    if (response.status === 204) return null;
    return response.json();
}

function encodePath(path) {
    return encodeURIComponent(path || '');
}

class FileManager {
    constructor() {
        this.currentPath = '';
        this.clipboard = null;
        // 0 means unlimited; the server enforces its own MAX_UPLOAD_MB setting.
        this.MAX_FILE_SIZE = 0;
        /** Object URLs created for previews, revoked when replaced. */
        this._objectUrls = [];
    }

    async init() {
        const status = await apiFetch('/api/auth/status');
        if (!status.authenticated) throw new AuthRequiredError();
        return status;
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------
    async getItems(path = this.currentPath) {
        const data = await apiFetch(`/api/files?path=${encodePath(path)}`);
        return data.items;
    }

    async loadContent(path = this.currentPath) {
        return this.getItems(path);
    }

    async getItem(path) {
        try {
            return await apiFetch(`/api/stat?path=${encodePath(path)}`);
        } catch (error) {
            if (error.status === 404) return undefined;
            throw error;
        }
    }

    async itemExists(path) {
        return (await this.getItem(path)) !== undefined;
    }

    // ------------------------------------------------------------------
    // Creating
    // ------------------------------------------------------------------
    async createItem(name, type, content = null) {
        const endpoint = type === 'folder' ? '/api/folder' : '/api/file';
        const item = await apiFetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: this.currentPath, name }),
        });

        // Creating a file with initial content: stream it up as a real body.
        if (content) {
            const blob = content instanceof Blob ? content : new Blob([content]);
            await this.uploadFile(new File([blob], name), { overwrite: true });
            return this.getItem(joinPath(this.currentPath, name));
        }

        return item;
    }

    /**
     * Upload a File/Blob with progress reporting.
     *
     * Uses XMLHttpRequest rather than fetch because only XHR exposes upload
     * progress events, which matter a lot for multi-gigabyte video.
     */
    uploadFile(file, { onProgress, overwrite = false, path = this.currentPath } = {}) {
        return new Promise((resolve, reject) => {
            const form = new FormData();
            form.append('file', file, file.name);
            form.append('path', path);
            form.append('name', file.name);

            const request = new XMLHttpRequest();
            request.open('POST', `/api/upload?overwrite=${overwrite ? '1' : '0'}`);
            request.withCredentials = true;

            if (onProgress) {
                request.upload.onprogress = (event) => {
                    if (event.lengthComputable) {
                        onProgress({
                            loaded: event.loaded,
                            total: event.total,
                            fraction: event.loaded / event.total,
                        });
                    }
                };
            }

            request.onload = () => {
                let body = {};
                try {
                    body = JSON.parse(request.responseText);
                } catch {
                    body = {};
                }

                if (request.status === 401 && body.auth_required) {
                    reject(new AuthRequiredError(body.error));
                } else if (request.status >= 200 && request.status < 300) {
                    resolve(body);
                } else {
                    reject(new ApiError(body.error || `Upload failed (${request.status})`, request.status));
                }
            };

            request.onerror = () => reject(new ApiError('Network error during upload', 0));
            request.onabort = () => reject(new ApiError('Upload cancelled', 0));
            request.send(form);
        });
    }

    // ------------------------------------------------------------------
    // Mutating
    // ------------------------------------------------------------------
    async deleteItem(path) {
        return apiFetch(`/api/files?path=${encodePath(path)}`, { method: 'DELETE' });
    }

    async renameItem(oldPath, newName) {
        const item = await this.getItem(oldPath);
        if (!item) throw new ApiError('Item not found', 404);
        const newPath = joinPath(item.parent_path, newName);
        return this.moveItem(oldPath, newPath);
    }

    async moveItem(sourcePath, targetPath) {
        return apiFetch('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: sourcePath, to: targetPath }),
        });
    }

    async copyItem(sourcePath, targetPath) {
        return apiFetch('/api/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: sourcePath, to: targetPath }),
        });
    }

    // ------------------------------------------------------------------
    // Clipboard
    // ------------------------------------------------------------------
    copyToClipboard(item, cut = false) {
        this.clipboard = { item, operation: cut ? 'cut' : 'copy' };
    }

    async paste() {
        if (!this.clipboard) return null;

        const { item, operation } = this.clipboard;

        if (operation === 'cut') {
            const destination = joinPath(this.currentPath, item.name);
            // Pasting into the folder it already lives in is a no-op.
            const result = destination === item.path
                ? item
                : await this.moveItem(item.path, destination);
            this.clipboard = null;
            return result;
        }

        // Let the server pick a non-colliding name, so pasting twice works.
        return apiFetch('/api/duplicate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: item.path, parent: this.currentPath }),
        });
    }

    // ------------------------------------------------------------------
    // URLs for previews and downloads
    // ------------------------------------------------------------------
    rawUrl(path, { download = false } = {}) {
        return `/api/raw?path=${encodePath(path)}${download ? '&download=1' : ''}`;
    }

    thumbnailUrl(path, size = 320) {
        // The server varies its ETag by file mtime, so no cache-busting param
        // is needed here.
        return `/api/thumbnail?path=${encodePath(path)}&size=${size}`;
    }

    /** Fetch a file's bytes as a blob URL (used for previews and downloads). */
    async fetchObjectUrl(path) {
        const response = await fetch(this.rawUrl(path), { credentials: 'same-origin' });
        if (response.status === 401) throw new AuthRequiredError();
        if (!response.ok) throw new ApiError(`Could not load file (${response.status})`, response.status);

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        this._objectUrls.push(url);
        return url;
    }

    /** Fetch a text file's contents for the code/text preview. */
    async fetchText(path) {
        const response = await fetch(this.rawUrl(path), { credentials: 'same-origin' });
        if (response.status === 401) throw new AuthRequiredError();
        if (!response.ok) throw new ApiError(`Could not read file (${response.status})`, response.status);
        return response.text();
    }

    releaseObjectUrls() {
        this._objectUrls.forEach((url) => URL.revokeObjectURL(url));
        this._objectUrls = [];
    }

    async downloadFile(item) {
        const url = await this.fetchObjectUrl(item.path);
        const link = document.createElement('a');
        link.href = url;
        link.download = item.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // ------------------------------------------------------------------
    // Sharing
    // ------------------------------------------------------------------
    async generateShareLink(item, days = 7) {
        const share = await apiFetch('/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: item.path, days }),
        });
        return share.url;
    }
}

/** Join a parent path and a name into an API path. */
export function joinPath(parent, name) {
    const clean = (parent || '').replace(/^\/+|\/+$/g, '');
    return clean ? `${clean}/${name}` : name;
}

/** Basename of an API path — the fragment used for display. */
export function baseName(path) {
    const clean = (path || '').replace(/\/+$/, '');
    return clean.split('/').pop() || '';
}

export default FileManager;
