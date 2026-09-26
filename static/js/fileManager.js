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
        /** Server-reported identity and permissions for this session. */
        this.principal = null;
        /** Set when signed in as an account: where "Shared" and "My files" live. */
        this.personal = null;
        this.shared = null;
        /** For a guest who unlocked a folder: the root they may see. */
        this.guestRoot = null;
    }

    async init() {
        const status = await apiFetch('/api/auth/status');
        if (!status.authenticated) throw new AuthRequiredError();
        return status;
    }

    /** Re-read who we are and what we may do. Cheap; called on each listing. */
    async loadSession() {
        const data = await apiFetch('/api/session');
        this.principal = data.principal;
        return data.principal;
    }

    async logout() {
        await apiFetch('/api/auth/logout', { method: 'POST' });
    }

    get isGuest() {
        return !!this.principal?.is_guest;
    }

    get username() {
        return this.principal?.username || null;
    }

    /** True when browsing the storage root, which is a read-only landing area. */
    get atRoot() {
        return !this.currentPath;
    }

    /** Whether write actions should be offered at all for a path. */
    canWrite(path = this.currentPath) {
        if (!this.principal) return false;
        // The root is writable for housekeeping (a welcome document, tidying
        // loose files) but is not listed as a writable root, so fall back to
        // the explicit permission the server reports for root files.
        if (!path) return true;
        return this.principal.writable_roots.some(
            (root) => root && (path === root || path.startsWith(`${root}/`))
        );
    }

    /** Root folders are refused server-side; the menu reflects that. */
    get canCreateFolderAtRoot() {
        return this.principal?.can_create_folder_at_root === true;
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------
    async getItems(path = this.currentPath) {
        const data = await apiFetch(`/api/files?path=${encodePath(path)}`);
        // The server reports the caller's permissions with every listing, so
        // the UI never has to guess what it is allowed to enable.
        if (data.principal) this.principal = data.principal;
        if (data.personal !== undefined) this.personal = data.personal;
        if (data.shared !== undefined) this.shared = data.shared;
        if (data.guest_root !== undefined) this.guestRoot = data.guest_root;
        return data.items;
    }

    /** Full listing payload, when the caller needs the metadata too. */
    async getListing(path = this.currentPath) {
        const data = await apiFetch(`/api/files?path=${encodePath(path)}`);
        if (data.principal) this.principal = data.principal;
        if (data.personal !== undefined) this.personal = data.personal;
        if (data.shared !== undefined) this.shared = data.shared;
        if (data.guest_root !== undefined) this.guestRoot = data.guest_root;
        return data;
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

    // ------------------------------------------------------------------
    // Folder PINs
    // ------------------------------------------------------------------
    /**
     * Protect a folder with a PIN and return the link and PIN to hand over.
     *
     * The folder's owner shares this pair; the recipient gets read-only access
     * scoped to that folder and nothing else.
     */
    async protectFolder(item, pin) {
        return apiFetch('/api/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: item.path, pin }),
        });
    }

    async unprotectFolder(item) {
        return apiFetch(`/api/pin?path=${encodePath(item.path)}`, { method: 'DELETE' });
    }

    async listProtectedFolders() {
        const data = await apiFetch('/api/pins');
        return data.pins;
    }

    /** Redeem a share token plus PIN for scoped read-only access. */
    async unlockDirectory(token, pin) {
        return apiFetch('/api/pin/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, pin }),
        });
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
