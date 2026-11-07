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
async function ocrImage(file, onProgress) {
  await loadScript("lib/tesseract/tesseract.min.js");
  const worker = await Tesseract.createWorker("fra", 1, {
    workerPath: "lib/tesseract/worker.min.js",
    corePath: "lib/tesseract/tesseract-core-lstm.wasm.js",
    langPath: "lib/tesseract/lang",
    workerBlobURL: false,
    logger: (m) => onProgress && m.status === "recognizing text" && onProgress(Math.round(m.progress * 100)),
  });
  try {
    const { data } = await worker.recognize(file);
    return data.text || "";
  } finally {
    worker.terminate();
  }
}
function parseLabel(raw) {
  const t = String(raw)
    .replace(/\s+/g, " ")
    .replace(/(\d) ?, ?(\d)/g, "$1.$2")
    .toLowerCase();
  const val = "(\\d+(?:\\.\\d+)?)";
  const grab = (re) => {
    const m = t.match(re);
    return m ? toNum(m[1]) : null;
  };
  const out = {
    protein: grab(new RegExp(`prot[ée]i?ne?s?(?: brutes?)?\\s*[:.\\-]?\\s*${val}\\s*%?`)),
    fat: grab(
      new RegExp(
        `(?:teneur en )?(?:mati[èe]res? grasses?|graisses?|lipides?)(?: brutes?)?(?: totales)?\\s*[:.\\-]?\\s*${val}`,
      ),
    ),
    fiber: grab(new RegExp(`(?:cellulose|fibres?)(?: brutes?| alimentaires?)?\\s*[:.\\-]?\\s*${val}`)),
    ash: grab(new RegExp(`(?:cendres?|mati[èe]res? (?:min[ée]rales|inorganiques))(?: brutes?)?\\s*[:.\\-]?\\s*${val}`)),
    humidity: grab(new RegExp(`humidit[ée]\\s*[:.\\-]?\\s*${val}`)),
    calcium: grab(new RegExp(`calcium\\s*[:.\\-]?\\s*${val}\\s*%`)),
    phosphorus: grab(new RegExp(`phosphore\\s*[:.\\-]?\\s*${val}\\s*%`)),
    omega3: grab(new RegExp(`om[ée]ga[ -]?3\\s*[:.\\-]?\\s*${val}`)),
    omega6: grab(new RegExp(`om[ée]ga[ -]?6\\s*[:.\\-]?\\s*${val}`)),
  };
  const tau = t.match(new RegExp(`taurine\\s*[:.\\-]?\\s*${val}\\s*mg`));
  if (tau) out.taurine = tau[1] + " mg/kg";
  let m = t.match(new RegExp(`${val}\\s*kcal\\s*(?:\\/|par|pour)?\\s*(100 ?g|kg)`));
  if (m) out.kcal100 = m[2] === "kg" ? toNum(m[1]) / 10 : toNum(m[1]);
  else {
    m = t.match(new RegExp(`${val}\\s*kj\\s*(?:\\/|par|pour)?\\s*(100 ?g|kg)`));
    if (m) out.kcal100 = (m[2] === "kg" ? toNum(m[1]) / 10 : toNum(m[1])) / 4.184;
  }
  out.portion = portionFromQuantity(t);
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
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const reader = eanReader();
    const W = img.naturalWidth,
      H = img.naturalHeight;
    const attempt = (sx, sy, sw, sh, maxW) => {
      const scale = Math.min(1, maxW / sw),
        c = document.createElement("canvas");
      c.width = Math.round(sw * scale);
      c.height = Math.round(sh * scale);
      c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const r = decodeCanvas(reader, c);
      return r && eanValid(r) ? r : null;
    };
    // image entière à plusieurs tailles, puis bandes horizontales qui se chevauchent
    for (const maxW of [1600, 1000, 640]) {
      const r = attempt(0, 0, W, H, maxW);
      if (r) return r;
    }
    for (let i = 0; i < 7; i++) {
      const r = attempt(0, Math.round((H * i) / 8), W, Math.round(H / 4), 1200);
      if (r) return r;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  // dernier recours : lire les chiffres sous les barres
  onStatus && onStatus("Barres illisibles, lecture des chiffres sous le code…");
  const code = findEanInText(await ocrImage(file));
  if (code) return code;
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
function askLabelPhoto(prefix) {
  const st = document.getElementById("afStatus");
  st.innerHTML = `${prefix}<br>Les constituants ne sont pas dans la base : prends l’étiquette en photo pour les lire.<button class="btn primary full" id="afLabelNow" style="margin-top:10px">🏷️ Photographier l’étiquette</button>`;
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
  if (!p) return askLabelPhoto(`Produit ${esc(code)} introuvable dans Open Pet Food Facts.`);
  const source = p._source.includes("pet") ? "Open Pet Food Facts" : "Open Food Facts";
  const d = mapProduct(p);
  applyFoodData(d, source);
  if (hasComposition(d)) return;
  // Pas de constituants : on essaie de lire les photos de l'emballage déjà présentes sur la fiche
  for (const url of d.images) {
    st.textContent = "📷 Lecture des photos de la fiche produit…";
    try {
      const ocr = parseLabel(await ocrImage(url, (pct) => (st.textContent = `📷 Lecture des photos de la fiche produit… ${pct} %`)));
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
      const text = await ocrImage(f, (pct) => (st.textContent = `🏷️ Lecture de l’étiquette… ${pct} %`));
      const d = parseLabel(text);
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
