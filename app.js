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
            );
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
            saveBookToHistory(
                currentBookMeta.name,
                currentBookMeta.size,
                pdfDoc.numPages,
                pageNum,
                arrayBufferCopy
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
            cover: null,
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
            alert('Este livro foi adicionado como referência bibliográfica da busca manual e não possui um arquivo PDF para leitura.');
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
        
        let iconHtml = '';
        if (book.cover) {
            iconHtml = `
                <div class="book-card-icon" style="height: 36px; width: 26px;">
                    <img src="${book.cover}" alt="Capa">
                </div>
            `;
        } else {
            iconHtml = `
                <div class="book-card-icon">
                    <i data-lucide="book"></i>
                </div>
            `;
        }
        
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
            if (confirm('Deseja excluir este livro da sua biblioteca?')) {
                deleteBookFromLibrary(book.id).then(() => {
                    loadLibraryUI();
                });
            }
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
    
    fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=10`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json();
        })
        .then(data => {
            renderSearchResults(data.items || []);
        })
        .catch(err => {
            console.error('Google Books API error:', err);
            if (searchResultsGrid) {
                searchResultsGrid.innerHTML = `
                    <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                        Erro ao buscar livros na API. Por favor, tente novamente.
                    </div>
                `;
            }
        });
}

function renderSearchResults(items) {
    if (!searchResultsGrid) return;
    searchResultsGrid.innerHTML = '';
    
    if (items.length === 0) {
        searchResultsGrid.innerHTML = `
            <div style="text-align: center; padding: 2rem; color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;">
                Nenhum resultado encontrado.
            </div>
        `;
        return;
    }
    
    items.forEach(item => {
        const volumeInfo = item.volumeInfo || {};
        const title = volumeInfo.title || 'Título desconhecido';
        const authors = volumeInfo.authors ? volumeInfo.authors.join(', ') : 'Autor desconhecido';
        const thumbnail = volumeInfo.imageLinks ? volumeInfo.imageLinks.thumbnail : null;
        
        const card = document.createElement('div');
        card.className = 'history-card';
        card.style.cursor = 'pointer';
        
        let iconHtml = '';
        if (thumbnail) {
            const secureThumbnail = thumbnail.replace(/^http:/i, 'https:');
            iconHtml = `
                <div class="book-card-icon" style="height: 36px; width: 26px;">
                    <img src="${secureThumbnail}" alt="Capa">
                </div>
            `;
        } else {
            iconHtml = `
                <div class="book-card-icon">
                    <i data-lucide="book"></i>
                </div>
            `;
        }
        
        card.innerHTML = `
            ${iconHtml}
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
                hasPdf: false
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
                    alert('Este livro já está na sua biblioteca!');
                    return;
                }
                
                saveBookToLibrary(libraryRecord).then(() => {
                    alert('Livro adicionado à biblioteca com sucesso!');
                    loadLibraryUI();
                }).catch(err => {
                    console.error('Failed to add search book to library:', err);
                    alert('Ocorreu um erro ao adicionar o livro.');
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
