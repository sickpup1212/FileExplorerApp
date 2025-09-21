class DragDropManager {
    constructor(fileManager, uiManager) {
        this.fileManager = fileManager;
        this.uiManager = uiManager;
        this.initializeDragDrop();
    }

    initializeDragDrop() {
        const filesContainer = document.getElementById('filesContainer');

        filesContainer.addEventListener('dragover', (e) => this.handleDragOver(e));
        filesContainer.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        filesContainer.addEventListener('drop', (e) => this.handleDrop(e));

        // Make items draggable
        this.makeItemsDraggable();
    }

    makeItemsDraggable() {
        document.querySelectorAll('.file-item').forEach(item => {
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));
        });
    }

    handleDragStart(e) {
        const item = e.target;
        item.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.dataset.path);
        e.dataTransfer.effectAllowed = 'move';
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        const target = this.getDropTarget(e.target);
        if (target && target.classList.contains('folder')) {
            target.classList.add('drag-over');
        }
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        const target = this.getDropTarget(e.target);
        if (target) {
            target.classList.remove('drag-over');
        }
    }

    async handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();

        const target = this.getDropTarget(e.target);
        if (target) {
            target.classList.remove('drag-over');
        }

        // Handle file uploads
        if (e.dataTransfer.files.length > 0) {
            await this.handleFileUpload(e.dataTransfer.files);
            return;
        }

        // Handle internal drag and drop
        const sourcePath = e.dataTransfer.getData('text/plain');
        if (!sourcePath) return;

        const targetPath = target?.dataset.path || this.fileManager.currentPath;
        await this.moveItem(sourcePath, targetPath);
    }

    async handleFileUpload(files) {
        for (const file of files) {
            try {
                if (file.size > this.fileManager.MAX_FILE_SIZE) {
                    throw new Error(`File ${file.name} is too large`);
                }

                const reader = new FileReader();
                reader.onload = async (e) => {
                    await this.fileManager.createItem(file.name, 'file', e.target.result);
                    await this.uiManager.refreshContent();
                };
                reader.readAsDataURL(file);
            } catch (error) {
                this.uiManager.showError(error.message);
            }
        }
    }

    async moveItem(sourcePath, targetPath) {
        try {
            if (sourcePath === targetPath) return;

            const sourceItem = await this.fileManager.getItem(sourcePath);
            const targetItem = await this.fileManager.getItem(targetPath);

            if (!sourceItem) throw new Error('Source item not found');

            const newPath = targetItem?.type === 'folder' 
                ? `${targetPath}/${sourceItem.name}`
                : `${this.fileManager.currentPath}/${sourceItem.name}`;

            await this.fileManager.moveItem(sourcePath, newPath);
            await this.uiManager.refreshContent();
        } catch (error) {
            this.uiManager.showError(error.message);
        }
    }

    getDropTarget(element) {
        while (element && !element.classList.contains('file-item')) {
            element = element.parentElement;
        }
        return element;
    }
}

export default DragDropManager;
