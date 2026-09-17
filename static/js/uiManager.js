/**
 * UIManager renders the explorer and drives the toolbar.
 *
 * It talks only to FileManager, so it does not care whether bytes come from
 * IndexedDB (the old behaviour) or the server API (now).
 */

import FileManager, { AuthRequiredError, joinPath } from './fileManager.js';

const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg'];
const VIDEO_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
const CODE_EXT = ['js', 'mjs', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'h', 'hpp', 'ts', 'tsx', 'sh', 'yml', 'yaml', 'toml', 'sql', 'rb', 'go', 'rs'];
const TEXT_EXT = ['txt', 'md', 'csv', 'log', 'ini', 'cfg', 'env'];

/** Human-readable byte size. Uses the real byte count from the server. */
function formatFileSize(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function extensionOf(name) {
    return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

class UIManager {
    constructor(fileManager) {
        this.fileManager = fileManager;
        this.selectedItems = new Set();
        this.viewMode = 'grid';
        this.currentItems = [];
        this._shareModal = null;

        this.initializeUI();
        this.bindEvents();
    }

    initializeUI() {
        if (window.feather) window.feather.replace();
        this.toggleViewMode(this.viewMode);
    }

    bindEvents() {
        const on = (id, handler) => {
            const element = document.getElementById(id);
            if (element) element.onclick = handler;
        };

        on('newFolderBtn', () => this.createFolder());
        on('newFileBtn', () => this.createFile());
        on('uploadBtn', () => document.getElementById('fileInput').click());
        on('deleteBtn', () => this.deleteSelected());
        on('downloadBtn', () => this.downloadSelected());
        on('cutBtn', () => this.cutSelected());
        on('copyBtn', () => this.copySelected());
        on('pasteBtn', () => this.paste());
        on('listViewBtn', () => this.toggleViewMode('list'));
        on('gridViewBtn', () => this.toggleViewMode('grid'));
        on('closePreview', () => this.closePreview());

        const fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.onchange = (event) => this.handleFileUpload(event.target.files);

        document.addEventListener('click', () => this.hideContextMenu());
    }

    // ------------------------------------------------------------------
    // Creating
    // ------------------------------------------------------------------
    async createFolder() {
        const name = prompt('Enter folder name:');
        if (!name) return;
        await this.run(async () => {
            await this.fileManager.createItem(name, 'folder');
        });
    }

    async createFile() {
        const name = prompt('Enter file name:');
        if (!name) return;
        await this.run(async () => {
            await this.fileManager.createItem(name, 'file');
        });
    }

    // ------------------------------------------------------------------
    // Upload
    // ------------------------------------------------------------------
    async handleFileUpload(fileList) {
        const files = Array.from(fileList || []);
        const input = document.getElementById('fileInput');
        if (input) input.value = '';
        if (!files.length) return;

        for (const file of files) {
            try {
                await this.uploadWithProgress(file);
            } catch (error) {
                this.showError(`${file.name}: ${error.message}`);
            }
        }

        await this.refreshContent();
    }

    async uploadWithProgress(file) {
        const label = `${file.name} (${formatFileSize(file.size)})`;
        this.showProgress(label, 0);

        try {
            await this.fileManager.uploadFile(file, {
                onProgress: ({ fraction }) => this.showProgress(label, fraction),
            });
            this.showProgress(label, 1);
            this.hideProgress();
        } catch (error) {
            this.hideProgress();
            throw error;
        }
    }

    // ------------------------------------------------------------------
    // Selection actions
    // ------------------------------------------------------------------
    async deleteSelected() {
        if (!this.selectedItems.size) return;
        if (!confirm(`Delete ${this.selectedItems.size} item(s)? This cannot be undone.`)) return;

        await this.run(async () => {
            for (const item of this.selectedItems) {
                await this.fileManager.deleteItem(item.path);
            }
            this.selectedItems.clear();
        });
    }

    async downloadSelected() {
        for (const item of this.selectedItems) {
            if (item.type !== 'file') continue;
            await this.run(async () => {
                await this.fileManager.downloadFile(item);
            });
        }
    }

    cutSelected() {
        if (this.selectedItems.size !== 1) return;
        const [item] = this.selectedItems;
        this.fileManager.copyToClipboard(item, true);
        this.showSuccess(`Cut "${item.name}"`);
    }

    copySelected() {
        if (this.selectedItems.size !== 1) return;
        const [item] = this.selectedItems;
        this.fileManager.copyToClipboard(item, false);
        this.showSuccess(`Copied "${item.name}"`);
    }

    async paste() {
        const result = await this.run(() => this.fileManager.paste());
        if (result) this.showSuccess(`Pasted "${result.name}"`);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    updateBreadcrumb() {
        const breadcrumb = document.getElementById('breadcrumb');
        if (!breadcrumb) return;

        const current = this.fileManager.currentPath || '';
        const parts = current ? current.split('/') : [];
        const segments = [{ label: 'Root', path: '' }];

        parts.forEach((part, index) => {
            segments.push({ label: part, path: parts.slice(0, index + 1).join('/') });
        });

        breadcrumb.innerHTML = segments
            .map((segment, index) => {
                const isLast = index === segments.length - 1;
                const label = this.escapeHtml(segment.label);
                const link = isLast
                    ? `<span class="text-body">${label}</span>`
                    : `<a href="#" data-path="${this.escapeHtml(segment.path)}">${label}</a>`;
                return `<li class="breadcrumb-item">${link}</li>`;
            })
            .join('');

        breadcrumb.querySelectorAll('a[data-path]').forEach((anchor) => {
            anchor.onclick = (event) => {
                event.preventDefault();
                this.navigateTo(anchor.dataset.path);
            };
        });
    }

    async navigateTo(path) {
        this.fileManager.currentPath = path;
        this.selectedItems.clear();
        await this.refreshContent();
        window.history.pushState({ path }, '', `#${path}`);
    }

    async refreshContent() {
        const container = document.getElementById('filesContainer');
        if (!container) return;

        let items;
        try {
            items = await this.fileManager.getItems();
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                document.dispatchEvent(new CustomEvent('auth:required'));
                return;
            }
            this.showError(error.message);
            return;
        }

        container.innerHTML = '';
        this.selectedItems.clear();
        this.currentItems = items;
        this.updateBreadcrumb();

        if (!items.length) {
            container.innerHTML = '<div class="empty-folder">This folder is empty</div>';
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => fragment.appendChild(this.createItemElement(item)));
        container.appendChild(fragment);

        if (window.feather) window.feather.replace();

        // DragDropManager listens for this to tag the freshly rendered items.
        container.dispatchEvent(new CustomEvent('files:rendered', { bubbles: true }));
    }

    createItemElement(item) {
        const div = document.createElement('div');
        div.className = `file-item ${item.type}`;
        div.dataset.path = item.path;

        const iconName = item.type === 'folder' ? 'folder' : this.getFileIcon(item.name);
        const extension = extensionOf(item.name);
        const canThumbnail = item.type === 'file'
            && (IMAGE_EXT.includes(extension) || VIDEO_EXT.includes(extension));

        if (canThumbnail) {
            const thumb = document.createElement('img');
            thumb.className = 'file-item-thumb';
            thumb.loading = 'lazy';
            thumb.alt = '';
            if (VIDEO_EXT.includes(extension)) thumb.classList.add('is-video');
            thumb.src = this.fileManager.thumbnailUrl(item.path, 320);
            // Fall back to the plain icon if the server cannot make a thumbnail.
            thumb.onerror = () => {
                thumb.replaceWith(this.createIconElement(iconName));
            };
            div.appendChild(thumb);

            if (VIDEO_EXT.includes(extension)) {
                const badge = document.createElement('div');
                badge.className = 'file-item-badge';
                badge.innerHTML = '<i data-feather="play"></i>';
                div.appendChild(badge);
            }
        } else {
            div.appendChild(this.createIconElement(iconName));
        }

        const name = document.createElement('div');
        name.className = 'file-item-name';
        name.textContent = item.name;
        name.title = item.name;
        div.appendChild(name);

        if (item.type === 'file' && item.size) {
            const meta = document.createElement('div');
            meta.className = 'file-item-meta';
            meta.textContent = formatFileSize(item.size);
            div.appendChild(meta);
        }

        div.onclick = (event) => this.handleItemClick(event, item);
        div.ondblclick = () => this.handleItemDoubleClick(item);
        div.oncontextmenu = (event) => this.showContextMenu(event, item);
        return div;
    }

    createIconElement(iconName) {
        const wrapper = document.createElement('div');
        wrapper.className = 'file-item-icon';
        wrapper.innerHTML = `<i data-feather="${iconName}"></i>`;
        return wrapper;
    }

    /** All file bytes are user-supplied, so names are inserted as text. */
    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
    }

    getFileIcon(filename) {
        const extension = extensionOf(filename);
        if (IMAGE_EXT.includes(extension)) return 'image';
        if (VIDEO_EXT.includes(extension)) return 'video';
        if (AUDIO_EXT.includes(extension)) return 'music';
        if (extension === 'pdf') return 'file-text';
        if (['doc', 'docx', 'txt', 'md'].includes(extension)) return 'file-text';
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return 'package';
        if (CODE_EXT.includes(extension)) return 'code';
        return 'file';
    }

    // ------------------------------------------------------------------
    // Context menu
    // ------------------------------------------------------------------
    showContextMenu(event, item) {
        event.preventDefault();
        this.handleItemClick(event, item);

        const menu = document.getElementById('contextMenu');
        if (!menu) return;

        menu.style.display = 'block';
        // Keep the menu on screen when opened near the right/bottom edge.
        const { offsetWidth, offsetHeight } = menu;
        const x = Math.min(event.pageX, window.scrollX + document.documentElement.clientWidth - offsetWidth - 8);
        const y = Math.min(event.pageY, window.scrollY + document.documentElement.clientHeight - offsetHeight - 8);
        menu.style.left = `${Math.max(x, 0)}px`;
        menu.style.top = `${Math.max(y, 0)}px`;

        menu.querySelectorAll('[data-action]').forEach((action) => {
            action.onclick = () => this.handleContextMenuAction(action.dataset.action, item);
        });
    }

    hideContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (menu) menu.style.display = 'none';
    }

    async handleContextMenuAction(action, item) {
        this.hideContextMenu();

        switch (action) {
            case 'open':
                await this.handleItemDoubleClick(item);
                break;

            case 'rename': {
                const newName = prompt('Enter new name:', item.name);
                if (newName && newName !== item.name) {
                    await this.run(() => this.fileManager.renameItem(item.path, newName));
                }
                break;
            }

            case 'copy':
                this.fileManager.copyToClipboard(item, false);
                this.showSuccess(`Copied "${item.name}"`);
                break;

            case 'cut':
                this.fileManager.copyToClipboard(item, true);
                this.showSuccess(`Cut "${item.name}"`);
                break;

            case 'delete':
                if (confirm(`Delete "${item.name}"? This cannot be undone.`)) {
                    await this.run(() => this.fileManager.deleteItem(item.path));
                }
                break;

            case 'download':
                if (item.type === 'file') {
                    await this.run(() => this.fileManager.downloadFile(item));
                }
                break;

            case 'share':
                if (item.type === 'file') {
                    const url = await this.run(() => this.fileManager.generateShareLink(item));
                    if (url) this.showShareDialog(url);
                } else {
                    this.showError('Only files can be shared');
                }
                break;

            default:
                break;
        }
    }

    // ------------------------------------------------------------------
    // Preview
    // ------------------------------------------------------------------
    async handleItemDoubleClick(item) {
        if (item.type === 'folder') {
            await this.navigateTo(item.path);
        } else {
            await this.previewFile(item);
        }
    }

    closePreview() {
        const panel = document.getElementById('previewPanel');
        const content = document.getElementById('previewContent');
        if (panel) panel.style.display = 'none';
        if (content) content.innerHTML = '';
        this.fileManager.releaseObjectUrls();
    }

    async previewFile(file) {
        const panel = document.getElementById('previewPanel');
        const content = document.getElementById('previewContent');
        if (!panel || !content) return;

        this.fileManager.releaseObjectUrls();
        content.innerHTML = '';

        const nameEl = document.getElementById('previewFileName');
        const infoEl = document.getElementById('previewFileInfo');
        if (nameEl) nameEl.textContent = file.name;
        if (infoEl) {
            const modified = new Date(file.modified).toLocaleString();
            infoEl.textContent = `${formatFileSize(file.size)} • Modified ${modified}`;
        }

        const downloadBtn = document.getElementById('downloadPreviewBtn');
        if (downloadBtn) downloadBtn.onclick = () => this.fileManager.downloadFile(file).catch((e) => this.showError(e.message));

        panel.style.display = 'block';
        this.showZoomControls(false);

        const extension = extensionOf(file.name);

        try {
            if (IMAGE_EXT.includes(extension)) await this.previewImage(file, content);
            else if (VIDEO_EXT.includes(extension)) this.previewVideo(file, content);
            else if (AUDIO_EXT.includes(extension)) this.previewAudio(file, content);
            else if (extension === 'pdf') await this.previewPdf(file, content);
            else if (CODE_EXT.includes(extension)) await this.previewCode(file, content, extension);
            else if (TEXT_EXT.includes(extension)) await this.previewText(file, content);
            else this.previewUnsupported(file, content);
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                document.dispatchEvent(new CustomEvent('auth:required'));
                return;
            }
            this.showError(error.message);
        }

        if (window.feather) window.feather.replace();
    }

    showZoomControls(show) {
        ['zoomInBtn', 'zoomOutBtn'].forEach((id) => {
            const button = document.getElementById(id);
            if (button) button.style.display = show ? 'block' : 'none';
        });
    }

    async previewImage(file, container) {
        const url = await this.fileManager.fetchObjectUrl(file.path);
        const wrapper = document.createElement('div');
        wrapper.className = 'preview-image-container';

        const img = document.createElement('img');
        img.src = url;
        img.className = 'preview-image';
        img.alt = file.name;

        wrapper.appendChild(img);
        container.appendChild(wrapper);

        let zoom = 1;
        this.showZoomControls(true);
        const apply = (factor) => {
            zoom = Math.min(Math.max(zoom * factor, 0.2), 8);
            img.style.transform = `scale(${zoom})`;
        };
        const zoomIn = document.getElementById('zoomInBtn');
        const zoomOut = document.getElementById('zoomOutBtn');
        if (zoomIn) zoomIn.onclick = () => apply(1.2);
        if (zoomOut) zoomOut.onclick = () => apply(1 / 1.2);
    }

    /**
     * Video and audio point straight at the streaming endpoint rather than
     * downloading a blob, so the browser can issue Range requests and start
     * playback immediately even for a multi-gigabyte file.
     */
    previewVideo(file, container) {
        const video = document.createElement('video');
        video.src = this.fileManager.rawUrl(file.path);
        video.className = 'preview-video';
        video.controls = true;
        video.preload = 'metadata';
        video.playsInline = true;
        container.appendChild(video);
    }

    previewAudio(file, container) {
        const audio = document.createElement('audio');
        audio.src = this.fileManager.rawUrl(file.path);
        audio.className = 'preview-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        container.appendChild(audio);
    }

    async previewPdf(file, container) {
        const url = await this.fileManager.fetchObjectUrl(file.path);
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'preview-pdf';
        iframe.title = file.name;
        container.appendChild(iframe);
    }

    async previewCode(file, container, language) {
        const text = await this.fileManager.fetchText(file.path);
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const code = document.createElement('code');
        code.className = `language-${language}`;
        code.textContent = text;
        pre.appendChild(code);
        container.appendChild(pre);
        if (window.hljs) window.hljs.highlightElement(code);
    }

    async previewText(file, container) {
        const text = await this.fileManager.fetchText(file.path);
        const pre = document.createElement('pre');
        pre.className = 'preview-text';
        pre.textContent = text;
        container.appendChild(pre);
    }

    previewUnsupported(file, container) {
        const wrapper = document.createElement('div');
        wrapper.className = 'preview-unsupported';
        wrapper.innerHTML = `
            <i data-feather="file-text"></i>
            <p>No in-browser preview for this file type.</p>
        `;

        const button = document.createElement('button');
        button.className = 'btn btn-primary';
        button.textContent = 'Download';
        button.onclick = () => this.fileManager.downloadFile(file).catch((e) => this.showError(e.message));

        wrapper.appendChild(button);
        container.appendChild(wrapper);
    }

    // ------------------------------------------------------------------
    // View mode
    // ------------------------------------------------------------------
    toggleViewMode(mode) {
        this.viewMode = mode;
        const container = document.getElementById('filesContainer');
        if (container) container.className = `files-container ${mode}-view`;

        const listBtn = document.getElementById('listViewBtn');
        const gridBtn = document.getElementById('gridViewBtn');
        if (listBtn) listBtn.classList.toggle('active', mode === 'list');
        if (gridBtn) gridBtn.classList.toggle('active', mode === 'grid');
    }

    // ------------------------------------------------------------------
    // Selection
    // ------------------------------------------------------------------
    handleItemClick(event, item) {
        if (!event.ctrlKey && !event.metaKey) {
            this.selectedItems.clear();
            document.querySelectorAll('.file-item.selected').forEach((element) => {
                element.classList.remove('selected');
            });
        }

        const element = event.currentTarget;
        element.classList.toggle('selected');

        if (element.classList.contains('selected')) {
            this.selectedItems.add(item);
        } else {
            this.selectedItems.delete(item);
        }
    }

    /** Select every item currently rendered (Ctrl+A). */
    selectAll() {
        document.querySelectorAll('.file-item').forEach((element) => {
            element.classList.add('selected');
        });
        this.selectedItems = new Set(this.currentItems);
    }

    // ------------------------------------------------------------------
    // Feedback
    // ------------------------------------------------------------------
    showError(message) {
        const alert = document.getElementById('errorAlert');
        if (!alert) return;
        alert.textContent = message;
        alert.style.display = 'block';
        clearTimeout(this._errorTimer);
        this._errorTimer = setTimeout(() => {
            alert.style.display = 'none';
        }, 5000);
    }

    showSuccess(message) {
        const toast = document.createElement('div');
        toast.className = 'alert alert-success alert-dismissible fade show position-fixed bottom-0 end-0 m-3';
        toast.setAttribute('role', 'alert');
        toast.style.zIndex = '2100';

        const text = document.createElement('span');
        text.textContent = message;
        toast.appendChild(text);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-close';
        close.setAttribute('aria-label', 'Close');
        close.onclick = () => toast.remove();
        toast.appendChild(close);

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    showProgress(label, fraction) {
        let container = document.getElementById('uploadProgress');
        if (!container) {
            container = document.createElement('div');
            container.id = 'uploadProgress';
            container.className = 'upload-progress';
            container.innerHTML = `
                <div class="upload-progress-label" id="uploadProgressLabel"></div>
                <div class="progress"><div class="progress-bar" id="uploadProgressBar"></div></div>
            `;
            document.body.appendChild(container);
        }

        const labelEl = document.getElementById('uploadProgressLabel');
        const bar = document.getElementById('uploadProgressBar');
        if (labelEl) labelEl.textContent = `Uploading ${label}`;
        if (bar) {
            const percent = Math.round(fraction * 100);
            bar.style.width = `${percent}%`;
            bar.textContent = `${percent}%`;
        }
    }

    hideProgress() {
        const container = document.getElementById('uploadProgress');
        if (container) container.remove();
    }

    showShareDialog(shareLink) {
        const dialogEl = document.getElementById('shareDialog');
        if (!dialogEl || !window.bootstrap) {
            // Fall back to a prompt so sharing still works without Bootstrap.
            window.prompt('Share link:', shareLink);
            return;
        }

        const input = document.getElementById('shareLink');
        if (input) input.value = shareLink;

        const copyButton = document.getElementById('copyShareLink');
        if (copyButton) {
            copyButton.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(shareLink);
                    this.showSuccess('Link copied to clipboard');
                } catch {
                    input.select();
                    document.execCommand('copy');
                    this.showSuccess('Link copied to clipboard');
                }
            };
        }

        try {
            this._shareModal = window.bootstrap.Modal.getOrCreateInstance(dialogEl);
            this._shareModal.show();
        } catch {
            window.prompt('Share link:', shareLink);
        }
    }

    /** Run an async action, routing errors to the alert bar. Returns a result. */
    async run(action) {
        try {
            return await action();
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                document.dispatchEvent(new CustomEvent('auth:required'));
                return null;
            }
            this.showError(error.message);
            return null;
        }
    }
}

export { formatFileSize, extensionOf };
export default UIManager;
