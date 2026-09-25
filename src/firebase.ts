/**
 * Firebase Firestore Integration for Istana Bubur POS & Management
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  enableIndexedDbPersistence
} from 'firebase/firestore';

export const firebaseConfig = {
  projectId: "gen-lang-client-0004446574",
  appId: "1:1029760704961:web:579fa951802ced68558f40",
  apiKey: "AIzaSyCHRUsF6MVa-cXYVyqadGuSCOlaK0Qf9mc",
  authDomain: "gen-lang-client-0004446574.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-istanabubur-4840979b-eb04-419d-b020-ec08e9c46b4c",
  storageBucket: "gen-lang-client-0004446574.firebasestorage.app",
  messagingSenderId: "1029760704961"
};

// Initialize Firebase App
export const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore with specific Database ID
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Enable offline persistence if available
if (typeof window !== 'undefined') {
  try {
    enableIndexedDbPersistence(db).catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('[Firestore] Multiple tabs open, persistence disabled');
      } else if (err.code === 'unimplemented') {
        console.warn('[Firestore] Browser does not support persistence');
      }
    });
  } catch (e) {
    // Ignore if not supported in current environment
  }
}

// Collection Names
export const COLLECTIONS = {
  USERS: 'users',
  PRODUCTS: 'products',
  TRANSACTIONS: 'transactions',
  EMPLOYEES: 'employees',
  PAYROLL: 'payroll',
  DOCUMENTS: 'documents',
  BRANCHES: 'branches',
  REFERRAL_CODES: 'referralCodes',
  ADMIN_CONVERSATIONS: 'admin_conversations',
  ADMIN_CHATS: 'admin_chats',
  GROUP_MESSAGES: 'group_messages'
};

// Helper: Seed Default Data if collections are empty (hanya data dasar tanpa dummy cabang A, B, C)
export async function seedInitialFirestoreData() {
  try {
    // 1. Bersihkan dummy users lama kasir1 / kasir2 / cabang A, B, C jika ada
    try {
      const dummyK1 = doc(db, COLLECTIONS.USERS, 'kasir1');
      const dummyK2 = doc(db, COLLECTIONS.USERS, 'kasir2');
      const snapK1 = await getDoc(dummyK1);
      if (snapK1.exists()) {
        await deleteDoc(dummyK1);
      }
      const snapK2 = await getDoc(dummyK2);
      if (snapK2.exists()) {
        await deleteDoc(dummyK2);
      }
    } catch (e) {}

    // 2. Check & Seed Products
    const prodSnap = await getDocs(collection(db, COLLECTIONS.PRODUCTS));
    if (prodSnap.empty) {
      const defaultProducts = [
        { id: 'PRD-001', nama: 'Bubur Ayam Spesial', harga: 15000, gambar: '', kategori: 'Makanan' },
        { id: 'PRD-002', nama: 'Bubur Ayam Komplit (Ati Ampela + Telur)', harga: 20000, gambar: '', kategori: 'Makanan' },
        { id: 'PRD-003', nama: 'Sate Usus Gurih', harga: 3000, gambar: '', kategori: 'Topping' },
        { id: 'PRD-004', nama: 'Sate Telur Puyuh', harga: 4000, gambar: '', kategori: 'Topping' },
        { id: 'PRD-005', nama: 'Sate Ati Ampela', harga: 4000, gambar: '', kategori: 'Topping' },
        { id: 'PRD-006', nama: 'Teh Manis (Hangat / Dingin)', harga: 5000, gambar: '', kategori: 'Minuman' },
        { id: 'PRD-007', nama: 'Jeruk Peras Segar', harga: 7000, gambar: '', kategori: 'Minuman' }
      ];
      for (const p of defaultProducts) {
        await setDoc(doc(db, COLLECTIONS.PRODUCTS, p.id), p);
      }
      console.log('[Firestore] Default Products seeded successfully');
    }

    // 3. Check & Seed Employees
    const empSnap = await getDocs(collection(db, COLLECTIONS.EMPLOYEES));
    if (empSnap.empty) {
      const defaultEmployees = [
        {
          id: 'KRY-001',
          nama: 'Budi Santoso',
          gender: 'Laki-laki',
          posisi: 'Kasir',
          cabang: 'Pusat',
          noWa: '081234567890',
          gajiHarian: 90000,
          email: 'budi@istanabubur.com'
        },
        {
          id: 'KRY-002',
          nama: 'Siti Rahma',
          gender: 'Perempuan',
          posisi: 'Dapur Bubur',
          cabang: 'Pusat',
          noWa: '081298765432',
          gajiHarian: 100000,
          email: 'siti@istanabubur.com'
        },
        {
          id: 'KRY-003',
          nama: 'Agus Prayogo',
          gender: 'Laki-laki',
          posisi: 'Driver',
          cabang: 'Pusat',
          noWa: '081345678901',
          gajiHarian: 85000,
          email: 'agus@istanabubur.com'
        }
      ];
      for (const e of defaultEmployees) {
        await setDoc(doc(db, COLLECTIONS.EMPLOYEES, e.id), e);
      }
      console.log('[Firestore] Default Employees seeded successfully');
    }

    // 4. Check & Seed Branches (Sempajak & M Yamin)
    const branchSnap = await getDocs(collection(db, COLLECTIONS.BRANCHES));
    if (branchSnap.empty) {
      const defaultBranches = [
        { id: 'sempajak', name: 'Sempajak', createdAt: Date.now() },
        { id: 'm_yamin', name: 'M Yamin', createdAt: Date.now() }
      ];
      for (const b of defaultBranches) {
        await setDoc(doc(db, COLLECTIONS.BRANCHES, b.id), b);
      }
      console.log('[Firestore] Default Branches (Sempajak, M Yamin) seeded successfully');
    }
  } catch (err) {
    console.warn('[Firestore Seed Warning]:', err);
  }
}

// -------------------------------------------------------------
// USER / AUTH FUNCTIONS
// -------------------------------------------------------------
export async function firestoreLogin(identity: string, pass: string, requestedRole?: string) {
  const normIdentity = String(identity || '').trim().toLowerCase();
  
  // Try direct username lookup
  const userDoc = await getDoc(doc(db, COLLECTIONS.USERS, normIdentity));
  let matchedUser: any = null;

  if (userDoc.exists()) {
    matchedUser = userDoc.data();
  } else {
    // Search by email
    const snap = await getDocs(collection(db, COLLECTIONS.USERS));
    for (const d of snap.docs) {
      const u = d.data();
      if ((u.email && u.email.toLowerCase() === normIdentity) || (u.username && u.username.toLowerCase() === normIdentity)) {
        matchedUser = u;
        break;
      }
    }
  }

  if (!matchedUser) {
    return { success: false, message: 'Pengguna tidak ditemukan di database Cloud Firestore.' };
  }

  // Validasi role berdasarkan data akun yang tersimpan di database
  const userRoleNorm = String(matchedUser.role || '').trim().toLowerCase();
  const reqRoleNorm = String(requestedRole || '').trim().toLowerCase();

  if (reqRoleNorm && userRoleNorm !== reqRoleNorm) {
    if (userRoleNorm === 'admin') {
      return {
        success: false,
        message: 'Akun Anda terdaftar sebagai Admin. Silakan gunakan Login Admin.'
      };
    } else if (userRoleNorm === 'kasir') {
      return {
        success: false,
        message: 'Akun Anda terdaftar sebagai Kasir. Silakan gunakan Login Kasir.'
      };
    } else {
      return {
        success: false,
        message: `Akun Anda terdaftar sebagai ${matchedUser.role}. Silakan gunakan Login ${matchedUser.role}.`
      };
    }
  }

  if (matchedUser.password !== pass) {
    return { success: false, message: 'Password salah. Silakan periksa kembali.' };
  }

  if (matchedUser.isActive === false) {
    return {
      success: false,
      needsActivation: true,
      username: matchedUser.username,
      message: 'Akun belum aktif! Anda wajib memasukkan Kode Autentikasi Admin.'
    };
  }

  return {
    success: true,
    user: {
      username: matchedUser.username,
      fullName: matchedUser.fullName || matchedUser.username,
      role: matchedUser.role,
      cabang: matchedUser.cabang || (matchedUser.role === 'Admin' ? 'Pusat' : 'Cabang A'),
      email: matchedUser.email || '',
      phone: matchedUser.phone || ''
    }
  };
}

export async function firestoreCheckUserExists(username: string, email?: string) {
  try {
    const uname = String(username || '').trim().toLowerCase();
    const existing = await getDoc(doc(db, COLLECTIONS.USERS, uname));
    if (existing.exists()) {
      return { exists: true, message: 'Username sudah terdaftar di Cloud Firestore. Silakan gunakan username lain.' };
    }
    if (email) {
      const snap = await getDocs(collection(db, COLLECTIONS.USERS));
      for (const d of snap.docs) {
        const u = d.data();
        if (u.email && u.email.toLowerCase() === email.trim().toLowerCase()) {
          return { exists: true, message: 'Email sudah terdaftar di Cloud Firestore. Silakan gunakan menu Lupa Password atau login.' };
        }
      }
    }
  } catch (err) {
    console.warn('[Firestore Check User Warning]:', err);
  }
  return { exists: false };
}

export async function firestoreRegister(userData: any) {
  const uname = String(userData.username || '').trim().toLowerCase();
  const existing = await getDoc(doc(db, COLLECTIONS.USERS, uname));
  if (existing.exists()) {
    return { success: false, message: 'Username sudah terdaftar di Firestore. Gunakan username lain.' };
  }

  const newId = 'USR-' + Math.floor(100 + Math.random() * 900);
  const record = {
    id: newId,
    fullName: userData.fullName || userData.username,
    username: userData.username,
    password: userData.password,
    email: userData.email || '',
    phone: userData.phone || '',
    role: userData.role || 'Kasir',
    cabang: userData.cabang || 'Cabang A',
    isActive: userData.isActive ?? true,
    authCode: userData.authCode || '',
    createdAt: new Date().toISOString()
  };

  await setDoc(doc(db, COLLECTIONS.USERS, uname), record);
  return { success: true, message: 'Pendaftaran akun berhasil disimpan ke Cloud Firestore.' };
}

export async function firestoreResetPassword(usernameOrEmail: string, newPass: string) {
  const normIdentity = String(usernameOrEmail || '').trim().toLowerCase();
  if (!normIdentity) return { success: false, message: 'Identitas akun wajib diisi.' };

  const userDoc = await getDoc(doc(db, COLLECTIONS.USERS, normIdentity));
  if (userDoc.exists()) {
    await setDoc(doc(db, COLLECTIONS.USERS, normIdentity), { password: newPass, updatedAt: new Date().toISOString() }, { merge: true });
    return { success: true, message: 'Password berhasil diperbarui di Cloud Firestore.' };
  }

  const snap = await getDocs(collection(db, COLLECTIONS.USERS));
  for (const d of snap.docs) {
    const u = d.data();
    if (
      (u.email && u.email.trim().toLowerCase() === normIdentity) ||
      (u.username && u.username.trim().toLowerCase() === normIdentity) ||
      (d.id && d.id.trim().toLowerCase() === normIdentity)
    ) {
      await setDoc(doc(db, COLLECTIONS.USERS, d.id), { password: newPass, updatedAt: new Date().toISOString() }, { merge: true });
      return { success: true, message: 'Password berhasil diperbarui di Cloud Firestore.' };
    }
  }

  return { success: false, message: 'Akun tidak ditemukan di database.' };
}

export async function firestoreFindUserByEmail(email: string) {
  const normEmail = String(email || '').trim().toLowerCase();
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.USERS));
    for (const d of snap.docs) {
      const u = d.data();
      if (u.email && u.email.trim().toLowerCase() === normEmail) {
        return {
          success: true,
          user: {
            username: u.username,
            fullName: u.fullName || u.username,
            email: u.email,
            phone: u.phone || '',
            role: u.role || 'Kasir',
            cabang: u.cabang || 'Cabang Utama'
          }
        };
      }
    }
  } catch (err) {
    console.warn('[firestoreFindUserByEmail Warning]:', err);
  }
  return { success: false, message: 'Email tidak ditemukan di database Cloud Firestore.' };
}

export async function firestoreFindUserByIdentity(identity: string) {
  const norm = String(identity || '').trim().toLowerCase();
  try {
    const userDoc = await getDoc(doc(db, COLLECTIONS.USERS, norm));
    if (userDoc.exists()) {
      const u = userDoc.data();
      return {
        success: true,
        user: {
          username: u.username,
          fullName: u.fullName || u.username,
          email: u.email || '',
          phone: u.phone || '',
          role: u.role || 'Kasir',
          cabang: u.cabang || 'Cabang Utama'
        }
      };
    }

    const snap = await getDocs(collection(db, COLLECTIONS.USERS));
    for (const d of snap.docs) {
      const u = d.data();
      if ((u.email && u.email.trim().toLowerCase() === norm) || (u.username && u.username.trim().toLowerCase() === norm)) {
        return {
          success: true,
          user: {
            username: u.username,
            fullName: u.fullName || u.username,
            email: u.email || '',
            phone: u.phone || '',
            role: u.role || 'Kasir',
            cabang: u.cabang || 'Cabang Utama'
          }
        };
      }
    }
  } catch (err) {
    console.warn('[firestoreFindUserByIdentity Warning]:', err);
  }
  return { success: false, message: 'Akun tidak ditemukan di database Cloud Firestore.' };
}

// -------------------------------------------------------------
// PRODUCT FUNCTIONS
// -------------------------------------------------------------
function inferKategori(nama: string = ''): string {
  const n = (nama || '').toLowerCase();
  if (n.includes('ongkir') || n.includes('kirim') || n.includes('kurir') || n.includes('antar') || n.includes('delivery')) return 'Ongkir';
  if (n.includes('teh') || n.includes('jeruk') || n.includes('kopi') || n.includes('jus') || n.includes('es ') || n.includes('air') || n.includes('minum')) return 'Minuman';
  if (n.includes('kue') || n.includes('sate') || n.includes('roti') || n.includes('gorengan') || n.includes('snack') || n.includes('kerupuk') || n.includes('emping')) return 'Kue';
  return 'Bubur';
}

export async function firestoreGetProduk() {
  const snap = await getDocs(collection(db, COLLECTIONS.PRODUCTS));
  const list: any[] = [];
  let index = 1;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    const kategori = data.kategori || inferKategori(data.nama);
    list.push({
      rowIndex: index++,
      'ID Produk': data.id || docSnap.id,
      'Nama Produk': data.nama || '',
      'Harga': Number(data.harga || 0),
      'Kategori': kategori,
      'GambarBase64': data.gambar || '',
      _docId: docSnap.id
    });
  });
  return list;
}

export async function firestoreSaveProduk(pData: any) {
  let docId = pData['ID Produk'] || pData.id;
  if (!docId) {
    docId = 'PRD-' + Math.floor(100 + Math.random() * 900);
  }

  const nama = pData.nama || pData['Nama Produk'] || '';
  const kategori = pData.kategori || pData['Kategori'] || inferKategori(nama);

  const payload: any = {
    id: docId,
    nama: nama,
    harga: Number(pData.harga || pData['Harga'] || 0),
    kategori: kategori,
    gambar: pData.gambar !== undefined ? pData.gambar : (pData['GambarBase64'] || ''),
    updatedAt: new Date().toISOString()
  };

  await setDoc(doc(db, COLLECTIONS.PRODUCTS, docId), payload, { merge: true });
  return { success: true, message: 'Produk berhasil disimpan ke Cloud Firestore.' };
}

export async function firestoreDeleteProduk(productIdOrDocId: string) {
  if (!productIdOrDocId) return { success: false, message: 'ID produk tidak valid' };
  // Check if doc exists with this id
  const targetDoc = doc(db, COLLECTIONS.PRODUCTS, productIdOrDocId);
  const snap = await getDoc(targetDoc);
  if (snap.exists()) {
    await deleteDoc(targetDoc);
    return { success: true, message: 'Produk berhasil dihapus dari Cloud Firestore.' };
  }

  // Fallback: search by id field
  const allSnap = await getDocs(collection(db, COLLECTIONS.PRODUCTS));
  for (const d of allSnap.docs) {
    if (d.data().id === productIdOrDocId || d.id === productIdOrDocId) {
      await deleteDoc(doc(db, COLLECTIONS.PRODUCTS, d.id));
      return { success: true, message: 'Produk berhasil dihapus dari Cloud Firestore.' };
    }
  }

  return { success: false, message: 'Produk tidak ditemukan.' };
}

// -------------------------------------------------------------
// EMPLOYEE FUNCTIONS
// -------------------------------------------------------------
export async function firestoreGetKaryawan() {
  const snap = await getDocs(collection(db, COLLECTIONS.EMPLOYEES));
  const list: any[] = [];
  let index = 1;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    list.push({
      rowIndex: index++,
      'ID Karyawan': data.id || docSnap.id,
      'Nama': data.nama || '',
      'Jenis Kelamin': data.gender || 'Laki-laki',
      'Jabatan': data.posisi || '-',
      'Lokasi Cabang': data.cabang || 'Pusat',
      'No WA': data.noWa || '',
      'Gaji Harian': Number(data.gajiHarian || 0),
      'Email': data.email || '',
      _docId: docSnap.id
    });
  });
  return list;
}

export async function firestoreSaveKaryawan(kData: any) {
  let docId = kData['ID Karyawan'] || kData.id;
  if (!docId) {
    docId = 'KRY-' + Math.floor(100 + Math.random() * 900);
  }

  const payload = {
    id: docId,
    nama: kData['Nama'] || kData.nama || '',
    gender: kData['Jenis Kelamin'] || kData.gender || 'Laki-laki',
    posisi: kData['Jabatan'] || kData.posisi || '-',
    cabang: kData['Lokasi Cabang'] || kData.cabang || 'Pusat',
    noWa: kData['No WA'] || kData.noWa || '',
    gajiHarian: Number(kData['Gaji Harian'] || kData.gajiHarian || 0),
    email: kData['Email'] || kData.email || ''
  };

  await setDoc(doc(db, COLLECTIONS.EMPLOYEES, docId), payload, { merge: true });
  return { success: true, message: 'Data karyawan berhasil disimpan ke Cloud Firestore.' };
}

export async function firestoreDeleteKaryawan(empId: string) {
  const targetDoc = doc(db, COLLECTIONS.EMPLOYEES, empId);
  const snap = await getDoc(targetDoc);
  if (snap.exists()) {
    await deleteDoc(targetDoc);
    return { success: true, message: 'Data karyawan berhasil dihapus dari Cloud Firestore.' };
  }

  const allSnap = await getDocs(collection(db, COLLECTIONS.EMPLOYEES));
  for (const d of allSnap.docs) {
    if (d.data().id === empId) {
      await deleteDoc(doc(db, COLLECTIONS.EMPLOYEES, d.id));
      return { success: true, message: 'Data karyawan berhasil dihapus dari Cloud Firestore.' };
    }
  }

  return { success: false, message: 'Karyawan tidak ditemukan.' };
}

// -------------------------------------------------------------
// TRANSACTIONS FUNCTIONS
// -------------------------------------------------------------
export async function firestoreGetHistoriTransaksi() {
  const snap = await getDocs(collection(db, COLLECTIONS.TRANSACTIONS));
  const list: any[] = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    list.push({
      'ID Transaksi': data.id || docSnap.id,
      'Tanggal': data.tanggal || '',
      'Cabang': data.cabang || 'Sempajak',
      'Kasir': data.kasir || 'Kasir',
      'Total Belanja': Number(data.total || 0),
      'Nama Pelanggan': data.namaPelanggan || 'Umum',
      'No WA': data.noWa || '',
      'Bayar': Number(data.bayar || data.total || 0),
      'Kembalian': Number(data.kembalian || 0),
      'Metode': data.metode || 'Cash',
      'Items JSON': typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
      'Link PDF': data.linkPdf || '#',
      _timestamp: data.createdAt || 0
    });
  });

  // Sort newest first
  return list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
}

export async function firestoreProcessTransaksiKasir(trx: any) {
  const trxId = trx.id || ('TRX-' + Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tanggalFormatted = trx.tanggal || `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  
  const namaPelanggan = `${trx.namaPelanggan || 'Umum'} [${trx.jenis || 'Dine In'}${trx.keterangan ? ' - ' + trx.keterangan : ''}]`;
  const itemsJson = typeof trx.items === 'string' ? trx.items : JSON.stringify(trx.items || []);

  const payload = {
    id: trxId,
    tanggal: tanggalFormatted,
    cabang: trx.cabang || 'Sempajak',
    kasir: trx.kasir || 'Kasir',
    total: Number(trx.total || 0),
    namaPelanggan: namaPelanggan,
    noWa: trx.wa || '',
    bayar: Number(trx.bayar || trx.total || 0),
    kembalian: Number(trx.kembali || 0),
    metode: trx.metode || 'Cash',
    items: itemsJson,
    linkPdf: (trx.linkPdf && trx.linkPdf !== '#') ? trx.linkPdf : `https://istana-bubur-2.vercel.app/?doc=nota-${trxId}&download=1`,
    createdAt: Date.now()
  };

  await setDoc(doc(db, COLLECTIONS.TRANSACTIONS, trxId), payload);

  return {
    success: true,
    idTrx: trxId,
    message: 'Transaksi kasir berhasil dicatat & disinkronkan ke Cloud Firestore!'
  };
}

export async function firestoreDeleteTransaksi(trxId: string) {
  const targetDoc = doc(db, COLLECTIONS.TRANSACTIONS, trxId);
  await deleteDoc(targetDoc);
  return { success: true, message: `Transaksi #${trxId} berhasil dihapus dari Cloud Firestore.` };
}

export async function firestoreUpdateTransaksiPdfLink(trxId: string, linkPdf: string) {
  try {
    const cleanId = String(trxId).trim();
    const targetDoc = doc(db, COLLECTIONS.TRANSACTIONS, cleanId);
    await updateDoc(targetDoc, {
      linkPdf: linkPdf,
      updatedAt: Date.now()
    });
    return { success: true };
  } catch(err) {
    console.warn(`[firestoreUpdateTransaksiPdfLink error for ${trxId}]:`, err);
    return { success: false, error: err };
  }
}

// -------------------------------------------------------------
// PAYROLL FUNCTIONS
// -------------------------------------------------------------
export async function firestoreGetHistoriGaji() {
  const snap = await getDocs(collection(db, COLLECTIONS.PAYROLL));
  const list: any[] = [];
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    list.push({
      'ID Slip': data.id || docSnap.id,
      'ID Gaji': data.id || docSnap.id,
      'id': data.id || docSnap.id,
      'Nama': data.nama || '',
      'ID Karyawan': data.employeeId || '',
      'Bulan': data.bulan || '',
      'Hari Masuk': Number(data.hariMasuk || 0),
      'Gaji Harian': Number(data.gajiHarian || 0),
      'Bonus': Number(data.bonus || 0),
      'Potongan': Number(data.potongan || 0),
      'Total Gaji': Number(data.totalGaji || 0),
      'Cabang': data.cabang || 'Pusat',
      'Jabatan': data.jabatan || '-',
      'No WA': data.noWa || '',
      'Keterangan Libur': data.keteranganLibur || '',
      'Link PDF': data.linkPdf || '#',
      _timestamp: data.createdAt || 0
    });
  });

  return list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
}

export async function firestoreProcessSlipGaji(sData: any) {
  const slipId = 'SLIP-' + Math.floor(100000 + Math.random() * 900000);
  const harian = Number(sData.gajiHarian || 0);
  const hari = Number(sData.hariMasuk || 0);
  const bonus = Number(sData.bonus || 0);
  const potongan = Number(sData.potongan || 0);
  const totalGaji = (harian * hari) + bonus - potongan;

  const payload = {
    id: slipId,
    nama: sData.nama || '',
    employeeId: sData.id || '',
    bulan: sData.bulan || '',
    hariMasuk: hari,
    gajiHarian: harian,
    bonus: bonus,
    potongan: potongan,
    totalGaji: totalGaji,
    cabang: sData.cabang || 'Pusat',
    jabatan: sData.jabatan || '-',
    noWa: sData.wa || '',
    keteranganLibur: sData.keteranganLibur || '',
    linkPdf: (sData.linkPdf && sData.linkPdf !== '#') ? sData.linkPdf : `https://istana-bubur-2.vercel.app/?doc=slip-${slipId}&download=1`,
    createdAt: Date.now()
  };

  await setDoc(doc(db, COLLECTIONS.PAYROLL, slipId), payload);

  const finalPdfUrl = payload.linkPdf;

  return {
    success: true,
    idSlip: slipId,
    message: 'Slip gaji berhasil diproses & disimpan di Cloud Firestore!',
    pdfUrl: finalPdfUrl,
    waLink: '#'
  };
}

export async function firestoreDeleteHistoriGaji(slipId: string) {
  const targetDoc = doc(db, COLLECTIONS.PAYROLL, slipId);
  await deleteDoc(targetDoc);
  return { success: true, message: 'Riwayat slip gaji berhasil dihapus dari Cloud Firestore.' };
}

export async function firestoreUpdateSlipPdfLink(slipId: string, linkPdf: string) {
  try {
    const cleanId = String(slipId).trim();
    const targetDoc = doc(db, COLLECTIONS.PAYROLL, cleanId);
    await updateDoc(targetDoc, {
      linkPdf: linkPdf,
      updatedAt: Date.now()
    });
    return { success: true };
  } catch(err) {
    console.warn(`[firestoreUpdateSlipPdfLink error for ${slipId}]:`, err);
    return { success: false, error: err };
  }
}

// -------------------------------------------------------------
// REALTIME LISTENERS
// -------------------------------------------------------------
export function subscribeToPayroll(callback: (payrollList: any[]) => void): () => void {
  const q = collection(db, COLLECTIONS.PAYROLL);
  return onSnapshot(q, (snapshot) => {
    const list: any[] = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      list.push({
        'ID Slip': data.id || docSnap.id,
        'ID Gaji': data.id || docSnap.id,
        'id': data.id || docSnap.id,
        'Nama': data.nama || '',
        'ID Karyawan': data.employeeId || '',
        'Bulan': data.bulan || '',
        'Hari Masuk': Number(data.hariMasuk || 0),
        'Gaji Harian': Number(data.gajiHarian || 0),
        'Bonus': Number(data.bonus || 0),
        'Potongan': Number(data.potongan || 0),
        'Total Gaji': Number(data.totalGaji || 0),
        'Cabang': data.cabang || 'Pusat',
        'Jabatan': data.jabatan || '-',
        'No WA': data.noWa || '',
        'Keterangan Libur': data.keteranganLibur || '',
        'Link PDF': data.linkPdf || '#',
        _timestamp: data.createdAt || 0
      });
    });
    list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
    callback(list);
  }, (err) => {
    console.warn('[Firestore Payroll Listener Warning]:', err);
  });
}

// -------------------------------------------------------------
// REALTIME LISTENERS
// -------------------------------------------------------------
export function subscribeToTransactions(callback: (transactions: any[]) => void): () => void {
  const q = collection(db, COLLECTIONS.TRANSACTIONS);
  return onSnapshot(q, (snapshot) => {
    const list: any[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      list.push({
        'ID Transaksi': data.id || d.id,
        'Tanggal': data.tanggal || '',
        'Cabang': data.cabang || 'Sempajak',
        'Kasir': data.kasir || 'Kasir',
        'Total Belanja': Number(data.total || 0),
        'Nama Pelanggan': data.namaPelanggan || 'Umum',
        'No WA': data.noWa || '',
        'Bayar': Number(data.bayar || data.total || 0),
        'Kembalian': Number(data.kembalian || 0),
        'Metode': data.metode || 'Cash',
        'Items JSON': typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
        'Link PDF': data.linkPdf || '#',
        _timestamp: data.createdAt || 0
      });
    });
    list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
    callback(list);
  }, (err) => {
    console.warn('[Firestore Transaction Listener Warning]:', err);
  });
}

// -------------------------------------------------------------
// CHAT BANTUAN CLOUD FIRESTORE FUNCTIONS
// 1. Chat Admin (1-on-1 User ↔ Admin)
// 2. Grup Pengguna (Obrolan Publik Seluruh Pengguna)
// -------------------------------------------------------------

export function parseMessageTimestamp(m: any): number {
  if (!m) return 0;
  // 1. Cek Firestore Timestamp object (toMillis / seconds / _seconds)
  if (m.createdAt && typeof m.createdAt.toMillis === 'function') {
    return m.createdAt.toMillis();
  }
  if (m.createdAt && typeof m.createdAt.seconds === 'number') {
    return m.createdAt.seconds * 1000;
  }
  if (m.createdAt && typeof m.createdAt._seconds === 'number') {
    return m.createdAt._seconds * 1000;
  }
  // 2. Cek numeric createdAt
  if (typeof m.createdAt === 'number' && m.createdAt > 0) {
    return m.createdAt;
  }
  if (typeof m.createdAt === 'string' && /^\d+$/.test(m.createdAt.trim())) {
    const parsed = parseInt(m.createdAt.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // 3. Cek ID yang mengandung milidetik (misal msg-1726567890123-xxx)
  if (typeof m.id === 'string') {
    const match = m.id.match(/\d{10,14}/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (!isNaN(num) && num > 0) return num;
    }
  }
  // 4. Cek string timestamp
  if (m.timestamp) {
    const str = String(m.timestamp).trim();
    const partsWithSec = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (partsWithSec) {
      const d = new Date(parseInt(partsWithSec[3], 10), parseInt(partsWithSec[2], 10) - 1, parseInt(partsWithSec[1], 10), parseInt(partsWithSec[4], 10), parseInt(partsWithSec[5], 10), parseInt(partsWithSec[6], 10));
      if (!isNaN(d.getTime())) return d.getTime();
    }
    const parts = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
    if (parts) {
      const d = new Date(parseInt(parts[3], 10), parseInt(parts[2], 10) - 1, parseInt(parts[1], 10), parseInt(parts[4], 10), parseInt(parts[5], 10));
      if (!isNaN(d.getTime())) return d.getTime();
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

export function subscribeToAdminChat(username: string, callback: (messages: any[]) => void): () => void {
  if (!username) return () => {};
  const normUser = String(username).trim().toLowerCase();
  const messagesCol = collection(db, COLLECTIONS.ADMIN_CHATS, normUser, 'messages');
  
  return onSnapshot(messagesCol, (snapshot) => {
    const msgs: any[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      msgs.push({
        id: data.id || d.id,
        senderUsername: data.senderUsername || '',
        senderName: data.senderName || data.senderUsername || 'Pengguna',
        senderRole: data.senderRole || 'Kasir',
        senderCabang: data.senderCabang || 'Pusat',
        text: data.text || '',
        imageUrl: data.imageUrl || '',
        timestamp: data.timestamp || '',
        createdAt: data.createdAt || 0
      });
    });
    msgs.sort((a, b) => {
      const diff = parseMessageTimestamp(a) - parseMessageTimestamp(b);
      return diff !== 0 ? diff : String(a.id || '').localeCompare(String(b.id || ''));
    });
    callback(msgs);
  }, (err) => {
    console.warn('[Firestore Admin Chat Listener Warning]:', err);
  });
}

export async function sendAdminChatMessage(payload: {
  username: string;
  senderUsername: string;
  senderName: string;
  senderRole: string;
  senderCabang: string;
  text: string;
  imageUrl?: string;
  replyAfterTimestamp?: number;
}) {
  const normUser = String(payload.username).trim().toLowerCase();
  
  // Pastikan pesan balasan selalu memiliki timestamp lebih baru daripada pesan yang diterima
  const minRequiredTime = (typeof payload.replyAfterTimestamp === 'number' && payload.replyAfterTimestamp > 0)
    ? (payload.replyAfterTimestamp + 1000)
    : 0;
  const finalCreatedAt = Math.max(Date.now(), minRequiredTime);
  const msgId = 'msg-' + finalCreatedAt + '-' + Math.random().toString(36).substring(2, 7);

  const now = new Date(finalCreatedAt);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const formattedTimestamp = `${day}/${month}/${year} ${hours}:${minutes}`;

  const messageDocData = {
    id: msgId,
    senderUsername: payload.senderUsername,
    senderName: payload.senderName || payload.senderUsername,
    senderRole: payload.senderRole,
    senderCabang: payload.senderCabang || 'Pusat',
    text: payload.text || '',
    imageUrl: payload.imageUrl || '',
    timestamp: formattedTimestamp,
    createdAt: finalCreatedAt
  };

  // 1. Simpan pesan ke subkoleksi chat
  const msgRef = doc(db, COLLECTIONS.ADMIN_CHATS, normUser, 'messages', msgId);
  await setDoc(msgRef, messageDocData);

  // 2. Perbarui metadata percakapan untuk list thread Admin
  try {
    const convRef = doc(db, COLLECTIONS.ADMIN_CONVERSATIONS, normUser);
    const existingSnap = await getDoc(convRef);
    const prev = existingSnap.exists() ? existingSnap.data() : {};

    const isFromAdmin = payload.senderRole === 'Admin';
    const unreadForAdmin = isFromAdmin ? 0 : ((prev?.unreadForAdmin || 0) + 1);
    const unreadForUser = isFromAdmin ? ((prev?.unreadForUser || 0) + 1) : 0;

    await setDoc(convRef, {
      id: normUser,
      username: normUser,
      fullName: (!isFromAdmin && payload.senderName) ? payload.senderName : (prev?.fullName || normUser),
      role: (!isFromAdmin && payload.senderRole) ? payload.senderRole : (prev?.role || 'Kasir'),
      cabang: (!isFromAdmin && payload.senderCabang) ? payload.senderCabang : (prev?.cabang || 'Pusat'),
      lastMessage: payload.text || (payload.imageUrl ? '📷 [Foto Terlampir]' : ''),
      lastTimestamp: formattedTimestamp,
      unreadForAdmin: unreadForAdmin,
      unreadForUser: unreadForUser,
      updatedAt: now.toISOString(),
      lastSender: payload.senderUsername
    }, { merge: true });
  } catch (err) {
    console.warn('[Firestore update admin conversation metadata error]:', err);
  }

  return { success: true, message: messageDocData };
}

export async function deleteAdminChatMessage(username: string, messageId: string) {
  const normUser = String(username).trim().toLowerCase();
  const targetDoc = doc(db, COLLECTIONS.ADMIN_CHATS, normUser, 'messages', messageId);
  await deleteDoc(targetDoc);
  return { success: true, message: 'Pesan berhasil dihapus.' };
}

export async function deleteUserConversationHistory(username: string) {
  const rawUser = String(username || '').trim();
  const normUser = rawUser.toLowerCase();
  
  const targets = new Set<string>();
  if (normUser) targets.add(normUser);
  if (rawUser) targets.add(rawUser);

  // 1. Hapus semua pesan dari subkoleksi messages untuk semua variasi username
  for (const targetUser of targets) {
    if (!targetUser) continue;
    try {
      const messagesCol = collection(db, COLLECTIONS.ADMIN_CHATS, targetUser, 'messages');
      const snap = await getDocs(messagesCol);
      if (!snap.empty) {
        const deletePromises = snap.docs.map(d => deleteDoc(d.ref));
        await Promise.all(deletePromises);
      }
      // Hapus parent chat document jika ada
      try {
        await deleteDoc(doc(db, COLLECTIONS.ADMIN_CHATS, targetUser));
      } catch (_) {}
    } catch (err) {
      console.warn(`[deleteUserConversationHistory admin_chats error for ${targetUser}]:`, err);
    }

    // 2. Hapus dokumen ringkasan percakapan di admin_conversations
    try {
      const convDoc = doc(db, COLLECTIONS.ADMIN_CONVERSATIONS, targetUser);
      await deleteDoc(convDoc);
    } catch (err) {
      console.warn(`[deleteUserConversationHistory convDoc warning for ${targetUser}]:`, err);
    }
  }

  return { success: true, message: 'Seluruh riwayat percakapan berhasil dihapus dari database.' };
}

export async function clearAllAdminConversationsHistory(): Promise<{ success: boolean; message: string }> {
  try {
    const userIds = new Set<string>();

    // 1. Dapatkan seluruh dokumen percakapan di ADMIN_CONVERSATIONS
    try {
      const convSnap = await getDocs(collection(db, COLLECTIONS.ADMIN_CONVERSATIONS));
      convSnap.forEach(d => {
        userIds.add(d.id);
        const data = d.data();
        if (data.username) userIds.add(String(data.username).trim().toLowerCase());
        if (data.id) userIds.add(String(data.id).trim().toLowerCase());
      });
    } catch (e) {
      console.warn('[clearAllAdminConversationsHistory convSnap warning]:', e);
    }

    // 2. Dapatkan juga dokumen dari ADMIN_CHATS jika ada
    try {
      const chatsSnap = await getDocs(collection(db, COLLECTIONS.ADMIN_CHATS));
      chatsSnap.forEach(d => {
        userIds.add(d.id);
      });
    } catch (_) {}

    // 3. Hapus seluruh pesan di subkoleksi 'messages' dan dokumen-dokumennya untuk tiap user
    for (const uid of userIds) {
      if (!uid) continue;
      try {
        const msgsCol = collection(db, COLLECTIONS.ADMIN_CHATS, uid, 'messages');
        const msgsSnap = await getDocs(msgsCol);
        if (!msgsSnap.empty) {
          const deletePromises = msgsSnap.docs.map(m => deleteDoc(m.ref));
          await Promise.all(deletePromises);
        }
        try {
          await deleteDoc(doc(db, COLLECTIONS.ADMIN_CHATS, uid));
        } catch (_) {}
      } catch (err) {
        console.warn(`[clearAllAdminConversationsHistory chat error for ${uid}]:`, err);
      }

      try {
        await deleteDoc(doc(db, COLLECTIONS.ADMIN_CONVERSATIONS, uid));
      } catch (_) {}
    }

    return { success: true, message: 'Seluruh riwayat percakapan admin berhasil dibersihkan.' };
  } catch (err) {
    console.error('[clearAllAdminConversationsHistory Error]:', err);
    throw err;
  }
}

export function subscribeToAdminConversations(callback: (conversations: any[]) => void): () => void {
  const colRef = collection(db, COLLECTIONS.ADMIN_CONVERSATIONS);
  return onSnapshot(colRef, (snapshot) => {
    const list: any[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      list.push({
        id: data.id || d.id,
        username: data.username || d.id,
        fullName: data.fullName || data.username || d.id,
        role: data.role || 'Kasir',
        cabang: data.cabang || 'Pusat',
        lastMessage: data.lastMessage || '',
        lastTimestamp: data.lastTimestamp || '',
        unreadForAdmin: Number(data.unreadForAdmin || 0),
        unreadForUser: Number(data.unreadForUser || 0),
        updatedAt: data.updatedAt || '',
        lastSender: data.lastSender || ''
      });
    });
    list.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    callback(list);
  }, (err) => {
    console.warn('[Firestore Admin Conversations Listener Warning]:', err);
  });
}

export async function markAdminConversationRead(username: string, role: string) {
  try {
    const normUser = String(username).trim().toLowerCase();
    const convRef = doc(db, COLLECTIONS.ADMIN_CONVERSATIONS, normUser);
    if (role === 'Admin') {
      await setDoc(convRef, { unreadForAdmin: 0 }, { merge: true });
    } else {
      await setDoc(convRef, { unreadForUser: 0 }, { merge: true });
    }
  } catch (e) {}
}

// -------------------------------------------------------------
// GRUP PENGGUNA (Obrolan Terbuka Seluruh Pengguna)
// -------------------------------------------------------------

export function subscribeToGroupChat(callback: (messages: any[]) => void): () => void {
  const colRef = collection(db, COLLECTIONS.GROUP_MESSAGES);
  return onSnapshot(colRef, (snapshot) => {
    const msgs: any[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      msgs.push({
        id: data.id || d.id,
        senderUsername: data.senderUsername || '',
        senderName: data.senderName || data.senderUsername || 'Pengguna',
        senderRole: data.senderRole || 'Kasir',
        senderCabang: data.senderCabang || 'Pusat',
        text: data.text || '',
        imageUrl: data.imageUrl || '',
        timestamp: data.timestamp || '',
        createdAt: data.createdAt || 0
      });
    });
    msgs.sort((a, b) => {
      const diff = parseMessageTimestamp(a) - parseMessageTimestamp(b);
      return diff !== 0 ? diff : String(a.id || '').localeCompare(String(b.id || ''));
    });
    callback(msgs);
  }, (err) => {
    console.warn('[Firestore Group Chat Listener Warning]:', err);
  });
}

export async function sendGroupChatMessage(payload: {
  senderUsername: string;
  senderName: string;
  senderRole: string;
  senderCabang: string;
  text: string;
  imageUrl?: string;
  replyAfterTimestamp?: number;
}) {
  const minRequiredTime = (typeof payload.replyAfterTimestamp === 'number' && payload.replyAfterTimestamp > 0)
    ? (payload.replyAfterTimestamp + 1000)
    : 0;
  const finalCreatedAt = Math.max(Date.now(), minRequiredTime);
  const msgId = 'grp-' + finalCreatedAt + '-' + Math.random().toString(36).substring(2, 7);

  const now = new Date(finalCreatedAt);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const formattedTimestamp = `${day}/${month}/${year} ${hours}:${minutes}`;

  const messageDocData = {
    id: msgId,
    senderUsername: payload.senderUsername,
    senderName: payload.senderName || payload.senderUsername,
    senderRole: payload.senderRole,
    senderCabang: payload.senderCabang || 'Pusat',
    text: payload.text || '',
    imageUrl: payload.imageUrl || '',
    timestamp: formattedTimestamp,
    createdAt: finalCreatedAt
  };

  const msgRef = doc(db, COLLECTIONS.GROUP_MESSAGES, msgId);
  await setDoc(msgRef, messageDocData);
  return { success: true, message: messageDocData };
}

export async function deleteGroupChatMessage(messageId: string) {
  const targetDoc = doc(db, COLLECTIONS.GROUP_MESSAGES, messageId);
  await deleteDoc(targetDoc);
  return { success: true, message: 'Pesan berhasil dihapus dari Grup Pengguna.' };
}

export async function clearGroupChatMessages() {
  const snap = await getDocs(collection(db, COLLECTIONS.GROUP_MESSAGES));
  if (snap.empty) {
    return { success: true, message: 'Grup obrolan sudah kosong.' };
  }
  const deletePromises = snap.docs.map(d => deleteDoc(d.ref));
  await Promise.all(deletePromises);
  return { success: true, message: 'Seluruh riwayat grup berhasil dibersihkan.' };
}

// -------------------------------------------------------------
// IMAGE COMPRESSOR HELPER (Mengoptimalkan gambar sebelum kirim)
// -------------------------------------------------------------
export function compressImageFile(file: File, maxWidth = 900, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      return reject(new Error('File bukan gambar yang valid'));
    }

    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          return resolve(e.target?.result as string);
        }

        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------------
// BRANCHES & ALL USERS FUNCTIONS
// -------------------------------------------------------------
export async function firestoreGetAllUsers(): Promise<any[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.USERS));
    const list: any[] = [];
    snap.docs.forEach((d) => {
      const u = d.data();
      list.push({
        username: u.username || d.id,
        fullName: u.fullName || u.username || d.id,
        email: u.email || '',
        phone: u.phone || '',
        role: u.role || 'Kasir',
        cabang: u.cabang || 'Sempajak',
        isActive: u.isActive !== false
      });
    });
    return list;
  } catch (err) {
    console.warn('[firestoreGetAllUsers Error]:', err);
    return [];
  }
}

export async function firestoreGetBranches(): Promise<string[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.BRANCHES));
    const list: string[] = [];
    snap.docs.forEach((d) => {
      const data = d.data();
      const name = (data.name || d.id || '').trim();
      if (name && !list.includes(name)) {
        list.push(name);
      }
    });
    if (!list.includes('Sempajak')) list.unshift('Sempajak');
    if (!list.includes('M Yamin')) list.push('M Yamin');
    return list;
  } catch (err) {
    console.warn('[firestoreGetBranches Error]:', err);
    return ['Sempajak', 'M Yamin'];
  }
}

export async function firestoreSaveBranch(branchName: string): Promise<{ success: boolean; message: string; branch: string }> {
  const cleanName = String(branchName || '').trim();
  if (!cleanName || cleanName.length < 2) {
    throw new Error('Nama cabang minimal 2 karakter!');
  }
  const branchId = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const bRef = doc(db, COLLECTIONS.BRANCHES, branchId);
  await setDoc(bRef, {
    id: branchId,
    name: cleanName,
    createdAt: Date.now()
  }, { merge: true });
  return { success: true, message: `Cabang ${cleanName} berhasil disimpan`, branch: cleanName };
}

export function subscribeToBranches(callback: (branches: string[]) => void): () => void {
  try {
    const colRef = collection(db, COLLECTIONS.BRANCHES);
    const unsub = onSnapshot(colRef, (snap) => {
      const list: string[] = [];
      snap.docs.forEach((d) => {
        const data = d.data();
        const name = (data.name || d.id || '').trim();
        if (name && !list.includes(name)) list.push(name);
      });
      if (!list.includes('Sempajak')) list.unshift('Sempajak');
      if (!list.includes('M Yamin')) list.push('M Yamin');
      callback(list);
    }, (err) => {
      console.warn('[Firestore subscribeBranches Warning]:', err);
      callback(['Sempajak', 'M Yamin']);
    });
    return unsub;
  } catch (e) {
    callback(['Sempajak', 'M Yamin']);
    return () => {};
  }
}

// -------------------------------------------------------------
// DOKUMEN ELEKTRONIK PUBLIK (NOTA TRANSAKSI & SLIP GAJI PDF)
// -------------------------------------------------------------
export async function firestoreSaveDocument(docData: {
  id: string;
  type?: 'nota' | 'slip';
  filename: string;
  title: string;
  htmlContent: string;
  phone?: string;
  waMessage?: string;
  base64Pdf?: string;
}): Promise<boolean> {
  try {
    const cleanId = String(docData.id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!cleanId) return false;
    const payload = {
      id: cleanId,
      type: docData.type || 'nota',
      filename: docData.filename,
      title: docData.title,
      htmlContent: docData.htmlContent,
      phone: docData.phone || '',
      waMessage: docData.waMessage || '',
      base64Pdf: docData.base64Pdf || '',
      createdAt: Date.now()
    };

    const docRef = doc(db, COLLECTIONS.DOCUMENTS, cleanId);
    await setDoc(docRef, payload, { merge: true });

    // Simpan juga variasi prefix agar tautan dengan/tanpa prefix tetap bisa dibuka
    const extraIds: string[] = [];
    if (cleanId.startsWith('nota-')) {
      extraIds.push(cleanId.replace(/^nota-/, ''));
    } else if (docData.type === 'nota') {
      extraIds.push('nota-' + cleanId);
    }
    if (cleanId.startsWith('slip-')) {
      extraIds.push(cleanId.replace(/^slip-/, ''));
    } else if (docData.type === 'slip') {
      extraIds.push('slip-' + cleanId);
    }

    for (const altId of extraIds) {
      if (altId && altId !== cleanId) {
        try {
          await setDoc(doc(db, COLLECTIONS.DOCUMENTS, altId), { ...payload, id: altId }, { merge: true });
        } catch (_) {}
      }
    }

    return true;
  } catch (err) {
    console.warn('[Firestore firestoreSaveDocument Error]:', err);
    return false;
  }
}

export async function firestoreGetDocument(docId: string): Promise<any | null> {
  try {
    const cleanId = String(docId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!cleanId) return null;
    const docRef = doc(db, COLLECTIONS.DOCUMENTS, cleanId);
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      return snap.data();
    }
    return null;
  } catch (err) {
    console.warn('[Firestore firestoreGetDocument Error]:', err);
    return null;
  }
}

// Smart document resolver: mencari di 'documents', dan jika belum ada, otomatis mengambil langsung dari 'transactions' atau 'payroll'
export async function firestoreGetDocumentOrFromDatabase(docId: string): Promise<{
  source: 'documents' | 'transactions' | 'payroll';
  data: any;
} | null> {
  try {
    const rawId = String(docId || '').trim();
    const cleanId = rawId.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!cleanId) return null;

    // 1. Cek di koleksi 'documents' dengan berbagai variasi format
    const docCandidates = [
      cleanId,
      cleanId.replace(/^nota-/, ''),
      cleanId.replace(/^slip-/, ''),
      'nota-' + cleanId.replace(/^nota-/, ''),
      'slip-' + cleanId.replace(/^slip-/, '')
    ];

    for (const c of docCandidates) {
      try {
        const snap = await getDoc(doc(db, COLLECTIONS.DOCUMENTS, c));
        if (snap.exists() && snap.data()?.htmlContent) {
          return { source: 'documents', data: snap.data() };
        }
      } catch (_) {}
    }

    // 2. Cek langsung di koleksi 'transactions' (Database Transaksi Kasir)
    const rawTrxId = cleanId.replace(/^nota-/, '');
    const trxCandidates = [
      rawTrxId,
      cleanId,
      rawTrxId.startsWith('TRX-') ? rawTrxId : 'TRX-' + rawTrxId
    ];

    for (const tc of trxCandidates) {
      try {
        const snap = await getDoc(doc(db, COLLECTIONS.TRANSACTIONS, tc));
        if (snap.exists()) {
          return { source: 'transactions', data: { ...snap.data(), id: snap.id || tc } };
        }
      } catch (_) {}
    }

    // Scan koleksi transactions jika ID belum ditemukan persis
    try {
      const snapTrxAll = await getDocs(collection(db, COLLECTIONS.TRANSACTIONS));
      for (const d of snapTrxAll.docs) {
        const data = d.data();
        const dId = String(data.id || d.id || '');
        if (dId === rawTrxId || dId === cleanId || rawTrxId.includes(dId) || dId.includes(rawTrxId)) {
          return { source: 'transactions', data: { ...data, id: dId } };
        }
      }
    } catch (_) {}

    // 3. Cek langsung di koleksi 'payroll' (Database Riwayat Slip Gaji Karyawan)
    const rawSlipId = cleanId.replace(/^slip-/, '');
    const payCandidates = [
      rawSlipId,
      cleanId,
      rawSlipId.startsWith('SLIP-') ? rawSlipId : 'SLIP-' + rawSlipId
    ];

    for (const pc of payCandidates) {
      try {
        const snap = await getDoc(doc(db, COLLECTIONS.PAYROLL, pc));
        if (snap.exists()) {
          return { source: 'payroll', data: { ...snap.data(), id: snap.id || pc } };
        }
      } catch (_) {}
    }

    // Scan koleksi payroll jika belum ketemu ID persis (misal pencarian nama atau bulan)
    try {
      const snapPayAll = await getDocs(collection(db, COLLECTIONS.PAYROLL));
      for (const d of snapPayAll.docs) {
        const data = d.data();
        const pId = String(data.id || d.id || '');
        const pNama = String(data.nama || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const pBulan = String(data.bulan || '').replace(/[^a-zA-Z0-9]/g, '_');

        if (pId === rawSlipId || pId === cleanId || rawSlipId.includes(pId) || pId.includes(rawSlipId)) {
          return { source: 'payroll', data: { ...data, id: pId } };
        }
        if (pNama && cleanId.toLowerCase().includes(pNama)) {
          if (!pBulan || cleanId.includes(pBulan)) {
            return { source: 'payroll', data: { ...data, id: pId } };
          }
        }
      }
    } catch (_) {}

    return null;
  } catch (err) {
    console.warn('[firestoreGetDocumentOrFromDatabase Error]:', err);
    return null;
  }
}

if (typeof window !== 'undefined') {
  (window as any).firestoreGetDocumentOrFromDatabase = firestoreGetDocumentOrFromDatabase;
  (window as any).firestoreGetDocument = firestoreGetDocument;
  (window as any).firestoreSaveDocument = firestoreSaveDocument;
  (window as any).firestoreUpdateTransaksiPdfLink = firestoreUpdateTransaksiPdfLink;
  (window as any).firestoreUpdateSlipPdfLink = firestoreUpdateSlipPdfLink;
  (window as any).deleteUserConversationHistory = deleteUserConversationHistory;
  (window as any).clearAllAdminConversationsHistory = clearAllAdminConversationsHistory;
  (window as any).deleteAdminChatMessage = deleteAdminChatMessage;
  (window as any).deleteGroupChatMessage = deleteGroupChatMessage;
  (window as any).clearGroupChatMessages = clearGroupChatMessages;
}

