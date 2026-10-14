/* =========================================================
   HABERS · Control de préstamo de muestras — app.js
   Firebase Web SDK modular (v10, compatible con la API v9+)
   ========================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, getDoc, updateDoc, onSnapshot, query, orderBy,
  runTransaction, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref as sRef, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

/* ---------------------------------------------------------
   1) CONFIGURACIÓN DE FIREBASE
   Pega aquí el objeto de tu proyecto:
   Consola Firebase → ⚙ Configuración del proyecto → Tus apps → SDK (Config)
   --------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyDQHNvUumdUiab3swQrURvVdqf6tkgBPyU",
  authDomain: "habers-muestras.firebaseapp.com",
  projectId: "habers-muestras",
  storageBucket: "habers-muestras.firebasestorage.app",
  messagingSenderId: "422538036878",
  appId: "1:422538036878:web:77316cfea6e55bb764ebdf"
  measurementId: "G-D20BGS0L1W"
};

/* 2) AJUSTES DE LA APP */
const AJUSTES = {
  // true  = las firmas se suben a Firebase Storage (requiere plan Blaze).
  // false = las firmas se guardan como imagen dentro del documento de Firestore.
  // Si Storage falla, la app usa Firestore automáticamente.
  usarStorage: true,
  prefijoFolio: "HAB-M-",
  diasDevolucionDefault: 7,
  vendedoresIniciales: ["Moisés Haber", "María José González", "Carmen Peñaloza", "Norma Hernández"],
  empresa: "Asociación Habers de México S.A. de C.V.",
  leyenda: "El cliente reconoce haber recibido las muestras descritas en buen estado y se compromete a devolverlas en la fecha indicada o, en su caso, a que se tomen a cuenta de pedido.",
};

/* =========================================================
   Utilidades
   ========================================================= */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MXN = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const NUM = new Intl.NumberFormat("es-MX");
const dinero = n => MXN.format(Number(n) || 0);
const numero = n => NUM.format(Number(n) || 0);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const slug = s => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hoyISO = () => isoLocal(new Date());
const sumarDias = (iso, n) => { const [y, m, d] = iso.split("-").map(Number); return isoLocal(new Date(y, m - 1, d + n)); };
const fechaCorta = iso => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const suma = (lista, fn) => lista.reduce((a, x) => a + (Number(fn(x)) || 0), 0);
const esVencido = p => p.estatus === "Prestado" && p.fechaDevolucion && p.fechaDevolucion < hoyISO();
const conTiempo = (promesa, ms) => Promise.race([promesa, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

let toastT;
function toast(msg, tipo = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast is-visible${tipo === "error" ? " toast-error" : ""}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = "toast"; }, 4200);
}
function mostrarBanner(msg) { const b = $("#banner"); b.textContent = msg; b.hidden = false; }

function setConn(estado) {
  const el = $("#conn");
  const textos = {
    conectando: "Conectando…",
    ok: "En línea · sincronizado",
    cache: "Sin conexión · copia local",
    error: "Error de conexión",
    config: "Falta configurar Firebase",
  };
  el.className = `conn ${estado}`;
  $(".conn-txt", el).textContent = textos[estado] || estado;
}

/* =========================================================
   Estado
   ========================================================= */
const state = {
  prestamos: [],
  vendedores: [],
  cargado: false,
  filtros: { desde: "", hasta: "", vendedor: "" },
  detalle: { busqueda: "", estatus: "todos", campo: "fechaSalida", dir: "desc" },
  firmas: { vendedor: null, receptor: null },
  admin: { desbloqueado: ss.get("habers_admin") === "1", existe: null },
};

let db = null, auth = null, storage = null, escuchando = false;

/* =========================================================
   Firebase
   ========================================================= */
function iniciarFirebase() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("Caché persistente no disponible, se usa memoria:", e);
    db = initializeFirestore(app, {});
  }
  if (AJUSTES.usarStorage) {
    try { storage = getStorage(app); } catch (e) { console.warn("Storage no disponible:", e); storage = null; }
  }

  onAuthStateChanged(auth, user => {
    if (user && !escuchando) { escuchando = true; escuchar(); prepararAdmin(); }
  });
  signInAnonymously(auth).catch(err => {
    console.error(err);
    setConn("error");
    mostrarBanner("No se pudo iniciar sesión en Firebase. Verifica que el proveedor «Anónimo» esté habilitado en Authentication y que este dominio esté autorizado (ver README).");
  });
}

function errorListener(err) {
  console.error(err);
  setConn("error");
  if (err.code === "permission-denied") {
    mostrarBanner("Firestore rechazó la lectura (permission-denied). Revisa que hayas publicado las reglas de seguridad del README.");
  } else {
    mostrarBanner(`Error de Firestore: ${err.message}`);
  }
}

function escuchar() {
  onSnapshot(query(collection(db, "vendedores"), orderBy("nombre")), snap => {
    state.vendedores = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (snap.empty && !snap.metadata.fromCache) sembrarVendedores();
    pintarVendedores();
    pintarDashboard();
  }, errorListener);

  onSnapshot(query(collection(db, "prestamos"), orderBy("fechaSalida", "desc")), { includeMetadataChanges: true }, snap => {
    state.prestamos = snap.docs.map(d => ({ id: d.id, _pendiente: d.metadata.hasPendingWrites, ...d.data() }));
    state.cargado = true;
    setConn(snap.metadata.fromCache && !navigator.onLine ? "cache" : "ok");
    pintarDashboard();
    pintarDetalle();
  }, errorListener);
}

async function sembrarVendedores() {
  const lote = writeBatch(db);
  AJUSTES.vendedoresIniciales.forEach(nombre => {
    lote.set(doc(db, "vendedores", slug(nombre)), { nombre, activo: true, creado: serverTimestamp() }, { merge: true });
  });
  try { await lote.commit(); } catch (e) { console.warn("No se pudieron crear los vendedores iniciales:", e); }
}

window.addEventListener("offline", () => setConn("cache"));
window.addEventListener("online", () => setConn(escuchando ? "ok" : "conectando"));

/* =========================================================
   Pestañas
   ========================================================= */
function irA(tab) {
  $$(".tab").forEach(b => {
    const activo = b.dataset.tab === tab;
    b.classList.toggle("is-active", activo);
    b.setAttribute("aria-selected", activo);
  });
  $$(".panel").forEach(p => {
    const activo = p.id === `tab-${tab}`;
    p.classList.toggle("is-active", activo);
    p.hidden = !activo;
  });
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  window.scrollTo({ top: 0 });
}
$$(".tab").forEach(b => b.addEventListener("click", () => irA(b.dataset.tab)));

/* =========================================================
   Vendedores (selects + admin)
   ========================================================= */
function pintarVendedores() {
  // Filtro del dashboard: todos (incluye inactivos con historial)
  const fSel = $("#f-vendedor");
  const fVal = fSel.value;
  fSel.innerHTML = `<option value="">Todos los vendedores</option>` +
    state.vendedores.map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}${v.activo ? "" : " (inactivo)"}</option>`).join("");
  fSel.value = state.vendedores.some(v => v.id === fVal) ? fVal : "";

  // Formulario: solo activos
  const sel = $("#vendedor");
  const val = sel.value;
  const activos = state.vendedores.filter(v => v.activo);
  sel.innerHTML = `<option value="">Selecciona…</option>` +
    activos.map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}</option>`).join("");
  sel.value = activos.some(v => v.id === val) ? val : "";

  // Lista de administración
  $("#lista-vendedores").innerHTML = state.vendedores.length
    ? state.vendedores.map(v => `
      <li class="${v.activo ? "" : "inactivo"}">
        <span class="v-nombre">${esc(v.nombre)}</span>
        <label class="switch">
          <input type="checkbox" data-vendedor="${esc(v.id)}" ${v.activo ? "checked" : ""}>
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          <span class="switch-txt">${v.activo ? "Activo" : "Inactivo"}</span>
        </label>
      </li>`).join("")
    : `<li class="muted">Aún no hay vendedores.</li>`;
}

async function sha256(txt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function prepararAdmin() {
  try {
    const snap = await getDoc(doc(db, "config", "admin"));
    state.admin.existe = snap.exists();
  } catch (e) {
    console.warn("No se pudo leer config/admin:", e);
    state.admin.existe = true; // asumimos que existe; se validará al entrar
  }
  pintarAdmin();
}

function pintarAdmin() {
  const ok = state.admin.desbloqueado;
  $("#admin-login").hidden = ok;
  $("#admin-body").hidden = !ok;
  $("#admin-cerrar").hidden = !ok;
  const primeraVez = state.admin.existe === false;
  $("#admin-pw2-wrap").hidden = !primeraVez;
  $("#admin-pw-lbl").textContent = primeraVez ? "Nueva contraseña (mín. 6 caracteres)" : "Contraseña";
  $("#admin-entrar").textContent = primeraVez ? "Crear contraseña" : "Entrar";
  $("#admin-ayuda").textContent = primeraVez
    ? "Primera vez: define la contraseña de administrador. Para cambiarla después, elimina el documento config/admin en la consola de Firebase."
    : "Ingresa la contraseña de administrador para agregar o desactivar vendedores.";
}

$("#admin-login").addEventListener("submit", async e => {
  e.preventDefault();
  if (!db) return toast("Configura Firebase primero.", "error");
  const pw = $("#admin-pw").value;
  const btn = $("#admin-entrar");
  btn.disabled = true;
  try {
    const ref = doc(db, "config", "admin");
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const pw2 = $("#admin-pw2").value;
      if (pw.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres.");
      if (pw !== pw2) throw new Error("Las contraseñas no coinciden.");
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
      await setDoc(ref, { salt, hash: await sha256(salt + pw), creado: serverTimestamp() });
      state.admin.existe = true;
      toast("Contraseña de administrador creada.");
    } else {
      const { salt, hash } = snap.data();
      if (await sha256(salt + pw) !== hash) throw new Error("Contraseña incorrecta.");
    }
    state.admin.desbloqueado = true;
    ss.set("habers_admin", "1");
    $("#admin-pw").value = ""; $("#admin-pw2").value = "";
    pintarAdmin();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

$("#admin-cerrar").addEventListener("click", () => {
  state.admin.desbloqueado = false;
  ss.del("habers_admin");
  pintarAdmin();
});

$("#admin-agregar").addEventListener("submit", async e => {
  e.preventDefault();
  const input = $("#nuevo-vendedor");
  const nombre = input.value.trim().replace(/\s+/g, " ");
  if (nombre.length < 3) return toast("Escribe el nombre completo del vendedor.", "error");
  const id = slug(nombre);
  const existente = state.vendedores.find(v => v.id === id);
  try {
    if (existente) {
      if (existente.activo) return toast(`${existente.nombre} ya está en la lista.`, "error");
      await updateDoc(doc(db, "vendedores", id), { activo: true });
      toast(`${existente.nombre} fue reactivado.`);
    } else {
      await setDoc(doc(db, "vendedores", id), { nombre, activo: true, creado: serverTimestamp() });
      toast(`${nombre} agregado.`);
    }
    input.value = "";
  } catch (err) {
    toast(`No se pudo guardar: ${err.message}`, "error");
  }
});

$("#lista-vendedores").addEventListener("change", async e => {
  const chk = e.target.closest("input[data-vendedor]");
  if (!chk) return;
  try {
    await updateDoc(doc(db, "vendedores", chk.dataset.vendedor), { activo: chk.checked });
  } catch (err) {
    chk.checked = !chk.checked;
    toast(`No se pudo actualizar: ${err.message}`, "error");
  }
});

/* =========================================================
   Dashboard
   ========================================================= */
function filtradosDashboard() {
  const { desde, hasta, vendedor } = state.filtros;
  return state.prestamos.filter(p =>
    (!desde || p.fechaSalida >= desde) &&
    (!hasta || p.fechaSalida <= hasta) &&
    (!vendedor || p.vendedorId === vendedor));
}

function pintarDashboard() {
  const lista = filtradosDashboard();
  const activos = lista.filter(p => p.estatus === "Prestado");
  const subs = lista.filter(p => p.estatus === "Subsidiado");
  const vencidos = activos.filter(esVencido);
  const conGarantia = activos.filter(p => Number(p.garantia) > 0);

  $("#k-prestado").textContent = dinero(suma(lista, p => p.totalValor));
  $("#k-prestado-n").textContent = `${numero(lista.length)} préstamos · ${numero(suma(lista, p => p.totalPiezas))} piezas`;
  $("#k-subsidiado").textContent = dinero(suma(subs, p => p.totalValor));
  $("#k-subsidiado-n").textContent = `${numero(subs.length)} préstamos a cuenta de pedido`;
  $("#k-garantia").textContent = dinero(suma(activos, p => p.garantia));
  $("#k-garantia-n").textContent = `En resguardo de ${numero(conGarantia.length)} préstamos activos`;
  $("#k-activas").textContent = numero(suma(activos, p => p.totalPiezas));
  $("#k-activas-n").textContent = `${numero(activos.length)} préstamos abiertos · ${numero(vencidos.length)} vencidos`;

  const { desde, hasta } = state.filtros;
  $("#m-rango").textContent = desde || hasta ? `${desde ? fechaCorta(desde) : "inicio"} – ${hasta ? fechaCorta(hasta) : "hoy"}` : "Todo el historial";

  // Agrupar por vendedor
  const mapa = new Map();
  state.vendedores.forEach(v => mapa.set(v.id, { nombre: v.nombre, activo: v.activo, n: 0, piezas: 0, monto: 0, calle: 0, garantia: 0 }));
  lista.forEach(p => {
    if (!mapa.has(p.vendedorId)) mapa.set(p.vendedorId, { nombre: p.vendedorNombre || "—", activo: false, n: 0, piezas: 0, monto: 0, calle: 0, garantia: 0 });
    const m = mapa.get(p.vendedorId);
    m.n++; m.piezas += Number(p.totalPiezas) || 0; m.monto += Number(p.totalValor) || 0;
    if (p.estatus === "Prestado") { m.calle += Number(p.totalPiezas) || 0; m.garantia += Number(p.garantia) || 0; }
  });
  let filas = [...mapa.entries()].filter(([id, m]) => m.activo || m.n > 0);
  if (state.filtros.vendedor) filas = filas.filter(([id]) => id === state.filtros.vendedor);
  filas.sort((a, b) => b[1].monto - a[1].monto || a[1].nombre.localeCompare(b[1].nombre));
  const totalMonto = filas.reduce((a, [, m]) => a + m.monto, 0);

  $("#tabla-vendedores tbody").innerHTML = filas.length ? filas.map(([, m]) => {
    const pct = totalMonto ? Math.round((m.monto / totalMonto) * 100) : 0;
    return `<tr>
      <td><strong>${esc(m.nombre)}</strong>${m.activo ? "" : ' <span class="muted small">(inactivo)</span>'}</td>
      <td class="num">${numero(m.n)}</td>
      <td class="num">${numero(m.piezas)}</td>
      <td class="num">${dinero(m.monto)}</td>
      <td class="num">${numero(m.calle)}</td>
      <td class="num">${dinero(m.garantia)}</td>
      <td><div class="part"><div class="barra" role="img" aria-label="${pct}% del monto"><span style="width:${pct}%"></span></div><small>${pct}%</small></div></td>
    </tr>`;
  }).join("") : `<tr><td class="vacio" colspan="7">${state.cargado ? "Sin registros en este rango." : "Cargando…"}</td></tr>`;
}

function aplicarFiltros() {
  state.filtros.desde = $("#f-desde").value;
  state.filtros.hasta = $("#f-hasta").value;
  state.filtros.vendedor = $("#f-vendedor").value;
  $$(".filtros .chip").forEach(c => c.classList.remove("is-active"));
  pintarDashboard();
}
["#f-desde", "#f-hasta", "#f-vendedor"].forEach(s => $(s).addEventListener("change", aplicarFiltros));
$$(".filtros .chip").forEach(chip => chip.addEventListener("click", () => {
  const hoy = new Date();
  const r = chip.dataset.rango;
  let desde;
  if (r === "mes") desde = isoLocal(new Date(hoy.getFullYear(), hoy.getMonth(), 1));
  else if (r === "anio") desde = isoLocal(new Date(hoy.getFullYear(), 0, 1));
  else desde = sumarDias(hoyISO(), -Number(r));
  $("#f-desde").value = desde;
  $("#f-hasta").value = hoyISO();
  aplicarFiltros();
  chip.classList.add("is-active");
}));
$("#f-limpiar").addEventListener("click", () => {
  $("#f-desde").value = ""; $("#f-hasta").value = ""; $("#f-vendedor").value = "";
  aplicarFiltros();
});

/* =========================================================
   Firma digital
   ========================================================= */
class FirmaPad {
  constructor(contenedor) {
    this.el = contenedor;
    this.clave = contenedor.dataset.firma;
    this.canvas = $("canvas", contenedor);
    this.ctx = this.canvas.getContext("2d");
    this.trazos = [];
    this.actual = null;
    this.bloqueado = false;
    this.w = 0; this.h = 0;

    this.canvas.addEventListener("pointerdown", e => this.inicio(e));
    this.canvas.addEventListener("pointermove", e => this.mover(e));
    ["pointerup", "pointercancel"].forEach(ev => this.canvas.addEventListener(ev, () => { this.actual = null; }));
    new ResizeObserver(() => this.ajustar()).observe(this.canvas);
    $('[data-accion="borrar"]', contenedor).addEventListener("click", () => this.borrar());
    $('[data-accion="guardar"]', contenedor).addEventListener("click", () => this.guardar());
  }
  ajustar() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redibujar();
  }
  punto(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  estilo(ctx) {
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 2.4; ctx.strokeStyle = "#1F1C18"; ctx.fillStyle = "#1F1C18";
  }
  inicio(e) {
    if (this.bloqueado) {
      toast("Firma guardada. Presiona «Borrar» para volver a firmar.");
      return;
    }
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.actual = [this.punto(e)];
    this.trazos.push(this.actual);
    this.el.classList.add("tiene-trazo");
    this.estilo(this.ctx);
    const p = this.actual[0];
    this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2); this.ctx.fill();
  }
  mover(e) {
    if (!this.actual) return;
    e.preventDefault();
    const eventos = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    this.estilo(this.ctx);
    for (const ev of eventos) {
      const a = this.actual[this.actual.length - 1];
      const b = this.punto(ev);
      this.actual.push(b);
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
    }
  }
  static pintar(ctx, trazos) {
    for (const t of trazos) {
      if (t.length === 1) { ctx.beginPath(); ctx.arc(t[0].x, t[0].y, 1.2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(t[0].x, t[0].y);
      for (let i = 1; i < t.length - 1; i++) {
        const mx = (t[i].x + t[i + 1].x) / 2, my = (t[i].y + t[i + 1].y) / 2;
        ctx.quadraticCurveTo(t[i].x, t[i].y, mx, my);
      }
      const u = t[t.length - 1]; ctx.lineTo(u.x, u.y); ctx.stroke();
    }
  }
  redibujar() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    this.estilo(this.ctx);
    FirmaPad.pintar(this.ctx, this.trazos);
  }
  exportar() {
    const ancho = 600, k = ancho / this.w;
    const c = document.createElement("canvas");
    c.width = ancho; c.height = Math.round(this.h * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(k, k);
    this.estilo(ctx);
    FirmaPad.pintar(ctx, this.trazos);
    return c.toDataURL("image/png");
  }
  guardar() {
    if (!this.trazos.length) return toast("Primero dibuja la firma.", "error");
    state.firmas[this.clave] = this.exportar();
    this.bloqueado = true;
    this.el.classList.add("is-guardada");
    $(".firma-estado", this.el).textContent = "Guardada ✓";
  }
  borrar() {
    this.trazos = []; this.actual = null; this.bloqueado = false;
    state.firmas[this.clave] = null;
    this.el.classList.remove("is-guardada", "tiene-trazo");
    $(".firma-estado", this.el).textContent = "Sin guardar";
    this.redibujar();
  }
}
const pads = $$(".firma").map(el => new FirmaPad(el));

/* =========================================================
   Formulario
   ========================================================= */
function agregarFilaMuestra(datos = {}) {
  const fila = document.createElement("div");
  fila.className = "muestra-fila";
  const n = $("#muestras").children.length + 1;
  fila.innerHTML = `
    <div class="field f-desc">
      <label class="lbl-movil" for="m-desc-${n}">Código / Descripción</label>
      <input type="text" id="m-desc-${n}" class="m-desc" maxlength="160" value="${esc(datos.descripcion || "")}" aria-label="Código o descripción de la muestra ${n}">
    </div>
    <div class="field">
      <label class="lbl-movil" for="m-cant-${n}">Cantidad</label>
      <input type="number" id="m-cant-${n}" class="m-cant num" min="1" step="1" inputmode="numeric" value="${esc(datos.cantidad ?? 1)}" aria-label="Cantidad">
    </div>
    <div class="field">
      <label class="lbl-movil" for="m-val-${n}">Valor unit. $</label>
      <input type="number" id="m-val-${n}" class="m-val num" min="0" step="0.01" inputmode="decimal" value="${esc(datos.valor ?? "")}" placeholder="0.00" aria-label="Valor unitario estimado">
    </div>
    <div class="m-subtotal">$0.00</div>
    <button type="button" class="m-quitar" aria-label="Quitar muestra" title="Quitar">×</button>`;
  $("#muestras").appendChild(fila);
  recalcular();
  return fila;
}

function leerMuestras() {
  return $$(".muestra-fila").map(f => ({
    descripcion: $(".m-desc", f).value.trim(),
    cantidad: Math.max(0, Math.floor(Number($(".m-cant", f).value) || 0)),
    valor: Math.max(0, Number($(".m-val", f).value) || 0),
  }));
}

function recalcular() {
  let piezas = 0, total = 0;
  $$(".muestra-fila").forEach(f => {
    const c = Math.max(0, Number($(".m-cant", f).value) || 0);
    const v = Math.max(0, Number($(".m-val", f).value) || 0);
    $(".m-subtotal", f).textContent = dinero(c * v);
    piezas += c; total += c * v;
  });
  $("#tot-piezas").textContent = numero(piezas);
  $("#tot-valor").textContent = dinero(total);
}

$("#add-muestra").addEventListener("click", () => $(".m-desc", agregarFilaMuestra()).focus());
$("#muestras").addEventListener("input", recalcular);
$("#muestras").addEventListener("click", e => {
  if (!e.target.closest(".m-quitar")) return;
  if ($$(".muestra-fila").length === 1) return toast("Debe haber al menos una muestra.", "error");
  e.target.closest(".muestra-fila").remove();
  recalcular();
});

// Sincronía switch ↔ estatus
function syncSwitchTxt() { $("#subsidiada-txt").textContent = $("#subsidiada").checked ? "Sí" : "No"; }
$("#subsidiada").addEventListener("change", () => {
  const chk = $("#subsidiada").checked;
  if (chk) $("#estatus").value = "Subsidiado";
  else if ($("#estatus").value === "Subsidiado") $("#estatus").value = "Prestado";
  syncSwitchTxt();
});
$("#estatus").addEventListener("change", () => {
  $("#subsidiada").checked = $("#estatus").value === "Subsidiado";
  syncSwitchTxt();
});

function valoresIniciales() {
  const hoy = hoyISO();
  $("#fechaSalida").value = hoy;
  $("#fechaDevolucion").value = sumarDias(hoy, AJUSTES.diasDevolucionDefault);
  $("#muestras").innerHTML = "";
  agregarFilaMuestra();
  $("#estatus").value = "Prestado";
  $("#subsidiada").checked = false;
  syncSwitchTxt();
  pads.forEach(p => p.borrar());
  $$("#form [aria-invalid]").forEach(el => el.removeAttribute("aria-invalid"));
}

$("#form").addEventListener("reset", () => setTimeout(valoresIniciales, 0));
$("#form").addEventListener("input", e => e.target.removeAttribute?.("aria-invalid"));

function leerFormulario() {
  const vendedorId = $("#vendedor").value;
  const vendedor = state.vendedores.find(v => v.id === vendedorId);
  const muestras = leerMuestras().filter(m => m.descripcion || m.valor);
  const estatus = $("#estatus").value;
  return {
    fechaSalida: $("#fechaSalida").value,
    fechaDevolucion: $("#fechaDevolucion").value,
    fechaDevolucionReal: estatus === "Devuelto" ? hoyISO() : null,
    vendedorId,
    vendedorNombre: vendedor?.nombre || "",
    cliente: {
      nombre: $("#clienteNombre").value.trim(),
      empresa: $("#clienteEmpresa").value.trim(),
      telefono: $("#clienteTelefono").value.trim(),
      correo: $("#clienteCorreo").value.trim(),
    },
    muestras,
    totalPiezas: muestras.reduce((a, m) => a + m.cantidad, 0),
    totalValor: Math.round(muestras.reduce((a, m) => a + m.cantidad * m.valor, 0) * 100) / 100,
    garantia: Math.max(0, Math.round((Number($("#garantia").value) || 0) * 100) / 100),
    subsidiada: $("#subsidiada").checked,
    estatus,
    notas: $("#notas").value.trim(),
  };
}

function validar(d) {
  const marcar = sel => { const el = $(sel); el.setAttribute("aria-invalid", "true"); return el; };
  let primero = null;
  const errores = [];
  const falla = (sel, msg) => { const el = marcar(sel); primero ??= el; errores.push(msg); };

  if (!d.fechaSalida) falla("#fechaSalida", "Indica la fecha de salida.");
  if (!d.fechaDevolucion) falla("#fechaDevolucion", "Indica la fecha estimada de devolución.");
  else if (d.fechaSalida && d.fechaDevolucion < d.fechaSalida) falla("#fechaDevolucion", "La devolución no puede ser antes de la salida.");
  if (!d.vendedorId) falla("#vendedor", "Selecciona el vendedor.");
  if (!d.cliente.nombre) falla("#clienteNombre", "Escribe el nombre del cliente.");
  if (d.cliente.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.cliente.correo)) falla("#clienteCorreo", "El correo no es válido.");

  const filas = $$(".muestra-fila");
  const validas = d.muestras.filter(m => m.descripcion && m.cantidad > 0);
  filas.forEach(f => {
    const desc = $(".m-desc", f), cant = $(".m-cant", f);
    if (!desc.value.trim() && filas.length === 1) { desc.setAttribute("aria-invalid", "true"); primero ??= desc; }
    if (desc.value.trim() && !(Number(cant.value) > 0)) { cant.setAttribute("aria-invalid", "true"); primero ??= cant; }
  });
  if (!validas.length || validas.length !== d.muestras.length) errores.push("Cada muestra necesita descripción y cantidad mayor a 0.");

  if (!state.firmas.vendedor) errores.push("Falta guardar la firma del vendedor.");
  if (!state.firmas.receptor) errores.push("Falta guardar la firma de quien recibe.");

  if (primero) primero.focus({ preventScroll: false });
  return errores[0] || null;
}

async function siguienteFolio() {
  try {
    const n = await conTiempo(runTransaction(db, async tx => {
      const ref = doc(db, "config", "contador");
      const snap = await tx.get(ref);
      const sig = (snap.exists() ? Number(snap.data().siguiente) || 1 : 1);
      tx.set(ref, { siguiente: sig + 1 }, { merge: true });
      return sig;
    }), 8000);
    return `${AJUSTES.prefijoFolio}${String(n).padStart(5, "0")}`;
  } catch (e) {
    // Sin conexión: folio basado en fecha y hora (único en la práctica)
    const d = new Date();
    const p = x => String(x).padStart(2, "0");
    return `${AJUSTES.prefijoFolio}${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
}

async function subirFirma(idPrestamo, clave, dataUrl) {
  if (!storage || !navigator.onLine) return dataUrl;
  try {
    const ref = sRef(storage, `firmas/${idPrestamo}/${clave}.png`);
    return await conTiempo(uploadString(ref, dataUrl, "data_url", { contentType: "image/png" }).then(() => getDownloadURL(ref)), 15000);
  } catch (e) {
    console.warn(`Storage no disponible para la firma ${clave}; se guarda en Firestore.`, e);
    return dataUrl;
  }
}

$("#form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!db) return toast("Configura Firebase en app.js antes de guardar.", "error");
  const datos = leerFormulario();
  const error = validar(datos);
  if (error) return toast(error, "error");

  const btn = $("#btn-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const refDoc = doc(collection(db, "prestamos"));
    const folio = await siguienteFolio();
    const firmas = {
      vendedor: await subirFirma(refDoc.id, "vendedor", state.firmas.vendedor),
      receptor: await subirFirma(refDoc.id, "receptor", state.firmas.receptor),
    };
    const registro = { ...datos, folio, firmas, creado: serverTimestamp(), actualizado: serverTimestamp() };
    const escritura = setDoc(refDoc, registro);
    escritura.catch(err => toast(`El registro ${folio} no se pudo sincronizar: ${err.message}`, "error"));
    try {
      await conTiempo(escritura, 6000);
      toast(`Préstamo ${folio} guardado.`);
    } catch {
      toast(`Préstamo ${folio} guardado en este equipo; se sincronizará al recuperar conexión.`);
    }
    abrirComprobante({ id: refDoc.id, ...registro });
    $("#form").reset();
  } catch (err) {
    console.error(err);
    toast(`No se pudo guardar: ${err.message}`, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Guardar préstamo";
  }
});

/* =========================================================
   Detalle (tabla tipo hoja de cálculo)
   ========================================================= */
const ordenadores = {
  folio: p => p.folio || "",
  fechaSalida: p => p.fechaSalida || "",
  fechaDevolucion: p => p.fechaDevolucion || "",
  vendedorNombre: p => norm(p.vendedorNombre),
  cliente: p => norm(p.cliente?.nombre),
  empresa: p => norm(p.cliente?.empresa),
  totalPiezas: p => Number(p.totalPiezas) || 0,
  totalValor: p => Number(p.totalValor) || 0,
  garantia: p => Number(p.garantia) || 0,
  estatus: p => p.estatus || "",
};

function filtradosDetalle() {
  const terminos = norm(state.detalle.busqueda.trim()).split(/\s+/).filter(Boolean);
  const est = state.detalle.estatus;
  const lista = state.prestamos.filter(p => {
    if (est === "vencido" && !esVencido(p)) return false;
    if (est !== "todos" && est !== "vencido" && p.estatus !== est) return false;
    if (!terminos.length) return true;
    const texto = norm([
      p.folio, p.vendedorNombre, p.cliente?.nombre, p.cliente?.empresa, p.cliente?.telefono, p.cliente?.correo,
      ...(p.muestras || []).map(m => m.descripcion), p.notas,
    ].join(" "));
    return terminos.every(t => texto.includes(t));
  });
  const fn = ordenadores[state.detalle.campo] || ordenadores.fechaSalida;
  const dir = state.detalle.dir === "asc" ? 1 : -1;
  return lista.sort((a, b) => {
    const x = fn(a), y = fn(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir || String(b.folio).localeCompare(String(a.folio));
  });
}

function resumenMuestras(p) {
  const m = p.muestras || [];
  if (!m.length) return "—";
  const primero = `${m[0].cantidad}× ${m[0].descripcion}`;
  return m.length > 1 ? `${primero} +${m.length - 1}` : primero;
}

function pintarDetalle() {
  const lista = filtradosDetalle();
  const total = suma(lista, p => p.totalValor);
  $("#d-conteo").textContent = `${numero(lista.length)} de ${numero(state.prestamos.length)} registros · ${dinero(total)}`;

  $$("#tabla-detalle th[data-orden]").forEach(th => {
    th.classList.remove("orden-asc", "orden-desc");
    th.removeAttribute("aria-sort");
    if (th.dataset.orden === state.detalle.campo) {
      th.classList.add(`orden-${state.detalle.dir}`);
      th.setAttribute("aria-sort", state.detalle.dir === "asc" ? "ascending" : "descending");
    }
  });

  $("#tabla-detalle tbody").innerHTML = lista.length ? lista.map(p => {
    const venc = esVencido(p);
    const titulo = (p.muestras || []).map(m => `${m.cantidad}× ${m.descripcion}`).join("\n");
    return `<tr class="${venc ? "is-vencido" : ""}">
      <td class="mono">${esc(p.folio)}${p._pendiente ? '<span class="pendiente-sync" title="Pendiente de sincronizar">●</span>' : ""}</td>
      <td>${fechaCorta(p.fechaSalida)}</td>
      <td>${fechaCorta(p.fechaDevolucion)}${venc ? '<span class="tag tag-danger">Vencido</span>' : ""}</td>
      <td>${esc(p.vendedorNombre)}</td>
      <td>${esc(p.cliente?.nombre)}</td>
      <td>${esc(p.cliente?.empresa || "—")}</td>
      <td class="muestras-cel" title="${esc(titulo)}">${esc(resumenMuestras(p))}</td>
      <td class="num">${numero(p.totalPiezas)}</td>
      <td class="num">${dinero(p.totalValor)}</td>
      <td class="num">${Number(p.garantia) ? dinero(p.garantia) : "—"}</td>
      <td>
        <select class="estatus-sel est-${esc(p.estatus)}" data-id="${esc(p.id)}" aria-label="Estatus de ${esc(p.folio)}">
          ${["Prestado", "Devuelto", "Subsidiado"].map(s => `<option ${s === p.estatus ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-ver="${esc(p.id)}">Ver ficha</button></td>
    </tr>`;
  }).join("") : `<tr><td class="vacio" colspan="12">${state.cargado ? "No hay registros que coincidan." : "Cargando registros…"}</td></tr>`;
}

let buscarT;
$("#d-buscar").addEventListener("input", e => {
  clearTimeout(buscarT);
  buscarT = setTimeout(() => { state.detalle.busqueda = e.target.value; pintarDetalle(); }, 150);
});
$("#d-estatus").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#d-estatus .chip").forEach(c => c.classList.toggle("is-active", c === chip));
  state.detalle.estatus = chip.dataset.estatus;
  pintarDetalle();
});
$("#tabla-detalle thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-orden]");
  if (!th) return;
  const campo = th.dataset.orden;
  if (state.detalle.campo === campo) state.detalle.dir = state.detalle.dir === "asc" ? "desc" : "asc";
  else { state.detalle.campo = campo; state.detalle.dir = ["totalPiezas", "totalValor", "garantia", "fechaSalida", "fechaDevolucion"].includes(campo) ? "desc" : "asc"; }
  pintarDetalle();
});
$("#tabla-detalle tbody").addEventListener("click", e => {
  const btn = e.target.closest("[data-ver]");
  if (!btn) return;
  const p = state.prestamos.find(x => x.id === btn.dataset.ver);
  if (p) abrirComprobante(p);
});
$("#tabla-detalle tbody").addEventListener("change", async e => {
  const sel = e.target.closest(".estatus-sel");
  if (!sel) return;
  const p = state.prestamos.find(x => x.id === sel.dataset.id);
  if (!p) return;
  const nuevo = sel.value;
  if (!confirm(`¿Cambiar el préstamo ${p.folio} de «${p.estatus}» a «${nuevo}»?`)) { sel.value = p.estatus; return; }
  const cambios = {
    estatus: nuevo,
    subsidiada: nuevo === "Subsidiado",
    fechaDevolucionReal: nuevo === "Devuelto" ? hoyISO() : null,
    actualizado: serverTimestamp(),
  };
  updateDoc(doc(db, "prestamos", p.id), cambios).catch(err => {
    toast(`No se pudo actualizar ${p.folio}: ${err.message}`, "error");
    pintarDetalle();
  });
  toast(`${p.folio} → ${nuevo}`);
});

/* Exportar CSV (abre directo en Excel, UTF-8 con BOM) */
$("#btn-exportar").addEventListener("click", () => {
  const lista = filtradosDetalle();
  if (!lista.length) return toast("No hay registros para exportar con estos filtros.", "error");
  const cols = [
    ["Folio", p => p.folio],
    ["Fecha salida", p => p.fechaSalida],
    ["Devolución estimada", p => p.fechaDevolucion],
    ["Devolución real", p => p.fechaDevolucionReal || ""],
    ["Vendedor", p => p.vendedorNombre],
    ["Cliente", p => p.cliente?.nombre],
    ["Empresa", p => p.cliente?.empresa],
    ["Teléfono", p => p.cliente?.telefono],
    ["Correo", p => p.cliente?.correo],
    ["Muestras", p => (p.muestras || []).map(m => `${m.cantidad} x ${m.descripcion} @ ${m.valor}`).join(" | ")],
    ["Piezas", p => p.totalPiezas],
    ["Valor total", p => p.totalValor],
    ["Garantía", p => p.garantia],
    ["Subsidiada", p => (p.subsidiada ? "Sí" : "No")],
    ["Estatus", p => p.estatus],
    ["Vencido", p => (esVencido(p) ? "Sí" : "No")],
    ["Notas", p => p.notas],
  ];
  const celda = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.map(c => celda(c[0])).join(","), ...lista.map(p => cols.map(c => celda(c[1](p))).join(","))].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `prestamos_muestras_habers_${hoyISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${numero(lista.length)} registros exportados.`);
});

/* =========================================================
   Comprobante (modal)
   ========================================================= */
let focoPrevio = null;
function abrirComprobante(p) {
  const firma = (url, etiqueta, nombre) => `
    <figure class="firma-img">
      ${url ? `<img src="${esc(url)}" alt="${esc(etiqueta)}">` : '<div class="firma-vacia">Sin firma</div>'}
      <figcaption>${esc(etiqueta)}${nombre ? `<br><strong>${esc(nombre)}</strong>` : ""}</figcaption>
    </figure>`;
  const dato = (dt, dd) => `<div><dt>${dt}</dt><dd>${dd || "—"}</dd></div>`;
  const venc = esVencido(p);

  $("#modal-cuerpo").innerHTML = `
    <div class="comp">
      <div class="comp-head">
        <div>
          <div class="brand-mark">HABERS<sup>®</sup></div>
          <div class="muted small">${esc(AJUSTES.empresa)}</div>
          <div class="muted small">Comprobante de préstamo de muestras</div>
        </div>
        <div class="comp-folio">
          <span class="muted small">Folio</span>
          <strong>${esc(p.folio)}</strong>
          <span class="badge est-${esc(p.estatus)}">${esc(p.estatus)}</span>
          ${venc ? '<span class="tag tag-danger">Vencido</span>' : ""}
        </div>
      </div>
      <dl class="comp-datos">
        ${dato("Fecha de salida", fechaCorta(p.fechaSalida))}
        ${dato("Devolución estimada", fechaCorta(p.fechaDevolucion))}
        ${dato("Devolución real", p.fechaDevolucionReal ? fechaCorta(p.fechaDevolucionReal) : "")}
        ${dato("Vendedor", esc(p.vendedorNombre))}
        ${dato("Cliente", esc(p.cliente?.nombre))}
        ${dato("Empresa", esc(p.cliente?.empresa))}
        ${dato("Teléfono", esc(p.cliente?.telefono))}
        ${dato("Correo", esc(p.cliente?.correo))}
        ${dato("Subsidiada / a cuenta de pedido", p.subsidiada ? "Sí" : "No")}
      </dl>
      <div class="tabla-wrap">
        <table class="tabla">
          <thead><tr><th>Código / Descripción</th><th class="num">Cantidad</th><th class="num">Valor unit.</th><th class="num">Subtotal</th></tr></thead>
          <tbody>
            ${(p.muestras || []).map(m => `<tr><td>${esc(m.descripcion)}</td><td class="num">${numero(m.cantidad)}</td><td class="num">${dinero(m.valor)}</td><td class="num">${dinero(m.cantidad * m.valor)}</td></tr>`).join("")}
          </tbody>
          <tfoot><tr><td>Total</td><td class="num">${numero(p.totalPiezas)}</td><td></td><td class="num">${dinero(p.totalValor)}</td></tr></tfoot>
        </table>
      </div>
      <div class="comp-resumen">
        <span>Valor estimado: <strong>${dinero(p.totalValor)}</strong></span>
        <span>Garantía recibida: <strong>${dinero(p.garantia)}</strong></span>
      </div>
      ${p.notas ? `<div class="comp-notas"><strong>Notas:</strong> ${esc(p.notas)}</div>` : ""}
      <div class="comp-firmas">
        ${firma(p.firmas?.vendedor, "Firma del vendedor", p.vendedorNombre)}
        ${firma(p.firmas?.receptor, "Firma de quien recibe", p.cliente?.nombre)}
      </div>
      <p class="comp-leyenda">${esc(AJUSTES.leyenda)}</p>
    </div>`;

  focoPrevio = document.activeElement;
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  $(".modal-caja").focus();
}
function cerrarModal() {
  $("#modal").hidden = true;
  document.body.style.overflow = "";
  focoPrevio?.focus?.();
}
$("#modal").addEventListener("click", e => { if (e.target.closest("[data-cerrar]")) cerrarModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#modal").hidden) cerrarModal(); });
$("#modal-imprimir").addEventListener("click", () => {
  document.body.classList.add("imprimiendo");
  window.print();
});
window.addEventListener("afterprint", () => document.body.classList.remove("imprimiendo"));

/* =========================================================
   Arranque
   ========================================================= */
valoresIniciales();
pintarDashboard();
pintarDetalle();
pintarAdmin();
const tabInicial = location.hash.replace("#", "");
if (["dashboard", "formulario", "detalle"].includes(tabInicial)) irA(tabInicial);

if (firebaseConfig.apiKey.startsWith("PEGA_")) {
  setConn("config");
  mostrarBanner("Falta configurar Firebase: abre app.js y pega la configuración de tu proyecto en «firebaseConfig» (ver README, paso 2).");
} else {
  setConn("conectando");
  iniciarFirebase();
}
