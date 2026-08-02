/**
 * upload-worker.js — Web Worker for Background File Uploads (V2)
 *
 * Offloads file upload XHR processing to a background thread
 * so the main UI thread never blocks during transfers.
 * The UI thread stays at 60fps while this worker handles the network I/O.
 *
 * Communication Protocol:
 *   Main → Worker: { type: 'upload', file: File, url: string }
 *   Worker → Main: { type: 'progress', percent, speed, eta, transferred, total }
 *   Worker → Main: { type: 'complete', response: object }
 *   Worker → Main: { type: 'error', message: string }
 */

self.onmessage = function(event) {
    const { type, file, url } = event.data;

    if (type === 'upload') {
        uploadFile(file, url || '/upload');
    } else if (type === 'abort') {
        if (self._currentXHR) {
            self._currentXHR.abort();
        }
    }
};

/**
 * Upload a file using XMLHttpRequest with progress tracking.
 * Runs entirely in the worker thread — main thread stays free.
 *
 * @param {File} file - The file to upload
 * @param {string} url - The upload endpoint URL
 */
function uploadFile(file, url) {
    const xhr = new XMLHttpRequest();
    self._currentXHR = xhr;

    const formData = new FormData();
    formData.append('file', file);

    const startTime = Date.now();
    let lastLoaded = 0;
    let lastTime = startTime;
    let speeds = [];
    let lastReportTime = 0;

    xhr.upload.onprogress = function(e) {
        if (!e.lengthComputable) return;

        const now = Date.now();
        const timeDelta = (now - lastTime) / 1000;

        // Calculate speed at least every 100ms
        if (timeDelta >= 0.1) {
            const byteDelta = e.loaded - lastLoaded;
            const speed = byteDelta / timeDelta;

            // Rolling average of last 5 speed measurements
            speeds.push(speed);
            if (speeds.length > 5) speeds.shift();

            lastLoaded = e.loaded;
            lastTime = now;
        }

        // Throttle progress reports to max every 50ms
        if (now - lastReportTime >= 50 || e.loaded >= e.total) {
            const avgSpeed = speeds.length > 0
                ? speeds.reduce((a, b) => a + b, 0) / speeds.length
                : 0;

            const percent = (e.loaded / e.total) * 100;
            const remaining = e.total - e.loaded;
            const eta = avgSpeed > 0 ? remaining / avgSpeed : 0;

            self.postMessage({
                type: 'progress',
                percent: Math.round(percent * 10) / 10,
                speed: Math.round(avgSpeed),
                eta: Math.round(eta),
                transferred: e.loaded,
                total: e.total
            });

            lastReportTime = now;
        }
    };

    xhr.onload = function() {
        self._currentXHR = null;
        if (xhr.status >= 200 && xhr.status < 300) {
            let response;
            try {
                response = JSON.parse(xhr.responseText);
            } catch (e) {
                response = { status: 'success' };
            }

            self.postMessage({
                type: 'complete',
                response: response,
                duration: ((Date.now() - startTime) / 1000).toFixed(2)
            });
        } else {
            self.postMessage({
                type: 'error',
                message: 'Upload failed with status ' + xhr.status
            });
        }
    };

    xhr.onerror = function() {
        self._currentXHR = null;
        self.postMessage({
            type: 'error',
            message: 'Network error during upload'
        });
    };

    xhr.onabort = function() {
        self._currentXHR = null;
        self.postMessage({
            type: 'error',
            message: 'Upload aborted'
        });
    };

    xhr.open('POST', url, true);
    xhr.send(formData);
}
