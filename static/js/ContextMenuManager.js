class ContextMenuManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
        this.fileManager = uiManager.fileManager;
    }

    showContextMenu(e, item) {
        e.preventDefault();
        this.uiManager.handleItemClick(e, item);
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
                    await this.uiManager.handleItemDoubleClick(item);
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
                    if (newName) {
                        await this.fileManager.renameItem(item.path, newName);
                        await this.uiManager.refreshContent();
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
                        await this.uiManager.refreshContent();
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
                        this.uiManager.showShareDialog(shareLink);
                    }
                    break;
            }
        } catch (error) {
            this.uiManager.showError(error.message);
        }
    }
}

export default ContextMenuManager;
