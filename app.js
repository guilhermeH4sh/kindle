// eKindle Reader - Application Logic
// Handles PDF.js loading, Drag & Drop, Navigation, Touch Zones, Settings Config, Fullscreen and IndexedDB History

// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Application State
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let pageNumPending = null;
let currentBookMeta = null; // Stores { id, name, size } of the active book
let db = null;

// DOM Elements
const uploadSection = document.getElementById('upload-section');
const readerSection = document.getElementById('reader-section');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const errorMessage = document.getElementById('error-message');
const errorText = document.getElementById('error-text');

const canvas = document.getElementById('pdf-canvas');
const ctx = canvas.getContext('2d');
const loadingOverlay = document.getElementById('loading-overlay');

const btnPrev = document.getElementById('btn-prev-page');
const btnNext = document.getElementById('btn-next-page');
const btnBack = document.getElementById('btn-back');
const btnFullscreen = document.getElementById('btn-fullscreen');
const currentPageSpan = document.getElementById('current-page');
const totalPagesSpan = document.getElementById('total-pages');
const readingPercentage = document.getElementById('reading-percentage');
const pageScrubber = document.getElementById('page-scrubber');

const zonePrev = document.getElementById('zone-prev');
const zoneNext = document.getElementById('zone-next');

// Settings Elements
const sizeSlider = document.getElementById('size-slider');
const sizeVal = document.getElementById('size-val');
const themeButtons = document.querySelectorAll('.btn-theme');
const kindleScreen = document.getElementById('kindle-screen');
const kindleDevice = document.querySelector('.kindle-device');

// History Elements
const historyContainer = document.getElementById('history-container');
const historyGrid = document.getElementById('history-grid');
const btnClearHistory = document.getElementById('btn-clear-history');

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();
    
    // Initialize DB and load history
    initDB()
        .then(() => {
            loadHistoryUI();
        })
        .catch(err => {
            console.error('Falha ao inicializar banco de dados local:', err);
        });

    // Setup Event Listeners
    setupDropzoneEvents();
    setupNavigationEvents();
    setupKeyboardEvents();
    setupSettingsEvents();
    setupFullscreenEvents();
    setupHistoryEvents();
});

// ==========================================
// INDEXEDDB DATABASE OPERATIONS
// ==========================================
const DB_NAME = 'eKindleDB';
const DB_VERSION = 1;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (e) => {
            const dbInstance = e.target.result;
            if (!dbInstance.objectStoreNames.contains('books')) {
                dbInstance.createObjectStore('books', { keyPath: 'id' });
            }
        };
        
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        
        request.onerror = (e) => {
            reject(e.target.error);
        };
    });
}

function saveBookToHistory(name, size, totalPages, currentPage, pdfData) {
    if (!db) return Promise.resolve();
    
    const id = `${name}-${size}`;
    const percentage = Math.round((currentPage / totalPages) * 100);
    const bookRecord = {
        id,
        name,
        size,
        totalPages,
        currentPage,
        percentage,
        pdfData, // Stores full binary ArrayBuffer
        lastRead: new Date().getTime()
    };
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['books'], 'readwrite');
        const store = transaction.objectStore('books');
        const request = store.put(bookRecord);
        
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function updateProgressInDB(id, page) {
    if (!db) return;
    
    const transaction = db.transaction(['books'], 'readwrite');
    const store = transaction.objectStore('books');
    const getRequest = store.get(id);
    
    getRequest.onsuccess = (e) => {
        const record = e.target.result;
        if (record) {
            record.currentPage = page;
            record.percentage = Math.round((page / record.totalPages) * 100);
            record.lastRead = new Date().getTime();
            store.put(record);
        }
    };
}

function getAllBooks() {
    if (!db) return Promise.resolve([]);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['books'], 'readonly');
        const store = transaction.objectStore('books');
        const request = store.getAll();
        
        request.onsuccess = (e) => {
            const books = e.target.result || [];
            // Sort by lastRead desc to show newest first
            books.sort((a, b) => b.lastRead - a.lastRead);
            resolve(books);
        };
        
        request.onerror = (e) => reject(e.target.error);
    });
}

function getBook(id) {
    if (!db) return Promise.resolve(null);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['books'], 'readonly');
        const store = transaction.objectStore('books');
        const request = store.get(id);
        
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

function deleteBook(id) {
    if (!db) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['books'], 'readwrite');
        const store = transaction.objectStore('books');
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function clearAllBooks() {
    if (!db) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['books'], 'readwrite');
        const store = transaction.objectStore('books');
        const request = store.clear();
        
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// ==========================================
// HISTORY UI RENDERING
// ==========================================
function loadHistoryUI() {
    getAllBooks().then(books => {
        renderHistoryGrid(books);
    }).catch(err => {
        console.error('Error loading history books:', err);
    });
}

function renderHistoryGrid(books) {
    if (books.length === 0) {
        historyContainer.classList.remove('active');
        return;
    }

    historyContainer.classList.add('active');
    historyGrid.innerHTML = '';
    
    books.forEach(book => {
        const card = document.createElement('div');
        card.className = 'history-card';
        card.setAttribute('data-id', book.id);
        
        card.innerHTML = `
            <div class="book-card-icon">
                <i data-lucide="book"></i>
            </div>
            <div class="book-card-details">
                <div class="book-card-title" title="${book.name}">${book.name}</div>
                <div class="book-card-progress">
                    <div class="book-card-text">
                        <span>Página ${book.currentPage} de ${book.totalPages}</span>
                        <span>${book.percentage}% lido</span>
                    </div>
                    <div class="book-progress-bar">
                        <div class="book-progress-fill" style="width: ${book.percentage}%"></div>
                    </div>
                </div>
            </div>
            <button class="btn-delete-book" title="Excluir livro do histórico">
                <i data-lucide="trash-2"></i>
            </button>
        `;
        
        // Open book on card click
        card.addEventListener('click', (e) => {
            // Prevent triggers when clicking the delete button
            if (e.target.closest('.btn-delete-book')) return;
            
            loadBookFromHistory(book.id);
        });
        
        // Delete action listener
        const deleteBtn = card.querySelector('.btn-delete-book');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBook(book.id).then(() => {
                loadHistoryUI();
            });
        });
        
        historyGrid.appendChild(card);
    });
    
    lucide.createIcons();
}

function loadBookFromHistory(id) {
    showLoading(true);
    dropzone.classList.add('processing');
    
    getBook(id).then(book => {
        if (!book) {
            showError('Livro não encontrado no histórico.');
            dropzone.classList.remove('processing');
            return;
        }
        
        currentBookMeta = {
            id: book.id,
            name: book.name,
            size: book.size
        };
        
        // Load with stored page index
        loadPDF(book.pdfData, book.currentPage);
    }).catch(err => {
        console.error('Error fetching book from DB:', err);
        showError('Erro ao abrir o livro do histórico.');
        dropzone.classList.remove('processing');
    });
}

function setupHistoryEvents() {
    btnClearHistory.addEventListener('click', () => {
        if (confirm('Deseja limpar todo o histórico de leitura?')) {
            clearAllBooks().then(() => {
                loadHistoryUI();
            });
        }
    });
}

// ==========================================
// DROPZONE & FILE INPUT EVENTS
// ==========================================
function setupDropzoneEvents() {
    dropzone.addEventListener('click', (e) => {
        if (errorMessage.classList.contains('active')) {
            hideError();
            return;
        }
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');
        }, false);
    });

    dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    });
}

function handleFiles(files) {
    if (files.length === 0) return;
    
    const file = files[0];
    
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        showError('Arquivo inválido! Por favor, selecione um livro em formato PDF.');
        return;
    }

    hideError();
    
    const reader = new FileReader();
    dropzone.classList.add('processing');
    
    reader.onload = (e) => {
        const arrayBuffer = e.target.result;
        
        // Initialize new book metadata
        currentBookMeta = {
            id: `${file.name}-${file.size}`,
            name: file.name,
            size: file.size
        };
        
        // Reset to page 1 for new uploads
        loadPDF(arrayBuffer, 1);
    };

    reader.onerror = () => {
        showError('Ocorreu um erro ao ler o arquivo do seu dispositivo.');
        dropzone.classList.remove('processing');
    };

    reader.readAsArrayBuffer(file);
}

// ==========================================
// PDF PROCESSING & RENDERING
// ==========================================
function loadPDF(arrayBuffer, startPage = 1) {
    showLoading(true);
    
    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(pdf => {
        pdfDoc = pdf;
        pageNum = startPage;
        
        // Setup pagination values
        totalPagesSpan.textContent = pdfDoc.numPages;
        pageScrubber.max = pdfDoc.numPages;
        pageScrubber.min = 1;
        pageScrubber.value = pageNum;
        
        pageScrubber.disabled = pdfDoc.numPages <= 1;

        // Switch screens
        uploadSection.classList.remove('active');
        readerSection.classList.add('active');
        
        dropzone.classList.remove('processing');
        fileInput.value = '';
        
        // Save book to IndexedDB storage
        if (currentBookMeta) {
            saveBookToHistory(
                currentBookMeta.name,
                currentBookMeta.size,
                pdfDoc.numPages,
                pageNum,
                arrayBuffer
            );
        }
        
        // Render target page
        renderPage(pageNum);
    }).catch(error => {
        console.error('PDF loading error:', error);
        showError('Não foi possível processar o PDF. O arquivo pode estar corrompido ou protegido.');
        dropzone.classList.remove('processing');
    });
}

function renderPage(num) {
    if (!pdfDoc) return;
    
    pageRendering = true;
    showLoading(true);
    
    pdfDoc.getPage(num).then(page => {
        const screen = document.getElementById('kindle-screen');
        
        const screenWidth = screen.clientWidth;
        const screenHeight = screen.clientHeight;
        
        const viewport = page.getViewport({ scale: 1.0 });
        
        const scaleX = screenWidth / viewport.width;
        const scaleY = screenHeight / viewport.height;
        const scale = Math.min(scaleX, scaleY);
        
        const dpr = window.devicePixelRatio || 1.5;
        const renderViewport = page.getViewport({ scale: scale * dpr });
        
        canvas.width = renderViewport.width;
        canvas.height = renderViewport.height;
        
        const renderContext = {
            canvasContext: ctx,
            viewport: renderViewport
        };
        
        const renderTask = page.render(renderContext);
        
        renderTask.promise.then(() => {
            pageRendering = false;
            showLoading(false);
            
            // Auto save reading progress on page load finish
            if (currentBookMeta) {
                updateProgressInDB(currentBookMeta.id, pageNum);
            }
            
            if (pageNumPending !== null) {
                renderPage(pageNumPending);
                pageNumPending = null;
            }
        }).catch(err => {
            console.error('Error rendering page:', err);
            pageRendering = false;
            showLoading(false);
        });
    }).catch(err => {
        console.error('Error getting page:', err);
        pageRendering = false;
        showLoading(false);
    });
    
    updateNavigationUI();
}

function queueRenderPage(num) {
    if (pageRendering) {
        pageNumPending = num;
    } else {
        renderPage(num);
    }
}

function changePage(offset) {
    if (!pdfDoc) return;
    
    const targetPage = pageNum + offset;
    
    if (targetPage >= 1 && targetPage <= pdfDoc.numPages) {
        pageNum = targetPage;
        queueRenderPage(pageNum);
    }
}

function updateNavigationUI() {
    currentPageSpan.textContent = pageNum;
    pageScrubber.value = pageNum;
    
    const percentage = Math.round((pageNum / pdfDoc.numPages) * 100);
    readingPercentage.textContent = `${percentage}% lido`;
    
    btnPrev.disabled = (pageNum <= 1);
    btnNext.disabled = (pageNum >= pdfDoc.numPages);
}

function showLoading(isLoading) {
    if (isLoading) {
        loadingOverlay.classList.add('active');
    } else {
        loadingOverlay.classList.remove('active');
    }
}

// ==========================================
// NAVIGATION & SETTINGS LISTENERS
// ==========================================
function setupNavigationEvents() {
    btnPrev.addEventListener('click', () => changePage(-1));
    btnNext.addEventListener('click', () => changePage(1));
    
    zonePrev.addEventListener('click', (e) => {
        e.stopPropagation();
        changePage(-1);
    });
    
    zoneNext.addEventListener('click', (e) => {
        e.stopPropagation();
        changePage(1);
    });
    
    pageScrubber.addEventListener('input', (e) => {
        currentPageSpan.textContent = e.target.value;
        const percentage = Math.round((parseInt(e.target.value) / pdfDoc.numPages) * 100);
        readingPercentage.textContent = `${percentage}% lido`;
    });
    
    pageScrubber.addEventListener('change', (e) => {
        pageNum = parseInt(e.target.value);
        queueRenderPage(pageNum);
    });
    
    btnBack.addEventListener('click', () => {
        resetToUpload();
    });
}

function setupKeyboardEvents() {
    document.addEventListener('keydown', (e) => {
        if (!pdfDoc) return;
        
        switch (e.key) {
            case 'ArrowLeft':
            case 'PageUp':
                changePage(-1);
                break;
            case 'ArrowRight':
            case 'PageDown':
            case ' ':
                e.preventDefault();
                changePage(1);
                break;
            case 'Home':
                if (pageNum !== 1) {
                    pageNum = 1;
                    queueRenderPage(1);
                }
                break;
            case 'End':
                if (pageNum !== pdfDoc.numPages) {
                    pageNum = pdfDoc.numPages;
                    queueRenderPage(pdfDoc.numPages);
                }
                break;
        }
    });
}

function setupSettingsEvents() {
    if (sizeSlider) {
        document.documentElement.style.setProperty('--kindle-width', `${sizeSlider.value}px`);
        sizeVal.textContent = `${sizeSlider.value}px`;
        
        sizeSlider.addEventListener('input', (e) => {
            const widthValue = e.target.value;
            sizeVal.textContent = `${widthValue}px`;
            document.documentElement.style.setProperty('--kindle-width', `${widthValue}px`);
        });

        sizeSlider.addEventListener('change', () => {
            if (pdfDoc) {
                queueRenderPage(pageNum);
            }
        });
    }

    if (themeButtons && themeButtons.length > 0) {
        themeButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const selectedTheme = e.target.getAttribute('data-screen-theme');
                
                themeButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                kindleScreen.className = 'kindle-screen';
                kindleScreen.classList.add(`theme-${selectedTheme}`);
            });
        });
    }
}

function setupFullscreenEvents() {
    if (btnFullscreen && kindleDevice) {
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                kindleDevice.requestFullscreen().catch(err => {
                    console.error(`Erro ao ativar tela cheia: ${err.message}`);
                });
            } else {
                document.exitFullscreen();
            }
        });
    }

    document.addEventListener('fullscreenchange', () => {
        const isFullscreen = !!document.fullscreenElement;
        const icon = btnFullscreen.querySelector('i');
        const span = btnFullscreen.querySelector('span');
        
        if (isFullscreen) {
            icon.setAttribute('data-lucide', 'minimize');
            span.textContent = 'Sair da Tela Cheia';
        } else {
            icon.setAttribute('data-lucide', 'maximize');
            span.textContent = 'Tela Cheia';
        }
        
        lucide.createIcons();

        if (pdfDoc) {
            setTimeout(() => {
                renderPage(pageNum);
            }, 100);
        }
    });
}

// Error Handling
let errorTimeout = null;
function showError(message) {
    errorText.textContent = message;
    errorMessage.classList.add('active');
    
    dropzone.classList.add('shake');
    setTimeout(() => {
        dropzone.classList.remove('shake');
    }, 400);

    if (errorTimeout) clearTimeout(errorTimeout);
    errorTimeout = setTimeout(hideError, 4000);
}

function hideError() {
    errorMessage.classList.remove('active');
}

// Reset state and return to Home Screen
function resetToUpload() {
    pdfDoc = null;
    pageNum = 1;
    pageRendering = false;
    pageNumPending = null;
    currentBookMeta = null;
    
    // Clean canvas contents
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
    
    // Reset interface displays
    readerSection.classList.remove('active');
    uploadSection.classList.add('active');
    
    // Reload history list on home screen to reflect last read progress
    loadHistoryUI();
}

// Handle Page Resizing to maintain sharpness and perfect container fitting
let resizeDebounce = null;
window.addEventListener('resize', () => {
    if (!pdfDoc || !readerSection.classList.contains('active')) return;
    
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
        renderPage(pageNum);
    }, 150);
});
