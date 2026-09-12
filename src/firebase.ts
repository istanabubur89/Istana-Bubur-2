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
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  enableIndexedDbPersistence,
  Unsubscribe
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
  REFERRAL_CODES: 'referralCodes'
};

// Helper: Seed Default Data if collections are empty
export async function seedInitialFirestoreData() {
  try {
    // 1. Check & Seed Users
    const usersSnap = await getDocs(collection(db, COLLECTIONS.USERS));
    if (usersSnap.empty) {
      const defaultUsers = [
        {
          id: 'USR-001',
          fullName: 'Bapak Hendra (Owner)',
          username: 'admin',
          password: '123',
          email: 'admin@istanabubur.com',
          phone: '081234567890',
          role: 'Admin',
          cabang: 'Pusat',
          isActive: true,
          authCode: 'IB-AUTH-2026',
          createdAt: new Date().toISOString()
        },
        {
          id: 'USR-002',
          fullName: 'Siti Rahmawati',
          username: 'kasir1',
          password: '123',
          email: 'kasir1@istanabubur.com',
          phone: '082198765432',
          role: 'Kasir',
          cabang: 'Cabang A',
          isActive: true,
          authCode: 'IB-AUTH-2026',
          createdAt: new Date().toISOString()
        },
        {
          id: 'USR-003',
          fullName: 'Ahmad Fauzi',
          username: 'kasir2',
          password: '123',
          email: 'kasir2@istanabubur.com',
          phone: '085211223344',
          role: 'Kasir',
          cabang: 'Cabang B',
          isActive: true,
          authCode: 'IB-AUTH-2026',
          createdAt: new Date().toISOString()
        }
      ];
      for (const u of defaultUsers) {
        await setDoc(doc(db, COLLECTIONS.USERS, u.username.toLowerCase()), u);
      }
      console.log('[Firestore] Default Users seeded successfully');
    }

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
          cabang: 'Cabang A',
          noWa: '081234567890',
          gajiHarian: 90000,
          email: 'budi@istanabubur.com'
        },
        {
          id: 'KRY-002',
          nama: 'Siti Rahma',
          gender: 'Perempuan',
          posisi: 'Dapur Bubur',
          cabang: 'Cabang A',
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

  let roleNotice = null;
  if (requestedRole && matchedUser.role !== requestedRole) {
    roleNotice = `Akun terdaftar sebagai ${matchedUser.role}. Hak akses disesuaikan ke ${matchedUser.role}.`;
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
    },
    roleNotice
  };
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
  const userDoc = await getDoc(doc(db, COLLECTIONS.USERS, normIdentity));
  if (userDoc.exists()) {
    await setDoc(doc(db, COLLECTIONS.USERS, normIdentity), { password: newPass }, { merge: true });
    return { success: true, message: 'Password berhasil diperbarui di Cloud Firestore.' };
  }

  const snap = await getDocs(collection(db, COLLECTIONS.USERS));
  for (const d of snap.docs) {
    const u = d.data();
    if (u.email && u.email.toLowerCase() === normIdentity) {
      await setDoc(doc(db, COLLECTIONS.USERS, d.id), { password: newPass }, { merge: true });
      return { success: true, message: 'Password berhasil diperbarui di Cloud Firestore.' };
    }
  }

  return { success: false, message: 'Akun tidak ditemukan di database.' };
}

// -------------------------------------------------------------
// PRODUCT FUNCTIONS
// -------------------------------------------------------------
export async function firestoreGetProduk() {
  const snap = await getDocs(collection(db, COLLECTIONS.PRODUCTS));
  const list: any[] = [];
  let index = 1;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    list.push({
      rowIndex: index++,
      'ID Produk': data.id || docSnap.id,
      'Nama Produk': data.nama || '',
      'Harga': Number(data.harga || 0),
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

  const payload: any = {
    id: docId,
    nama: pData.nama || pData['Nama Produk'] || '',
    harga: Number(pData.harga || pData['Harga'] || 0),
    gambar: pData.gambar || pData['GambarBase64'] || ''
  };

  await setDoc(doc(db, COLLECTIONS.PRODUCTS, docId), payload, { merge: true });
  return { success: true, message: 'Produk berhasil disimpan ke Cloud Firestore.' };
}

export async function firestoreDeleteProduk(productIdOrDocId: string) {
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
    if (d.data().id === productIdOrDocId) {
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
      'Cabang': data.cabang || 'Pusat',
      'Kasir': data.kasir || 'Kasir',
      'Total Belanja': Number(data.total || 0),
      'Nama Pelanggan': data.namaPelanggan || 'Umum',
      'No WA': data.noWa || '',
      'Bayar': Number(data.bayar || data.total || 0),
      'Kembalian': Number(data.kembalian || 0),
      'Metode': data.metode || 'Cash',
      'Items JSON': typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
      _timestamp: data.createdAt || 0
    });
  });

  // Sort newest first
  return list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
}

export async function firestoreProcessTransaksiKasir(trx: any) {
  const trxId = 'TRX-' + Math.floor(100000 + Math.random() * 900000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tanggalFormatted = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  
  const namaPelanggan = `${trx.namaPelanggan || 'Umum'} [${trx.jenis || 'Dine In'}${trx.keterangan ? ' - ' + trx.keterangan : ''}]`;
  const itemsJson = typeof trx.items === 'string' ? trx.items : JSON.stringify(trx.items || []);

  const payload = {
    id: trxId,
    tanggal: tanggalFormatted,
    cabang: trx.cabang || 'Pusat',
    kasir: trx.kasir || 'Kasir',
    total: Number(trx.total || 0),
    namaPelanggan: namaPelanggan,
    noWa: trx.wa || '',
    bayar: Number(trx.bayar || trx.total || 0),
    kembalian: Number(trx.kembali || 0),
    metode: trx.metode || 'Cash',
    items: itemsJson,
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
    linkPdf: '#',
    createdAt: Date.now()
  };

  await setDoc(doc(db, COLLECTIONS.PAYROLL, slipId), payload);

  return {
    success: true,
    idSlip: slipId,
    message: 'Slip gaji berhasil diproses & disimpan di Cloud Firestore!',
    pdfUrl: '#',
    waLink: '#'
  };
}

export async function firestoreDeleteHistoriGaji(slipId: string) {
  const targetDoc = doc(db, COLLECTIONS.PAYROLL, slipId);
  await deleteDoc(targetDoc);
  return { success: true, message: 'Riwayat slip gaji berhasil dihapus dari Cloud Firestore.' };
}

// -------------------------------------------------------------
// REALTIME LISTENERS
// -------------------------------------------------------------
export function subscribeToTransactions(callback: (transactions: any[]) => void): Unsubscribe {
  const q = collection(db, COLLECTIONS.TRANSACTIONS);
  return onSnapshot(q, (snapshot) => {
    const list: any[] = [];
    snapshot.forEach((d) => {
      const data = d.data();
      list.push({
        'ID Transaksi': data.id || d.id,
        'Tanggal': data.tanggal || '',
        'Cabang': data.cabang || 'Pusat',
        'Kasir': data.kasir || 'Kasir',
        'Total Belanja': Number(data.total || 0),
        'Nama Pelanggan': data.namaPelanggan || 'Umum',
        'No WA': data.noWa || '',
        'Bayar': Number(data.bayar || data.total || 0),
        'Kembalian': Number(data.kembalian || 0),
        'Metode': data.metode || 'Cash',
        'Items JSON': typeof data.items === 'string' ? data.items : JSON.stringify(data.items || []),
        _timestamp: data.createdAt || 0
      });
    });
    list.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
    callback(list);
  }, (err) => {
    console.warn('[Firestore Transaction Listener Warning]:', err);
  });
}
