// Main application initialization
import FileManager, { AuthRequiredError } from './fileManager.js';
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
            this.fileManager = new FileManager();
            await this.fileManager.init();
            await this.start();
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                // The server is the authority on this: if the session is not
                // valid, go to the login screen rather than guessing.
                window.location.href = '/login';
                return;
            }
            console.error('Initialization error:', error);
            this.showError('Failed to initialize application');
        }
    }

    async start() {
        if (this.uiManager) return;

        document.getElementById('explorer').hidden = false;

        this.uiManager = new UIManager(this.fileManager);
        this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);

        window.navigateTo = (path) => this.navigateTo(path);
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
        document.addEventListener('auth:required', () => {
            window.location.href = '/login';
        });

        this.bindLogout();

        window.addEventListener('popstate', (e) => {
            if (e.state?.path !== undefined) this.navigateTo(e.state.path);
        });

        await this.loadInitialContent();
    }

    bindLogout() {
        const button = document.getElementById('logoutBtn');
        if (!button) return;
        button.onclick = async () => {
            try {
                await this.fileManager.logout();
            } catch (error) {
                console.warn('Logout request failed; clearing the page anyway', error);
            }
            window.location.href = '/login';
        };
    }

    /**
     * Work out which folder to open first.
     *
     * A guest who redeemed a PIN lands on /explorer/<path>, a normal user may
     * have a #path deep link, and everyone else starts at the root.
     */
    async loadInitialContent() {
        try {
            // A guest who redeemed a PIN is redirected to
            // /explorer/<path with %2F separators>, so the slashes survive the
            // single path segment. Decoding once yields the storage-relative
            // path; without this the encoded form is sent back to the API and
            // the session resolves as anonymous.
            const segments = window.location.pathname.split('/').filter(Boolean);
            if (segments[0] === 'explorer' && segments.length > 1) {
                const raw = segments.slice(1).join('/');
                let target = raw;
                try {
                    target = decodeURIComponent(raw);
                } catch (error) {
                    console.warn('Could not decode explorer path, using raw value', error);
                }
                await this.uiManager.navigateTo(target, { updateUrl: false });
                return;
            }

            let hash = window.location.hash.slice(1);
            if (hash) {
                try {
                    hash = decodeURIComponent(hash);
                } catch (error) {
                    console.warn('Could not decode hash path, using raw value', error);
                }
                await this.uiManager.navigateTo(hash);
                return;
            }

            await this.uiManager.refreshContent();
        } catch (error) {
            console.error('Error loading initial content:', error);
            this.showError('Failed to load content');
        }
    }

    showError(message) {
        if (this.uiManager) {
            this.uiManager.showError(message);
            return;
        }
        const errorAlert = document.getElementById('errorAlert');
        if (errorAlert) {
            errorAlert.textContent = message;
            errorAlert.style.display = 'block';
            setTimeout(() => {
                errorAlert.style.display = 'none';
            }, 3000);
        }
    }

    async navigateTo(path) {
        if (!this.uiManager) return;
        try {
            await this.uiManager.navigateTo(path);
        } catch (error) {
            console.error('Navigation error:', error);
            this.showError('Failed to navigate to folder');
        }
    }

    handleKeyboardShortcuts(e) {
        if (!this.uiManager) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const ctrlKey = e.ctrlKey || e.metaKey;
        const writable = this.fileManager.canWrite();

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
                if (!writable) return;
                e.preventDefault();
                this.uiManager.cutSelected();
                break;

            case ctrlKey && e.key === 'v':
                if (!writable) return;
                e.preventDefault();
                this.uiManager.paste();
                break;

            case e.key === 'Delete':
                if (!writable) return;
                e.preventDefault();
                this.uiManager.deleteSelected();
                break;

            case e.key === 'F2':
                if (!writable) return;
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
                document.querySelectorAll('.file-item.selected').forEach((el) => {
                    el.classList.remove('selected');
                });
                break;

            default:
                break;
        }
    }
}

// Initialize the application when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    window.app = app;
    app.init();
});

// Prevent the browser from opening files dropped outside the explorer
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// Expose managers globally for debugging
window.DEBUG = {
    getApp: () => window.app,
    getFileManager: () => window.app?.fileManager,
    getUIManager: () => window.app?.uiManager,
    getDragDropManager: () => window.app?.dragDropManager,
};
