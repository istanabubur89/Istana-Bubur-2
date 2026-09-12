/**
 * ====================================================================
 * GOOGLE APPS SCRIPT (Code.gs) - SISTEM KASIR & MANAJEMEN ISTANA BUBUR
 * ====================================================================
 * 
 * PANDUAN PENYIAPAN DATABASE GOOGLE SPREADSHEET:
 * 1. Buka Google Spreadsheet baru di https://sheets.new
 * 2. Beri nama spreadsheet, contoh: "Database Istana Bubur"
 * 3. Buka menu "Ekstensi" > "Apps Script" (Extensions > Apps Script)
 * 4. Hapus kode default di "Code.gs", lalu tempel seluruh isi file ini.
 * 5. Buat 2 file HTML di Apps Script (ikon '+' di panel kiri > HTML):
 *    a. File "Index.html"      -> tempel kode dari Index.html
 *    b. File "JavaScript.html" -> tempel kode dari JavaScript.html
 * 6. Jalankan fungsi "initAllSheets" satu kali di editor Apps Script 
 *    untuk membuat otomatis semua Sheet (Users, Produk, Transaksi, 
 *    Karyawan, HistoriGaji) beserta header & data awal.
 * 7. Klik "Terapkan" (Deploy) > "Kelola Penerapan Baru" (New Deployment):
 *    - Pilih jenis: "Aplikasi Web" (Web App)
 *    - Jalankan sebagai: "Saya" (Me)
 *    - Siapa yang memiliki akses: "Siapa saja" (Anyone)
 * 8. Salin URL Aplikasi Web yang diberikan dan buka di browser / HP!
 * ====================================================================
 */

// Konstanta Nama Sheet Database
const SHEET_USERS = 'Users';
const SHEET_PRODUK = 'Produk';
const SHEET_TRANSAKSI = 'Transaksi';
const SHEET_KARYAWAN = 'Karyawan';
const SHEET_GAJI = 'HistoriGaji';

// Daftar Kode Autentikasi Resmi Admin Pusat
const MASTER_AUTH_CODES = ['IB-AUTH-2026', 'ADMIN-IB-889', 'IB-PUSAT-99', 'ISTANA-BUBUR-AUTH'];

/**
 * Entry point aplikasi web Google Apps Script
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Istana Bubur - POS & Manajemen')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
}

/**
 * Helper untuk menyertakan file HTML lain (seperti JavaScript.html)
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Helper: Ambil Sheet aktif atau buat otomatis jika belum ada
 */
function getDbSheet(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    initSheetHeaders(sheet, sheetName);
  }
  return sheet;
}

/**
 * Inisialisasi Header untuk masing-masing Sheet
 */
function initSheetHeaders(sheet, sheetName) {
  if (sheetName === SHEET_USERS) {
    sheet.appendRow(['ID', 'Nama Lengkap', 'Username', 'Password', 'Email', 'No WA', 'Role', 'Cabang', 'IsActive', 'AuthCode', 'Tanggal']);
  } else if (sheetName === SHEET_PRODUK) {
    sheet.appendRow(['ID Produk', 'Nama Produk', 'Harga', 'GambarBase64']);
  } else if (sheetName === SHEET_TRANSAKSI) {
    sheet.appendRow(['ID Transaksi', 'Tanggal', 'Cabang', 'Kasir', 'Total Belanja', 'Nama Pelanggan', 'No WA', 'Bayar', 'Kembalian', 'Metode', 'Items JSON']);
  } else if (sheetName === SHEET_KARYAWAN) {
    sheet.appendRow(['ID Karyawan', 'Nama', 'Jenis Kelamin', 'Jabatan', 'Lokasi Cabang', 'No WA', 'Gaji Harian', 'Email']);
  } else if (sheetName === SHEET_GAJI) {
    sheet.appendRow(['ID Slip', 'Nama', 'ID Karyawan', 'Bulan', 'Hari Masuk', 'Gaji Harian', 'Bonus', 'Potongan', 'Total Gaji', 'Cabang', 'Jabatan', 'No WA', 'Keterangan Libur', 'Link PDF']);
  }
}

/**
 * FUNGSI SETUP: Jalankan fungsi ini 1x di editor Apps Script 
 * untuk membuat seluruh sheet dan data awal secara otomatis!
 */
function initAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Sheet Users
  const sUsers = getDbSheet(SHEET_USERS);
  if (sUsers.getLastRow() <= 1) {
    sUsers.appendRow(['USR-001', 'Bapak Hendra (Owner)', 'admin', '123456', 'admin@istanabubur.com', '081234567890', 'Admin', 'Pusat', true, 'IB-AUTH-2026', new Date()]);
    sUsers.appendRow(['USR-002', 'Siti Rahmawati', 'kasir1', '123456', 'kasir1@istanabubur.com', '082198765432', 'Kasir', 'Cabang A', true, 'IB-AUTH-2026', new Date()]);
    sUsers.appendRow(['USR-003', 'Ahmad Fauzi', 'kasir2', '123456', 'kasir2@istanabubur.com', '085211223344', 'Kasir', 'Cabang B', true, 'IB-AUTH-2026', new Date()]);
  }

  // 2. Sheet Produk
  const sProduk = getDbSheet(SHEET_PRODUK);
  if (sProduk.getLastRow() <= 1) {
    sProduk.appendRow(['PRD-001', 'Bubur Ayam Spesial', 15000, '']);
    sProduk.appendRow(['PRD-002', 'Bubur Ayam Komplit (Ati Ampela + Telur)', 20000, '']);
    sProduk.appendRow(['PRD-003', 'Sate Usus Gurih', 3000, '']);
    sProduk.appendRow(['PRD-004', 'Sate Telur Puyuh', 4000, '']);
    sProduk.appendRow(['PRD-005', 'Sate Ati Ampela', 4000, '']);
    sProduk.appendRow(['PRD-006', 'Teh Manis (Hangat / Dingin)', 5000, '']);
    sProduk.appendRow(['PRD-007', 'Jeruk Peras Segar', 7000, '']);
  }

  // 3. Sheet Karyawan
  const sKaryawan = getDbSheet(SHEET_KARYAWAN);
  if (sKaryawan.getLastRow() <= 1) {
    sKaryawan.appendRow(['KRY-001', 'Budi Santoso', 'Laki-laki', 'Kasir', 'Cabang A', '081234567890', 90000, 'budi@istanabubur.com']);
    sKaryawan.appendRow(['KRY-002', 'Siti Rahma', 'Perempuan', 'Dapur Bubur', 'Cabang A', '081298765432', 100000, 'siti@istanabubur.com']);
    sKaryawan.appendRow(['KRY-003', 'Agus Prayogo', 'Laki-laki', 'Driver', 'Pusat', '081345678901', 85000, 'agus@istanabubur.com']);
  }

  // 4. Sheet Transaksi
  getDbSheet(SHEET_TRANSAKSI);

  // 5. Sheet HistoriGaji
  getDbSheet(SHEET_GAJI);

  Logger.log('Semua Sheet Istana Bubur berhasil diinisialisasi!');
  return 'Inisialisasi berhasil!';
}

// ====================================================================
// 1. MANAJEMEN PENGGUNA & AUTENTIKASI
// ====================================================================

function loginUser(usernameOrEmail, password, role) {
  const sheet = getDbSheet(SHEET_USERS);
  const data = sheet.getDataRange().getValues();
  const identity = String(usernameOrEmail || '').trim().toLowerCase();
  const pass = String(password || '').trim();

  if (data.length <= 1) {
    if (identity === 'admin' && pass === '123456') {
      return {
        success: true,
        user: { username: 'admin', fullName: 'Bapak Hendra (Owner)', role: 'Admin', cabang: 'Pusat', email: 'admin@istanabubur.com', phone: '081234567890' }
      };
    }
    return { success: false, message: 'Username atau password salah.' };
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const uName = String(row[2] || '').trim().toLowerCase();
    const uEmail = String(row[4] || '').trim().toLowerCase();
    const uPass = String(row[3] || '').trim();
    const uRole = String(row[6] || '').trim();
    const uActive = (row[8] === true || String(row[8]).toLowerCase() === 'true');

    if (uName === identity || uEmail === identity) {
      if (uPass !== pass) {
        return { success: false, message: 'Password salah. Silakan coba lagi.' };
      }
      if (!uActive) {
        return { 
          success: false, 
          needsActivation: true, 
          username: row[2], 
          message: 'Akun belum diaktifkan! Masukkan kode autentikasi admin.' 
        };
      }
      return {
        success: true,
        user: {
          username: String(row[2]),
          fullName: String(row[1] || row[2]),
          role: uRole || 'Kasir',
          cabang: String(row[7] || 'Pusat'),
          email: String(row[4] || ''),
          phone: String(row[5] || '')
        }
      };
    }
  }

  return { success: false, message: 'Pengguna tidak ditemukan.' };
}

function registerUser(userData) {
  const sheet = getDbSheet(SHEET_USERS);
  const data = sheet.getDataRange().getValues();
  const uname = String(userData.username || '').trim().toLowerCase();
  const email = String(userData.email || '').trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]).trim().toLowerCase() === uname) {
      return { success: false, message: 'Username sudah terdaftar! Pilih username lain.' };
    }
    if (email && String(data[i][4]).trim().toLowerCase() === email) {
      return { success: false, message: 'Email sudah terdaftar! Gunakan email lain.' };
    }
  }

  const newId = 'USR-' + String(data.length).padStart(3, '0');
  sheet.appendRow([
    newId,
    userData.fullName || userData.username,
    userData.username,
    userData.password,
    userData.email || '',
    userData.phone || '',
    userData.role || 'Kasir',
    userData.cabang || 'Cabang A',
    userData.isActive === true,
    userData.authCode || '',
    new Date()
  ]);

  return { success: true, message: 'Pendaftaran berhasil! Silakan login.' };
}

function verifyAdminAuthCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (MASTER_AUTH_CODES.includes(c)) {
    return { success: true, message: 'Kode autentikasi valid.' };
  }
  return { success: false, message: 'Kode autentikasi tidak valid.' };
}

function resetUserPassword(usernameOrEmail, newPass) {
  const sheet = getDbSheet(SHEET_USERS);
  const data = sheet.getDataRange().getValues();
  const identity = String(usernameOrEmail || '').trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    const uName = String(data[i][2]).trim().toLowerCase();
    const uEmail = String(data[i][4]).trim().toLowerCase();
    if (uName === identity || uEmail === identity) {
      sheet.getRange(i + 1, 4).setValue(String(newPass).trim());
      return { success: true, message: 'Password berhasil direset. Silakan login kembali.' };
    }
  }
  return { success: false, message: 'Pengguna tidak ditemukan.' };
}

// ====================================================================
// 2. PRODUK & MENU KASIR
// ====================================================================

function getProduk() {
  const sheet = getDbSheet(SHEET_PRODUK);
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] && !row[1]) continue;
    list.push({
      rowIndex: i + 1,
      'ID Produk': String(row[0] || ('PRD-' + String(i).padStart(3, '0'))),
      'Nama Produk': String(row[1] || ''),
      'Harga': Number(row[2] || 0),
      'GambarBase64': String(row[3] || '')
    });
  }
  return list;
}

function saveProduk(pData) {
  const sheet = getDbSheet(SHEET_PRODUK);
  if (pData.rowIndex) {
    const row = Number(pData.rowIndex);
    sheet.getRange(row, 2).setValue(pData.nama);
    sheet.getRange(row, 3).setValue(Number(pData.harga));
    if (pData.gambar !== undefined) {
      sheet.getRange(row, 4).setValue(pData.gambar || '');
    }
  } else {
    const lastRow = sheet.getLastRow();
    const id = 'PRD-' + String(lastRow).padStart(3, '0');
    sheet.appendRow([id, pData.nama, Number(pData.harga), pData.gambar || '']);
  }
  return { success: true, message: 'Produk berhasil disimpan ke database.' };
}

function deleteProduk(rowIndex) {
  const sheet = getDbSheet(SHEET_PRODUK);
  const row = Number(rowIndex);
  if (row > 1 && row <= sheet.getLastRow()) {
    sheet.deleteRow(row);
    return { success: true, message: 'Produk berhasil dihapus.' };
  }
  return { success: false, message: 'Baris produk tidak ditemukan.' };
}

// ====================================================================
// 3. DATA KARYAWAN
// ====================================================================

function getKaryawan() {
  const sheet = getDbSheet(SHEET_KARYAWAN);
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0] && !row[1]) continue;
    list.push({
      rowIndex: i + 1,
      'ID Karyawan': String(row[0]),
      'Nama': String(row[1] || ''),
      'Jenis Kelamin': String(row[2] || 'Laki-laki'),
      'Jabatan': String(row[3] || '-'),
      'Lokasi Cabang': String(row[4] || 'Pusat'),
      'No WA': String(row[5] || ''),
      'Gaji Harian': Number(row[6] || 0),
      'Email': String(row[7] || '')
    });
  }
  return list;
}

function saveKaryawan(kData) {
  const sheet = getDbSheet(SHEET_KARYAWAN);
  if (kData.rowIndex) {
    const row = Number(kData.rowIndex);
    sheet.getRange(row, 2).setValue(kData['Nama']);
    sheet.getRange(row, 3).setValue(kData['Jenis Kelamin'] || 'Laki-laki');
    sheet.getRange(row, 4).setValue(kData['Jabatan'] || '-');
    sheet.getRange(row, 5).setValue(kData['Lokasi Cabang'] || 'Pusat');
    sheet.getRange(row, 6).setValue(kData['No WA'] || '');
    sheet.getRange(row, 7).setValue(Number(kData['Gaji Harian'] || 0));
    sheet.getRange(row, 8).setValue(kData['Email'] || '');
  } else {
    const lastRow = sheet.getLastRow();
    const id = 'KRY-' + String(lastRow).padStart(3, '0');
    sheet.appendRow([
      id,
      kData['Nama'],
      kData['Jenis Kelamin'] || 'Laki-laki',
      kData['Jabatan'] || '-',
      kData['Lokasi Cabang'] || 'Pusat',
      kData['No WA'] || '',
      Number(kData['Gaji Harian'] || 0),
      kData['Email'] || ''
    ]);
  }
  return { success: true, message: 'Data karyawan berhasil disimpan.' };
}

function deleteKaryawan(rowIndex) {
  const sheet = getDbSheet(SHEET_KARYAWAN);
  const row = Number(rowIndex);
  if (row > 1 && row <= sheet.getLastRow()) {
    sheet.deleteRow(row);
    return { success: true, message: 'Data karyawan berhasil dihapus.' };
  }
  return { success: false, message: 'Baris karyawan tidak ditemukan.' };
}

// ====================================================================
// 4. TRANSAKSI KASIR
// ====================================================================

function getHistoriTransaksi() {
  const sheet = getDbSheet(SHEET_TRANSAKSI);
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    list.push({
      'ID Transaksi': String(row[0]),
      'Tanggal': String(row[1] || ''),
      'Cabang': String(row[2] || 'Pusat'),
      'Kasir': String(row[3] || 'Kasir'),
      'Total Belanja': Number(row[4] || 0),
      'Nama Pelanggan': String(row[5] || 'Umum'),
      'No WA': String(row[6] || ''),
      'Bayar': Number(row[7] || row[4] || 0),
      'Kembalian': Number(row[8] || 0),
      'Metode': String(row[9] || 'Cash'),
      'Items JSON': typeof row[10] === 'string' ? row[10] : JSON.stringify(row[10] || [])
    });
  }
  return list.reverse(); // Transaksi terbaru di atas
}

function processTransaksiKasir(trx) {
  const sheet = getDbSheet(SHEET_TRANSAKSI);
  const trxId = 'TRX-' + Math.floor(100000 + Math.random() * 900000);
  
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tanggalFormatted = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  
  const namaPelangganLengkap = `${trx.namaPelanggan || 'Umum'} [${trx.jenis || 'Dine In'}${trx.keterangan ? ' - ' + trx.keterangan : ''}]`;
  const itemsJson = typeof trx.items === 'string' ? trx.items : JSON.stringify(trx.items || []);

  sheet.appendRow([
    trxId,
    tanggalFormatted,
    trx.cabang || 'Pusat',
    trx.kasir || 'Kasir',
    Number(trx.total || 0),
    namaPelangganLengkap,
    trx.wa || '',
    Number(trx.bayar || trx.total || 0),
    Number(trx.kembali || 0),
    trx.metode || 'Cash',
    itemsJson
  ]);

  return {
    success: true,
    idTrx: trxId,
    message: 'Transaksi kasir berhasil dicatat di Spreadsheet!'
  };
}

function deleteTransaksi(idTrx) {
  const sheet = getDbSheet(SHEET_TRANSAKSI);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(idTrx)) {
      sheet.deleteRow(i + 1);
      return { success: true, message: `Transaksi #${idTrx} berhasil dihapus dari Spreadsheet.` };
    }
  }
  return { success: false, message: 'Transaksi tidak ditemukan.' };
}

// ====================================================================
// 5. PENGGAJIAN & SLIP GAJI
// ====================================================================

function getHistori() {
  const sheet = getDbSheet(SHEET_GAJI);
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    list.push({
      'ID Slip': String(row[0]),
      'Nama': String(row[1] || ''),
      'ID Karyawan': String(row[2] || ''),
      'Bulan': String(row[3] || ''),
      'Hari Masuk': Number(row[4] || 0),
      'Gaji Harian': Number(row[5] || 0),
      'Bonus': Number(row[6] || 0),
      'Potongan': Number(row[7] || 0),
      'Total Gaji': Number(row[8] || 0),
      'Cabang': String(row[9] || 'Pusat'),
      'Jabatan': String(row[10] || '-'),
      'No WA': String(row[11] || ''),
      'Keterangan Libur': String(row[12] || ''),
      'Link PDF': String(row[13] || '#')
    });
  }
  return list.reverse();
}

function processSlipGaji(sData) {
  const sheet = getDbSheet(SHEET_GAJI);
  const slipId = 'SLIP-' + Math.floor(100000 + Math.random() * 900000);
  
  const harian = Number(sData.gajiHarian || 0);
  const hari = Number(sData.hariMasuk || 0);
  const bonus = Number(sData.bonus || 0);
  const potongan = Number(sData.potongan || 0);
  const totalGaji = (harian * hari) + bonus - potongan;

  sheet.appendRow([
    slipId,
    sData.nama || '',
    sData.id || '',
    sData.bulan || '',
    hari,
    harian,
    bonus,
    potongan,
    totalGaji,
    sData.cabang || 'Pusat',
    sData.jabatan || '-',
    sData.wa || '',
    sData.keteranganLibur || '',
    '#'
  ]);

  return {
    success: true,
    idSlip: slipId,
    message: 'Slip gaji berhasil diproses dan dicatat di Spreadsheet!',
    pdfUrl: '#',
    waLink: '#'
  };
}

function deleteHistoriGaji(target) {
  const sheet = getDbSheet(SHEET_GAJI);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const slipId = String(data[i][0]);
    if (slipId === String(target)) {
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Riwayat slip gaji berhasil dihapus.' };
    }
  }

  // Jika target berupa indeks numerik
  if (typeof target === 'number' || !isNaN(Number(target))) {
    const rowIdx = Number(target);
    if (rowIdx >= 0 && rowIdx < data.length - 1) {
      // Data terbalik pada tampilan frontend
      const actualRow = data.length - rowIdx;
      sheet.deleteRow(actualRow);
      return { success: true, message: 'Riwayat slip gaji berhasil dihapus.' };
    }
  }

  return { success: false, message: 'Data slip gaji tidak ditemukan.' };
}
