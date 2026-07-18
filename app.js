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
const pageInput = document.getElementById('page-input');
const pageTotalSpan = document.getElementById('page-total');

// Settings Elements
const sizeSlider = document.getElementById('size-slider');
const sizeVal = document.getElementById('size-val');
const kindleScreen = document.getElementById('kindle-screen');
const kindleDevice = document.querySelector('.kindle-device');

// History Elements
const historyContainer = document.getElementById('history-container');
const historyGrid = document.getElementById('history-grid');
const btnClearHistory = document.getElementById('btn-clear-history');

// Library Elements
const librarySection = document.getElementById('library-section');
const libraryGrid = document.getElementById('library-grid');
const searchResultsContainer = document.getElementById('search-results-container');
const searchResultsGrid = document.getElementById('search-results-grid');
const librarySearchInput = document.getElementById('library-search-input');
const btnNavLibrary = document.getElementById('btn-nav-library');
const btnLibraryBack = document.getElementById('btn-library-back');
const btnLibrarySearch = document.getElementById('btn-library-search');
const btnClearSearchResults = document.getElementById('btn-clear-search-results');

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide Icons
    lucide.createIcons();
    
    // Initialize DB, run auto-cleanup on corrupted old entries, and load history UI
    initDB()
        .then(() => {
            return validateAndCleanHistory();
        })
        .then(() => {
            loadHistoryUI();
            loadLibraryUI();
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
    setupLibraryEvents();
    setupThemeEvents();
    setupLogoEvents();
    setupModalEvents();
});

// ==========================================
// INDEXEDDB DATABASE OPERATIONS
// ==========================================
const DB_NAME = 'GUIDB';
const DB_VERSION = 2;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (e) => {
            const dbInstance = e.target.result;
            if (!dbInstance.objectStoreNames.contains('books')) {
                dbInstance.createObjectStore('books', { keyPath: 'id' });
            }
            if (!dbInstance.objectStoreNames.contains('library')) {
                dbInstance.createObjectStore('library', { keyPath: 'id' });
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
    
    // Convert ArrayBuffer to Blob for universal structured cloning support in IndexedDB
    const pdfBlob = pdfData instanceof Blob ? pdfData : new Blob([pdfData], { type: 'application/pdf' });
    
    const bookRecord = {
        id,
        name,
        size,
        totalPages,
        currentPage,
        percentage,
        pdfData: pdfBlob, 
        lastRead: new Date().getTime()
    };
    
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(['books'], 'readwrite');
            const store = transaction.objectStore('books');
            const request = store.put(bookRecord);
            
            request.onsuccess = () => {
                if (percentage === 100) {
                    checkAndAddToLibrary(bookRecord);
                }
                resolve();
            };
            request.onerror = (e) => {
                const error = e.target.error;
                console.error("IndexedDB put error:", error);
                if (error && error.name === 'QuotaExceededError') {
                    showError('Espaço insuficiente. O arquivo é muito grande para salvar no histórico local.');
                }
                reject(error);
            };
            
            transaction.onabort = (e) => {
                const error = transaction.error;
                console.error("IndexedDB transaction aborted:", error);
                if (error && error.name === 'QuotaExceededError') {
                    showError('Espaço insuficiente. O arquivo é muito grande para salvar no histórico local.');
                }
                reject(error);
            };
            
            transaction.onerror = (e) => {
                console.error("IndexedDB transaction error:", e.target.error);
            };
        } catch (err) {
            console.error("Failed to create transaction or put record:", err);
            reject(err);
        }
    });
}

function updateProgressInDB(id, page) {
    if (!db) return;
    
    try {
        const transaction = db.transaction(['books'], 'readwrite');
        const store = transaction.objectStore('books');
        const getRequest = store.get(id);
        
        getRequest.onsuccess = (e) => {
            const record = e.target.result;
            if (record) {
                record.currentPage = page;
                record.percentage = Math.round((page / record.totalPages) * 100);
                record.lastRead = new Date().getTime();
                
                const putRequest = store.put(record);
                putRequest.onsuccess = () => {
                    if (record.percentage === 100) {
                        checkAndAddToLibrary(record);
                    }
                };
                putRequest.onerror = (err) => {
                    console.error("Error updating progress in DB:", err);
                };
            }
        };
        
        getRequest.onerror = (err) => {
            console.error("Error getting book to update progress:", err);
        };
    } catch (err) {
        console.error("Failed to update progress transaction:", err);
    }
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

function getLibraryBook(id) {
    if (!db) return Promise.resolve(null);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['library'], 'readonly');
        const store = transaction.objectStore('library');
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
                ${book.cover ? `<img src="${book.cover}" alt="Capa">` : `<i data-lucide="book"></i>`}
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
            showCustomConfirm('Deseja excluir este livro do seu histórico de leitura?', 'Excluir do Histórico').then(confirmed => {
                if (confirmed) {
                    deleteBook(book.id).then(() => {
                        loadHistoryUI();
                    });
                }
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
        // Case (b): Book record not found in IndexedDB
        if (!book) {
            console.error(`[Error] Book record with ID ${id} not found in IndexedDB.`);
            showError('Registro do livro não encontrado no histórico.');
            dropzone.classList.remove('processing');
            return;
        }
        
        // Case (b): Binary PDF data is missing in the record
        if (!book.pdfData) {
            console.error(`[Error] PDF binary data is missing in record for book: ${book.name}`);
            showError('Arquivo não encontrado no armazenamento local. Por favor, importe novamente.');
            dropzone.classList.remove('processing');
            
            // Auto delete invalid entry from history
            deleteBook(id).then(() => {
                loadHistoryUI();
            });
            return;
        }
        
        currentBookMeta = {
            id: book.id,
            name: book.name,
            size: book.size
        };
        
        // Case (c): Convert Blob back to ArrayBuffer, handling FileReader errors
        if (book.pdfData instanceof Blob) {
            // Check if the Blob is too small (e.g. empty or corrupted)
            if (book.pdfData.size < 100) {
                console.error(`[Error] PDF Blob is corrupted or empty (size: ${book.pdfData.size} bytes).`);
                showError('O arquivo salvo no histórico está corrompido. Por favor, importe novamente.');
                dropzone.classList.remove('processing');
                deleteBook(id).then(() => {
                    loadHistoryUI();
                });
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const arrayBuffer = e.target.result;
                loadPDFFromHistory(arrayBuffer, book.currentPage, id);
            };
            reader.onerror = (err) => {
                console.error('[Error] Failed to read PDF Blob from database:', err);
                showError('Falha ao ler o arquivo armazenado no histórico.');
                dropzone.classList.remove('processing');
            };
            reader.readAsArrayBuffer(book.pdfData);
        } else if (book.pdfData instanceof ArrayBuffer) {
            if (book.pdfData.byteLength < 100) {
                console.error(`[Error] PDF ArrayBuffer is corrupted or empty (byteLength: ${book.pdfData.byteLength} bytes).`);
                showError('O arquivo salvo no histórico está corrompido. Por favor, importe novamente.');
                dropzone.classList.remove('processing');
                deleteBook(id).then(() => {
                    loadHistoryUI();
                });
                return;
            }
            loadPDFFromHistory(book.pdfData, book.currentPage, id);
        } else {
            console.error('[Error] Unsupported pdfData type in IndexedDB:', typeof book.pdfData);
            showError('Formato de dados não suportado no histórico local.');
            dropzone.classList.remove('processing');
        }
    }).catch(err => {
        console.error('[Error] Failed to query IndexedDB:', err);
        showError('Erro ao consultar o banco de dados do histórico.');
        dropzone.classList.remove('processing');
    });
}

function loadPDFFromHistory(arrayBuffer, startPage = 1, bookId) {
    showLoading(true);
    
    // Create a copy of the ArrayBuffer before passing it to PDF.js, to prevent neutering issues
    const arrayBufferCopy = arrayBuffer.slice(0);
    
    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(pdf => {
        pdfDoc = pdf;
        pageNum = startPage;
        
        // Setup pagination values
        if (totalPagesSpan) totalPagesSpan.textContent = pdfDoc.numPages;
        if (pageTotalSpan) pageTotalSpan.textContent = pdfDoc.numPages;
        if (pageInput) {
            pageInput.max = pdfDoc.numPages;
            pageInput.value = pageNum;
        }
        if (pageScrubber) {
            pageScrubber.max = pdfDoc.numPages;
            pageScrubber.min = 1;
            pageScrubber.value = pageNum;
            pageScrubber.disabled = pdfDoc.numPages <= 1;
        }

        // Switch screens
        navigateTo('reader');
        
        dropzone.classList.remove('processing');
        fileInput.value = '';
        
        // Save book to IndexedDB storage to refresh timestamp using the safe copy
        if (currentBookMeta) {
            saveBookToHistory(
                currentBookMeta.name,
                currentBookMeta.size,
                pdfDoc.numPages,
                pageNum,
                arrayBufferCopy
            ).then(() => {
                // Check if book cover is missing, if so generate it in background
                if (bookId) {
                    getBook(bookId).then(bookRecord => {
                        if (bookRecord && !bookRecord.cover) {
                            generateCover(pdfDoc).then(coverDataUrl => {
                                if (coverDataUrl) {
                                    saveBookCover(bookId, coverDataUrl);
                                }
                            });
                        }
                    });
                }
            });
        }
        
        // Render target page
        renderPage(pageNum);
    }).catch(error => {
        console.error('[Error] PDF.js failed to parse history PDF data:', error);
        if (error.name === 'PasswordException') {
            showError('O PDF do histórico está protegido por senha.');
        } else {
            showError('Erro ao carregar o PDF do histórico: o arquivo armazenado está inválido.');
            // Auto delete invalid entry from history
            deleteBook(bookId).then(() => {
                loadHistoryUI();
            });
        }
        dropzone.classList.remove('processing');
    });
}

function validateAndCleanHistory() {
    return getAllBooks().then(books => {
        const deletePromises = [];
        books.forEach(book => {
            let isInvalid = false;
            
            // Check if pdfData is missing
            if (!book.pdfData) {
                isInvalid = true;
            } 
            // Check if pdfData is too small (e.g. empty or corrupted text)
            else if (book.pdfData instanceof Blob && book.pdfData.size < 100) {
                isInvalid = true;
            } 
            else if (book.pdfData instanceof ArrayBuffer && book.pdfData.byteLength < 100) {
                isInvalid = true;
            }
            
            if (isInvalid) {
                console.warn(`Deleting invalid/corrupted history record: ${book.name} (${book.id})`);
                deletePromises.push(deleteBook(book.id));
            }
        });
        
        if (deletePromises.length > 0) {
            return Promise.all(deletePromises);
        }
    }).catch(err => {
        console.error('Error during history validation:', err);
    });
}

function setupHistoryEvents() {
    btnClearHistory.addEventListener('click', () => {
        showCustomConfirm('Deseja limpar todo o histórico de leitura?', 'Limpar Histórico').then(confirmed => {
            if (confirmed) {
                clearAllBooks().then(() => {
                    loadHistoryUI();
                });
            }
        });
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
    
    // Create a copy of the ArrayBuffer before passing it to PDF.js, to prevent neutering issues
    const arrayBufferCopy = arrayBuffer.slice(0);
    
    pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(pdf => {
        pdfDoc = pdf;
        pageNum = startPage;
        
        // Setup pagination values
        if (totalPagesSpan) totalPagesSpan.textContent = pdfDoc.numPages;
        if (pageTotalSpan) pageTotalSpan.textContent = pdfDoc.numPages;
        if (pageInput) {
            pageInput.max = pdfDoc.numPages;
            pageInput.value = pageNum;
        }
        if (pageScrubber) {
            pageScrubber.max = pdfDoc.numPages;
            pageScrubber.min = 1;
            pageScrubber.value = pageNum;
            pageScrubber.disabled = pdfDoc.numPages <= 1;
        }

        // Switch screens
        navigateTo('reader');
        
        dropzone.classList.remove('processing');
        fileInput.value = '';
        
        // Save book to IndexedDB storage using the safe copy
        if (currentBookMeta) {
            const filenameEl = document.getElementById('reader-filename');
            if (filenameEl) {
                filenameEl.textContent = currentBookMeta.name;
            }
            const bookId = currentBookMeta.id;
            saveBookToHistory(
                currentBookMeta.name,
                currentBookMeta.size,
                pdfDoc.numPages,
                pageNum,
                arrayBufferCopy
            ).then(() => {
                // Generate cover in background (non-blocking)
                generateCover(pdfDoc).then(coverDataUrl => {
                    if (coverDataUrl) {
                        saveBookCover(bookId, coverDataUrl);
                    }
                });
            });
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
    if (currentPageSpan) currentPageSpan.textContent = pageNum;
    if (pageInput) pageInput.value = pageNum;
    if (pageScrubber) pageScrubber.value = pageNum;
    
    if (readingPercentage) {
        const percentage = Math.round((pageNum / pdfDoc.numPages) * 100);
        readingPercentage.textContent = `${percentage}% lido`;
    }
    
    if (btnPrev) btnPrev.disabled = (pageNum <= 1);
    if (btnNext) btnNext.disabled = (pageNum >= pdfDoc.numPages);
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
    if (btnPrev) btnPrev.addEventListener('click', () => changePage(-1));
    if (btnNext) btnNext.addEventListener('click', () => changePage(1));
    
    if (zonePrev) {
        zonePrev.addEventListener('click', (e) => {
            e.stopPropagation();
            changePage(-1);
        });
    }
    
    if (zoneNext) {
        zoneNext.addEventListener('click', (e) => {
            e.stopPropagation();
            changePage(1);
        });
    }
    
    if (pageScrubber) {
        pageScrubber.addEventListener('input', (e) => {
            if (currentPageSpan) currentPageSpan.textContent = e.target.value;
            if (readingPercentage) {
                const percentage = Math.round((parseInt(e.target.value) / pdfDoc.numPages) * 100);
                readingPercentage.textContent = `${percentage}% lido`;
            }
        });
        
        pageScrubber.addEventListener('change', (e) => {
            pageNum = parseInt(e.target.value);
            queueRenderPage(pageNum);
        });
    }
    
    if (btnBack) {
        btnBack.addEventListener('click', () => {
            resetToUpload();
        });
    }

    if (pageInput) {
        pageInput.addEventListener('change', (e) => {
            if (!pdfDoc) return;
            let targetPage = parseInt(e.target.value);
            if (isNaN(targetPage) || targetPage < 1) {
                targetPage = 1;
            } else if (targetPage > pdfDoc.numPages) {
                targetPage = pdfDoc.numPages;
            }
            pageNum = targetPage;
            e.target.value = pageNum;
            queueRenderPage(pageNum);
        });

        pageInput.addEventListener('keydown', (e) => {
            e.stopPropagation(); // Evita ativar navegação global por teclado enquanto digita
            if (e.key === 'Enter') {
                pageInput.blur();
            }
        });
    }
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
            
            // Re-render the PDF page in real-time as the slider moves to fit width changes
            if (pdfDoc) {
                queueRenderPage(pageNum);
            }
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
    
    // Reset interface displays and reload view
    navigateTo(previousView || 'home');
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

// ==========================================
// THEME SWITCHER (LIGHT/DARK MODE)
// ==========================================
function setupThemeEvents() {
    const btnHomeToggle = document.getElementById('btn-theme-toggle');
    const btnReaderToggle = document.getElementById('btn-reader-theme-toggle');
    
    // Check saved theme or use system preference
    const savedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        updateThemeIcons(true);
    } else {
        document.body.classList.remove('dark-theme');
        updateThemeIcons(false);
    }
    
    function toggleTheme() {
        const isDark = document.body.classList.toggle('dark-theme');
        localStorage.setItem('theme', isDark ? 'dark' : 'light');
        updateThemeIcons(isDark);
        
        // Recreate icons to sync styling if necessary
        lucide.createIcons();
    }
    
    function updateThemeIcons(isDark) {
        const sunIcons = document.querySelectorAll('.theme-icon-sun');
        const moonIcons = document.querySelectorAll('.theme-icon-moon');
        
        sunIcons.forEach(sun => {
            sun.style.display = isDark ? 'block' : 'none';
        });
        moonIcons.forEach(moon => {
            moon.style.display = isDark ? 'none' : 'block';
        });
    }
    
    if (btnHomeToggle) {
        btnHomeToggle.addEventListener('click', toggleTheme);
    }
    if (btnReaderToggle) {
        btnReaderToggle.addEventListener('click', toggleTheme);
    }
}

let previousView = 'home';

function navigateTo(view) {
    if (view === 'home') {
        uploadSection.classList.add('active');
        readerSection.classList.remove('active');
        librarySection.classList.remove('active');
        document.body.classList.remove('reader-active');
        loadHistoryUI();
    } else if (view === 'library') {
        uploadSection.classList.remove('active');
        readerSection.classList.remove('active');
        librarySection.classList.add('active');
        document.body.classList.remove('reader-active');
        loadLibraryUI();
    } else if (view === 'reader') {
        uploadSection.classList.remove('active');
        readerSection.classList.add('active');
        librarySection.classList.remove('active');
        document.body.classList.add('reader-active');
    }
}

// ==========================================
// LIBRARY DB OPERATIONS & UI
// ==========================================
function saveBookToLibrary(bookRecord) {
    if (!db) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(['library'], 'readwrite');
            const store = transaction.objectStore('library');
            const request = store.put(bookRecord);
            
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        } catch (err) {
            reject(err);
        }
    });
}

function getAllLibraryBooks() {
    if (!db) return Promise.resolve([]);
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['library'], 'readonly');
        const store = transaction.objectStore('library');
        const request = store.getAll();
        
        request.onsuccess = (e) => {
            const books = e.target.result || [];
            books.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
            resolve(books);
        };
        
        request.onerror = (e) => reject(e.target.error);
    });
}

function deleteBookFromLibrary(id) {
    if (!db) return Promise.resolve();
    
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['library'], 'readwrite');
        const store = transaction.objectStore('library');
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function checkAndAddToLibrary(bookRecord) {
    if (!db) return;
    
    getAllLibraryBooks().then(libraryBooks => {
        const normalize = str => str ? str.toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9]/g, '') : '';
        const recordNameNormalized = normalize(bookRecord.name || bookRecord.title);
        
        const isDuplicate = libraryBooks.some(libBook => {
            if (libBook.id === bookRecord.id) return true;
            const libNormalized = normalize(libBook.name || libBook.title);
            return libNormalized && recordNameNormalized && (libNormalized === recordNameNormalized);
        });
        
        if (isDuplicate) {
            console.log("Book is already in the library, skipping auto-addition to avoid duplicates.");
            return;
        }
        
        const libraryRecord = {
            id: bookRecord.id,
            name: bookRecord.name,
            title: bookRecord.name,
            author: 'PDF Local',
            cover: bookRecord.cover || null,
            currentPage: bookRecord.currentPage,
            totalPages: bookRecord.totalPages,
            percentage: bookRecord.percentage,
            addedAt: new Date().getTime(),
            hasPdf: true
        };
        
        saveBookToLibrary(libraryRecord).then(() => {
            console.log("Book auto-added to library upon reaching 100% progress:", bookRecord.name);
            if (librarySection && librarySection.classList.contains('active')) {
                loadLibraryUI();
            }
        }).catch(err => {
            console.error("Failed to auto-add book to library:", err);
        });
    });
}

function loadBookFromLibrary(id) {
    getBook(id).then(book => {
        if (book && book.pdfData) {
            previousView = 'library';
            loadBookFromHistory(id);
        } else {
            getLibraryBook(id).then(libBook => {
                if (libBook && libBook.downloadUrl) {
                    showCustomConfirm('Este livro ainda não possui um arquivo PDF local para leitura. Deseja abrir a página de download do PDF para baixá-lo?', 'Baixar Livro').then(confirmed => {
                        if (confirmed) {
                            window.open(libBook.downloadUrl, '_blank');
                        }
                    });
                } else {
                    showCustomAlert('Este livro foi adicionado como referência bibliográfica e não possui um arquivo PDF disponível para leitura.', 'Referência');
                }
            });
        }
    });
}

function loadLibraryUI() {
    getAllLibraryBooks().then(books => {
        renderLibraryGrid(books);
    }).catch(err => {
        console.error('Error loading library books:', err);
    });
}

function renderLibraryGrid(books) {
    if (!libraryGrid) return;
    libraryGrid.innerHTML = '';
    
    if (books.length === 0) {
        libraryGrid.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                Nenhum livro salvo na biblioteca.
            </div>
        `;
        return;
    }
    
    books.forEach(book => {
        const card = document.createElement('div');
        card.className = 'history-card';
        card.setAttribute('data-id', book.id);
        
        const displayTitle = book.title || book.name;
        const displayAuthor = book.author || 'Autor desconhecido';
        
        let progressHtml = '';
        if (book.percentage !== undefined && book.percentage !== null) {
            progressHtml = `
                <div class="book-card-progress">
                    <div class="book-card-text">
                        <span>Página ${book.currentPage || 0} de ${book.totalPages || 0}</span>
                        <span>${book.percentage}% lido</span>
                    </div>
                    <div class="book-progress-bar">
                        <div class="book-progress-fill" style="width: ${book.percentage}%"></div>
                    </div>
                </div>
            `;
        } else {
            progressHtml = `
                <div class="book-card-progress">
                    <div class="book-card-text">
                        <span>${displayAuthor}</span>
                    </div>
                </div>
            `;
        }
        
        let iconHtml = `
            <div class="book-card-icon">
                ${book.cover ? `<img src="${book.cover}" alt="Capa">` : `<i data-lucide="book"></i>`}
            </div>
        `;
        
        card.innerHTML = `
            ${iconHtml}
            <div class="book-card-details">
                <div class="book-card-title" title="${displayTitle}">${displayTitle}</div>
                ${progressHtml}
            </div>
            <button class="btn-delete-book" title="Excluir livro da biblioteca">
                <i data-lucide="trash-2"></i>
            </button>
        `;
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-delete-book')) return;
            loadBookFromLibrary(book.id);
        });
        
        const deleteBtn = card.querySelector('.btn-delete-book');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showCustomConfirm('Deseja excluir este livro da sua biblioteca?', 'Excluir Livro').then(confirmed => {
                if (confirmed) {
                    deleteBookFromLibrary(book.id).then(() => {
                        loadLibraryUI();
                    });
                }
            });
        });
        
        libraryGrid.appendChild(card);
    });
    
    lucide.createIcons();
}

// ==========================================
// LIBRARY SEARCH (GOOGLE BOOKS API)
// ==========================================
function performLibrarySearch() {
    if (!librarySearchInput) return;
    const query = librarySearchInput.value.trim();
    if (!query) return;
    
    if (searchResultsGrid) {
        searchResultsGrid.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                Buscando livros...
            </div>
        `;
    }
    if (searchResultsContainer) searchResultsContainer.style.display = 'block';
    
    // Tenta primeiro a API do Google Books
    fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`)
        .then(response => {
            if (!response.ok) {
                throw new Error(`Google Books HTTP error ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            renderSearchResults(data.items || []);
        })
        .catch(err => {
            console.warn('Google Books API falhou, tentando fallback da Open Library...', err);
            
            // Fallback para a Open Library API
            fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=10`)
                .then(olResponse => {
                    if (!olResponse.ok) {
                        throw new Error(`Open Library HTTP error ${olResponse.status}`);
                    }
                    return olResponse.json();
                })
                .then(olData => {
                    renderOpenLibraryResults(olData.docs || []);
                })
                .catch(olErr => {
                    console.error('Todas as APIs de livros falharam:', olErr);
                    if (searchResultsGrid) {
                        searchResultsGrid.innerHTML = `
                            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500; line-height: 1.4; max-width: 480px; margin: 0 auto;">
                                Não foi possível carregar resultados da busca externa. Verifique sua conexão com a internet e tente novamente.
                            </div>
                        `;
                    }
                });
        });
}

function renderOpenLibraryResults(docs) {
    if (!searchResultsGrid) return;
    searchResultsGrid.innerHTML = '';
    
    // Filtra apenas livros que possuem identificador do Internet Archive (IA) e são de domínio público (acesso livre, sem empréstimo)
    const docsWithPdf = docs.filter(doc => doc.ia && doc.ia.length > 0 && doc.ebook_access === 'public');
    
    if (docsWithPdf.length === 0) {
        searchResultsGrid.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                Nenhum livro com PDF disponível encontrado.
            </div>
        `;
        return;
    }
    
    docsWithPdf.forEach(doc => {
        const title = doc.title || 'Título desconhecido';
        const authors = doc.author_name ? doc.author_name.join(', ') : 'Autor desconhecido';
        const coverId = doc.cover_i;
        const secureThumbnail = coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null;
        
        const iaId = doc.ia[0];
        const pdfUrl = `https://archive.org/download/${iaId}/${iaId}.pdf`;
        
        const card = document.createElement('div');
        card.className = 'history-card';
        card.style.cursor = 'pointer';
        
        card.innerHTML = `
            <div class="book-card-icon">
                ${secureThumbnail ? `<img src="${secureThumbnail}" alt="Capa">` : `<i data-lucide="book"></i>`}
            </div>
            <div class="book-card-details">
                <div class="book-card-title" title="${title}">${title}</div>
                <div class="book-card-progress">
                    <div class="book-card-text">
                        <span>${authors}</span>
                    </div>
                </div>
            </div>
            <button class="btn-add-library" title="Adicionar à biblioteca">
                <i data-lucide="plus"></i>
            </button>
        `;
        
        const addHandler = (e) => {
            e.stopPropagation();
            
            const workId = doc.key ? doc.key.replace(/^\/works\//, '') : Math.random().toString(36).substr(2, 9);
            
            const libraryRecord = {
                id: `api-ol-${workId}`,
                name: title,
                title: title,
                author: authors,
                cover: secureThumbnail,
                addedAt: new Date().getTime(),
                hasPdf: false,
                downloadUrl: pdfUrl
            };
            
            getAllLibraryBooks().then(libraryBooks => {
                const normalize = str => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
                const titleNormalized = normalize(title);
                
                const isDuplicate = libraryBooks.some(libBook => {
                    if (libBook.id === libraryRecord.id) return true;
                    const libNormalized = normalize(libBook.name || libBook.title);
                    return libNormalized && titleNormalized && (libNormalized === titleNormalized);
                });
                
                if (isDuplicate) {
                    showCustomAlert('Este livro já está na sua biblioteca!', 'Aviso');
                    return;
                }
                
                saveBookToLibrary(libraryRecord).then(() => {
                    showCustomAlert('Livro adicionado à biblioteca com sucesso!', 'Sucesso');
                    loadLibraryUI();
                }).catch(err => {
                    console.error('Failed to add search book to library:', err);
                    showCustomAlert('Ocorreu um erro ao adicionar o livro.', 'Erro');
                });
            });
        };
        
        card.addEventListener('click', addHandler);
        searchResultsGrid.appendChild(card);
    });
    
    lucide.createIcons();
}

function renderSearchResults(items) {
    if (!searchResultsGrid) return;
    searchResultsGrid.innerHTML = '';
    
    // Filtra apenas resultados que possuem PDF disponível e de domínio público (sem DRM ou restrição)
    const itemsWithPdf = items.filter(item => {
        const accessInfo = item.accessInfo || {};
        const pdf = accessInfo.pdf || {};
        return pdf.isAvailable && pdf.downloadLink && accessInfo.publicDomain;
    });
    
    if (itemsWithPdf.length === 0) {
        searchResultsGrid.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                Nenhum livro com PDF disponível encontrado.
            </div>
        `;
        return;
    }
    
    itemsWithPdf.forEach(item => {
        const volumeInfo = item.volumeInfo || {};
        const title = volumeInfo.title || 'Título desconhecido';
        const authors = volumeInfo.authors ? volumeInfo.authors.join(', ') : 'Autor desconhecido';
        const imageLinks = volumeInfo.imageLinks || {};
        const thumbnail = imageLinks.thumbnail || imageLinks.smallThumbnail || null;
        const secureThumbnail = thumbnail ? thumbnail.replace(/^http:/i, 'https:') : null;
        
        const accessInfo = item.accessInfo || {};
        const pdf = accessInfo.pdf || {};
        const downloadUrl = pdf.downloadLink || item.volumeInfo.infoLink || null;
        
        const card = document.createElement('div');
        card.className = 'history-card';
        card.style.cursor = 'pointer';
        
        card.innerHTML = `
            <div class="book-card-icon">
                ${secureThumbnail ? `<img src="${secureThumbnail}" alt="Capa">` : `<i data-lucide="book"></i>`}
            </div>
            <div class="book-card-details">
                <div class="book-card-title" title="${title}">${title}</div>
                <div class="book-card-progress">
                    <div class="book-card-text">
                        <span>${authors}</span>
                    </div>
                </div>
            </div>
            <button class="btn-add-library" title="Adicionar à biblioteca">
                <i data-lucide="plus"></i>
            </button>
        `;
        
        const addHandler = (e) => {
            e.stopPropagation();
            
            const libraryRecord = {
                id: `api-${item.id}`,
                name: title,
                title: title,
                author: authors,
                cover: thumbnail ? thumbnail.replace(/^http:/i, 'https:') : null,
                addedAt: new Date().getTime(),
                hasPdf: false,
                downloadUrl: downloadUrl
            };
            
            getAllLibraryBooks().then(libraryBooks => {
                const normalize = str => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
                const titleNormalized = normalize(title);
                
                const isDuplicate = libraryBooks.some(libBook => {
                    if (libBook.id === libraryRecord.id) return true;
                    const libNormalized = normalize(libBook.name || libBook.title);
                    return libNormalized && titleNormalized && (libNormalized === titleNormalized);
                });
                
                if (isDuplicate) {
                    showCustomAlert('Este livro já está na sua biblioteca!', 'Aviso');
                    return;
                }
                
                saveBookToLibrary(libraryRecord).then(() => {
                    showCustomAlert('Livro adicionado à biblioteca com sucesso!', 'Sucesso');
                    loadLibraryUI();
                }).catch(err => {
                    console.error('Failed to add search book to library:', err);
                    showCustomAlert('Ocorreu um erro ao adicionar o livro.', 'Erro');
                });
            });
        };
        
        card.addEventListener('click', addHandler);
        
        searchResultsGrid.appendChild(card);
    });
    
    lucide.createIcons();
}

function setupLibraryEvents() {
    if (btnNavLibrary) {
        btnNavLibrary.addEventListener('click', () => {
            previousView = 'library';
            navigateTo('library');
        });
    }
    
    if (btnLibraryBack) {
        btnLibraryBack.addEventListener('click', () => {
            previousView = 'home';
            navigateTo('home');
        });
    }
    
    if (btnLibrarySearch) {
        btnLibrarySearch.addEventListener('click', () => {
            performLibrarySearch();
        });
    }
    
    if (librarySearchInput) {
        librarySearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                performLibrarySearch();
            }
        });
    }
    
    if (btnClearSearchResults) {
        btnClearSearchResults.addEventListener('click', () => {
            if (librarySearchInput) librarySearchInput.value = '';
            if (searchResultsGrid) searchResultsGrid.innerHTML = '';
            if (searchResultsContainer) searchResultsContainer.style.display = 'none';
        });
    }
}

function setupLogoEvents() {
    const logoContainer = document.querySelector('.header-logo');
    if (logoContainer) {
        logoContainer.addEventListener('click', () => {
            if (readerSection && readerSection.classList.contains('active')) {
                resetToUpload();
            } else {
                navigateTo('home');
            }
        });
    }
}

let confirmPromiseResolve = null;

function showCustomConfirm(message, title = 'Confirmar Ação') {
    const modal = document.getElementById('confirm-modal');
    const modalTitle = document.getElementById('confirm-modal-title');
    const modalMessage = document.getElementById('confirm-modal-message');
    
    if (!modal || !modalTitle || !modalMessage) {
        return Promise.resolve(confirm(message));
    }
    
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    
    modal.style.display = 'flex';
    modal.offsetHeight; // trigger reflow
    modal.classList.add('active');
    
    return new Promise((resolve) => {
        confirmPromiseResolve = resolve;
    });
}

function closeCustomConfirm(result) {
    const modal = document.getElementById('confirm-modal');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 200);
    }
    if (confirmPromiseResolve) {
        confirmPromiseResolve(result);
        confirmPromiseResolve = null;
    }
}

function showCustomAlert(message, title = 'Aviso') {
    const btnCancel = document.getElementById('confirm-modal-cancel');
    if (btnCancel) btnCancel.style.display = 'none';
    
    const btnOk = document.getElementById('confirm-modal-ok');
    const oldText = btnOk ? btnOk.textContent : 'Confirmar';
    const oldClass = btnOk ? btnOk.className : 'btn-modal btn-modal-ok';
    
    if (btnOk) {
        btnOk.textContent = 'Ok';
        btnOk.className = 'btn-modal btn-modal-ok alert-ok-style';
    }
    
    return showCustomConfirm(message, title).then(result => {
        if (btnCancel) btnCancel.style.display = '';
        if (btnOk) {
            btnOk.textContent = oldText;
            btnOk.className = oldClass;
        }
        return result;
    });
}

function setupModalEvents() {
    const btnCancel = document.getElementById('confirm-modal-cancel');
    const btnOk = document.getElementById('confirm-modal-ok');
    const modal = document.getElementById('confirm-modal');
    
    if (btnCancel) {
        btnCancel.addEventListener('click', () => closeCustomConfirm(false));
    }
    if (btnOk) {
        btnOk.addEventListener('click', () => closeCustomConfirm(true));
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeCustomConfirm(false);
            }
        });
    }
}

function generateCover(pdf) {
    if (!pdf) return Promise.resolve(null);
    return pdf.getPage(1).then(page => {
        const viewport = page.getViewport({ scale: 1.0 });
        const scale = 120 / viewport.width;
        const thumbViewport = page.getViewport({ scale: scale });
        
        const canvasOff = document.createElement('canvas');
        canvasOff.width = thumbViewport.width;
        canvasOff.height = thumbViewport.height;
        const ctxOff = canvasOff.getContext('2d');
        
        const renderContext = {
            canvasContext: ctxOff,
            viewport: thumbViewport
        };
        
        return page.render(renderContext).promise.then(() => {
            try {
                return canvasOff.toDataURL('image/jpeg', 0.6);
            } catch (e) {
                console.error('Error exporting canvas to DataURL:', e);
                return null;
            }
        });
    }).catch(err => {
        console.error('Error generating PDF cover:', err);
        return null;
    });
}

function saveBookCover(bookId, coverDataUrl) {
    if (!db || !coverDataUrl) return;
    
    try {
        const transaction = db.transaction(['books', 'library'], 'readwrite');
        const booksStore = transaction.objectStore('books');
        const libraryStore = transaction.objectStore('library');
        
        const getBookReq = booksStore.get(bookId);
        getBookReq.onsuccess = (e) => {
            const record = e.target.result;
            if (record) {
                record.cover = coverDataUrl;
                booksStore.put(record);
            }
        };
        
        const getLibReq = libraryStore.get(bookId);
        getLibReq.onsuccess = (e) => {
            const record = e.target.result;
            if (record) {
                record.cover = coverDataUrl;
                libraryStore.put(record);
            }
        };
        
        transaction.oncomplete = () => {
            console.log(`Successfully generated and saved cover for book: ${bookId}`);
            loadHistoryUI();
            loadLibraryUI();
        };
        
        transaction.onerror = (err) => {
            console.error('IndexedDB transaction error saving book cover:', err);
        };
    } catch (err) {
        console.error('Failed to initiate transaction for saving book cover:', err);
    }
}
