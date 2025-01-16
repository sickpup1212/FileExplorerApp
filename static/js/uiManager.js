class UIManager {
    constructor(fileManager) {
        this.fileManager = fileManager;
        this.selectedItems = new Set();
        this.viewMode = 'grid';
        
        this.initializeUI();
        this.bindEvents();
    }

    initializeUI() {
        feather.replace();
        this.updateBreadcrumb();
        this.toggleViewMode(this.viewMode);
    }

    bindEvents() {
        // Toolbar buttons
        document.getElementById('newFolderBtn').onclick = () => this.createFolder();
        document.getElementById('newFileBtn').onclick = () => this.createFile();
        document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
        document.getElementById('deleteBtn').onclick = () => this.deleteSelected();
        document.getElementById('downloadBtn').onclick = () => this.downloadSelected();
        document.getElementById('cutBtn').onclick = () => this.cutSelected();
        document.getElementById('copyBtn').onclick = () => this.copySelected();
        document.getElementById('pasteBtn').onclick = () => this.paste();

        // View toggle
        document.getElementById('listViewBtn').onclick = () => this.toggleViewMode('list');
        document.getElementById('gridViewBtn').onclick = () => this.toggleViewMode('grid');

        // File input
        document.getElementById('fileInput').onchange = (e) => this.handleFileUpload(e);

        // Context menu
        document.addEventListener('click', () => this.hideContextMenu());
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
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
        div.oncontextmenu = (e) => this.showContextMenu(e, item);

        feather.replace();
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
            jpeg: 'image',
            png: 'image',
            gif: 'image',
            mp4: 'video',
            mp3: 'music',
            zip: 'package'
        };
        return icons[ext] || 'file';
    }

    showContextMenu(e, item) {
        e.preventDefault();
        
        const menu = document.getElementById('contextMenu');
        menu.style.display = 'block';
        menu.style.left = `${e.pageX}px`;
        menu.style.top = `${e.pageY}px`;

        const actions = menu.querySelectorAll('[data-action]');
        actions.forEach(action => {
            action.onclick = () => this.handleContextMenuAction(action.dataset.action, item);
        });
    }

    hideContextMenu() {
        document.getElementById('contextMenu').style.display = 'none';
    }

    async handleContextMenuAction(action, item) {
        this.hideContextMenu();
        
        switch (action) {
            case 'open':
                this.handleItemDoubleClick(item);
                break;
            case 'rename':
                await this.renameItem(item);
                break;
            case 'copy':
                this.fileManager.copyToClipboard(item, false);
                break;
            case 'cut':
                this.fileManager.copyToClipboard(item, true);
                break;
            case 'delete':
                await this.deleteItem(item);
                break;
            case 'download':
                this.downloadItem(item);
                break;
        }
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
                reader.readAsDataURL(file);
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

    // Additional methods for handling item selection, keyboard shortcuts, etc.
    // would go here...
}

export default UIManager;
