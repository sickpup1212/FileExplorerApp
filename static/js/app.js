import FileManager from './fileManager.js';
import UIManager from './uiManager.js';
import DragDropManager from './dragDrop.js';

class App {
    constructor() {
        this.fileManager = null;
        this.uiManager = null;
        this.dragDropManager = null;
        this.isPicker = false;
    }

    async init() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            this.isPicker = urlParams.get('from') === 'editor';

            // Initialize file manager first
            this.fileManager = new FileManager();
            await this.fileManager.init();

            // Initialize UI manager with file manager instance and app instance
            this.uiManager = new UIManager(this.fileManager, this);
            await this.uiManager.refreshContent();

            // Initialize drag and drop manager
            this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);

            // Bind global navigation function
            window.navigateTo = this.navigateTo.bind(this);

            // Initialize keyboard shortcuts
            document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

            // Load initial content
            await this.loadInitialContent();

            // Initialize context menu handlers
            this.initializeContextMenuHandlers();
        } catch (error) {
            console.error('Initialization error:', error);
            this.showError('Failed to initialize application');
        }
    }

    async loadInitialContent() {
        try {
            await this.uiManager.refreshContent();
        } catch (error) {
            console.error('Error loading initial content:', error);
            this.showError('Failed to load content');
        }
    }

    showError(message) {
        if (this.uiManager) {
            this.uiManager.showError(message);
        } else {
            const errorAlert = document.getElementById('errorAlert');
            if (errorAlert) {
                errorAlert.textContent = message;
                errorAlert.style.display = 'block';
                setTimeout(() => errorAlert.style.display = 'none', 3000);
            }
        }
    }

    async navigateTo(path) {
        try {
            this.fileManager.currentPath = path;
            sessionStorage.setItem('lastPath', path); // Store the last path
            await this.uiManager.refreshContent();
            this.uiManager.updateBreadcrumb();
            // Update browser history
            const state = { path };
            window.history.pushState(state, '', `#${path}`);
        } catch (error) {
            console.error('Navigation error:', error);
            this.showError('Failed to navigate to folder');
        }
    }

    initializeContextMenuHandlers() {
        // Remove click handler from parent "Open/Edit" item
        const editParentItem = document.querySelector('.context-menu-item[data-action="edit"]');
        if (editParentItem) {
            editParentItem.addEventListener('click', (e) => {
                // Stop propagation to prevent hiding the context menu
                e.stopPropagation();
            });
        }

        // Handle submenu items
        document.querySelectorAll('.context-submenu .context-menu-item').forEach(item => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent parent handlers from firing
                const action = e.currentTarget.getAttribute('data-action');

                // Get the currently selected file from UIManager
                const selectedItems = Array.from(this.uiManager.selectedItems);
                if (!selectedItems || selectedItems.length === 0) {
                    this.showError('No file selected');
                    return;
                }
                const selectedFile = selectedItems[0];

                switch (action) {
                    case 'openTextEditor':
                        // Text editor functionality - only for text files
                        const textMimeType = selectedFile.type;
                        if (textMimeType && textMimeType.startsWith('text/')) {
                            window.location.href = `/editor?file=${selectedFile.path}`;
                        } else {
                            this.showError('Only text files can be opened in the Text Editor');
                        }
                        break;

                    case 'openDocChatFiles':
                        try {
                            const response = await fetch('/api/doc-chat/add-file', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ path: selectedFile.path })
                            });

                            if (!response.ok) {
                                const error = await response.json();
                                throw new Error(error.error || 'Failed to add file to Doc Chat');
                            }

                            // Redirect to Doc Chat page after successful addition
                            window.location.href = '/document-chat';
                        } catch (error) {
                            this.showError(error.message);
                        }
                        break;

                    case 'openDocChatEdit':
                        try {
                            const response = await fetch('/api/doc-chat/get-text-content', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({ path: selectedFile.path })
                            });

                            if (!response.ok) {
                                const error = await response.json();
                                throw new Error(error.error || 'Failed to get text content');
                            }

                            const result = await response.json();

                            // Store content in sessionStorage for Doc Chat to use
                            sessionStorage.setItem('docChatEditContent', result.content);

                            // Redirect to Doc Chat page
                            window.location.href = '/document-chat';
                        } catch (error) {
                            this.showError(error.message);
                        }
                        break;
                }
            });
        });
    }

    handleKeyboardShortcuts(e) {
        // Only handle shortcuts if UI manager is initialized
        if (!this.uiManager) return;

        // Prevent shortcuts when typing in input fields
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const ctrlKey = e.ctrlKey || e.metaKey;

        switch (true) {
            case ctrlKey && e.key === 'a':
                e.preventDefault();
                this.uiManager.selectAll();
                break;

            case ctrlKey && e.key === 'c':
                e.preventDefault();
                this.uiManager.copySelected();
                break;

            case ctrlKey && e.key === 'x':
                e.preventDefault();
                this.uiManager.cutSelected();
                break;

            case ctrlKey && e.key === 'v':
                e.preventDefault();
                this.uiManager.paste();
                break;

            case e.key === 'Delete':
                e.preventDefault();
                this.uiManager.deleteSelected();
                break;

            case e.key === 'F2':
                e.preventDefault();
                if (this.uiManager.selectedItems.size === 1) {
                    const item = Array.from(this.uiManager.selectedItems)[0];
                    this.uiManager.handleContextMenuAction('rename', item);
                }
                break;

            case e.key === 'Escape':
                e.preventDefault();
                this.uiManager.selectedItems.clear();
                this.uiManager.hideContextMenu();
                document.querySelectorAll('.file-item.selected').forEach(el => {
                    el.classList.remove('selected');
                });
                break;
        }
    }
}

// Initialize the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
    window.app = app;
});

// Handle browser navigation
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.path) {
        window.app.navigateTo(e.state.path);
    }
});

// Handle initial hash route
window.addEventListener('load', () => {
    const hash = window.location.hash.slice(1);
    if (hash) {
        window.app.navigateTo(hash);
    }
});

// Expose managers globally for debugging
window.DEBUG = {
    getApp: () => window.app,
    getFileManager: () => window.app?.fileManager,
    getUIManager: () => window.app?.uiManager,
    getDragDropManager: () => window.app?.dragDropManager
};