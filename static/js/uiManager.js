class UIManager {
    constructor(fileManager) {
        this.fileManager = fileManager;
        this.selectedItems = new Set();
        this.viewMode = 'grid';
        this.currentZoom = 1;
        this.isPanning = false;
        this.startPanX = 0;
        this.startPanY = 0;
        this.translateX = 0;
        this.translateY = 0;

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
        document.addEventListener('click', () => this.hideContextMenu());

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
                case 'edit':
                    if (item.type === 'file') {
                        const textFileExtensions = ['txt', 'js', 'py', 'html', 'css', 'json', 'xml', 'md', 'csv', 'log', 'sh', 'java', 'cpp', 'c', 'h', 'hpp'];
                        const ext = item.name.split('.').pop().toLowerCase();
                        if (textFileExtensions.includes(ext)) {
                            window.location.href = `/editor?file=${encodeURIComponent(item.path)}`;
                        }
                    }
                    break;
                case 'rename':
                    const newName = prompt('Enter new name:', item.name);
                    if (newName) { await this.fileManager.renameItem(item.path, newName); await this.refreshContent(); }
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
                case 'share':
                    if (item.type === 'file') {
                        const shareId = await this.fileManager.generateShareLink(item);
                        const shareLink = `${window.location.origin}/share/${shareId}`;
                        this.showShareDialog(shareLink);
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

        // Update mobile edit button visibility
        this.updateMobileEditButton();
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
        const previewFileName = document.getElementById('previewFileName');
        const previewFileInfo = document.getElementById('previewFileInfo');
        const downloadPreviewBtn = document.getElementById('downloadPreviewBtn');

        // Reset zoom and pan
        this.currentZoom = 1;
        this.translateX = 0;
        this.translateY = 0;

        previewContent.innerHTML = '';
        previewFileName.textContent = file.name;
        previewFileInfo.textContent = this.formatFileInfo(file);

        // Show preview panel and overlay
        previewPanel.style.display = 'block';
        const overlay = document.createElement('div');
        overlay.className = 'preview-overlay';
        document.body.appendChild(overlay);
        overlay.style.display = 'block';

        // Close preview when clicking overlay or close button
        const closePreview = () => {
            previewPanel.style.display = 'none';
            overlay.remove();
            document.removeEventListener('keydown', this.handleKeyboardShortcuts);
        };

        overlay.onclick = closePreview;
        document.getElementById('closePreview').onclick = closePreview;

        downloadPreviewBtn.onclick = () => {
            const link = document.createElement('a');
            link.href = file.content;
            link.download = file.name;
            link.click();
        };

        const ext = file.name.split('.').pop().toLowerCase();

        switch (true) {
            case ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext):
                this.previewImage(file, previewContent);
                break;
            case ['js', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'h', 'hpp'].includes(ext):
                this.previewCode(file, previewContent, ext);
                break;
            case ['txt', 'md', 'csv'].includes(ext):
                this.previewText(file, previewContent);
                break;
            case ext === 'pdf':
                this.previewPDF(file, previewContent);
                break;
            case ['mp4', 'webm'].includes(ext):
                this.previewVideo(file, previewContent);
                break;
            case ['mp3', 'wav'].includes(ext):
                this.previewAudio(file, previewContent);
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
        }

        // Add keyboard shortcuts for zoom
        document.addEventListener('keydown', this.handleKeyboardShortcuts);
    }

    previewImage(file, container) {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'preview-image-container';

        const img = document.createElement('img');
        img.src = file.content;
        img.className = 'preview-image';

        // Create zoom controls
        const zoomControls = document.createElement('div');
        zoomControls.className = 'zoom-controls';
        zoomControls.innerHTML = `
            <button class="btn btn-sm btn-light" id="zoomOutBtn">
                <i data-feather="zoom-out"></i>
            </button>
            <span class="zoom-percentage">100%</span>
            <button class="btn btn-sm btn-light" id="zoomInBtn">
                <i data-feather="zoom-in"></i>
            </button>
            <button class="btn btn-sm btn-light" id="zoomFitBtn">
                <i data-feather="maximize-2"></i>
            </button>
        `;

        img.onload = () => {
            this.setupImageControls(img, imageContainer, zoomControls);
        };

        img.onerror = () => {
            console.error('Failed to load image:', file.name);
            container.innerHTML = `
                <div class="preview-unsupported">
                    <i data-feather="image"></i>
                    <p>Failed to load image: ${file.name}</p>
                </div>
            `;
            feather.replace();
        };

        imageContainer.appendChild(img);
        container.appendChild(imageContainer);
        container.appendChild(zoomControls);
        feather.replace();
    }

    setupImageControls(img, container, zoomControls) {
        const zoomInBtn = zoomControls.querySelector('#zoomInBtn');
        const zoomOutBtn = zoomControls.querySelector('#zoomOutBtn');
        const zoomFitBtn = zoomControls.querySelector('#zoomFitBtn');
        const zoomText = zoomControls.querySelector('.zoom-percentage');

        // Initialize pan functionality
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let translateX = 0;
        let translateY = 0;

        const updateTransform = () => {
            img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${this.currentZoom})`;
            zoomText.textContent = `${Math.round(this.currentZoom * 100)}%`;
        };

        const zoom = (delta, centerX = container.clientWidth / 2, centerY = container.clientHeight / 2) => {
            const oldZoom = this.currentZoom;
            this.currentZoom = Math.max(0.1, Math.min(5, this.currentZoom + delta));

            // Adjust position to zoom towards mouse position
            const imageRect = img.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();

            const mouseX = centerX - containerRect.left;
            const mouseY = centerY - containerRect.top;

            translateX += (mouseX - translateX) * (1 - this.currentZoom / oldZoom);
            translateY += (mouseY - translateY) * (1 - this.currentZoom / oldZoom);

            updateTransform();
        };

        // Mouse wheel zoom
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            zoom(delta, e.clientX, e.clientY);
        });

        // Pan functionality
        container.addEventListener('mousedown', (e) => {
            isDragging = true;
            container.classList.add('panning');
            startX = e.clientX - translateX;
            startY = e.clientY - translateY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            translateX = e.clientX - startX;
            translateY = e.clientY - startY;
            updateTransform();
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            container.classList.remove('panning');
        });

        // Zoom buttons
        zoomInBtn.onclick = () => zoom(0.1);
        zoomOutBtn.onclick = () => zoom(-0.1);
        zoomFitBtn.onclick = () => {
            this.currentZoom = 1;
            translateX = 0;
            translateY = 0;
            updateTransform();
        };

        // Keyboard shortcuts
        this.handleKeyboardShortcuts = (e) => {
            if (e.key === '=' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                zoom(0.1);
            } else if (e.key === '-' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                zoom(-0.1);
            } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.currentZoom = 1;
                translateX = 0;
                translateY = 0;
                updateTransform();
            }
        };

        // Initial transform
        updateTransform();
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