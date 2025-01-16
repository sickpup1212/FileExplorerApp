// Main application initialization
class App {
    constructor() {
        this.fileManager = null;
        this.uiManager = null;
        this.dragDropManager = null;
        this.init();
    }

    init() {
        // Initialize file manager
        this.fileManager = new FileManager();

        // Wait for IndexedDB to be ready
        this.fileManager.db?.addEventListener('success', () => {
            // Initialize UI manager once database is ready
            this.uiManager = new UIManager(this.fileManager);
            
            // Initialize drag and drop manager
            this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);
            
            // Bind global navigation function
            window.navigateTo = this.navigateTo.bind(this);
            
            // Initial content load
            this.loadInitialContent();
        });

        // Global error handler
        window.onerror = (message, source, lineno, colno, error) => {
            console.error('Global error:', error);
            this.uiManager?.showError('An unexpected error occurred');
        };

        // Handle keyboard shortcuts globally
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
    }

    async loadInitialContent() {
        try {
            await this.uiManager.refreshContent();
        } catch (error) {
            console.error('Error loading initial content:', error);
            this.uiManager.showError('Failed to load content');
        }
    }

    async navigateTo(path) {
        try {
            this.uiManager.showLoading(true);
            this.fileManager.currentPath = path;
            await this.uiManager.refreshContent();
            this.uiManager.updateBreadcrumb();
        } catch (error) {
            console.error('Navigation error:', error);
            this.uiManager.showError('Failed to navigate to folder');
        } finally {
            this.uiManager.showLoading(false);
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
