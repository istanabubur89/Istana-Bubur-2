/**
 * Firebase Cloud Storage for Transaction & Payroll PDFs
 * Automatically uploads Nota Transaksi and Slip Gaji PDFs to Firebase Storage
 * Generates direct download links for WhatsApp sharing
 * Avoids duplicate uploads if file is already available
 */
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { app, firestoreSaveDocument, firestoreUpdateTransaksiPdfLink, firestoreUpdateSlipPdfLink } from './firebase';

export const storage = getStorage(app);

/**
 * Converts HTML content to PDF Blob and Base64 string using html2pdf
 */
export async function generatePdfBlobFromHtml(htmlContent: string, filename: string, isNota: boolean = true): Promise<{ blob: Blob; base64: string }> {
  if (typeof window === 'undefined') {
    throw new Error('generatePdfBlobFromHtml hanya dapat dijalankan di browser');
  }

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '-99999px';
  container.style.width = isNota ? '760px' : '535px';
  container.style.backgroundColor = '#ffffff';
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  try {
    const html2pdf = (window as any).html2pdf;
    if (typeof html2pdf !== 'function') {
      throw new Error('Pustaka html2pdf belum tersedia di browser.');
    }
    const opt = {
      margin: [4, 4, 4, 4],
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, logging: false },
      jsPDF: { unit: 'mm', format: isNota ? 'a4' : 'a5', orientation: 'portrait' }
    };
    const worker = html2pdf().set(opt).from(container);
    const blob: Blob = await worker.outputPdf('blob');
    const dataUri: string = await worker.outputPdf('datauristring');
    const base64 = (dataUri && dataUri.includes('base64,')) ? dataUri.split('base64,')[1] : '';
    return { blob, base64 };
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}

/**
 * Uploads a PDF Blob to Firebase Storage (with Firestore Document fallback)
 */
export async function uploadPdfToFirebase(options: {
  storagePath: string;
  blob: Blob;
  base64?: string;
  filename: string;
  docId: string;
  type: 'nota' | 'slip';
  title?: string;
  htmlContent?: string;
}): Promise<string> {
  const { storagePath, blob, base64, filename, docId, type, title, htmlContent } = options;

  // 1. Coba upload langsung via Firebase Cloud Storage SDK jika bucket aktif
  try {
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, blob, {
      contentType: 'application/pdf',
      customMetadata: {
        filename,
        docId,
        type,
        uploadedAt: new Date().toISOString()
      }
    });
    const downloadUrl = await getDownloadURL(fileRef);
    if (downloadUrl && downloadUrl.startsWith('http')) {
      console.log('[Firebase Storage] Berhasil upload ke Storage:', downloadUrl);
      return downloadUrl;
    }
  } catch (storageErr) {
    console.warn('[Firebase Storage SDK] Upload bucket tidak aktif / gagal, menggunakan Firebase Firestore Document Cloud Storage:', storageErr);
  }

  // 2. Simpan ke Cloud Firestore (Koleksi 'documents') sebagai penyimpanan cloud utama
  let b64 = base64 || '';
  if (!b64) {
    try {
      b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result as string;
          resolve(res.replace(/^data:[^;]+;base64,/, ''));
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {}
  }

  const cleanDocId = String(docId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '_');
  try {
    await firestoreSaveDocument({
      id: cleanDocId,
      type,
      filename,
      title: title || (type === 'slip' ? 'Slip Gaji Karyawan' : 'Nota Transaksi'),
      htmlContent: htmlContent || '',
      base64Pdf: b64
    });
    console.log('[Firebase Firestore] Dokumen PDF tersimpan di Cloud Firestore:', cleanDocId);
  } catch (fsErr) {
    console.warn('[Firebase Document Save] Warning:', fsErr);
  }

  // Simpan juga ke server Express cache jika server tersedia
  try {
    fetch('/api/pdf/prepare-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customId: cleanDocId,
        type,
        filename,
        title: title || (type === 'slip' ? 'Slip Gaji Karyawan' : 'Nota Transaksi'),
        htmlContent: htmlContent || '<p>PDF Dokumen</p>',
        base64Pdf: b64
      })
    }).catch(() => {});
  } catch (e) {}

  // Helper origin publik resmi yang berfungsi di Vercel, APK Android, dan Web Desktop
  let publicOrigin = 'https://istana-bubur-2.vercel.app';
  if (typeof window !== 'undefined') {
    const custom = (localStorage.getItem('IB_PUBLIC_URL') || '').trim();
    if (custom.startsWith('http://') || custom.startsWith('https://')) {
      publicOrigin = custom.replace(/\/+$/, '');
    } else if (window.location && window.location.origin && window.location.origin !== 'null' && (window.location.protocol === 'http:' || window.location.protocol === 'https:') && !window.location.origin.startsWith('file:')) {
      publicOrigin = window.location.origin.replace(/\/+$/, '');
    }
  }

  return `${publicOrigin}/?doc=${cleanDocId}&download=1`;
}

/**
 * Checks if a URL is already a valid Firebase / Cloud storage download link
 */
export function isValidPdfDownloadUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed === '#' || trimmed.length < 10) return false;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  return true;
}

/**
 * 1. Simpan & Dapatkan URL PDF Transaksi ke Firebase Storage
 * Hindari duplikat jika linkPdf / pdfUrl sudah tersedia
 */
export async function ensureTransactionFirebasePdfUrl(trx: any): Promise<string> {
  if (!trx) throw new Error('Data transaksi tidak ditemukan');

  const rawId = trx.id || trx['ID Transaksi'] || Date.now();
  const cleanId = String(rawId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const docId = cleanId.startsWith('nota-') ? cleanId : `nota-${cleanId}`;

  // 1. CEK APAKAH SUDAH TERSEDIA (HINDARI DUPLIKAT)
  const existingUrl = trx.linkPdf || trx.pdfUrl || trx['Link PDF'];
  if (isValidPdfDownloadUrl(existingUrl)) {
    console.log('[Firebase Storage] Nota sudah memiliki URL, melewati upload:', existingUrl);
    return existingUrl;
  }

  // 2. Generate PDF dari HTML nota
  const filename = `Nota_${cleanId}.pdf`;
  const generateReceiptHTML = (window as any).generateReceiptHTML;
  if (typeof generateReceiptHTML !== 'function') {
    throw new Error('generateReceiptHTML belum tersedia');
  }
  const htmlContent = generateReceiptHTML(trx);
  const { blob, base64 } = await generatePdfBlobFromHtml(htmlContent, filename, true);

  // 3. Upload ke Firebase Storage
  const storagePath = `nota_transaksi/${filename}`;
  const downloadUrl = await uploadPdfToFirebase({
    storagePath,
    blob,
    base64,
    filename,
    docId,
    type: 'nota',
    title: `Nota Transaksi #${cleanId}`,
    htmlContent
  });

  // 4. Simpan URL ke data transaksi lokal dan Cloud Firestore
  trx.linkPdf = downloadUrl;
  trx.pdfUrl = downloadUrl;
  trx['Link PDF'] = downloadUrl;

  try {
    await firestoreUpdateTransaksiPdfLink(cleanId, downloadUrl);
  } catch (err) {
    console.warn('[firestoreUpdateTransaksiPdfLink warning]:', err);
  }

  return downloadUrl;
}

/**
 * 2. Simpan & Dapatkan URL PDF Slip Gaji ke Firebase Storage
 * Hindari duplikat jika 'Link PDF' / linkPdf sudah tersedia
 */
export async function ensureSalarySlipFirebasePdfUrl(slip: any): Promise<string> {
  if (!slip) throw new Error('Data slip gaji tidak ditemukan');

  const cleanName = (slip['Nama'] || slip.nama || 'Karyawan').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cleanBulan = (slip['Bulan'] || slip.bulan || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const rawId = slip['ID Slip'] || slip['ID Gaji'] || slip.id || `${cleanName}-${cleanBulan}`;
  const cleanId = String(rawId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const docId = cleanId.startsWith('slip-') ? cleanId : `slip-${cleanId}`;

  // 1. CEK APAKAH SUDAH TERSEDIA (HINDARI DUPLIKAT)
  const existingUrl = slip['Link PDF'] || slip.linkPdf || slip.pdfUrl;
  if (isValidPdfDownloadUrl(existingUrl)) {
    console.log('[Firebase Storage] Slip gaji sudah memiliki URL, melewati upload:', existingUrl);
    return existingUrl;
  }

  // 2. Generate PDF dari HTML slip gaji
  const filename = `Slip_Gaji_${cleanName}_${cleanBulan}.pdf`;
  const generateSlipGajiHTML = (window as any).generateSlipGajiHTML;
  if (typeof generateSlipGajiHTML !== 'function') {
    throw new Error('generateSlipGajiHTML belum tersedia');
  }
  const htmlContent = generateSlipGajiHTML(slip);
  const { blob, base64 } = await generatePdfBlobFromHtml(htmlContent, filename, false);

  // 3. Upload ke Firebase Storage
  const storagePath = `slip_gaji/${filename}`;
  const downloadUrl = await uploadPdfToFirebase({
    storagePath,
    blob,
    base64,
    filename,
    docId,
    type: 'slip',
    title: `Slip Gaji - ${slip['Nama'] || 'Karyawan'} (${slip['Bulan'] || ''})`,
    htmlContent
  });

  // 4. Simpan URL ke data slip gaji lokal dan Cloud Firestore
  slip['Link PDF'] = downloadUrl;
  slip.linkPdf = downloadUrl;
  slip.pdfUrl = downloadUrl;

  try {
    const targetSlipId = slip['ID Slip'] || slip['ID Gaji'] || docId;
    await firestoreUpdateSlipPdfLink(targetSlipId, downloadUrl);
  } catch (err) {
    console.warn('[firestoreUpdateSlipPdfLink warning]:', err);
  }

  return downloadUrl;
}

// Expose globally for app.js
if (typeof window !== 'undefined') {
  (window as any).FirebasePdfStorage = {
    ensureTransactionFirebasePdfUrl,
    ensureSalarySlipFirebasePdfUrl,
    isValidPdfDownloadUrl,
    uploadPdfToFirebase,
    generatePdfBlobFromHtml
  };
}
