import { getDocument, GlobalWorkerOptions, version } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

function syntheticPdf(): Uint8Array {
  const content = [
    "q",
    "1 0 0 rg",
    "10 10 70 50 re",
    "f",
    "Q",
    "q",
    "0 0 1 rg",
    "100 10 70 50 re",
    "f",
    "Q",
    "",
  ].join("\n");
  const contentLength = new TextEncoder().encode(content).length;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${contentLength} >>\nstream\n${content}endstream`,
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(source).length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const crossReferenceOffset = new TextEncoder().encode(source).length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF`;
  return new TextEncoder().encode(source);
}

async function renderProof() {
  const status = document.querySelector<HTMLElement>("#status");
  const canvas = document.querySelector<HTMLCanvasElement>("#pdf-canvas");
  if (!status || !canvas) throw new Error("PDF proof canvas is unavailable");

  const loadingTask = getDocument({
    data: syntheticPdf(),
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
  });
  const pdf = await loadingTask.promise;
  if (pdf.numPages !== 1)
    throw new Error("Synthetic PDF did not contain one page");
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("PDF proof canvas has no 2D context");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let redPixels = 0;
  let bluePixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    if (red > 200 && green < 80 && blue < 80) redPixels++;
    if (blue > 200 && red < 80 && green < 80) bluePixels++;
  }
  document.documentElement.dataset.pdfVersion = version;
  document.documentElement.dataset.pdfPages = String(pdf.numPages);
  document.documentElement.dataset.redPixels = String(redPixels);
  document.documentElement.dataset.bluePixels = String(bluePixels);
  document.documentElement.dataset.workerAsset = workerUrl;
  document.documentElement.dataset.renderState = "rendered";
  status.textContent = `Rendered page 1 with PDF.js ${version}`;
  await loadingTask.destroy();
}

void renderProof().catch((error: unknown) => {
  document.documentElement.dataset.renderState = "failed";
  const status = document.querySelector<HTMLElement>("#status");
  if (status)
    status.textContent =
      error instanceof Error ? error.message : "PDF render failed";
  console.error(error);
});
