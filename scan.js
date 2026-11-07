/* ---- Remplissage automatique d'un aliment ----
 * 1. Code-barres (scan caméra, photo, ou saisie) → Open Pet Food Facts / Open Food Facts
 * 2. Photo de l'étiquette → reconnaissance de texte (Tesseract, sur le téléphone) → constituants
 * 3. Estimation des kcal (Atwater modifié, NRC) quand l'emballage ne les donne pas
 * Les bibliothèques sont chargées seulement à la première utilisation.
 */
const scriptPromises = {};
function loadScript(src) {
  if (!scriptPromises[src])
    scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        delete scriptPromises[src];
        reject(new Error("Chargement impossible : " + src));
      };
      document.head.appendChild(s);
    });
  return scriptPromises[src];
}
const toNum = (x) => {
  if (x === null || x === undefined || x === "") return null;
  const n = parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/* Énergie métabolisable estimée (kcal / 100 g) — Atwater modifié, NRC 2006 */
function estimateKcal100({ protein, fat, fiber, ash, humidity, ena }) {
  if (protein === null || fat === null) return null;
  let nfe = ena;
  if (nfe === null || nfe === undefined) {
    const known = [protein, fat, fiber, ash, humidity];
    if (ash === null || humidity === null) return null;
    nfe = Math.max(0, 100 - known.reduce((s, x) => s + (x || 0), 0));
  }
  return 3.5 * protein + 8.5 * fat + 3.5 * nfe;
}

/* Poids d'une portion à partir du texte de quantité ("4 x 57 g", "85 g", "1,5 kg") */
function portionFromQuantity(q) {
  const t = String(q || "").toLowerCase().replace(",", ".");
  let m = t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*g\b/);
  if (m) return +m[2];
  m = t.match(/(\d+(?:\.\d+)?)\s*g\b/);
  if (m && +m[1] <= 200) return +m[1];
  return null;
}

/* ---------- Open (Pet) Food Facts ---------- */
async function lookupBarcode(code) {
  const fields =
    "code,product_name,product_name_fr,generic_name_fr,brands,quantity,product_quantity,serving_size,nutriments,categories_tags," +
    "ingredients_text_fr,ingredients_text,image_ingredients_url,image_nutrition_url,image_packaging_url";
  for (const host of ["world.openpetfoodfacts.org", "world.openfoodfacts.org"]) {
    try {
      const r = await fetch(`https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === 1 && j.product) return { ...j.product, _source: host };
    } catch (e) {}
  }
  return null;
}
function nutr(n, ...keys) {
  for (const k of keys) {
    const v = toNum(n[k + "_100g"] ?? n[k]);
    if (v !== null) return v;
  }
  return null;
}
function mapProduct(p) {
  const n = p.nutriments || {};
  const out = {
    name: p.product_name_fr || p.product_name || p.generic_name_fr || "",
    brand: (p.brands || "").split(",")[0].trim(),
    protein: nutr(n, "proteins", "crude-protein"),
    fat: nutr(n, "fat", "crude-fat"),
    fiber: nutr(n, "fiber", "crude-fibre", "crude-fiber"),
    ash: nutr(n, "ash", "crude-ash", "crude-ashes"),
    humidity: nutr(n, "moisture", "water"),
    calcium: nutr(n, "calcium"),
    phosphorus: nutr(n, "phosphorus"),
    omega3: nutr(n, "omega-3-fat"),
    omega6: nutr(n, "omega-6-fat"),
    ena: nutr(n, "carbohydrates"),
  };
  const taurine = nutr(n, "taurine");
  if (taurine !== null) out.taurine = Math.round(taurine * 10000) + " mg/kg"; // g/100 g → mg/kg
  let kcal100 = nutr(n, "energy-kcal");
  if (kcal100 === null) {
    const kj = nutr(n, "energy-kj", "energy");
    if (kj !== null) kcal100 = kj / 4.184;
  }
  out.kcal100 = kcal100;
  out.portion = portionFromQuantity(p.quantity) || portionFromQuantity(p.serving_size);
  // Les « constituants analytiques » des aliments pour animaux sont souvent recopiés dans le texte des ingrédients
  const ingr = [p.ingredients_text_fr, p.ingredients_text].filter(Boolean).join("\n"),
    at = ingr.toLowerCase().search(/constituants|composants analytiques|analyse moyenne|analytical/);
  const fromText = at >= 0 ? parseLabel(ingr.slice(at)) : {};
  for (const [k, v] of Object.entries(fromText)) if ((out[k] === null || out[k] === undefined) && v !== null) out[k] = v;
  out.images = [p.image_ingredients_url, p.image_nutrition_url, p.image_packaging_url].filter(Boolean);
  const cats = (p.categories_tags || []).join(" ");
  out.type = /dry|croquette|kibble/.test(cats)
    ? "Croquettes"
    : /mousse/.test(cats + out.name.toLowerCase())
      ? "Mousse"
      : /soup|soupe/.test(cats + out.name.toLowerCase())
        ? "Soupe"
        : /wet|p[aâ]t[ée]e|pouch|sachet/.test(cats + out.name.toLowerCase())
          ? "Pâtée"
          : null;
  return out;
}

/* ---------- Lecture d'étiquette (OCR) ---------- */
/* Image → canvas préparé : rotation, niveaux de gris, contraste étiré, taille adaptée */
async function loadImageSource(src) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    img.src = url;
    await img.decode();
  } finally {
    if (typeof src !== "string") setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return img;
}
function prepCanvas(img, deg = 0, target = 2200, gray = true) {
  const W = img.naturalWidth || img.width,
    H = img.naturalHeight || img.height,
    scale = Math.min(2.5, target / Math.max(W, H)),
    w = Math.round(W * scale),
    h = Math.round(H * scale),
    swap = deg === 90 || deg === 270,
    c = document.createElement("canvas");
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  if (gray) {
    const im = g.getImageData(0, 0, c.width, c.height),
      d = im.data,
      hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      d[i] = v;
      hist[v]++;
    }
    // étirement du contraste en ignorant 1 % des extrêmes (reflets, ombres)
    const n = d.length / 4;
    let lo = 0,
      hi = 255,
      acc = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) / span) * 255));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.putImageData(im, 0, 0);
  }
  return c;
}
let ocrWorkerPromise = null;
function getOcrWorker(onProgress) {
  ocrProgress = onProgress;
  if (!ocrWorkerPromise)
    ocrWorkerPromise = loadScript("lib/tesseract/tesseract.min.js").then(() =>
      Tesseract.createWorker("fra", 1, {
        workerPath: "lib/tesseract/worker.min.js",
        corePath: "lib/tesseract/tesseract-core-lstm.wasm.js",
        langPath: "lib/tesseract/lang",
        workerBlobURL: false,
        logger: (m) => ocrProgress && m.status === "recognizing text" && ocrProgress(Math.round(m.progress * 100)),
      }),
    ).catch((e) => {
      ocrWorkerPromise = null;
      throw e;
    });
  return ocrWorkerPromise;
}
let ocrProgress = null;
/* Texte brut d'une image (une orientation) */
async function ocrImage(src, onProgress) {
  const worker = await getOcrWorker(onProgress);
  const img = await loadImageSource(src);
  const { data } = await worker.recognize(prepCanvas(img));
  return data.text || "";
}
/* Seuillage adaptatif (moyenne locale) : sépare le texte d'un fond brillant ou irrégulier */
function adaptiveThreshold(c, k = 0.88) {
  const g = c.getContext("2d", { willReadFrequently: true }),
    W = c.width,
    H = c.height,
    im = g.getImageData(0, 0, W, H),
    d = im.data,
    I = new Uint32Array((W + 1) * (H + 1)),
    r = Math.max(8, Math.round(W / 40));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += d[(y * W + x) * 4];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r),
      y1 = Math.min(H, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r),
        x1 = Math.min(W, x + r),
        sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0],
        i = (y * W + x) * 4,
        v = d[i] < (sum / ((x1 - x0) * (y1 - y0))) * k ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  g.putImageData(im, 0, 0);
  return c;
}
/* Plausibilité d'une valeur selon le type d'aliment (humide si humidité > 50 %) */
function plausible(k, v, humidity) {
  if (v === null || v === undefined) return false;
  if (humidity === null || humidity === undefined) return true;
  const wet = humidity > 50,
    lim = wet ? { protein: 25, fat: 18, fiber: 4, ash: 6, calcium: 1.5, phosphorus: 1.2 } : { protein: 75, fat: 45, fiber: 15, ash: 13, calcium: 4, phosphorus: 3 };
  return lim[k] === undefined || v <= lim[k];
}
function sanitizeLabel(d) {
  const h = d.humidity;
  for (const k of ["protein", "fat", "fiber", "ash", "calcium", "phosphorus"]) if (d[k] !== undefined && d[k] !== null && !plausible(k, d[k], h)) d[k] = null;
  const sum = ["protein", "fat", "fiber", "ash", "humidity"].reduce((s, k) => s + (+d[k] || 0), 0);
  if (sum > 101) d.ash = null; // incohérent : la valeur la plus souvent mal lue
  return d;
}
const LABEL_KEYS = ["protein", "fat", "fiber", "ash", "humidity", "kcal100", "calcium", "phosphorus", "taurine", "portion", "omega3", "omega6"];
/* Lecture d'étiquette : 1) trouve le bon sens, 2) relit avec d'autres réglages et fusionne,
   jusqu'à avoir protéines, matières grasses, cellulose, cendres et humidité. */
async function ocrLabel(src, onProgress) {
  const worker = await getOcrWorker();
  const img = await loadImageSource(src);
  const merged = {};
  const merge = (pl) => {
    const h = merged.humidity ?? pl.humidity;
    for (const k of LABEL_KEYS)
      if ((merged[k] === null || merged[k] === undefined) && pl[k] !== null && pl[k] !== undefined && plausible(k, pl[k], h)) merged[k] = pl[k];
    sanitizeLabel(merged);
  };
  const complete = () => ["protein", "fat", "fiber", "ash", "humidity"].every((k) => merged[k] !== null && merged[k] !== undefined);
  const run = async (canvas, psm, phase) => {
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    ocrProgress = (pct) => onProgress && onProgress(pct, phase);
    const { data } = await worker.recognize(canvas);
    return data.text || "";
  };
  try {
    let best = { score: -1, deg: 0 };
    const angles = [0, 90, 270, 180];
    for (let i = 0; i < angles.length; i++) {
      const text = await run(prepCanvas(img, angles[i], 1800), "3", i ? `recherche du sens ${i + 1}/4` : "");
      const pl = parseLabel(text),
        sc = labelScore(pl, text);
      if (sc > best.score) best = { score: sc, deg: angles[i] };
      if (sc > 0) merge(pl);
      if (sc >= 3) break;
    }
    const variants = [
      [() => adaptiveThreshold(prepCanvas(img, best.deg, 2600)), "3"],
      [() => prepCanvas(img, best.deg, 2600), "4"],
      [() => adaptiveThreshold(prepCanvas(img, best.deg, 2600)), "11"],
      [() => adaptiveThreshold(prepCanvas(img, best.deg, 2600), 0.8), "6"],
    ];
    for (let i = 0; i < variants.length && !complete(); i++) merge(parseLabel(await run(variants[i][0](), variants[i][1], `lecture détaillée ${i + 1}/${variants.length}`)));
    return { data: merged, score: best.score };
  } finally {
    worker.setParameters({ tessedit_pageseg_mode: "3" }).catch(() => {});
  }
}
function labelScore(parsed, text) {
  const found = ["protein", "fat", "fiber", "ash", "humidity", "kcal100"].filter((k) => parsed[k] !== null && parsed[k] !== undefined).length;
  const words = (noAccents(text).match(/constituant|proteine|grasse|cendre|cellulose|humidite|energie|kcal/g) || []).length;
  return found * 2 + Math.min(words, 6) * 0.5;
}
const noAccents = (x) =>
  String(x)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
/* Analyse tolérante du texte (accents ignorés, mots partiels, erreurs d'OCR courantes) */
function parseLabel(raw) {
  const t = noAccents(raw)
    .replace(/[ \t]+/g, " ")
    .replace(/(\d) ?[,.] ?(\d)/g, "$1.$2")
    .replace(/(\d)\s*o\b/g, "$10"); // « 8o » → 80
  const val = "(\\d+(?:\\.\\d+)?)";
  const fix = (s) => {
    if (s === null) return null;
    // « 04 % » lu sans la virgule → 0.4
    return /^0\d+$/.test(s) ? parseFloat("0." + s.slice(1)) : parseFloat(s);
  };
  const grab = (key, min, max, gap = 28) => {
    const re = new RegExp(`(?:${key})[^0-9\\n]{0,${gap}}?${val}`, "g");
    let m;
    while ((m = re.exec(t))) {
      const v = fix(m[1]);
      if (v !== null && v >= min && v <= max) return v;
    }
    return null;
  };
  const out = {
    protein: grab("prot[a-z]*", 0.5, 75),
    fat: grab("grass?[a-z]*|graiss[a-z]*|lipid[a-z]*|fat\\b", 0.1, 45),
    fiber: grab("cellul[a-z]*|ellulo[a-z]*|fibr[a-z]*", 0, 20),
    ash: grab("cendr[a-z]*|endres|\\bdres\\b|matieres? minerales?|matiere inorganique", 0, 20),
    humidity: grab("humid[a-z]*|umidit[a-z]*|midite|nidite|moisture", 1, 90, 18),
    calcium: grab("calci[a-z]*", 0, 5, 18),
    phosphorus: grab("phosph[a-z]*|hosph[a-z]*", 0, 5, 18),
    omega3: grab("omega[ -]?3", 0, 10, 12),
    omega6: grab("omega[ -]?6", 0, 15, 12),
  };
  const tau = t.match(new RegExp(`taurine\\s*(?:\\([^)]*\\))?[^0-9\\n]{0,6}${val}\\s*mg`));
  if (tau) out.taurine = tau[1] + " mg/kg";
  let m = t.match(new RegExp(`${val}\\s*k?cal\\w*\\s*(?:\\/|par|pour)?\\s*(100 ?g|kg)`));
  if (m) out.kcal100 = m[2] === "kg" ? toNum(m[1]) / 10 : toNum(m[1]);
  else {
    m = t.match(new RegExp(`${val}\\s*kj\\s*(?:\\/|par|pour)?\\s*(100 ?g|kg)`));
    if (m) out.kcal100 = (m[2] === "kg" ? toNum(m[1]) / 10 : toNum(m[1])) / 4.184;
  }
  if (out.kcal100 !== undefined && !(out.kcal100 > 20 && out.kcal100 < 600)) delete out.kcal100;
  // poids d'une portion : « poids net 85 g », « 4 x 57 g », « (85g/jour) », sinon « 85 g » isolé (pas « /100g »)
  const pn = t.match(/poids net[^0-9\n]{0,15}(?:\d+\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*g\b/);
  const mult = t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*g\b/);
  const single = [...t.matchAll(/(^|[^\/\d.])(\d{2,3})\s*g\b/g)].map((x) => +x[2]).find((g) => g >= 20 && g <= 200);
  out.portion = pn ? +pn[1] : mult ? +mult[2] : single || null;
  return out;
}

/* ---------- Scanner de code-barres ---------- */
// Boucle maison : caméra en haute résolution, analyse de la seule zone du cadre,
// deux méthodes de binarisation, plusieurs échelles. Boutons de secours dans l'écran.
let scanSession = null;
function stopScanner() {
  if (scanSession) {
    scanSession.stopped = true;
    clearTimeout(scanSession.timer);
    scanSession.stream?.getTracks().forEach((t) => t.stop());
    scanSession = null;
  }
  document.getElementById("scanOverlay")?.remove();
}
function eanValid(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
  const d = code.padStart(code.length === 8 ? 8 : 13, "0").split("").map(Number),
    check = d.pop();
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
function eanReader() {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
    ZXing.BarcodeFormat.EAN_13,
    ZXing.BarcodeFormat.EAN_8,
    ZXing.BarcodeFormat.UPC_A,
    ZXing.BarcodeFormat.UPC_E,
  ]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return reader;
}
/* Netteté + contraste pour les images floues : niveaux de gris, étirement
   de l'histogramme, puis masque flou (unsharp) horizontal + vertical. */
function enhanceCanvas(src, amount = 1.6) {
  const w = src.width,
    h = src.height,
    g = src.getContext("2d", { willReadFrequently: true }),
    im = g.getImageData(0, 0, w, h),
    d = im.data,
    y = new Float32Array(w * h);
  let lo = 255,
    hi = 0;
  for (let i = 0, j = 0; j < y.length; i += 4, j++) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    y[j] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(1, hi - lo),
    r = 2,
    blur = new Float32Array(w * h),
    tmp = new Float32Array(w * h);
  for (let row = 0; row < h; row++)
    for (let x = 0; x < w; x++) {
      let s = 0,
        n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) {
          s += y[row * w + xx];
          n++;
        }
      }
      tmp[row * w + x] = s / n;
    }
  for (let row = 0; row < h; row++)
    for (let x = 0; x < w; x++) {
      let s = 0,
        n = 0;
      for (let k = -1; k <= 1; k++) {
        const rr = row + k;
        if (rr >= 0 && rr < h) {
          s += tmp[rr * w + x];
          n++;
        }
      }
      blur[row * w + x] = s / n;
    }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const og = out.getContext("2d"),
    oim = og.createImageData(w, h),
    od = oim.data;
  for (let j = 0, i = 0; j < y.length; j++, i += 4) {
    let v = ((y[j] + amount * (y[j] - blur[j]) - lo) / span) * 255;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    od[i] = od[i + 1] = od[i + 2] = v;
    od[i + 3] = 255;
  }
  og.putImageData(oim, 0, 0);
  return out;
}
function decodeCanvas(reader, c, binarizers = [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer], enhance = true) {
  const tryOne = (cv) => {
    const lum = new ZXing.HTMLCanvasElementLuminanceSource(cv);
    for (const Bin of binarizers) {
      try {
        return reader.decode(new ZXing.BinaryBitmap(new Bin(lum))).getText();
      } catch (e) {}
    }
    return null;
  };
  return tryOne(c) || (enhance ? tryOne(enhanceCanvas(c)) || tryOne(enhanceCanvas(c, 3)) : null);
}
/* Résout avec : un code (texte), "photo", "type" ou null (fermé). */
async function scanBarcode() {
  await loadScript("lib/zxing/zxing.min.js");
  const reader = eanReader();
  const ov = document.createElement("div");
  ov.id = "scanOverlay";
  ov.className = "scanoverlay";
  ov.innerHTML = `<video id="scanVideo" playsinline muted autoplay></video><div class="scanframe"></div><div class="scanhint" id="scanHint">Place le code-barres dans le cadre, à environ 15–20 cm</div><div class="scanactions"><button class="btn" id="scanPhoto">📸 Prendre une photo</button><button class="btn" id="scanType">🔢 Saisir</button></div><button class="pdfclose" id="scanClose" aria-label="Fermer">×</button>`;
  document.body.appendChild(ov);
  const video = document.getElementById("scanVideo");
  return new Promise(async (resolve, reject) => {
    const session = (scanSession = { stopped: false });
    const finish = (v) => {
      stopScanner();
      resolve(v);
    };
    document.getElementById("scanClose").onclick = () => finish(null);
    document.getElementById("scanType").onclick = () => finish("type");
    document.getElementById("scanPhoto").onclick = () => {
      document.getElementById("afBarFile")?.click(); // dans le geste de l'utilisateur (exigence iOS)
      finish("photo");
    };
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" }],
        },
      });
    } catch (e) {
      stopScanner();
      return reject(e);
    }
    if (session.stopped) return session.stream.getTracks().forEach((t) => t.stop());
    const track = session.stream.getVideoTracks()[0];
    try {
      const cap = track.getCapabilities?.() || {};
      const adv = {};
      if (cap.focusMode?.includes?.("continuous")) adv.focusMode = "continuous";
      if (cap.zoom && cap.zoom.max >= 1.5) adv.zoom = Math.min(cap.zoom.max, 2);
      if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] });
    } catch (e) {}
    video.srcObject = session.stream;
    try {
      await video.play();
    } catch (e) {}
    const c = document.createElement("canvas"),
      g = c.getContext("2d", { willReadFrequently: true });
    const started = Date.now();
    let n = 0;
    const tick = () => {
      if (session.stopped) return;
      const vw = video.videoWidth,
        vh = video.videoHeight;
      if (vw && vh) {
        // zone centrale (le cadre fait ~78 % × 28 % de l'écran ; on prend large)
        const sw = vw * 0.9,
          sh = vh * 0.5,
          sx = (vw - sw) / 2,
          sy = (vh - sh) / 2;
        const sizes = n % 2 === 0 ? [1280] : [800];
        for (const maxW of sizes) {
          const scale = Math.min(1, maxW / sw);
          c.width = Math.round(sw * scale);
          c.height = Math.round(sh * scale);
          g.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
          const code = decodeCanvas(reader, c);
          if (code && eanValid(code)) {
            navigator.vibrate?.(60);
            return finish(code);
          }
        }
        if (n % 3 === 2) {
          // code-barres tenu à la verticale
          const sw2 = vw * 0.5,
            sh2 = vh * 0.9;
          const scale = Math.min(1, 1000 / sh2);
          c.width = Math.round(sh2 * scale);
          c.height = Math.round(sw2 * scale);
          g.save();
          g.translate(c.width / 2, c.height / 2);
          g.rotate(-Math.PI / 2);
          g.drawImage(video, (vw - sw2) / 2, (vh - sh2) / 2, sw2, sh2, -c.height / 2, -c.width / 2, c.height, c.width);
          g.restore();
          const code = decodeCanvas(reader, c);
          if (code && eanValid(code)) {
            navigator.vibrate?.(60);
            return finish(code);
          }
        }
        n++;
        if (Date.now() - started > 7000) {
          const h = document.getElementById("scanHint");
          if (h && !h.dataset.slow) {
            h.dataset.slow = "1";
            h.textContent = "Difficile ? Recule un peu (20 cm), ou utilise « Prendre une photo ».";
            document.getElementById("scanPhoto").classList.add("primary");
          }
        }
      }
      session.timer = setTimeout(tick, 80);
    };
    tick();
  });
}
/* Repli : lire les chiffres imprimés sous le code-barres (OCR), validés par la clé de contrôle */
function findEanInText(text) {
  for (const line of String(text).split(/\n/)) {
    const digits = line.replace(/[oO]/g, "0").replace(/[^\d]/g, "");
    for (const len of [13, 8, 12])
      for (let i = 0; i + len <= digits.length; i++) {
        const cand = digits.slice(i, i + len);
        if (eanValid(cand)) return cand;
      }
  }
  return null;
}
async function decodeBarcodeFromFile(file, onStatus) {
  await loadScript("lib/zxing/zxing.min.js");
  const img = await loadImageSource(file);
  const reader = eanReader();
  const tryC = (c) => {
    const r = decodeCanvas(reader, c);
    return r && eanValid(r) ? r : null;
  };
  // 4 sens × plusieurs tailles, puis bandes qui se chevauchent dans chaque sens
  for (const deg of [0, 90, 270, 180])
    for (const size of [1600, 1000]) {
      const r = tryC(prepCanvas(img, deg, size, false));
      if (r) return r;
    }
  for (const deg of [0, 90]) {
    const c = prepCanvas(img, deg, 1600, false);
    for (let i = 0; i < 7; i++) {
      const band = document.createElement("canvas"),
        h = Math.round(c.height / 4);
      band.width = c.width;
      band.height = h;
      band.getContext("2d").drawImage(c, 0, Math.round((c.height * i) / 8), c.width, h, 0, 0, c.width, h);
      const r = tryC(band);
      if (r) return r;
    }
  }
  // dernier recours : lire les chiffres sous les barres
  onStatus && onStatus("Barres illisibles, lecture des chiffres sous le code…");
  for (const deg of [0, 90, 270]) {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(prepCanvas(img, deg));
    const code = findEanInText(data.text || "");
    if (code) return code;
  }
  throw new Error("illisible");
}

/* ---------- Intégration au formulaire « Ajouter un aliment » ---------- */
function autofillHtml() {
  return `<div class="autofill"><div class="autofilltitle">⚡ Remplir automatiquement</div><div class="autofillgrid"><button class="btn" id="afScan">📷 Scanner<br><small>code-barres</small></button><button class="btn" id="afLabel">🏷️ Photo<br><small>de l’étiquette</small></button><button class="btn" id="afCode">🔢 Saisir<br><small>le code</small></button></div><input id="afLabelFile" type="file" accept="image/*" capture="environment" class="hidden"><input id="afBarFile" type="file" accept="image/*" capture="environment" class="hidden"><div class="note" id="afStatus"></div></div>`;
}
function setField(id, value, { overwrite = true } = {}) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined || value === "") return false;
  if (!overwrite && el.value) return false;
  el.value = typeof value === "number" ? String(round(value, 3)) : value;
  el.classList.add("autofilled");
  setTimeout(() => el.classList.remove("autofilled"), 2500);
  return true;
}
function applyFoodData(d, source) {
  const filled = [];
  const put = (id, v, label) => {
    if (setField(id, v)) filled.push(label);
  };
  put("fname", d.name, "nom");
  put("fbrand", d.brand, "marque");
  if (d.type) document.getElementById("ftype").value = d.type;
  put("fprotein", d.protein, "protéines");
  put("ffat", d.fat, "matières grasses");
  put("ffiber", d.fiber, "fibres");
  put("fash", d.ash, "cendres");
  put("fhumidity", d.humidity, "humidité");
  put("fcalcium", d.calcium, "calcium");
  put("fphosphorus", d.phosphorus, "phosphore");
  put("fomega3", d.omega3, "oméga 3");
  put("fomega6", d.omega6, "oméga 6");
  put("fena", d.ena, "glucides");
  put("ftaurine", d.taurine, "taurine");
  // Énergie : réelle si connue, sinon estimée à partir des constituants
  let kcal100 = d.kcal100 ?? null,
    estimated = false;
  if (kcal100 === null) {
    kcal100 = estimateKcal100(readComposition());
    estimated = kcal100 !== null;
  }
  const portion = d.portion ?? toNum(document.getElementById("fportion").value);
  const hum = d.humidity ?? toNum(document.getElementById("fhumidity").value);
  const wet = (hum !== null && hum > 40) || (portion !== null && portion <= 200 && d.type !== "Croquettes");
  if (portion) setField("fportion", portion);
  if (wet && portion && d.type !== "Croquettes") {
    document.getElementById("fmode").value = "portion";
    if (!document.getElementById("fusual").value) setField("fusual", "1 portion");
  }
  if (kcal100 !== null) {
    if (wet && portion) {
      document.getElementById("fmode").value = "portion";
      setField("fkcal", round((kcal100 * portion) / 100, 0));
      if (!document.getElementById("fusual").value) setField("fusual", "1 portion");
    } else {
      document.getElementById("fmode").value = "g";
      setField("fkcal", round(kcal100 / 100, 3));
    }
    filled.push(estimated ? "kcal (estimées)" : "kcal");
  }
  const st = document.getElementById("afStatus");
  st.innerHTML = filled.length
    ? `✅ ${esc(source)} : ${esc(filled.join(", "))}.${estimated ? "<br>Les kcal sont <strong>estimées</strong> à partir des constituants (méthode NRC) : vérifie-les si l’emballage indique une valeur." : ""}<br>Vérifie les champs surlignés avant d’enregistrer.`
    : `⚠️ ${esc(source)} : aucune valeur reconnue. Complète à la main.`;
  return filled.length;
}
function readComposition() {
  const g = (id) => toNum(document.getElementById(id)?.value);
  return {
    protein: g("fprotein"),
    fat: g("ffat"),
    fiber: g("ffiber"),
    ash: g("fash"),
    humidity: g("fhumidity"),
    ena: g("fena"),
  };
}
let afBarcode = "";
function hasComposition(d) {
  return d && d.protein !== null && d.protein !== undefined && d.fat !== null && d.fat !== undefined;
}
/* Produit déjà enregistré dans Cats (l'un ou l'autre chat) avec ce code-barres */
function findLocalFood(code) {
  for (const [catId, cat] of Object.entries(rootState.cats || {}))
    for (const f of cat.foods || []) {
      const bc = f.barcode || (String(f.notes || "").match(/Code-barres\s*:\s*(\d{8,14})/) || [])[1];
      if (bc === code) return { food: f, cat: cat.profile?.nickname || catId };
    }
  return null;
}
function fillFromLocal(f) {
  const map = {
    fname: f.name,
    fbrand: f.brand,
    fkcal: f.kcal,
    fportion: f.portionWeight,
    fusual: f.usualPortion,
    fhumidity: f.humidity,
    fprotein: f.protein,
    ffat: f.fat,
    ffiber: f.fiber,
    fash: f.ash,
    fcalcium: f.calcium,
    fphosphorus: f.phosphorus,
    fomega3: f.omega3,
    fomega6: f.omega6,
    fena: f.ena,
    ftaurine: f.taurine,
  };
  for (const [id, v] of Object.entries(map)) setField(id, v);
  if (f.type) document.getElementById("ftype").value = f.type;
  if (f.mode) document.getElementById("fmode").value = f.mode;
}
/* Lien vers la page d'ajout / de modification du produit sur Open Pet Food Facts */
function contributeUrl(code, host = "world.openpetfoodfacts.org", exists = false) {
  return `https://${host}/cgi/product.pl?type=${exists ? "edit" : "add"}&code=${encodeURIComponent(code)}`;
}
let lastLookup = null; // { code, host, exists }
function contributeLink(label = "🌍 Compléter sur Open Pet Food Facts") {
  if (!lastLookup) return "";
  return `<a class="btn full contriblink" href="${esc(contributeUrl(lastLookup.code, lastLookup.host, lastLookup.exists))}" target="_blank" rel="noopener">${label}</a>`;
}
/* Texte prêt à coller dans le formulaire Open Pet Food Facts */
function foodValuesText(f) {
  const rows = [
    ["Humidité", f.humidity, "%"],
    ["Protéines", f.protein, "%"],
    ["Matières grasses", f.fat, "%"],
    ["Cellulose brute", f.fiber, "%"],
    ["Cendres brutes", f.ash, "%"],
    ["Calcium", f.calcium, "%"],
    ["Phosphore", f.phosphorus, "%"],
    ["Oméga 3", f.omega3, "%"],
    ["Oméga 6", f.omega6, "%"],
    ["Taurine", f.taurine, ""],
  ].filter((r) => r[1] !== null && r[1] !== undefined && r[1] !== "");
  const kcal100 = f.kcal ? (f.mode === "g" ? f.kcal * 100 : f.portionWeight ? (f.kcal / f.portionWeight) * 100 : null) : null;
  const lines = [`${f.name}${f.brand ? " — " + f.brand : ""}`, "Constituants analytiques : " + rows.map((r) => `${r[0]} ${r[1]}${r[2] && !String(r[1]).includes(r[2]) ? " " + r[2] : ""}`).join(", ")];
  if (kcal100) lines.push(`Énergie : ${Math.round(kcal100)} kcal/100 g`);
  if (f.portionWeight) lines.push(`Poids d’une portion : ${f.portionWeight} g`);
  return lines.join("\n");
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
function askLabelPhoto(prefix) {
  const st = document.getElementById("afStatus");
  st.innerHTML = `${prefix}<br>Les constituants ne sont pas dans la base : prends l’étiquette en photo pour les lire.<button class="btn primary full" id="afLabelNow" style="margin-top:10px">🏷️ Photographier l’étiquette</button>${contributeLink()}<div class="note" style="margin-top:6px">Une fois l’aliment enregistré, tu pourras aussi copier ses valeurs depuis sa fiche pour compléter la base : tout le monde en profitera, et Cats le retrouvera automatiquement.</div>`;
  document.getElementById("afLabelNow").onclick = () => document.getElementById("afLabelFile").click();
}
async function fillFromBarcode(code) {
  const st = document.getElementById("afStatus");
  code = String(code || "").replace(/\D/g, "");
  if (code.length < 8) {
    st.textContent = "Code-barres invalide.";
    return;
  }
  afBarcode = code;
  setField("fnotes", `Code-barres : ${code}`, { overwrite: false });
  const local = findLocalFood(code);
  if (local) {
    fillFromLocal(local.food);
    st.innerHTML = `✅ Produit déjà enregistré dans Cats (${esc(local.cat)}) : toutes tes valeurs ont été reprises.`;
    return;
  }
  st.textContent = `🔎 Recherche du produit ${code}…`;
  if (!navigator.onLine) {
    st.textContent = "Pas de connexion internet : la recherche par code-barres nécessite le réseau.";
    return;
  }
  const p = await lookupBarcode(code);
  lastLookup = { code, host: p?._source || "world.openpetfoodfacts.org", exists: !!p };
  if (!p) return askLabelPhoto(`Produit ${esc(code)} introuvable dans Open Pet Food Facts.`);
  const source = p._source.includes("pet") ? "Open Pet Food Facts" : "Open Food Facts";
  const d = mapProduct(p);
  applyFoodData(d, source);
  if (hasComposition(d)) return;
  // Pas de constituants : on essaie de lire les photos de l'emballage déjà présentes sur la fiche
  for (const url of d.images) {
    st.textContent = "📷 Lecture des photos de la fiche produit…";
    try {
      const ocr = (await ocrLabel(url, (pct) => (st.textContent = `📷 Lecture des photos de la fiche produit… ${pct} %`))).data;
      if (hasComposition(ocr)) {
        ocr.portion = ocr.portion ?? d.portion;
        applyFoodData(ocr, `${source} (photo de la fiche)`);
        return;
      }
    } catch (e) {}
  }
  askLabelPhoto(`✅ ${esc(source)} : ${esc([d.name && "nom", d.brand && "marque", d.portion && "portion"].filter(Boolean).join(", ") || "produit trouvé")}.`);
}
function bindAutofill(current) {
  const st = document.getElementById("afStatus");
  afBarcode = current?.barcode || "";
  lastLookup = null;
  if (!st) return;
  document.getElementById("afScan").onclick = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("caméra indisponible");
      const code = await scanBarcode();
      if (code === "type") return document.getElementById("afCode").click();
      if (code && code !== "photo") await fillFromBarcode(code);
    } catch (e) {
      st.textContent = "Caméra indisponible ou refusée : prends plutôt une photo du code-barres.";
      document.getElementById("afBarFile").click();
    }
  };
  document.getElementById("afBarFile").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    st.textContent = "Lecture du code-barres…";
    try {
      await fillFromBarcode(await decodeBarcodeFromFile(f, (m) => (st.textContent = m)));
    } catch (err) {
      st.textContent = "Code-barres illisible sur la photo. Reprends-la bien nette (touche l’écran pour faire la mise au point), ou saisis le code.";
    }
  };
  document.getElementById("afCode").onclick = async () => {
    const code = prompt("Numéro sous le code-barres (13 chiffres) :");
    if (code) await fillFromBarcode(code);
  };
  document.getElementById("afLabel").onclick = () => document.getElementById("afLabelFile").click();
  document.getElementById("afLabelFile").onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    st.textContent = "🏷️ Lecture de l’étiquette… (la première fois, quelques secondes de chargement)";
    try {
      const d = (
        await ocrLabel(f, (pct, phase) => (st.textContent = `🏷️ Lecture de l’étiquette${phase ? " — " + phase : ""}… ${pct} %`))
      ).data;
      const n = applyFoodData(d, "Étiquette");
      if (!n) st.innerHTML += "<br>Astuce : photo nette, bien éclairée, cadrée sur « Constituants analytiques ».";
    } catch (err) {
      st.textContent = "Lecture impossible : " + (err?.message || err);
    }
  };
  document.getElementById("afEstimate")?.addEventListener("click", () => {
    const k = estimateKcal100(readComposition());
    if (k === null)
      return alert("Renseigne au moins protéines, matières grasses, cendres et humidité (ou glucides) pour estimer.");
    const portion = toNum(document.getElementById("fportion").value);
    if (document.getElementById("fmode").value === "portion" && portion) setField("fkcal", round((k * portion) / 100, 0));
    else setField("fkcal", round(k / 100, 3));
    st.innerHTML = `Estimation NRC : <strong>${Math.round(k)} kcal / 100 g</strong>.`;
  });
}
