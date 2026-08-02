(function() {
    let uploadQueue = [];
    let isUploading = false;
    let logoClicks = 0;
    let lastLogoClick = 0;
    let sharedTextBuffer = "";
    let isWsConnected = false;

    let uploadWorker = null;

    // V2 Phase 2: Virtual scrolling state
    const VIRTUAL_ITEM_HEIGHT = 68; // px per file row
    const VIRTUAL_BUFFER = 5;       // Extra items above/below viewport
    const VIRTUAL_THRESHOLD = 50;   // Use virtual scroll when > 50 files
    let cachedFiles = [];            // Cached file list for virtual scroll
    let isVirtualScrollActive = false;

    // V2 Phase 3: Ease of Use state
    let isMultiSelectMode = false;
    let selectedFiles = new Set();   // Set of filenames currently checked
    let pwaInstallPrompt = null;     // Deferred PWA install prompt
    let wsReconnectTimer = null;     // Auto-reconnect countdown timer
    let wsReconnectCountdown = 0;

    // V2 Phase 4: Beat All Competition state


    // Initialize Web Worker for uploads (V2 performance)
    function initUploadWorker() {
        try {
            uploadWorker = new Worker('/static/upload-worker.js');
            return true;
        } catch (e) {
            console.warn('Web Worker not supported, falling back to main thread upload:', e);
            uploadWorker = null;
            return false;
        }
    }

    // Utility Functions
    function formatBytes(bytes, decimals = 1) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function formatDuration(seconds) {
        if (!seconds || seconds < 1) return '< 1s';
        if (!isFinite(seconds)) return 'Calculating...';
        seconds = Math.round(seconds);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        
        const video = ['mp4','mkv','avi','mov','webm'];
        const image = ['jpg','jpeg','png','gif','svg','webp'];
        const audio = ['mp3','wav','flac','aac','ogg'];
        const archive = ['zip','rar','7z','tar','gz'];
        const code = ['js','py','html','css','json'];
        
        // Lucide styling: stroke color matches text color
        const svgAttr = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide-icon"';

        if (video.includes(ext)) {
            return `<svg ${svgAttr}><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>`;
        }
        if (image.includes(ext)) {
            return `<svg ${svgAttr}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`;
        }
        if (audio.includes(ext)) {
            return `<svg ${svgAttr}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        }
        if (ext === 'pdf') {
            return `<svg ${svgAttr}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
        }
        if (archive.includes(ext)) {
            return `<svg ${svgAttr}><path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/></svg>`;
        }
        if (code.includes(ext)) {
            return `<svg ${svgAttr}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
        }
        return `<svg ${svgAttr}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="9" x2="15" y1="9" y2="9"/><line x1="9" x2="15" y1="13" y2="13"/><line x1="9" x2="11" y1="17" y2="17"/></svg>`;
    }

    function initUploadZone() {
        const uploadZone = document.getElementById('upload-zone');
        const fileInput = document.getElementById('file-input');
        const browseBtn = document.getElementById('browse-btn');
        const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.body.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        ['dragenter', 'dragover'].forEach(eventName => {
            if (uploadZone) uploadZone.addEventListener(eventName, highlight, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            if (uploadZone) uploadZone.addEventListener(eventName, unhighlight, false);
        });

        function highlight(e) {
            uploadZone.classList.add('drag-over');
        }

        function unhighlight(e) {
            uploadZone.classList.remove('drag-over');
        }

        if (uploadZone) uploadZone.addEventListener('drop', handleDrop, false);

        // Keyboard accessibility: Enter/Space activates upload zone
        if (uploadZone) {
            uploadZone.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    uploadZone.click();
                }
            });
        }

        function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            handleFiles(files);
        }

        if (isLocalhost) {
            // LOCALHOST: Use native OS file picker (zero-copy, no upload)
            if (browseBtn) {
                browseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    pickLocalFiles();
                });
            }

            if (uploadZone) {
                uploadZone.addEventListener('click', (e) => {
                    if (e.target === browseBtn || e.target.closest('#browse-btn')) return;
                    pickLocalFiles();
                });
            }
        } else {
            // MOBILE: Use standard browser file input (upload via XHR)
            if (browseBtn) {
                browseBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (fileInput) fileInput.click();
                });
            }

            if (uploadZone) {
                uploadZone.addEventListener('click', (e) => {
                    if (e.target === browseBtn || e.target.closest('#browse-btn')) return;
                    if (fileInput) fileInput.click();
                });
            }
        }

        if (fileInput) {
            fileInput.addEventListener('change', function() {
                handleFiles(this.files);
            });
        }
    }

    let isPickerActive = false;

    async function pickLocalFiles() {
        /**
         * Call server to open a native OS file dialog (tkinter).
         * Returns real file paths — registered as zero-copy virtual shares.
         * No upload, no copy, instant availability.
         */
        if (isPickerActive) return;
        isPickerActive = true;
        try {
            const res = await fetch('/pick-local-files', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'success' && data.count > 0) {
                    loadFileList();
                    loadTransferHistory();
                }
            }
        } catch (e) {
            console.error('pick-local-files error:', e);
        } finally {
            isPickerActive = false;
        }
    }

    function handleFiles(fileList) {
        if (fileList && fileList.length > 0) {
            for (let i = 0; i < fileList.length; i++) {
                uploadQueue.push(fileList[i]);
            }
            if (!isUploading) {
                processNextUpload();
            }
        }
    }

    async function shareLocalPath(filePath) {
        /**
         * Register a local file for direct-path sharing via /share-local.
         * No upload, no copy — the server streams from the original location.
         */
        try {
            const res = await fetch('/share-local', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath }),
            });
            if (res.ok) {
                loadFileList();
                loadTransferHistory();
            } else {
                const data = await res.json();
                console.error('share-local failed:', data.detail);
            }
        } catch (e) {
            console.error('share-local error:', e);
        }
    }

    function processNextUpload() {
        if (uploadQueue.length === 0) {
            isUploading = false;
            // Clear progress section state after queue finishes
            setTimeout(() => {
                const progressSection = document.getElementById('progress-section');
                if (progressSection && !isUploading) {
                    progressSection.classList.remove('active');
                }
            }, 3000);
            return;
        }

        isUploading = true;
        const file = uploadQueue.shift();
        uploadFileWithResume(file, () => {
            processNextUpload();
        }, () => {
            // On error, pause briefly so user sees the message, then process next file
            setTimeout(processNextUpload, 2000);
        });
    }

    function uploadFile(file, onComplete, onError) {
        const progressSection = document.getElementById('progress-section');
        const progressFilename = document.getElementById('progress-filename');
        const progressPercent = document.getElementById('progress-percent');
        const progressBarFill = document.getElementById('progress-bar-fill');
        const progressTransferred = document.getElementById('progress-transferred');
        const progressSpeed = document.getElementById('progress-speed');
        const progressEta = document.getElementById('progress-eta');

        if (progressSection) progressSection.classList.add('active');
        
        const queueHint = uploadQueue.length > 0 ? ` (+${uploadQueue.length} more)` : '';
        if (progressFilename) progressFilename.textContent = file.name + queueHint;
        
        if (progressBarFill) {
            progressBarFill.style.width = '0%';
            progressBarFill.classList.remove('complete', 'error');
        }
        if (progressSection) progressSection.classList.remove('complete', 'error');

        // V2: requestAnimationFrame-based progress rendering (60fps, zero jank)
        let pendingUpdate = null;
        let rafScheduled = false;

        function applyProgressUpdate(update) {
            if (progressBarFill) progressBarFill.style.width = update.percent + '%';
            if (progressPercent) progressPercent.textContent = Math.round(update.percent) + '%';
            if (progressTransferred) progressTransferred.textContent = formatBytes(update.transferred) + ' / ' + formatBytes(update.total);
            if (update.speed !== undefined && progressSpeed) progressSpeed.textContent = formatBytes(update.speed) + '/s';
            if (update.eta !== undefined && progressEta) progressEta.textContent = formatDuration(update.eta) + ' remaining';
        }

        function scheduleProgressUpdate(update) {
            pendingUpdate = update;
            if (!rafScheduled) {
                rafScheduled = true;
                requestAnimationFrame(() => {
                    if (pendingUpdate) applyProgressUpdate(pendingUpdate);
                    rafScheduled = false;
                });
            }
        }

        function handleComplete() {
            if (progressBarFill) {
                progressBarFill.style.width = '100%';
                progressBarFill.classList.add('complete');
            }
            if (progressSection) progressSection.classList.add('complete');
            if (progressSpeed) progressSpeed.textContent = 'Complete';
            if (progressEta) progressEta.textContent = '✓';

            // V2 Phase 3: Completion sound + haptic feedback (Task 11)
            playCompletionSound();
            if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
            
            setTimeout(() => {
                loadFileList();
                loadTransferHistory(); // Refresh history dashboard after upload
                if (onComplete) onComplete();
            }, 500);
        }

        function handleError() {
            if (progressBarFill) progressBarFill.classList.add('error');
            if (progressSection) progressSection.classList.add('error');
            if (progressSpeed) progressSpeed.textContent = 'Failed';
            if (progressEta) progressEta.textContent = 'Upload error';
            if (onError) onError();
        }

        // V2: Try Web Worker upload first (offloads XHR to background thread)
        if (uploadWorker) {
            uploadWorker.onmessage = function(e) {
                const msg = e.data;
                if (msg.type === 'progress') {
                    scheduleProgressUpdate({
                        percent: msg.percent,
                        transferred: msg.transferred,
                        total: msg.total,
                        speed: msg.speed,
                        eta: msg.eta
                    });
                } else if (msg.type === 'complete') {
                    handleComplete();
                } else if (msg.type === 'error') {
                    console.error('Worker upload error:', msg.message);
                    handleError();
                }
            };

            uploadWorker.onerror = function(err) {
                console.error('Worker error:', err);
                handleError();
            };

            uploadWorker.postMessage({ type: 'upload', file: file, url: '/upload' });
            return;
        }

        // Fallback: XHR upload on main thread (V1 behavior with rAF optimization)
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);
        
        let lastLoaded = 0;
        let lastTime = Date.now();
        let speeds = []; 
        
        xhr.upload.addEventListener('progress', function(e) {
            if (e.lengthComputable) {
                const percent = (e.loaded / e.total) * 100;

                const now = Date.now();
                const timeDelta = (now - lastTime) / 1000;
                if (timeDelta > 0.1) {
                    const byteDelta = e.loaded - lastLoaded;
                    const speed = byteDelta / timeDelta;
                    speeds.push(speed);
                    if (speeds.length > 5) speeds.shift();
                    lastLoaded = e.loaded;
                    lastTime = now;
                }

                const avgSpeed = speeds.length > 0 ? speeds.reduce((a,b) => a+b, 0) / speeds.length : 0;
                const remaining = e.total - e.loaded;
                const eta = avgSpeed > 0 ? remaining / avgSpeed : 0;

                scheduleProgressUpdate({
                    percent: percent,
                    transferred: e.loaded,
                    total: e.total,
                    speed: avgSpeed,
                    eta: eta
                });
            }
        });
        
        xhr.addEventListener('load', function() {
            if (xhr.status >= 200 && xhr.status < 300) {
                handleComplete();
            } else {
                handleError();
            }
        });
        
        xhr.addEventListener('error', handleError);
        xhr.addEventListener('abort', handleError);
        
        xhr.open('POST', '/upload');
        xhr.send(formData);
    }

    async function loadFileList() {
        const fileListElement = document.getElementById('file-list');
        try {
            const response = await fetch('/files');
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();
            const files = data.files || [];
            cachedFiles = files;

            // Remove skeleton placeholders on first load
            if (fileListElement) {
                const skeletons = fileListElement.querySelectorAll('.skeleton-item');
                skeletons.forEach(s => s.remove());
            }

            if (files.length > VIRTUAL_THRESHOLD) {
                initVirtualScroll(files);
            } else {
                isVirtualScrollActive = false;
                if (fileListElement) fileListElement.classList.remove('virtual-scroll');
                renderFileList(files, data.count || files.length);
            }
        } catch (err) {
            console.warn('Could not load file list:', err);
            if (fileListElement) {
                fileListElement.innerHTML = '<li class="error-msg">Error loading file list.</li>';
            }
        }
    }

    function renderFileList(files, count) {
        const fileListElement = document.getElementById('file-list');
        const fileCount = document.getElementById('file-count');
        const fileTotalSize = document.getElementById('file-total-size');

        if (fileCount) fileCount.innerHTML = `<span>${count}</span> files`;

        let totalSize = 0;
        files.forEach(f => {
            totalSize += f.size || 0;
        });

        if (fileTotalSize) fileTotalSize.innerHTML = `<span>${formatBytes(totalSize)}</span> total`;

        if (!fileListElement) return;

        // V2: Use DocumentFragment for batched DOM insertion (zero reflows)
        const fragment = document.createDocumentFragment();

        if (files.length === 0) {
            const emptyLi = document.createElement('li');
            emptyLi.className = 'empty-msg';
            emptyLi.textContent = 'No files available.';
            fragment.appendChild(emptyLi);
        } else {
            files.forEach(file => {
                fragment.appendChild(createFileItem(file));
            });
        }

        fileListElement.innerHTML = '';
        fileListElement.appendChild(fragment);
    }

    function createFileItem(file) {
        const li = document.createElement('li');
        li.className = 'file-item';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'file-icon';
        iconSpan.innerHTML = getFileIcon(file.name);

        const infoDiv = document.createElement('div');
        infoDiv.className = 'file-info';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = file.name;
        nameSpan.title = file.name;

        const metaDiv = document.createElement('div');
        metaDiv.className = 'file-meta';

        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'file-size';
        sizeSpan.textContent = formatBytes(file.size);

        const separatorSpan = document.createElement('span');
        separatorSpan.className = 'meta-separator';
        separatorSpan.innerHTML = ' &middot; ';

        const dateSpan = document.createElement('span');
        dateSpan.className = 'file-date';
        const d = new Date(file.modified || Date.now());
        dateSpan.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();

        metaDiv.appendChild(sizeSpan);
        metaDiv.appendChild(separatorSpan);
        metaDiv.appendChild(dateSpan);

        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(metaDiv);

        // V2 Phase 3: Checkbox for multi-select (Task 10)
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-checkbox';
        checkbox.setAttribute('aria-label', 'Select ' + file.name);
        checkbox.checked = selectedFiles.has(file.name);
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                selectedFiles.add(file.name);
                li.classList.add('selected');
            } else {
                selectedFiles.delete(file.name);
                li.classList.remove('selected');
            }
            updateSelectCountLabel();
        });
        if (selectedFiles.has(file.name)) li.classList.add('selected');

        const actionSpan = document.createElement('span');
        actionSpan.className = 'file-actions';

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`;
        downloadBtn.title = 'Download File';
        downloadBtn.onclick = (e) => {
            e.stopPropagation();
            downloadFile(file.name);
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
        deleteBtn.title = 'Delete File';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            showConfirm(`Delete "${file.name}"?`, async () => {
                await deleteFile(file.name);
            }, "Delete File", "Delete");
        };

        actionSpan.appendChild(downloadBtn);

        // V2 Phase 4: Web Share API button (Task 9) — visible only on mobile
        if (navigator.share) {
            const shareBtn = document.createElement('button');
            shareBtn.className = 'share-btn';
            shareBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>`;
            shareBtn.title = 'Share';
            shareBtn.onclick = (e) => {
                e.stopPropagation();
                tryWebShare(file.name);
            };
            actionSpan.appendChild(shareBtn);
        }

        actionSpan.appendChild(deleteBtn);

        li.appendChild(checkbox);
        li.appendChild(iconSpan);
        li.appendChild(infoDiv);
        li.appendChild(actionSpan);

        // V2 Phase 3: Click on file item → Open preview (DEFAULT action, Task 4)
        li.addEventListener('click', (e) => {
            // Don't open preview if clicking action buttons or checkbox
            if (e.target.closest('.file-actions') || e.target.closest('.file-checkbox')) return;
            if (isMultiSelectMode) {
                // In multi-select mode: toggle checkbox on row click
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
                return;
            }
            openPreview(file);
        });

        return li;
    }

    // -----------------------------------------------------------------------
    // V2 Phase 2: Virtual Scrolling Engine
    // -----------------------------------------------------------------------
    function initVirtualScroll(files) {
        const fileListElement = document.getElementById('file-list');
        const fileCount = document.getElementById('file-count');
        const fileTotalSize = document.getElementById('file-total-size');

        if (!fileListElement) return;

        isVirtualScrollActive = true;
        fileListElement.classList.add('virtual-scroll');

        const count = files.length;
        if (fileCount) fileCount.innerHTML = `<span>${count}</span> files`;

        let totalSize = 0;
        files.forEach(f => { totalSize += f.size || 0; });
        if (fileTotalSize) fileTotalSize.innerHTML = `<span>${formatBytes(totalSize)}</span> total`;

        // Set total height for scroll
        const totalHeight = count * VIRTUAL_ITEM_HEIGHT;

        function renderVisibleItems() {
            const scrollTop = fileListElement.scrollTop;
            const viewportHeight = fileListElement.clientHeight;

            const startIndex = Math.max(0, Math.floor(scrollTop / VIRTUAL_ITEM_HEIGHT) - VIRTUAL_BUFFER);
            const endIndex = Math.min(count, Math.ceil((scrollTop + viewportHeight) / VIRTUAL_ITEM_HEIGHT) + VIRTUAL_BUFFER);

            const fragment = document.createDocumentFragment();

            // Top spacer
            const topSpacer = document.createElement('li');
            topSpacer.className = 'virtual-spacer-top';
            topSpacer.style.height = (startIndex * VIRTUAL_ITEM_HEIGHT) + 'px';
            fragment.appendChild(topSpacer);

            // Visible items
            for (let i = startIndex; i < endIndex; i++) {
                fragment.appendChild(createFileItem(files[i]));
            }

            // Bottom spacer
            const bottomSpacer = document.createElement('li');
            bottomSpacer.className = 'virtual-spacer-bottom';
            bottomSpacer.style.height = ((count - endIndex) * VIRTUAL_ITEM_HEIGHT) + 'px';
            fragment.appendChild(bottomSpacer);

            fileListElement.innerHTML = '';
            fileListElement.appendChild(fragment);
        }

        // Initial render
        renderVisibleItems();

        // Re-render on scroll (throttled via rAF)
        let scrollRafScheduled = false;
        fileListElement.onscroll = function() {
            if (!scrollRafScheduled) {
                scrollRafScheduled = true;
                requestAnimationFrame(() => {
                    renderVisibleItems();
                    scrollRafScheduled = false;
                });
            }
        };
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: File Preview Modal (Tasks 4, 5, 6)
    // -----------------------------------------------------------------------

    const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','svg','webp','bmp','ico','avif']);
    const VIDEO_EXTS = new Set(['mp4','mkv','webm','mov','avi','ogv']);
    const AUDIO_EXTS = new Set(['mp3','wav','ogg','flac','aac','m4a','opus']);
    const PDF_EXTS   = new Set(['pdf']);
    const ARCHIVE_EXTS = new Set(['zip','rar','7z','tar','gz','bz2','xz','iso']);
    const TEXT_EXTS  = new Set([
        'txt','md','json','xml','csv','log','ini','yaml','yml','toml','env','dockerfile','gitignore',
        'js','ts','jsx','tsx','vue','svelte','html','css','scss','less',
        'py','sh','bat','cmd','java','c','cpp','h','hpp','cs','rs','go','php','rb','kt','swift','sql','r','lua','dart','zig'
    ]);

    function getFileExtension(filename) {
        return filename.split('.').pop().toLowerCase();
    }

    function openPreview(file) {
        const modal = document.getElementById('preview-modal');
        const title = document.getElementById('preview-title');
        const body = document.getElementById('preview-body');
        const downloadBtn = document.getElementById('preview-download-btn');
        const closeBtn = document.getElementById('preview-close-btn');

        if (!modal || !body) return;

        const ext = getFileExtension(file.name);
        const previewUrl = '/preview/' + encodeURIComponent(file.name);

        if (title) title.textContent = file.name;
        if (downloadBtn) {
            downloadBtn.onclick = () => downloadFile(file.name);
        }

        // Show loading state first
        body.innerHTML = '<div class="preview-loader"><div class="preview-spinner"></div>Loading...</div>';
        modal.classList.add('active');

        if (IMAGE_EXTS.has(ext)) {
            // Image preview
            const img = document.createElement('img');
            img.className = 'preview-img';
            img.alt = file.name;
            img.onload = () => { body.innerHTML = ''; body.appendChild(img); };
            img.onerror = () => showPreviewUnsupported(body, file.name, ext);
            img.src = previewUrl;

        } else if (VIDEO_EXTS.has(ext)) {
            // Video preview
            const video = document.createElement('video');
            video.className = 'preview-video';
            video.controls = true;
            video.autoplay = false;
            video.preload = 'metadata';
            video.src = previewUrl;
            video.onerror = () => showPreviewUnsupported(body, file.name, ext);

            // Handle smooth fullscreen exit transition on mobile GPUs
            const handleFullscreenChange = () => {
                const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
                if (!isFS && modal) {
                    modal.classList.add('exiting-fullscreen');
                    setTimeout(() => modal.classList.remove('exiting-fullscreen'), 250);
                }
            };
            document.addEventListener('fullscreenchange', handleFullscreenChange);
            document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

            body.innerHTML = '';
            body.appendChild(video);

        } else if (PDF_EXTS.has(ext)) {
            // PDF preview via native browser viewer iframe
            const iframe = document.createElement('iframe');
            iframe.className = 'preview-pdf';
            iframe.src = previewUrl;
            iframe.onerror = () => showPreviewUnsupported(body, file.name, ext);
            body.innerHTML = '';
            body.appendChild(iframe);

        } else if (AUDIO_EXTS.has(ext)) {
            // Dedicated Full-Width Audio Preview Player
            const wrapper = document.createElement('div');
            wrapper.className = 'preview-audio-wrapper';

            const iconDiv = document.createElement('div');
            iconDiv.className = 'preview-audio-icon';
            iconDiv.innerHTML = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

            const nameDiv = document.createElement('div');
            nameDiv.className = 'preview-audio-filename';
            nameDiv.textContent = file.name;

            const playerDiv = document.createElement('div');
            playerDiv.className = 'preview-audio-player';

            playerDiv.innerHTML = `
                <div class="audio-progress-container">
                    <input type="range" class="audio-scrubber" min="0" max="100" value="0" step="0.1" aria-label="Audio timeline">
                    <div class="audio-time-row">
                        <span class="audio-time-current">0:00</span>
                        <span class="audio-time-total">0:00</span>
                    </div>
                </div>
                <div class="audio-controls-row">
                    <button type="button" class="audio-play-btn" aria-label="Play or pause audio">
                        <svg class="play-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                </div>
            `;

            const audio = document.createElement('audio');
            audio.preload = 'metadata';
            audio.src = previewUrl;

            const scrubber = playerDiv.querySelector('.audio-scrubber');
            const timeCurrent = playerDiv.querySelector('.audio-time-current');
            const timeTotal = playerDiv.querySelector('.audio-time-total');
            const playBtn = playerDiv.querySelector('.audio-play-btn');

            const playIconHTML = `<svg class="play-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
            const pauseIconHTML = `<svg class="pause-icon" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;

            function formatAudioTime(seconds) {
                if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
                const mins = Math.floor(seconds / 60);
                const secs = Math.floor(seconds % 60);
                return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
            }

            audio.addEventListener('loadedmetadata', () => {
                timeTotal.textContent = formatAudioTime(audio.duration);
            });

            let isScrubbing = false;

            audio.addEventListener('timeupdate', () => {
                if (audio.duration && !isScrubbing) {
                    const pct = (audio.currentTime / audio.duration) * 100;
                    scrubber.value = pct;
                    timeCurrent.textContent = formatAudioTime(audio.currentTime);
                }
            });

            scrubber.addEventListener('mousedown', () => { isScrubbing = true; });
            scrubber.addEventListener('touchstart', () => { isScrubbing = true; });
            scrubber.addEventListener('mouseup', () => { isScrubbing = false; });
            scrubber.addEventListener('touchend', () => { isScrubbing = false; });

            scrubber.addEventListener('input', () => {
                if (audio.duration) {
                    audio.currentTime = (scrubber.value / 100) * audio.duration;
                }
            });

            playBtn.onclick = () => {
                if (audio.paused) {
                    audio.play().then(() => {
                        playBtn.innerHTML = pauseIconHTML;
                    }).catch(() => {});
                } else {
                    audio.pause();
                    playBtn.innerHTML = playIconHTML;
                }
            };

            audio.addEventListener('ended', () => {
                playBtn.innerHTML = playIconHTML;
                scrubber.value = 0;
                timeCurrent.textContent = "0:00";
            });

            audio.onerror = () => showPreviewUnsupported(body, file.name, ext);

            wrapper.appendChild(iconDiv);
            wrapper.appendChild(nameDiv);
            wrapper.appendChild(playerDiv);
            wrapper.appendChild(audio);

            body.innerHTML = '';
            body.appendChild(wrapper);

        } else if (TEXT_EXTS.has(ext)) {
            // Guard: If text file size exceeds 2 MB, prevent loading to avoid browser freeze
            const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
            if (file.size && file.size > MAX_TEXT_PREVIEW_BYTES) {
                body.innerHTML = `
                    <div class="preview-unsupported">
                        <div class="preview-unsupported-icon">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                        </div>
                        <h3>Large Text File (${formatBytes(file.size)})</h3>
                        <p>Text file exceeds 2 MB safety limit. Download file to view complete content.</p>
                    </div>
                `;
                return;
            }

            // Fetch and render text/code preview safely
            fetch(previewUrl)
                .then(r => {
                    if (!r.ok) throw new Error('Fetch failed');
                    return r.text();
                })
                .then(text => {
                    const pre = document.createElement('pre');
                    pre.className = 'preview-text-content';
                    pre.textContent = text.length > 50000 ? text.slice(0, 50000) + '\n\n[Truncated — file too large to display fully]' : text;
                    body.innerHTML = '';
                    body.appendChild(pre);
                })
                .catch(() => showPreviewUnsupported(body, file.name, ext));

        } else if (ARCHIVE_EXTS.has(ext)) {
            body.innerHTML = `
                <div class="preview-unsupported">
                    <div class="preview-unsupported-icon">
                        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/></svg>
                    </div>
                    <h3>Archive Package (.${ext})</h3>
                    <p>Compressed archive file. Click Download to save and extract files on your device.</p>
                </div>
            `;
        } else {
            showPreviewUnsupported(body, file.name, ext);
        }

        // Close on button or overlay click
        if (closeBtn) {
            closeBtn.onclick = closePreview;
        }
        modal.onclick = (e) => {
            if (e.target === modal) closePreview();
        };

        // Close on Escape key
        document.addEventListener('keydown', handlePreviewEscape);
    }

    function handlePreviewEscape(e) {
        if (e.key === 'Escape') closePreview();
    }

    function closePreview() {
        const modal = document.getElementById('preview-modal');
        const body = document.getElementById('preview-body');
        if (modal) modal.classList.remove('active');
        // Stop any playing media cleanly without triggering console 404 warnings
        if (body) {
            const video = body.querySelector('video');
            const audio = body.querySelector('audio');
            if (video) {
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
            if (audio) {
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            }
            body.innerHTML = '';
        }
        document.removeEventListener('keydown', handlePreviewEscape);
    }

    function showPreviewUnsupported(body, filename, ext) {
        body.innerHTML = `
            <div class="preview-unsupported">
                <div class="preview-unsupported-icon">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="9" x2="15" y1="9" y2="9"/><line x1="9" x2="15" y1="13" y2="13"/><line x1="9" x2="11" y1="17" y2="17"/></svg>
                </div>
                <h3>Preview not available</h3>
                <p>.${ext} files can't be previewed in browser. Use the Download button to save the file.</p>
            </div>
        `;
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: Multi-Select (Task 10)
    // -----------------------------------------------------------------------

    function updateSelectCountLabel() {
        const label = document.getElementById('select-count-label');
        if (label) label.textContent = selectedFiles.size + ' selected';
    }

    function initMultiSelect() {
        const toggleBtn = document.getElementById('select-toggle-btn');
        const bar = document.getElementById('multi-select-bar');
        const fileList = document.getElementById('file-list');
        const selectAllBtn = document.getElementById('select-all-btn');
        const deleteSelectedBtn = document.getElementById('delete-selected-btn');

        if (!toggleBtn) return;

        toggleBtn.addEventListener('click', () => {
            isMultiSelectMode = !isMultiSelectMode;
            selectedFiles.clear();

            if (fileList) {
                fileList.classList.toggle('multi-select-mode', isMultiSelectMode);
                // Deselect all
                fileList.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
                fileList.querySelectorAll('.file-checkbox').forEach(cb => cb.checked = false);
            }

            if (bar) bar.classList.toggle('hidden', !isMultiSelectMode);
            toggleBtn.innerHTML = isMultiSelectMode
                ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel`
                : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg> Select`;

            updateSelectCountLabel();
        });

        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                const fileList = document.getElementById('file-list');
                if (!fileList) return;
                const allNames = cachedFiles.map(f => f.name);
                allNames.forEach(n => selectedFiles.add(n));
                fileList.querySelectorAll('.file-item').forEach(item => {
                    item.classList.add('selected');
                    const cb = item.querySelector('.file-checkbox');
                    if (cb) cb.checked = true;
                });
                updateSelectCountLabel();
            });
        }

        if (deleteSelectedBtn) {
            deleteSelectedBtn.addEventListener('click', () => {
                if (selectedFiles.size === 0) return;
                showConfirm(`Delete ${selectedFiles.size} selected file(s)?`, async () => {
                    const toDelete = [...selectedFiles];
                    for (const name of toDelete) {
                        await deleteFile(name);
                    }
                    selectedFiles.clear();
                    isMultiSelectMode = false;
                    const fileList = document.getElementById('file-list');
                    if (fileList) fileList.classList.remove('multi-select-mode');
                    if (bar) bar.classList.add('hidden');
                    if (toggleBtn) {
                        toggleBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg> Select`;
                    }
                    updateSelectCountLabel();
                }, "Delete Selected Files", "Delete");
            });
        }
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: Download All ZIP (Task 9)
    // -----------------------------------------------------------------------

    function initDownloadAll() {
        const btn = document.getElementById('download-all-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (cachedFiles.length === 0) {
                showNotice('No files available to download.');
                return;
            }
            const originalHTML = btn.innerHTML;
            btn.innerHTML = `<svg class="preview-spinner" style="width:14px;height:14px;border-width:2px" viewBox="0 0 24 24"></svg> Zipping...`;
            btn.disabled = true;
            // Trigger browser download of the ZIP stream
            const a = document.createElement('a');
            a.href = '/download-all';
            a.download = 'ADrop-files.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => {
                btn.innerHTML = originalHTML;
                btn.disabled = false;
            }, 3000);
        });
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: Copy URL Button (Task 12)
    // -----------------------------------------------------------------------

    function initCopyUrlBtn() {
        const btn = document.getElementById('copy-url-btn');
        if (!btn) return;
        const originalHTML = btn.innerHTML;
        btn.addEventListener('click', () => {
            const urlText = document.getElementById('connection-url-text');
            const url = urlText ? urlText.textContent.trim() : window.location.href;
            copyTextToClipboard(url, btn, originalHTML);
        });
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: Completion Sound via Web Audio API (Task 11)
    // -----------------------------------------------------------------------

    function playCompletionSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Play a short pleasant two-tone chime
            function playTone(freq, startTime, duration, gain) {
                const osc = ctx.createOscillator();
                const gainNode = ctx.createGain();
                osc.connect(gainNode);
                gainNode.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, startTime);
                gainNode.gain.setValueAtTime(0, startTime);
                gainNode.gain.linearRampToValueAtTime(gain, startTime + 0.02);
                gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
                osc.start(startTime);
                osc.stop(startTime + duration);
            }
            const now = ctx.currentTime;
            playTone(523.25, now, 0.25, 0.15);       // C5
            playTone(783.99, now + 0.12, 0.3, 0.12); // G5
            // Auto-close context after sounds finish
            setTimeout(() => ctx.close(), 600);
        } catch (e) {
            // Web Audio not supported or blocked — silent fail
        }
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: Auto-Reconnect Countdown Overlay (Task 13)
    // -----------------------------------------------------------------------

    function showReconnectOverlay(seconds) {
        let overlay = document.getElementById('reconnect-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'reconnect-overlay';
            overlay.className = 'reconnect-overlay';
            overlay.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M3.5 12a9 9 0 0 1 15-6.7L21.5 8"/><path d="M2.5 22v-6h6"/><path d="M20.5 12a9 9 0 0 1-15 6.7L2.5 16"/></svg>
                <span>Reconnecting in <span class="reconnect-countdown" id="reconnect-countdown">${seconds}</span>s</span>
            `;
            document.body.appendChild(overlay);
        }
        const countdownEl = overlay.querySelector('#reconnect-countdown') ||
                            document.getElementById('reconnect-countdown');
        if (countdownEl) countdownEl.textContent = seconds;
        overlay.classList.add('active');
        wsReconnectCountdown = seconds;

        clearInterval(wsReconnectTimer);
        wsReconnectTimer = setInterval(() => {
            wsReconnectCountdown--;
            if (countdownEl) countdownEl.textContent = Math.max(0, wsReconnectCountdown);
            if (wsReconnectCountdown <= 0) {
                clearInterval(wsReconnectTimer);
                hideReconnectOverlay();
            }
        }, 1000);
    }

    function hideReconnectOverlay() {
        const overlay = document.getElementById('reconnect-overlay');
        if (overlay) overlay.classList.remove('active');
        clearInterval(wsReconnectTimer);
    }

    // -----------------------------------------------------------------------
    // V2 Phase 3: PWA Service Worker Registration + Install Prompt (Tasks 2, 14)
    // -----------------------------------------------------------------------

    function initPWA() {
        // Register Service Worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/static/sw.js').then(reg => {
                console.log('[PWA] Service Worker registered:', reg.scope);
            }).catch(err => {
                console.warn('[PWA] Service Worker registration failed:', err);
            });
        }

        // Capture beforeinstallprompt for custom install button
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            pwaInstallPrompt = e;
            const hint = document.getElementById('pwa-install-hint');
            if (hint) hint.classList.remove('hidden');

            const installLink = document.getElementById('pwa-install-link');
            if (installLink) {
                installLink.addEventListener('click', (evt) => {
                    evt.preventDefault();
                    if (!pwaInstallPrompt) return;
                    pwaInstallPrompt.prompt();
                    pwaInstallPrompt.userChoice.then(() => {
                        pwaInstallPrompt = null;
                        if (hint) hint.classList.add('hidden');
                    });
                });
            }
        });

        // Hide install hint if already installed
        window.addEventListener('appinstalled', () => {
            const hint = document.getElementById('pwa-install-hint');
            if (hint) hint.classList.add('hidden');
            pwaInstallPrompt = null;
        });
    }

    async function deleteFile(filename) {
        // V2: Optimistic UI — remove immediately, restore on error
        const fileListElement = document.getElementById('file-list');
        let removedItem = null;
        let removedIndex = -1;

        if (fileListElement) {
            const items = fileListElement.querySelectorAll('.file-item');
            items.forEach((item, idx) => {
                const nameEl = item.querySelector('.file-name');
                if (nameEl && nameEl.textContent === filename) {
                    removedItem = item;
                    removedIndex = idx;
                    item.style.opacity = '0';
                    item.style.transform = 'translateX(20px)';
                    item.style.transition = 'opacity 0.2s, transform 0.2s';
                    setTimeout(() => item.remove(), 200);
                }
            });
        }

        // Also remove from cached files
        cachedFiles = cachedFiles.filter(f => f.name !== filename);

        try {
            const response = await fetch('/delete/' + encodeURIComponent(filename), {
                method: 'DELETE'
            });
            if (response.ok) {
                // Update footer counts
                const fileCount = document.getElementById('file-count');
                const fileTotalSize = document.getElementById('file-total-size');
                if (fileCount) fileCount.innerHTML = `<span>${cachedFiles.length}</span> files`;
                let totalSize = 0;
                cachedFiles.forEach(f => { totalSize += f.size || 0; });
                if (fileTotalSize) fileTotalSize.innerHTML = `<span>${formatBytes(totalSize)}</span> total`;
                // Reload file list to fix virtual scroll desync
                loadFileList();
            } else {
                // Restore on error
                const data = await response.json();
                showNotice('Error deleting file: ' + (data.detail || 'unknown error'));
                loadFileList(); // Reload to restore state
            }
        } catch (err) {
            console.error('Delete failed:', err);
            showNotice('Failed to connect to server to delete file.');
            loadFileList(); // Reload to restore state
        }
    }

    /**
     * Show a non-blocking notice modal (replaces alert()).
     * Auto-dismisses after 3 seconds or on click.
     */
    function showNotice(message) {
        let overlay = document.getElementById('notice-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'notice-overlay';
            overlay.className = 'notice-overlay';
            overlay.innerHTML = `
                <div class="notice-card glass-card">
                    <p class="notice-message"></p>
                    <button class="glass-btn notice-ok-btn">OK</button>
                </div>
            `;
            // Inline styles for notice overlay (consistent with existing modal design)
            overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);opacity:0;transition:opacity 0.2s;pointer-events:none;';
            const card = overlay.querySelector('.notice-card');
            if (card) card.style.cssText = 'padding:24px 28px;text-align:center;max-width:340px;width:90%;';
            const msg = overlay.querySelector('.notice-message');
            if (msg) msg.style.cssText = 'margin:0 0 16px;font-size:0.95rem;color:var(--text-primary,#fff);';
            document.body.appendChild(overlay);
        }
        const msg = overlay.querySelector('.notice-message');
        if (msg) msg.textContent = message;
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'auto';

        function dismiss() {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
        }

        const btn = overlay.querySelector('.notice-ok-btn');
        if (btn) btn.onclick = dismiss;
        overlay.onclick = (e) => { if (e.target === overlay) dismiss(); };
        // Auto-dismiss after 4 seconds
        setTimeout(dismiss, 4000);
    }

    function showConfirm(message, onConfirm, titleText = "Confirm Action", confirmBtnText = "Confirm") {
        const overlay = document.getElementById('confirm-modal');
        const titleElem = document.getElementById('confirm-title');
        const msgElem = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');

        if (!overlay || !msgElem || !okBtn || !cancelBtn) return;

        if (titleElem) titleElem.textContent = titleText;
        msgElem.textContent = message;
        okBtn.textContent = confirmBtnText;
        overlay.classList.add('active');

        function cleanup() {
            overlay.classList.remove('active');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            overlay.onclick = null;
        }

        okBtn.onclick = () => {
            cleanup();
            onConfirm();
        };

        cancelBtn.onclick = () => {
            cleanup();
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                cleanup();
            }
        };
    }

    function downloadFile(filename) {
        const a = document.createElement('a');
        a.href = '/download/' + encodeURIComponent(filename);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    async function checkConnection() {
        const statusDot = document.getElementById('status-dot');
        const statusText = document.getElementById('status-text');
        const statusBar = document.getElementById('status-bar');
        const connectionUrlText = document.getElementById('connection-url-text');

        try {
            const response = await fetch('/info');
            if (response.ok) {
                const data = await response.json();
                if (statusDot) {
                    statusDot.style.backgroundColor = '';
                }
                if (statusText) {
                    statusText.textContent = 'Connected  \u00B7  ' + (data.local_ip || '') + ':' + (data.port || '8000');
                }
                if (statusBar) {
                    statusBar.classList.remove('disconnected');
                }
                if (connectionUrlText && data.connection_url) {
                    connectionUrlText.textContent = data.connection_url;
                }
            } else {
                throw new Error('Not ok');
            }
        } catch (err) {
            if (statusDot) {
                statusDot.style.backgroundColor = '';
            }
            if (statusText) {
                statusText.textContent = 'Disconnected  \u00B7  Reconnecting...';
            }
            if (statusBar) {
                statusBar.classList.add('disconnected');
            }
        }
    }

    function initConnectionCard() {
        const connectionCard = document.getElementById('connection-card');
        if (connectionCard) {
            // Hide connection QR code card on mobile browsers
            const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
            if (!isLocalhost) {
                connectionCard.style.display = 'none';
            }
        }
    }

    async function loadSharedText() {
        try {
            const response = await fetch('/share-text');
            if (response.ok) {
                const data = await response.json();
                displaySharedText(data.text || "");
            }
        } catch (err) {
            console.warn('Could not load shared text:', err);
        }
    }

    async function shareText(text) {
        const shareBtn = document.getElementById('clipboard-share-btn');
        if (shareBtn) shareBtn.disabled = true;
        
        try {
            const response = await fetch('/share-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
            });
            if (response.ok) {
                const textarea = document.getElementById('clipboard-textarea');
                if (textarea) textarea.value = '';
            } else {
                showNotice('Failed to share text.');
            }
        } catch (err) {
            console.error('Share text failed:', err);
            showNotice('Failed to connect to server.');
        } finally {
            if (shareBtn) shareBtn.disabled = false;
        }
    }

    function displaySharedText(text) {
        sharedTextBuffer = text;
        const container = document.getElementById('shared-text-display-container');
        const textContent = document.getElementById('shared-text-content');
        const warningCard = document.getElementById('clipboard-warning-card');

        if (!container) return;

        if (!text) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');

        // Threshold Switcher Guard (50,000 characters)
        if (text.length < 50000) {
            if (textContent) {
                textContent.textContent = text;
                textContent.classList.remove('hidden');
            }
            if (warningCard) warningCard.classList.add('hidden');
        } else {
            if (textContent) textContent.classList.add('hidden');
            if (warningCard) warningCard.classList.remove('hidden');
        }

        // Smart Parsing Engine
        runSmartParser(text);
    }

    function downloadTextPayload(text, filename = "clipboard.txt") {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function copyTextToClipboard(text, buttonElem, originalHTML) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                showFeedback();
            }).catch(err => {
                fallbackCopy();
            });
        } else {
            fallbackCopy();
        }

        function fallbackCopy() {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.top = "0";
            textArea.style.left = "0";
            textArea.style.position = "fixed";
            textArea.style.opacity = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                const successful = document.execCommand('copy');
                if (successful) {
                    showFeedback();
                } else {
                    console.error("execCommand copy returned false");
                }
            } catch (err) {
                console.error("Fallback copy failed:", err);
            }
            document.body.removeChild(textArea);
        }

        function showFeedback() {
            if (buttonElem) {
                buttonElem.innerHTML = `✓ Copied!`;
                buttonElem.style.color = '#00ff66';
                setTimeout(() => {
                    buttonElem.innerHTML = originalHTML;
                    buttonElem.style.color = '';
                }, 2000);
            }
        }
    }

    function runSmartParser(text) {
        const chipsContainer = document.getElementById('smart-chips-container');
        const chipsList = document.getElementById('smart-chips-list');

        if (!chipsContainer || !chipsList) return;

        chipsList.innerHTML = '';

        if (!text || typeof text !== 'string') {
            chipsContainer.classList.add('hidden');
            return;
        }

        // Limit parsing to first 10,000 characters to ensure 0ms latency on mobile CPUs
        const parseText = text.length > 10000 ? text.slice(0, 10000) : text;

        // ===================================================================
        // 1. URL Detection (super-fast linear regex, 0 backtracking)
        // ===================================================================
        const tlds = 'com|in|net|org|edu|gov|io|co|xyz|me|dev|app|ai|tech|live|info|biz|shop|online|club|pro|site|store|fun|space|world|us|uk|de|fr|jp|ru|br|au|ca|eu|tv|cc|ly|it|es|nl|se|pl|be|ch|at';
        const urlRegex = new RegExp(
            '(https?:\\/\\/[^\\s]+|www\\.[^\\s]+|[a-zA-Z0-9-]+\\.(?:' + tlds + ')(?:\\/[^\\s]*)?)',
            'gi'
        );

        // ===================================================================
        // 2. Email Detection
        // ===================================================================
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

        // ===================================================================
        // 3. UPI ID Detection (user@bank patterns)
        // ===================================================================
        const upiProviders = 'upi|paytm|ybl|oksbi|okaxis|okicici|okhdfcbank|ibl|apl|axisbank|sbi|icici|hdfcbank|kotak|indus|rbl|federal|axl|freecharge|phonepe|gpay|jio|slice|cred|amazonpay|mobikwik|airtel';
        const upiRegex = new RegExp(
            '[a-zA-Z0-9._%+-]+@(?:' + upiProviders + ')\\b',
            'gi'
        );

        // ===================================================================
        // 4. Phone Detection (Indian format: 10 digits starting 6-9)
        // ===================================================================
        const phoneRegex = /(?:\+91[\s-]?|0[\s-]?)?[6-9](?:[\s-]?\d){9}\b/g;

        // ===================================================================
        // 5. OTP Detection — Context-aware (keyword proximity)
        // ===================================================================
        function extractOTPs(inputText) {
            const otpKeywords = /(?:otp|code|verification|verify|pin|token|passcode|one[\s-]?time)/i;
            if (!otpKeywords.test(inputText)) return [];

            const otps = [];
            const segments = inputText.split(/[\n.!?]+/);
            for (const segment of segments) {
                if (otpKeywords.test(segment)) {
                    const nums = segment.match(/\b\d{4,6}\b/g);
                    if (nums) {
                        for (const n of nums) {
                            const num = parseInt(n, 10);
                            if (num >= 1900 && num <= 2099) continue;
                            otps.push(n);
                        }
                    }
                }
            }
            return [...new Set(otps)];
        }

        // --- Run all detectors ---
        const emails = parseText.match(emailRegex) || [];
        const upiIds = parseText.match(upiRegex) || [];
        const urls = parseText.match(urlRegex) || [];
        const phones = parseText.match(phoneRegex) || [];
        const otps = extractOTPs(parseText);

        // --- Deduplicate ---
        const uniqueEmails = [...new Set(emails)];
        const uniqueUpiIds = [...new Set(upiIds)];

        // Remove emails from URL matches (email domains can false-match as URLs)
        const emailSet = new Set(uniqueEmails.map(e => e.toLowerCase()));
        const cleanUrls = urls
            .map(url => url.replace(/[.,?!:;)]+$/, ''))
            .filter(url => {
                // Exclude if this URL is actually an email domain part
                const lower = url.toLowerCase();
                for (const email of emailSet) {
                    if (email.includes(lower) || lower.includes('@')) return false;
                }
                return true;
            });
        const uniqueUrls = [...new Set(cleanUrls)];

        // Remove UPI IDs from email matches (upi@bank shouldn't show as email)
        const upiSet = new Set(uniqueUpiIds.map(u => u.toLowerCase()));
        const filteredEmails = uniqueEmails.filter(e => !upiSet.has(e.toLowerCase()));

        const uniquePhones = [...new Set(phones.map(p => p.trim()))];

        let chipCount = 0;

        // --- Render URL chips ---
        uniqueUrls.forEach(url => {
            chipCount++;
            const chip = document.createElement('a');
            chip.className = 'smart-chip';
            let href = url;
            if (!/^https?:\/\//i.test(url)) {
                href = 'https://' + url;
            }
            chip.href = href;
            chip.target = '_blank';
            chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Open Link`;
            chipsList.appendChild(chip);
        });

        // --- Render Email chips ---
        filteredEmails.forEach(email => {
            chipCount++;
            const chip = document.createElement('a');
            chip.className = 'smart-chip';
            chip.href = `mailto:${email}`;
            chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg> ${email}`;
            chipsList.appendChild(chip);
        });

        // --- Render UPI chips ---
        uniqueUpiIds.forEach(upi => {
            chipCount++;
            const chip = document.createElement('button');
            chip.className = 'smart-chip';
            const originalHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg> Copy UPI (${upi})`;
            chip.innerHTML = originalHTML;
            chip.onclick = (e) => {
                e.stopPropagation();
                copyTextToClipboard(upi, chip, originalHTML);
            };
            chipsList.appendChild(chip);
        });

        // --- Render Phone chips ---
        uniquePhones.forEach(phone => {
            chipCount++;
            const chip = document.createElement('a');
            chip.className = 'smart-chip';
            chip.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
            chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> Call ${phone}`;
            chipsList.appendChild(chip);
        });

        // --- Render OTP chips ---
        otps.forEach(otp => {
            chipCount++;
            const chip = document.createElement('button');
            chip.className = 'smart-chip';
            const originalHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Copy OTP (${otp})`;
            chip.innerHTML = originalHTML;
            chip.onclick = (e) => {
                e.stopPropagation();
                copyTextToClipboard(otp, chip, originalHTML);
            };
            chipsList.appendChild(chip);
        });

        if (chipCount > 0) {
            chipsContainer.classList.remove('hidden');
        } else {
            chipsContainer.classList.add('hidden');
        }
    }

    function initEasterEgg() {
        const logo = document.getElementById('logo');
        const creditsModal = document.getElementById('credits-modal');
        const closeBtn = document.getElementById('credits-close');

        if (!logo || !creditsModal) return;

        logo.addEventListener('click', async function(e) {
            e.preventDefault();
            const now = Date.now();
            if (now - lastLogoClick > 3000) {
                logoClicks = 0;
            }
            logoClicks++;
            lastLogoClick = now;

            if (logoClicks === 7) {
                logoClicks = 0; // Reset
                creditsModal.classList.add('active');
                await updateSystemStats();
            }
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                creditsModal.classList.remove('active');
            });
        }

        creditsModal.onclick = (e) => {
            if (e.target === creditsModal) {
                creditsModal.classList.remove('active');
            }
        };

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && creditsModal.classList.contains('active')) {
                creditsModal.classList.remove('active');
            }
        });
    }

    async function updateSystemStats() {
        const termPort = document.getElementById('term-port');
        const termStream = document.getElementById('term-stream');
        const termActive = document.getElementById('term-active');
        const termWs = document.getElementById('term-ws');

        if (termPort) termPort.textContent = '2703';
        if (termStream) termStream.textContent = 'Ready';
        if (termWs) {
            termWs.textContent = isWsConnected ? 'Connected' : 'Disconnected';
            termWs.style.color = isWsConnected ? '#00ff66' : '#ff5f56';
        }

        try {
            const infoRes = await fetch('/info');
            if (infoRes.ok) {
                const infoData = await infoRes.json();
                if (termPort && infoData.port) {
                    termPort.textContent = infoData.port;
                }
            }
        } catch (e) {
            console.warn('Failed to query info metrics:', e);
        }

        try {
            const transfersRes = await fetch('/transfers');
            if (transfersRes.ok) {
                const transfersData = await transfersRes.json();
                const list = transfersData.transfers || [];
                const running = list.filter(t => t.status === 'running' || t.status === 'active');
                if (termActive) {
                    termActive.textContent = running.length + (running.length === 1 ? ' Stream' : ' Streams');
                    termActive.style.color = running.length > 0 ? '#fbbf24' : '';
                }
                if (termStream) {
                    termStream.textContent = running.length > 0 ? 'Active' : 'Ready';
                    termStream.style.color = running.length > 0 ? '#fbbf24' : '';
                }
            }
        } catch (e) {
            console.warn('Failed to query transfers metrics:', e);
        }
    }

    function initWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        let ws;

        try {
            ws = new WebSocket(wsUrl);

            ws.onopen = function() {
                isWsConnected = true;
                hideReconnectOverlay(); // V2 Phase 3: hide reconnect overlay on connect
                const statusLabel = document.getElementById('term-ws');
                if (statusLabel) {
                    statusLabel.textContent = 'CONNECTED';
                    statusLabel.style.color = '#00ff66';
                }
            };

            // V2: Debounced WebSocket refresh (300ms window to batch rapid updates)
            let wsRefreshTimeout = null;
            ws.onmessage = function(event) {
                if (event.data === 'refresh') {
                    clearTimeout(wsRefreshTimeout);
                    wsRefreshTimeout = setTimeout(() => {
                        loadFileList();
                        loadTransferHistory();
                    }, 300);
                } else if (event.data === 'text_refresh') {
                    loadSharedText();
                } else if (event.data === 'ip_changed') {
                    // Hotspot/network changed — refresh connection URL + QR code
                    checkConnection();
                    const qrImg = document.getElementById('qr-code-img');
                    if (qrImg) {
                        qrImg.src = '/qr?t=' + Date.now();
                    }
                }
            };

            ws.onclose = function() {
                isWsConnected = false;
                const statusLabel = document.getElementById('term-ws');
                if (statusLabel) {
                    statusLabel.textContent = 'DISCONNECTED';
                    statusLabel.style.color = '#ff5f56';
                }
                // V2 Phase 3: Show auto-reconnect countdown, then reconnect
                const RECONNECT_DELAY = 3;
                showReconnectOverlay(RECONNECT_DELAY);
                setTimeout(initWebSocket, RECONNECT_DELAY * 1000);
            };

            ws.onerror = function() {
                ws.close();
            };
        } catch (err) {
            isWsConnected = false;
            showReconnectOverlay(5);
            setTimeout(initWebSocket, 5000);
        }
    }

    function initModalScrollLock() {
        const modalObserver = new MutationObserver(() => {
            const activeModals = document.querySelectorAll('.modal-overlay.active');
            if (activeModals.length > 0) {
                document.body.classList.add('modal-open');
            } else {
                document.body.classList.remove('modal-open');
            }
        });

        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modalObserver.observe(modal, { attributes: true, attributeFilter: ['class'] });
        });
    }

    function init() {
        initModalScrollLock();
        initUploadWorker();
        initConnectionCard();
        initUploadZone();
        loadFileList();
        checkConnection();
        initWebSocket();
        initEasterEgg();

        // V2 Phase 3: New feature initializers
        initMultiSelect();
        initDownloadAll();
        initCopyUrlBtn();
        initPWA();

        // V2 Phase 4: New feature initializers

        initTransferHistory();
        initPINProtection();  // Check PIN last so other things load first

        // Load shared text on startup
        loadSharedText();

        // Clipboard listeners
        const shareBtn = document.getElementById('clipboard-share-btn');
        const textarea = document.getElementById('clipboard-textarea');
        const copyBtn = document.getElementById('clipboard-copy-btn');
        const downloadBtn = document.getElementById('clipboard-download-btn');
        const copyAnywayBtn = document.getElementById('clipboard-copy-anyway-btn');

        if (shareBtn && textarea) {
            shareBtn.onclick = () => {
                const text = textarea.value.trim();
                if (text) {
                    shareText(text);
                }
            };

            textarea.onkeydown = (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    const text = textarea.value.trim();
                    if (text) {
                        shareText(text);
                    }
                }
            };
        }

        if (copyBtn) {
            const originalHTML = copyBtn.innerHTML;
            copyBtn.onclick = () => {
                copyTextToClipboard(sharedTextBuffer, copyBtn, originalHTML);
            };
        }

        const clearBtn = document.getElementById('clipboard-clear-btn');
        if (clearBtn) {
            clearBtn.onclick = () => {
                showConfirm("Clear shared text from all devices?", () => {
                    shareText("");
                }, "Clear Text Clipboard", "Clear Text");
            };
        }

        if (downloadBtn) {
            downloadBtn.onclick = () => {
                downloadTextPayload(sharedTextBuffer);
            };
        }

        if (copyAnywayBtn) {
            const originalHTML = copyAnywayBtn.innerHTML;
            copyAnywayBtn.onclick = () => {
                copyTextToClipboard(sharedTextBuffer, copyAnywayBtn, originalHTML);
            };
        }

        const refreshBtn = document.getElementById('refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function() {
                refreshBtn.classList.add('spinning');
                loadFileList().then(function() {
                    setTimeout(function() {
                        refreshBtn.classList.remove('spinning');
                    }, 600);
                });
            });
        }

        // Refresh instantly when user tabs back or unlocks their device
        window.addEventListener('focus', function() {
            loadFileList();
            checkConnection();
            loadSharedText();
        });

        // V2 Phase 3: Close preview on browser back button
        window.addEventListener('popstate', () => {
            const previewModal = document.getElementById('preview-modal');
            if (previewModal && previewModal.classList.contains('active')) {
                closePreview();
            }
        });

        setInterval(checkConnection, 30000); // Every 30s — WS handles real-time
        setInterval(loadFileList, 60000); // Every 60s safety net — WS handles real-time refresh
    }

    document.addEventListener('DOMContentLoaded', init);

    // =======================================================================
    // V2 Phase 4: Beat All Competition
    // =======================================================================

    // -----------------------------------------------------------------------
    // Task 3: PIN Entry UI
    // -----------------------------------------------------------------------

    function initPINProtection() {
        // Ask server if PIN is required
        fetch('/pin-check')
            .then(r => r.json())
            .then(data => {
                if (data.pin_required) {
                    showPINModal();
                }
            })
            .catch(() => {/* PIN check failed — assume no PIN needed */});
    }

    function showPINModal() {
        // Build PIN modal dynamically if not present
        let modal = document.getElementById('pin-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'pin-modal';
            modal.className = 'modal-overlay active pin-modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'pin-modal-title');
            modal.innerHTML = `
                <div class="modal-content glass-card pin-card">
                    <div class="pin-header">
                        <div class="pin-lock-icon">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        </div>
                        <h3 id="pin-modal-title" class="modal-title">Enter PIN</h3>
                        <p class="pin-subtitle">This ADrop instance is protected. Enter the PIN to access.</p>
                    </div>
                    <div class="pin-input-group">
                        <input type="password" id="pin-input" class="pin-input" maxlength="12"
                               placeholder="Enter PIN" autocomplete="current-password"
                               inputmode="numeric" aria-label="PIN code">
                        <p class="pin-error hidden" id="pin-error">Incorrect PIN. Try again.</p>
                    </div>
                    <div class="modal-actions">
                        <button id="pin-submit-btn" class="glass-btn primary-btn">Unlock</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }

        const input = document.getElementById('pin-input');
        const submitBtn = document.getElementById('pin-submit-btn');
        const errorEl = document.getElementById('pin-error');

        if (input) setTimeout(() => input.focus(), 100);

        const tryPIN = async () => {
            const pin = input ? input.value.trim() : '';
            if (!pin) return;

            submitBtn.disabled = true;
            submitBtn.textContent = 'Checking...';

            try {
                const res = await fetch('/pin-verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin }),
                });

                if (res.ok) {
                    modal.classList.remove('active');
                    modal.remove();
                    // Reload data now that we're authenticated
                    loadFileList();
                    loadSharedText();
                    checkConnection();
                } else {
                    if (errorEl) errorEl.classList.remove('hidden');
                    if (input) { input.value = ''; input.focus(); }
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Unlock';
                }
            } catch (e) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Unlock';
            }
        };

        if (submitBtn) submitBtn.onclick = tryPIN;
        if (input) {
            input.onkeydown = (e) => {
                if (e.key === 'Enter') tryPIN();
                if (errorEl) errorEl.classList.add('hidden'); // Hide error on new input
            };
        }
    }

    // -----------------------------------------------------------------------
    // Task 5: Resume Upload (client-side)
    // -----------------------------------------------------------------------

    async function uploadFileWithResume(file, onComplete, onError) {
        // Check if server already has partial data for this file
        let offset = 0;
        try {
            const offsetRes = await fetch('/upload-offset?filename=' + encodeURIComponent(file.name));
            if (offsetRes.ok) {
                const offsetData = await offsetRes.json();
                offset = offsetData.offset || 0;
            }
        } catch (e) {
            offset = 0; // If check fails, start from beginning
        }

        if (offset >= file.size) {
            // File already complete on server
            if (onComplete) onComplete();
            return;
        }

        const progressSection = document.getElementById('progress-section');
        const progressFilename = document.getElementById('progress-filename');
        const progressPercent = document.getElementById('progress-percent');
        const progressBarFill = document.getElementById('progress-bar-fill');
        const progressTransferred = document.getElementById('progress-transferred');
        const progressSpeed = document.getElementById('progress-speed');
        const progressEta = document.getElementById('progress-eta');

        if (progressSection) progressSection.classList.add('active');
        const queueHint = uploadQueue.length > 0 ? ` (+${uploadQueue.length} more)` : '';
        if (progressFilename) progressFilename.textContent = file.name + (offset > 0 ? ' (resuming)' : '') + queueHint;
        if (progressBarFill) { progressBarFill.style.width = '0%'; progressBarFill.classList.remove('complete','error'); }
        if (progressSection) progressSection.classList.remove('complete','error');

        // Slice the file from the offset
        const blob = offset > 0 ? file.slice(offset) : file;
        const total = file.size;
        let loaded = offset;
        let lastLoaded = loaded;
        let lastTime = Date.now();
        let speeds = [];

        function handleComplete() {
            if (progressBarFill) { progressBarFill.style.width = '100%'; progressBarFill.classList.add('complete'); }
            if (progressSection) progressSection.classList.add('complete');
            if (progressSpeed) progressSpeed.textContent = 'Complete';
            if (progressEta) progressEta.textContent = '✓';
            playCompletionSound();
            if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
            setTimeout(() => { 
                loadFileList(); 
                loadTransferHistory();
                if (onComplete) onComplete(); 
            }, 500);
        }

        function handleError() {
            if (progressBarFill) progressBarFill.classList.add('error');
            if (progressSection) progressSection.classList.add('error');
            if (progressSpeed) progressSpeed.textContent = 'Failed';
            if (onError) onError();
        }

        let pendingProgress = null;
        let rafScheduled = false;

        // Use XHR for progress events (fetch doesn't support upload progress yet)
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                loaded = offset + e.loaded;
                const percent = (loaded / total) * 100;
                const now = Date.now();
                const dt = (now - lastTime) / 1000;
                if (dt > 0.1) {
                    const speed = (e.loaded - (lastLoaded - offset)) / dt;
                    speeds.push(speed);
                    if (speeds.length > 5) speeds.shift();
                    lastLoaded = loaded;
                    lastTime = now;
                }
                const avgSpeed = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
                const eta = avgSpeed > 0 ? (total - loaded) / avgSpeed : 0;

                pendingProgress = { percent, loaded, total, avgSpeed, eta };
                if (!rafScheduled) {
                    rafScheduled = true;
                    requestAnimationFrame(() => {
                        if (pendingProgress) {
                            if (progressBarFill) progressBarFill.style.width = pendingProgress.percent + '%';
                            if (progressPercent) progressPercent.textContent = Math.round(pendingProgress.percent) + '%';
                            if (progressTransferred) progressTransferred.textContent = formatBytes(pendingProgress.loaded) + ' / ' + formatBytes(pendingProgress.total);
                            if (progressSpeed) progressSpeed.textContent = formatBytes(pendingProgress.avgSpeed) + '/s';
                            if (progressEta) progressEta.textContent = formatDuration(pendingProgress.eta) + ' remaining';
                        }
                        rafScheduled = false;
                    });
                }
            }
        });
        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) handleComplete();
            else handleError();
        });
        xhr.addEventListener('error', handleError);
        xhr.addEventListener('abort', handleError);

        const endpoint = offset > 0 ? '/upload/resume' : '/upload/raw';
        xhr.open('POST', endpoint);
        xhr.setRequestHeader('X-Filename', file.name);
        if (offset > 0) xhr.setRequestHeader('X-Offset', String(offset));
        xhr.send(blob);
    }

    // Tasks 6 & 7: Dark/Light Theme Toggle — REMOVED per user request (dark-only)

    // -----------------------------------------------------------------------
    // Task 8: Transfer History Dashboard
    // -----------------------------------------------------------------------

    async function loadTransferHistory() {
        try {
            const res = await fetch('/transfers');
            if (!res.ok) return;
            const data = await res.json();
            renderTransferHistory(data.transfers || []);
        } catch (e) {
            console.warn('Could not load transfer history:', e);
        }
    }

    function renderTransferHistory(transfers) {
        const container = document.getElementById('transfer-history-list');
        const clearBtn = document.getElementById('clear-history-btn');
        if (!container) return;

        if (transfers.length === 0) {
            container.innerHTML = '<li class="empty-msg">No transfers yet.</li>';
            if (clearBtn) clearBtn.classList.add('hidden');
            return;
        }

        if (clearBtn) clearBtn.classList.remove('hidden');

        const fragment = document.createDocumentFragment();
        transfers.slice(0, 20).forEach(t => {  // Show latest 20
            const li = document.createElement('li');
            li.className = 'history-item';
            
            const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
            const crossSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
            const spinSvg = `<svg class="preview-spinner" style="width:12px;height:12px;border-width:2px;" viewBox="0 0 24 24"></svg>`;

            const statusIcon = t.status === 'completed' 
                ? `<span class="status-badge success" title="Completed">${checkSvg}</span>`
                : t.status === 'failed'
                ? `<span class="status-badge error" title="Failed">${crossSvg}</span>`
                : `<span class="status-badge progress" title="In Progress">${spinSvg}</span>`;

            const speed = t.speed > 0 ? formatBytes(t.speed) + '/s' : '--';
            const size = t.total_size > 0 ? formatBytes(t.total_size) : formatBytes(t.transferred);
            const elapsed = t.updated_at && t.started_at ? (t.updated_at - t.started_at).toFixed(1) + 's' : '--';
            
            const tid = t.transfer_id || t.id;

            li.innerHTML = `
                ${statusIcon}
                <div class="history-info">
                    <span class="history-name" title="${t.filename}">${t.filename}</span>
                    <span class="history-meta">${size} · ${speed}</span>
                </div>
                <span class="history-time">${elapsed}</span>
                <button type="button" class="history-delete-btn" title="Remove record" data-tid="${tid}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            `;

            const deleteBtn = li.querySelector('.history-delete-btn');
            if (deleteBtn) {
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    deleteHistoryItem(tid, li);
                };
            }

            fragment.appendChild(li);
        });

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    async function deleteHistoryItem(transferId, liElement) {
        if (!transferId) return;
        if (liElement) {
            liElement.style.opacity = '0';
            liElement.style.transform = 'translateX(20px)';
            liElement.style.transition = 'opacity 0.2s, transform 0.2s';
            setTimeout(() => liElement.remove(), 200);
        }
        try {
            const res = await fetch('/transfers/' + encodeURIComponent(transferId), { method: 'DELETE' });
            if (res.ok) {
                loadTransferHistory();
            }
        } catch (e) {
            console.warn('Failed to delete transfer record:', e);
            loadTransferHistory();
        }
    }

    async function clearAllHistory() {
        try {
            const res = await fetch('/transfers', { method: 'DELETE' });
            if (res.ok) {
                loadTransferHistory();
            }
        } catch (e) {
            console.warn('Failed to clear transfer history:', e);
        }
    }

    function initTransferHistory() {
        loadTransferHistory();
        const clearBtn = document.getElementById('clear-history-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                showConfirm('Are you sure you want to clear all transfer history records?', () => {
                    clearAllHistory();
                }, "Clear Transfer History", "Clear History");
            });
        }
    }

    // -----------------------------------------------------------------------
    // Task 9: Web Share API for downloads
    // -----------------------------------------------------------------------

    function tryWebShare(filename) {
        if (!navigator.share) return false;
        const url = window.location.origin + '/download/' + encodeURIComponent(filename);
        navigator.share({
            title: filename,
            text: 'Download ' + filename + ' from ADrop',
            url: url,
        }).catch(() => {/* User cancelled or Share failed */});
        return true;
    }

    // Expose as global for inline onclick if needed
    window._adropShare = tryWebShare;

})();
