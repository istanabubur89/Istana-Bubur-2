/**
 * Direct PDF Generator & WhatsApp File Sharer for Istana Bubur
 * Generates Nota Transaksi & Slip Gaji PDFs locally in memory
 * Shares the PDF file directly to WhatsApp without uploading to Firebase Storage or Google Drive
 * Supports Android APK WebView, Mobile Browsers, and Web Desktop
 */

/**
 * Converts HTML content to PDF Blob and Base64 string using html2pdf
 * Pure client-side generation without uploading to any cloud storage
 */
export async function generatePdfBlobFromHtml(
  htmlContent: string,
  filename: string,
  isNota: boolean = true
): Promise<{ blob: Blob; base64: string }> {
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
 * Membagikan file PDF secara langsung ke WhatsApp tanpa perlu link unduh
 * Berfungsi di APK Android WebView, HP Android / iOS, dan Web Desktop
 */
export async function sharePdfDirectToWhatsApp(options: {
  blob: Blob;
  base64?: string;
  filename: string;
  phone?: string;
  text?: string;
}): Promise<boolean> {
  const { blob, base64, filename, phone, text } = options;

  let cleanWa = (phone || '').replace(/[^0-9]/g, '');
  if (cleanWa.startsWith('0')) {
    cleanWa = '62' + cleanWa.slice(1);
  } else if (cleanWa.startsWith('8')) {
    cleanWa = '62' + cleanWa;
  }

  // 1. Cek Native Android Interface jika APK memiliki bridge Java/Kotlin
  const native = (window as any).Android || (window as any).AndroidShare || (window as any).AndroidBridge || (window as any).AndroidApp || (window as any).JSInterface;
  if (native) {
    if (typeof native.sharePdfWithWhatsApp === 'function') {
      try {
        native.sharePdfWithWhatsApp(base64 || '', filename, cleanWa, text || '');
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('Membagikan file PDF ke WhatsApp...', 'success');
        }
        return true;
      } catch (e) {
        console.warn('Native sharePdfWithWhatsApp error:', e);
      }
    }
    if (typeof native.sharePdf === 'function') {
      try {
        native.sharePdf(base64 || '', filename, cleanWa, text || '');
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('Membagikan file PDF ke WhatsApp...', 'success');
        }
        return true;
      } catch (e) {
        console.warn('Native sharePdf error:', e);
      }
    }
    if (typeof native.shareFile === 'function') {
      try {
        native.shareFile(base64 || '', filename, 'application/pdf', text || '');
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('Membagikan file PDF...', 'success');
        }
        return true;
      } catch (e) {
        console.warn('Native shareFile error:', e);
      }
    }
  }

  // 2. Buat File object standar untuk Web Share API
  let pdfFile: File;
  try {
    pdfFile = new File([blob], filename, {
      type: 'application/pdf',
      lastModified: Date.now()
    });
  } catch (err) {
    pdfFile = blob as any;
    (pdfFile as any).name = filename;
    (pdfFile as any).lastModifiedDate = new Date();
  }

  // 3. Web Share API dengan File Lampiran Langsung (Standar Resmi Android WebView & Chrome)
  // Di Android WebView / Chrome, navigator.share dengan file memicu Android Share Sheet,
  // di mana WhatsApp langsung membuka dan melampirkan file PDF tersebut.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    let canShareFiles = false;
    try {
      canShareFiles = typeof navigator.canShare === 'function' ? navigator.canShare({ files: [pdfFile] }) : true;
    } catch (_) {
      canShareFiles = false;
    }

    if (canShareFiles) {
      try {
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('Membuka WhatsApp untuk melampirkan file PDF...', 'info');
        }
        await navigator.share({
          files: [pdfFile],
          title: filename,
          text: text || ''
        });
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('File PDF berhasil dibagikan ke WhatsApp!', 'success');
        }
        return true;
      } catch (shareErr: any) {
        if (shareErr && (shareErr.name === 'AbortError' || shareErr.message?.includes('canceled') || shareErr.message?.includes('abort'))) {
          // Pengguna membatalkan dialog share
          return false;
        }
        console.warn('[WebShare] Gagal membagikan file via navigator.share:', shareErr);
      }
    }
  }

  // 4. Fallback jika sistem / WebView tidak mengizinkan Web Share file:
  // Unduh/simpan file PDF ke memori perangkat secara instan, lalu buka WhatsApp
  if (typeof (window as any).showToast === 'function') {
    (window as any).showToast('Menyimpan file PDF & membuka WhatsApp...', 'info');
  }

  try {
    const fileUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = fileUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(fileUrl);
    }, 3000);
  } catch (dlErr) {
    console.warn('Gagal unduh file lokal:', dlErr);
  }

  setTimeout(() => {
    if (typeof (window as any).openWhatsAppApp === 'function') {
      (window as any).openWhatsAppApp(cleanWa, text || '');
    }
    if (typeof (window as any).showToast === 'function') {
      (window as any).showToast('File PDF telah tersimpan. Silakan kirim file tersebut di chat WhatsApp.', 'success');
    }
  }, 600);

  return true;
}

// Expose globally for convenience
if (typeof window !== 'undefined') {
  (window as any).generatePdfBlobFromHtml = generatePdfBlobFromHtml;
  (window as any).sharePdfDirectToWhatsApp = sharePdfDirectToWhatsApp;
}
