import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { streamImage } from "@/lib/stream-image";
import { zipSync, strToU8 } from "fflate";
import { traceImage, toDoc, toSVG, toDXF, toMilvec, GADGET_LUA, GADGET_NAME, type Traced } from "@/lib/vectorize";
import logoAsset from "@/assets/mil-artes-logo.jpg.asset.json";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "Mil Artes — Conversor Preto e Branco Vetorial" },
      {
        name: "description",
        content:
          "Envie sua imagem e converta para arte vetorial em preto sólido sobre fundo branco, ideal para corte a laser, plotter, sublimação e serigrafia.",
      },
      { property: "og:title", content: "Mil Artes — Conversor Preto e Branco Vetorial" },
      {
        property: "og:description",
        content: "Converta imagens em arte vetorial preto e branco de alto contraste para corte, gravação e impressão.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

const CONVERSION_PROMPT = `Transforme esta imagem em uma versão de arte vetorial limpa, profissional e de alto contraste, mantendo fielmente o design original, a composição, os textos, os elementos gráficos, os símbolos e as proporções.

Converta todos os elementos para preto sólido sobre fundo branco, eliminando completamente cores, gradientes, sombras, brilhos, efeitos 3D, texturas e transparências.

Preserve os contornos e detalhes importantes da imagem original, recriando-os como linhas e formas vetoriais nítidas e uniformes.

O resultado deve ser adequado para: corte a laser, recorte em plotter, sublimação, serigrafia, gravação, criação de SVG e arquivos para impressão.

Estilo: black and white vector, clean line art, high contrast, sharp contours, professional logo tracing, solid black shapes, white background, no color, no gradients, no shadows, no 3D, no photorealism.

IMPORTANTE: não redesenhe o logotipo de forma diferente. Reproduza fielmente a imagem original, apenas convertendo-a para uma aparência vetorial preta e branca.`;

// Downscale large uploads before sending: much faster upload and processing,
// with no visible quality loss for vector-style conversion.
async function downscaleImage(file: File, maxSide: number): Promise<File> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const { width, height } = bitmap;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  if (scale >= 1) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, ".png"), { type: "image/png" });
}

function Index() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [isFinal, setIsFinal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dragging, setDragging] = useState(false);
  const [traced, setTraced] = useState<Traced | null>(null);
  const [tracing, setTracing] = useState(false);
  const [widthMm, setWidthMm] = useState(300);
  const [marginMm, setMarginMm] = useState(5);
  const [thickMm, setThickMm] = useState(18);

  useEffect(() => {
    setTraced(null);
    if (!resultUrl || !isFinal) return;
    let alive = true;
    setTracing(true);
    traceImage(resultUrl)
      .then((t) => alive && setTraced(t))
      .catch((e) => alive && setError("Falha na vetorização: " + (e?.message ?? e)))
      .finally(() => alive && setTracing(false));
    return () => {
      alive = false;
    };
  }, [resultUrl, isFinal]);

  const doc = traced ? toDoc(traced, widthMm, marginMm) : null;
  const svgText = doc ? toSVG(doc) : null;
  const baseName = (file?.name.replace(/\.\w+$/, "") || "milartes").replace(/[^\w-]+/g, "_");
  const save = (data: BlobPart, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const downloadGadget = () => {
    const zip = zipSync({
      [`${GADGET_NAME}/${GADGET_NAME}.lua`]: strToU8(GADGET_LUA),
    });
    save(zip, `${GADGET_NAME}.zip`, "application/zip");
  };
  const runId = useRef(0);

  const convert = useCallback(async (source: File) => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    setResultUrl(null);
    setIsFinal(false);
    try {
      const optimized = await downscaleImage(source, 1536);
      const form = new FormData();
      form.append("prompt", CONVERSION_PROMPT);
      form.append("image[]", optimized);
      await streamImage("/api/edit-image", form, (src, final) => {
        if (id !== runId.current) return;
        setResultUrl(src);
        setIsFinal(final);
      });
    } catch (err) {
      if (id === runId.current)
        setError(err instanceof Error ? err.message : "Falha ao converter a imagem. Tente novamente.");
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, []);

  const handleFile = useCallback(
    (selected: File | undefined | null) => {
      if (!selected || !selected.type.startsWith("image/")) return;
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(selected);
      });
      setFile(selected);
      void convert(selected);
    },
    [convert],
  );

  const handleConvert = () => {
    if (file && !loading) void convert(file);
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const pasted = item?.getAsFile();
      if (!pasted) return;
      e.preventDefault();
      const ext = pasted.type.split("/")[1] || "png";
      handleFile(new File([pasted], `colada.${ext}`, { type: pasted.type }));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFile]);

  const handleDownload = () => {
    if (!resultUrl || !isFinal) return;
    const a = document.createElement("a");
    a.href = resultUrl;
    a.download = "vetor-preto-branco.png";
    a.click();
  };

  return (
    <div
      className={`min-h-screen bg-[#052012] text-neutral-100 ${dragging ? "ring-4 ring-inset ring-[#f5b800]" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
    >
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 text-center">
          <img
            src={logoAsset.url}
            alt="Mil Artes CNC"
            className="mx-auto mb-6 h-28 w-28 rounded-2xl border border-[#1a4a33] object-cover shadow-lg shadow-black/40 sm:h-36 sm:w-36"
          />
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            <span className="text-[#f5b800]">Mil Artes</span>{" "}
            <span className="text-neutral-300">— Conversor Vetorial P&B</span>
          </h1>
          <p className="mt-3 text-neutral-400">
            Transforme qualquer imagem em arte preta e branca de alto contraste, pronta para corte a
            laser, plotter, sublimação, serigrafia e gravação.
          </p>
        </header>

        <div className="mb-8 flex flex-col items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border border-[#1a4a33] bg-[#0a2e1f] px-6 py-3 font-medium transition hover:border-[#f5b800]/60 hover:bg-[#0d3a26]"
            >
              {file ? "Trocar imagem real" : "Escolher imagem real"}
            </button>
            <button
              onClick={handleConvert}
              disabled={!file || loading}
              className="rounded-lg bg-[#f5b800] px-6 py-3 font-semibold text-black transition hover:bg-[#ffcb2e] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Convertendo..." : file ? "Converter novamente" : "Converter para P&B vetorial"}
            </button>
            {resultUrl && isFinal && (
              <button
                onClick={handleDownload}
                className="rounded-lg border border-[#1a4a33] bg-[#0a2e1f] px-6 py-3 font-medium transition hover:border-[#f5b800]/60 hover:bg-[#0d3a26]"
              >
                Baixar resultado
              </button>
            )}
          </div>
          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/50 px-4 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-xl border border-[#1a4a33] bg-[#0a2e1f] p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[#f5b800]">
              Imagem real
            </h2>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-[#052012]">
              {originalUrl ? (
                <img src={originalUrl} alt="Imagem original" className="max-h-full max-w-full object-contain" />
              ) : (
                <p className="px-6 text-center text-sm text-neutral-500">
                  Cole uma imagem (Ctrl+V / Cmd+V), arraste aqui ou clique em "Escolher imagem real". A conversão começa automaticamente.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-[#1a4a33] bg-[#0a2e1f] p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[#f5b800]">
              Resultado
            </h2>
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white">
              {resultUrl ? (
                <img
                  src={resultUrl}
                  alt="Resultado em preto e branco"
                  className={`max-h-full max-w-full object-contain transition-[filter] ${
                    isFinal ? "blur-0" : "blur-2xl"
                  }`}
                />
              ) : (
                <p className="px-6 text-center text-sm text-neutral-500">
                  {loading
                    ? "Gerando prévia..."
                    : "O resultado vetorial em preto e branco aparecerá aqui."}
                </p>
              )}
            </div>
          </section>
        </div>

        <section className="mt-8 rounded-xl border border-[#1a4a33] bg-[#0a2e1f] p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-[#f5b800]">
            Vetores para CNC / Vectric Aspire
          </h2>
          <div className="mb-4 flex flex-wrap gap-4 text-sm">
            {([
              ["Largura da arte (mm)", widthMm, setWidthMm],
              ["Margem (mm)", marginMm, setMarginMm],
              ["Espessura do material (mm)", thickMm, setThickMm],
            ] as const).map(([label, v, set]) => (
              <label key={label} className="flex flex-col gap-1">
                <span className="text-neutral-400">{label}</span>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={v}
                  onChange={(e) => set(Math.max(0, Number(e.target.value) || 0))}
                  className="w-44 rounded-md border border-[#1a4a33] bg-[#052012] px-3 py-2 text-neutral-100"
                />
              </label>
            ))}
          </div>
          {tracing && <p className="text-sm text-neutral-400">Gerando vetores editáveis...</p>}
          {!doc && !tracing && (
            <p className="text-sm text-neutral-500">Os vetores são gerados automaticamente quando o resultado ficar pronto.</p>
          )}
          {doc && svgText && (
            <div className="grid gap-5 md:grid-cols-2">
              <div
                className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white p-2 [&>svg]:h-auto [&>svg]:max-h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svgText.replace(/<\?xml[^>]*>/, "").replace(/ width="[^"]*" height="[^"]*"/, "") }}
              />
              <div className="flex flex-col gap-3 text-sm">
                <p className="text-neutral-300">
                  Trabalho: <b>{doc.widthMm.toFixed(1)} × {doc.heightMm.toFixed(1)} mm</b> · {doc.paths.length} vetores
                  fechados (furos das letras preservados)
                </p>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => save(toMilvec(doc, thickMm, baseName), `${baseName}.milvec`, "text/plain")} className="rounded-lg bg-[#f5b800] px-4 py-2 font-semibold text-black hover:bg-[#ffcb2e]">Baixar para Aspire (.milvec)</button>
                  <button onClick={() => save(svgText, `${baseName}.svg`, "image/svg+xml")} className="rounded-lg border border-[#1a4a33] bg-[#052012] px-4 py-2 hover:border-[#f5b800]/60">Baixar SVG</button>
                  <button onClick={() => save(toDXF(doc), `${baseName}.dxf`, "application/dxf")} className="rounded-lg border border-[#1a4a33] bg-[#052012] px-4 py-2 hover:border-[#f5b800]/60">Baixar DXF</button>
                  <button onClick={downloadGadget} className="rounded-lg border border-[#1a4a33] bg-[#052012] px-4 py-2 hover:border-[#f5b800]/60">Baixar Gadget Aspire</button>
                </div>
                <ol className="list-decimal space-y-1 pl-5 text-neutral-400">
                  <li>Uma vez só: extraia o Gadget na pasta de Gadgets do Aspire (Gadgets → Abrir pasta de Gadgets) e reinicie o Aspire.</li>
                  <li>No Aspire: Gadgets → <b>MilArtes_Importar</b> → escolha o arquivo .milvec.</li>
                  <li>O trabalho é criado no tamanho certo, os vetores ficam centralizados na camada “Mil Artes Vetores”. Pronto para o percurso.</li>
                  <li>Alternativa: Arquivo → Importar Vetores com o SVG ou DXF (já em mm).</li>
                </ol>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
