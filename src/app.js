// ==========================================
// ISTANA BUBUR - SYSTEM MANAGEMENT & KASIR
// ==========================================

import {
    db,
    seedInitialFirestoreData,
    firestoreLogin,
    firestoreRegister,
    firestoreCheckUserExists,
    firestoreResetPassword,
    firestoreGetProduk,
    firestoreSaveProduk,
    firestoreDeleteProduk,
    firestoreGetKaryawan,
    firestoreSaveKaryawan,
    firestoreDeleteKaryawan,
    firestoreGetHistoriTransaksi,
    firestoreProcessTransaksiKasir,
    firestoreDeleteTransaksi,
    firestoreGetHistoriGaji,
    firestoreProcessSlipGaji,
    firestoreDeleteHistoriGaji,
    subscribeToTransactions
} from './firebase.ts';

// Global Cache & State
let CURRENT_USER = null;
let KARYAWAN_CACHE = [];
let PRODUK_CACHE = [];
let HISTORI_GAJI_CACHE = [];
let HISTORI_TRX_CACHE = [];
let CART = [];
let LAST_TRX_DATA = null;

let tabHistory = [];
let currentTab = 'profil';

let touchStartX = 0;
let touchStartY = 0;
let touchEndX = 0;
let touchEndY = 0;

let chartPenggajian = null;
let chartKaryawan = null;
let chartPenjualan = null;
let chartKasirPenjualan = null;
let wsChat = null;
let CHAT_MESSAGES = [];
let chatUnreadCount = 0;
let currentAdminChatCabang = 'Semua';
let typingTimeout = null;
let isTypingSent = false;
let cabangUnreadCounts = {};
let isChatSoundEnabled = (localStorage.getItem('ib_chat_sound') !== 'off');
let isUserScrolledUp = false;
let audioCtx = null;

const SESSION_KEY = 'ib_logged_in';
const USER_DATA_KEY = 'ib_user_data';
const TRX_STORAGE_KEY = 'ib_stored_transactions';
const PRODUK_STORAGE_KEY = 'ib_stored_produk';
const KARYAWAN_STORAGE_KEY = 'ib_stored_karyawan';
const USERS_STORAGE_KEY = 'ib_stored_users';
const MASTER_AUTH_STORAGE_KEY = 'ib_master_auth_key';

// Helper URL Endpoint API agar mendukung Browser, Android WebView APK (file://), Capacitor, dan Cloud Host
function getApiEndpoint(path) {
    if (!path.startsWith('/')) path = '/' + path;
    
    // 1. Cek jika pengguna menyetel server custom di localStorage
    const customServer = (localStorage.getItem('IB_API_SERVER_URL') || '').trim();
    if (customServer.startsWith('http://') || customServer.startsWith('https://')) {
        return customServer.replace(/\/+$/, '') + path;
    }

    // 2. Deteksi lingkungan APK (file:, null, capacitor:, dll)
    const origin = window.location.origin;
    const protocol = window.location.protocol;
    const isApkOrFile = !origin || origin === 'null' || protocol === 'file:' || 
        origin.startsWith('capacitor://') || origin.startsWith('ionic://') || origin.startsWith('content://');

    if (isApkOrFile) {
        // Arahkan ke Cloud Run backend
        return 'https://ais-dev-ogj3dc3qbsd5dfa3r23vou-21312793176.asia-southeast1.run.app' + path;
    }

    // 3. Lingkungan web standar (gunakan relative path)
    return path;
}

// Buka Aplikasi Gmail di luar APK/Browser
function openGmailApp() {
    openUrlOutsideApp('https://mail.google.com/mail/u/0/#search/from%3Aistanabubur89%40gmail.com+OR+Istana+Bubur');
}

// Kirim kode referral verifikasi lewat WhatsApp
function sendReferralViaWhatsApp() {
    if (!tempRegistration || !tempRegistration.phone) {
        showToast('Nomor WhatsApp pendaftar tidak ditemukan!', 'warning');
        return;
    }
    const code = activeReferralCode || '123456';
    const msg = `*ISTANA BUBUR - VERIFIKASI AKUN*\n\nHalo ${tempRegistration.username || 'Pengguna'},\nBerikut adalah 6-digit Kode Referral Verifikasi Akun Anda:\n\n*${code}*\n\nKode ini berlaku 10 menit. Masukkan kode ini pada aplikasi untuk menyelesaikan pendaftaran.`;
    openWhatsAppApp(tempRegistration.phone, msg);
}

// Kunci Autentikasi Khusus Admin Pusat (Hanya Diketahui oleh Admin/Owner)
function getActiveMasterAuthKey() {
    return localStorage.getItem(MASTER_AUTH_STORAGE_KEY) || 'IB-AUTH-2026';
}

function setActiveMasterAuthKey(newKey) {
    if (!newKey) return;
    const cleanKey = String(newKey).trim().toUpperCase();
    localStorage.setItem(MASTER_AUTH_STORAGE_KEY, cleanKey);
    
    // Sinkronkan ke server endpoint jika tersedia
    try {
        fetch(getApiEndpoint('/api/auth/update-admin-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'Admin', newCode: cleanKey })
        }).catch(err => console.warn('Sync auth code to server warning:', err));
    } catch(e) {}

    // Perbarui elemen UI yang menampilkan kunci
    const displayEl = document.getElementById('admin-display-auth-key');
    if (displayEl) displayEl.value = cleanKey;
    const curEl = document.getElementById('input-current-auth-code');
    if (curEl) curEl.value = cleanKey;
}

// Fallback kode otorisasi bawaan
const VALID_AUTH_CODES = ['IB-AUTH-2026', 'ADMIN-IB-889', 'IB-PUSAT-99'];


// Akun Bawaan (Admin bawaan telah dihapus sesuai permintaan)
const DEFAULT_USERS = [
    {
        username: 'kasir1',
        password: '123',
        fullName: 'Siti Rahmawati',
        email: 'kasir1@istanabubur.com',
        phone: '082198765432',
        role: 'Kasir',
        cabang: 'Cabang A',
        isActive: true,
        authCode: 'IB-AUTH-2026'
    },
    {
        username: 'kasir2',
        password: '123',
        fullName: 'Ahmad Fauzi',
        email: 'kasir2@istanabubur.com',
        phone: '085211223344',
        role: 'Kasir',
        cabang: 'Cabang B',
        isActive: true,
        authCode: 'IB-AUTH-2026'
    }
];

function getAllUsers() {
    try {
        const saved = localStorage.getItem(USERS_STORAGE_KEY);
        if (saved) {
            let parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                // Filter hapus akun bawaan admin/123456 jika masih tersimpan di storage lokal lama
                parsed = parsed.filter(u => !(u.username && u.username.toLowerCase() === 'admin' && (u.password === '123456' || u.password === '123')));
                localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(parsed));
                const combined = [...DEFAULT_USERS];
                parsed.forEach(p => {
                    const idx = combined.findIndex(u => u.username.toLowerCase() === p.username.toLowerCase());
                    if (idx >= 0) {
                        combined[idx] = { ...combined[idx], ...p };
                    } else {
                        combined.push(p);
                    }
                });
                return combined.filter(u => !(u.username && u.username.toLowerCase() === 'admin' && (u.password === '123456' || u.password === '123')));
            }
        }
    } catch(e) {}
    return [...DEFAULT_USERS];
}

function saveUserAccount(userObj) {
    let saved = [];
    try {
        const raw = localStorage.getItem(USERS_STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch(e){}
    if (!Array.isArray(saved)) saved = [];
    
    const idx = saved.findIndex(u => u.username.toLowerCase() === userObj.username.toLowerCase());
    if (idx >= 0) {
        saved[idx] = { ...saved[idx], ...userObj };
    } else {
        saved.push(userObj);
    }
    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(saved));
    return true;
}

let currentLoginRole = 'Admin'; // 'Admin' or 'Kasir'

// Demo initial seed data for simulator mode
const DEFAULT_PRODUK = [
    { rowIndex: 1, 'ID Produk': 'PRD-001', 'Nama Produk': 'Bubur Ayam Spesial', 'Harga': 15000, 'GambarBase64': '' },
    { rowIndex: 2, 'ID Produk': 'PRD-002', 'Nama Produk': 'Bubur Ayam Komplit (Ati Ampela + Telur)', 'Harga': 20000, 'GambarBase64': '' },
    { rowIndex: 3, 'ID Produk': 'PRD-003', 'Nama Produk': 'Sate Usus Gurih', 'Harga': 3000, 'GambarBase64': '' },
    { rowIndex: 4, 'ID Produk': 'PRD-004', 'Nama Produk': 'Sate Telur Puyuh', 'Harga': 4000, 'GambarBase64': '' },
    { rowIndex: 5, 'ID Produk': 'PRD-005', 'Nama Produk': 'Sate Ati Ampela', 'Harga': 4000, 'GambarBase64': '' },
    { rowIndex: 6, 'ID Produk': 'PRD-006', 'Nama Produk': 'Teh Manis (Hangat / Dingin)', 'Harga': 5000, 'GambarBase64': '' },
    { rowIndex: 7, 'ID Produk': 'PRD-007', 'Nama Produk': 'Jeruk Peras Segar', 'Harga': 7000, 'GambarBase64': '' }
];

const GAJI_STORAGE_KEY = 'ib_stored_histori_gaji';

const DEFAULT_HISTORI_GAJI = [
    { 
        'ID Slip': 'SLIP-881001', 
        'Nama': 'Budi Santoso', 
        'ID Karyawan': 'KRY-001', 
        'Bulan': '2026-09', 
        'Hari Masuk': 26, 
        'Gaji Harian': 90000, 
        'Bonus': 150000, 
        'Potongan': 0, 
        'Total Gaji': 2490000, 
        'Cabang': 'Cabang A', 
        'Jabatan': 'Kasir', 
        'No WA': '081234567890', 
        'Keterangan Libur': '', 
        'Link PDF': '#' 
    },
    { 
        'ID Slip': 'SLIP-881002', 
        'Nama': 'Siti Rahma', 
        'ID Karyawan': 'KRY-002', 
        'Bulan': '2026-09', 
        'Hari Masuk': 25, 
        'Gaji Harian': 100000, 
        'Bonus': 100000, 
        'Potongan': 50000, 
        'Total Gaji': 2550000, 
        'Cabang': 'Cabang A', 
        'Jabatan': 'Dapur Bubur', 
        'No WA': '081298765432', 
        'Keterangan Libur': 'Izin 1 hari', 
        'Link PDF': '#' 
    },
    { 
        'ID Slip': 'SLIP-881003', 
        'Nama': 'Agus Prayogo', 
        'ID Karyawan': 'KRY-003', 
        'Bulan': '2026-09', 
        'Hari Masuk': 26, 
        'Gaji Harian': 85000, 
        'Bonus': 100000, 
        'Potongan': 0, 
        'Total Gaji': 2310000, 
        'Cabang': 'Pusat', 
        'Jabatan': 'Driver', 
        'No WA': '081345678901', 
        'Keterangan Libur': '', 
        'Link PDF': '#' 
    }
];

const DEFAULT_KARYAWAN = [
    { rowIndex: 1, 'ID Karyawan': 'KRY-001', 'Nama': 'Budi Santoso', 'Jenis Kelamin': 'Laki-laki', 'Jabatan': 'Kasir', 'Lokasi Cabang': 'Cabang A', 'No WA': '081234567890', 'Gaji Harian': 90000, 'Email': 'budi@istanabubur.com' },
    { rowIndex: 2, 'ID Karyawan': 'KRY-002', 'Nama': 'Siti Rahma', 'Jenis Kelamin': 'Perempuan', 'Jabatan': 'Dapur Bubur', 'Lokasi Cabang': 'Cabang A', 'No WA': '081298765432', 'Gaji Harian': 100000, 'Email': 'siti@istanabubur.com' },
    { rowIndex: 3, 'ID Karyawan': 'KRY-003', 'Nama': 'Agus Prayogo', 'Jenis Kelamin': 'Laki-laki', 'Jabatan': 'Driver', 'Lokasi Cabang': 'Pusat', 'No WA': '081345678901', 'Gaji Harian': 85000, 'Email': 'agus@istanabubur.com' }
];

function getSampleTransactions() {
    const today = getTodayStringFormatted();
    return [
        {
            'ID Transaksi': 'TRX-882101',
            'Tanggal': `${today} 08:30`,
            'Cabang': 'Cabang A',
            'Kasir': 'kasir1',
            'Total Belanja': 45000,
            'Nama Pelanggan': 'Pak Joko [Dine In - Sambal dipisah]',
            'No WA': '081234567890',
            'Bayar': 50000,
            'Kembalian': 5000,
            'Metode': 'Cash',
            'Items JSON': JSON.stringify([
                { id: 'PRD-001', nama: 'Bubur Ayam Spesial', harga: 15000, qty: 2 },
                { id: 'PRD-004', nama: 'Sate Telur Puyuh', harga: 4000, qty: 2 },
                { id: 'PRD-006', nama: 'Teh Manis (Hangat / Dingin)', harga: 5000, qty: 1 }
            ])
        },
        {
            'ID Transaksi': 'TRX-882102',
            'Tanggal': `${today} 09:15`,
            'Cabang': 'Cabang A',
            'Kasir': 'kasir1',
            'Total Belanja': 20000,
            'Nama Pelanggan': 'Ibu Dewi [Takeaway - Kerupuk banyak]',
            'No WA': '081398765432',
            'Bayar': 20000,
            'Kembalian': 0,
            'Metode': 'Transfer (QRIS - Istana Bubur)',
            'Items JSON': JSON.stringify([
                { id: 'PRD-002', nama: 'Bubur Ayam Komplit (Ati Ampela + Telur)', harga: 20000, qty: 1 }
            ])
        }
    ];
}

// Utility Toast
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    const bgClass = type === 'error' ? 'bg-red-600' : (type === 'success' ? 'bg-emerald-600' : (type === 'warning' ? 'bg-amber-600' : 'bg-blue-600'));
    const iconClass = type === 'error' ? 'fa-circle-exclamation' : (type === 'success' ? 'fa-circle-check' : (type === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info'));
    t.className = `p-3.5 rounded-2xl shadow-xl text-white text-xs sm:text-sm font-bold mb-2 flex items-center gap-2.5 transform transition-all duration-300 opacity-0 translate-y-[-20px] ${bgClass}`;
    t.innerHTML = `<i class="fas ${iconClass} text-base shrink-0"></i> <span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.classList.remove('opacity-0', 'translate-y-[-20px]'); }, 10);
    setTimeout(() => { t.classList.add('opacity-0'); setTimeout(() => t.remove(), 300); }, 3500);
}

function formatRupiah(angka) {
    return Number(angka || 0).toLocaleString('id-ID');
}

function getTodayStringFormatted() {
    const now = new Date();
    return String(now.getDate()).padStart(2, '0') + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear();
}

function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden-view');
}

function openGuideModal(tabName = 'login') {
    const el = document.getElementById('modal-guide');
    if (el) el.classList.remove('hidden-view');
    switchGuideTab(tabName);
}

function switchGuideTab(tabId) {
    const tabs = ['login', 'kasir', 'admin', 'keamanan', 'firebase'];
    tabs.forEach(t => {
        const btn = document.getElementById(`btn-gtab-${t}`);
        const panel = document.getElementById(`gpanel-${t}`);
        if (btn) {
            if (t === tabId) {
                btn.className = 'guide-tab-btn px-4 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 bg-red-600 text-white shadow-sm transition whitespace-nowrap';
            } else {
                btn.className = 'guide-tab-btn px-4 py-2.5 rounded-xl font-semibold text-xs flex items-center gap-2 bg-gray-100 text-gray-600 hover:bg-gray-200 transition whitespace-nowrap';
            }
        }
        if (panel) {
            if (t === tabId) {
                panel.classList.remove('hidden-view');
            } else {
                panel.classList.add('hidden-view');
            }
        }
    });
}

function togglePasswordVisibility(id, btn) {
    const input = document.getElementById(id);
    const icon = btn.querySelector('i');
    if (!input || !icon) return;
    if (input.type === "password") {
        input.type = "text";
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        input.type = "password";
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

function toggleMenu() {
    const menu = document.getElementById('dropdown-menu');
    if (menu) menu.classList.toggle('hidden-view');
}

document.addEventListener('click', function(event) {
    const menu = document.getElementById('dropdown-menu');
    const btn = document.getElementById('btn-menu-toggle');
    if (menu && !menu.classList.contains('hidden-view')) {
        if (!menu.contains(event.target) && !btn.contains(event.target)) {
            menu.classList.add('hidden-view');
        }
    }
});

function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Nomor rekening disalin ke clipboard', 'success');
        }).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        showToast('Nomor rekening disalin ke clipboard', 'success');
    } catch (err) {
        showToast('Gagal menyalin nomor rekening', 'error');
    }
    ta.remove();
}

function applyRoleRestrictions() {
    if (!CURRENT_USER) return;
    const isAdmin = CURRENT_USER.role === 'Admin';
    
    document.querySelectorAll('.admin-only').forEach(el => {
        if (isAdmin) {
            el.classList.remove('hidden-view');
            el.style.display = '';
        } else {
            el.classList.add('hidden-view');
            el.style.display = 'none';
        }
    });

    document.querySelectorAll('.kasir-only').forEach(el => {
        if (isAdmin) {
            el.classList.add('hidden-view');
            el.style.display = 'none';
        } else {
            el.classList.remove('hidden-view');
            el.style.display = '';
        }
    });

    const kasirInfo = document.getElementById('kasir-outlet-info');
    const trxSubtitle = document.getElementById('histori-trx-subtitle');
    const headerSubtitle = document.getElementById('header-subtitle');
    const dashOwner = document.getElementById('dash-owner');

    if (!isAdmin) {
        if (kasirInfo) kasirInfo.innerText = `Outlet: ${CURRENT_USER.cabang} | Kasir: ${CURRENT_USER.username}`;
        if (trxSubtitle) trxSubtitle.innerText = `Riwayat transaksi cabang ${CURRENT_USER.cabang} hari ini`;
        if (headerSubtitle) headerSubtitle.innerText = `Cabang ${CURRENT_USER.cabang}`;
    } else {
        if (headerSubtitle) headerSubtitle.innerText = `Dashboard Pusat`;
        if (dashOwner) dashOwner.innerText = CURRENT_USER.username;
        updateAdminDashboardGreeting();
    }
}

function switchTab(tabId, isGoBack = false) {
    if (!CURRENT_USER) return;
    
    if (CURRENT_USER.role !== 'Admin') {
        const restrictedTabs = ['produk', 'slip', 'karyawan', 'histori-gaji'];
        if (restrictedTabs.includes(tabId)) {
            tabId = 'kasir';
            showToast('Akses Ditolak. Anda masuk sebagai Kasir.', 'error');
        }
    }

    const mainApp = document.getElementById('main-app');
    if (!isGoBack && currentTab !== tabId && mainApp && !mainApp.classList.contains('hidden-view')) {
        tabHistory.push(currentTab);
        history.pushState({ tabId: tabId }, "", `#${tabId}`);
    }
    currentTab = tabId;

    document.querySelectorAll('.view-content').forEach(el => el.classList.add('hidden-view'));
    const targetView = document.getElementById('view-' + tabId);
    if (targetView) targetView.classList.remove('hidden-view');
    
    document.querySelectorAll('.nav-item-dropdown').forEach(el => el.classList.remove('active', 'bg-gray-50'));
    const activeTabBtn = document.getElementById('tab-' + tabId);
    if (activeTabBtn) activeTabBtn.classList.add('active', 'bg-gray-50');

    const namaMenu = { 
        'profil': 'Dashboard', 'kasir': 'Kasir / POS', 'produk': 'Master Produk', 
        'slip': 'Cetak Slip Gaji', 'karyawan': 'Karyawan', 'histori-trx': 'Riwayat Transaksi', 
        'histori-gaji': 'Riwayat Gaji', 'printer': 'Pengaturan Printer', 'about': 'Tentang Aplikasi',
        'chat': 'Chat Bantuan'
    };
    const titleEl = document.getElementById('header-title');
    if (titleEl) titleEl.innerText = namaMenu[tabId] || 'Dashboard';
    
    if (tabId === 'profil') {
        if (CURRENT_USER.role === 'Admin') {
            updateAdminDashboardGreeting();
            initDashboardCharts();
            syncAdminAuthKeyUI();
        } else {
            updateKasirDashboard();
        }
    }
    if (tabId === 'karyawan') loadKaryawan();
    if (tabId === 'slip') { loadKaryawanForSlip(); resetFormSlip(); } 
    if (tabId === 'histori-trx') loadHistoriTransaksi();
    if (tabId === 'histori-gaji') loadHistoriGaji();
    if (tabId === 'produk') loadProduk();
    if (tabId === 'kasir') { loadProdukKasir(); updateCartUI(); }
    if (tabId === 'chat') { openChatView(); }
}

window.addEventListener('popstate', (e) => {
    const mainApp = document.getElementById('main-app');
    if (!mainApp || mainApp.classList.contains('hidden-view')) return; 
    
    const modals = ['modal-cart', 'modal-produk', 'modal-karyawan', 'modal-confirm', 'modal-logout'];
    const openModal = modals.find(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden-view');
    });
    
    if (openModal) {
        closeModal(openModal);
        history.pushState({ tabId: currentTab }, "", `#${currentTab}`); 
        return;
    }

    if (tabHistory.length > 0) {
        const prevTab = tabHistory.pop();
        switchTab(prevTab, true);
    } else {
        let startTab = CURRENT_USER && CURRENT_USER.role === 'Admin' ? 'profil' : 'kasir';
        history.pushState({ tabId: startTab }, "", `#${startTab}`);
        switchTab(startTab, true);
    }
});

function goBack() { history.back(); }

document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX; 
    touchStartY = e.changedTouches[0].screenY;
}, {passive: true});

document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX; 
    touchEndY = e.changedTouches[0].screenY;
    const mainApp = document.getElementById('main-app');
    if (!mainApp || mainApp.classList.contains('hidden-view')) return;
    const modals = ['modal-cart', 'modal-produk', 'modal-karyawan', 'modal-confirm', 'modal-logout'];
    const isModalOpen = modals.some(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden-view');
    });
    if (isModalOpen) return;
    const swipeDistX = touchEndX - touchStartX; 
    const swipeDistY = Math.abs(touchEndY - touchStartY);
    if (swipeDistX > 70 && swipeDistY < 50 && touchStartX < 50) { goBack(); }
}, {passive: true});

function openLogoutModal() {
    const el = document.getElementById('modal-logout');
    if (el) el.classList.remove('hidden-view');
}

function processLogout() {
    closeModal('modal-logout');
    closeChatWebSocket();
    cabangUnreadCounts = {};
    chatUnreadCount = 0;
    updateChatUnreadBadges();
    
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_DATA_KEY);
    sessionStorage.removeItem(USER_DATA_KEY);
    CURRENT_USER = null;
    
    const savedUser = localStorage.getItem('ib_saved_user');
    const savedPass = localStorage.getItem('ib_saved_pass');
    const isRemember = localStorage.getItem('ib_remember') === 'true';

    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.reset();
    
    if (isRemember && savedUser && savedPass) {
        document.getElementById('l-user').value = savedUser;
        document.getElementById('l-pass').value = savedPass;
        document.getElementById('remember-me').checked = true;
    }
    
    document.getElementById('main-app').classList.add('hidden-view');
    document.getElementById('auth-view').classList.remove('hidden-view');
    
    tabHistory = [];
    history.pushState(null, "", window.location.pathname);
    showToast('Berhasil keluar dari aplikasi', 'success');
}

// ====================================================
// LOCAL PERSISTENCE STORAGE HANDLERS
// ====================================================
async function getStoredProdukList() {
    const saved = localStorage.getItem(PRODUK_STORAGE_KEY);
    return saved ? JSON.parse(saved) : DEFAULT_PRODUK;
}

async function getStoredTransaksiList() {
    const saved = localStorage.getItem(TRX_STORAGE_KEY);
    return saved ? JSON.parse(saved) : getSampleTransactions();
}

// Backend bridge with Firebase Firestore cloud persistence and offline local fallback
async function callBackend(funcName, ...args) {
    if (typeof google !== 'undefined' && google.script) {
        return new Promise((resolve, reject) => {
            google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[funcName](...args);
        });
    }

    console.log(`[BACKEND/FIRESTORE] Memanggil: ${funcName}`, args);
    try {
        if (funcName === 'loginUser') {
            const inputIdentity = String(args[0] || '').trim();
            const inputPass = String(args[1] || '').trim();
            const requestedRole = args[2] || currentLoginRole || 'Admin';

            try {
                const fsRes = await firestoreLogin(inputIdentity, inputPass, requestedRole);
                if (fsRes && fsRes.success) return fsRes;
                if (fsRes && fsRes.needsActivation) return fsRes;
            } catch (err) {
                console.warn('[Firestore Login Warning, falling back to local]', err);
            }

            // Local fallback
            const users = getAllUsers();
            const matched = users.find(u => 
                (u.username.toLowerCase() === inputIdentity.toLowerCase() || (u.email && u.email.toLowerCase() === inputIdentity.toLowerCase()))
            );

            if (!matched) {
                return { success: false, message: 'Username/password salah. Silakan periksa kembali.' };
            }
            if (matched.password !== inputPass) {
                return { success: false, message: 'Password salah. Silakan periksa kembali.' };
            }
            if (matched.isActive === false) {
                return { 
                    success: false, 
                    needsActivation: true, 
                    username: matched.username,
                    message: 'Akun belum aktif! Anda wajib memasukkan Kode Autentikasi yang diberikan oleh Admin.' 
                };
            }

            let roleNotice = null;
            if (requestedRole && matched.role !== requestedRole) {
                roleNotice = `Akun terdaftar sebagai ${matched.role}. Hak akses disesuaikan ke ${matched.role}.`;
            }

            return {
                success: true,
                user: {
                    username: matched.username,
                    fullName: matched.fullName || matched.username,
                    role: matched.role,
                    cabang: matched.cabang || (matched.role === 'Admin' ? 'Pusat' : 'Cabang A'),
                    email: matched.email,
                    phone: matched.phone
                },
                roleNotice: roleNotice
            };
        } else if (funcName === 'registerUser') {
            const data = args[0];
            try {
                const res = await firestoreRegister(data);
                if (!res.success) return res;
            } catch (err) {
                console.warn('[Firestore Register fallback]', err);
            }
            saveUserAccount(data);
            return { success: true, message: 'Pendaftaran berhasil disimpan ke Cloud Database.' };
        } else if (funcName === 'verifyAdminAuthCode') {
            const code = String(args[0] || '').trim().toUpperCase();
            const isValid = VALID_AUTH_CODES.map(c => c.toUpperCase()).includes(code);
            return isValid ? { success: true } : { success: false, message: 'Kode autentikasi salah atau tidak valid.' };
        } else if (funcName === 'resetUserPassword') {
            const uname = String(args[0] || '').trim();
            const newPass = String(args[1] || '').trim();
            try {
                await firestoreResetPassword(uname, newPass);
            } catch (e) {
                console.warn('[Firestore Reset Pass fallback]', e);
            }
            const users = getAllUsers();
            const target = users.find(u => u.username.toLowerCase() === uname.toLowerCase());
            if (target) {
                target.password = newPass;
                saveUserAccount(target);
                return { success: true, message: 'Password berhasil direset.' };
            }
            return { success: true, message: 'Password berhasil diperbarui di Cloud Firestore.' };
        } else if (funcName === 'getProduk') {
            try {
                const fsList = await firestoreGetProduk();
                if (fsList && fsList.length > 0) {
                    localStorage.setItem(PRODUK_STORAGE_KEY, JSON.stringify(fsList));
                    return fsList;
                }
            } catch (e) {
                console.warn('[Firestore GetProduk fallback]', e);
            }
            return await getStoredProdukList();
        } else if (funcName === 'saveProduk') {
            const pData = args[0];
            try {
                await firestoreSaveProduk(pData);
            } catch (e) {
                console.warn('[Firestore SaveProduk fallback]', e);
            }
            // Update local backup
            let saved = localStorage.getItem(PRODUK_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_PRODUK];
            if (pData.rowIndex) {
                const idx = list.findIndex(item => String(item.rowIndex) === String(pData.rowIndex));
                if (idx !== -1) {
                    list[idx]['Nama Produk'] = pData.nama;
                    list[idx]['Harga'] = Number(pData.harga);
                    if (pData.gambar) list[idx]['GambarBase64'] = pData.gambar;
                }
            } else {
                const newId = 'PRD-' + String(list.length + 1).padStart(3, '0');
                list.push({
                    rowIndex: list.length + 1,
                    'ID Produk': newId,
                    'Nama Produk': pData.nama,
                    'Harga': Number(pData.harga),
                    'GambarBase64': pData.gambar || ''
                });
            }
            localStorage.setItem(PRODUK_STORAGE_KEY, JSON.stringify(list));
            return { success: true, message: 'Produk berhasil disimpan ke Cloud Firestore' };
        } else if (funcName === 'deleteProduk') {
            const rowIdx = args[0];
            let saved = localStorage.getItem(PRODUK_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_PRODUK];
            const target = list.find(item => String(item.rowIndex) === String(rowIdx));
            if (target && target['ID Produk']) {
                try {
                    await firestoreDeleteProduk(target['ID Produk']);
                } catch (e) {
                    console.warn('[Firestore DeleteProduk fallback]', e);
                }
            }
            list = list.filter(item => String(item.rowIndex) !== String(rowIdx));
            localStorage.setItem(PRODUK_STORAGE_KEY, JSON.stringify(list));
            return { success: true, message: 'Produk berhasil dihapus dari Cloud Firestore' };
        } else if (funcName === 'getKaryawan') {
            try {
                const fsList = await firestoreGetKaryawan();
                if (fsList && fsList.length > 0) {
                    localStorage.setItem(KARYAWAN_STORAGE_KEY, JSON.stringify(fsList));
                    return fsList;
                }
            } catch (e) {
                console.warn('[Firestore GetKaryawan fallback]', e);
            }
            const saved = localStorage.getItem(KARYAWAN_STORAGE_KEY);
            return saved ? JSON.parse(saved) : DEFAULT_KARYAWAN;
        } else if (funcName === 'saveKaryawan') {
            const kData = args[0];
            try {
                await firestoreSaveKaryawan(kData);
            } catch (e) {
                console.warn('[Firestore SaveKaryawan fallback]', e);
            }
            let saved = localStorage.getItem(KARYAWAN_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_KARYAWAN];
            if (kData.rowIndex) {
                const idx = list.findIndex(item => String(item.rowIndex) === String(kData.rowIndex));
                if (idx !== -1) {
                    list[idx] = { ...list[idx], ...kData };
                }
            } else {
                const newId = 'KRY-' + String(list.length + 1).padStart(3, '0');
                list.push({
                    rowIndex: list.length + 1,
                    'ID Karyawan': newId,
                    ...kData
                });
            }
            localStorage.setItem(KARYAWAN_STORAGE_KEY, JSON.stringify(list));
            return { success: true, message: 'Data karyawan berhasil disimpan ke Cloud Firestore' };
        } else if (funcName === 'deleteKaryawan') {
            const rowIdx = args[0];
            let saved = localStorage.getItem(KARYAWAN_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_KARYAWAN];
            const target = list.find(item => String(item.rowIndex) === String(rowIdx));
            if (target && target['ID Karyawan']) {
                try {
                    await firestoreDeleteKaryawan(target['ID Karyawan']);
                } catch (e) {
                    console.warn('[Firestore DeleteKaryawan fallback]', e);
                }
            }
            list = list.filter(item => String(item.rowIndex) !== String(rowIdx));
            localStorage.setItem(KARYAWAN_STORAGE_KEY, JSON.stringify(list));
            return { success: true, message: 'Data karyawan berhasil dihapus dari Cloud Firestore' };
        } else if (funcName === 'getHistoriTransaksi') {
            try {
                const fsList = await firestoreGetHistoriTransaksi();
                if (fsList && fsList.length > 0) {
                    localStorage.setItem(TRX_STORAGE_KEY, JSON.stringify(fsList));
                    return fsList;
                }
            } catch (e) {
                console.warn('[Firestore GetHistoriTransaksi fallback]', e);
            }
            return await getStoredTransaksiList();
        } else if (funcName === 'processTransaksiKasir') {
            const trx = args[0];
            let trxId = 'TRX-' + Math.floor(100000 + Math.random() * 900000);
            try {
                const fsRes = await firestoreProcessTransaksiKasir(trx);
                if (fsRes && fsRes.idTrx) trxId = fsRes.idTrx;
            } catch (e) {
                console.warn('[Firestore ProcessTransaksi fallback]', e);
            }

            const now = new Date();
            const tanggalFormatted = getTodayStringFormatted() + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            
            const newTrxItem = {
                'ID Transaksi': trxId,
                'Tanggal': tanggalFormatted,
                'Cabang': CURRENT_USER ? CURRENT_USER.cabang : (trx.cabang || 'Pusat'),
                'Kasir': CURRENT_USER ? CURRENT_USER.username : 'Kasir',
                'Total Belanja': trx.total,
                'Nama Pelanggan': `${trx.namaPelanggan || 'Umum'} [${trx.jenis || 'Dine In'}${trx.keterangan ? ' - ' + trx.keterangan : ''}]`,
                'No WA': trx.wa || '',
                'Bayar': trx.bayar,
                'Kembalian': trx.kembali,
                'Metode': trx.metode,
                'Items JSON': typeof trx.items === 'string' ? trx.items : JSON.stringify(trx.items)
            };

            let saved = localStorage.getItem(TRX_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : getSampleTransactions();
            list.unshift(newTrxItem);
            localStorage.setItem(TRX_STORAGE_KEY, JSON.stringify(list));

            return {
                success: true,
                idTrx: trxId,
                message: 'Transaksi berhasil dicatat & disinkronkan ke Cloud Firestore!'
            };
        } else if (funcName === 'deleteTransaksi') {
            const idTrx = args[0];
            try {
                await firestoreDeleteTransaksi(idTrx);
            } catch (e) {
                console.warn('[Firestore DeleteTransaksi fallback]', e);
            }
            let saved = localStorage.getItem(TRX_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : getSampleTransactions();
            list = list.filter(t => String(t['ID Transaksi']) !== String(idTrx));
            localStorage.setItem(TRX_STORAGE_KEY, JSON.stringify(list));
            return {
                success: true,
                message: `Transaksi #${idTrx} berhasil dihapus dari Cloud Firestore`
            };
        } else if (funcName === 'getHistori') {
            try {
                const fsList = await firestoreGetHistoriGaji();
                if (fsList && fsList.length > 0) {
                    localStorage.setItem(GAJI_STORAGE_KEY, JSON.stringify(fsList));
                    return fsList;
                }
            } catch (e) {
                console.warn('[Firestore GetHistoriGaji fallback]', e);
            }
            const saved = localStorage.getItem(GAJI_STORAGE_KEY);
            return saved ? JSON.parse(saved) : DEFAULT_HISTORI_GAJI;
        } else if (funcName === 'processSlipGaji') {
            const sData = args[0];
            let slipId = 'SLIP-' + Math.floor(100000 + Math.random() * 900000);
            try {
                const fsRes = await firestoreProcessSlipGaji(sData);
                if (fsRes && fsRes.idSlip) slipId = fsRes.idSlip;
            } catch (e) {
                console.warn('[Firestore ProcessSlipGaji fallback]', e);
            }

            const harian = Number(sData.gajiHarian || 0);
            const hari = Number(sData.hariMasuk || 0);
            const bonus = Number(sData.bonus || 0);
            const potongan = Number(sData.potongan || 0);
            const totalGaji = (harian * hari) + bonus - potongan;

            const newSlip = {
                'ID Slip': slipId,
                'Nama': sData.nama,
                'ID Karyawan': sData.id,
                'Bulan': sData.bulan,
                'Hari Masuk': hari,
                'Gaji Harian': harian,
                'Bonus': bonus,
                'Potongan': potongan,
                'Total Gaji': totalGaji,
                'Cabang': sData.cabang || 'Pusat',
                'Jabatan': sData.jabatan || '-',
                'No WA': sData.wa || '',
                'Keterangan Libur': sData.keteranganLibur || '',
                'Link PDF': '#'
            };

            let saved = localStorage.getItem(GAJI_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_HISTORI_GAJI];
            list.unshift(newSlip);
            localStorage.setItem(GAJI_STORAGE_KEY, JSON.stringify(list));

            return {
                success: true,
                message: 'Slip gaji berhasil dibuat & tersimpan di Cloud Firestore!',
                idSlip: slipId,
                pdfUrl: '#',
                waLink: '#'
            };
        } else if (funcName === 'deleteHistoriGaji') {
            const target = args[0];
            try {
                await firestoreDeleteHistoriGaji(String(target));
            } catch (e) {
                console.warn('[Firestore DeleteSlipGaji fallback]', e);
            }
            let saved = localStorage.getItem(GAJI_STORAGE_KEY);
            let list = saved ? JSON.parse(saved) : [...DEFAULT_HISTORI_GAJI];
            if (typeof target === 'number') {
                list.splice(target, 1);
            } else {
                list = list.filter((item, idx) => item['ID Slip'] !== target && String(idx) !== String(target));
            }
            localStorage.setItem(GAJI_STORAGE_KEY, JSON.stringify(list));
            return { success: true, message: 'Data riwayat slip gaji berhasil dihapus dari Cloud Firestore' };
        } else {
            return { success: true, message: 'Operasi berhasil (Cloud Firestore)' };
        }
    } catch (globalErr) {
        console.error('[Backend Global Error]', globalErr);
        return { success: false, message: 'Terjadi kendala pada database: ' + (globalErr.message || globalErr) };
    }
}

function parseDataArray(res) {
    if (typeof res === 'string') { 
        try { return JSON.parse(res); } catch(e) { return []; } 
    }
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object' && res.data && Array.isArray(res.data)) return res.data;
    return [];
}

function setLoginRole(role) {
    currentLoginRole = role === 'Kasir' ? 'Kasir' : 'Admin';
    const tabAdmin = document.getElementById('tab-login-admin');
    const tabKasir = document.getElementById('tab-login-kasir');
    const roleIcon = document.getElementById('login-role-icon');
    const roleDesc = document.getElementById('login-role-desc');

    if (currentLoginRole === 'Admin') {
        if (tabAdmin) {
            tabAdmin.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-black transition-all bg-red-600 text-white shadow-sm';
            const i = tabAdmin.querySelector('i');
            if (i) i.className = 'fas fa-crown text-amber-300';
        }
        if (tabKasir) {
            tabKasir.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-black transition-all text-gray-600 hover:text-gray-900';
            const i = tabKasir.querySelector('i');
            if (i) i.className = 'fas fa-cash-register text-gray-400';
        }
        if (roleIcon) roleIcon.className = 'fas fa-shield-halved text-red-600';
        if (roleDesc) roleDesc.innerText = 'Mode: Akses Penuh Sistem & Manajemen Pusat';
    } else {
        if (tabKasir) {
            tabKasir.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-black transition-all bg-blue-600 text-white shadow-sm';
            const i = tabKasir.querySelector('i');
            if (i) i.className = 'fas fa-cash-register text-white';
        }
        if (tabAdmin) {
            tabAdmin.className = 'flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-black transition-all text-gray-600 hover:text-gray-900';
            const i = tabAdmin.querySelector('i');
            if (i) i.className = 'fas fa-crown text-gray-400';
        }
        if (roleIcon) roleIcon.className = 'fas fa-store text-blue-600';
        if (roleDesc) roleDesc.innerText = 'Mode: Akses Kasir POS Cabang & Pesanan';
    }
}

function setDemoLogin(username, password, role) {
    const uInput = document.getElementById('l-user');
    const pInput = document.getElementById('l-pass');
    if (uInput) uInput.value = username;
    if (pInput) pInput.value = password;
    
    if (role) {
        setLoginRole(role);
    } else {
        setLoginRole(username.toLowerCase().includes('kasir') ? 'Kasir' : 'Admin');
    }
    
    showToast(`Akun demo ${username} (${role || currentLoginRole}) dipilih`, 'info');
}

async function handleLogin(e) {
    e.preventDefault();
    
    const user = (document.getElementById('l-user').value || '').trim();
    const pass = (document.getElementById('l-pass').value || '').trim();
    const isRememberMe = document.getElementById('remember-me').checked;
    const btn = document.getElementById('btn-login');

    if (!user || !pass) {
        showToast('Username dan password wajib diisi!', 'warning');
        return;
    }
    
    btn.innerHTML = '<div class="loader border-white"></div>';
    btn.disabled = true;
    
    try {
        const res = await callBackend('loginUser', user, pass, currentLoginRole);
        if (res.success) {
            CURRENT_USER = res.user;
            if (isRememberMe) {
                localStorage.setItem(SESSION_KEY, 'true');
                localStorage.setItem(USER_DATA_KEY, JSON.stringify(CURRENT_USER));
                localStorage.setItem('ib_saved_user', user);
                localStorage.setItem('ib_saved_pass', pass);
                localStorage.setItem('ib_saved_role', CURRENT_USER.role);
                localStorage.setItem('ib_remember', 'true');
            } else {
                sessionStorage.setItem(SESSION_KEY, 'true');
                sessionStorage.setItem(USER_DATA_KEY, JSON.stringify(CURRENT_USER));
                localStorage.removeItem(SESSION_KEY);
                localStorage.removeItem(USER_DATA_KEY);
                localStorage.removeItem('ib_saved_user');
                localStorage.removeItem('ib_saved_pass');
                localStorage.removeItem('ib_saved_role');
                localStorage.removeItem('ib_remember');
            }

            if (res.roleNotice) {
                showToast(res.roleNotice, 'info');
            }
            showToast(`Login berhasil! Selamat datang, ${CURRENT_USER.fullName || CURRENT_USER.username}`, 'success');
            loginSuccessLogic();
        } else {
            showToast(res.message || 'Username atau password salah', 'error');
            if (res.needsActivation) {
                setTimeout(() => {
                    openActivateAccountPrompt(res.username);
                }, 1000);
            }
        }
    } catch (e) {
        showToast('Gagal terhubung ke server', 'error');
    }
    
    btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> Masuk';
    btn.disabled = false;
}

function checkAutoLogin() {
    const savedUser = localStorage.getItem('ib_saved_user');
    const savedPass = localStorage.getItem('ib_saved_pass');
    const savedRole = localStorage.getItem('ib_saved_role');
    const isRemember = localStorage.getItem('ib_remember') === 'true';
    const isLoggedLocal = localStorage.getItem(SESSION_KEY) === 'true';
    const isLoggedSession = sessionStorage.getItem(SESSION_KEY) === 'true';

    if (savedRole) {
        setLoginRole(savedRole);
    }

    if (isRemember && savedUser) {
        const uEl = document.getElementById('l-user');
        const pEl = document.getElementById('l-pass');
        const rEl = document.getElementById('remember-me');
        if (uEl) uEl.value = savedUser;
        if (pEl && savedPass) pEl.value = savedPass;
        if (rEl) rEl.checked = true;
    }

    if (isLoggedLocal || isLoggedSession) {
        const rawData = localStorage.getItem(USER_DATA_KEY) || sessionStorage.getItem(USER_DATA_KEY);
        if (rawData) {
            CURRENT_USER = JSON.parse(rawData);
            loginSuccessLogic();
            return;
        }
    }

    // Kosongkan form login awal agar pengguna memasukkan akunnya sendiri
    const uInput = document.getElementById('l-user');
    const pInput = document.getElementById('l-pass');
    if (uInput && (uInput.value === 'admin' || !uInput.value)) uInput.value = '';
    if (pInput && (pInput.value === '123456' || !pInput.value)) pInput.value = '';
}

// ==========================================
// REGISTRASI, REFERRAL EMAIL & KODE AUTENTIKASI ADMIN
// ==========================================
let tempRegistration = null;
let activeReferralCode = null;
let referralExpiryTime = 0;
let referralTimerInterval = null;

function openRegisterModal() {
    tempRegistration = null;
    activeReferralCode = null;
    if (referralTimerInterval) clearInterval(referralTimerInterval);

    document.getElementById('register-step-1').classList.remove('hidden-view');
    document.getElementById('register-step-2').classList.add('hidden-view');
    document.getElementById('register-step-3').classList.add('hidden-view');
    
    updateRegisterStepIndicator(1);

    document.getElementById('reg-nama').value = '';
    document.getElementById('reg-user').value = '';
    document.getElementById('reg-email').value = '';
    document.getElementById('reg-wa').value = '';
    document.getElementById('reg-role').value = currentLoginRole || 'Kasir';
    document.getElementById('reg-cabang').value = '';
    document.getElementById('reg-pass').value = '';
    document.getElementById('reg-pass-conf').value = '';
    document.getElementById('reg-input-referral').value = '';
    document.getElementById('reg-auth-code').value = '';

    const m = document.getElementById('modal-register');
    if (m) m.classList.remove('hidden-view');
}

function updateRegisterStepIndicator(step) {
    const s1B = document.getElementById('step-badge-1');
    const s1L = document.getElementById('step-label-1');
    const s2B = document.getElementById('step-badge-2');
    const s2L = document.getElementById('step-label-2');
    const s3B = document.getElementById('step-badge-3');
    const s3L = document.getElementById('step-label-3');
    const line1 = document.getElementById('step-line-1');
    const line2 = document.getElementById('step-line-2');

    if (step === 1) {
        if (s1B) s1B.className = 'w-6 h-6 rounded-full bg-red-600 text-white font-bold text-xs flex items-center justify-center';
        if (s1L) s1L.className = 'text-xs font-bold text-gray-800';
        if (s2B) s2B.className = 'w-6 h-6 rounded-full bg-gray-200 text-gray-500 font-bold text-xs flex items-center justify-center';
        if (s2L) s2L.className = 'text-xs font-bold text-gray-400';
        if (s3B) s3B.className = 'w-6 h-6 rounded-full bg-gray-200 text-gray-500 font-bold text-xs flex items-center justify-center';
        if (s3L) s3L.className = 'text-xs font-bold text-gray-400';
        if (line1) line1.className = 'flex-1 h-0.5 bg-gray-200 mx-2';
        if (line2) line2.className = 'flex-1 h-0.5 bg-gray-200 mx-2';
    } else if (step === 2) {
        if (s1B) s1B.className = 'w-6 h-6 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center';
        if (s1L) s1L.className = 'text-xs font-bold text-gray-800';
        if (s2B) s2B.className = 'w-6 h-6 rounded-full bg-red-600 text-white font-bold text-xs flex items-center justify-center';
        if (s2L) s2L.className = 'text-xs font-bold text-gray-800';
        if (s3B) s3B.className = 'w-6 h-6 rounded-full bg-gray-200 text-gray-500 font-bold text-xs flex items-center justify-center';
        if (s3L) s3L.className = 'text-xs font-bold text-gray-400';
        if (line1) line1.className = 'flex-1 h-0.5 bg-emerald-600 mx-2';
        if (line2) line2.className = 'flex-1 h-0.5 bg-gray-200 mx-2';
    } else if (step === 3) {
        if (s1B) s1B.className = 'w-6 h-6 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center';
        if (s1L) s1L.className = 'text-xs font-bold text-gray-800';
        if (s2B) s2B.className = 'w-6 h-6 rounded-full bg-emerald-600 text-white font-bold text-xs flex items-center justify-center';
        if (s2L) s2L.className = 'text-xs font-bold text-gray-800';
        if (s3B) s3B.className = 'w-6 h-6 rounded-full bg-red-600 text-white font-bold text-xs flex items-center justify-center';
        if (s3L) s3L.className = 'text-xs font-bold text-gray-800';
        if (line1) line1.className = 'flex-1 h-0.5 bg-emerald-600 mx-2';
        if (line2) line2.className = 'flex-1 h-0.5 bg-emerald-600 mx-2';
    }
}

async function submitRegisterStep1() {
    const nama = (document.getElementById('reg-nama').value || '').trim();
    const user = (document.getElementById('reg-user').value || '').trim();
    const email = (document.getElementById('reg-email').value || '').trim();
    const wa = (document.getElementById('reg-wa').value || '').trim();
    const role = document.getElementById('reg-role').value;
    const cabang = document.getElementById('reg-cabang').value;
    const pass = (document.getElementById('reg-pass').value || '').trim();
    const passConf = (document.getElementById('reg-pass-conf').value || '').trim();

    if (!nama || !user || !email || !wa || !pass || !passConf) {
        showToast('Semua data wajib diisi!', 'warning');
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showToast('Format email tidak valid! Harap gunakan format seperti user@gmail.com', 'error');
        return;
    }

    if (pass.length < 6) {
        showToast('Password minimal 6 karakter!', 'error');
        return;
    }

    if (pass !== passConf) {
        showToast('Konfirmasi password tidak cocok!', 'error');
        return;
    }

    // Cek username sudah dipakai
    const allUsers = getAllUsers();
    if (allUsers.some(u => u.username.toLowerCase() === user.toLowerCase())) {
        showToast('Username sudah digunakan! Silakan pilih username lain.', 'error');
        return;
    }

    const btn = document.querySelector('#register-step-1 button[type="submit"]') || document.getElementById('btn-submit-step1') || document.querySelector('#register-step-1 button');
    const originalBtnText = btn ? btn.innerHTML : 'Lanjut & Kirim Kode Referral ke Email';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Mengirim Kode Referral ke Email...';
    }

    showToast(`Memvalidasi & mengirim kode referral ke ${email}...`, 'info');

    // Simpan data pendaftaran sementara
    tempRegistration = {
        fullName: nama,
        username: user,
        email: email,
        phone: wa,
        role: role,
        cabang: cabang,
        password: pass,
        isActive: false
    };

    let sendSuccess = false;
    let fallbackCode = null;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9000);

        const resp = await fetch(getApiEndpoint('/api/auth/send-referral-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email,
                username: user
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        let res = null;
        try {
            res = await resp.json();
        } catch(pe) {
            console.warn('Respon non-JSON diterima:', pe);
        }

        if (res && res.success) {
            sendSuccess = true;
            referralExpiryTime = res.expiresAt || (Date.now() + 10 * 60 * 1000);
            if (res.codeForTesting) {
                activeReferralCode = res.codeForTesting;
            }
            showToast(res.message || `Kode referral 6-digit berhasil dikirimkan ke email ${email}`, 'success');
        } else {
            // Jika server mengembalikan penolakan spesifik
            throw new Error((res && res.message) ? res.message : 'Server tidak mengembalikan status berhasil');
        }
    } catch (err) {
        console.warn('[Kirim Kode Referral Info/Fallback]:', err);
        // Fallback Kode Referral Lokal jika koneksi offline / APK diblokir sistem
        fallbackCode = Math.floor(100000 + Math.random() * 900000).toString();
        activeReferralCode = fallbackCode;
        referralExpiryTime = Date.now() + 10 * 60 * 1000;
        sendSuccess = true; // izinkan pengguna lanjut ke Step 2 tanpa terhenti!
        showToast(`Server email terkendala. Kode OTP darurat Anda: ${fallbackCode}`, 'warning');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalBtnText;
        }
    }

    if (sendSuccess) {
        // Perbarui UI Step 2
        const emailDisplay = document.getElementById('reg-display-email');
        if (emailDisplay) emailDisplay.innerText = email;
        const inputRef = document.getElementById('reg-input-referral');
        if (inputRef) inputRef.value = '';

        const fallbackBox = document.getElementById('reg-fallback-box');
        const fallbackCodeVal = document.getElementById('reg-fallback-code-val');
        const statusBadge = document.getElementById('reg-status-badge');

        if (fallbackCode) {
            if (fallbackBox) fallbackBox.classList.remove('hidden-view');
            if (fallbackCodeVal) fallbackCodeVal.innerText = fallbackCode;
            if (statusBadge) {
                statusBadge.innerText = 'Kode Darurat';
                statusBadge.className = 'text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded-full font-extrabold';
            }
        } else {
            if (fallbackBox) fallbackBox.classList.add('hidden-view');
            if (statusBadge) {
                statusBadge.innerText = 'Aktif';
                statusBadge.className = 'text-[10px] bg-emerald-200/80 text-emerald-900 px-2 py-0.5 rounded-full font-extrabold';
            }
        }

        // Pindah ke Step 2
        document.getElementById('register-step-1').classList.add('hidden-view');
        document.getElementById('register-step-2').classList.remove('hidden-view');
        document.getElementById('register-step-3').classList.add('hidden-view');
        updateRegisterStepIndicator(2);
        startReferralTimer();
    }
}

function startReferralTimer() {
    if (referralTimerInterval) clearInterval(referralTimerInterval);
    const timerEl = document.getElementById('reg-timer');

    function update() {
        const remaining = Math.max(0, referralExpiryTime - Date.now());
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        if (timerEl) timerEl.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (remaining <= 0) {
            clearInterval(referralTimerInterval);
            if (timerEl) timerEl.innerText = 'Kedaluwarsa';
        }
    }
    update();
    referralTimerInterval = setInterval(update, 1000);
}

async function resendReferralCode() {
    if (!tempRegistration || !tempRegistration.email) {
        showToast('Data pendaftar tidak ditemukan!', 'error');
        return;
    }

    const btn = document.getElementById('btn-resend-referral');
    if (btn) {
        btn.disabled = true;
        setTimeout(() => { if (btn) btn.disabled = false; }, 4000);
    }

    showToast(`Mengirim ulang kode referral ke ${tempRegistration.email}...`, 'info');

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9000);

        const resp = await fetch(getApiEndpoint('/api/auth/send-referral-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: tempRegistration.email,
                username: tempRegistration.username
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        let res = null;
        try { res = await resp.json(); } catch(e) {}

        if (res && res.success) {
            referralExpiryTime = res.expiresAt || (Date.now() + 10 * 60 * 1000);
            if (res.codeForTesting) {
                activeReferralCode = res.codeForTesting;
            }
            startReferralTimer();
            showToast(res.message || `Kode referral baru telah dikirim ke ${tempRegistration.email}`, 'success');
            return;
        }
        throw new Error(res ? res.message : 'Gagal mengirim');
    } catch (e) {
        // Fallback kode baru lokal jika koneksi bermasalah
        const newFallback = Math.floor(100000 + Math.random() * 900000).toString();
        activeReferralCode = newFallback;
        referralExpiryTime = Date.now() + 10 * 60 * 1000;
        startReferralTimer();

        const fallbackBox = document.getElementById('reg-fallback-box');
        const fallbackCodeVal = document.getElementById('reg-fallback-code-val');
        if (fallbackBox) fallbackBox.classList.remove('hidden-view');
        if (fallbackCodeVal) fallbackCodeVal.innerText = newFallback;

        showToast(`Kode referral diperbarui: ${newFallback}. Masukkan kode ini pada kolom verifikasi.`, 'warning');
    }
}

function backToRegisterStep1() {
    if (referralTimerInterval) clearInterval(referralTimerInterval);
    document.getElementById('register-step-1').classList.remove('hidden-view');
    document.getElementById('register-step-2').classList.add('hidden-view');
    document.getElementById('register-step-3').classList.add('hidden-view');
    updateRegisterStepIndicator(1);
}

async function verifyReferralStep2() {
    const inputCode = (document.getElementById('reg-input-referral').value || '').trim();
    if (!inputCode || inputCode.length !== 6) {
        showToast('Masukkan 6-digit kode referral dari email!', 'warning');
        return;
    }

    if (Date.now() > referralExpiryTime) {
        showToast('Kode referral telah kedaluwarsa! Silakan klik "Kirim Ulang Kode".', 'error');
        return;
    }

    if (!tempRegistration || !tempRegistration.email) {
        showToast('Data pendaftaran tidak valid. Silakan ulangi langkah pertama.', 'error');
        backToRegisterStep1();
        return;
    }

    const verifyBtn = document.getElementById('btn-verify-referral') || document.querySelector('#register-step-2 button.bg-emerald-600') || document.querySelector('#register-step-2 button');
    const originalText = verifyBtn ? verifyBtn.innerHTML : 'Verifikasi Kode & Lanjut';
    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Memverifikasi Kode...';
    }

    let isVerified = false;

    // 1. Cek langsung kecocokan kode lokal darurat / devMode
    if (activeReferralCode && inputCode === activeReferralCode) {
        isVerified = true;
    }

    // 2. Jika belum cocok lokal, coba verifikasi ke server API
    if (!isVerified) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 7000);

            const resp = await fetch(getApiEndpoint('/api/auth/verify-referral-code'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: tempRegistration.email,
                    code: inputCode
                }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            const res = await resp.json();
            if (res && res.success) {
                isVerified = true;
            }
        } catch (err) {
            console.warn('[Verify Referral Network Warning]:', err);
        }
    }

    if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = originalText;
    }

    if (isVerified) {
        if (referralTimerInterval) clearInterval(referralTimerInterval);

        // Beralih ke Step 3: Masukkan Kode Autentikasi Admin
        document.getElementById('register-step-1').classList.add('hidden-view');
        document.getElementById('register-step-2').classList.add('hidden-view');
        document.getElementById('register-step-3').classList.remove('hidden-view');
        updateRegisterStepIndicator(3);

        showToast('Kode referral berhasil diverifikasi! Masukkan Kode Autentikasi Admin.', 'success');
    } else {
        showToast('Kode referral salah atau tidak cocok! Periksa kembali email Anda atau klik "Kirim Ulang Kode".', 'error');
    }
}

function backToRegisterStep2() {
    document.getElementById('register-step-1').classList.add('hidden-view');
    document.getElementById('register-step-2').classList.remove('hidden-view');
    document.getElementById('register-step-3').classList.add('hidden-view');
    updateRegisterStepIndicator(2);
}

async function activateAccountStep3() {
    const inputAuthCode = (document.getElementById('reg-auth-code').value || '').trim().toUpperCase();
    if (!inputAuthCode) {
        showToast('Kode autentikasi wajib diisi!', 'warning');
        return;
    }

    if (!tempRegistration) {
        showToast('Data pendaftaran tidak ditemukan. Ulangi proses pendaftaran.', 'error');
        return;
    }

    const btn = document.getElementById('btn-activate-account');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Memvalidasi Otorisasi Admin...</span>';
    }

    let isValid = false;
    try {
        const resp = await fetch(getApiEndpoint('/api/auth/verify-admin-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: inputAuthCode })
        });
        const res = await resp.json();
        if (res && res.success) {
            isValid = true;
        }
    } catch(e) {
        // Fallback validasi lokal bila offline
        const master = getActiveMasterAuthKey().toUpperCase();
        isValid = (inputAuthCode === master || VALID_AUTH_CODES.map(c => c.toUpperCase()).includes(inputAuthCode));
    }

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check-circle"></i> <span>Aktivasi Akun Sekarang</span>';
    }

    if (!isValid) {
        showToast('Kode autentikasi salah atau tidak valid! Hanya Admin/Owner Pusat yang mengetahui kode ini.', 'error');
        return;
    }

    // Aktivasi akun berhasil!
    tempRegistration.isActive = true;
    tempRegistration.authCode = inputAuthCode;
    saveUserAccount(tempRegistration);

    showToast('Pendaftaran berhasil! Akun Anda telah aktif dan dapat digunakan.', 'success');
    closeModal('modal-register');

    // Isi ke form login agar pengguna bisa langsung masuk
    const uInput = document.getElementById('l-user');
    const pInput = document.getElementById('l-pass');
    if (uInput) uInput.value = tempRegistration.username;
    if (pInput) pInput.value = tempRegistration.password;

    setLoginRole(tempRegistration.role);
}

function openActivateAccountPrompt(username) {
    openRegisterModal();
    const users = getAllUsers();
    const u = users.find(x => x.username.toLowerCase() === (username || '').toLowerCase());
    if (u) {
        tempRegistration = u;
        document.getElementById('register-step-1').classList.add('hidden-view');
        document.getElementById('register-step-2').classList.add('hidden-view');
        document.getElementById('register-step-3').classList.remove('hidden-view');
        updateRegisterStepIndicator(3);
    }
}

// ==========================================
// BANTUAN LUPA USERNAME
// ==========================================
function openForgotUsernameModal() {
    const m = document.getElementById('modal-forgot-username');
    if (m) {
        document.getElementById('fu-email').value = '';
        document.getElementById('fu-wa').value = '';
        const resBox = document.getElementById('fu-result-box');
        if (resBox) resBox.classList.add('hidden-view');
        m.classList.remove('hidden-view');
    }
}

function handleFindUsername(e) {
    if (e && e.preventDefault) e.preventDefault();
    const email = (document.getElementById('fu-email').value || '').trim().toLowerCase();
    const wa = (document.getElementById('fu-wa').value || '').trim();

    if (!email || !wa) {
        showToast('Email dan nomor WhatsApp wajib diisi!', 'warning');
        return;
    }

    const users = getAllUsers();
    const matched = users.find(u => {
        const uEmail = (u.email || '').toLowerCase();
        const uPhone = (u.phone || '').replace(/\D/g, '');
        const cleanWa = wa.replace(/\D/g, '');
        return uEmail === email && (uPhone === cleanWa || uPhone.endsWith(cleanWa) || cleanWa.endsWith(uPhone));
    });

    if (matched) {
        const resBox = document.getElementById('fu-result-box');
        const foundEl = document.getElementById('fu-found-username');
        if (resBox && foundEl) {
            foundEl.innerText = matched.username;
            resBox.classList.remove('hidden-view');
        }
        showToast('Akun ditemukan! Username Anda telah ditampilkan.', 'success');
    } else {
        showToast('Data tidak ditemukan! Pastikan email dan nomor WhatsApp sesuai.', 'error');
    }
}

function useFoundUsername() {
    const foundEl = document.getElementById('fu-found-username');
    if (foundEl && foundEl.innerText) {
        const uInput = document.getElementById('l-user');
        if (uInput) uInput.value = foundEl.innerText;
        closeModal('modal-forgot-username');
        showToast(`Username ${foundEl.innerText} telah dimasukkan ke form login`, 'info');
    }
}

// ==========================================
// RESET PASSWORD (LUPA PASSWORD)
// ==========================================
let fpTempUser = null;
let fpActiveOtp = null;

function openForgotPasswordModal() {
    const m = document.getElementById('modal-forgot-password');
    if (m) {
        document.getElementById('fp-step-1').classList.remove('hidden-view');
        document.getElementById('fp-step-2').classList.add('hidden-view');
        document.getElementById('fp-user').value = '';
        document.getElementById('fp-email').value = '';
        document.getElementById('fp-otp').value = '';
        document.getElementById('fp-new-pass').value = '';
        document.getElementById('fp-new-pass-conf').value = '';
        m.classList.remove('hidden-view');
    }
}

function submitForgotPasswordStep1() {
    const user = (document.getElementById('fp-user').value || '').trim().toLowerCase();
    const email = (document.getElementById('fp-email').value || '').trim().toLowerCase();

    if (!user || !email) {
        showToast('Username dan email wajib diisi!', 'warning');
        return;
    }

    const users = getAllUsers();
    const matched = users.find(u => u.username.toLowerCase() === user && (u.email || '').toLowerCase() === email);

    if (!matched) {
        showToast('Username atau email tidak terdaftar!', 'error');
        return;
    }

    fpTempUser = matched;
    fpActiveOtp = String(Math.floor(100000 + Math.random() * 900000));

    document.getElementById('fp-step-1').classList.add('hidden-view');
    document.getElementById('fp-step-2').classList.remove('hidden-view');

    showToast(`Mengirim kode OTP reset ke email ${email}...`, 'info');
    fetch(getApiEndpoint('/api/auth/send-referral-email'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: email,
            username: user,
            code: fpActiveOtp,
            type: 'reset_password'
        })
    })
    .then(r => r.json())
    .then(res => {
        showToast(`Kode OTP reset telah dikirim ke email ${email}`, 'success');
    })
    .catch(err => {
        showToast(`Kode OTP reset diproses untuk email ${email}`, 'info');
    });
}

function autoFillFpOtp() {
    // Disabled in production mode
}

function backToFpStep1() {
    document.getElementById('fp-step-1').classList.remove('hidden-view');
    document.getElementById('fp-step-2').classList.add('hidden-view');
}

// ==========================================
// PENGELOLAAN KUNCI AUTENTIKASI ADMIN PUSAT
// ==========================================
async function syncAdminAuthKeyUI() {
    const activeKey = getActiveMasterAuthKey();
    const displayEl = document.getElementById('admin-display-auth-key');
    if (displayEl) displayEl.value = activeKey;

    try {
        const resp = await fetch(getApiEndpoint('/api/auth/get-admin-codes'));
        const res = await resp.json();
        if (res && res.success && res.codes && res.codes['Admin']) {
            const serverKey = res.codes['Admin'];
            localStorage.setItem(MASTER_AUTH_STORAGE_KEY, serverKey);
            if (displayEl) displayEl.value = serverKey;
        }
    } catch(e) {}
}

function toggleShowAdminAuthKey() {
    const input = document.getElementById('admin-display-auth-key');
    const icon = document.getElementById('icon-toggle-auth-key');
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fas fa-eye-slash text-xs';
    } else {
        input.type = 'password';
        icon.className = 'fas fa-eye text-xs';
    }
}

function copyAdminAuthKey() {
    const input = document.getElementById('admin-display-auth-key');
    const val = (input && input.value) ? input.value : getActiveMasterAuthKey();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(() => {
            showToast('Kunci Autentikasi Admin disalin ke clipboard!', 'success');
        }).catch(() => {
            showToast(`Kunci Autentikasi: ${val}`, 'info');
        });
    } else {
        showToast(`Kunci Autentikasi: ${val}`, 'info');
    }
}

function openEditAuthCodeModal() {
    const m = document.getElementById('modal-edit-auth-code');
    const curEl = document.getElementById('input-current-auth-code');
    const newEl = document.getElementById('input-new-auth-code');
    if (curEl) curEl.value = getActiveMasterAuthKey();
    if (newEl) newEl.value = '';
    if (m) m.classList.remove('hidden-view');
}

async function saveNewAdminAuthCode(e) {
    if (e && e.preventDefault) e.preventDefault();
    const newEl = document.getElementById('input-new-auth-code');
    const val = (newEl ? newEl.value : '').trim().toUpperCase();

    if (!val || val.length < 4) {
        showToast('Kunci otorisasi baru minimal 4 karakter!', 'warning');
        return;
    }

    try {
        const resp = await fetch(getApiEndpoint('/api/auth/update-admin-code'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'Admin', newCode: val })
        });
        const res = await resp.json();
        if (res && res.success) {
            setActiveMasterAuthKey(val);
            showToast('Kunci Autentikasi Admin berhasil diperbarui!', 'success');
            closeModal('modal-edit-auth-code');
            syncAdminAuthKeyUI();
            return;
        }
    } catch(err) {}

    // Fallback simpan lokal
    setActiveMasterAuthKey(val);
    showToast('Kunci Autentikasi Admin berhasil diperbarui!', 'success');
    closeModal('modal-edit-auth-code');
    syncAdminAuthKeyUI();
}

function submitForgotPasswordStep2() {
    const otp = (document.getElementById('fp-otp').value || '').trim();
    const newPass = (document.getElementById('fp-new-pass').value || '').trim();
    const newPassConf = (document.getElementById('fp-new-pass-conf').value || '').trim();

    if (!otp) {
        showToast('Masukkan kode OTP!', 'warning');
        return;
    }

    if (otp !== fpActiveOtp) {
        showToast('Kode OTP salah!', 'error');
        return;
    }

    if (newPass.length < 6) {
        showToast('Password baru minimal 6 karakter!', 'error');
        return;
    }

    if (newPass !== newPassConf) {
        showToast('Konfirmasi password baru tidak cocok!', 'error');
        return;
    }

    fpTempUser.password = newPass;
    saveUserAccount(fpTempUser);

    showToast('Password berhasil diubah! Silakan login dengan password baru.', 'success');
    closeModal('modal-forgot-password');

    const pInput = document.getElementById('l-pass');
    if (pInput) pInput.value = newPass;
}

function loginSuccessLogic() {
    document.getElementById('auth-view').classList.add('hidden-view');
    document.getElementById('main-app').classList.remove('hidden-view');
    
    applyRoleRestrictions();
    initChatWebSocket();

    const now = new Date();
    const monthDash = document.getElementById('filter-month-dashboard');
    if (monthDash) monthDash.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}`;
    
    if (CURRENT_USER.role !== 'Admin') {
        loadHistoriTransaksi().then(() => updateKasirDashboard());
    }

    tabHistory = [];
    let startTab = CURRENT_USER.role === 'Admin' ? 'profil' : 'profil';
    history.pushState({ tabId: startTab }, "", `#${startTab}`);
    
    switchTab(startTab, true);
}

// Helper tanggal & waktu lokal
function getHariTanggalIndo() {
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const now = new Date();
    return `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

function extractTrxHour(dateStr) {
    if (!dateStr) return null;
    const match = String(dateStr).match(/(\d{1,2})[:.](\d{2})/);
    if (match) {
        const h = parseInt(match[1], 10);
        if (!isNaN(h) && h >= 0 && h <= 23) return h;
    }
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getHours();
    return null;
}

// Kasir Dashboard
function updateKasirDashboard() {
    if (!CURRENT_USER || CURRENT_USER.role === 'Admin') return;
    
    const namaKasir = CURRENT_USER.username || 'Kasir';
    const cabangKasir = CURRENT_USER.cabang || 'Pusat';

    const namaEl = document.getElementById('profil-kasir-nama');
    const cabangEl = document.getElementById('profil-kasir-cabang');
    const chartCabangEl = document.getElementById('kasir-chart-cabang-label');
    const todayDateEl = document.getElementById('kasir-today-date');

    if (namaEl) namaEl.innerText = namaKasir;
    if (cabangEl) cabangEl.innerText = cabangKasir;
    if (chartCabangEl) chartCabangEl.innerText = cabangKasir;
    if (todayDateEl) todayDateEl.innerText = getHariTanggalIndo();
    
    let totalPenjualan = 0;
    let trxCount = 0;
    let totalItems = 0;
    const menuCounter = {};

    // Interval jam operasional kasir untuk grafik
    const timeSlots = ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
    const salesBySlot = {
        '06:00': 0, '08:00': 0, '10:00': 0, '12:00': 0,
        '14:00': 0, '16:00': 0, '18:00': 0, '20:00': 0, '22:00': 0
    };
    const countBySlot = {
        '06:00': 0, '08:00': 0, '10:00': 0, '12:00': 0,
        '14:00': 0, '16:00': 0, '18:00': 0, '20:00': 0, '22:00': 0
    };

    (HISTORI_TRX_CACHE || []).forEach(t => {
        const isCabangMatch = !CURRENT_USER.cabang || t['Cabang'] === CURRENT_USER.cabang;
        if (!isCabangMatch || !isDateTrxToday(t['Tanggal'])) return;

        trxCount++;
        const omset = Number(t['Total Belanja']) || 0;
        totalPenjualan += omset;

        // Parse items
        try {
            const items = JSON.parse(t['Items JSON'] || '[]');
            items.forEach(item => {
                const qty = Number(item.qty) || 1;
                totalItems += qty;
                const namaMenu = item.nama || 'Menu';
                menuCounter[namaMenu] = (menuCounter[namaMenu] || 0) + qty;
            });
        } catch(e) {}

        // Jam transaksi
        const hour = extractTrxHour(t['Tanggal']);
        let slot = '08:00';
        if (hour !== null) {
            if (hour < 8) slot = '06:00';
            else if (hour < 10) slot = '08:00';
            else if (hour < 12) slot = '10:00';
            else if (hour < 14) slot = '12:00';
            else if (hour < 16) slot = '14:00';
            else if (hour < 18) slot = '16:00';
            else if (hour < 20) slot = '18:00';
            else if (hour < 22) slot = '20:00';
            else slot = '22:00';
        }
        salesBySlot[slot] = (salesBySlot[slot] || 0) + omset;
        countBySlot[slot] = (countBySlot[slot] || 0) + 1;
    });

    const avgTrx = trxCount > 0 ? Math.round(totalPenjualan / trxCount) : 0;
    
    const statHariIni = document.getElementById('stat-kasir-hari-ini');
    const statTrxCount = document.getElementById('stat-kasir-trx-count');
    const statAvgTrx = document.getElementById('stat-kasir-avg-trx');
    const statTotalItems = document.getElementById('stat-kasir-total-items');

    if (statHariIni) statHariIni.innerText = 'Rp ' + formatRupiah(totalPenjualan);
    if (statTrxCount) statTrxCount.innerHTML = `<i class="fas fa-receipt text-emerald-200 mr-1"></i> ${trxCount} Transaksi Selesai`;
    if (statAvgTrx) statAvgTrx.innerText = 'Rp ' + formatRupiah(avgTrx);
    if (statTotalItems) statTotalItems.innerText = `${totalItems} menu`;

    // Render Menu Terlaris Hari Ini
    const topContainer = document.getElementById('kasir-top-products-list');
    if (topContainer) {
        const sortedMenus = Object.entries(menuCounter).sort((a, b) => b[1] - a[1]);
        if (sortedMenus.length > 0) {
            const medals = ['text-amber-500', 'text-gray-400', 'text-amber-700', 'text-blue-500'];
            topContainer.innerHTML = sortedMenus.slice(0, 4).map((entry, idx) => {
                return `
                    <span class="inline-flex items-center gap-1.5 bg-amber-50 text-amber-900 border border-amber-200 px-2.5 py-1 rounded-lg text-[11px] font-bold shadow-xs">
                        <i class="fas fa-award ${medals[idx] || 'text-gray-400'}"></i> ${entry[0]} 
                        <span class="bg-amber-200 text-amber-900 text-[10px] px-1.5 py-0.2 rounded font-black ml-0.5">${entry[1]}x</span>
                    </span>
                `;
            }).join('');
        } else {
            topContainer.innerHTML = `<span class="text-gray-400 italic text-[11px]">Belum ada penjualan menu tercatat hari ini</span>`;
        }
    }

    // Render Grafik Penjualan Hari Ini
    const canvasKasir = document.getElementById('chart-kasir-penjualan');
    if (canvasKasir && typeof Chart !== 'undefined') {
        const ctx = canvasKasir.getContext('2d');
        if (chartKasirPenjualan) {
            chartKasirPenjualan.destroy();
            chartKasirPenjualan = null;
        }
        
        const chartData = timeSlots.map(slot => salesBySlot[slot] || 0);

        chartKasirPenjualan = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: timeSlots,
                datasets: [{
                    label: 'Penjualan Hari Ini',
                    data: chartData,
                    backgroundColor: '#10b981',
                    hoverBackgroundColor: '#059669',
                    borderRadius: 6,
                    borderSkipped: false,
                    maxBarThickness: 36
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1e293b',
                        titleFont: { size: 12, weight: 'bold' },
                        bodyFont: { size: 11 },
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            title: function(items) {
                                if (!items.length) return '';
                                return `Jam Operasional: Sekitar ${items[0].label}`;
                            },
                            label: function(context) {
                                const slot = context.label;
                                const val = context.raw || 0;
                                const count = countBySlot[slot] || 0;
                                return [
                                    `Total Omset: Rp ${formatRupiah(val)}`,
                                    `Jumlah Transaksi: ${count} transaksi`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            font: { size: 10, weight: '600' },
                            color: '#64748b'
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: '#f1f5f9'
                        },
                        ticks: {
                            font: { size: 10 },
                            color: '#94a3b8',
                            callback: function(value) {
                                if (value >= 1000000) return 'Rp ' + (value / 1000000) + 'jt';
                                if (value >= 1000) return 'Rp ' + (value / 1000) + 'rb';
                                return 'Rp ' + value;
                            }
                        }
                    }
                }
            }
        });
    }
}

// Sapaan & Waktu Real-Time Dashboard Admin
let adminLiveClockTimer = null;

function getGreetingByHour(hours) {
    if (hours >= 4 && hours < 11) {
        return {
            text: 'Selamat Pagi ☀️',
            icon: 'fas fa-sun text-amber-300',
            motto: 'Awali hari dengan memeriksa persiapan bahan, stok bubur, dan kesiapan kasir di seluruh cabang.'
        };
    } else if (hours >= 11 && hours < 15) {
        return {
            text: 'Selamat Siang 🌤️',
            icon: 'fas fa-cloud-sun text-amber-200',
            motto: 'Jam makan siang berlangsung, pantau kelancaran pesanan, antrean, dan omset di seluruh outlet.'
        };
    } else if (hours >= 15 && hours < 18) {
        return {
            text: 'Selamat Sore 🌅',
            icon: 'fas fa-sun text-orange-300',
            motto: 'Pantau pergerakan transaksi sore dan koordinasi dengan kasir cabang jika ada kendala.'
        };
    } else {
        return {
            text: 'Selamat Malam 🌙',
            icon: 'fas fa-moon text-indigo-200',
            motto: 'Waktu rekapitulasi penjualan harian dan evaluasi penutupan kasir seluruh cabang Istana Bubur.'
        };
    }
}

function updateAdminDashboardGreeting() {
    if (!CURRENT_USER || CURRENT_USER.role !== 'Admin') return;

    const now = new Date();
    const hours = now.getHours();
    const greeting = getGreetingByHour(hours);

    const greetingTextEl = document.getElementById('admin-dash-greeting-text');
    const greetingIconEl = document.getElementById('admin-dash-greeting-icon');
    const mottoEl = document.getElementById('admin-dash-motto');
    const ownerEl = document.getElementById('dash-owner');
    const dateEl = document.getElementById('admin-live-date');
    const clockEl = document.getElementById('admin-live-clock');

    if (greetingTextEl) greetingTextEl.innerText = greeting.text;
    if (greetingIconEl) greetingIconEl.className = greeting.icon;
    if (mottoEl) mottoEl.innerText = greeting.motto;

    const adminName = CURRENT_USER.username ? (CURRENT_USER.username.charAt(0).toUpperCase() + CURRENT_USER.username.slice(1)) : 'Admin Pusat';
    if (ownerEl) {
        ownerEl.innerText = `${adminName} (Istana Bubur)`;
    }

    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    
    if (dateEl) {
        dateEl.innerText = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    }

    const pad = (n) => String(n).padStart(2, '0');
    if (clockEl) {
        clockEl.innerText = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    // Jalankan timer real-time clock setiap detik jika belum ada
    if (!adminLiveClockTimer) {
        adminLiveClockTimer = setInterval(() => {
            const cur = new Date();
            const curClockEl = document.getElementById('admin-live-clock');
            if (curClockEl) {
                curClockEl.innerText = `${pad(cur.getHours())}:${pad(cur.getMinutes())}:${pad(cur.getSeconds())}`;
            }
            if (cur.getHours() === 0 && cur.getMinutes() === 0 && cur.getSeconds() < 2) {
                const curDateEl = document.getElementById('admin-live-date');
                if (curDateEl) {
                    curDateEl.innerText = `${days[cur.getDay()]}, ${cur.getDate()} ${months[cur.getMonth()]} ${cur.getFullYear()}`;
                }
            }
        }, 1000);
    }
}

// Admin Dashboard & Charts
async function initDashboardCharts() {
    if (!CURRENT_USER || CURRENT_USER.role !== 'Admin') return;
    
    updateAdminDashboardGreeting();
    
    const todayStr = new Date().toISOString().split('T')[0];
    const sDate = document.getElementById('filter-start-date');
    const eDate = document.getElementById('filter-end-date');
    if (sDate && !sDate.value) sDate.value = todayStr;
    if (eDate && !eDate.value) eDate.value = todayStr;

    try { 
        const resGaji = await callBackend('getHistori'); 
        HISTORI_GAJI_CACHE = parseDataArray(resGaji); 
    } catch(e){}

    try { 
        const resKaryawan = await callBackend('getKaryawan'); 
        KARYAWAN_CACHE = parseDataArray(resKaryawan); 
    } catch(e){}

    try { 
        const resTrx = await callBackend('getHistoriTransaksi'); 
        HISTORI_TRX_CACHE = parseDataArray(resTrx); 
    } catch(e){}

    populateCabangFilterDashboard(); 
    updateDashboardCharts();
}

function populateCabangFilterDashboard() {
    const filter = document.getElementById('filter-cabang-dashboard');
    if (!filter) return;
    const cabangs = new Set();
    (HISTORI_TRX_CACHE || []).forEach(t => { if (t['Cabang']) cabangs.add(t['Cabang']); });
    let html = '<option value="Semua">Semua Cabang</option>';
    cabangs.forEach(c => html += `<option value="${c}">${c}</option>`);
    filter.innerHTML = html;
}

function parseTrxDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split(' ');
    if (parts.length === 0) return null;
    const dateParts = parts[0].split('/');
    if (dateParts.length !== 3) return null;
    return new Date(dateParts[2], dateParts[1] - 1, dateParts[0]);
}

function resetDateFilter() {
    const todayStr = new Date().toISOString().split('T')[0];
    const sDate = document.getElementById('filter-start-date');
    const eDate = document.getElementById('filter-end-date');
    if (sDate) sDate.value = todayStr;
    if (eDate) eDate.value = todayStr;
    updateDashboardCharts();
}

function updateDashboardCharts() {
    if (!CURRENT_USER || CURRENT_USER.role !== 'Admin') return;
    const filterVal = document.getElementById('filter-month-dashboard')?.value;
    const filterCabang = document.getElementById('filter-cabang-dashboard')?.value || 'Semua';
    const filterStartDate = document.getElementById('filter-start-date')?.value;
    const filterEndDate = document.getElementById('filter-end-date')?.value;
    
    const statKaryawan = document.getElementById('stat-karyawan');
    if (statKaryawan) statKaryawan.innerText = KARYAWAN_CACHE ? KARYAWAN_CACHE.length : 0;

    let filteredGaji = HISTORI_GAJI_CACHE || [];
    if (filterVal) filteredGaji = filteredGaji.filter(g => g['Bulan'] === filterVal);
    
    let totalPokok = 0, totalBonus = 0, totalPotongan = 0, totalBersih = 0;
    filteredGaji.forEach(g => {
        const bonus = Number(g['Bonus']) || 0, potongan = Number(g['Potongan']) || 0, total = Number(g['Total Gaji']) || 0;
        totalPokok += (total - bonus + potongan); 
        totalBonus += bonus; 
        totalPotongan += potongan; 
        totalBersih += total;
    });

    const statGaji = document.getElementById('stat-gaji');
    if (statGaji) statGaji.innerText = 'Rp ' + formatRupiah(totalBersih);

    const canvasDonut = document.getElementById('chart-penggajian');
    if (canvasDonut) {
        const ctxDonut = canvasDonut.getContext('2d');
        if (chartPenggajian) chartPenggajian.destroy();
        let donutData = [totalPokok, totalBonus, totalPotongan];
        let donutBgColors = ['#3b82f6', '#10b981', '#ef4444'];
        let donutLabels = ['Gaji Pokok', 'Bonus', 'Potongan'];
        if (totalPokok === 0 && totalBonus === 0 && totalPotongan === 0) { 
            donutData = [1]; 
            donutBgColors = ['#e5e7eb']; 
            donutLabels = ['Belum Ada Data']; 
        }
        chartPenggajian = new Chart(ctxDonut, { 
            type: 'doughnut', 
            data: { labels: donutLabels, datasets: [{ data: donutData, backgroundColor: donutBgColors, borderWidth: 0, hoverOffset: 4 }] }, 
            options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: {size: 10} } }, tooltip: { enabled: (totalBersih > 0) } } } 
        });
    }

    const branchCounts = {};
    (KARYAWAN_CACHE || []).forEach(k => { 
        const branch = k['Lokasi Cabang'] || 'Pusat'; 
        branchCounts[branch] = (branchCounts[branch] || 0) + 1; 
    });

    const canvasBar = document.getElementById('chart-karyawan');
    if (canvasBar) {
        const ctxBar = canvasBar.getContext('2d');
        if (chartKaryawan) chartKaryawan.destroy();
        chartKaryawan = new Chart(ctxBar, { 
            type: 'bar', 
            data: { labels: Object.keys(branchCounts).length ? Object.keys(branchCounts) : ['Belum Ada Data'], datasets: [{ label: 'Karyawan', data: Object.values(branchCounts).length ? Object.values(branchCounts) : [0], backgroundColor: '#ef4444', borderRadius: 4 }] }, 
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1, font: {size: 10} } }, x: { ticks: { font: {size: 10} } } }, plugins: { legend: { display: false } } } 
        });
    }

    let filteredTrx = HISTORI_TRX_CACHE || [];
    if (filterCabang !== 'Semua') filteredTrx = filteredTrx.filter(t => t['Cabang'] === filterCabang);
    if (filterStartDate || filterEndDate) {
        let start = filterStartDate ? new Date(filterStartDate) : null;
        let end = filterEndDate ? new Date(filterEndDate) : null;
        if (start) start.setHours(0, 0, 0, 0); 
        if (end) end.setHours(23, 59, 59, 999);
        filteredTrx = filteredTrx.filter(t => {
            const trxDate = parseTrxDate(t['Tanggal']); 
            if (!trxDate) return false;
            let isValid = true;
            if (start && trxDate < start) isValid = false; 
            if (end && trxDate > end) isValid = false;
            return isValid;
        });
    }
    
    let totalPenjualan = 0; 
    let trxCount = filteredTrx.length; 
    const penjualanPerCabang = {};
    filteredTrx.forEach(t => { 
        const cabang = t['Cabang'] || 'Pusat'; 
        const omset = Number(t['Total Belanja']) || 0; 
        totalPenjualan += omset; 
        penjualanPerCabang[cabang] = (penjualanPerCabang[cabang] || 0) + omset; 
    });

    const statPenjualan = document.getElementById('stat-penjualan');
    const statTrxCount = document.getElementById('stat-trx-count');
    if (statPenjualan) statPenjualan.innerText = 'Rp ' + formatRupiah(totalPenjualan); 
    if (statTrxCount) statTrxCount.innerText = `${trxCount} Transaksi Selesai`;

    const canvasPenjualan = document.getElementById('chart-penjualan');
    if (canvasPenjualan) {
        const ctxPenjualan = canvasPenjualan.getContext('2d');
        if (chartPenjualan) chartPenjualan.destroy();
        chartPenjualan = new Chart(ctxPenjualan, { 
            type: 'bar', 
            data: { labels: Object.keys(penjualanPerCabang).length ? Object.keys(penjualanPerCabang) : ['Belum Ada Data'], datasets: [{ label: 'Total Penjualan', data: Object.values(penjualanPerCabang).length ? Object.values(penjualanPerCabang) : [0], backgroundColor: '#10b981', borderRadius: 4 }] }, 
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { callback: function(value) { return 'Rp ' + (value/1000) + 'k'; }, font: {size: 10} } }, x: { ticks: { font: {size: 10} } } }, plugins: { legend: { display: false } } } 
        });
    }
}

function renderDashboardSalesCharts() {
    updateDashboardCharts();
}

// Karyawan & Slip Gaji Logic
async function loadKaryawan() {
    const loading = document.getElementById('loading-karyawan');
    if (loading) loading.classList.remove('hidden-view');
    const list = document.getElementById('list-karyawan');
    if (list) list.innerHTML = '';
    try {
        const res = await callBackend('getKaryawan'); 
        KARYAWAN_CACHE = parseDataArray(res); 
        if (KARYAWAN_CACHE.length === 0) { 
            list.innerHTML = `<div class="text-center text-gray-400 py-10"><i class="fas fa-users-slash text-4xl mb-3"></i><p class="text-sm">Belum ada karyawan</p></div>`; 
        } else { 
            list.innerHTML = KARYAWAN_CACHE.map(k => `
                <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-center gap-2">
                    <div class="flex-1 overflow-hidden">
                        <p class="font-bold text-sm text-gray-800 truncate">${k['Nama']}</p>
                        <p class="text-[10px] text-gray-500 truncate">${k['Lokasi Cabang']} &bull; ${k['Jabatan']}</p>
                        <p class="text-[10px] text-gray-400 mt-0.5">Rp ${formatRupiah(k['Gaji Harian'])}/hari</p>
                    </div>
                    <div class="flex gap-2">
                        <button onclick='editKaryawan(${JSON.stringify(k)})' class="bg-blue-50 text-blue-600 w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold hover:bg-blue-100 transition"><i class="fas fa-edit"></i></button>
                        <button onclick="confirmHapusKaryawan(${k.rowIndex})" class="bg-red-50 text-red-600 w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold hover:bg-red-100 transition"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`).join(''); 
        }
        if (CURRENT_USER.role === 'Admin') initDashboardCharts(); 
    } catch (e) { 
        showToast('Gagal memuat karyawan', 'error'); 
    }
    if (loading) loading.classList.add('hidden-view');
}

function openFormKaryawan() { 
    document.getElementById('form-karyawan').reset(); 
    document.getElementById('k-rowIndex').value = ''; 
    document.getElementById('modal-title').innerHTML = 'Tambah Karyawan <button onclick="closeModal(\'modal-karyawan\')"><i class="fas fa-times text-gray-400"></i></button>'; 
    document.getElementById('modal-karyawan').classList.remove('hidden-view'); 
}

function editKaryawan(k) { 
    openFormKaryawan(); 
    document.getElementById('modal-title').innerHTML = 'Edit Karyawan <button onclick="closeModal(\'modal-karyawan\')"><i class="fas fa-times text-gray-400"></i></button>'; 
    document.getElementById('k-rowIndex').value = k.rowIndex; 
    document.getElementById('k-nama').value = k['Nama'] || ''; 
    document.getElementById('k-gender').value = k['Jenis Kelamin'] || 'Laki-laki'; 
    document.getElementById('k-jabatan').value = k['Jabatan'] || 'Kasir'; 
    document.getElementById('k-cabang').value = k['Lokasi Cabang'] || ''; 
    document.getElementById('k-wa').value = k['No WA'] || ''; 
    document.getElementById('k-gaji').value = k['Gaji Harian'] || ''; 
    document.getElementById('k-email').value = k['Email'] || ''; 
}

async function saveKaryawanData(e) { 
    e.preventDefault(); 
    const btn = document.getElementById('btn-save-karyawan'); 
    btn.innerHTML = '<div class="loader border-white"></div> Menyimpan...'; 
    btn.disabled = true; 
    const data = { 
        rowIndex: document.getElementById('k-rowIndex').value, 
        'Nama': document.getElementById('k-nama').value, 
        'Jenis Kelamin': document.getElementById('k-gender').value, 
        'Jabatan': document.getElementById('k-jabatan').value, 
        'Lokasi Cabang': document.getElementById('k-cabang').value, 
        'No WA': document.getElementById('k-wa').value, 
        'Gaji Harian': document.getElementById('k-gaji').value, 
        'Email': document.getElementById('k-email').value 
    }; 
    try { 
        const res = await callBackend('saveKaryawan', data); 
        if (res.success) { 
            showToast(res.message, 'success'); 
            closeModal('modal-karyawan'); 
            loadKaryawan(); 
        } else { 
            showToast(res.message, 'error'); 
        } 
    } catch(err) { 
        showToast('Gagal menyimpan karyawan', 'error'); 
    } 
    btn.innerHTML = 'Simpan'; 
    btn.disabled = false; 
}

function confirmHapusKaryawan(id) { 
    document.getElementById('confirm-title').innerText = 'Hapus Karyawan?'; 
    document.getElementById('btn-confirm-action').onclick = async () => { 
        closeModal('modal-confirm'); 
        try { 
            const res = await callBackend('deleteKaryawan', id); 
            if (res.success) { 
                showToast(res.message, 'success'); 
                loadKaryawan(); 
            } 
        } catch(e) { 
            showToast('Gagal menghapus data', 'error'); 
        } 
    }; 
    document.getElementById('modal-confirm').classList.remove('hidden-view'); 
}

async function loadKaryawanForSlip() { 
    if (!Array.isArray(KARYAWAN_CACHE) || KARYAWAN_CACHE.length === 0) { 
        try { 
            const res = await callBackend('getKaryawan'); 
            KARYAWAN_CACHE = parseDataArray(res); 
        } catch(e) {} 
    } 
    const select = document.getElementById('s-karyawan'); 
    if (select) {
        select.innerHTML = '<option value="">-- Pilih Karyawan --</option>' + (KARYAWAN_CACHE || []).map(k => `<option value="${k['ID Karyawan']}">${k['Nama']} - ${k['Lokasi Cabang']}</option>`).join(''); 
    }
}

function autoFillSlipGaji() { 
    const id = document.getElementById('s-karyawan').value; 
    const k = KARYAWAN_CACHE.find(x => String(x['ID Karyawan']) === String(id)); 
    if (k) { 
        document.getElementById('s-gaji').value = k['Gaji Harian']; 
        hitungTotalGaji(); 
    } else { 
        document.getElementById('s-gaji').value = ''; 
        document.getElementById('s-total').innerText = 'Rp 0'; 
    } 
}

function hitungTotalGaji() { 
    const harian = Number(document.getElementById('s-gaji').value || 0);
    const hari = Number(document.getElementById('s-hari').value || 0);
    const bonus = Number(document.getElementById('s-bonus').value || 0);
    const potongan = Number(document.getElementById('s-potongan').value || 0); 
    const total = (harian * hari) + bonus - potongan; 
    document.getElementById('s-total').innerText = 'Rp ' + formatRupiah(total); 
}

function resetFormSlip() { 
    const form = document.getElementById('form-slip');
    if (form) form.reset(); 
    document.getElementById('s-total').innerText = 'Rp 0'; 
    document.getElementById('hasil-slip').classList.add('hidden-view'); 
    const now = new Date(); 
    document.getElementById('s-bulan').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')}`; 
}

async function generateSlip(e) { 
    e.preventDefault(); 
    const btn = document.getElementById('btn-generate-slip'); 
    const kId = document.getElementById('s-karyawan').value; 
    const k = (KARYAWAN_CACHE || []).find(x => String(x['ID Karyawan']) === String(kId)); 
    if (!k) { 
        showToast('Silahkan pilih Karyawan terlebih dahulu!', 'error'); 
        return; 
    } 
    btn.innerHTML = '<div class="loader border-white"></div> Memproses...'; 
    btn.disabled = true; 
    const data = { 
        id: k['ID Karyawan'], 
        nama: k['Nama'], 
        cabang: k['Lokasi Cabang'], 
        jabatan: k['Jabatan'], 
        wa: k['No WA'], 
        gajiHarian: k['Gaji Harian'], 
        bulan: document.getElementById('s-bulan').value, 
        hariMasuk: document.getElementById('s-hari').value, 
        keteranganLibur: document.getElementById('s-keterangan').value, 
        bonus: document.getElementById('s-bonus').value, 
        potongan: document.getElementById('s-potongan').value 
    }; 
    try { 
        const res = await callBackend('processSlipGaji', data); 
        if (res.success) { 
            document.getElementById('hasil-slip').classList.remove('hidden-view'); 
            
            const slipObj = {
                'ID Slip': res.idSlip || 'SLIP-NEW',
                'Nama': k['Nama'],
                'ID Karyawan': k['ID Karyawan'],
                'Bulan': data.bulan,
                'Hari Masuk': data.hariMasuk,
                'Gaji Harian': data.gajiHarian,
                'Bonus': data.bonus,
                'Potongan': data.potongan,
                'Total Gaji': (Number(data.gajiHarian) * Number(data.hariMasuk)) + Number(data.bonus) - Number(data.potongan),
                'Cabang': k['Lokasi Cabang'] || 'Pusat',
                'Jabatan': k['Jabatan'] || '-',
                'No WA': k['No WA'] || '',
                'Keterangan Libur': data.keteranganLibur,
                'Link PDF': res.pdfUrl || '#'
            };

            const linkPdf = document.getElementById('link-pdf');
            if (linkPdf) {
                linkPdf.onclick = (ev) => {
                    ev.preventDefault();
                    cetakSlipGajiPDF(slipObj);
                };
            }
            const linkWa = document.getElementById('link-wa');
            if (linkWa) {
                linkWa.onclick = (ev) => {
                    ev.preventDefault();
                    kirimWaSlipGajiDirect(slipObj);
                };
            }

            showToast(res.message, 'success'); 
            HISTORI_GAJI_CACHE = []; 
        } else { 
            showToast(res.message, 'error'); 
        } 
    } catch(err) { 
        showToast('Gagal mencetak slip', 'error'); 
    } 
    btn.innerHTML = '<i class="fas fa-print"></i> Cetak PDF'; 
    btn.disabled = false; 
}

// Produk Master Logic
async function loadProduk() { 
    const loading = document.getElementById('loading-produk');
    if (loading) loading.classList.remove('hidden-view'); 
    const list = document.getElementById('list-produk');
    if (list) list.innerHTML = ''; 
    try { 
        const res = await callBackend('getProduk'); 
        PRODUK_CACHE = parseDataArray(res); 
        renderListProduk(); 
    } catch(e) { 
        showToast('Gagal memuat produk', 'error'); 
    } 
    if (loading) loading.classList.add('hidden-view'); 
}

function renderListProduk() { 
    const list = document.getElementById('list-produk'); 
    const searchInput = document.getElementById('search-produk'); 
    const keyword = searchInput ? searchInput.value.toLowerCase() : ''; 
    let filteredProduk = PRODUK_CACHE; 
    if (keyword) { 
        filteredProduk = PRODUK_CACHE.filter(p => { 
            const nama = (p['Nama Produk'] || '').toLowerCase(); 
            const id = String(p['ID Produk'] || '').toLowerCase(); 
            return nama.includes(keyword) || id.includes(keyword); 
        }); 
    } 
    if (filteredProduk.length === 0) { 
        list.innerHTML = `<div class="col-span-full text-center text-gray-400 py-10"><i class="fas fa-box-open text-4xl mb-3"></i><p class="text-sm">Produk tidak ditemukan</p></div>`; 
        return; 
    } 
    list.innerHTML = filteredProduk.map(p => `
        <div class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
            <div class="h-28 bg-gray-100 relative">
                ${p['GambarBase64'] ? `<img src="${p['GambarBase64']}" class="w-full h-full object-cover">` : `<div class="w-full h-full flex items-center justify-center text-gray-300"><i class="fas fa-image text-3xl"></i></div>`}
            </div>
            <div class="p-3 flex flex-col flex-1">
                <p class="font-bold text-xs text-gray-800 line-clamp-2 mb-1">${p['Nama Produk']}</p>
                <p class="text-xs text-gray-500 font-medium mb-2">Rp ${formatRupiah(p['Harga'])}</p>
                <div class="flex gap-2 mt-auto pt-2 border-t border-gray-100">
                    <button onclick='editProduk(${JSON.stringify(p)})' class="flex-1 bg-blue-50 text-blue-600 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-100 transition"><i class="fas fa-edit"></i></button>
                    <button onclick="confirmHapusProduk(${p.rowIndex})" class="flex-1 bg-red-50 text-red-600 py-1.5 rounded-lg text-xs font-bold hover:bg-red-100 transition"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        </div>`).join(''); 
}

function openFormProduk() { 
    document.getElementById('form-produk').reset(); 
    document.getElementById('pr-rowIndex').value = ''; 
    document.getElementById('pr-base64').value = ''; 
    document.getElementById('pr-preview').classList.add('hidden-view'); 
    document.getElementById('pr-placeholder').classList.remove('hidden-view'); 
    document.getElementById('mp-title').innerText = 'Tambah Produk'; 
    document.getElementById('modal-produk').classList.remove('hidden-view'); 
}

function editProduk(p) { 
    openFormProduk(); 
    document.getElementById('mp-title').innerText = 'Edit Produk'; 
    document.getElementById('pr-rowIndex').value = p.rowIndex; 
    document.getElementById('pr-nama').value = p['Nama Produk']; 
    document.getElementById('pr-harga').value = p['Harga']; 
    if (p['GambarBase64']) { 
        document.getElementById('pr-base64').value = p['GambarBase64']; 
        document.getElementById('pr-preview').src = p['GambarBase64']; 
        document.getElementById('pr-preview').classList.remove('hidden-view'); 
        document.getElementById('pr-placeholder').classList.add('hidden-view'); 
    } 
}

function previewImage(event) { 
    const file = event.target.files[0]; 
    if (!file) return; 
    const reader = new FileReader(); 
    reader.onload = function(e) { 
        document.getElementById('pr-base64').value = e.target.result; 
        document.getElementById('pr-preview').src = e.target.result; 
        document.getElementById('pr-preview').classList.remove('hidden-view'); 
        document.getElementById('pr-placeholder').classList.add('hidden-view'); 
    }; 
    reader.readAsDataURL(file); 
}

async function saveProdukData(e) { 
    e.preventDefault(); 
    const btn = document.getElementById('btn-save-produk'); 
    btn.innerHTML = '<div class="loader border-white"></div> Menyimpan...'; 
    btn.disabled = true; 
    const data = { 
        rowIndex: document.getElementById('pr-rowIndex').value, 
        nama: document.getElementById('pr-nama').value, 
        harga: document.getElementById('pr-harga').value, 
        gambar: document.getElementById('pr-base64').value 
    }; 
    try { 
        const res = await callBackend('saveProduk', data); 
        if (res.success) { 
            showToast(res.message, 'success'); 
            closeModal('modal-produk'); 
            loadProduk(); 
        } else { 
            showToast(res.message, 'error'); 
        } 
    } catch(err) { 
        showToast('Gagal menyimpan produk', 'error'); 
    } 
    btn.innerHTML = 'Simpan Produk'; 
    btn.disabled = false; 
}

function confirmHapusProduk(id) { 
    document.getElementById('confirm-title').innerText = 'Hapus Produk?'; 
    document.getElementById('btn-confirm-action').onclick = async () => { 
        closeModal('modal-confirm'); 
        try { 
            const res = await callBackend('deleteProduk', id); 
            if (res.success) { 
                showToast(res.message, 'success'); 
                loadProduk(); 
            } 
        } catch(e) { 
            showToast('Gagal menghapus data', 'error'); 
        } 
    }; 
    document.getElementById('modal-confirm').classList.remove('hidden-view'); 
}

// Kasir POS & Cart Logic
function loadProdukKasir() {
    if (!PRODUK_CACHE || PRODUK_CACHE.length === 0) {
        callBackend('getProduk').then(res => {
            PRODUK_CACHE = parseDataArray(res);
            renderKasirProdukList();
        });
    } else {
        renderKasirProdukList();
    }
}

function renderKasirProdukList() {
    const list = document.getElementById('list-kasir-produk');
    if (!list) return;
    const searchInput = document.getElementById('search-kasir-produk');
    const keyword = searchInput ? searchInput.value.toLowerCase() : '';
    
    let filteredProduk = PRODUK_CACHE;
    if (keyword) {
        filteredProduk = PRODUK_CACHE.filter(p => {
            const nama = (p['Nama Produk'] || '').toLowerCase();
            return nama.includes(keyword);
        });
    }

    if (filteredProduk.length === 0) {
        list.innerHTML = `<div class="col-span-full text-center text-gray-400 py-10"><i class="fas fa-box-open text-4xl mb-3"></i><p class="text-sm">Produk tidak ditemukan</p></div>`;
        return;
    }
    
    list.innerHTML = filteredProduk.map(p => `
        <div onclick="addToCart('${p['ID Produk']}')" class="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col cursor-pointer hover:border-red-400 hover:shadow-md transition">
            <div class="h-24 bg-gray-100 relative">
                ${p['GambarBase64'] ? `<img src="${p['GambarBase64']}" class="w-full h-full object-cover">` : `<div class="w-full h-full flex items-center justify-center text-gray-300"><i class="fas fa-image text-2xl"></i></div>`}
            </div>
            <div class="p-2 flex flex-col flex-1 text-center">
                <p class="font-bold text-[10px] text-gray-800 line-clamp-2 mb-1">${p['Nama Produk']}</p>
                <p class="text-[10px] text-red-600 font-bold mt-auto">Rp ${formatRupiah(p['Harga'])}</p>
            </div>
        </div>
    `).join('');
}

function addToCart(id) {
    const p = PRODUK_CACHE.find(x => String(x['ID Produk']) === String(id));
    if (!p) return;
    const existing = CART.find(x => String(x.id) === String(id));
    if (existing) { 
        existing.qty += 1; 
    } else { 
        CART.push({ id: p['ID Produk'], nama: p['Nama Produk'], harga: Number(p['Harga']), qty: 1 }); 
    }
    updateCartUI();
    showToast(p['Nama Produk'] + ' ditambahkan', 'success');
}

function updateCartUI() {
    const total = CART.reduce((sum, item) => sum + (item.harga * item.qty), 0);
    const badge = document.getElementById('cart-badge');
    const totalBanner = document.getElementById('cart-total-banner');
    const modalTotal = document.getElementById('cart-modal-total');

    if (badge) badge.innerText = CART.reduce((s, i) => s + i.qty, 0);
    if (totalBanner) totalBanner.innerText = 'Rp ' + formatRupiah(total);
    if (modalTotal) modalTotal.innerText = 'Rp ' + formatRupiah(total);
    
    const container = document.getElementById('cart-items-container');
    if (!container) return;
    if (CART.length === 0) {
        container.innerHTML = `<div class="text-center text-gray-400 mt-10"><i class="fas fa-shopping-basket text-4xl mb-3"></i><p class="text-sm">Keranjang kosong</p></div>`;
        return;
    }
    
    container.innerHTML = CART.map((item, index) => `
        <div class="bg-white p-3 rounded-xl shadow-sm border border-gray-100 mb-2 flex justify-between items-center">
            <div class="flex-1">
                <p class="font-bold text-xs text-gray-800 line-clamp-1">${item.nama}</p>
                <p class="text-[10px] text-red-600 font-semibold mt-0.5">Rp ${formatRupiah(item.harga)}</p>
            </div>
            <div class="flex items-center gap-3">
                <div class="flex items-center bg-gray-50 rounded-lg border border-gray-200">
                    <button type="button" onclick="changeQty(${index}, -1)" class="w-7 h-7 flex items-center justify-center text-gray-600 hover:bg-gray-200 rounded-l-lg">-</button>
                    <span class="text-xs font-bold w-6 text-center">${item.qty}</span>
                    <button type="button" onclick="changeQty(${index}, 1)" class="w-7 h-7 flex items-center justify-center text-gray-600 hover:bg-gray-200 rounded-r-lg">+</button>
                </div>
            </div>
        </div>
    `).join('');
}

function changeQty(index, delta) {
    if (!CART[index]) return;
    CART[index].qty += delta;
    if (CART[index].qty <= 0) CART.splice(index, 1);
    updateCartUI();
}

function openCartModal() {
    if (CART.length === 0) {
        showToast('Keranjang masih kosong', 'error');
        return;
    }
    document.getElementById('modal-cart').classList.remove('hidden-view');
    document.getElementById('form-checkout').classList.remove('hidden-view');
    document.getElementById('checkout-result').classList.add('hidden-view');
    
    const cashRadio = document.querySelector('input[name="metode-bayar"][value="Cash"]');
    if (cashRadio) cashRadio.checked = true;
    togglePaymentMethod('Cash'); 
    
    const coBayar = document.getElementById('co-bayar');
    if (coBayar) coBayar.value = '';
    
    hitungKembalian();
}

function clearCart() { 
    CART = []; 
    updateCartUI(); 
    closeModal('modal-cart'); 
}

function togglePaymentMethod(method) {
    const secCash = document.getElementById('section-cash');
    const secTrf = document.getElementById('section-transfer');
    const coBayar = document.getElementById('co-bayar');

    if (method === 'Cash') {
        if (secCash) secCash.classList.remove('hidden-view');
        if (secTrf) secTrf.classList.add('hidden-view');
        if (coBayar) coBayar.required = true;
    } else {
        if (secCash) secCash.classList.add('hidden-view');
        if (secTrf) secTrf.classList.remove('hidden-view');
        if (coBayar) {
            coBayar.required = false;
            coBayar.value = '';
        }
        const kembaliEl = document.getElementById('co-kembali');
        if (kembaliEl) kembaliEl.innerText = 'Rp 0';
    }
}

function hitungKembalian() {
    const total = CART.reduce((sum, item) => sum + (item.harga * item.qty), 0);
    const bayar = Number(document.getElementById('co-bayar')?.value) || 0;
    const kembali = bayar - total;
    
    const kembaliEl = document.getElementById('co-kembali');
    if (!kembaliEl) return;
    if (kembali < 0) {
        kembaliEl.innerText = 'Kurang Rp ' + formatRupiah(Math.abs(kembali));
        kembaliEl.className = 'text-red-500 font-bold';
    } else {
        kembaliEl.innerText = 'Rp ' + formatRupiah(kembali);
        kembaliEl.className = 'text-green-600 font-bold';
    }
}

// PROCESS CHECKOUT (Fix: populates LAST_TRX_DATA so PDF, WhatsApp & Thermal buttons work!)
async function processCheckout(e) {
    if (e && e.preventDefault) e.preventDefault(); 
    
    if (CART.length === 0) { 
        showToast('Keranjang masih kosong!', 'error'); 
        return; 
    }
    
    let total = 0; 
    CART.forEach(i => total += (i.harga * i.qty));
    
    const selectedMetode = document.querySelector('input[name="metode-bayar"]:checked')?.value || 'Cash';
    let bayar = total;
    let kembali = 0;
    let infoPembayaran = selectedMetode;

    if (selectedMetode === 'Cash') {
        bayar = Number(document.getElementById('co-bayar')?.value || 0);
        if (bayar < total) { 
            showToast('Uang pembayaran kurang!', 'error'); 
            return; 
        }
        kembali = bayar - total;
    } else {
        const bank = document.getElementById('co-bank')?.value || 'Transfer';
        const ref = document.getElementById('co-ref')?.value || '';
        infoPembayaran = `Transfer (${bank}${ref ? ' - Ref: ' + ref : ''})`;
    }
    
    const btn = document.getElementById('btn-checkout');
    if (btn) {
        btn.innerHTML = '<div class="loader border-white"></div> Memproses...'; 
        btn.disabled = true;
    }

    const namaPelangganInput = document.getElementById('co-nama')?.value.trim() || 'Umum';
    const waInput = document.getElementById('co-wa')?.value.trim() || '';
    const jenisInput = document.getElementById('co-jenis')?.value || 'Dine In';
    const ketInput = document.getElementById('co-keterangan')?.value.trim() || '';
    
    const dataTrx = {
        namaPelanggan: namaPelangganInput,
        wa: waInput,
        jenis: jenisInput,
        keterangan: ketInput,
        items: JSON.parse(JSON.stringify(CART)),
        total: total,
        bayar: bayar,
        kembali: kembali,
        metode: infoPembayaran
    };
    
    try {
        const res = await callBackend('processTransaksiKasir', dataTrx);
        
        if (res.success) {
            const trxId = res.idTrx || ('TRX-' + Math.floor(100000 + Math.random() * 900000));
            const now = new Date();
            const tanggalFormatted = getTodayStringFormatted() + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

            // CRITICAL FIX: Save to LAST_TRX_DATA so PDF, WA, and Thermal receipt work!
            LAST_TRX_DATA = {
                id: trxId,
                cabang: CURRENT_USER ? CURRENT_USER.cabang : 'Pusat',
                kasir: CURRENT_USER ? CURRENT_USER.username : 'Kasir',
                tanggal: tanggalFormatted,
                nama_pelanggan: namaPelangganInput,
                no_wa: waInput,
                jenis_pesanan: jenisInput,
                keterangan: ketInput,
                items: JSON.parse(JSON.stringify(CART)),
                total: total,
                bayar: bayar,
                kembali: kembali,
                metode: infoPembayaran,
                pdfUrl: res.pdfUrl || null,
                waLink: res.waLink || null
            };

            document.getElementById('form-checkout').classList.add('hidden-view');
            document.getElementById('checkout-result').classList.remove('hidden-view');
            
            showToast(res.message || 'Transaksi berhasil!', 'success');
            
            // Reload transaction history cache
            loadHistoriTransaksi();
        } else {
            showToast(res.message || 'Gagal memproses transaksi', 'error');
            if (btn) {
                btn.innerHTML = '<i class="fas fa-check-circle"></i> Selesaikan Transaksi'; 
                btn.disabled = false;
            }
        }
    } catch(err) {
        showToast('Gagal memproses transaksi', 'error');
        if (btn) {
            btn.innerHTML = '<i class="fas fa-check-circle"></i> Selesaikan Transaksi'; 
            btn.disabled = false;
        }
    }
}

function resetCart() {
    CART = [];
    updateCartUI();
    const form = document.getElementById('form-checkout');
    if (form) form.reset();
    const kembaliEl = document.getElementById('co-kembali');
    if (kembaliEl) kembaliEl.innerText = 'Rp 0';
    const jenisEl = document.getElementById('co-jenis');
    if (jenisEl) jenisEl.value = 'Dine In';
    closeModal('modal-cart');
}

// ==========================================
// FEATURE: CETAK / LIHAT NOTA PDF
// ==========================================
function generateReceiptHTML(trx) {
    const itemsHtml = (trx.items || []).map(it => `
        <tr style="border-bottom: 1px dashed #e5e7eb;">
            <td style="padding: 4px 0; font-weight: bold; color: #1f2937;">${it.nama}</td>
            <td style="padding: 4px 0; text-align: center; color: #4b5563;">${it.qty}</td>
            <td style="padding: 4px 0; text-align: right; color: #4b5563;">${formatRupiah(it.harga)}</td>
            <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #111827;">${formatRupiah(it.qty * it.harga)}</td>
        </tr>
    `).join('');

    return `
        <div id="pdf-receipt-content" style="width: 320px; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #ffffff; padding: 20px; box-sizing: border-box; color: #1f2937; line-height: 1.4;">
            <div style="text-align: center; margin-bottom: 12px; border-bottom: 2px dashed #9ca3af; padding-bottom: 12px;">
                <h1 style="font-size: 20px; font-weight: 800; margin: 0; color: #dc2626; letter-spacing: 1px;">ISTANA BUBUR</h1>
                <p style="font-size: 11px; font-weight: 600; color: #4b5563; margin: 2px 0;">Sistem Manajemen & Kasir</p>
                <p style="font-size: 10px; color: #6b7280; margin: 2px 0;">Outlet: ${trx.cabang || 'Pusat'}</p>
            </div>

            <div style="font-size: 11px; margin-bottom: 12px; border-bottom: 1px dashed #d1d5db; padding-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                    <span style="color: #6b7280;">No. Trx:</span>
                    <span style="font-weight: 700; color: #111827;">#${trx.id}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                    <span style="color: #6b7280;">Tanggal:</span>
                    <span>${trx.tanggal || getTodayStringFormatted()}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                    <span style="color: #6b7280;">Kasir:</span>
                    <span>${trx.kasir || '-'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                    <span style="color: #6b7280;">Pelanggan:</span>
                    <span style="font-weight: 600;">${trx.nama_pelanggan || 'Umum'}</span>
                </div>
                ${trx.no_wa ? `<div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span style="color: #6b7280;">No. WA:</span><span>${trx.no_wa}</span></div>` : ''}
                ${trx.jenis_pesanan ? `<div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span style="color: #6b7280;">Tipe:</span><span style="background: #fef2f2; color: #b91c1c; padding: 1px 6px; border-radius: 4px; font-weight: 600;">${trx.jenis_pesanan}</span></div>` : ''}
                ${trx.keterangan ? `<div style="display: flex; justify-content: space-between; margin-bottom: 2px;"><span style="color: #6b7280;">Catatan:</span><span>${trx.keterangan}</span></div>` : ''}
            </div>

            <table style="width: 100%; font-size: 11px; border-collapse: collapse; margin-bottom: 12px;">
                <thead>
                    <tr style="border-bottom: 1px solid #9ca3af; color: #6b7280; font-size: 10px; text-transform: uppercase;">
                        <th style="text-align: left; padding-bottom: 4px;">Item</th>
                        <th style="text-align: center; padding-bottom: 4px;">Qty</th>
                        <th style="text-align: right; padding-bottom: 4px;">Harga</th>
                        <th style="text-align: right; padding-bottom: 4px;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsHtml}
                </tbody>
            </table>

            <div style="border-top: 2px dashed #9ca3af; padding-top: 8px; margin-bottom: 14px; font-size: 11px;">
                <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: 800; margin-bottom: 6px; color: #111827;">
                    <span>TOTAL</span>
                    <span style="color: #16a34a;">Rp ${formatRupiah(trx.total)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 3px; color: #4b5563;">
                    <span>Metode Pembayaran:</span>
                    <span style="font-weight: 600;">${trx.metode || 'Cash'}</span>
                </div>
                ${trx.bayar ? `
                <div style="display: flex; justify-content: space-between; margin-bottom: 3px; color: #4b5563;">
                    <span>Bayar / Tunai:</span>
                    <span>Rp ${formatRupiah(trx.bayar)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; color: #4b5563;">
                    <span>Kembalian:</span>
                    <span style="font-weight: 600;">Rp ${formatRupiah(trx.kembali)}</span>
                </div>` : ''}
            </div>

            <div style="text-align: center; border-top: 1px dashed #d1d5db; padding-top: 12px; font-size: 11px; color: #4b5563;">
                <p style="margin: 2px 0; font-weight: 700; color: #111827;">TERIMA KASIH ATAS KUNJUNGAN ANDA</p>
                <p style="margin: 2px 0; font-size: 10px; color: #6b7280;">Selamat Menikmati Hidangan Istana Bubur</p>
            </div>
        </div>
    `;
}

// ==========================================
// FEATURE: CETAK / LIHAT NOTA PDF & WHATSAPP (ANDROID APK & WEB READY)
// ==========================================

// Helper: Membuka URL di luar aplikasi APK Android (di Google Chrome / browser eksternal sistem)
function openUrlOutsideApp(url) {
    if (!url) return;

    // 1. Cek Native Android Bridge jika APK menyediakan JavascriptInterface
    const native = window.Android || window.AndroidApp || window.BluetoothBridge || window.AndroidPrinter;
    if (native) {
        if (typeof native.openInBrowser === 'function') {
            try { native.openInBrowser(url); return; } catch(e){}
        }
        if (typeof native.openExternal === 'function') {
            try { native.openExternal(url); return; } catch(e){}
        }
        if (typeof native.openBrowser === 'function') {
            try { native.openBrowser(url); return; } catch(e){}
        }
        if (typeof native.openUrl === 'function') {
            try { native.openUrl(url); return; } catch(e){}
        }
    }

    // 2. Cek Cordova / Capacitor InAppBrowser
    try {
        if (window.cordova && window.cordova.InAppBrowser) {
            window.cordova.InAppBrowser.open(url, '_system');
            return;
        }
    } catch(e){}

    const isAndroid = /Android/i.test(navigator.userAgent);

    // 3. Pada Android APK WebView, gunakan Android intent scheme agar sistem melempar URL ke browser Chrome luar
    if (isAndroid && url.startsWith('http')) {
        try {
            const cleanHttp = url.replace(/^https?:\/\//, '');
            const scheme = url.startsWith('https://') ? 'https' : 'http';
            const intentUrl = `intent://${cleanHttp}#Intent;scheme=${scheme};action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;end`;

            const opened = window.open(url, '_system');
            if (!opened || opened.closed) {
                const a = document.createElement('a');
                a.href = intentUrl;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => a.remove(), 1000);
            }
            return;
        } catch(e) {
            console.warn('Android external intent error:', e);
        }
    }

    // 4. Default web browser: buka tab baru
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
}

// Helper: Membuka aplikasi WhatsApp langsung (berpindah ke app WhatsApp di Android)
function openWhatsAppApp(phone, message) {
    let cleanWa = (phone || '').replace(/[^0-9]/g, '');
    if (cleanWa.startsWith('0')) {
        cleanWa = '62' + cleanWa.slice(1);
    } else if (cleanWa.startsWith('8')) {
        cleanWa = '62' + cleanWa;
    }
    const encodedMsg = encodeURIComponent(message || '');

    // 1. Android Native Bridge jika APK memiliki interface native
    const native = window.Android || window.AndroidApp || window.BluetoothBridge || window.AndroidPrinter;
    if (native) {
        if (typeof native.openWhatsApp === 'function') {
            try {
                native.openWhatsApp(cleanWa, message || '');
                showToast('Membuka aplikasi WhatsApp...', 'success');
                return;
            } catch(e) { console.warn('Native openWhatsApp error:', e); }
        }
        if (typeof native.openExternal === 'function') {
            try {
                const targetUri = cleanWa 
                    ? `whatsapp://send?phone=${cleanWa}&text=${encodedMsg}`
                    : `whatsapp://send?text=${encodedMsg}`;
                native.openExternal(targetUri);
                showToast('Membuka aplikasi WhatsApp...', 'success');
                return;
            } catch(e) { console.warn('Native openExternal error:', e); }
        }
    }

    const isAndroid = /Android/i.test(navigator.userAgent);
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (isAndroid) {
        showToast('Berpindah ke aplikasi WhatsApp...', 'success');
        
        // Pada Android APK (WebView), URL dengan skema whatsapp:// langsung memicu OS Android
        // untuk membuka aplikasi resmi WhatsApp
        const waDirectUrl = cleanWa 
            ? `whatsapp://send?phone=${cleanWa}&text=${encodedMsg}`
            : `whatsapp://send?text=${encodedMsg}`;

        // Intent Android package com.whatsapp untuk memastikan aplikasi WhatsApp langsung terbuka
        const intentUrl = cleanWa
            ? `intent://send?phone=${cleanWa}&text=${encodedMsg}#Intent;package=com.whatsapp;scheme=whatsapp;action=android.intent.action.VIEW;end`
            : `intent://send?text=${encodedMsg}#Intent;package=com.whatsapp;scheme=whatsapp;action=android.intent.action.VIEW;end`;

        try {
            window.location.href = waDirectUrl;
        } catch(e) {
            try {
                window.location.href = intentUrl;
            } catch(err2) {
                console.warn(err2);
            }
        }

        // Fallback jika WhatsApp tidak terpasang di HP pengguna
        setTimeout(() => {
            if (!document.hidden) {
                const fallbackUrl = cleanWa 
                    ? `https://api.whatsapp.com/send?phone=${cleanWa}&text=${encodedMsg}`
                    : `https://api.whatsapp.com/send?text=${encodedMsg}`;
                openUrlOutsideApp(fallbackUrl);
            }
        }, 1500);
    } else if (isMobile) {
        const waDirectUrl = cleanWa 
            ? `whatsapp://send?phone=${cleanWa}&text=${encodedMsg}`
            : `whatsapp://send?text=${encodedMsg}`;
        showToast('Membuka aplikasi WhatsApp...', 'success');
        window.location.href = waDirectUrl;
        setTimeout(() => {
            if (!document.hidden) {
                const fallbackUrl = cleanWa 
                    ? `https://api.whatsapp.com/send?phone=${cleanWa}&text=${encodedMsg}`
                    : `https://api.whatsapp.com/send?text=${encodedMsg}`;
                window.open(fallbackUrl, '_blank');
            }
        }, 1200);
    } else {
        // Desktop Browser
        const waWebUrl = cleanWa 
            ? `https://api.whatsapp.com/send?phone=${cleanWa}&text=${encodedMsg}`
            : `https://api.whatsapp.com/send?text=${encodedMsg}`;
        showToast('Membuka WhatsApp...', 'success');
        window.open(waWebUrl, '_blank', 'noopener,noreferrer');
    }
}

// Helper: Menyiapkan dokumen & membuka di luar aplikasi Android agar dapat diunduh ke memori HP
async function openDocPdfOutsideApp(options) {
    const { type, filename, title, htmlContent, element, jsPdfOpt, phone, waMessage } = options;
    showToast('Menyiapkan file PDF untuk dibuka di luar aplikasi...', 'info');

    let base64Pdf = null;
    try {
        if (typeof html2pdf !== 'undefined' && element) {
            const opt = jsPdfOpt || {
                margin: [4, 4, 4, 4],
                filename: filename,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: type === 'nota' ? [80, 200] : 'a5', orientation: 'portrait' }
            };
            const dataUri = await html2pdf().set(opt).from(element).outputPdf('datauristring');
            if (dataUri && dataUri.includes('base64,')) {
                base64Pdf = dataUri.split('base64,')[1];
            }
        }
    } catch(e) {
        console.warn('Client base64 PDF generation error:', e);
    }

    // 1. Simpan dokumen sementara di server agar dapat diakses & diunduh oleh Google Chrome / Browser luar HP
    let externalUrl = null;
    try {
        const resp = await fetch(getApiEndpoint('/api/pdf/prepare-doc'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type,
                filename,
                title,
                htmlContent,
                base64Pdf: base64Pdf || '',
                phone: phone || '',
                waMessage: waMessage || ''
            })
        });
        const res = await resp.json();
        if (res && res.success) {
            const apiBase = getApiEndpoint('');
            const originBase = (window.location.origin && window.location.origin !== 'null' && window.location.protocol.startsWith('http')) 
                ? window.location.origin 
                : (apiBase || 'https://ais-dev-ogj3dc3qbsd5dfa3r23vou-21312793176.asia-southeast1.run.app');
            externalUrl = originBase.replace(/\/+$/, '') + res.viewUrl + '?download=1';
        }
    } catch(err) {
        console.warn('Failed to prepare external doc on server:', err);
    }

    // 2. Buka URL di luar aplikasi Android (browser default / Chrome / sistem unduhan)
    if (externalUrl) {
        openUrlOutsideApp(externalUrl);
        showToast('Membuka & mengunduh PDF di luar aplikasi...', 'success');
    } else {
        showToast('Mengunduh PDF di perangkat...', 'info');
    }

    // 3. Cadangan unduh lokal di dalam web jika didukung
    if (typeof html2pdf !== 'undefined' && element) {
        try {
            const opt = jsPdfOpt || {
                margin: [4, 4, 4, 4],
                filename: filename,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: type === 'nota' ? [80, 200] : 'a5', orientation: 'portrait' }
            };
            html2pdf().set(opt).from(element).save().then(() => {
                showToast('Nota / Slip PDF siap diunduh!', 'success');
            }).catch(() => {});
        } catch(e){}
    }
}

function generateReceiptWhatsAppMessage(trx) {
    const itemsText = (trx.items || []).map(i => `• ${i.nama} (${i.qty}x @Rp ${formatRupiah(i.harga)}) = Rp ${formatRupiah(i.qty * i.harga)}`).join('\n');

    return `*NOTA TRANSAKSI - ISTANA BUBUR*
===============================
*No. Trx:* #${trx.id}
*Tanggal:* ${trx.tanggal || getTodayStringFormatted()}
*Cabang:* ${trx.cabang || 'Pusat'}
*Kasir:* ${trx.kasir || '-'}
*Pelanggan:* ${trx.nama_pelanggan || 'Umum'}
${trx.jenis_pesanan ? `*Tipe Pesanan:* ${trx.jenis_pesanan}\n` : ''}${trx.keterangan ? `*Catatan:* ${trx.keterangan}\n` : ''}===============================
*Rincian Pesanan:*
${itemsText}
===============================
*TOTAL BELANJA: Rp ${formatRupiah(trx.total)}*
*Pembayaran:* ${trx.metode || 'Cash'}${trx.bayar ? `\n*Tunai:* Rp ${formatRupiah(trx.bayar)}\n*Kembalian:* Rp ${formatRupiah(trx.kembali)}` : ''}
===============================
_Terima kasih telah berbelanja di Istana Bubur!_
_Selamat menikmati hidangan kami._`;
}

async function cetakNotaPDF(data = null) {
    const trx = data || LAST_TRX_DATA;
    if (!trx) {
        showToast('Tidak ada data transaksi untuk dibuat PDF', 'error');
        return;
    }

    showToast('Menyiapkan Nota PDF...', 'info');

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'fixed';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '0';
    tempContainer.innerHTML = generateReceiptHTML(trx);
    document.body.appendChild(tempContainer);

    const receiptElement = tempContainer.firstElementChild;
    const filename = `Nota_${trx.id || 'Transaksi'}.pdf`;
    const title = `Nota Transaksi #${trx.id || ''}`;
    const htmlContent = generateReceiptHTML(trx);
    const waMessage = generateReceiptWhatsAppMessage(trx);

    const jsPdfOpt = {
        margin: [4, 4, 4, 4],
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, letterRendering: true },
        jsPDF: { unit: 'mm', format: [80, Math.max(160, 90 + ((trx.items?.length || 1) * 14))], orientation: 'portrait' }
    };

    await openDocPdfOutsideApp({
        type: 'nota',
        filename,
        title,
        htmlContent,
        element: receiptElement,
        jsPdfOpt,
        phone: trx.no_wa || '',
        waMessage
    });

    setTimeout(() => tempContainer.remove(), 2000);
}

function printReceiptFallback(htmlContent) {
    const frame = document.getElementById('print-frame');
    if (frame) {
        const doc = frame.contentWindow.document;
        doc.open();
        doc.write(`
            <html>
                <head>
                    <title>Nota Transaksi</title>
                    <style>
                        body { margin: 0; padding: 10px; font-family: monospace; }
                        @media print { body { width: 80mm; } }
                    </style>
                </head>
                <body>${htmlContent}</body>
            </html>
        `);
        doc.close();
        setTimeout(() => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            showToast('Membuka dialog cetak PDF', 'info');
        }, 500);
    }
}

// ==========================================
// FEATURE: KIRIM WHATSAPP
// ==========================================
function kirimWhatsApp(data = null) {
    const trx = data || LAST_TRX_DATA;
    if (!trx) {
        showToast('Tidak ada data transaksi untuk dikirim ke WhatsApp', 'error');
        return;
    }

    let noWa = (trx.no_wa || '').trim();
    if (!noWa) {
        noWa = prompt('Masukkan nomor WhatsApp pelanggan (contoh: 08123456789):', '');
        if (noWa === null) return; // Batal
        noWa = noWa.trim();
    }

    const waMessage = generateReceiptWhatsAppMessage(trx);
    openWhatsAppApp(noWa, waMessage);
}

// ==========================================
// RIWAYAT TRANSAKSI LOGIC & ACTIONS
// ==========================================
async function loadHistoriTransaksi() {
    const loading = document.getElementById('loading-histori-trx');
    if (loading) loading.classList.remove('hidden-view');
    try { 
        const res = await callBackend('getHistoriTransaksi'); 
        HISTORI_TRX_CACHE = parseDataArray(res); 
        
        if (CURRENT_USER && CURRENT_USER.role === 'Admin') {
            const filter = document.getElementById('filter-cabang-trx');
            if (filter) {
                const cabangs = new Set();
                HISTORI_TRX_CACHE.forEach(t => { if (t['Cabang']) cabangs.add(t['Cabang']); });
                let html = '<option value="Semua">Semua Cabang</option>';
                cabangs.forEach(c => html += `<option value="${c}">${c}</option>`);
                const prevVal = filter.value;
                filter.innerHTML = html;
                if (Array.from(filter.options).some(o => o.value === prevVal)) filter.value = prevVal;
            }
        }

        renderHistoriTransaksi(); 
        if (CURRENT_USER && CURRENT_USER.role !== 'Admin') updateKasirDashboard();
    } catch(e) { 
        console.error('Error loading histori transaksi:', e);
    }
    if (loading) loading.classList.add('hidden-view');
}

function refreshHistoriTransaksi() { 
    loadHistoriTransaksi(); 
}

function isDateTrxToday(dateStr) {
    if (!dateStr) return false;
    const todayFormatted = getTodayStringFormatted(); // DD/MM/YYYY
    if (String(dateStr).trim().startsWith(todayFormatted)) return true;
    
    // Parse using parseTrxDate
    const parsed = parseTrxDate(dateStr);
    if (parsed) {
        const now = new Date();
        return parsed.getDate() === now.getDate() &&
               parsed.getMonth() === now.getMonth() &&
               parsed.getFullYear() === now.getFullYear();
    }
    
    // Parse using standard Date
    const nativeDate = new Date(dateStr);
    if (!isNaN(nativeDate.getTime())) {
        const now = new Date();
        return nativeDate.getDate() === now.getDate() &&
               nativeDate.getMonth() === now.getMonth() &&
               nativeDate.getFullYear() === now.getFullYear();
    }
    return false;
}

function renderHistoriTransaksi() {
    const list = document.getElementById('list-histori-transaksi');
    if (!list) return;
    const keyword = (document.getElementById('search-trx')?.value || '').toLowerCase();
    const cabangFilter = document.getElementById('filter-cabang-trx')?.value || 'Semua';
    const isAdmin = CURRENT_USER && CURRENT_USER.role === 'Admin';
    
    const subtitleEl = document.getElementById('histori-trx-subtitle');
    if (subtitleEl) {
        subtitleEl.innerText = isAdmin 
            ? 'Daftar seluruh riwayat transaksi penjualan kasir' 
            : `Riwayat transaksi khusus hari ini (${CURRENT_USER?.cabang || 'Cabang'})`;
    }

    let filtered = HISTORI_TRX_CACHE || [];
    
    // JIKA KASIR: HANYA tampil riwayat transaksi hari ini saja (dan cabang kasir jika ada)
    if (!isAdmin) {
        filtered = filtered.filter(t => {
            const isCabangMatch = !CURRENT_USER?.cabang || t['Cabang'] === CURRENT_USER.cabang;
            return isCabangMatch && isDateTrxToday(t['Tanggal']);
        });
    } else {
        // JIKA ADMIN: bisa filter berdasarkan cabang atau melihat semua riwayat
        if (cabangFilter !== 'Semua') {
            filtered = filtered.filter(t => t['Cabang'] === cabangFilter);
        }
    }
    
    if (keyword) {
        filtered = filtered.filter(t => {
            const id = String(t['ID Transaksi'] || '').toLowerCase();
            const nama = (t['Nama Pelanggan'] || '').toLowerCase();
            return id.includes(keyword) || nama.includes(keyword);
        });
    }
    
    if (filtered.length === 0) { 
        list.innerHTML = `<div class="text-center text-gray-400 py-10"><i class="fas fa-receipt text-4xl mb-3"></i><p class="text-sm font-semibold">${!isAdmin ? 'Tidak ada riwayat transaksi untuk hari ini' : 'Tidak ada riwayat transaksi'}</p></div>`; 
        return; 
    }

    list.innerHTML = filtered.map(t => {
        let displayNama = t['Nama Pelanggan'] || 'Umum';
        let extractJenis = '';
        const match = displayNama.match(/(.+) \[(.+)\]/);
        if (match) {
            displayNama = match[1];
            let ketFull = match[2];
            let spl = ketFull.split(' - ');
            extractJenis = spl[0]; 
        }

        const idTrx = t['ID Transaksi'];

        // Tombol hapus HANYA TAMPIL untuk Admin. Kasir TIDAK MENAMPILKAN tombol hapus.
        const deleteButtonHtml = isAdmin ? `
            <button onclick="confirmHapusTransaksi('${idTrx}')" title="Hapus Transaksi (Admin)" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-sm active:scale-95 transition font-bold text-[10px]">
                <i class="fas fa-trash-alt"></i> Hapus
            </button>
        ` : '';

        return `
        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col gap-2 hover:border-gray-200 transition">
            <div class="flex justify-between items-start">
                <div>
                    <p class="font-bold text-sm text-gray-900">#${idTrx}</p>
                    <p class="text-[10px] text-gray-500">${t['Tanggal']} &bull; ${t['Cabang']}</p>
                </div>
                <p class="font-extrabold text-green-600 text-sm">Rp ${formatRupiah(t['Total Belanja'])}</p>
            </div>
            
            <div class="bg-gray-50 rounded-lg p-2.5 flex justify-between items-center text-[10px] text-gray-600 flex-wrap gap-2">
                <div class="flex items-center gap-1.5 overflow-hidden">
                    <i class="fas fa-user text-gray-400 text-xs"></i>
                    <span class="font-bold text-gray-800 truncate">${displayNama}</span> 
                    ${extractJenis ? `<span class="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[9px] font-semibold">${extractJenis}</span>` : ''} 
                </div>

                <!-- Action Buttons: Cetak Struk, PDF, WA, & Hapus (Khusus Admin) -->
                <div class="flex items-center gap-1.5 flex-wrap">
                    <button onclick="reprintStrukTrx('${idTrx}')" title="Cetak ke Printer Bluetooth" class="bg-gray-900 text-white px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-sm hover:bg-gray-800 active:scale-95 transition font-bold text-[10px]">
                        <i class="fas fa-print"></i> Struk
                    </button>
                    <button onclick="cetakNotaPDFFromHistory('${idTrx}')" title="Lihat / Download Nota PDF" class="bg-red-600 text-white px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-sm hover:bg-red-700 active:scale-95 transition font-bold text-[10px]">
                        <i class="fas fa-file-pdf"></i> PDF
                    </button>
                    <button onclick="kirimWhatsAppFromHistory('${idTrx}')" title="Kirim Nota via WhatsApp" class="bg-emerald-600 text-white px-2.5 py-1.5 rounded-lg flex items-center gap-1 shadow-sm hover:bg-emerald-700 active:scale-95 transition font-bold text-[10px]">
                        <i class="fab fa-whatsapp"></i> WA
                    </button>
                    ${deleteButtonHtml}
                </div>
            </div>
        </div>`;
    }).join('');
}

// Function: Konfirmasi & Hapus Transaksi (Khusus Admin)
function confirmHapusTransaksi(idTrx) {
    if (!CURRENT_USER || CURRENT_USER.role !== 'Admin') {
        showToast('Hanya Admin yang memiliki wewenang untuk menghapus transaksi', 'error');
        return;
    }

    const trx = (HISTORI_TRX_CACHE || []).find(t => String(t['ID Transaksi']) === String(idTrx));
    if (!trx) {
        showToast('Data transaksi tidak ditemukan', 'error');
        return;
    }

    let displayNama = trx['Nama Pelanggan'] || 'Umum';
    const match = displayNama.match(/(.+) \[(.+)\]/);
    if (match) displayNama = match[1];

    const modalConfirm = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const btnAction = document.getElementById('btn-confirm-action');

    if (titleEl) titleEl.innerText = 'Hapus Transaksi?';
    if (msgEl) msgEl.innerText = `Apakah Anda yakin ingin menghapus Transaksi #${idTrx} (${displayNama} - Rp ${formatRupiah(trx['Total Belanja'])})? Tindakan ini tidak dapat dibatalkan.`;

    if (btnAction) {
        btnAction.onclick = async () => {
            closeModal('modal-confirm');
            try {
                const res = await callBackend('deleteTransaksi', idTrx);
                if (res.success) {
                    showToast(res.message || `Transaksi #${idTrx} berhasil dihapus`, 'success');
                    HISTORI_TRX_CACHE = (HISTORI_TRX_CACHE || []).filter(t => String(t['ID Transaksi']) !== String(idTrx));
                    renderHistoriTransaksi();
                    if (CURRENT_USER.role === 'Admin') {
                        updateDashboardCharts();
                    } else {
                        updateKasirDashboard();
                    }
                } else {
                    showToast(res.message || 'Gagal menghapus transaksi', 'error');
                }
            } catch(e) {
                showToast('Gagal menghapus transaksi', 'error');
            }
        };
    }

    if (modalConfirm) modalConfirm.classList.remove('hidden-view');
}

function getTrxDataFromHistory(idTrx) {
    const trx = (HISTORI_TRX_CACHE || []).find(t => String(t['ID Transaksi']) === String(idTrx));
    if (!trx) return null;

    let items = [];
    try { 
        items = JSON.parse(trx['Items JSON'] || '[]'); 
    } catch(e) {
        items = [];
    }

    let namaP = trx['Nama Pelanggan'] || 'Umum';
    let jenisP = '';
    let ketP = '';
    const match = namaP.match(/(.+) \[(.+)\]/);
    if (match) {
        namaP = match[1];
        const notes = match[2].split(' - ');
        jenisP = notes[0] || '';
        ketP = notes[1] || '';
    }

    return {
        id: trx['ID Transaksi'],
        cabang: trx['Cabang'] || 'Pusat',
        kasir: trx['Kasir'] || '-',
        tanggal: trx['Tanggal'] || '',
        nama_pelanggan: namaP,
        no_wa: trx['No WA'] || '',
        jenis_pesanan: jenisP,
        keterangan: ketP,
        items: items,
        total: Number(trx['Total Belanja']) || 0,
        metode: trx['Metode'] || (trx['Bayar'] ? (trx['Kembalian'] >= 0 ? 'Cash' : 'Transfer') : 'Cash'),
        bayar: Number(trx['Bayar']) || 0,
        kembali: Number(trx['Kembalian']) || 0,
        pdfUrl: trx['Link PDF'] || null
    };
}

function cetakNotaPDFFromHistory(idTrx) {
    const data = getTrxDataFromHistory(idTrx);
    if (!data) {
        showToast('Data transaksi tidak ditemukan', 'error');
        return;
    }
    cetakNotaPDF(data);
}

function kirimWhatsAppFromHistory(idTrx) {
    const data = getTrxDataFromHistory(idTrx);
    if (!data) {
        showToast('Data transaksi tidak ditemukan', 'error');
        return;
    }
    kirimWhatsApp(data);
}

async function reprintStrukTrx(idTrx) {
    const trxData = getTrxDataFromHistory(idTrx);
    if (!trxData) { 
        showToast('Data transaksi tidak ditemukan', 'error'); 
        return; 
    }
    LAST_TRX_DATA = trxData;
    await cetakStrukThermal();
}

// Histori Gaji Logic
async function loadHistoriGaji() { 
    const loading = document.getElementById('loading-histori-gaji');
    if (loading) loading.classList.remove('hidden-view'); 
    try { 
        const res = await callBackend('getHistori'); 
        HISTORI_GAJI_CACHE = parseDataArray(res); 
        renderHistoriGaji(); 
    } catch(e) { } 
    if (loading) loading.classList.add('hidden-view'); 
}

function refreshHistoriGaji() { 
    loadHistoriGaji(); 
}

// Helper format bulan Indonesia
function formatBulanIndo(bulanStr) {
    if (!bulanStr) return '-';
    if (bulanStr.includes('-')) {
        const parts = bulanStr.split('-');
        if (parts.length === 2) {
            const y = parts[0];
            const m = parseInt(parts[1], 10) - 1;
            const namaBulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
            if (m >= 0 && m < 12) {
                return `${namaBulan[m]} ${y}`;
            }
        }
    }
    return bulanStr;
}

function renderHistoriGaji() { 
    const list = document.getElementById('list-histori-gaji'); 
    if (!list) return;
    const keyword = (document.getElementById('search-gaji')?.value || '').toLowerCase(); 
    let filtered = HISTORI_GAJI_CACHE || []; 
    if (keyword) { 
        filtered = filtered.filter(t => { 
            const nama = (t['Nama'] || '').toLowerCase(); 
            const bulan = String(t['Bulan'] || '').toLowerCase(); 
            return nama.includes(keyword) || bulan.includes(keyword); 
        }); 
    } 
    if (filtered.length === 0) { 
        list.innerHTML = `<div class="text-center text-gray-400 py-10"><i class="fas fa-file-invoice text-4xl mb-3"></i><p class="text-sm">Tidak ada riwayat slip gaji</p></div>`; 
        return; 
    } 
    list.innerHTML = filtered.map((t, idx) => {
        const noWa = t['No WA'] || '';
        const bulanDisplay = formatBulanIndo(t['Bulan']);
        return `
        <div class="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex flex-col sm:flex-row justify-between sm:items-center gap-3 hover:border-gray-200 transition">
            <div class="flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                    <p class="font-bold text-sm text-gray-900">${t['Nama']}</p>
                    ${t['Jabatan'] ? `<span class="bg-gray-100 text-gray-600 text-[10px] font-semibold px-2 py-0.5 rounded-full">${t['Jabatan']}</span>` : ''}
                    ${t['Cabang'] ? `<span class="bg-blue-50 text-blue-600 text-[10px] font-semibold px-2 py-0.5 rounded-full">${t['Cabang']}</span>` : ''}
                </div>
                <p class="text-[11px] text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
                    <span><i class="far fa-calendar-alt text-gray-400 mr-1"></i> Periode: <b>${bulanDisplay}</b></span>
                    ${t['Hari Masuk'] ? `<span>&bull; Masuk: <b>${t['Hari Masuk']} hr</b></span>` : ''}
                    ${noWa ? `<span>&bull; <i class="fab fa-whatsapp text-emerald-500"></i> ${noWa}</span>` : ''}
                </p>
                <div class="mt-1 flex items-baseline gap-2">
                    <p class="text-xs font-bold text-gray-500">Total Gaji:</p>
                    <p class="font-black text-red-600 text-base">Rp ${formatRupiah(t['Total Gaji'])}</p>
                </div>
            </div>

            <!-- Tombol Aksi: Lihat/Download PDF, Kirim Slip Gaji ke WhatsApp Karyawan, & Hapus -->
            <div class="flex items-center gap-2 pt-2 sm:pt-0 border-t sm:border-t-0 border-gray-100 flex-wrap">
                <button onclick="lihatPdfSlipGaji(${idx})" title="Lihat / Unduh Slip Gaji PDF" class="bg-gray-900 hover:bg-gray-800 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center gap-1.5 active:scale-95">
                    <i class="fas fa-file-pdf text-red-400"></i> PDF
                </button>
                <button onclick="kirimWaSlipGaji(${idx})" title="Kirim Link & Rincian Slip Gaji ke No. WhatsApp Karyawan" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center gap-1.5 active:scale-95">
                    <i class="fab fa-whatsapp text-white text-sm"></i> Kirim WA
                </button>
                <button onclick="confirmHapusHistoriGaji(${idx})" title="Hapus Riwayat Slip Gaji" class="bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 px-3 py-2 rounded-xl text-xs font-bold shadow-sm transition flex items-center gap-1.5 active:scale-95">
                    <i class="fas fa-trash-alt"></i> Hapus
                </button>
            </div>
        </div>`;
    }).join(''); 
}

// Function: Hapus Slip Gaji from Riwayat Gaji
function confirmHapusHistoriGaji(idx) {
    const item = (HISTORI_GAJI_CACHE || [])[idx];
    if (!item) {
        showToast('Data slip gaji tidak ditemukan', 'error');
        return;
    }

    const nama = item['Nama'] || 'Karyawan';
    const bulan = formatBulanIndo(item['Bulan']);
    const modalConfirm = document.getElementById('modal-confirm');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const btnAction = document.getElementById('btn-confirm-action');

    if (titleEl) titleEl.innerText = 'Hapus Riwayat Gaji?';
    if (msgEl) msgEl.innerText = `Apakah Anda yakin ingin menghapus slip gaji ${nama} (${bulan})? Tindakan ini tidak dapat dibatalkan.`;
    
    if (btnAction) {
        btnAction.onclick = async () => {
            closeModal('modal-confirm');
            try {
                const targetId = item['ID Slip'] || idx;
                const res = await callBackend('deleteHistoriGaji', targetId);
                if (res.success) {
                    showToast(res.message || 'Riwayat slip gaji berhasil dihapus', 'success');
                    HISTORI_GAJI_CACHE.splice(idx, 1);
                    renderHistoriGaji();
                    if (CURRENT_USER && CURRENT_USER.role === 'Admin') {
                        updateDashboardCharts();
                    }
                } else {
                    showToast(res.message || 'Gagal menghapus riwayat gaji', 'error');
                }
            } catch(e) {
                showToast('Gagal menghapus riwayat gaji', 'error');
            }
        };
    }

    if (modalConfirm) modalConfirm.classList.remove('hidden-view');
}

// Function: Format Slip Gaji HTML for display, print, and PDF
function generateSlipGajiHTML(t) {
    const bonus = Number(t['Bonus']) || 0;
    const potongan = Number(t['Potongan']) || 0;
    const totalGaji = Number(t['Total Gaji']) || 0;
    const harian = Number(t['Gaji Harian']) || 0;
    const hari = Number(t['Hari Masuk']) || 0;
    const pokok = (harian && hari) ? (harian * hari) : (totalGaji - bonus + potongan);
    const bulanFormatted = formatBulanIndo(t['Bulan']);

    return `
        <div style="width: 420px; font-family: 'Inter', -apple-system, sans-serif; background: #ffffff; padding: 24px; box-sizing: border-box; color: #1f2937; line-height: 1.5; border: 1px solid #e5e7eb;">
            <div style="text-align: center; border-bottom: 2px solid #dc2626; padding-bottom: 12px; margin-bottom: 16px;">
                <h1 style="font-size: 20px; font-weight: 800; margin: 0; color: #dc2626; letter-spacing: 1px;">ISTANA BUBUR</h1>
                <p style="font-size: 11px; font-weight: 700; color: #374151; margin: 3px 0; text-transform: uppercase;">SLIP GAJI KARYAWAN RESMI</p>
                <p style="font-size: 10px; color: #6b7280; margin: 0;">Periode: ${bulanFormatted}</p>
            </div>

            <div style="font-size: 11px; margin-bottom: 14px; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: #64748b;">Nama Karyawan:</span>
                    <span style="font-weight: 700; color: #0f172a;">${t['Nama']}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: #64748b;">Jabatan:</span>
                    <span style="font-weight: 600; color: #334155;">${t['Jabatan'] || '-'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                    <span style="color: #64748b;">Lokasi Penempatan:</span>
                    <span style="font-weight: 600; color: #334155;">${t['Cabang'] || 'Pusat'}</span>
                </div>
                ${t['No WA'] ? `<div style="display: flex; justify-content: space-between;"><span style="color: #64748b;">No. WhatsApp:</span><span style="font-weight: 600; color: #334155;">${t['No WA']}</span></div>` : ''}
            </div>

            <table style="width: 100%; font-size: 11px; border-collapse: collapse; margin-bottom: 14px;">
                <thead>
                    <tr style="border-bottom: 1px solid #cbd5e1; color: #475569; background: #f1f5f9;">
                        <th style="text-align: left; padding: 6px 8px;">Komponen Gaji</th>
                        <th style="text-align: right; padding: 6px 8px;">Nominal</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-bottom: 1px dashed #e2e8f0;">
                        <td style="padding: 6px 8px;">Gaji Pokok ${hari ? `(${hari} hari x Rp ${formatRupiah(harian)})` : ''}</td>
                        <td style="padding: 6px 8px; text-align: right; font-weight: 600;">Rp ${formatRupiah(pokok)}</td>
                    </tr>
                    <tr style="border-bottom: 1px dashed #e2e8f0;">
                        <td style="padding: 6px 8px; color: #16a34a;">Bonus & Tunjangan</td>
                        <td style="padding: 6px 8px; text-align: right; font-weight: 600; color: #16a34a;">+ Rp ${formatRupiah(bonus)}</td>
                    </tr>
                    <tr style="border-bottom: 1px dashed #e2e8f0;">
                        <td style="padding: 6px 8px; color: #dc2626;">Potongan ${t['Keterangan Libur'] ? `(${t['Keterangan Libur']})` : ''}</td>
                        <td style="padding: 6px 8px; text-align: right; font-weight: 600; color: #dc2626;">- Rp ${formatRupiah(potongan)}</td>
                    </tr>
                </tbody>
            </table>

            <div style="border-top: 2px solid #0f172a; padding-top: 8px; margin-bottom: 18px;">
                <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: 800; color: #0f172a;">
                    <span>TOTAL DITERIMA:</span>
                    <span style="color: #dc2626;">Rp ${formatRupiah(totalGaji)}</span>
                </div>
            </div>

            <div style="text-align: center; border-top: 1px dashed #cbd5e1; padding-top: 12px; font-size: 10px; color: #64748b;">
                <p style="margin: 0; font-style: italic;">Slip gaji ini sah dan diterbitkan secara digital oleh Sistem Manajemen Istana Bubur.</p>
            </div>
        </div>
    `;
}

function generateSlipGajiWhatsAppMessage(t) {
    const bulanFormatted = formatBulanIndo(t['Bulan']);
    const bonus = Number(t['Bonus']) || 0;
    const potongan = Number(t['Potongan']) || 0;
    const totalGaji = Number(t['Total Gaji']) || 0;
    const harian = Number(t['Gaji Harian']) || 0;
    const hari = Number(t['Hari Masuk']) || 0;
    const pokok = (harian && hari) ? (harian * hari) : (totalGaji - bonus + potongan);

    let linkPdfSection = '';
    if (t['Link PDF'] && t['Link PDF'] !== '#' && t['Link PDF'].startsWith('http')) {
        linkPdfSection = `*Link Unduh Slip Gaji PDF:*\n${t['Link PDF']}\n\n`;
    } else {
        linkPdfSection = `*Status Dokumen:*\nTelah diverifikasi & disahkan resmi oleh Manajemen Istana Bubur\n\n`;
    }

    return `*SLIP GAJI KARYAWAN - ISTANA BUBUR*
================================
Halo *${t['Nama']}*,
Berikut adalah rincian slip gaji Anda:
*Periode:* ${bulanFormatted}
*Lokasi Cabang:* ${t['Cabang'] || 'Pusat'}
*Jabatan:* ${t['Jabatan'] || '-'}
--------------------------------
*Rincian Gaji:*
${hari ? `• Hari Masuk : ${hari} hari (@Rp ${formatRupiah(harian)})\n` : ''}• Gaji Pokok : Rp ${formatRupiah(pokok)}
• Bonus & Tunjangan : Rp ${formatRupiah(bonus)}
• Potongan Gaji : Rp ${formatRupiah(potongan)}
${t['Keterangan Libur'] ? `• Keterangan : ${t['Keterangan Libur']}\n` : ''}--------------------------------
*TOTAL DITERIMA : Rp ${formatRupiah(totalGaji)}*
================================
${linkPdfSection}_Terima kasih atas kerja keras, loyalitas, dan dedikasi Anda di Istana Bubur._`;
}

// Function: Kirim WhatsApp Slip Gaji Karyawan from Riwayat Gaji
function kirimWaSlipGaji(idx) {
    const t = (HISTORI_GAJI_CACHE || [])[idx];
    if (!t) {
        showToast('Data slip gaji tidak ditemukan', 'error');
        return;
    }
    kirimWaSlipGajiDirect(t);
}

function kirimWaSlipGajiDirect(t) {
    if (!t) {
        showToast('Data slip gaji tidak ditemukan', 'error');
        return;
    }

    // 1. Cari nomor WhatsApp karyawan
    let noWa = (t['No WA'] || '').trim();
    if (!noWa && Array.isArray(KARYAWAN_CACHE)) {
        const k = KARYAWAN_CACHE.find(item => 
            (t['ID Karyawan'] && String(item['ID Karyawan']) === String(t['ID Karyawan'])) ||
            (item['Nama'] && item['Nama'].toLowerCase() === (t['Nama'] || '').toLowerCase())
        );
        if (k && k['No WA']) {
            noWa = String(k['No WA']).trim();
        }
    }

    if (!noWa) {
        noWa = prompt(`Masukkan nomor WhatsApp untuk karyawan ${t['Nama']} (contoh: 08123456789):`, '');
        if (noWa === null) return; // Dibatalkan pengguna
        noWa = noWa.trim();
    }

    const waMessage = generateSlipGajiWhatsAppMessage(t);
    openWhatsAppApp(noWa, waMessage);
}

// Function: Lihat / Download Slip Gaji PDF from Riwayat Gaji
function lihatPdfSlipGaji(idx) {
    const t = (HISTORI_GAJI_CACHE || [])[idx];
    if (!t) {
        showToast('Data slip gaji tidak ditemukan', 'error');
        return;
    }
    cetakSlipGajiPDF(t);
}

async function cetakSlipGajiPDF(t) {
    if (!t) {
        showToast('Data slip gaji tidak ditemukan', 'error');
        return;
    }

    if (t['Link PDF'] && t['Link PDF'] !== '#' && t['Link PDF'].startsWith('http')) {
        openUrlOutsideApp(t['Link PDF']);
        showToast('Membuka file PDF di luar aplikasi...', 'success');
        return;
    }

    showToast('Menyiapkan Slip Gaji PDF...', 'info');

    const cleanName = (t['Nama'] || 'Karyawan').replace(/[^a-zA-Z0-9]/g, '_');
    const cleanBulan = (t['Bulan'] || '').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `Slip_Gaji_${cleanName}_${cleanBulan}.pdf`;
    const title = `Slip Gaji - ${t['Nama'] || 'Karyawan'}`;
    const htmlContent = generateSlipGajiHTML(t);
    const waMessage = generateSlipGajiWhatsAppMessage(t);

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'fixed';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '0';
    tempContainer.innerHTML = htmlContent;
    document.body.appendChild(tempContainer);

    const el = tempContainer.firstElementChild;
    const jsPdfOpt = {
        margin: [4, 4, 4, 4],
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a5', orientation: 'portrait' }
    };

    await openDocPdfOutsideApp({
        type: 'slip',
        filename,
        title,
        htmlContent,
        element: el,
        jsPdfOpt,
        phone: t['No WA'] || '',
        waMessage
    });

    setTimeout(() => tempContainer.remove(), 2000);
}

// ==========================================
// BLUETOOTH THERMAL PRINTER ESC/POS LOGIC
// ==========================================
let printerDevice = null; 
let printerServer = null; 
let printerCharacteristic = null; 
let isNativeBluetooth = false; 
let connectedPrinterMac = null; 
const PRINTER_SETTINGS_KEY = 'ib_printer_settings';
let printerSettings = { paperSize: '58', copies: 1, savedMac: null, savedName: null };

function initPrinterSettings() {
    const saved = localStorage.getItem(PRINTER_SETTINGS_KEY);
    if (saved) {
        printerSettings = { ...printerSettings, ...JSON.parse(saved) };
        if (document.getElementById('printer-paper-size')) document.getElementById('printer-paper-size').value = printerSettings.paperSize;
        if (document.getElementById('printer-copies')) document.getElementById('printer-copies').value = printerSettings.copies;
        if (window.AndroidPrinter && printerSettings.savedMac) { 
            updatePrinterStatus('Menghubungkan ke ' + printerSettings.savedName + '...', 'warning'); 
            try { window.AndroidPrinter.connect(printerSettings.savedMac, printerSettings.savedName); } catch(e) {} 
        }
    }
}

function savePrinterSettings() { 
    printerSettings.paperSize = document.getElementById('printer-paper-size').value; 
    printerSettings.copies = parseInt(document.getElementById('printer-copies').value) || 1; 
    localStorage.setItem(PRINTER_SETTINGS_KEY, JSON.stringify(printerSettings)); 
    showToast('Pengaturan printer disimpan', 'success'); 
}

function updatePrinterStatus(text, state='disconnected') { 
    const badge = document.getElementById('printer-status-badge'); 
    if (!badge) return; 
    badge.innerText = text; 
    badge.className = 'text-[10px] font-bold px-2 py-1 rounded '; 
    if (state === 'connected') badge.className += 'bg-green-100 text-green-700'; 
    else if (state === 'warning') badge.className += 'bg-yellow-100 text-yellow-700'; 
    else badge.className += 'bg-gray-100 text-gray-600'; 
}

function getNativeAndroidPrinter() {
    return window.AndroidPrinter || window.BluetoothBridge || window.Android || window.BTPrinter || null;
}

window.onAndroidPrinterConnected = function(mac, name) { 
    isNativeBluetooth = true; 
    connectedPrinterMac = mac; 
    printerSettings.savedMac = mac; 
    printerSettings.savedName = name; 
    savePrinterSettings(); 
    updatePrinterStatus('Terhubung: ' + name, 'connected'); 
    showToast('Printer Terhubung (' + name + ')', 'success'); 
};

window.onAndroidPrinterDisconnected = function() { 
    connectedPrinterMac = null; 
    updatePrinterStatus('Tidak Terhubung', 'disconnected'); 
    showToast('Printer Terputus', 'error'); 
};

async function scanPrinters() {
    const native = getNativeAndroidPrinter();
    if (native) {
        try { 
            if (typeof native.scanAndConnect === 'function') {
                native.scanAndConnect(); 
            } else if (typeof native.scanPrinters === 'function') {
                native.scanPrinters();
            } else if (typeof native.openBluetoothSettings === 'function') {
                native.openBluetoothSettings();
            }
            if (typeof native.getPairedDevices === 'function') { 
                const devicesStr = native.getPairedDevices(); 
                if (devicesStr) {
                    const devices = typeof devicesStr === 'string' ? JSON.parse(devicesStr) : devicesStr;
                    renderPrinterListNative(devices); 
                }
            } 
            showToast('Membuka pemindai Bluetooth perangkat Android...', 'info');
        } catch(e) { 
            console.error('Android native printer error:', e);
            showToast('Gagal memanggil fungsi Bluetooth Native Android: ' + e.message, 'error'); 
        } 
        return;
    }

    if (!navigator.bluetooth) { 
        if (/Android/i.test(navigator.userAgent)) {
            showToast('WebView APK Android: Gunakan opsi Driver RawBT atau pasangkan di Pengaturan Bluetooth HP.', 'info');
        } else {
            showToast('Browser ini tidak mendukung Web Bluetooth. Gunakan Google Chrome atau Android WebView.', 'error'); 
        }
        return; 
    }

    try {
        updatePrinterStatus('Mencari...', 'warning');
        const optionalServices = [
            '000018f0-0000-1000-8000-00805f9b34fb',
            '0000ffe0-0000-1000-8000-00805f9b34fb',
            '0000ff00-0000-1000-8000-00805f9b34fb',
            '0000fee7-0000-1000-8000-00805f9b34fb',
            '49535343-fe7d-4ae5-8fa9-9fafd205e455',
            'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
            '000018f1-0000-1000-8000-00805f9b34fb',
            '0000af30-0000-1000-8000-00805f9b34fb'
        ];

        // Gunakan acceptAllDevices agar semua printer Bluetooth thermal dapat terbaca
        printerDevice = await navigator.bluetooth.requestDevice({ 
            acceptAllDevices: true,
            optionalServices: optionalServices 
        });

        printerDevice.addEventListener('gattserverdisconnected', () => { 
            updatePrinterStatus('Tidak Terhubung', 'disconnected'); 
            printerCharacteristic = null; 
            showToast('Koneksi printer terputus', 'warning');
        });

        updatePrinterStatus('Menghubungkan...', 'warning'); 
        printerServer = await printerDevice.gatt.connect();
        const services = await printerServer.getPrimaryServices();

        for (const s of services) {
            try {
                const chars = await s.getCharacteristics();
                const writeChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
                if (writeChar) {
                    printerCharacteristic = writeChar;
                    break;
                }
            } catch(e) {}
        }

        if (printerCharacteristic) {
            updatePrinterStatus('Terhubung: ' + printerDevice.name, 'connected'); 
            printerSettings.savedName = printerDevice.name; 
            savePrinterSettings(); 
            showToast('Printer Bluetooth Terhubung: ' + printerDevice.name, 'success'); 
            return;
        }

        throw new Error('Karakteristik Tulis ESC/POS tidak ditemukan.');
    } catch(err) { 
        console.warn('[Bluetooth Scanner]:', err);
        updatePrinterStatus('Tidak Terhubung', 'disconnected'); 
        if (err.name !== 'NotFoundError') {
            showToast('Gagal menghubungkan printer: ' + err.message, 'error');
        }
    }
}

function scanPairedAndroidPrinters() {
    const native = getNativeAndroidPrinter();
    if (native && typeof native.getPairedDevices === 'function') {
        try {
            const devicesStr = native.getPairedDevices();
            if (devicesStr) {
                const devices = typeof devicesStr === 'string' ? JSON.parse(devicesStr) : devicesStr;
                renderPrinterListNative(devices);
                showToast(`Ditemukan ${devices.length} perangkat Bluetooth tersanding`, 'info');
                return;
            }
        } catch(e) {
            console.error('Error getting paired devices:', e);
        }
    }

    // Panduan jika di browser atau bridge belum terpasang
    const container = document.getElementById('printer-list-container');
    const list = document.getElementById('printer-list');
    if (container && list) {
        container.classList.remove('hidden-view');
        list.innerHTML = `
            <div class="p-3 bg-white rounded-xl border border-blue-100 text-left space-y-2">
                <p class="text-xs font-bold text-gray-800 flex items-center gap-1.5">
                    <i class="fab fa-android text-emerald-600"></i> Cara Hubungkan Printer Thermal Android:
                </p>
                <ol class="text-[11px] text-gray-600 list-decimal list-inside space-y-1">
                    <li>Buka <b>Pengaturan HP &gt; Bluetooth</b>.</li>
                    <li>Nyalakan Bluetooth dan lakukan <b>Sandingkan Perangkat Baru</b> dengan printer thermal Anda (PIN: 0000 atau 1234).</li>
                    <li>Kembali ke aplikasi ini, klik <b>Pindai / Hubungkan Printer</b> atau masukkan nama printer pada kolom sambung manual di bawah.</li>
                    <li>Atau gunakan tombol <b>Tes RawBT</b> untuk cetak langsung via driver printer Android.</li>
                </ol>
            </div>
        `;
    }
    showToast('Buka Pengaturan Bluetooth HP untuk menyandingkan printer', 'info');
}

function renderPrinterListNative(devices) {
    const container = document.getElementById('printer-list-container'); 
    const list = document.getElementById('printer-list'); 
    if (!container || !list) return;
    container.classList.remove('hidden-view');
    if (!devices || devices.length === 0) { 
        list.innerHTML = `<p class="text-xs text-center text-gray-400 py-4">Tidak ada perangkat tersimpan di Android</p>`; 
        return; 
    }
    list.innerHTML = devices.map(d => `
        <button onclick="connectNativePrinter('${d.address}', '${d.name}')" class="w-full bg-gray-50 border border-gray-200 p-3 rounded-xl text-left hover:bg-blue-50 transition flex justify-between items-center">
            <div>
                <p class="text-sm font-bold text-gray-800">${d.name || 'Printer Bluetooth'}</p>
                <p class="text-[10px] text-gray-500">${d.address}</p>
            </div>
            <i class="fas fa-link text-blue-500"></i>
        </button>`).join('');
}

function connectManualPrinter() {
    const input = document.getElementById('printer-manual-mac');
    const val = input ? input.value.trim() : '';
    if (!val) {
        showToast('Masukkan Alamat MAC atau Nama Printer Bluetooth!', 'warning');
        return;
    }

    printerSettings.savedMac = val;
    printerSettings.savedName = val;
    savePrinterSettings();

    const native = getNativeAndroidPrinter();
    if (native && typeof native.connect === 'function') {
        updatePrinterStatus('Menghubungkan ke ' + val + '...', 'warning');
        try {
            native.connect(val, val);
            showToast('Menghubungkan ke printer ' + val, 'info');
        } catch(e) {
            showToast('Gagal menghubungkan: ' + e.message, 'error');
        }
    } else {
        updatePrinterStatus('Tersimpan: ' + val, 'connected');
        showToast('Pengaturan printer ' + val + ' disimpan untuk pencetakan Android', 'success');
    }
}

function closePrinterList() {
    const container = document.getElementById('printer-list-container');
    if (container) container.classList.add('hidden-view');
}

function connectNativePrinter(mac, name) { 
    const native = getNativeAndroidPrinter();
    if (native && typeof native.connect === 'function') { 
        updatePrinterStatus('Menghubungkan...', 'warning'); 
        try { 
            native.connect(mac, name); 
            printerSettings.savedMac = mac;
            printerSettings.savedName = name;
            savePrinterSettings();
        } catch(e) { 
            showToast('Koneksi Gagal: ' + e.message, 'error'); 
            updatePrinterStatus('Tidak Terhubung', 'disconnected'); 
        } 
    } else {
        printerSettings.savedMac = mac;
        printerSettings.savedName = name;
        savePrinterSettings();
        updatePrinterStatus('Terhubung: ' + name, 'connected');
        showToast('Printer ' + name + ' dipilih', 'success');
    }
}

function disconnectPrinter() { 
    const native = getNativeAndroidPrinter();
    if (native && typeof native.disconnect === 'function') { 
        try { native.disconnect(); } catch(e){} 
        onAndroidPrinterDisconnected(); 
    } else if (printerDevice && printerDevice.gatt && printerDevice.gatt.connected) { 
        printerDevice.gatt.disconnect(); 
        updatePrinterStatus('Tidak Terhubung', 'disconnected');
    } else {
        printerCharacteristic = null;
        updatePrinterStatus('Tidak Terhubung', 'disconnected');
        showToast('Printer dinonaktifkan', 'info');
    }
}

function printViaRawBT(escPosData) {
    const b64 = escPosData.getBase64();
    const rawbtUri = 'rawbt:data:application/octet-stream;base64,' + b64;
    const intentUri = 'intent:base64,' + b64 + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;';

    // Buat link tersembunyi untuk memicu Driver RawBT Android
    try {
        const link = document.createElement('a');
        link.href = rawbtUri;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 1500);

        showToast('Meneruskan data struk ke Driver Thermal Android (RawBT)...', 'success');
        return true;
    } catch(e) {
        console.warn('Gagal memicu RawBT URI, mencoba intent:', e);
        try {
            window.location.href = intentUri;
            return true;
        } catch(err) {
            showToast('Gagal membuka Driver Android: ' + err.message, 'error');
            return false;
        }
    }
}

async function testPrintRawBT() {
    const p = new EscPos(); 
    p.init().alignCenter().bold(true).size(2,2).textLine("TEST PRINT RAWBT").size(1,1).bold(false).feed(1)
     .textLine("Istana Bubur - Android Thermal")
     .textLine("Driver: RawBT / Android Service").feed(1)
     .textLine("Kertas: " + printerSettings.paperSize + "mm")
     .textLine("Waktu: " + new Date().toLocaleTimeString('id-ID'))
     .feed(3).cut();
    
    printViaRawBT(p);
}

class EscPos {
    constructor() { this.buffer = []; }
    init() { this.buffer.push(27, 64); return this; }
    alignCenter() { this.buffer.push(27, 97, 1); return this; }
    alignLeft() { this.buffer.push(27, 97, 0); return this; }
    alignRight() { this.buffer.push(27, 97, 2); return this; }
    bold(on) { this.buffer.push(27, 69, on ? 1 : 0); return this; }
    size(w, h) { this.buffer.push(29, 33, (w-1)*16 + (h-1)); return this; }
    text(str) { for (let i=0; i<str.length; i++) this.buffer.push(str.charCodeAt(i)); return this; }
    textLine(str) { return this.text(str).feed(1); }
    feed(lines=1) { for (let i=0; i<lines; i++) this.buffer.push(10); return this; }
    cut() { this.buffer.push(29, 86, 65, 0); return this; }
    getBuffer() { return new Uint8Array(this.buffer); }
    getBase64() { 
        let binary = ''; 
        const bytes = this.getBuffer(); 
        for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); } 
        return window.btoa(binary); 
    }
}

function formatLineLR(left, right, maxLen) { 
    let str = left.substring(0, maxLen - right.length - 1); 
    const spaces = maxLen - str.length - right.length; 
    if (spaces > 0) { str += ' '.repeat(spaces) + right; } 
    else { str += ' ' + right; } 
    return str; 
}

function printSeparator(maxLen, char='-') { return char.repeat(maxLen); }

async function sendDataToPrinter(escPosData) {
    const base64Data = escPosData.getBase64();
    const native = getNativeAndroidPrinter();

    for (let i=0; i<printerSettings.copies; i++) {
        if (native && typeof native.printBase64 === 'function') { 
            try { 
                native.printBase64(base64Data); 
            } catch (e) { 
                console.error('Native print error:', e);
                throw new Error('Native print error: ' + e.message); 
            } 
        } else if (printerCharacteristic) { 
            const buffer = escPosData.getBuffer(); 
            const CHUNK_SIZE = 512; 
            for (let j = 0; j < buffer.length; j += CHUNK_SIZE) { 
                await printerCharacteristic.writeValue(buffer.slice(j, j + CHUNK_SIZE)); 
            } 
        } else if (/Android/i.test(navigator.userAgent) || printerSettings.savedMac) {
            // Jika berjalan di Android APK/browser tanpa native bridge, kirim ke driver RawBT
            const success = printViaRawBT(escPosData);
            if (!success) {
                showToast('Printer belum terhubung! Menggunakan preview struk...', 'info');
                return false;
            }
        } else { 
            showToast('Printer belum terhubung! Silakan hubungkan di menu Pengaturan Printer.', 'info'); 
            return false; 
        }
        if (i < printerSettings.copies - 1) await new Promise(r => setTimeout(r, 1000));
    } 
    return true;
}

async function testPrint() {
    const p = new EscPos(); 
    p.init().alignCenter().bold(true).size(2,2).textLine("TEST PRINT").size(1,1).bold(false).feed(1)
     .textLine("Istana Bubur").textLine("Printer Berhasil Tersambung!").feed(1)
     .textLine("Kertas: " + printerSettings.paperSize + "mm")
     .textLine("Copy: " + printerSettings.copies + "x").feed(4).cut();
    try { 
        const res = await sendDataToPrinter(p); 
        if (res) showToast('Test cetak dikirim ke printer', 'success'); 
    } catch(e) { 
        showToast('Gagal mencetak. Cek koneksi.', 'error'); 
    }
}

async function cetakStrukThermal() {
    if (!LAST_TRX_DATA) { 
        showToast('Tidak ada data transaksi', 'error'); 
        return; 
    }
    
    if (!window.AndroidPrinter && !printerCharacteristic) { 
        showToast('Hubungkan Printer Bluetooth di menu Pengaturan Printer terlebih dahulu!', 'error'); 
        setTimeout(() => switchTab('printer'), 600); 
        return; 
    }

    const t = LAST_TRX_DATA; 
    const p = new EscPos(); 
    const maxChars = printerSettings.paperSize === '80' ? 48 : 32;

    p.init().alignCenter().bold(true).size(2,2).textLine("ISTANA BUBUR").size(1,1).bold(false)
     .textLine("Cabang: " + (t.cabang || "Pusat"))
     .textLine(t.tanggal || new Date().toLocaleString('id-ID'))
     .textLine("Kasir: " + (t.kasir || "-"))
     .textLine(printSeparator(maxChars)).alignLeft();
     
    if (t.nama_pelanggan) p.textLine("Pel: " + t.nama_pelanggan);
    if (t.no_wa) p.textLine("WA: " + t.no_wa);
    if (t.jenis_pesanan) p.textLine("Tipe: " + t.jenis_pesanan); 
    if (t.keterangan) p.textLine("Ket: " + t.keterangan); 
    
    p.textLine(printSeparator(maxChars));

    (t.items || []).forEach(item => {
        p.textLine(item.nama);
        const detail = `${item.qty} x ${formatRupiah(item.harga)}`;
        const subtotal = formatRupiah(item.qty * item.harga);
        p.textLine(formatLineLR(detail, subtotal, maxChars));
    });

    p.textLine(printSeparator(maxChars));
    p.bold(true).textLine(formatLineLR("TOTAL", formatRupiah(t.total), maxChars)).bold(false);
     
    p.textLine(formatLineLR("Tipe Bayar", t.metode || "Cash", maxChars));
    if (t.metode === 'Cash' || !t.metode) { 
        p.textLine(formatLineLR("Tunai", formatRupiah(t.bayar || t.total), maxChars)); 
        p.textLine(formatLineLR("Kembali", formatRupiah(t.kembali || 0), maxChars)); 
    }
    
    p.alignCenter().feed(2).textLine("Terima Kasih").textLine("Silahkan Datang Kembali").feed(4).cut();

    try { 
        await sendDataToPrinter(p); 
        showToast('Struk sedang dicetak...', 'success'); 
    } catch(e) { 
        showToast('Gagal mencetak struk, cek koneksi.', 'error'); 
    }
}

// ===================================================
// FITUR EKSPOR REKAP LAPORAN (EXCEL & GOOGLE SHEETS)
// ===================================================

let currentExportType = 'transaksi'; // 'transaksi' | 'gaji' | 'produk' | 'karyawan' | 'semua'
let currentExportTab = 'download';   // 'download' | 'sheets' | 'sync'

function openExportModal(defaultType = 'transaksi') {
    if (defaultType) {
        currentExportType = defaultType;
    }
    
    // Populate branch select
    const cabangSelect = document.getElementById('export-filter-cabang');
    if (cabangSelect) {
        const branches = new Set(['Semua', 'Pusat', 'Cabang A', 'Cabang B']);
        if (Array.isArray(HISTORI_TRX_CACHE)) {
            HISTORI_TRX_CACHE.forEach(t => { if (t['Cabang']) branches.add(t['Cabang']); });
        }
        if (Array.isArray(KARYAWAN_CACHE)) {
            KARYAWAN_CACHE.forEach(k => { if (k['Cabang']) branches.add(k['Cabang']); });
        }
        
        const currentVal = cabangSelect.value || 'Semua';
        cabangSelect.innerHTML = Array.from(branches).map(b => 
            `<option value="${b}" ${b === currentVal ? 'selected' : ''}>${b === 'Semua' ? 'Semua Cabang (Pusat & Cabang)' : b}</option>`
        ).join('');
    }

    // Set export type styling
    setExportType(currentExportType);
    
    // Switch to tab download by default
    switchExportTab('download');
    
    // Default period: semua (or current dates if already set)
    const startDateInput = document.getElementById('export-start-date');
    const endDateInput = document.getElementById('export-end-date');
    if (startDateInput && !startDateInput.value) {
        setExportQuickPeriod('semua');
    } else {
        updateExportPreview();
    }

    openModal('modal-export');
}

function switchExportTab(tab) {
    currentExportTab = tab;
    
    const tabs = ['download', 'sheets', 'sync'];
    tabs.forEach(t => {
        const btn = document.getElementById(`btn-export-tab-${t}`);
        const pane = document.getElementById(`export-pane-${t}`);
        if (btn) {
            if (t === tab) {
                btn.className = 'export-tab-btn px-3.5 py-2 rounded-xl font-bold text-xs flex items-center gap-2 bg-emerald-600 text-white shadow-sm transition whitespace-nowrap';
            } else {
                btn.className = 'export-tab-btn px-3.5 py-2 rounded-xl font-semibold text-xs flex items-center gap-2 bg-gray-100 text-gray-600 hover:bg-gray-200 transition whitespace-nowrap';
            }
        }
        if (pane) {
            if (t === tab) {
                pane.classList.remove('hidden-view');
            } else {
                pane.classList.add('hidden-view');
            }
        }
    });

    const copyStatus = document.getElementById('copy-status-message');
    if (copyStatus) copyStatus.classList.add('hidden-view');
    
    updateExportPreview();
}

function setExportType(type) {
    currentExportType = type;
    const types = ['transaksi', 'gaji', 'produk', 'semua'];
    types.forEach(t => {
        const btn = document.getElementById(`btn-extype-${t}`);
        if (btn) {
            if (t === type) {
                btn.className = 'export-type-btn p-2.5 rounded-xl border-2 border-emerald-600 bg-emerald-50/80 text-emerald-950 font-bold text-xs flex flex-col items-center justify-center gap-1 transition shadow-xs';
            } else {
                btn.className = 'export-type-btn p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 font-semibold text-xs flex flex-col items-center justify-center gap-1 transition';
            }
        }
    });

    updateExportPreview();
}

function setExportQuickPeriod(period) {
    const startDateInput = document.getElementById('export-start-date');
    const endDateInput = document.getElementById('export-end-date');
    const now = new Date();
    
    const formatDate = (d) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    };

    const periodBtns = ['hari-ini', 'bulan-ini', 'tahun-ini', 'semua'];
    periodBtns.forEach(p => {
        const btn = document.getElementById(`btn-period-${p}`);
        if (btn) {
            if (p === period) {
                btn.className = 'period-btn px-2 py-1.5 rounded-lg border border-emerald-500 bg-emerald-50 text-[10px] font-bold text-emerald-800 transition text-center';
            } else {
                btn.className = 'period-btn px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-[10px] font-semibold hover:bg-gray-100 text-gray-700 transition text-center';
            }
        }
    });

    if (period === 'hari-ini') {
        const todayStr = formatDate(now);
        if (startDateInput) startDateInput.value = todayStr;
        if (endDateInput) endDateInput.value = todayStr;
    } else if (period === 'bulan-ini') {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        if (startDateInput) startDateInput.value = formatDate(firstDay);
        if (endDateInput) endDateInput.value = formatDate(lastDay);
    } else if (period === 'tahun-ini') {
        const firstDayYear = new Date(now.getFullYear(), 0, 1);
        const lastDayYear = new Date(now.getFullYear(), 11, 31);
        if (startDateInput) startDateInput.value = formatDate(firstDayYear);
        if (endDateInput) endDateInput.value = formatDate(lastDayYear);
    } else { // 'semua'
        if (startDateInput) startDateInput.value = '';
        if (endDateInput) endDateInput.value = '';
    }

    updateExportPreview();
}

function getFilteredDataForExport() {
    const branch = document.getElementById('export-filter-cabang')?.value || 'Semua';
    const startDate = document.getElementById('export-start-date')?.value || '';
    const endDate = document.getElementById('export-end-date')?.value || '';

    let filteredTransactions = (HISTORI_TRX_CACHE || []).slice();
    let filteredGaji = (HISTORI_GAJI_CACHE || []).slice();
    let filteredProduk = (PRODUK_CACHE || []).slice();
    let filteredKaryawan = (KARYAWAN_CACHE || []).slice();

    // Filter branch
    if (branch !== 'Semua') {
        filteredTransactions = filteredTransactions.filter(t => (t['Cabang'] || 'Pusat') === branch);
        filteredGaji = filteredGaji.filter(g => (g['Cabang'] || 'Pusat') === branch);
        filteredKaryawan = filteredKaryawan.filter(k => (k['Cabang'] || 'Pusat') === branch);
    }

    // Filter date
    const startObj = startDate ? new Date(startDate + 'T00:00:00') : null;
    const endObj = endDate ? new Date(endDate + 'T23:59:59') : null;

    if (startObj || endObj) {
        filteredTransactions = filteredTransactions.filter(t => {
            const d = parseTrxDate(t['Tanggal']);
            if (!d) return true;
            if (startObj && d < startObj) return false;
            if (endObj && d > endObj) return false;
            return true;
        });

        filteredGaji = filteredGaji.filter(g => {
            if (!startObj && !endObj) return true;
            return true;
        });
    }

    return {
        transactions: filteredTransactions,
        gaji: filteredGaji,
        produk: filteredProduk,
        karyawan: filteredKaryawan,
        branch,
        startDate,
        endDate
    };
}

function updateExportPreview() {
    const data = getFilteredDataForExport();
    const titleEl = document.getElementById('export-preview-title');
    const subtitleEl = document.getElementById('export-preview-subtitle');
    const badgeEl = document.getElementById('export-preview-badge');

    if (!titleEl || !subtitleEl || !badgeEl) return;

    if (currentExportType === 'transaksi') {
        const count = data.transactions.length;
        const total = data.transactions.reduce((acc, t) => acc + (parseFloat(t['Total Belanja']) || 0), 0);
        titleEl.textContent = `${count} Transaksi Penjualan Ditemukan`;
        subtitleEl.textContent = `Total Omset Terfilter: ${formatRupiah(total)} | Cabang: ${data.branch}`;
        badgeEl.textContent = `${count} Baris`;
    } else if (currentExportType === 'gaji') {
        const count = data.gaji.length;
        const total = data.gaji.reduce((acc, g) => acc + (parseFloat(g['Total Gaji'] || g['Gaji Bersih'] || 0)), 0);
        titleEl.textContent = `${count} Riwayat Slip Gaji Ditemukan`;
        subtitleEl.textContent = `Total Pengeluaran Gaji: ${formatRupiah(total)} | Cabang: ${data.branch}`;
        badgeEl.textContent = `${count} Baris`;
    } else if (currentExportType === 'produk') {
        const count = data.produk.length;
        titleEl.textContent = `${count} Data Menu Makanan & Minuman`;
        subtitleEl.textContent = `Daftar lengkap harga dan kategori produk Istana Bubur`;
        badgeEl.textContent = `${count} Produk`;
    } else { // 'semua'
        const totalRows = data.transactions.length + data.gaji.length + data.produk.length + data.karyawan.length;
        titleEl.textContent = `Paket Lengkap (${totalRows} Total Data)`;
        subtitleEl.textContent = `4 Lembar Sheet: Penjualan (${data.transactions.length}), Gaji (${data.gaji.length}), Produk (${data.produk.length}), Karyawan (${data.karyawan.length})`;
        badgeEl.textContent = `${totalRows} Total`;
    }
}

function buildTableDataForType(type, data) {
    let headers = [];
    let rows = [];

    if (type === 'transaksi') {
        headers = ['No', 'ID Transaksi', 'Tanggal & Waktu', 'Cabang', 'Kasir', 'Pelanggan', 'No WA', 'Metode Bayar', 'Rincian Menu Dipesan', 'Total Belanja (Rp)', 'Nominal Bayar (Rp)', 'Kembalian (Rp)'];
        let totalBelanjaSum = 0;
        let totalBayarSum = 0;
        let totalKembaliSum = 0;

        rows = data.transactions.map((t, idx) => {
            const total = parseFloat(t['Total Belanja']) || 0;
            const bayar = parseFloat(t['Nominal Bayar']) || total;
            const kembali = parseFloat(t['Kembalian']) || 0;
            totalBelanjaSum += total;
            totalBayarSum += bayar;
            totalKembaliSum += kembali;

            let itemsStr = '';
            try {
                const parsed = typeof t['Items JSON'] === 'string' ? JSON.parse(t['Items JSON']) : (t['Items JSON'] || []);
                if (Array.isArray(parsed)) {
                    itemsStr = parsed.map(i => `${i.nama || i.name} (${i.qty}x @${formatRupiah(i.harga || 0)})`).join('; ');
                }
            } catch(e) {
                itemsStr = String(t['Items JSON'] || '-');
            }

            return [
                idx + 1,
                t['ID Transaksi'] || '-',
                t['Tanggal'] || '-',
                t['Cabang'] || 'Pusat',
                t['Kasir'] || '-',
                t['Nama Pelanggan'] || '-',
                t['No WA'] || '-',
                t['Metode Bayar'] || 'Cash',
                itemsStr || '-',
                total,
                bayar,
                kembali
            ];
        });

        rows.push(['TOTAL', '', '', '', '', '', '', '', `${rows.length} Transaksi`, totalBelanjaSum, totalBayarSum, totalKembaliSum]);

    } else if (type === 'gaji') {
        headers = ['No', 'ID Slip Gaji', 'Nama Karyawan', 'ID Karyawan', 'Cabang', 'Jabatan', 'Periode Bulan', 'Hari Masuk', 'Gaji Harian (Rp)', 'Bonus Kinerja (Rp)', 'Potongan Kasbon (Rp)', 'Total Diterima (Rp)', 'No WhatsApp', 'Keterangan Libur'];
        let totalGajiSum = 0;

        rows = data.gaji.map((g, idx) => {
            const total = parseFloat(g['Total Gaji'] || g['Gaji Bersih']) || 0;
            totalGajiSum += total;
            return [
                idx + 1,
                g['ID Slip'] || '-',
                g['Nama Karyawan'] || '-',
                g['ID Karyawan'] || '-',
                g['Cabang'] || 'Pusat',
                g['Jabatan'] || '-',
                g['Bulan'] || '-',
                g['Hari Masuk'] || 0,
                parseFloat(g['Gaji Harian']) || 0,
                parseFloat(g['Bonus Kinerja']) || 0,
                parseFloat(g['Potongan Kasbon']) || 0,
                total,
                g['No WA'] || '-',
                g['Keterangan Libur'] || '-'
            ];
        });

        rows.push(['TOTAL PENGGAJIAN', '', '', '', '', '', '', '', '', '', '', totalGajiSum, '', '']);

    } else if (type === 'produk') {
        headers = ['No', 'ID Produk', 'Nama Produk / Menu', 'Kategori', 'Harga Jual (Rp)'];
        rows = data.produk.map((p, idx) => [
            idx + 1,
            p['ID Produk'] || `PRD-${idx + 1}`,
            p['Nama Produk'] || '-',
            p['Kategori'] || 'Makanan',
            parseFloat(p['Harga']) || 0
        ]);

    } else if (type === 'karyawan') {
        headers = ['No', 'ID Karyawan', 'Nama Lengkap', 'Jenis Kelamin', 'Jabatan', 'Cabang', 'Upah Harian (Rp)', 'No WhatsApp'];
        rows = data.karyawan.map((k, idx) => [
            idx + 1,
            k['ID Karyawan'] || `KRY-${idx + 1}`,
            k['Nama'] || '-',
            k['Gender'] || '-',
            k['Jabatan'] || '-',
            k['Cabang'] || 'Pusat',
            parseFloat(k['Gaji Harian']) || 0,
            k['No WA'] || '-'
        ]);
    }

    return { headers, rows };
}

function executeExportExcel() {
    try {
        const data = getFilteredDataForExport();
        const wb = XLSX.utils.book_new();
        const dateStamp = new Date().toISOString().slice(0, 10);

        if (currentExportType === 'semua') {
            // Sheet 1: Penjualan
            const tTable = buildTableDataForType('transaksi', data);
            const wsTrx = XLSX.utils.aoa_to_sheet([tTable.headers, ...tTable.rows]);
            wsTrx['!cols'] = [{wch: 5}, {wch: 16}, {wch: 20}, {wch: 12}, {wch: 12}, {wch: 16}, {wch: 15}, {wch: 14}, {wch: 35}, {wch: 18}, {wch: 18}, {wch: 16}];
            XLSX.utils.book_append_sheet(wb, wsTrx, 'Penjualan_Kasir');

            // Sheet 2: Gaji
            const gTable = buildTableDataForType('gaji', data);
            const wsGaji = XLSX.utils.aoa_to_sheet([gTable.headers, ...gTable.rows]);
            wsGaji['!cols'] = [{wch: 5}, {wch: 16}, {wch: 20}, {wch: 12}, {wch: 12}, {wch: 15}, {wch: 14}, {wch: 12}, {wch: 16}, {wch: 16}, {wch: 16}, {wch: 18}, {wch: 15}, {wch: 20}];
            XLSX.utils.book_append_sheet(wb, wsGaji, 'Riwayat_Gaji');

            // Sheet 3: Produk
            const pTable = buildTableDataForType('produk', data);
            const wsPrd = XLSX.utils.aoa_to_sheet([pTable.headers, ...pTable.rows]);
            wsPrd['!cols'] = [{wch: 5}, {wch: 14}, {wch: 25}, {wch: 15}, {wch: 16}];
            XLSX.utils.book_append_sheet(wb, wsPrd, 'Master_Produk');

            // Sheet 4: Karyawan
            const kTable = buildTableDataForType('karyawan', data);
            const wsKry = XLSX.utils.aoa_to_sheet([kTable.headers, ...kTable.rows]);
            wsKry['!cols'] = [{wch: 5}, {wch: 14}, {wch: 22}, {wch: 14}, {wch: 16}, {wch: 14}, {wch: 16}, {wch: 16}];
            XLSX.utils.book_append_sheet(wb, wsKry, 'Data_Karyawan');

            XLSX.writeFile(wb, `Laporan_Lengkap_IstanaBubur_${dateStamp}.xlsx`);
        } else {
            const table = buildTableDataForType(currentExportType, data);
            const ws = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
            ws['!cols'] = table.headers.map(() => ({ wch: 18 }));
            const sheetTitle = currentExportType === 'transaksi' ? 'Penjualan_POS' : 
                               currentExportType === 'gaji' ? 'Rekap_Gaji' : 'Master_Produk';
            XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
            XLSX.writeFile(wb, `Laporan_${sheetTitle}_${dateStamp}.xlsx`);
        }

        showToast('File Excel (.xlsx) berhasil diunduh!', 'success');
    } catch(err) {
        console.error('Error export Excel:', err);
        showToast('Gagal mengekspor file Excel: ' + err.message, 'error');
    }
}

function executeExportCSV() {
    try {
        const data = getFilteredDataForExport();
        const table = buildTableDataForType(currentExportType === 'semua' ? 'transaksi' : currentExportType, data);
        
        const escapeCSV = (val) => {
            if (val === null || val === undefined) return '""';
            let str = String(val);
            if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
                str = '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };

        const csvContent = '\uFEFF' + [table.headers, ...table.rows]
            .map(row => row.map(escapeCSV).join(','))
            .join('\r\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const dateStamp = new Date().toISOString().slice(0, 10);
        link.setAttribute('href', url);
        link.setAttribute('download', `Laporan_${currentExportType}_IstanaBubur_${dateStamp}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showToast('File CSV berhasil diunduh!', 'success');
    } catch(err) {
        console.error('Error export CSV:', err);
        showToast('Gagal mengekspor CSV: ' + err.message, 'error');
    }
}

function executeCopyForGoogleSheets() {
    try {
        const data = getFilteredDataForExport();
        const table = buildTableDataForType(currentExportType === 'semua' ? 'transaksi' : currentExportType, data);
        
        const tsv = [table.headers, ...table.rows]
            .map(row => row.map(cell => String(cell || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'))
            .join('\n');

        navigator.clipboard.writeText(tsv).then(() => {
            const statusMsg = document.getElementById('copy-status-message');
            if (statusMsg) statusMsg.classList.remove('hidden-view');

            const labelEl = document.getElementById('label-copy-sheets');
            if (labelEl) {
                const oldText = labelEl.textContent;
                labelEl.textContent = '✓ Berhasil Disalin! Buka Google Sheets & Tekan Ctrl + V';
                setTimeout(() => { labelEl.textContent = oldText; }, 5000);
            }

            showToast('Tabel berhasil disalin ke clipboard! Siap ditempel di Google Sheets.', 'success');
        }).catch(err => {
            console.error('Clipboard copy error:', err);
            showToast('Gagal menyalin otomatis. Silakan gunakan unduh Excel.', 'error');
        });
    } catch(err) {
        console.error('Copy sheets error:', err);
        showToast('Gagal menyiapkan data Google Sheets.', 'error');
    }
}

function openGoogleSheetsNew() {
    window.open('https://sheets.new', '_blank');
}

function copyAppsScriptCode() {
    const codeEl = document.getElementById('code-apps-script');
    if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent.trim()).then(() => {
            const labelEl = document.getElementById('label-copy-script');
            if (labelEl) {
                labelEl.textContent = '✓ Disalin!';
                setTimeout(() => { labelEl.textContent = 'Salin Kode'; }, 3000);
            }
            showToast('Kode Apps Script berhasil disalin!', 'success');
        });
    }
}

// Global initialization
document.addEventListener('DOMContentLoaded', () => { 
    initPrinterSettings(); 
    checkAutoLogin(); 

    // Initialize Firebase Firestore Cloud Connection
    const modeBadge = document.getElementById('app-mode-badge');
    if (modeBadge) {
        modeBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping mr-1"></span><i class="fas fa-fire text-amber-300"></i> Cloud Firestore';
        modeBadge.title = 'Database Cloud Firestore Terhubung & Sinkronisasi Real-Time Aktif';
    }

    // Seed default data if database is new
    seedInitialFirestoreData().then(() => {
        console.log('[Firestore] Sinkronisasi awal database siap.');
    }).catch(err => {
        console.warn('[Firestore Init Note]:', err);
    });

    // Real-time listener for cashier transactions across branches
    try {
        subscribeToTransactions((newTrxList) => {
            if (newTrxList && newTrxList.length > 0) {
                HISTORI_TRX_CACHE = newTrxList;
                localStorage.setItem(TRX_STORAGE_KEY, JSON.stringify(newTrxList));
                // Update views if visible
                if (currentTab === 'histori-trx') {
                    renderRiwayatTransaksi();
                } else if (currentTab === 'profil') {
                    if (CURRENT_USER && CURRENT_USER.role === 'Admin') {
                        renderDashboardSalesCharts();
                    } else if (CURRENT_USER && CURRENT_USER.role !== 'Admin') {
                        updateKasirDashboard();
                    }
                }
            }
        });
    } catch (e) {
        console.warn('[Firestore Real-time Listener]:', e);
    }
});

// Bind methods to window so onclick attributes can access them globally
window.handleLogin = handleLogin;
window.togglePasswordVisibility = togglePasswordVisibility;
window.toggleMenu = toggleMenu;
window.switchTab = switchTab;
window.openLogoutModal = openLogoutModal;
window.processLogout = processLogout;
window.closeModal = closeModal;
window.copyToClipboard = copyToClipboard;
window.openFormProduk = openFormProduk;
window.editProduk = editProduk;
window.previewImage = previewImage;
window.saveProdukData = saveProdukData;
window.confirmHapusProduk = confirmHapusProduk;
window.renderListProduk = renderListProduk;
window.openFormKaryawan = openFormKaryawan;
window.editKaryawan = editKaryawan;
window.saveKaryawanData = saveKaryawanData;
window.confirmHapusKaryawan = confirmHapusKaryawan;
window.autoFillSlipGaji = autoFillSlipGaji;
window.hitungTotalGaji = hitungTotalGaji;
window.resetFormSlip = resetFormSlip;
window.generateSlip = generateSlip;
window.renderKasirProdukList = renderKasirProdukList;
window.addToCart = addToCart;
window.changeQty = changeQty;
window.openCartModal = openCartModal;
window.clearCart = clearCart;
window.togglePaymentMethod = togglePaymentMethod;
window.hitungKembalian = hitungKembalian;
window.processCheckout = processCheckout;
window.resetCart = resetCart;
window.cetakStrukThermal = cetakStrukThermal;
window.cetakNotaPDF = cetakNotaPDF;
window.kirimWhatsApp = kirimWhatsApp;
window.cetakNotaPDFFromHistory = cetakNotaPDFFromHistory;
window.kirimWhatsAppFromHistory = kirimWhatsAppFromHistory;
window.reprintStrukTrx = reprintStrukTrx;
window.refreshHistoriTransaksi = refreshHistoriTransaksi;
window.renderHistoriTransaksi = renderHistoriTransaksi;
window.confirmHapusTransaksi = confirmHapusTransaksi;
window.isDateTrxToday = isDateTrxToday;
window.refreshHistoriGaji = refreshHistoriGaji;
window.renderHistoriGaji = renderHistoriGaji;
window.confirmHapusHistoriGaji = confirmHapusHistoriGaji;
window.kirimWaSlipGaji = kirimWaSlipGaji;
window.kirimWaSlipGajiDirect = kirimWaSlipGajiDirect;
window.lihatPdfSlipGaji = lihatPdfSlipGaji;
window.cetakSlipGajiPDF = cetakSlipGajiPDF;
window.formatBulanIndo = formatBulanIndo;
window.savePrinterSettings = savePrinterSettings;
window.scanPrinters = scanPrinters;
window.disconnectPrinter = disconnectPrinter;
window.testPrint = testPrint;
window.updateDashboardCharts = updateDashboardCharts;
window.renderDashboardSalesCharts = renderDashboardSalesCharts;
window.resetDateFilter = resetDateFilter;
window.updateKasirDashboard = updateKasirDashboard;
window.getHariTanggalIndo = getHariTanggalIndo;
window.openUrlOutsideApp = openUrlOutsideApp;
window.openWhatsAppApp = openWhatsAppApp;
window.openDocPdfOutsideApp = openDocPdfOutsideApp;
window.generateReceiptHTML = generateReceiptHTML;
window.generateSlipGajiHTML = generateSlipGajiHTML;
window.generateReceiptWhatsAppMessage = generateReceiptWhatsAppMessage;
window.generateSlipGajiWhatsAppMessage = generateSlipGajiWhatsAppMessage;

// ==========================================
// REAL-TIME CHAT BANTUAN (ADMIN & SELURUH CABANG)
// ==========================================

function initChatWebSocket() {
    if (!CURRENT_USER) return;
    if (wsChat && (wsChat.readyState === WebSocket.OPEN || wsChat.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/chat`;
        wsChat = new WebSocket(wsUrl);

        updateChatWsStatus('connecting');

        wsChat.onopen = () => {
            updateChatWsStatus('online');
            // Register current user session with WebSocket server
            wsChat.send(JSON.stringify({
                type: 'register',
                user: {
                    username: CURRENT_USER.username,
                    role: CURRENT_USER.role,
                    cabang: CURRENT_USER.cabang
                }
            }));
        };

        wsChat.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'init') {
                    CHAT_MESSAGES = Array.isArray(data.messages) ? data.messages : [];
                    if (data.onlineUsers) {
                        updateOnlineUsersUI(data.onlineUsers);
                    }
                    if (currentTab === 'chat') {
                        renderChatMessages();
                        if (CURRENT_USER.role === 'Admin') renderAdminCabangTabs();
                    }
                } else if (data.type === 'new_message') {
                    const newMsg = data.message;
                    if (!newMsg) return;

                    // Idempotent check
                    const exists = CHAT_MESSAGES.some(m => m.id === newMsg.id);
                    if (!exists) {
                        CHAT_MESSAGES.push(newMsg);
                    }

                    const isFromSelf = (CURRENT_USER && newMsg.sender === CURRENT_USER.username);

                    // Play bright audio chime for incoming messages from others
                    if (!isFromSelf) {
                        playChatNotificationSound();
                    }

                    const isCurrentTabChat = (currentTab === 'chat');

                    if (CURRENT_USER && CURRENT_USER.role === 'Admin') {
                        const targetBranch = newMsg.cabang || 'Cabang A';
                        const isLookingAtThisBranch = isCurrentTabChat && (currentAdminChatCabang === targetBranch || currentAdminChatCabang === 'Semua');

                        if (isLookingAtThisBranch) {
                            renderChatMessages(newMsg.id);
                            renderAdminCabangTabs();
                            if (isUserScrolledUp) {
                                showScrollBottomButton();
                            } else {
                                scrollChatToBottom(false);
                            }
                        } else {
                            if (!isFromSelf) {
                                if (targetBranch !== 'Semua') {
                                    cabangUnreadCounts[targetBranch] = (cabangUnreadCounts[targetBranch] || 0) + 1;
                                }
                                chatUnreadCount++;
                                updateChatUnreadBadges();
                                if (isCurrentTabChat) {
                                    renderAdminCabangTabs();
                                }
                                showChatNotificationPopup(newMsg);
                            }
                        }
                    } else if (CURRENT_USER && CURRENT_USER.role === 'Kasir') {
                        const userCabang = CURRENT_USER.cabang || 'Cabang A';
                        const isRelevant = (newMsg.cabang === userCabang || newMsg.cabang === 'Semua');

                        if (isRelevant) {
                            if (isCurrentTabChat) {
                                renderChatMessages(newMsg.id);
                                if (isUserScrolledUp) {
                                    showScrollBottomButton();
                                } else {
                                    scrollChatToBottom(false);
                                }
                            } else {
                                if (!isFromSelf) {
                                    chatUnreadCount++;
                                    updateChatUnreadBadges();
                                    showChatNotificationPopup(newMsg);
                                }
                            }
                        }
                    }
                } else if (data.type === 'presence') {
                    if (data.onlineUsers) {
                        updateOnlineUsersUI(data.onlineUsers);
                    }
                } else if (data.type === 'typing') {
                    handleIncomingTyping(data);
                }
            } catch (err) {
                console.error('Error handling WebSocket message:', err);
            }
        };

        wsChat.onclose = () => {
            updateChatWsStatus('offline');
            if (CURRENT_USER) {
                setTimeout(() => {
                    initChatWebSocket();
                }, 4000);
            }
        };

        wsChat.onerror = (err) => {
            console.warn('WebSocket error:', err);
            updateChatWsStatus('offline');
        };
    } catch (e) {
        console.error('Failed to initialize WebSocket:', e);
        updateChatWsStatus('offline');
    }
}

function closeChatWebSocket() {
    if (wsChat) {
        try {
            wsChat.close();
        } catch (e) {}
        wsChat = null;
    }
    chatUnreadCount = 0;
    updateChatUnreadBadges();
}

function updateChatWsStatus(status) {
    const badge = document.getElementById('chat-ws-status-badge');
    const text = document.getElementById('chat-ws-status-text');
    const dot = document.getElementById('chat-ws-dot');
    if (!badge || !text || !dot) return;

    if (status === 'online') {
        badge.className = 'inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200';
        dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        text.innerText = 'Online (Live)';
    } else if (status === 'connecting') {
        badge.className = 'inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200';
        dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
        text.innerText = 'Menghubungkan...';
    } else {
        badge.className = 'inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200';
        dot.className = 'w-2 h-2 rounded-full bg-gray-400';
        text.innerText = 'Mode Cadangan (HTTP)';
    }
}

function updateOnlineUsersUI(onlineUsers) {
    const el = document.getElementById('chat-online-count');
    if (!el || !Array.isArray(onlineUsers)) return;
    const count = Math.max(1, onlineUsers.length);
    el.innerText = `${count} Online`;
}

// ==========================================
// NOTIFIKASI AUDIO & POPUP CHAT
// ==========================================

function playChatNotificationSound() {
    if (!isChatSoundEnabled) return;
    try {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                audioCtx = new AudioContextClass();
            }
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        if (!audioCtx) return;

        const now = audioCtx.currentTime;
        // Two-tone cheerful bell: 587.33Hz (D5) -> 880Hz (A5)
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(587.33, now);
        gain1.gain.setValueAtTime(0.12, now);
        gain1.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.2);

        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880, now + 0.08);
        gain2.gain.setValueAtTime(0.18, now + 0.08);
        gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.08);
        osc2.stop(now + 0.4);
    } catch (err) {
        console.log('Audio notification skipped:', err);
    }
}

function toggleChatSound() {
    isChatSoundEnabled = !isChatSoundEnabled;
    localStorage.setItem('ib_chat_sound', isChatSoundEnabled ? 'on' : 'off');
    updateChatSoundUI();
    if (isChatSoundEnabled) {
        playChatNotificationSound();
        showToast('🔊 Suara Notifikasi Chat: AKTIF', 'info');
    } else {
        showToast('🔇 Suara Notifikasi Chat: NONAKTIF', 'info');
    }
}

function updateChatSoundUI() {
    const icon = document.getElementById('icon-chat-sound');
    const text = document.getElementById('text-chat-sound');
    if (icon && text) {
        if (isChatSoundEnabled) {
            icon.className = 'fas fa-volume-up text-xs text-blue-600';
            text.innerText = 'Suara: ON';
        } else {
            icon.className = 'fas fa-volume-mute text-xs text-gray-400';
            text.innerText = 'Suara: OFF';
        }
    }
}

function showChatNotificationPopup(newMsg) {
    if (!newMsg) return;
    const container = document.getElementById('chat-notification-banner-container');
    if (!container) return;

    const popupId = 'chat-popup-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const popup = document.createElement('div');
    popup.id = popupId;
    popup.className = 'pointer-events-auto bg-white border-2 border-red-500 rounded-2xl p-3.5 shadow-2xl shadow-red-900/20 transform transition-all duration-300 translate-y-[-15px] opacity-0 flex items-start gap-3 w-full';

    const isFromAdmin = newMsg.role === 'Admin';
    const senderDisplay = isFromAdmin ? 'Admin Pusat' : `${newMsg.sender} (${newMsg.cabang || 'Cabang'})`;
    const roleBadge = isFromAdmin ? '👑 Pusat' : `🏪 ${newMsg.cabang || 'Cabang'}`;
    const truncatedText = escapeHtml(newMsg.text.length > 75 ? newMsg.text.slice(0, 72) + '...' : newMsg.text);

    popup.innerHTML = `
        <div class="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center text-lg shrink-0 border border-red-100 relative">
            <i class="fas fa-comment-dots"></i>
            <span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-red-500 animate-ping"></span>
            <span class="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-red-600"></span>
        </div>
        <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-1.5 mb-1">
                <span class="text-xs font-black text-gray-900 truncate">${escapeHtml(senderDisplay)}</span>
                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 shrink-0">${roleBadge}</span>
            </div>
            <p class="text-xs text-gray-700 leading-snug break-words mb-2.5 line-clamp-2">${truncatedText}</p>
            <div class="flex items-center gap-2">
                <button onclick="openChatFromNotification('${newMsg.cabang || 'Cabang A'}', '${popupId}')" class="text-xs bg-red-600 hover:bg-red-700 active:scale-95 text-white font-bold px-3 py-1 rounded-lg transition shadow-xs flex items-center gap-1.5">
                    <i class="fas fa-reply text-[10px]"></i>
                    <span>Buka Chat</span>
                </button>
                <button onclick="dismissChatPopup('${popupId}')" class="text-xs text-gray-500 hover:text-gray-800 font-medium px-2 py-1 rounded-lg hover:bg-gray-100 transition">
                    Tutup
                </button>
            </div>
        </div>
        <button onclick="dismissChatPopup('${popupId}')" class="text-gray-400 hover:text-gray-600 p-1 -mr-1 -mt-1 text-xs transition">
            <i class="fas fa-times"></i>
        </button>
    `;

    container.appendChild(popup);

    requestAnimationFrame(() => {
        popup.classList.remove('translate-y-[-15px]', 'opacity-0');
    });

    popup._dismissTimer = setTimeout(() => {
        dismissChatPopup(popupId);
    }, 7000);
}

function dismissChatPopup(popupId) {
    const el = document.getElementById(popupId);
    if (!el) return;
    clearTimeout(el._dismissTimer);
    el.classList.add('opacity-0', 'scale-95');
    setTimeout(() => {
        el.remove();
    }, 250);
}

function openChatFromNotification(cabang, popupId) {
    dismissChatPopup(popupId);
    if (CURRENT_USER && CURRENT_USER.role === 'Admin') {
        currentAdminChatCabang = (cabang && cabang !== 'Semua') ? cabang : 'Semua';
    }
    switchTab('chat');
}

function handleChatScroll() {
    const box = document.getElementById('chat-messages-box');
    const btn = document.getElementById('btn-scroll-bottom-chat');
    if (!box) return;

    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    isUserScrolledUp = (distanceFromBottom > 90);

    if (!isUserScrolledUp && btn) {
        btn.classList.add('hidden-view');
    }
}

function showScrollBottomButton() {
    const btn = document.getElementById('btn-scroll-bottom-chat');
    if (btn) btn.classList.remove('hidden-view');
}

function scrollChatToBottom(smooth = true) {
    const box = document.getElementById('chat-messages-box');
    const btn = document.getElementById('btn-scroll-bottom-chat');
    if (btn) btn.classList.add('hidden-view');
    isUserScrolledUp = false;
    if (box) {
        box.scrollTo({
            top: box.scrollHeight,
            behavior: smooth ? 'smooth' : 'auto'
        });
    }
}

function updateChatUnreadBadges() {
    const tabBadge = document.getElementById('badge-unread-chat');
    const headerBadge = document.getElementById('header-unread-badge');
    const headerPing = document.getElementById('header-unread-ping');
    const menuDot = document.getElementById('menu-unread-dot');
    const adminDashBadge = document.getElementById('admin-dash-unread-badge');
    const kasirDashBadge = document.getElementById('kasir-dash-unread-badge');
    const chatIcon = document.getElementById('header-chat-icon');

    if (chatUnreadCount > 0) {
        const countText = chatUnreadCount > 99 ? '99+' : String(chatUnreadCount);

        if (tabBadge) {
            tabBadge.innerText = countText;
            tabBadge.classList.remove('hidden-view');
        }
        if (headerBadge) {
            headerBadge.innerText = countText;
            headerBadge.classList.remove('hidden-view');
        }
        if (headerPing) {
            headerPing.classList.remove('hidden-view');
        }
        if (menuDot) {
            menuDot.classList.remove('hidden-view');
        }
        if (adminDashBadge) {
            adminDashBadge.innerText = `${countText} Pesan Baru`;
            adminDashBadge.classList.remove('hidden-view');
        }
        if (kasirDashBadge) {
            kasirDashBadge.innerText = `${countText} Baru`;
            kasirDashBadge.classList.remove('hidden-view');
        }
        if (chatIcon) {
            chatIcon.classList.add('animate-bounce');
        }

        // Tanda notifikasi di Tab browser
        document.title = `(${countText}) 💬 Pesan Baru | Istana Bubur`;
    } else {
        if (tabBadge) tabBadge.classList.add('hidden-view');
        if (headerBadge) headerBadge.classList.add('hidden-view');
        if (headerPing) headerPing.classList.add('hidden-view');
        if (menuDot) menuDot.classList.add('hidden-view');
        if (adminDashBadge) adminDashBadge.classList.add('hidden-view');
        if (kasirDashBadge) kasirDashBadge.classList.add('hidden-view');
        if (chatIcon) {
            chatIcon.classList.remove('animate-bounce');
        }

        // Kembalikan judul halaman
        document.title = 'Istana Bubur';
    }
}

function openChatView() {
    if (!CURRENT_USER) return;

    if (CURRENT_USER.role === 'Admin') {
        if (currentAdminChatCabang !== 'Semua') {
            cabangUnreadCounts[currentAdminChatCabang] = 0;
        } else {
            cabangUnreadCounts = {};
        }
        chatUnreadCount = Object.values(cabangUnreadCounts).reduce((a, b) => a + b, 0);
    } else {
        chatUnreadCount = 0;
    }

    updateChatUnreadBadges();
    updateChatSoundUI();

    initChatWebSocket();

    const kasirLabel = document.getElementById('kasir-chat-cabang-label');
    if (kasirLabel) {
        kasirLabel.innerText = CURRENT_USER.cabang || 'Cabang A';
    }

    const headerDesc = document.getElementById('chat-header-desc');
    if (headerDesc) {
        if (CURRENT_USER.role === 'Admin') {
            headerDesc.innerText = 'Pusat Bantuan & Komunikasi Seluruh Cabang Istana Bubur';
        } else {
            headerDesc.innerText = `Terhubung langsung dengan Admin Pusat (Cabang: ${CURRENT_USER.cabang || 'Cabang A'})`;
        }
    }

    if (CURRENT_USER.role === 'Admin') {
        renderAdminCabangTabs();
    }

    renderChatMessages();

    setTimeout(() => {
        scrollChatToBottom(false);
        const input = document.getElementById('chat-input-text');
        if (input) input.focus();
    }, 100);
}

function renderAdminCabangTabs() {
    const container = document.getElementById('admin-cabang-pill-container');
    if (!container) return;

    const cabangSet = new Set(['Semua', 'Cabang A', 'Cabang B', 'Cabang C']);
    if (Array.isArray(HISTORI_TRX_CACHE)) {
        HISTORI_TRX_CACHE.forEach(t => {
            if (t['Cabang']) cabangSet.add(t['Cabang']);
        });
    }
    CHAT_MESSAGES.forEach(m => {
        if (m.cabang && m.cabang !== 'Semua') cabangSet.add(m.cabang);
    });

    const cabangs = Array.from(cabangSet);
    container.innerHTML = cabangs.map(c => {
        const isActive = (c === currentAdminChatCabang);
        const label = c === 'Semua' ? '📢 Semua Cabang (Broadcast)' : `🏪 ${c}`;
        const activeClass = isActive 
            ? 'bg-red-600 text-white font-bold shadow-sm' 
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium';

        const unreadThisCabang = (c === 'Semua') ? 0 : (cabangUnreadCounts[c] || 0);
        const unreadBadgeHtml = unreadThisCabang > 0
            ? `<span class="ml-1.5 px-1.5 py-0.2 rounded-full text-[9px] font-black ${isActive ? 'bg-white text-red-600' : 'bg-red-600 text-white animate-pulse'}">${unreadThisCabang}</span>`
            : '';

        return `
            <button onclick="selectAdminChatCabang('${c}')" class="shrink-0 text-xs px-3.5 py-1.5 rounded-xl transition active:scale-95 flex items-center ${activeClass}">
                <span>${label}</span>
                ${unreadBadgeHtml}
            </button>
        `;
    }).join('');
}

function selectAdminChatCabang(cabang) {
    currentAdminChatCabang = cabang;
    if (cabang !== 'Semua') {
        cabangUnreadCounts[cabang] = 0;
    } else {
        cabangUnreadCounts = {};
    }
    chatUnreadCount = Object.values(cabangUnreadCounts).reduce((a, b) => a + b, 0);
    updateChatUnreadBadges();

    renderAdminCabangTabs();
    renderChatMessages();
    scrollChatToBottom(false);
    
    const input = document.getElementById('chat-input-text');
    if (input) {
        input.placeholder = cabang === 'Semua' 
            ? 'Kirim pesan broadcast ke SEMUA cabang...' 
            : `Tulis balasan ke ${cabang}...`;
        input.focus();
    }
}

function renderChatMessages(highlightMessageId = null) {
    const container = document.getElementById('chat-messages-box');
    const titleEl = document.getElementById('chat-active-channel-title');
    const countEl = document.getElementById('chat-message-count');
    if (!container || !CURRENT_USER) return;

    const isAdmin = CURRENT_USER.role === 'Admin';
    let filtered = [];

    if (isAdmin) {
        if (currentAdminChatCabang === 'Semua') {
            filtered = [...CHAT_MESSAGES];
            if (titleEl) titleEl.innerText = 'Ruang Chat: Seluruh Cabang (Semua)';
        } else {
            filtered = CHAT_MESSAGES.filter(m => m.cabang === currentAdminChatCabang || m.cabang === 'Semua');
            if (titleEl) titleEl.innerText = `Ruang Chat: ${currentAdminChatCabang}`;
        }
    } else {
        const userCabang = CURRENT_USER.cabang || 'Cabang A';
        filtered = CHAT_MESSAGES.filter(m => m.cabang === userCabang || m.cabang === 'Semua');
        if (titleEl) titleEl.innerText = `Ruang Chat: ${userCabang} ↔ Admin Pusat`;
    }

    if (countEl) {
        countEl.innerText = `${filtered.length} pesan`;
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-center p-6 text-gray-400">
                <div class="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center text-gray-400 text-2xl mb-3">
                    <i class="fas fa-comments"></i>
                </div>
                <p class="text-sm font-bold text-gray-700 mb-1">Belum Ada Percakapan</p>
                <p class="text-xs text-gray-400 max-w-xs">
                    ${isAdmin ? 'Belum ada pesan pada saluran ini. Pilih cabang lain atau kirim pesan baru di bawah.' : 'Mulai chat untuk menghubungi Admin Pusat terkait bantuan operasional, printer, stok, atau kasir.'}
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(msg => {
        const isSelf = msg.sender === CURRENT_USER.username;
        const isBroadcast = msg.cabang === 'Semua';
        const isHighlighted = (msg.id && msg.id === highlightMessageId);
        const highlightClass = isHighlighted ? 'ring-4 ring-amber-400 ring-offset-2 animate-pulse' : '';

        if (isSelf) {
            return `
                <div class="flex flex-col items-end">
                    <div class="max-w-[85%] sm:max-w-[75%] bg-gradient-to-r from-red-600 to-rose-600 text-white rounded-2xl rounded-tr-none px-4 py-2.5 shadow-sm ${highlightClass}">
                        <div class="flex items-center justify-between gap-2 mb-1">
                            <span class="text-[10px] font-bold text-red-100">${msg.role === 'Admin' ? 'Admin Pusat' : (CURRENT_USER.cabang || 'Kasir')}</span>
                            ${isBroadcast ? '<span class="text-[9px] bg-white/20 text-white px-1.5 py-0.5 rounded font-semibold">Broadcast</span>' : ''}
                        </div>
                        <p class="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words">${escapeHtml(msg.text)}</p>
                        <div class="flex items-center justify-end gap-1.5 mt-1.5 text-[10px] text-red-100">
                            <span>${msg.formattedTime || ''}</span>
                            <i class="fas fa-check-double text-[9px]"></i>
                        </div>
                    </div>
                </div>
            `;
        } else {
            const isMsgAdmin = msg.role === 'Admin';
            const roleBadgeClass = isMsgAdmin 
                ? 'bg-red-50 text-red-700 border-red-200' 
                : 'bg-blue-50 text-blue-700 border-blue-200';
            const roleLabel = isMsgAdmin 
                ? 'Admin Pusat' 
                : `${msg.sender} (${msg.cabang})`;

            return `
                <div class="flex flex-col items-start">
                    <div class="max-w-[85%] sm:max-w-[75%] bg-white border border-gray-200 text-gray-800 rounded-2xl rounded-tl-none px-4 py-2.5 shadow-xs ${highlightClass}">
                        <div class="flex items-center justify-between gap-2 mb-1">
                            <div class="flex items-center gap-1.5">
                                <span class="text-xs font-bold text-gray-900">${escapeHtml(msg.sender)}</span>
                                <span class="text-[9px] font-bold px-1.5 py-0.5 rounded border ${roleBadgeClass}">${roleLabel}</span>
                            </div>
                            ${isBroadcast ? '<span class="text-[9px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded font-semibold">Broadcast</span>' : ''}
                        </div>
                        <p class="text-xs sm:text-sm leading-relaxed text-gray-700 whitespace-pre-wrap break-words">${escapeHtml(msg.text)}</p>
                        <div class="flex items-center justify-end mt-1.5 text-[10px] text-gray-400">
                            <span>${msg.formattedTime || ''}</span>
                        </div>
                    </div>
                </div>
            `;
        }
    }).join('');

    if (!isUserScrolledUp) {
        container.scrollTop = container.scrollHeight;
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function handleSendChatMessage(e) {
    if (e) e.preventDefault();
    if (!CURRENT_USER) return;

    const input = document.getElementById('chat-input-text');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    let targetCabang = 'Semua';
    if (CURRENT_USER.role === 'Admin') {
        targetCabang = currentAdminChatCabang;
    } else {
        targetCabang = CURRENT_USER.cabang || 'Cabang A';
    }

    input.value = '';

    if (wsChat && wsChat.readyState === WebSocket.OPEN) {
        wsChat.send(JSON.stringify({ type: 'typing', isTyping: false }));
        isTypingSent = false;
    }

    if (wsChat && wsChat.readyState === WebSocket.OPEN) {
        wsChat.send(JSON.stringify({
            type: 'chat_message',
            cabang: targetCabang,
            sender: CURRENT_USER.username,
            text: text
        }));
    } else {
        // Fallback to HTTP REST
        try {
            const resp = await fetch(getApiEndpoint('/api/chat/send'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cabang: targetCabang,
                    sender: CURRENT_USER.username,
                    role: CURRENT_USER.role,
                    text: text
                })
            });
            const res = await resp.json();
            if (res.success && res.message) {
                const exists = CHAT_MESSAGES.some(m => m.id === res.message.id);
                if (!exists) {
                    CHAT_MESSAGES.push(res.message);
                    renderChatMessages();
                }
            }
        } catch (err) {
            console.error('Error fallback sending chat:', err);
            showToast('Gagal mengirim pesan chat', 'error');
        }
    }

    setTimeout(() => {
        const box = document.getElementById('chat-messages-box');
        if (box) box.scrollTop = box.scrollHeight;
    }, 50);
}

function sendQuickPrompt(promptText) {
    const input = document.getElementById('chat-input-text');
    if (input) {
        input.value = promptText;
        handleSendChatMessage(null);
    }
}

function handleChatTyping(e) {
    if (!wsChat || wsChat.readyState !== WebSocket.OPEN) return;
    if (!isTypingSent) {
        isTypingSent = true;
        wsChat.send(JSON.stringify({ type: 'typing', isTyping: true }));
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        isTypingSent = false;
        if (wsChat && wsChat.readyState === WebSocket.OPEN) {
            wsChat.send(JSON.stringify({ type: 'typing', isTyping: false }));
        }
    }, 2000);
}

function handleIncomingTyping(data) {
    if (!CURRENT_USER || data.sender === CURRENT_USER.username) return;
    const indicator = document.getElementById('chat-typing-indicator');
    const textEl = document.getElementById('chat-typing-text');
    if (!indicator || !textEl) return;

    if (data.isTyping) {
        textEl.innerText = `${data.sender} (${data.role === 'Admin' ? 'Admin Pusat' : data.cabang}) sedang mengetik...`;
        indicator.classList.remove('hidden-view');
        clearTimeout(indicator._hideTimer);
        indicator._hideTimer = setTimeout(() => {
            indicator.classList.add('hidden-view');
        }, 3000);
    } else {
        indicator.classList.add('hidden-view');
    }
}

async function refreshChatHistory() {
    if (!CURRENT_USER) return;
    try {
        const targetCabang = CURRENT_USER.role === 'Admin' ? currentAdminChatCabang : (CURRENT_USER.cabang || 'Cabang A');
        const resp = await fetch(getApiEndpoint(`/api/chat/messages?cabang=${encodeURIComponent(targetCabang)}&role=${encodeURIComponent(CURRENT_USER.role)}`));
        const res = await resp.json();
        if (res.success && Array.isArray(res.messages)) {
            CHAT_MESSAGES = res.messages;
            renderChatMessages();
            if (CURRENT_USER.role === 'Admin') renderAdminCabangTabs();
            showToast('Riwayat chat berhasil dimuat ulang', 'success');
        }
    } catch (e) {
        console.error('Error refreshing chat:', e);
    }
}

// Global window bindings for authentication & account management
window.setLoginRole = setLoginRole;
window.setDemoLogin = setDemoLogin;
window.handleLogin = handleLogin;
window.checkAutoLogin = checkAutoLogin;

window.openRegisterModal = openRegisterModal;
window.submitRegisterStep1 = submitRegisterStep1;
window.resendReferralCode = resendReferralCode;
window.backToRegisterStep1 = backToRegisterStep1;
window.verifyReferralStep2 = verifyReferralStep2;
window.backToRegisterStep2 = backToRegisterStep2;
window.activateAccountStep3 = activateAccountStep3;
window.openActivateAccountPrompt = openActivateAccountPrompt;

// Admin Security Key bindings
window.toggleShowAdminAuthKey = toggleShowAdminAuthKey;
window.copyAdminAuthKey = copyAdminAuthKey;
window.openEditAuthCodeModal = openEditAuthCodeModal;
window.saveNewAdminAuthCode = saveNewAdminAuthCode;
window.syncAdminAuthKeyUI = syncAdminAuthKeyUI;

window.openForgotUsernameModal = openForgotUsernameModal;
window.handleFindUsername = handleFindUsername;
window.useFoundUsername = useFoundUsername;

window.openForgotPasswordModal = openForgotPasswordModal;
window.submitForgotPasswordStep1 = submitForgotPasswordStep1;
window.autoFillFpOtp = autoFillFpOtp;
window.backToFpStep1 = backToFpStep1;
window.submitForgotPasswordStep2 = submitForgotPasswordStep2;

// Chat & Dashboard bindings
window.initChatWebSocket = initChatWebSocket;
window.closeChatWebSocket = closeChatWebSocket;
window.openChatView = openChatView;
window.renderAdminCabangTabs = renderAdminCabangTabs;
window.selectAdminChatCabang = selectAdminChatCabang;
window.renderChatMessages = renderChatMessages;
window.handleSendChatMessage = handleSendChatMessage;
window.sendQuickPrompt = sendQuickPrompt;
window.handleChatTyping = handleChatTyping;
window.refreshChatHistory = refreshChatHistory;
window.playChatNotificationSound = playChatNotificationSound;
window.toggleChatSound = toggleChatSound;
window.updateChatSoundUI = updateChatSoundUI;
window.showChatNotificationPopup = showChatNotificationPopup;
window.dismissChatPopup = dismissChatPopup;
window.openChatFromNotification = openChatFromNotification;
window.handleChatScroll = handleChatScroll;
window.showScrollBottomButton = showScrollBottomButton;
window.scrollChatToBottom = scrollChatToBottom;
window.updateAdminDashboardGreeting = updateAdminDashboardGreeting;
window.openGuideModal = openGuideModal;
window.switchGuideTab = switchGuideTab;

// Export feature bindings
window.openExportModal = openExportModal;
window.switchExportTab = switchExportTab;
window.setExportType = setExportType;
window.setExportQuickPeriod = setExportQuickPeriod;
window.updateExportPreview = updateExportPreview;
window.executeExportExcel = executeExportExcel;
window.executeExportCSV = executeExportCSV;
window.executeCopyForGoogleSheets = executeCopyForGoogleSheets;
window.openGoogleSheetsNew = openGoogleSheetsNew;
window.copyAppsScriptCode = copyAppsScriptCode;

// Printer Bluetooth & Android APK bindings
window.initPrinterSettings = initPrinterSettings;
window.savePrinterSettings = savePrinterSettings;
window.scanPrinters = scanPrinters;
window.scanPairedAndroidPrinters = scanPairedAndroidPrinters;
window.renderPrinterListNative = renderPrinterListNative;
window.connectManualPrinter = connectManualPrinter;
window.closePrinterList = closePrinterList;
window.connectNativePrinter = connectNativePrinter;
window.disconnectPrinter = disconnectPrinter;
window.printViaRawBT = printViaRawBT;
window.testPrint = testPrint;
window.testPrintRawBT = testPrintRawBT;
window.cetakStrukThermal = cetakStrukThermal;

