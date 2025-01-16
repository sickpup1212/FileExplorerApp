// Main application initialization
import FileManager from './fileManager.js';
import UIManager from './uiManager.js';
import DragDropManager from './dragDrop.js';

class App {
    constructor() {
        this.fileManager = null;
        this.uiManager = null;
        this.dragDropManager = null;
        this.init();
    }

    async init() {
        try {
            // Initialize file manager first
            this.fileManager = new FileManager();

            // Wait for file manager to initialize
            await new Promise(resolve => {
                const checkInit = () => {
                    if (this.fileManager.db) {
                        resolve();
                    } else {
                        setTimeout(checkInit, 100);
                    }
                };
                checkInit();
            });

            // Initialize UI manager
            this.uiManager = new UIManager(this.fileManager);

            // Initialize drag and drop manager
            this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);

            // Bind global navigation function
            window.navigateTo = this.navigateTo.bind(this);

            // Initialize Feather icons
            feather.replace();

            // Initial content load
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
            this.uiManager.showError('Failed to load content');
        }
    }

    showError(message) {
        const errorAlert = document.getElementById('errorAlert');
        if (errorAlert) {
            errorAlert.textContent = message;
            errorAlert.style.display = 'block';
            setTimeout(() => errorAlert.style.display = 'none', 3000);
        }
    }

    async navigateTo(path) {
        try {
            this.fileManager.currentPath = path;
            await this.uiManager.refreshContent();
            this.uiManager.updateBreadcrumb();
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
                this.uiManager.renameSelected();
                break;

            case e.key === 'Escape':
                e.preventDefault();
                this.uiManager.clearSelection();
                this.uiManager.hideContextMenu();
                break;

            case ctrlKey && e.key === 'n':
                e.preventDefault();
                this.uiManager.createFolder();
                break;

            case ctrlKey && e.key === 'u':
                e.preventDefault();
                document.getElementById('fileInput').click();
                break;
        }
    }
}

// Initialize the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});

// Prevent default browser drag and drop behavior
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Handle back/forward browser navigation
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.path) {
        window.app.navigateTo(e.state.path);
    }
});

// Update browser history when navigating
const pushState = (path) => {
    const state = { path };
    window.history.pushState(state, '', `#${path}`);
};

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