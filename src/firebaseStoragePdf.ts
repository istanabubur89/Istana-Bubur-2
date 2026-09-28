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
  container.id = 'direct-pdf-render-' + Date.now();
  container.style.position = 'fixed';
  container.style.top = '0px';
  container.style.left = '0px';
  container.style.width = isNota ? '760px' : '535px';
  container.style.backgroundColor = '#ffffff';
  container.style.zIndex = '-999999';
  container.style.opacity = '1';
  container.style.visibility = 'visible';
  container.style.pointerEvents = 'none';
  container.style.margin = '0';
  container.style.padding = '0';
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  try {
    const html2pdf = (window as any).html2pdf;
    if (typeof html2pdf !== 'function') {
      throw new Error('Pustaka html2pdf belum tersedia di browser.');
    }

    // Tunggu semua gambar (logo, watermark, tanda tangan) selesai dimuat sepenuhnya
    const images = Array.from(container.querySelectorAll('img'));
    await Promise.all(
      images.map(img => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 800);
        });
      })
    );

    // Beri jeda agar rendering layout CSS dan font selesai
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 150)));

    const targetEl = (container.firstElementChild as HTMLElement) || container;
    const targetWidth = targetEl.scrollWidth || (isNota ? 760 : 535);
    const targetHeight = targetEl.scrollHeight || (isNota ? 1050 : 750);

    const opt = {
      margin: [4, 4, 4, 4],
      filename: filename,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        x: 0,
        y: 0,
        width: targetWidth,
        height: targetHeight,
        windowWidth: targetWidth,
        windowHeight: targetHeight
      },
      jsPDF: {
        unit: 'mm',
        format: isNota ? 'a4' : 'a5',
        orientation: 'portrait'
      },
      pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
    };

    const worker = html2pdf().set(opt).from(targetEl);
    const blob: Blob = await worker.outputPdf('blob');
    const dataUri: string = await worker.outputPdf('datauristring');
    const base64 = (dataUri && dataUri.includes('base64,')) ? dataUri.split('base64,')[1].trim() : '';
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
  blob?: Blob;
  base64?: string;
  filename?: string;
  phone?: string;
  text?: string;
}): Promise<boolean> {
  const { phone, text } = options;

  let cleanWa = (phone || '').replace(/[^0-9]/g, '');
  if (cleanWa.startsWith('0')) {
    cleanWa = '62' + cleanWa.slice(1);
  } else if (cleanWa.startsWith('8')) {
    cleanWa = '62' + cleanWa;
  }

  if (typeof (window as any).openWhatsAppApp === 'function') {
    (window as any).openWhatsAppApp(cleanWa, text || '');
  } else {
    const encoded = encodeURIComponent(text || '');
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      window.location.href = cleanWa ? `whatsapp://send?phone=${cleanWa}&text=${encoded}` : `whatsapp://send?text=${encoded}`;
    } else {
      window.open(`https://api.whatsapp.com/send?phone=${cleanWa}&text=${encoded}`, '_blank');
    }
  }

  return true;
}

// Expose globally for convenience
if (typeof window !== 'undefined') {
  (window as any).generatePdfBlobFromHtml = generatePdfBlobFromHtml;
  (window as any).sharePdfDirectToWhatsApp = sharePdfDirectToWhatsApp;
}
