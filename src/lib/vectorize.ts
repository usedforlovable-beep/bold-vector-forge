// @ts-nocheck -- numeric-array heavy geometry code; indices are bounds-checked by construction.
// Browser-only vectorization (Potrace WASM) + SVG / DXF / Aspire export.
// All coordinates in output are millimetres. Internal model is Y-up (CNC convention).

export type Pt = [number, number];
export type Seg = { t: "L"; p: Pt } | { t: "C"; c1: Pt; c2: Pt; p: Pt };
export type SubPath = { start: Pt; segs: Seg[] };
export type VectorDoc = { widthMm: number; heightMm: number; paths: SubPath[] };
/** Traced geometry in source pixels, Y-up. */
export type Traced = { wPx: number; hPx: number; paths: SubPath[] };

const UPSCALE = 2; // trace at 2x for sub-pixel accurate contours (no detail loss)

export async function traceImage(src: string): Promise<Traced> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const w = img.naturalWidth * UPSCALE;
  const h = img.naturalHeight * UPSCALE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  // Hard threshold to pure black / white.
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = l < 128 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);

  const mod: any = await import("potrace-wasm");
  const loadFromCanvas = mod.loadFromCanvas ?? mod.default?.loadFromCanvas;
  const svg: string = await loadFromCanvas(canvas);

  const paths: SubPath[] = [];
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) paths.push(...parsePotracePath(m[1]));
  // Potrace units are 1/10 px, already Y-up. Convert to source pixels.
  const k = 1 / (10 * UPSCALE);
  const sc = (p: Pt): Pt => [p[0] * k, p[1] * k];
  return {
    wPx: img.naturalWidth,
    hPx: img.naturalHeight,
    paths: paths.map((sp) => ({
      start: sc(sp.start),
      segs: sp.segs.map((s) => (s.t === "L" ? { t: "L", p: sc(s.p) } : { t: "C", c1: sc(s.c1), c2: sc(s.c2), p: sc(s.p) })),
    })),
  };
}

function parsePotracePath(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let i = 0;
  let cmd = "";
  let cur: Pt = [0, 0];
  let sp: SubPath | null = null;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const P = (): Pt => {
      const x = num(), y = num();
      return rel ? [cur[0] + x, cur[1] + y] : [x, y];
    };
    switch (cmd.toLowerCase()) {
      case "m": {
        cur = P();
        sp = { start: cur, segs: [] };
        out.push(sp);
        cmd = rel ? "l" : "L"; // implicit lineto after moveto
        break;
      }
      case "l": {
        const p = P();
        sp!.segs.push({ t: "L", p });
        cur = p;
        break;
      }
      case "c": {
        const base = cur;
        const r = (): Pt => {
          const x = num(), y = num();
          return rel ? [base[0] + x, base[1] + y] : [x, y];
        };
        const c1 = r(), c2 = r(), p = r();
        sp!.segs.push({ t: "C", c1, c2, p });
        cur = p;
        break;
      }
      case "z": {
        if (sp) cur = sp.start;
        break;
      }
      default:
        i++;
    }
  }
  return out;
}

export function toDoc(t: Traced, widthMm: number, marginMm: number): VectorDoc {
  const s = widthMm / t.wPx;
  const tr = (p: Pt): Pt => [p[0] * s + marginMm, p[1] * s + marginMm];
  return {
    widthMm: widthMm + marginMm * 2,
    heightMm: t.hPx * s + marginMm * 2,
    paths: t.paths.map((sp) => ({
      start: tr(sp.start),
      segs: sp.segs.map((g) => (g.t === "L" ? { t: "L", p: tr(g.p) } : { t: "C", c1: tr(g.c1), c2: tr(g.c2), p: tr(g.p) })),
    })),
  };
}

const f = (n: number) => (Math.round(n * 10000) / 10000).toString();

export function toSVG(doc: VectorDoc): string {
  const H = doc.heightMm;
  const P = (p: Pt) => `${f(p[0])} ${f(H - p[1])}`;
  const d = doc.paths
    .map((sp) => `M${P(sp.start)}` + sp.segs.map((s) => (s.t === "L" ? `L${P(s.p)}` : `C${P(s.c1)} ${P(s.c2)} ${P(s.p)}`)).join("") + "Z")
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(doc.widthMm)}mm" height="${f(H)}mm" viewBox="0 0 ${f(doc.widthMm)} ${f(H)}">
<path fill="#000000" fill-rule="evenodd" d="${d}"/>
</svg>`;
}

function flatten(sp: SubPath, tol = 0.01): Pt[] {
  const pts: Pt[] = [sp.start];
  let cur = sp.start;
  for (const s of sp.segs) {
    if (s.t === "L") pts.push(s.p);
    else {
      const len = Math.hypot(s.c1[0] - cur[0], s.c1[1] - cur[1]) + Math.hypot(s.c2[0] - s.c1[0], s.c2[1] - s.c1[1]) + Math.hypot(s.p[0] - s.c2[0], s.p[1] - s.c2[1]);
      const n = Math.max(4, Math.min(200, Math.ceil(Math.sqrt(len / tol))));
      for (let k = 1; k <= n; k++) {
        const t = k / n, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
        pts.push([a * cur[0] + b * s.c1[0] + c * s.c2[0] + e * s.p[0], a * cur[1] + b * s.c1[1] + c * s.c2[1] + e * s.p[1]]);
      }
    }
    cur = s.p;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - pts[0][0], last[1] - pts[0][1]) < 1e-6) pts.pop();
  return pts;
}

/** DXF R12, units mm ($INSUNITS=4), closed POLYLINEs on layer MIL_ARTES. */
export function toDXF(doc: VectorDoc): string {
  const L: string[] = [];
  const g = (c: number, v: string | number) => L.push(String(c), typeof v === "number" ? f(v) : v);
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, "4");
  g(9, "$EXTMIN"); g(10, 0); g(20, 0);
  g(9, "$EXTMAX"); g(10, doc.widthMm); g(20, doc.heightMm);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, "1");
  g(0, "LAYER"); g(2, "MIL_ARTES"); g(70, "0"); g(62, "7"); g(6, "CONTINUOUS");
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const sp of doc.paths) {
    const pts = flatten(sp);
    if (pts.length < 2) continue;
    g(0, "POLYLINE"); g(8, "MIL_ARTES"); g(66, "1"); g(70, "1");
    for (const p of pts) { g(0, "VERTEX"); g(8, "MIL_ARTES"); g(10, p[0]); g(20, p[1]); }
    g(0, "SEQEND"); g(8, "MIL_ARTES");
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return L.join("\r\n") + "\r\n";
}

/** Plain-text vector file read by the Mil Artes Aspire Gadget (exact Bezier curves, mm, Y-up). */
export function toMilvec(doc: VectorDoc, thicknessMm: number, name: string): string {
  const L = [`MILVEC 1`, `NAME ${name.replace(/\s+/g, "_")}`, `JOB ${f(doc.widthMm)} ${f(doc.heightMm)} ${f(thicknessMm)}`];
  for (const sp of doc.paths) {
    L.push(`M ${f(sp.start[0])} ${f(sp.start[1])}`);
    for (const s of sp.segs)
      L.push(s.t === "L" ? `L ${f(s.p[0])} ${f(s.p[1])}` : `C ${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.p[0])} ${f(s.p[1])}`);
    L.push("Z");
  }
  L.push("END");
  return L.join("\n") + "\n";
}

export const GADGET_NAME = "MilArtes_Importar";

export const GADGET_LUA = `-- Mil Artes - Importar Vetores (.milvec) para Vectric Aspire / VCarve
-- Cria o trabalho no tamanho correto (mm), importa curvas Bezier exatas,
-- centraliza e coloca tudo em uma nova camada.
require "strict"

local LAYER_NAME = "Mil Artes Vetores"

local function split(s)
  local t = {}
  for w in string.gmatch(s, "%S+") do t[#t + 1] = w end
  return t
end

function main(script_path)
  local fd = FileDialog()
  if not fd:FileOpen("milvec", "*.milvec", "Mil Artes Vetores (*.milvec)|*.milvec|") then
    return false
  end
  local fh = io.open(fd.PathName, "r")
  if fh == nil then
    MessageBox("Nao foi possivel abrir o arquivo:\\n" .. fd.PathName)
    return false
  end

  local name, jw, jh, thick = "MilArtes", 100, 100, 18
  local contours = {}
  local ctr = nil
  local sx, sy = 0, 0
  local cx, cy = 0, 0

  for line in fh:lines() do
    local t = split(line)
    local c = t[1]
    if c == "NAME" then name = t[2]
    elseif c == "JOB" then jw, jh, thick = tonumber(t[2]), tonumber(t[3]), tonumber(t[4])
    elseif c == "M" then
      sx, sy = tonumber(t[2]), tonumber(t[3])
      cx, cy = sx, sy
      ctr = Contour(0.0)
      ctr:AppendPoint(sx, sy)
    elseif c == "L" then
      cx, cy = tonumber(t[2]), tonumber(t[3])
      ctr:LineTo(cx, cy)
    elseif c == "C" then
      local c1 = Point2D(tonumber(t[2]), tonumber(t[3]))
      local c2 = Point2D(tonumber(t[4]), tonumber(t[5]))
      cx, cy = tonumber(t[6]), tonumber(t[7])
      ctr:BezierTo(Point2D(cx, cy), c1, c2)
    elseif c == "Z" then
      if math.abs(cx - sx) > 1e-6 or math.abs(cy - sy) > 1e-6 then
        ctr:LineTo(sx, sy)
      end
      contours[#contours + 1] = ctr
      ctr = nil
    end
  end
  fh:close()

  local job = VectricJob()
  if not job.Exists then
    local bounds = Box2D(Point2D(0, 0), Point2D(jw, jh))
    -- name, bounds, thickness, in_mm, origin_on_surface
    if not CreateNewJob(name, bounds, thick, true, true) then
      MessageBox("Falha ao criar o trabalho.")
      return false
    end
    job = VectricJob()
  end

  -- Centralizar no material atual
  local mat = MaterialBlock()
  local mb = mat.MaterialBox
  local dx = (mb.MinX + mb.MaxX) / 2 - jw / 2
  local dy = (mb.MinY + mb.MaxY) / 2 - jh / 2
  local xf = TranslationMatrix2D(Vector2D(dx, dy))

  local layer = job.LayerManager:GetLayerWithName(LAYER_NAME)
  for i = 1, #contours do
    local obj = CreateCadContour(contours[i])
    obj:Transform(xf)
    layer:AddObject(obj, true)
  end
  job:Refresh2DView()
  MessageBox("Mil Artes: " .. #contours .. " vetores importados na camada '" .. LAYER_NAME .. "'.\\nPronto para criar o percurso!")
  return true
end
`;
