import PreviewManager from './PreviewManager.js';
import ContextMenuManager from './ContextMenuManager.js';

class UIManager {
    constructor(fileManager, app) {
        this.fileManager = fileManager;
        this.app = app;
        this.selectedItems = new Set();
        this.viewMode = 'grid';
        this.previewManager = new PreviewManager(this);
        this.contextMenuManager = new ContextMenuManager(this);

        this.initializeUI();
        this.bindEvents();
        this.updateMobileEditButton();
    }

    initializeUI() {
        feather.replace();
        this.updateBreadcrumb();
        this.toggleViewMode(this.viewMode);
    }

    bindEvents() {
        document.getElementById('newFolderBtn').onclick = () => this.createFolder();
        document.getElementById('newFileBtn').onclick = () => this.createFile();
        document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
        document.getElementById('deleteBtn').onclick = () => this.deleteSelected();
        document.getElementById('downloadBtn').onclick = () => this.downloadSelected();
        document.getElementById('cutBtn').onclick = () => this.cutSelected();
        document.getElementById('copyBtn').onclick = () => this.copySelected();
        document.getElementById('pasteBtn').onclick = () => this.paste();
        document.getElementById('listViewBtn').onclick = () => this.toggleViewMode('list');
        document.getElementById('gridViewBtn').onclick = () => this.toggleViewMode('grid');
        document.getElementById('fileInput').onchange = (e) => this.handleFileUpload(e);
        document.addEventListener('click', () => this.contextMenuManager.hideContextMenu());

        // Add mobile edit button handler
        const mobileEditBtn = document.getElementById('mobileEditBtn');
        if (mobileEditBtn) {
            mobileEditBtn.onclick = () => this.handleMobileEdit();
        }
    }

    async createFolder() {
        const name = prompt('Enter folder name:');
        if (!name) return;

        try {
            await this.fileManager.createItem(name, 'folder');
            await this.refreshContent();
        } catch (error) {
            this.showError(error.message);
        }
    }

    async createFile() {
        const name = prompt('Enter file name:');
        if (!name) return;

        try {
            await this.fileManager.createItem(name, 'file', '');
            await this.refreshContent();
        } catch (error) {
            this.showError(error.message);
        }
    }

    async deleteSelected() {
        if (this.selectedItems.size === 0) return;

        if (confirm(`Delete ${this.selectedItems.size} item(s)?`)) {
            try {
                for (const item of this.selectedItems) {
                    await this.fileManager.deleteItem(item.path);
                }
                this.selectedItems.clear();
                await this.refreshContent();
            } catch (error) {
                this.showError(error.message);
            }
        }
    }

    async downloadSelected() {
        for (const item of this.selectedItems) {
            if (item.type === 'file' && item.content) {
                const link = document.createElement('a');
                link.href = item.content;
                link.download = item.name;
                link.click();
            }
        }
    }

    cutSelected() {
        if (this.selectedItems.size === 1) {
            const [item] = this.selectedItems;
            this.fileManager.copyToClipboard(item, true);
        }
    }

    copySelected() {
        if (this.selectedItems.size === 1) {
            const [item] = this.selectedItems;
            this.fileManager.copyToClipboard(item, false);
        }
    }

    async paste() {
        try {
            await this.fileManager.paste();
            await this.refreshContent();
        } catch (error) {
            this.showError(error.message);
        }
    }

    updateBreadcrumb() {
        const breadcrumb = document.getElementById('breadcrumb');
        const parts = this.fileManager.currentPath.split('/');
        breadcrumb.innerHTML = parts.map((part, index) => {
            const path = parts.slice(0, index + 1).join('/');
            return `
                <li class="breadcrumb-item">
                    <a href="#" onclick="navigateTo('${path}'); return false;">${part}</a>
                </li>
            `;
        }).join('');
    }

    async refreshContent() {
        const container = document.getElementById('filesContainer');
        const items = await this.fileManager.getItems(this.fileManager.currentPath);
        container.innerHTML = '';
        items.sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'folder' ? -1 : 1;
        });
        items.forEach(item => {
            const element = this.createItemElement(item);
            container.appendChild(element);
        });
        feather.replace();
    }

    createItemElement(item) {
        const div = document.createElement('div');
        div.className = `file-item ${item.type}`;
        div.dataset.path = item.path;
        const icon = item.type === 'folder' ? 'folder' : this.getFileIcon(item.name);
        div.innerHTML = `
            <div class="file-item-icon">
                <i data-feather="${icon}"></i>
            </div>
            <div class="file-item-name">${item.name}</div>
        `;
        div.onclick = (e) => this.handleItemClick(e, item);
        div.ondblclick = () => this.handleItemDoubleClick(item);
        div.oncontextmenu = (e) => this.contextMenuManager.showContextMenu(e, item);
        return div;
    }

    getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const icons = {
            pdf: 'file-text',
            doc: 'file-text',
            docx: 'file-text',
            txt: 'file-text',
            jpg: 'image',
            webp: 'image',
            jpeg: 'image',
            png: 'image',
            gif: 'image',
            mp4: 'video',
            mp3: 'music',
            zip: 'package'
        };
        return icons[ext] || 'file';
    }


    async handleFileUpload(event) {
        const files = event.target.files;
        for (const file of files) {
            try {
                if (file.size > this.fileManager.MAX_FILE_SIZE) {
                    throw new Error(`File ${file.name} is too large (max ${this.fileManager.MAX_FILE_SIZE / 1024 / 1024}MB)`);
                }

                const reader = new FileReader();
                reader.onload = async (e) => {
                    await this.fileManager.createItem(file.name, 'file', e.target.result);
                    await this.refreshContent();
                };
                reader.readAsArrayBuffer(file);
            } catch (error) {
                this.showError(error.message);
            }
        }
        event.target.value = '';
    }

    showError(message) {
        const alert = document.getElementById('errorAlert');
        alert.textContent = message;
        alert.style.display = 'block';
        setTimeout(() => alert.style.display = 'none', 3000);
    }

    showLoading(show = true) {
        document.getElementById('loadingOverlay').style.display = show ? 'flex' : 'none';
    }

    toggleViewMode(mode) {
        this.viewMode = mode;
        const container = document.getElementById('filesContainer');
        container.className = `files-container ${mode}-view`;
    }

    handleItemClick(e, item) {
        if (!e.ctrlKey && !e.metaKey) {
            this.selectedItems.clear();
            document.querySelectorAll('.file-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
        }

        const element = e.currentTarget;
        element.classList.toggle('selected');

        if (element.classList.contains('selected')) {
            this.selectedItems.add(item);
        } else {
            this.selectedItems.delete(item);
        }

        // Update mobile edit button visibility
        this.updateMobileEditButton();
    }

    async handleItemDoubleClick(item) {
        if (item.type === 'folder') {
            this.fileManager.currentPath = item.path;
            await this.refreshContent();
            this.updateBreadcrumb();
        } else {
            this.previewManager.previewFile(item);
        }
    }

    formatFileInfo(file) {
        const size = this.formatFileSize(file.content.length);
        const date = new Date(file.modified).toLocaleString();
        return `${size} • Modified ${date}`;
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    handleMobileEdit() {
        if (this.selectedItems.size === 1) {
            const item = Array.from(this.selectedItems)[0];
            this.handleContextMenuAction('edit', item);
        }
    }

    updateMobileEditButton() {
        const mobileEditBtn = document.getElementById('mobileEditBtn');
        if (!mobileEditBtn) return;

        if (this.selectedItems.size === 1) {
            const [item] = this.selectedItems;
            const textFileExtensions = ['txt', 'js', 'py', 'html', 'css', 'json', 'xml', 'md', 'csv', 'log', 'sh', 'java', 'cpp', 'c', 'h', 'hpp'];
            const ext = item.name.split('.').pop().toLowerCase();

            if (item.type === 'file' && textFileExtensions.includes(ext)) {
                mobileEditBtn.classList.remove('d-none');
                mobileEditBtn.classList.add('d-md-none'); // Only show on mobile
            } else {
                mobileEditBtn.classList.add('d-none');
            }
        } else {
            mobileEditBtn.classList.add('d-none');
        }
    }

    showShareDialog(shareLink) {
        const shareDialogEl = document.getElementById('shareDialog');
        const shareDialog = new bootstrap.Modal(shareDialogEl);
        const shareLinkInput = document.getElementById('shareLink');
        const copyButton = document.getElementById('copyShareLink');

        shareLinkInput.value = shareLink;

        copyButton.onclick = () => {
            shareLinkInput.select();
            navigator.clipboard.writeText(shareLinkInput.value)
                .then(() => {
                    this.showSuccess('Link copied to clipboard!');
                })
                .catch(() => {
                    shareLinkInput.select();
                    document.execCommand('copy');
                    this.showSuccess('Link copied to clipboard!');
                });
        };

        shareDialog.show();
    }

    showSuccess(message) {
        const successAlert = document.createElement('div');
        successAlert.className = 'alert alert-success alert-dismissible fade show position-fixed bottom-0 end-0 m-3';
        successAlert.setAttribute('role', 'alert');
        successAlert.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
        `;
        document.body.appendChild(successAlert);
        setTimeout(() => successAlert.remove(), 3000);
    }
}

export default UIManager;