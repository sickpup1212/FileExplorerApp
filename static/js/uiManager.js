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
        this.initializePreviewResizer();
    }

    /**
     * Let the preview panel be resized by dragging its left edge.
     *
     * The width is applied as a CSS variable on :root, which is what the panel
     * reads, and remembered in localStorage so it survives a reload.
     */
    initializePreviewResizer() {
        const handle = document.getElementById('previewResizer');
        const panel = document.getElementById('previewPanel');
        if (!handle || !panel) return;

        const MIN_WIDTH = 240;
        const STORAGE_KEY = 'previewPanelWidth';

        const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 200);

        const applyWidth = (width) => {
            const clamped = Math.min(Math.max(width, MIN_WIDTH), maxWidth());
            document.documentElement.style.setProperty('--preview-panel-width', `${clamped}px`);
            return clamped;
        };

        // Restore a previously chosen width.
        const saved = parseInt(window.localStorage.getItem(STORAGE_KEY) || '', 10);
        if (!Number.isNaN(saved)) applyWidth(saved);

        let dragging = false;

        const onMove = (event) => {
            if (!dragging) return;
            // The panel is anchored to the right edge, so width is measured
            // from the pointer to the right edge of the window.
            applyWidth(window.innerWidth - event.clientX);
            event.preventDefault();
        };

        const stop = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing-preview');
            const current = parseInt(
                getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width'),
                10
            );
            if (!Number.isNaN(current)) {
                window.localStorage.setItem(STORAGE_KEY, String(current));
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', stop);
            window.removeEventListener('pointercancel', stop);
        };

        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            dragging = true;
            handle.classList.add('dragging');
            document.body.classList.add('resizing-preview');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', stop);
            window.addEventListener('pointercancel', stop);
            event.preventDefault();
        });

        // Keyboard support: the handle is focusable and reports as a separator.
        handle.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 40 : 10;
            const current = parseInt(
                getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width'),
                10
            ) || 400;

            if (event.key === 'ArrowLeft') {
                applyWidth(current + step);
            } else if (event.key === 'ArrowRight') {
                applyWidth(current - step);
            } else if (event.key === 'Home') {
                applyWidth(MIN_WIDTH);
            } else {
                return;
            }

            event.preventDefault();
            const settled = parseInt(
                getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width'),
                10
            );
            window.localStorage.setItem(STORAGE_KEY, String(settled));
        });

        // A resize can leave the stored width wider than the window.
        window.addEventListener('resize', () => {
            const current = parseInt(
                getComputedStyle(document.documentElement).getPropertyValue('--preview-panel-width'),
                10
            );
            if (!Number.isNaN(current)) applyWidth(current);
        });
    }

    bindEvents() {
        // Some controls exist twice: once in the desktop toolbar and once in
        // the mobile sidebar. Bind and style all copies, not just the first.
        const on = (id, handler) => {
            document.querySelectorAll(`#${id}`).forEach((element) => {
                element.onclick = handler;
            });
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

        // Mobile aliases. The view mode is shared state, so these only need to
        // call the same handler; the sidebar toggle opens the drawer that
        // replaced the toolbar.
        on('listViewBtnMobile', () => this.toggleViewMode('list'));
        on('gridViewBtnMobile', () => this.toggleViewMode('grid'));
        on('sidebarToggleMobile', () => {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) sidebar.classList.add('show');
        });

        const fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.onchange = (event) => this.handleFileUpload(event.target.files);

        // Tapping the dimmed backdrop closes the menu; the click handler below
        // would otherwise fight with the menu's own clicks on touch.
        const backdrop = document.getElementById('menuBackdrop');
        if (backdrop) backdrop.onclick = () => this.hideContextMenu();

        document.addEventListener('click', (event) => {
            // Ignore clicks originating inside the open menu, so tapping an
            // action does not close the menu before the action fires.
            if (event.target.closest && event.target.closest('#contextMenu')) return;
            this.hideContextMenu();
        });
    }

    /** True on touch-first devices, where the context menu becomes a sheet. */
    isMobileLayout() {
        return window.matchMedia('(max-width: 768px)').matches;
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

        // A guest must not see the path above the folder they unlocked, so
        // their breadcrumb starts at that folder and has no way up.
        const guestRoot = this.fileManager.isGuest ? this.fileManager.guestRoot : null;

        let segments;
        if (guestRoot) {
            const rootParts = guestRoot.split('/');
            const tail = parts.slice(rootParts.length);
            segments = [
                { label: rootParts[rootParts.length - 1] || 'Shared folder', path: guestRoot },
                ...tail.map((part, index) => ({
                    label: part,
                    path: [...rootParts, ...tail.slice(0, index + 1)].join('/'),
                })),
            ];
        } else {
            segments = [{ label: 'Root', path: '' }];
            parts.forEach((part, index) => {
                segments.push({ label: part, path: parts.slice(0, index + 1).join('/') });
            });
        }

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

    async navigateTo(path, { updateUrl = true } = {}) {
        this.fileManager.currentPath = path;
        this.selectedItems.clear();
        await this.refreshContent();
        // A guest arriving from /explorer/<path> should keep that URL so a
        // refresh puts them back inside their shared folder.
        if (updateUrl) window.history.pushState({ path }, '', `#${path}`);
    }

    async refreshContent() {
        const container = document.getElementById('filesContainer');
        if (!container) return;

        let listing;
        try {
            listing = await this.fileManager.getListing();
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                // The session expired or was never valid: go back to the login
                // screen rather than showing a broken explorer.
                window.location.href = '/login';
                return;
            }
            this.showError(error.message);
            return;
        }

        const items = listing.items || [];
        container.innerHTML = '';
        this.selectedItems.clear();
        this.currentItems = items;
        this.updateBreadcrumb();
        this.applyPermissionState();

        // At the root, describe the layout rather than showing a bare folder
        // that offers nothing: this is the first thing a new user sees.
        if (this.fileManager.atRoot && !this.fileManager.isGuest) {
            container.appendChild(this.createLandingPanel());
        }

        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-folder';
            empty.textContent = this.fileManager.isGuest
                ? 'This shared folder is empty'
                : 'This folder is empty';
            container.appendChild(empty);
            container.dispatchEvent(new CustomEvent('files:rendered', { bubbles: true }));
            return;
        }

        const fragment = document.createDocumentFragment();
        items.forEach((item) => fragment.appendChild(this.createItemElement(item)));
        container.appendChild(fragment);

        if (window.feather) window.feather.replace();

        // DragDropManager listens for this to tag the freshly rendered items.
        container.dispatchEvent(new CustomEvent('files:rendered', { bubbles: true }));
    }

    /**
     * The landing panel shown at the storage root.
     *
     * The root is a read-only container, so without this a new user would see
     * one inert folder and no indication of where their own space is.
     */
    createLandingPanel() {
        const panel = document.createElement('div');
        panel.className = 'landing-panel';

        const title = document.createElement('h6');
        title.textContent = 'Your file spaces';
        panel.appendChild(title);

        const makeCard = (label, description, path, icon) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'landing-card';

            const iconEl = document.createElement('i');
            iconEl.setAttribute('data-feather', icon);
            card.appendChild(iconEl);

            const text = document.createElement('div');
            const heading = document.createElement('strong');
            heading.textContent = label;
            const sub = document.createElement('span');
            sub.textContent = description;
            text.appendChild(heading);
            text.appendChild(sub);
            card.appendChild(text);

            card.onclick = () => this.navigateTo(path);
            return card;
        };

        const shared = this.fileManager.shared;
        const personal = this.fileManager.personal;
        if (shared) {
            panel.appendChild(makeCard('Shared', 'Visible to every account', shared, 'users'));
        }
        if (personal) {
            panel.appendChild(makeCard('My files', 'Private to you', personal, 'user'));
        }

        const note = document.createElement('p');
        note.className = 'landing-note';
        note.textContent =
            'This root folder holds the two spaces above and a welcome document. '
            + 'You can upload files here, but folders belong inside Shared or My files.';
        panel.appendChild(note);

        return panel;
    }

    /**
     * Reflect the server's permissions in the toolbar.
     *
     * Actions the principal cannot perform are disabled rather than hidden, so
     * the interface does not reflow as you move between folders.
     */
    applyPermissionState() {
        const root = this.fileManager.atRoot;
        const writable = this.fileManager.canWrite();
        const guest = this.fileManager.isGuest;

        // Each control may exist twice (toolbar and mobile sidebar), so set the
        // state on every copy.
        const setDisabled = (id, disabled, title) => {
            document.querySelectorAll(`#${id}`).forEach((element) => {
                element.disabled = disabled;
                if (title) element.title = title;
            });
        };

        // At the root, uploading and creating files is allowed (that is where a
        // welcome document lives), but creating folders is not - that would
        // turn the root into a second place to organise content.
        const readOnlyTitle = writable ? null : 'Read-only for you';
        ['newFileBtn', 'uploadBtn', 'pasteBtn', 'deleteBtn'].forEach((id) => {
            setDisabled(id, !writable, readOnlyTitle);
        });

        const folderBlocked = root && !this.fileManager.canCreateFolderAtRoot;
        setDisabled(
            'newFolderBtn',
            !writable || folderBlocked,
            folderBlocked ? 'Create folders inside Shared or your own folder' : readOnlyTitle
        );

        const sidebarUser = document.getElementById('sidebarUser');
        if (sidebarUser) {
            const who = this.fileManager.principal || {};
            const label = guest
                ? 'Shared folder (read-only)'
                : `Signed in as ${who.username || 'unknown'}`;
            sidebarUser.textContent = label;
            sidebarUser.classList.toggle('readonly', guest || !writable);
        }

        this.renderHomeButtons();
    }

    /** Quick links to Shared and the user's own space. */
    renderHomeButtons() {
        const holder = document.getElementById('homeButtons');
        if (!holder) return;

        const shared = this.fileManager.shared;
        const personal = this.fileManager.personal;
        if (this.fileManager.isGuest || (!shared && !personal)) {
            holder.innerHTML = '';
            return;
        }

        const makeButton = (label, path, icon) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-light';
            button.title = path;
            button.innerHTML = `<i data-feather="${icon}"></i> <span>${label}</span>`;
            button.onclick = () => this.navigateTo(path);
            return button;
        };

        holder.innerHTML = '';
        if (shared) holder.appendChild(makeButton('Shared', shared, 'users'));
        // The label is friendlier than the path, which is 'users/<name>'.
        if (personal) holder.appendChild(makeButton('My files', personal, 'user'));
        if (window.feather) window.feather.replace();
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

        // A locked folder: the contents are hidden until its PIN is entered.
        if (item.has_pin) {
            const lock = document.createElement('div');
            lock.className = 'file-item-lock';
            lock.title = 'PIN protected - click to enter the PIN';
            lock.innerHTML = '<i data-feather="lock"></i>';
            div.appendChild(lock);
            div.classList.add('is-locked');
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
        } else if (item.type === 'folder' && item.writable === false) {
            const meta = document.createElement('div');
            meta.className = 'file-item-meta';
            meta.textContent = 'read-only';
            div.appendChild(meta);
        }

        div.onclick = (event) => this.handleItemClick(event, item);
        div.ondblclick = () => this.handleItemDoubleClick(item);
        div.oncontextmenu = (event) => this.showContextMenu(event, item);

        // Touch devices get an explicit trigger: a long-press is neither
        // discoverable nor reliable across mobile browsers.
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'file-item-menu';
        trigger.setAttribute('aria-label', `Actions for ${item.name}`);
        trigger.innerHTML = '<i data-feather="more-vertical"></i>';
        trigger.onclick = (event) => {
            event.stopPropagation();
            this.openItemMenu(item, trigger);
        };
        div.appendChild(trigger);

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

        const writable = item.writable !== false && this.fileManager.canWrite(item.path);
        const isFolder = item.type === 'folder';
        const guest = this.fileManager.isGuest;
        // At the root nothing may be renamed or deleted: those need write
        // access to the root directory, which is read-only by design.
        const atRoot = this.fileManager.atRoot;

        // Show only actions that make sense here, so a read-only guest or a
        // non-writable folder does not offer operations that would fail.
        const allowed = {
            open: true,
            rename: writable && !atRoot,
            protect: isFolder && writable && !atRoot && !item.pin_protected,
            unprotect: isFolder && writable && !atRoot && item.pin_protected,
            share: !isFolder && !guest,
            copy: !guest,
            cut: writable && !guest && !atRoot,
            delete: writable && !atRoot,
            download: !isFolder,
        };

        menu.querySelectorAll('[data-action]').forEach((action) => {
            const visible = allowed[action.dataset.action] === true;
            action.style.display = visible ? 'flex' : 'none';
            if (visible) {
                action.onclick = () => this.handleContextMenuAction(action.dataset.action, item);
            }
        });

        menu.style.display = 'block';

        // On a phone there is no right-click, so the menu becomes a bottom
        // sheet: full width, thumb-reachable, with a backdrop to dismiss it.
        if (this.isMobileLayout()) {
            menu.classList.add('as-sheet');
            menu.style.left = '';
            menu.style.top = '';
            const backdrop = document.getElementById('menuBackdrop');
            if (backdrop) backdrop.style.display = 'block';
            return;
        }

        menu.classList.remove('as-sheet');
        // Keep the menu on screen when opened near the right/bottom edge.
        const { offsetWidth, offsetHeight } = menu;
        const x = Math.min(event.pageX, window.scrollX + document.documentElement.clientWidth - offsetWidth - 8);
        const y = Math.min(event.pageY, window.scrollY + document.documentElement.clientHeight - offsetHeight - 8);
        menu.style.left = `${Math.max(x, 0)}px`;
        menu.style.top = `${Math.max(y, 0)}px`;
    }

    hideContextMenu() {
        const menu = document.getElementById('contextMenu');
        if (menu) {
            menu.style.display = 'none';
            menu.classList.remove('as-sheet');
        }
        const backdrop = document.getElementById('menuBackdrop');
        if (backdrop) backdrop.style.display = 'none';
    }

    /**
     * Open the action sheet for an item without a right-click.
     *
     * Shown as a small "..." button on each item when the layout is touch
     * sized, since a long-press is not discoverable and does not reliably
     * produce a contextmenu event on every mobile browser.
     */
    openItemMenu(item, trigger) {
        const rect = trigger.getBoundingClientRect();
        const synthetic = {
            preventDefault() {},
            pageX: rect.left + rect.width / 2 + window.scrollX,
            pageY: rect.bottom + window.scrollY,
            currentTarget: trigger.closest('.file-item'),
        };
        this.showContextMenu(synthetic, item);
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

            case 'protect':
                this.openPinDialog(item);
                break;

            case 'unprotect':
                if (confirm(`Remove PIN protection from "${item.name}"?`)) {
                    const result = await this.run(() => this.fileManager.unprotectFolder(item));
                    if (result) {
                        this.showSuccess(`"${item.name}" is no longer PIN protected`);
                    }
                }
                break;

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
                    await this.runReadOnly(() => this.fileManager.downloadFile(item));
                }
                break;

            case 'share':
                if (item.type === 'file') {
                    const url = await this.runReadOnly(() => this.fileManager.generateShareLink(item));
                    if (url) {
                        this.showShareDialog(
                            url,
                            'Anyone with this link can download the file. It expires in 7 days.',
                            'Share file'
                        );
                    }
                } else {
                    this.showError('Use "Set folder PIN" to share a folder');
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

        // Reflect the active mode on every copy of the control, including the
        // mobile bar's aliases.
        const setActive = (id, active) => {
            document.querySelectorAll(`#${id}`).forEach((element) => {
                element.classList.toggle('active', active);
            });
        };
        setActive('listViewBtn', mode === 'list');
        setActive('gridViewBtn', mode === 'grid');
        setActive('listViewBtnMobile', mode === 'list');
        setActive('gridViewBtnMobile', mode === 'grid');
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

    showShareDialog(shareLink, hint = '', title = 'Share') {
        const dialogEl = document.getElementById('shareDialog');
        if (!dialogEl || !window.bootstrap) {
            // Fall back to a prompt so sharing still works without Bootstrap.
            window.prompt(`${title}:`, shareLink);
            return;
        }

        const titleEl = dialogEl.querySelector('.modal-title');
        if (titleEl) titleEl.textContent = title;

        const labelEl = document.getElementById('shareLinkLabel');
        if (labelEl) labelEl.textContent = 'Link';

        const hintEl = document.getElementById('shareHint');
        if (hintEl) hintEl.textContent = hint;

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
            window.prompt(`${title}:`, shareLink);
        }
    }

    /**
     * Ask for a PIN and protect the folder with it.
     *
     * On success the link and the PIN are shown together, because both are
     * needed by whoever receives access.
     */
    openPinDialog(item) {
        const dialogEl = document.getElementById('pinDialog');
        if (!dialogEl || !window.bootstrap) {
            const pin = window.prompt(`Set a PIN for "${item.name}":`);
            if (pin) this.applyFolderPin(item, pin);
            return;
        }

        const nameEl = document.getElementById('pinFolderName');
        if (nameEl) nameEl.textContent = `Folder: ${item.name}`;

        const pinInput = document.getElementById('newPin');
        const errorEl = document.getElementById('pinError');
        if (pinInput) pinInput.value = '';
        if (errorEl) errorEl.textContent = '';

        const saveButton = document.getElementById('savePinBtn');
        if (saveButton) {
            saveButton.onclick = async () => {
                const pin = (pinInput?.value || '').trim();
                if (!pin) {
                    if (errorEl) errorEl.textContent = 'Enter a PIN.';
                    return;
                }
                const result = await this.applyFolderPin(item, pin);
                if (result) {
                    window.bootstrap.Modal.getOrCreateInstance(dialogEl).hide();
                }
            };
        }

        try {
            window.bootstrap.Modal.getOrCreateInstance(dialogEl).show();
            setTimeout(() => pinInput?.focus(), 200);
        } catch {
            const pin = window.prompt(`Set a PIN for "${item.name}":`);
            if (pin) this.applyFolderPin(item, pin);
        }
    }

    async applyFolderPin(item, pin) {
        const record = await this.run(() => this.fileManager.protectFolder(item, pin));
        if (!record) return null;

        // Show the link and the PIN together: the recipient needs both, and
        // the server never returns the PIN for display.
        this.showShareDialog(
            record.url,
            `PIN: ${pin}  —  share this link and PIN together. The recipient gets read-only access to "${item.name}" only.`,
            'Folder PIN set'
        );
        await this.refreshContent();
        return record;
    }

    /**
     * Run an async action, routing errors to the alert bar. Returns a result.
     *
     * Pass ``{ refresh: false }`` for actions that only read or download. Every
     * other use re-renders the listing afterwards, so a new folder, upload or
     * rename appears immediately instead of leaving the user to wonder whether
     * it worked and refresh the page by hand.
     */
    async run(action, { refresh = true } = {}) {
        try {
            const result = await action();
            if (refresh) await this.refreshContent();
            return result;
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                document.dispatchEvent(new CustomEvent('auth:required'));
                return null;
            }
            this.showError(error.message);
            return null;
        }
    }

    /** For actions that only read or download, so no re-render is needed. */
    runReadOnly(action) {
        return this.run(action, { refresh: false });
    }
}

export { formatFileSize, extensionOf };
export default UIManager;
