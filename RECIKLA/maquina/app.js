/* =========================================================
   RECIKLA · MÁQUINA
   Visión artificial (COCO-SSD + MobileNet) + Supabase
   ========================================================= */

const CFG = window.RECIKLA_CONFIG;

const VISION = {
  scoreCoco: 0.45,
  areaMinima: 0.035,
  framesParaAceptar: 4,
  framesParaInvalido: 5,
  framesParaLimpiar: 6,
  intervaloMs: 170,
  confianzaMinima: 0.30
};

const CLASES_ENVASE = ['bottle', 'cup', 'wine glass', 'vase'];

const LEXICO = {
  vidrio:  ['beer bottle','wine bottle','whiskey jug','goblet','beer glass','vase','pitcher','water jug','measuring cup','wine','perfume','flask'],
  plastico:['pop bottle','soda bottle','water bottle','pill bottle','lotion','sunscreen','shampoo','plastic','nipple','jug','saltshaker'],
  lata:    ['milk can','can opener','hair spray','oil filter','cocktail shaker','beer can','tin can','pop can','bucket','pail','shaker','lighter']
};

const ETIQUETA = { plastico:'PLASTICO', vidrio:'VIDRIO', lata:'LATA' };
const ICONO    = { plastico:'🧴', vidrio:'🍾', lata:'🥤' };
const COLOR    = { plastico:'#38b6ff', vidrio:'#22e07a', lata:'#ffc043' };

const $ = id => document.getElementById(id);
const nf = n => new Intl.NumberFormat('es-CO').format(n || 0);

/* ------------------ ESTADO ------------------ */
const S = {
  usuario: null,          // { id, nombre, nombre_usuario, puntos }
  sesionId: null,
  tokenQR: null,
  conteo: { plastico:0, vidrio:0, lata:0 },
  puntosSesion: 0,
  sesionActiva: false,
  estado: 'ESPERANDO',
  bloqueado: false,
  buffer: [],
  framesVacios: 0,
  framesInvalido: 0,
  modelosListos: false,
  camaraLista: false,
  limiteAlcanzado: false
};

let db = null;              // cliente Supabase
let MODO_LOCAL = true;      // true = sin base de datos (demo offline)
let cocoModel = null, mobilenetModel = null;
let pollQR = null, timerQR = null, timerResumen = null;

const cropCanvas = document.createElement('canvas');
cropCanvas.width = 224; cropCanvas.height = 224;
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently:true });

/* =========================================================
   1. CONEXIÓN A SUPABASE
   ========================================================= */
function conectar() {
  const url = (CFG.SUPABASE_URL || '').trim();
  const key = (CFG.SUPABASE_ANON_KEY || '').trim();
  const listo = url.startsWith('https://') && !url.includes('TU-PROYECTO')
             && key.length > 30 && !key.includes('PEGA-AQUI');
  if (!listo || !window.supabase) {
    MODO_LOCAL = true;
    $('badgeConn').innerHTML = 'Modo <b>demo local</b>';
    $('badgeConn').classList.add('off');
    return;
  }
  db = window.supabase.createClient(url, key);
  MODO_LOCAL = false;
  $('badgeConn').innerHTML = 'Conectado a <b>Supabase</b>';
  $('badgeConn').classList.remove('off');
}

async function rpc(nombre, args) {
  const { data, error } = await db.rpc(nombre, args);
  if (error) throw new Error(error.message);
  return data;
}

function toast(msg, malo) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (malo ? ' bad' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.className = 'toast' + (malo ? ' bad' : ''), 3800);
}

/* =========================================================
   2. NAVEGACIÓN
   ========================================================= */
function mostrar(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function volverInicio() {
  clearInterval(timerResumen);
  S.usuario = null; S.sesionId = null; S.sesionActiva = false;
  S.conteo = { plastico:0, vidrio:0, lata:0 };
  S.puntosSesion = 0; S.limiteAlcanzado = false;
  S.buffer = []; S.bloqueado = false;
  $('inPhone').value = '';
  $('phoneError').textContent = '';
  pintarEstado('ESPERANDO', '');
  mostrar('screenHome');
  refrescarQR();
  refrescarMaquina();
}

/* =========================================================
   3. CÓDIGO QR DE INICIO RÁPIDO
   ========================================================= */
let qrObj = null;
async function refrescarQR() {
  clearInterval(pollQR); clearInterval(timerQR);
  const box = $('qrbox');
  box.innerHTML = '';

  let destino = CFG.URL_APP_MOVIL.replace(/\/+$/, '');
  let segundos = 180;

  if (!MODO_LOCAL) {
    try {
      const r = await rpc('crear_token_qr', { p_maquina_codigo: CFG.CODIGO_MAQUINA });
      S.tokenQR = r.token;
      destino += '/?vincular=' + r.token;
    } catch (e) {
      S.tokenQR = null;
      toast('No se pudo generar el QR: ' + e.message, true);
    }
  } else {
    S.tokenQR = null;
    destino += '/?demo=1';
  }

  try {
    qrObj = new QRCode(box, {
      text: destino, width: 150, height: 150,
      colorDark: '#07130d', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (e) { box.textContent = 'QR no disponible'; }

  if (!S.tokenQR) { $('qrTimer').textContent = MODO_LOCAL ? 'Modo demo · el QR abre la app móvil' : ''; return; }

  timerQR = setInterval(() => {
    segundos--;
    $('qrTimer').textContent = 'El código se renueva en ' + segundos + ' s';
    if (segundos <= 0) refrescarQR();
  }, 1000);

  // Consulta si alguien ya lo escaneó desde la app
  pollQR = setInterval(async () => {
    if (!S.tokenQR) return;
    try {
      const r = await rpc('estado_token_qr', { p_token: S.tokenQR });
      if (r.estado === 'vinculado' && r.usuario_id) {
        clearInterval(pollQR); clearInterval(timerQR);
        S.usuario = { id:r.usuario_id, nombre:r.nombre, nombre_usuario:r.nombre_usuario, puntos:r.puntos };
        toast('¡Hola ' + (r.nombre || '') + '! Iniciando tu sesión…');
        iniciarSesion();
      } else if (r.estado === 'expirado') {
        refrescarQR();
      }
    } catch (e) { /* silencioso */ }
  }, 2000);
}

/* =========================================================
   4. INGRESO POR TELÉFONO
   ========================================================= */
(function armarTeclado() {
  const k = $('keypad');
  ['1','2','3','4','5','6','7','8','9','⌫','0','OK'].forEach(t => {
    const b = document.createElement('button');
    b.className = 'key' + (t === '⌫' || t === 'OK' ? ' alt' : '');
    b.textContent = t;
    b.onclick = () => {
      const i = $('inPhone');
      if (t === '⌫') i.value = i.value.slice(0, -1);
      else if (t === 'OK') $('searchPhone').click();
      else if (i.value.replace(/\D/g,'').length < 10) i.value += t;
      $('phoneError').textContent = '';
    };
    k.appendChild(b);
  });
})();

$('goPhone').onclick   = () => { clearInterval(pollQR); mostrar('screenPhone'); };
$('backHome1').onclick = volverInicio;
$('backHome2').onclick = volverInicio;

$('searchPhone').onclick = async () => {
  const tel = $('inPhone').value.replace(/\D/g, '');
  if (tel.length < 7) return $('phoneError').textContent = 'Escribe un número válido (10 dígitos).';
  $('phoneError').textContent = 'Buscando…';

  if (MODO_LOCAL) {
    S.usuario = { id:'demo-local', nombre:'Usuario de prueba', nombre_usuario:'@demo', puntos:0 };
    return mostrarEncontrado();
  }
  try {
    const r = await rpc('buscar_usuario_telefono', { p_telefono: tel });
    if (!r.encontrado) {
      return $('phoneError').textContent = 'No encontramos una cuenta con ese número. Regístrate en la app RECIKLA.';
    }
    S.usuario = { id:r.usuario_id, nombre:r.nombre, nombre_usuario:r.nombre_usuario, puntos:r.puntos };
    mostrarEncontrado();
  } catch (e) {
    $('phoneError').textContent = 'Error de conexión: ' + e.message;
  }
};

function mostrarEncontrado() {
  $('phoneError').textContent = '';
  $('foundName').textContent   = S.usuario.nombre || '—';
  $('foundUser').textContent   = S.usuario.nombre_usuario ? '@' + String(S.usuario.nombre_usuario).replace('@','') : '';
  $('foundPoints').textContent = nf(S.usuario.puntos);
  mostrar('screenFound');
}

$('continueSession').onclick = () => iniciarSesion();

/* =========================================================
   5. SESIÓN DE RECICLAJE
   ========================================================= */
async function iniciarSesion() {
  clearInterval(pollQR); clearInterval(timerQR);
  S.conteo = { plastico:0, vidrio:0, lata:0 };
  S.puntosSesion = 0; S.limiteAlcanzado = false;
  S.buffer = []; S.bloqueado = false; S.framesVacios = 0;
  S.sesionActiva = true;

  if (!MODO_LOCAL) {
    try {
      const r = await rpc('iniciar_sesion_maquina', {
        p_usuario_id: S.usuario.id,
        p_maquina_codigo: CFG.CODIGO_MAQUINA,
        p_token: S.tokenQR
      });
      S.sesionId = r.sesion_id;
    } catch (e) {
      toast('No se pudo abrir la sesión: ' + e.message, true);
      S.sesionId = null;
    }
  } else {
    S.sesionId = 'local';
  }

  $('chipName').textContent = S.usuario.nombre || 'Invitado';
  $('chipUser').textContent = S.usuario.nombre_usuario ? '@' + String(S.usuario.nombre_usuario).replace('@','') : 'sin cuenta';
  $('capMax').textContent = CFG.MAX_OBJETOS;
  $('logBox').innerHTML = '<div class="log-empty" id="logEmpty">Aún no has ingresado objetos en esta sesión.</div>';
  refrescarPanel();
  pintarEstado('ESPERANDO', '');
  mostrar('screenSession');
}

function refrescarPanel() {
  const total = S.conteo.plastico + S.conteo.vidrio + S.conteo.lata;
  $('cPlastico').textContent = S.conteo.plastico;
  $('cVidrio').textContent   = S.conteo.vidrio;
  $('cLata').textContent     = S.conteo.lata;
  $('cTotal').textContent    = total;
  $('moneyVal').textContent  = nf(S.puntosSesion);
  $('capNow').textContent    = total;
  const pct = Math.min(100, total / CFG.MAX_OBJETOS * 100);
  const bar = $('capBar');
  bar.style.width = pct + '%';
  bar.classList.toggle('full', pct >= 100);
}

function agregarRegistro(tipo, puntos) {
  const vacio = $('logEmpty');
  if (vacio) vacio.remove();
  const div = document.createElement('div');
  div.className = 'log-item';
  div.innerHTML = `<div class="ic ic-${tipo}">${ICONO[tipo]}</div>
                   <div class="nm">${ETIQUETA[tipo]}</div>
                   <div class="pz">+${nf(puntos)} pts</div>`;
  $('logBox').prepend(div);
}

async function aceptarObjeto(tipo) {
  if (!S.sesionActiva || S.bloqueado || S.limiteAlcanzado) return;
  S.bloqueado = true;
  S.buffer = []; S.framesVacios = 0;

  let puntos = CFG.PUNTOS[tipo];
  let limite = false;

  if (!MODO_LOCAL && S.sesionId && S.sesionId !== 'local') {
    try {
      const r = await rpc('registrar_objeto', { p_sesion_id: S.sesionId, p_material: tipo });
      if (r.ok === false) {
        S.limiteAlcanzado = true;
        pintarEstado('INVALIDO', 'Límite de ' + CFG.MAX_OBJETOS + ' envases');
        toast('Alcanzaste el máximo de ' + CFG.MAX_OBJETOS + ' envases. Presiona FINALIZAR.', true);
        return;
      }
      puntos = r.puntos;
      S.puntosSesion = r.total_puntos;
      limite = r.limite;
    } catch (e) {
      toast('No se pudo registrar el envase: ' + e.message, true);
      S.puntosSesion += puntos;
    }
  } else {
    S.puntosSesion += puntos;
  }

  S.conteo[tipo]++;
  const total = S.conteo.plastico + S.conteo.vidrio + S.conteo.lata;
  if (total >= CFG.MAX_OBJETOS) limite = true;

  refrescarPanel();
  agregarRegistro(tipo, puntos);
  pintarEstado('ACEPTADO', ETIQUETA[tipo]);
  animarMotor();
  beep(true);
  refrescarMaquina();

  if (limite) {
    S.limiteAlcanzado = true;
    setTimeout(() => {
      pintarEstado('INVALIDO', 'Límite alcanzado');
      $('statusSub').textContent = 'Llegaste a ' + CFG.MAX_OBJETOS + ' envases. Presiona FINALIZAR.';
      toast('Máximo de ' + CFG.MAX_OBJETOS + ' envases alcanzado. Presiona FINALIZAR.');
    }, 1200);
  }
}

/* ---- FINALIZAR ---- */
$('finishBtn').onclick = async () => {
  S.sesionActiva = false;
  const total = S.conteo.plastico + S.conteo.vidrio + S.conteo.lata;
  let balance = (S.usuario?.puntos || 0) + S.puntosSesion;

  if (!MODO_LOCAL && S.sesionId && S.sesionId !== 'local') {
    try {
      const r = await rpc('finalizar_sesion', { p_sesion_id: S.sesionId });
      balance = r.balance;
      S.puntosSesion = r.total_puntos;
    } catch (e) {
      toast('No se pudieron abonar los puntos: ' + e.message, true);
    }
  }

  $('sumName').textContent     = S.usuario?.nombre || 'Invitado';
  $('sumUser').textContent     = S.usuario?.nombre_usuario ? '@' + String(S.usuario.nombre_usuario).replace('@','') : '—';
  $('sumPlastico').textContent = S.conteo.plastico;
  $('sumVidrio').textContent   = S.conteo.vidrio;
  $('sumLata').textContent     = S.conteo.lata;
  $('sumTotal').textContent    = total;
  $('sumGain').textContent     = nf(S.puntosSesion) + ' pts';
  $('sumBalance').textContent  = nf(balance) + ' pts';
  $('sumDate').textContent     = new Date().toLocaleString('es-CO');
  mostrar('screenSummary');

  let s = CFG.SEGUNDOS_RESUMEN;
  $('countdown').textContent = 'Volviendo al inicio en ' + s + ' s';
  clearInterval(timerResumen);
  timerResumen = setInterval(() => {
    s--;
    $('countdown').textContent = 'Volviendo al inicio en ' + s + ' s';
    if (s <= 0) volverInicio();
  }, 1000);
};

$('newSession').onclick = volverInicio;

/* ---- Estado de la máquina (nivel de llenado) ---- */
async function refrescarMaquina() {
  $('badgeMaquina').innerHTML = 'Máquina <b>' + CFG.CODIGO_MAQUINA + '</b>';
  if (MODO_LOCAL) { $('badgeLlenado').innerHTML = 'Llenado <b>demo</b>'; return; }
  try {
    const { data, error } = await db.from('maquinas')
      .select('objetos_actuales,capacidad_max,estado')
      .eq('codigo', CFG.CODIGO_MAQUINA).single();
    if (error || !data) return;
    const pct = Math.round(data.objetos_actuales / data.capacidad_max * 100);
    $('badgeLlenado').innerHTML = 'Llenado <b>' + pct + '%</b>';
  } catch (e) { /* silencioso */ }
}

/* =========================================================
   6. VISIÓN ARTIFICIAL
   ========================================================= */
function pintarEstado(estado, detalle) {
  S.estado = estado;
  const clase = estado === 'ACEPTADO' ? 'st-ok' : estado === 'INVALIDO' ? 'st-bad' : 'st-wait';

  const cam = $('camStatus');
  cam.className = 'cam-status ' + clase;
  cam.firstChild.textContent = estado + ' ';
  $('camSub').textContent = detalle || '';

  const box = $('statusBox');
  if (box) {
    box.className = 'status-box ' + clase;
    $('statusVal').textContent = estado;
    $('statusSub').textContent =
      estado === 'ACEPTADO' ? (detalle || '') + ' — ingresado por el motor'
      : estado === 'INVALIDO' ? 'Este material no se recibe. Retíralo.'
      : 'Acerca un objeto al lector';
  }
}

function animarMotor() {
  const m = $('motor');
  m.classList.add('on');
  setTimeout(() => m.classList.remove('on'), 520);
}

function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    o.start(); o.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');

async function iniciarCamara() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width:{ideal:1280}, height:{ideal:720}, facingMode:'user' }, audio:false
  });
  video.srcObject = stream;
  await new Promise(res => { if (video.readyState >= 2) return res(); video.onloadedmetadata = () => res(); });
  await video.play();
  S.camaraLista = true;
}

async function cargarModelos() {
  $('camModel').textContent = 'Cargando modelos…';
  const [coco, mob] = await Promise.all([
    cocoSsd.load({ base:'lite_mobilenet_v2' }),
    mobilenet.load({ version:2, alpha:1.0 })
  ]);
  cocoModel = coco; mobilenetModel = mob;
  S.modelosListos = true;
  $('camModel').textContent = 'COCO-SSD + MobileNet v2';
}

function ajustarOverlay() {
  const r = $('stage').getBoundingClientRect();
  overlay.width = r.width; overlay.height = r.height;
}
window.addEventListener('resize', ajustarOverlay);

function mapear(x, y, w, h) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = overlay.width, ch = overlay.height;
  const esc = Math.min(cw / vw, ch / vh);
  const offX = (cw - vw * esc) / 2, offY = (ch - vh * esc) / 2;
  return { x: offX + (vw - (x + w)) * esc, y: offY + y * esc, w: w * esc, h: h * esc };
}

function analizarColor() {
  const d = cropCtx.getImageData(0, 0, 224, 224).data;
  let sumV = 0, sumS = 0, brillantes = 0, verdes = 0, ambar = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    const r = d[i]/255, g = d[i+1]/255, b = d[i+2]/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const v = max, s = max === 0 ? 0 : (max - min)/max;
    sumV += v; sumS += s; n++;
    if (v > 0.92 && s < 0.25) brillantes++;
    if (max - min > 0.06) {
      let hue;
      if (max === r) hue = 60 * (((g-b)/(max-min)) % 6);
      else if (max === g) hue = 60 * ((b-r)/(max-min) + 2);
      else hue = 60 * ((r-g)/(max-min) + 4);
      if (hue < 0) hue += 360;
      if (hue >= 70 && hue <= 175) verdes++;
      if (hue >= 15 && hue <= 48 && v < 0.7) ambar++;
    }
  }
  return { v:sumV/n, s:sumS/n, brillo:brillantes/n, verde:verdes/n, ambar:ambar/n };
}

function decidirMaterial(preds, ar, col) {
  const p = { plastico:0, vidrio:0, lata:0 };
  preds.forEach(pr => {
    const nombre = pr.className.toLowerCase();
    for (const mat in LEXICO) {
      if (LEXICO[mat].some(w => nombre.includes(w))) p[mat] += pr.probability * 1.1;
    }
  });
  if (ar > 0 && ar < 2.00) p.lata += 0.38;
  else if (ar < 2.35) { p.lata += 0.10; p.plastico += 0.10; p.vidrio += 0.06; }
  else { p.plastico += 0.20; p.vidrio += 0.16; }

  if (col.brillo > 0.05 && col.s < 0.35) p.lata += 0.26;
  if (col.s > 0.48 && ar < 2.15)         p.lata += 0.18;
  if (col.verde > 0.22 && col.v < 0.62)  p.vidrio += 0.26;
  if (col.ambar > 0.20 && col.v < 0.60)  p.vidrio += 0.22;
  if (col.v > 0.62 && col.s < 0.22 && ar > 2.2) p.plastico += 0.18;

  const mejor = Object.keys(p).reduce((a,b) => p[a] > p[b] ? a : b);
  return { tipo: mejor, conf: p[mejor] };
}

const TRAD = {
  person:'persona','cell phone':'celular',book:'libro',laptop:'portátil',banana:'banano',
  apple:'manzana',orange:'naranja',mouse:'mouse',keyboard:'teclado',remote:'control',
  scissors:'tijeras',chair:'silla',backpack:'mochila','teddy bear':'peluche',clock:'reloj',
  spoon:'cuchara',fork:'tenedor',knife:'cuchillo',bowl:'plato'
};
const traducir = c => TRAD[c] || c;

function dibujarCaja(x, y, w, h, texto, color) {
  const m = mapear(x, y, w, h);
  octx.lineWidth = 3; octx.strokeStyle = color;
  octx.shadowColor = color; octx.shadowBlur = 12;
  octx.strokeRect(m.x, m.y, m.w, m.h);
  octx.shadowBlur = 0;
  octx.font = '700 18px Segoe UI, system-ui, sans-serif';
  const tw = octx.measureText(texto).width;
  octx.fillStyle = color;
  octx.fillRect(m.x, Math.max(0, m.y - 28), tw + 18, 26);
  octx.fillStyle = '#06170e';
  octx.fillText(texto, m.x + 9, Math.max(18, m.y - 9));
}

async function bucle() {
  if (!S.modelosListos || !S.camaraLista || video.readyState < 2) return setTimeout(bucle, 200);
  try {
    if (overlay.width === 0) ajustarOverlay();
    const dets = await cocoModel.detect(video, 8, VISION.scoreCoco);
    octx.clearRect(0, 0, overlay.width, overlay.height);

    const areaCuadro = video.videoWidth * video.videoHeight;
    let envase = null, ajeno = null;

    for (const d of dets) {
      const [x, y, w, h] = d.bbox;
      if ((w * h) / areaCuadro < VISION.areaMinima) continue;
      if (CLASES_ENVASE.includes(d.class)) {
        if (!envase || w*h > envase.bbox[2]*envase.bbox[3]) envase = d;
      } else if (d.score > 0.55) {
        if (!ajeno || w*h > ajeno.bbox[2]*ajeno.bbox[3]) ajeno = d;
      }
    }

    if (envase) {
      S.framesVacios = 0; S.framesInvalido = 0;
      const [x, y, w, h] = envase.bbox;
      cropCtx.drawImage(video, x, y, w, h, 0, 0, 224, 224);
      const preds = await mobilenetModel.classify(cropCanvas, 5);
      const res = decidirMaterial(preds, h / w, analizarColor());
      const tipo = res.conf >= VISION.confianzaMinima ? res.tipo : 'plastico';
      dibujarCaja(x, y, w, h, ETIQUETA[tipo], COLOR[tipo]);

      if (!S.bloqueado && !S.limiteAlcanzado) {
        S.buffer.push(tipo);
        if (S.buffer.length > VISION.framesParaAceptar) S.buffer.shift();
        const estable = S.buffer.length >= VISION.framesParaAceptar && S.buffer.every(t => t === S.buffer[0]);
        if (estable && S.sesionActiva) await aceptarObjeto(S.buffer[0]);
        else if (S.estado !== 'ACEPTADO') pintarEstado('ESPERANDO', 'Analizando ' + ETIQUETA[tipo] + '…');
      }
    } else if (ajeno) {
      S.framesVacios = 0; S.buffer = [];
      S.framesInvalido++;
      const [x, y, w, h] = ajeno.bbox;
      dibujarCaja(x, y, w, h, 'INVALIDO', '#ff4d5e');
      if (S.framesInvalido >= VISION.framesParaInvalido && !S.bloqueado && !S.limiteAlcanzado) {
        if (S.estado !== 'INVALIDO') beep(false);
        pintarEstado('INVALIDO', traducir(ajeno.class));
      }
    } else {
      S.framesInvalido = 0; S.buffer = [];
      S.framesVacios++;
      if (S.framesVacios >= VISION.framesParaLimpiar) {
        S.bloqueado = false;
        if (S.estado !== 'ESPERANDO' && !S.limiteAlcanzado) pintarEstado('ESPERANDO', '');
      }
    }
  } catch (e) { console.error('[RECIKLA]', e); }
  setTimeout(bucle, VISION.intervaloMs);
}

/* ---- Atajos de respaldo: 1 lata · 2 plástico · 3 vidrio ---- */
document.addEventListener('keydown', e => {
  if (!CFG.ATAJOS_ACTIVOS || !S.sesionActiva) return;
  if (['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const mapa = { '1':'lata', '2':'plastico', '3':'vidrio' };
  const tipo = mapa[e.key];
  if (!tipo) return;
  S.bloqueado = false;
  aceptarObjeto(tipo);
});

/* =========================================================
   7. ARRANQUE
   ========================================================= */
(async function main() {
  conectar();
  refrescarMaquina();
  ajustarOverlay();
  pintarEstado('ESPERANDO', '');
  refrescarQR();

  try {
    await iniciarCamara();
  } catch (e) {
    $('loader').innerHTML = `<div><p><b>No se pudo abrir la cámara</b>
      Permite el acceso a la cámara y recarga la página. Solo funciona en https:// o localhost.
      <br><br><span style="opacity:.6">${e.name}: ${e.message}</span></p></div>`;
    return;
  }
  ajustarOverlay();
  $('loader').classList.add('hidden');

  try {
    await cargarModelos();
    bucle();
  } catch (e) {
    console.error('[RECIKLA] modelos:', e);
    $('camModel').textContent = 'Modo manual (modelos no disponibles)';
    pintarEstado('ESPERANDO', 'Detección automática no disponible');
  }
})();
