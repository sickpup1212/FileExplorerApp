// Main application initialization
import FileManager from './fileManager.js';
import UIManager from './uiManager.js';
import DragDropManager from './dragDrop.js';

class App {
    constructor() {
        this.fileManager = null;
        this.uiManager = null;
        this.dragDropManager = null;
    }

    async init() {
        try {
            // Initialize file manager first
            this.fileManager = new FileManager();
            await this.fileManager.init();

            // Initialize UI manager with file manager instance
            this.uiManager = new UIManager(this.fileManager);
            await this.uiManager.refreshContent();

            // Initialize drag and drop manager
            this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);

            // Bind global navigation function
            window.navigateTo = this.navigateTo.bind(this);

            // Initialize keyboard shortcuts
            document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

            // Load initial content
            await this.loadInitialContent();
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

// Prevent default browser drag and drop behavior
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

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