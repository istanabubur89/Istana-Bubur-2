/**
 * Document Viewer & Auto-Downloader for Istana Bubur
 * Handles public links: ?doc=nota-TRX-XXXXXX&download=1
 * Supports Web Desktop, Mobile Browsers, and Android APK WebView
 * Loads documents directly from Cloud Firestore (collections: documents, transactions, payroll)
 */
import {
  db,
  COLLECTIONS
} from './firebase';
import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where
} from 'firebase/firestore';

export interface StoredDocData {
  id: string;
  type: 'nota' | 'slip';
  filename: string;
  title: string;
  htmlContent: string;
  base64Pdf?: string;
  phone?: string;
  waMessage?: string;
  createdAt?: number | string;
}

/**
 * Trigger immediate browser download of a PDF Blob or Base64 string
 */
export function triggerPdfDownload(base64OrBlob: string | Blob, filename: string) {
  let blob: Blob;
  if (typeof base64OrBlob === 'string') {
    const cleanB64 = base64OrBlob.replace(/^data:[^;]+;base64,/, '').trim();
    const byteCharacters = atob(cleanB64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    blob = new Blob([byteArray], { type: 'application/pdf' });
  } else {
    blob = base64OrBlob;
  }

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename || 'Dokumen_Istana_Bubur.pdf';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }, 1000);
}

/**
 * Fetches document from Firestore documents, transactions, or payroll
 */
export async function fetchDocumentFromFirestore(rawDocId: string): Promise<StoredDocData | null> {
  if (!rawDocId) return null;
  const cleanId = String(rawDocId).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  const candidateIds = [
    cleanId,
    cleanId.replace(/^nota-/, ''),
    cleanId.replace(/^slip-/, ''),
    `nota-${cleanId}`,
    `slip-${cleanId}`
  ];

  // 1. Cek di koleksi 'documents'
  for (const cid of candidateIds) {
    try {
      const snap = await getDoc(doc(db, COLLECTIONS.DOCUMENTS, cid));
      if (snap.exists()) {
        const d = snap.data() as any;
        return {
          id: cid,
          type: d.type || (cid.startsWith('slip') ? 'slip' : 'nota'),
          filename: d.filename || `${cid}.pdf`,
          title: d.title || (cid.startsWith('slip') ? 'Slip Gaji Karyawan' : 'Nota Transaksi'),
          htmlContent: d.htmlContent || '',
          base64Pdf: d.base64Pdf || '',
          phone: d.phone || '',
          waMessage: d.waMessage || '',
          createdAt: d.createdAt
        };
      }
    } catch (e) {
      console.warn('[DocViewer] Error checking documents doc:', e);
    }
  }

  // 2. Cek di koleksi 'transactions' (jika nota)
  const trxId = cleanId.replace(/^nota-/, '');
  try {
    const trxSnap = await getDoc(doc(db, COLLECTIONS.TRANSACTIONS, trxId));
    let trxData = trxSnap.exists() ? trxSnap.data() : null;
    if (!trxData) {
      const q = query(collection(db, COLLECTIONS.TRANSACTIONS), where('id', '==', trxId));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        trxData = qSnap.docs[0].data();
      }
    }

    if (trxData) {
      const genReceipt = (window as any).generateReceiptHTML;
      const html = typeof genReceipt === 'function' ? genReceipt(trxData) : '';
      return {
        id: `nota-${trxId}`,
        type: 'nota',
        filename: `Nota_${trxId}.pdf`,
        title: `Nota Transaksi #${trxId}`,
        htmlContent: html,
        phone: trxData.no_wa || '',
        createdAt: trxData.tanggal
      };
    }
  } catch (e) {
    console.warn('[DocViewer] Error checking transactions:', e);
  }

  // 3. Cek di koleksi 'payroll' (jika slip gaji)
  const slipId = cleanId.replace(/^slip-/, '');
  try {
    const slipSnap = await getDoc(doc(db, COLLECTIONS.PAYROLL, slipId));
    let slipData = slipSnap.exists() ? slipSnap.data() : null;
    if (!slipData) {
      const q = query(collection(db, COLLECTIONS.PAYROLL), where('id', '==', slipId));
      const qSnap = await getDocs(q);
      if (!qSnap.empty) {
        slipData = qSnap.docs[0].data();
      }
    }

    if (slipData) {
      const genSlip = (window as any).generateSlipGajiHTML;
      const html = typeof genSlip === 'function' ? genSlip(slipData) : '';
      return {
        id: `slip-${slipId}`,
        type: 'slip',
        filename: `Slip_Gaji_${String(slipData.nama || 'Karyawan').replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`,
        title: `Slip Gaji - ${slipData.nama || 'Karyawan'}`,
        htmlContent: html,
        phone: slipData.noWa || '',
        createdAt: slipData.tanggal
      };
    }
  } catch (e) {
    console.warn('[DocViewer] Error checking payroll:', e);
  }

  return null;
}

/**
 * Checks URL parameters and pathname to render dedicated Document Viewer
 * Returns true if handled (suppresses normal POS view)
 */
export async function checkAndHandleDocViewerRoute(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  const urlParams = new URLSearchParams(window.location.search);
  const docParam = urlParams.get('doc');
  const pathMatch = window.location.pathname.match(/^\/(?:view-doc|api\/pdf\/download)\/([^/?#]+)/);
  const docId = docParam || (pathMatch ? pathMatch[1] : null);

  if (!docId) return false;

  const isAutoDownload = urlParams.get('download') === '1' || urlParams.get('download') === 'true' || window.location.pathname.startsWith('/api/pdf/download');

  console.log('[DocViewer] Initializing viewer for docId:', docId, 'autoDownload:', isAutoDownload);

  // Buat wadah tampilan viewer khusus di body
  const viewerContainer = document.createElement('div');
  viewerContainer.id = 'istana-doc-viewer-root';
  viewerContainer.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: #f1f5f9;
    z-index: 999999;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  `;

  viewerContainer.innerHTML = `
    <!-- Top Action Bar -->
    <div style="background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 12px 16px; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 4px rgba(0,0,0,0.05); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-weight: 800; color: #a11d20; font-size: 18px; letter-spacing: 0.5px;">ISTANA BUBUR</span>
        <span id="doc-badge-status" style="background: #fee2e2; color: #991b1b; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 9999px;">Memuat...</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <button id="btn-doc-download" style="background: #16a34a; color: #ffffff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
          <svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
          Unduh PDF
        </button>
        <button id="btn-doc-print" style="background: #0284c7; color: #ffffff; border: none; padding: 8px 16px; border-radius: 6px; font-weight: 700; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 6px;">
          <svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
          Cetak
        </button>
        <button id="btn-doc-back" style="background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; padding: 8px 14px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer;">
          Buka Aplikasi
        </button>
      </div>
    </div>

    <!-- Main Content Area -->
    <div style="flex: 1; padding: 20px 12px 60px 12px; display: flex; flex-direction: column; align-items: center; justify-content: flex-start;">
      <!-- Download Alert Banner -->
      <div id="doc-download-banner" style="display: none; max-width: 760px; width: 100%; background: #dcfce7; border: 1px solid #86efac; color: #166534; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 600; text-align: center;">
        📥 Mengunduh file PDF secara otomatis ke perangkat Anda...
      </div>

      <!-- Loading State -->
      <div id="doc-loading-state" style="padding: 60px 20px; text-align: center;">
        <div style="display: inline-block; width: 44px; height: 44px; border: 4px solid #f3f4f6; border-top: 4px solid #a11d20; border-radius: 50%; animation: spin 1s linear infinite;"></div>
        <p style="margin-top: 16px; color: #64748b; font-weight: 600; font-size: 14px;">Memuat dokumen dari Firebase Cloud...</p>
      </div>

      <!-- Document Target Canvas -->
      <div id="doc-content-wrapper" style="display: none; width: 100%; max-width: 760px;"></div>

      <!-- Error State -->
      <div id="doc-error-state" style="display: none; max-width: 500px; width: 100%; background: #ffffff; border: 1px solid #fecaca; border-radius: 12px; padding: 32px 24px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05); margin-top: 40px;">
        <div style="width: 54px; height: 54px; background: #fee2e2; color: #dc2626; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px auto; font-size: 24px;">!</div>
        <h3 style="font-size: 18px; font-weight: 800; color: #1e293b; margin: 0 0 8px 0;">Dokumen Tidak Ditemukan</h3>
        <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0 0 20px 0;">Tautan dokumen ini mungkin sudah kedaluwarsa atau ID transaksi (#${docId}) tidak sesuai.</p>
        <button id="btn-doc-retry" style="background: #a11d20; color: #ffffff; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 700; font-size: 13px; cursor: pointer;">Coba Muat Ulang</button>
      </div>
    </div>
  `;

  // Style helper for spinner animation
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    @media print {
      #istana-doc-viewer-root > div:first-child { display: none !important; }
      #istana-doc-viewer-root { background: #ffffff !important; position: static !important; width: 100% !important; height: auto !important; overflow: visible !important; }
      body { background: #ffffff !important; }
    }
  `;
  document.head.appendChild(styleEl);
  document.body.appendChild(viewerContainer);

  const statusBadge = viewerContainer.querySelector('#doc-badge-status') as HTMLElement;
  const loadingState = viewerContainer.querySelector('#doc-loading-state') as HTMLElement;
  const contentWrapper = viewerContainer.querySelector('#doc-content-wrapper') as HTMLElement;
  const errorState = viewerContainer.querySelector('#doc-error-state') as HTMLElement;
  const downloadBanner = viewerContainer.querySelector('#doc-download-banner') as HTMLElement;
  const btnDownload = viewerContainer.querySelector('#btn-doc-download') as HTMLButtonElement;
  const btnPrint = viewerContainer.querySelector('#btn-doc-print') as HTMLButtonElement;
  const btnBack = viewerContainer.querySelector('#btn-doc-back') as HTMLButtonElement;
  const btnRetry = viewerContainer.querySelector('#btn-doc-retry') as HTMLButtonElement;

  btnBack.addEventListener('click', () => {
    window.location.href = window.location.pathname.startsWith('/view-doc') ? '/' : window.location.origin;
  });

  btnPrint.addEventListener('click', () => {
    window.print();
  });

  let loadedDoc: StoredDocData | null = null;

  async function downloadCurrentDoc() {
    if (!loadedDoc) return;
    if (loadedDoc.base64Pdf) {
      triggerPdfDownload(loadedDoc.base64Pdf, loadedDoc.filename);
    } else {
      const html2pdf = (window as any).html2pdf;
      const targetElement = contentWrapper.firstElementChild || contentWrapper;
      if (typeof html2pdf === 'function' && targetElement) {
        const isNota = loadedDoc.type === 'nota';
        const opt = {
          margin: [4, 4, 4, 4],
          filename: loadedDoc.filename,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: 'mm', format: isNota ? 'a4' : 'a5', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(targetElement).save();
      } else {
        window.print();
      }
    }
  }

  btnDownload.addEventListener('click', downloadCurrentDoc);

  async function loadData() {
    loadingState.style.display = 'block';
    contentWrapper.style.display = 'none';
    errorState.style.display = 'none';
    statusBadge.textContent = 'Memuat...';
    statusBadge.style.background = '#fef3c7';
    statusBadge.style.color = '#92400e';

    try {
      const data = await fetchDocumentFromFirestore(docId);
      if (!data || (!data.htmlContent && !data.base64Pdf)) {
        throw new Error('Dokumen tidak ditemukan di Cloud Firestore');
      }

      loadedDoc = data;
      document.title = `${data.title} - Istana Bubur`;

      contentWrapper.innerHTML = data.htmlContent;
      contentWrapper.style.display = 'block';
      loadingState.style.display = 'none';
      statusBadge.textContent = data.type === 'slip' ? 'Slip Gaji' : 'Nota Resmi';
      statusBadge.style.background = '#dcfce7';
      statusBadge.style.color = '#166534';

      if (isAutoDownload) {
        downloadBanner.style.display = 'block';
        setTimeout(() => {
          downloadCurrentDoc();
          setTimeout(() => {
            downloadBanner.style.display = 'none';
          }, 3500);
        }, 500);
      }
    } catch (err: any) {
      console.error('[DocViewer] Load error:', err);
      loadingState.style.display = 'none';
      errorState.style.display = 'block';
      statusBadge.textContent = 'Gagal';
      statusBadge.style.background = '#fee2e2';
      statusBadge.style.color = '#991b1b';
    }
  }

  btnRetry.addEventListener('click', loadData);
  loadData();

  return true;
}

// Expose globally
if (typeof window !== 'undefined') {
  (window as any).checkAndHandleDocViewerRoute = checkAndHandleDocViewerRoute;
}
