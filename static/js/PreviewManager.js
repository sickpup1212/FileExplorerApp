class PreviewManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
        this.fileManager = uiManager.fileManager;
        this.currentZoom = 1;
        this.translateX = 0;
        this.translateY = 0;
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
        previewFileInfo.textContent = this.uiManager.formatFileInfo(file);

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
            document.removeEventListener('keydown', this.uiManager.app.handleKeyboardShortcuts);
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
        document.addEventListener('keydown', this.uiManager.app.handleKeyboardShortcuts);
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
        this.uiManager.app.handleKeyboardShortcuts = (e) => {
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
}

export default PreviewManager;
