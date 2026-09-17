// Main application initialization
import FileManager, { AuthRequiredError } from './fileManager.js';
import UIManager from './uiManager.js';
import DragDropManager from './dragDrop.js';

class App {
    constructor() {
        this.fileManager = null;
        this.uiManager = null;
        this.dragDropManager = null;
        this._loginPromise = null;
    }

    async init() {
        try {
            this.fileManager = new FileManager();
            await this.fileManager.init();
            await this.start();
        } catch (error) {
            if (error instanceof AuthRequiredError) {
                // Not logged in yet: gate the UI behind the PIN prompt.
                await this.requireLogin();
                return;
            }
            console.error('Initialization error:', error);
            this.showError('Failed to initialize application');
        }
    }

    /** Build the explorer UI. Safe to call again after a later login. */
    async start() {
        if (this.uiManager) return;

        this.uiManager = new UIManager(this.fileManager);
        this.dragDropManager = new DragDropManager(this.fileManager, this.uiManager);

        window.navigateTo = (path) => this.navigateTo(path);
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
        document.addEventListener('auth:required', () => this.requireLogin());
        window.addEventListener('popstate', (e) => {
            if (e.state?.path !== undefined) this.navigateTo(e.state.path);
        });

        await this.uiManager.refreshContent();
    }

    /** Show the login screen and resolve once the user is authenticated. */
    requireLogin() {
        if (this._loginPromise) return this._loginPromise;

        this._loginPromise = new Promise((resolve) => {
            const overlay = document.getElementById('loginOverlay');
            const form = document.getElementById('loginForm');
            const input = document.getElementById('pinInput');
            const errorEl = document.getElementById('loginError');

            if (!overlay || !form) {
                this.showError('Login UI missing; reload the page.');
                return;
            }

            overlay.style.display = 'flex';
            if (input) {
                input.value = '';
                input.focus();
            }
            if (errorEl) errorEl.textContent = '';

            const submit = async (event) => {
                event.preventDefault();
                const pin = input ? input.value.trim() : '';
                if (!pin) return;

                if (errorEl) errorEl.textContent = '';

                try {
                    const response = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ pin }),
                    });

                    if (!response.ok) {
                        const body = await response.json().catch(() => ({}));
                        if (errorEl) errorEl.textContent = body.error || 'Login failed';
                        if (input) {
                            input.value = '';
                            input.focus();
                        }
                        return;
                    }

                    overlay.style.display = 'none';
                    form.removeEventListener('submit', submit);
                    this._loginPromise = null;

                    await this.start();
                    await this.loadInitialContent();
                    resolve();
                } catch (error) {
                    if (errorEl) errorEl.textContent = 'Could not reach the server';
                }
            };

            form.addEventListener('submit', submit);
        });

        return this._loginPromise;
    }

    async loadInitialContent() {
        try {
            // Honour a #path deep link if the URL has one.
            const hash = decodeURIComponent(window.location.hash.slice(1));
            if (hash) {
                await this.uiManager.navigateTo(hash);
            } else {
                await this.uiManager.refreshContent();
            }
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
