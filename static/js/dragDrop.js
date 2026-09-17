/**
 * DragDropManager handles dropping OS files onto the explorer and moving
 * items between folders by dragging.
 */

class DragDropManager {
    constructor(fileManager, uiManager) {
        this.fileManager = fileManager;
        this.uiManager = uiManager;
        this.initializeDragDrop();
    }

    initializeDragDrop() {
        const filesContainer = document.getElementById('filesContainer');
        if (!filesContainer) return;

        ['dragenter', 'dragover'].forEach((type) => {
            filesContainer.addEventListener(type, (e) => this.handleDragOver(e));
        });
        filesContainer.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        filesContainer.addEventListener('drop', (e) => this.handleDrop(e));

        // Every refresh rebuilds the item elements, so re-tag them whenever the
        // UI manager reports a new render.
        filesContainer.addEventListener('files:rendered', () => this.markDraggable());
        this.markDraggable();
    }

    /** Make current file/folder elements draggable and wire their handlers. */
    markDraggable() {
        document.querySelectorAll('.file-item').forEach((item) => {
            if (item.dataset.draggableBound) return;
            item.dataset.draggableBound = '1';
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', (e) => this.handleDragStart(e));
            item.addEventListener('dragend', (e) => this.handleDragEnd(e));
        });
    }

    handleDragStart(e) {
        const item = e.target.closest('.file-item');
        if (!item) return;
        item.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.dataset.path);
        e.dataTransfer.effectAllowed = 'move';
    }

    handleDragEnd(e) {
        const item = e.target.closest('.file-item');
        if (item) item.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();

        // DataTransfer types are not readable during dragover, so the drop
        // effect is set optimistically and corrected on drop.
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
        if (target) target.classList.remove('drag-over');
    }

    async handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();

        const target = this.getDropTarget(e.target);
        if (target) target.classList.remove('drag-over');

        // Desktop files dropped in: stream them to the server.
        if (e.dataTransfer.files.length > 0) {
            await this.uiManager.handleFileUpload(e.dataTransfer.files);
            return;
        }

        const sourcePath = e.dataTransfer.getData('text/plain');
        if (!sourcePath) return;

        const targetPath = target?.dataset.path ?? this.fileManager.currentPath;
        await this.moveItem(sourcePath, targetPath);
    }

    async moveItem(sourcePath, targetPath) {
        const sourceItem = await this.fileManager.getItem(sourcePath);
        if (!sourceItem) {
            this.uiManager.showError('Source item no longer exists');
            return;
        }

        const targetItem = targetPath === sourcePath ? null : await this.fileManager.getItem(targetPath);
        const destination = targetItem?.type === 'folder'
            ? `${targetPath}/${sourceItem.name}`
            : `${this.fileManager.currentPath}/${sourceItem.name}`;

        if (destination === sourcePath) return; // dropped onto itself

        await this.uiManager.run(async () => {
            await this.fileManager.moveItem(sourcePath, destination);
        });
    }

    getDropTarget(element) {
        let node = element;
        while (node && !node.classList?.contains('file-item')) {
            node = node.parentElement;
        }
        return node;
    }
}

export default DragDropManager;
