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
        div.oncontextmenu = (e) => this.showContextMenu(e, item);

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
        this.handleItemClick(e, item);

        const menu = document.getElementById('contextMenu');
        menu.style.display = 'block';
        menu.style.left = `${e.pageX}px`;
        menu.style.top = `${e.pageY}px`;

        const actions = menu.querySelectorAll('[data-action]');
        actions.forEach(action => {
            const actionType = action.dataset.action;
            action.onclick = () => this.handleContextMenuAction(actionType, item);
        });
    }

    hideContextMenu() {
        document.getElementById('contextMenu').style.display = 'none';
    }

    async handleContextMenuAction(action, item) {
        this.hideContextMenu();

        try {
            switch (action) {
                case 'open':
                    await this.handleItemDoubleClick(item);
                    break;
                case 'rename':
                    const newName = prompt('Enter new name:', item.name);
                    if (newName) {
                        await this.fileManager.renameItem(item.path, newName);
                        await this.refreshContent();
                    }
                    break;
                case 'copy':
                    this.fileManager.copyToClipboard(item, false);
                    break;
                case 'cut':
                    this.fileManager.copyToClipboard(item, true);
                    break;
                case 'delete':
                    if (confirm(`Delete ${item.name}?`)) {
                        await this.fileManager.deleteItem(item.path);
                        await this.refreshContent();
                    }
                    break;
                case 'download':
                    if (item.type === 'file' && item.content) {
                        const link = document.createElement('a');
                        link.href = item.content;
                        link.download = item.name;
                        link.click();
                    }
                    break;
            }
        } catch (error) {
            this.showError(error.message);
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
    }

    async handleItemDoubleClick(item) {
        if (item.type === 'folder') {
            this.fileManager.currentPath = item.path;
            await this.refreshContent();
            this.updateBreadcrumb();
        } else {
            this.previewFile(item);
        }
    }

    previewFile(file) {
        const previewPanel = document.getElementById('previewPanel');
        const previewContent = document.getElementById('previewContent');
        const closePreview = document.getElementById('closePreview');
        const previewFileName = document.getElementById('previewFileName');
        const previewFileInfo = document.getElementById('previewFileInfo');
        const downloadPreviewBtn = document.getElementById('downloadPreviewBtn');
        const zoomInBtn = document.getElementById('zoomInBtn');
        const zoomOutBtn = document.getElementById('zoomOutBtn');

        // Clear previous content
        previewContent.innerHTML = '';

        // Set file info
        previewFileName.textContent = file.name;
        previewFileInfo.textContent = this.formatFileInfo(file);

        // Show preview panel
        previewPanel.style.display = 'block';

        // Handle close button
        closePreview.onclick = () => {
            previewPanel.style.display = 'none';
        };

        // Handle download button
        downloadPreviewBtn.onclick = () => {
            const link = document.createElement('a');
            link.href = file.content;
            link.download = file.name;
            link.click();
        };

        const ext = file.name.split('.').pop().toLowerCase();

        // Initialize zoom level for images
        let zoomLevel = 1;

        switch (true) {
            case ['jpg', 'jpeg', 'png', 'gif'].includes(ext):
                this.previewImage(file, previewContent, zoomLevel);
                // Show zoom controls
                zoomInBtn.style.display = 'block';
                zoomOutBtn.style.display = 'block';

                zoomInBtn.onclick = () => {
                    zoomLevel *= 1.2;
                    this.updateImageZoom(previewContent.querySelector('.preview-image'), zoomLevel);
                };

                zoomOutBtn.onclick = () => {
                    zoomLevel /= 1.2;
                    this.updateImageZoom(previewContent.querySelector('.preview-image'), zoomLevel);
                };
                break;

            case ['js', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'h', 'hpp'].includes(ext):
                this.previewCode(file, previewContent, ext);
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
                break;

            case ['txt', 'md', 'csv'].includes(ext):
                this.previewText(file, previewContent);
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
                break;

            case ext === 'pdf':
                this.previewPDF(file, previewContent);
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
                break;

            case ['mp4', 'webm'].includes(ext):
                this.previewVideo(file, previewContent);
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
                break;

            case ['mp3', 'wav'].includes(ext):
                this.previewAudio(file, previewContent);
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
                break;

            default:
                previewContent.innerHTML = `
                    <div class="preview-unsupported">
                        <i data-feather="file-text"></i>
                        <p>Preview not available for ${file.name}</p>
                        <button class="btn btn-primary" onclick="window.open('${file.content}', '_blank')">
                            Open File
                        </button>
                    </div>
                `;
                feather.replace();
                zoomInBtn.style.display = 'none';
                zoomOutBtn.style.display = 'none';
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

    updateImageZoom(img, zoomLevel) {
        img.style.transform = `scale(${zoomLevel})`;
    }

    previewImage(file, container, zoomLevel) {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'preview-image-container';

        const img = document.createElement('img');
        img.src = file.content;
        img.className = 'preview-image';
        img.style.transform = `scale(${zoomLevel})`;

        imageContainer.appendChild(img);
        container.appendChild(imageContainer);
    }

    previewCode(file, container, language) {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const code = document.createElement('code');
        code.className = `language-${language}`;

        if (file.content.startsWith('data:')) {
            fetch(file.content)
                .then(response => response.text())
                .then(text => {
                    code.textContent = text;
                    hljs.highlightElement(code);
                });
        } else {
            code.textContent = file.content;
            hljs.highlightElement(code);
        }

        pre.appendChild(code);
        container.appendChild(pre);
    }

    previewText(file, container) {
        if (file.content.startsWith('data:')) {
            fetch(file.content)
                .then(response => response.text())
                .then(text => {
                    const pre = document.createElement('pre');
                    pre.className = 'preview-text';
                    pre.textContent = text;
                    container.appendChild(pre);
                });
        } else {
            const pre = document.createElement('pre');
            pre.className = 'preview-text';
            pre.textContent = file.content;
            container.appendChild(pre);
        }
    }

    previewPDF(file, container) {
        const iframe = document.createElement('iframe');
        iframe.src = file.content;
        iframe.className = 'preview-pdf';
        container.appendChild(iframe);
    }

    previewVideo(file, container) {
        const video = document.createElement('video');
        video.src = file.content;
        video.className = 'preview-video';
        video.controls = true;
        container.appendChild(video);
    }

    previewAudio(file, container) {
        const audio = document.createElement('audio');
        audio.src = file.content;
        audio.className = 'preview-audio';
        audio.controls = true;
        container.appendChild(audio);
    }
}

export default UIManager;