/* =========================================================
   RECIKLA · APP MÓVIL
   Registro, balance, máquinas, escáner QR, canje y perfil
   ========================================================= */

const CFG = window.RECIKLA_CONFIG;
const $ = id => document.getElementById(id);
const nf  = n => new Intl.NumberFormat('es-CO').format(Math.round(n || 0));
const cop = n => '$' + nf((n || 0) * (CFG.PESOS_POR_PUNTO || 1)) + ' COP';

let sb = null;
let USUARIO = null;          // fila de public.usuarios
let MAQUINAS = [];
let mapa = null, capaMarcas = null;
let scanStream = null, scanLoop = null;
let tokenPendiente = null;

/* ---------------------------------------------------------
   Utilidades de interfaz
   --------------------------------------------------------- */
function toast(msg, malo) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (malo ? ' bad' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast' + (malo ? ' bad' : ''); }, 4000);
}

function msg(el, texto, tipo) {
  const e = $(el);
  e.textContent = texto || '';
  e.className = 'msg' + (tipo ? ' ' + tipo : '');
}

function abrirModal(html) {
  $('modalBody').innerHTML = html;
  $('modal').classList.add('show');
}
$('modalClose').onclick = () => $('modal').classList.remove('show');
$('modal').onclick = e => { if (e.target.id === 'modal') $('modal').classList.remove('show'); };

/* ---------------------------------------------------------
   Navegación
   --------------------------------------------------------- */
function ir(vista) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(vista).classList.add('active');
  document.querySelectorAll('.nav button').forEach(b =>
    b.classList.toggle('on', b.dataset.go === vista));
  window.scrollTo(0, 0);

  if (vista !== 'viewEscanear') detenerEscaner();
  if (vista === 'viewEscanear') iniciarEscaner();
  if (vista === 'viewMaquinas') { cargarMaquinas().then(pintarMapa); }
  if (vista === 'viewCanjear')  { $('cjBalance').textContent = nf(USUARIO?.puntos); cargarRetiros(); }
  if (vista === 'viewPerfil')   llenarPerfil();
  if (vista === 'viewHome')     refrescarInicio();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) ir(b.dataset.go);
});

/* ---------------------------------------------------------
   Conexión
   --------------------------------------------------------- */
/* Limpia la URL: quita espacios, barras finales y cualquier ruta pegada
   por error (ej. .../rest/v1). Supabase solo acepta el dominio. */
function urlLimpia(v) {
  let u = (v || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');
  try { u = new URL(u).origin; } catch (e) {}
  return u;
}

function conectar() {
  const url = urlLimpia(CFG.SUPABASE_URL);
  const key = (CFG.SUPABASE_ANON_KEY || '').trim().replace(/\s+/g, '');
  if (!window.supabase) return false;
  if (!url.startsWith('https://') || url.includes('TU-PROYECTO') || key.length < 30 || key.includes('PEGA-AQUI')) {
    return false;
  }
  sb = window.supabase.createClient(url, key);
  return true;
}

async function rpc(nombre, args) {
  const { data, error } = await sb.rpc(nombre, args);
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------------------------------------------------
   AUTENTICACIÓN
   --------------------------------------------------------- */
$('tabLogin').onclick = () => {
  $('tabLogin').classList.add('on'); $('tabReg').classList.remove('on');
  $('formLogin').style.display = ''; $('formReg').style.display = 'none';
};
$('tabReg').onclick = () => {
  $('tabReg').classList.add('on'); $('tabLogin').classList.remove('on');
  $('formReg').style.display = ''; $('formLogin').style.display = 'none';
};

$('btnLogin').onclick = async () => {
  const email = $('lgCorreo').value.trim();
  const pass  = $('lgClave').value;
  if (!email || !pass) return msg('lgMsg', 'Escribe tu correo y contraseña.', 'err');
  msg('lgMsg', 'Entrando…');
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) {
    return msg('lgMsg', error.message.includes('Invalid')
      ? 'Correo o contraseña incorrectos.' : error.message, 'err');
  }
  msg('lgMsg', '');
  await entrar();
};

$('btnReg').onclick = async () => {
  const nombre  = $('rgNombre').value.trim();
  const usuario = $('rgUsuario').value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
  const tel     = $('rgTel').value.replace(/\D/g, '');
  const correo  = $('rgCorreo').value.trim();
  const nac     = $('rgNac').value;
  const clave   = $('rgClave').value;

  if (nombre.length < 3)   return msg('rgMsg', 'Escribe tu nombre completo.', 'err');
  if (usuario.length < 3)  return msg('rgMsg', 'El nombre de usuario debe tener al menos 3 caracteres.', 'err');
  if (tel.length !== 10)   return msg('rgMsg', 'El teléfono debe tener 10 dígitos.', 'err');
  if (!/^\S+@\S+\.\S+$/.test(correo)) return msg('rgMsg', 'Correo no válido.', 'err');
  if (!nac)                return msg('rgMsg', 'Selecciona tu fecha de nacimiento.', 'err');
  if (clave.length < 6)    return msg('rgMsg', 'La contraseña debe tener mínimo 6 caracteres.', 'err');

  msg('rgMsg', 'Verificando…');
  try {
    const d = await rpc('disponibilidad', { p_telefono: tel, p_nombre_usuario: usuario });
    if (!d.telefono_libre) return msg('rgMsg', 'Ya existe una cuenta con ese teléfono.', 'err');
    if (!d.usuario_libre)  return msg('rgMsg', 'Ese nombre de usuario ya está tomado.', 'err');
  } catch (e) { /* si falla la verificación, seguimos: el índice único protege igual */ }

  msg('rgMsg', 'Creando tu cuenta…');
  const { data, error } = await sb.auth.signUp({
    email: correo, password: clave,
    options: { data: {
      nombre_completo: nombre, nombre_usuario: usuario,
      telefono: tel, fecha_nacimiento: nac
    }}
  });
  if (error) return msg('rgMsg', error.message, 'err');

  if (!data.session) {
    return msg('rgMsg', 'Cuenta creada. Revisa tu correo y confirma el registro para poder entrar.', 'ok');
  }
  msg('rgMsg', '');
  toast('¡Bienvenido a RECIKLA, ' + nombre.split(' ')[0] + '!');
  await entrar();
};

$('btnSalir').onclick = async () => {
  await sb.auth.signOut();
  USUARIO = null;
  $('nav').style.display = 'none';
  ir('viewAuth');
};

async function cargarPerfil() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.from('usuarios').select('*').eq('id', user.id).single();
  if (error) {
    // El perfil puede tardar un instante en crearse tras el registro
    await new Promise(r => setTimeout(r, 900));
    const reintento = await sb.from('usuarios').select('*').eq('id', user.id).single();
    if (reintento.error) return null;
    return { ...reintento.data, correo: reintento.data.correo || user.email };
  }
  return { ...data, correo: data.correo || user.email };
}

async function entrar() {
  USUARIO = await cargarPerfil();
  if (!USUARIO) { toast('No se pudo cargar tu perfil.', true); return; }
  $('nav').style.display = '';
  ir('viewHome');
  if (tokenPendiente) { const t = tokenPendiente; tokenPendiente = null; vincular(t); }
}

/* ---------------------------------------------------------
   INICIO
   --------------------------------------------------------- */
async function refrescarInicio() {
  if (!USUARIO) return;
  USUARIO = (await cargarPerfil()) || USUARIO;
  $('hiName').textContent  = USUARIO.nombre_completo;
  $('hiUser').textContent  = '@' + (USUARIO.nombre_usuario || 'usuario');
  $('balPuntos').textContent = nf(USUARIO.puntos);
  $('balPesos').textContent  = '≈ ' + cop(USUARIO.puntos);
  await cargarMaquinas();
  pintarListaMaquinas($('homeMaquinas'), MAQUINAS.slice(0, 3));
  cargarActividad();
}

async function cargarActividad() {
  try {
    const { data, error } = await sb.from('sesiones')
      .select('id,iniciada_en,total_objetos,total_puntos,estado,maquinas(nombre)')
      .order('iniciada_en', { ascending: false }).limit(5);
    if (error || !data || !data.length) return;
    $('homeActividad').innerHTML = data.map(s => `
      <div class="item">
        <div class="ic">♻️</div>
        <div class="grow">
          <div style="font-weight:600">${s.maquinas?.nombre || 'Máquina RECIKLA'}</div>
          <div class="muted" style="font-size:11.5px">
            ${new Date(s.iniciada_en).toLocaleDateString('es-CO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
            · ${s.total_objetos} envases
          </div>
        </div>
        <div class="pz">+${nf(s.total_puntos)}</div>
      </div>`).join('');
  } catch (e) {}
}

/* ---------------------------------------------------------
   MÁQUINAS
   --------------------------------------------------------- */
function nivel(m) {
  return Math.min(100, Math.round(m.objetos_actuales / Math.max(1, m.capacidad_max) * 100));
}
function colorNivel(p) { return p >= 90 ? '#ff4d5e' : p >= 65 ? '#ffc043' : '#22e07a'; }

async function cargarMaquinas() {
  try {
    const { data, error } = await sb.from('maquinas').select('*').order('nombre');
    if (!error && data) MAQUINAS = data;
  } catch (e) {}
  pintarListaMaquinas($('listaMaquinas'), MAQUINAS);
  return MAQUINAS;
}

function pintarListaMaquinas(cont, lista) {
  if (!cont) return;
  if (!lista.length) { cont.innerHTML = '<div class="muted">No hay máquinas registradas todavía.</div>'; return; }
  cont.innerHTML = lista.map(m => {
    const p = nivel(m), c = colorNivel(p);
    const estado = m.estado !== 'activa' ? 'Fuera de servicio'
                 : p >= 90 ? 'Casi llena' : p >= 65 ? 'Disponible · llenándose' : 'Disponible';
    const clase  = m.estado !== 'activa' || p >= 90 ? 'st-full' : p >= 65 ? 'st-med' : 'st-ok';
    return `<div class="maq">
      <div class="ring" style="background:conic-gradient(${c} ${p*3.6}deg, rgba(255,255,255,.08) 0deg)">
        <i>${p}%</i>
      </div>
      <div class="grow">
        <div class="nm">${m.nombre}</div>
        <div class="ad">${m.direccion || ''}${m.ciudad ? ' · ' + m.ciudad : ''}</div>
        <div class="st ${clase}">● ${estado} · ${m.codigo}</div>
      </div>
    </div>`;
  }).join('');
}

function pintarMapa() {
  const conPos = MAQUINAS.filter(m => m.lat && m.lng);
  if (!window.L || !conPos.length) {
    $('mapa').innerHTML = '<div class="muted" style="display:grid;place-items:center;height:100%;text-align:center;padding:20px">'
      + (window.L ? 'Las máquinas aún no tienen ubicación registrada.' : 'No se pudo cargar el mapa. Revisa tu conexión.')
      + '</div>';
    return;
  }
  if (!mapa) {
    mapa = L.map('mapa', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapa);
    capaMarcas = L.layerGroup().addTo(mapa);
  }
  capaMarcas.clearLayers();
  conPos.forEach(m => {
    const p = nivel(m);
    const icon = L.divIcon({
      className: '', iconSize: [26, 26],
      html: `<div class="mk" style="background:${colorNivel(p)}">${p}</div>`
    });
    L.marker([m.lat, m.lng], { icon })
      .bindPopup(`<b>${m.nombre}</b><br>${m.direccion || ''}<br>Llenado: ${p}%`)
      .addTo(capaMarcas);
  });
  mapa.fitBounds(conPos.map(m => [m.lat, m.lng]), { padding: [30, 30] });
  setTimeout(() => mapa.invalidateSize(), 250);
}

/* ---------------------------------------------------------
   ESCÁNER QR
   --------------------------------------------------------- */
/* Espera a que la librería jsQR termine de cargar (puede venir de un CDN de respaldo) */
function esperarJsQR(msMax = 6000) {
  return new Promise(resolve => {
    if (window.jsQR) return resolve(true);
    const t0 = Date.now();
    const t = setInterval(() => {
      if (window.jsQR) { clearInterval(t); resolve(true); }
      else if (Date.now() - t0 > msMax) { clearInterval(t); resolve(false); }
    }, 150);
  });
}

async function iniciarEscaner() {
  const v = $('scanVideo');
  $('scanHint').textContent = 'Abriendo cámara…';
  msg('scanMsg', '');

  // 1. Cámara. Se pide la trasera; si el equipo no la tiene, se usa cualquiera.
  try {
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 } }, audio: false
      });
    } catch (e1) {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false
      });
    }
    v.srcObject = scanStream;
    v.setAttribute('playsinline', '');
    await v.play();
  } catch (e) {
    $('scanHint').textContent = '';
    return msg('scanMsg',
      'No se pudo abrir la cámara (' + e.name + '). Revisa el permiso de cámara del navegador, '
      + 'o usa el botón de abajo para escribir el código.', 'err');
  }

  // 2. Librería del lector
  $('scanHint').textContent = 'Buscando código…';
  const listo = await esperarJsQR();
  if (!listo) {
    $('scanHint').textContent = '';
    return msg('scanMsg', 'No se pudo cargar el lector de QR. Usa el ingreso manual del código.', 'err');
  }

  // 3. Bucle de lectura. Se reduce el cuadro a 640 px de ancho: en celular
  //    detecta mucho más rápido y consume menos batería.
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let intentos = 0;

  scanLoop = setInterval(() => {
    if (!v.videoWidth || v.readyState < 2) return;

    const escala = Math.min(1, 640 / v.videoWidth);
    c.width  = Math.round(v.videoWidth  * escala);
    c.height = Math.round(v.videoHeight * escala);
    ctx.drawImage(v, 0, 0, c.width, c.height);

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });

    if (r && r.data) {
      detenerEscaner();
      $('scanHint').textContent = '✅ Código detectado';
      $('scanWrap').style.outline = '3px solid var(--green)';
      setTimeout(() => { $('scanWrap').style.outline = ''; }, 800);
      vincular(extraerToken(r.data));
      return;
    }

    intentos++;
    if (intentos === 40) $('scanHint').textContent = 'Acerca más el celular al código';
    if (intentos === 90) $('scanHint').textContent = 'Si no engancha, usa el ingreso manual';
  }, 200);
}

function detenerEscaner() {
  clearInterval(scanLoop); scanLoop = null;
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = $('scanVideo'); if (v) v.srcObject = null;
}

function extraerToken(texto) {
  try {
    const u = new URL(texto);
    return u.searchParams.get('vincular') || texto;
  } catch (e) { return texto.trim(); }
}

async function vincular(token, silencioso) {
  if (!token) return false;
  if (!USUARIO) { tokenPendiente = token; return false; }
  try {
    const r = await rpc('vincular_token_qr', { p_token: token });
    abrirModal(`
      <h2 style="text-align:center">✅ Conectado</h2>
      <p class="muted" style="text-align:center;margin:10px 0 4px">
        Tu cuenta quedó vinculada con<br><b style="color:var(--text)">${r.maquina}</b>
      </p>
      <p class="muted" style="text-align:center">
        Ya puedes empezar a depositar tus envases. Los puntos se abonan al finalizar la sesión.
      </p>`);
    ir('viewHome');
    return true;
  } catch (e) {
    msg('scanMsg', e.message, 'err');
    if (!silencioso) toast(e.message, true);
    return false;
  }
}

$('scanManual').onclick = () => {
  abrirModal(`
    <h2>Ingresar código</h2>
    <p class="muted" style="margin-bottom:12px">Escribe los 6 caracteres que aparecen debajo del QR en la máquina.</p>
    <div class="field">
      <input id="codManual" type="text" maxlength="10" autocapitalize="characters" autocomplete="off"
             placeholder="A1B2C3"
             style="text-align:center;font-size:30px;letter-spacing:8px;font-family:'Courier New',monospace;text-transform:uppercase">
    </div>
    <div class="msg err" id="codMsg"></div>
    <button class="btn" id="codOk">Conectar con la máquina</button>`);
  const inp = $('codManual');
  setTimeout(() => inp.focus(), 150);
  inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') $('codOk').click(); });
  $('codOk').onclick = async () => {
    const t = inp.value.trim();
    if (t.length < 4) { msg('codMsg', 'El código tiene 6 caracteres.', 'err'); return; }
    msg('codMsg', 'Conectando…');
    // Si todo sale bien, vincular() reemplaza el contenido del modal por la confirmación
    const ok = await vincular(t, true);
    if (!ok) msg('codMsg', $('scanMsg').textContent || 'No se pudo conectar.', 'err');
  };
};

/* ---------------------------------------------------------
   CANJE DE PUNTOS
   --------------------------------------------------------- */
$('btnCanjear').onclick = async () => {
  const puntos  = parseInt($('cjPuntos').value, 10);
  const metodo  = $('cjMetodo').value;
  const destino = $('cjDestino').value.trim();
  const min = CFG.CANJE_MINIMO || 2000;

  if (!puntos || puntos < min) return msg('cjMsg', 'El mínimo es ' + nf(min) + ' puntos.', 'err');
  if (puntos > (USUARIO?.puntos || 0)) return msg('cjMsg', 'No tienes puntos suficientes.', 'err');
  if (destino.length < 5) return msg('cjMsg', 'Escribe el número o correo de destino.', 'err');

  msg('cjMsg', 'Enviando solicitud…');
  try {
    const r = await rpc('solicitar_retiro', { p_puntos: puntos, p_metodo: metodo, p_destino: destino });
    USUARIO.puntos = r.balance;
    $('cjBalance').textContent = nf(r.balance);
    $('cjPuntos').value = '';
    msg('cjMsg', 'Solicitud registrada. Se procesa en 1 a 3 días hábiles.', 'ok');
    toast('Canje solicitado por ' + cop(puntos));
    cargarRetiros();
  } catch (e) { msg('cjMsg', e.message, 'err'); }
};

async function cargarRetiros() {
  try {
    const { data, error } = await sb.from('retiros').select('*')
      .order('solicitado_en', { ascending: false }).limit(10);
    if (error || !data || !data.length) return;
    $('listaRetiros').innerHTML = data.map(r => `
      <div class="item">
        <div class="ic">💸</div>
        <div class="grow">
          <div style="font-weight:600;text-transform:capitalize">${r.metodo}</div>
          <div class="muted" style="font-size:11.5px">
            ${new Date(r.solicitado_en).toLocaleDateString('es-CO',{day:'2-digit',month:'short',year:'numeric'})}
            · ${r.estado}
          </div>
        </div>
        <div class="pz neg">-${nf(r.puntos)}</div>
      </div>`).join('');
  } catch (e) {}
}

/* ---------------------------------------------------------
   PERFIL
   --------------------------------------------------------- */
function llenarPerfil() {
  if (!USUARIO) return;
  $('pfNombre').value  = USUARIO.nombre_completo || '';
  $('pfUsuario').value = USUARIO.nombre_usuario || '';
  $('pfTel').value     = USUARIO.telefono || '';
  $('pfNac').value     = USUARIO.fecha_nacimiento || '';
  $('pfCorreo').value  = USUARIO.correo || '';
  msg('pfMsg', ''); msg('pwMsg', '');
}

$('btnGuardarPerfil').onclick = async () => {
  const nombre  = $('pfNombre').value.trim();
  const usuario = $('pfUsuario').value.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '');
  const tel     = $('pfTel').value.replace(/\D/g, '');
  const nac     = $('pfNac').value || null;

  if (nombre.length < 3)  return msg('pfMsg', 'Nombre demasiado corto.', 'err');
  if (usuario.length < 3) return msg('pfMsg', 'Nombre de usuario demasiado corto.', 'err');
  if (tel.length !== 10)  return msg('pfMsg', 'El teléfono debe tener 10 dígitos.', 'err');

  msg('pfMsg', 'Guardando…');
  const { error } = await sb.from('usuarios').update({
    nombre_completo: nombre, nombre_usuario: usuario, telefono: tel, fecha_nacimiento: nac
  }).eq('id', USUARIO.id);

  if (error) {
    return msg('pfMsg', error.message.includes('usuarios_telefono_key')
      ? 'Ese teléfono ya está registrado en otra cuenta.'
      : error.message.includes('usuarios_nombre_usuario_key')
      ? 'Ese nombre de usuario ya está tomado.' : error.message, 'err');
  }
  Object.assign(USUARIO, { nombre_completo: nombre, nombre_usuario: usuario, telefono: tel, fecha_nacimiento: nac });
  msg('pfMsg', 'Datos actualizados.', 'ok');
  toast('Perfil actualizado');
};

$('btnClave').onclick = async () => {
  const a = $('pwNueva').value, b = $('pwRepetir').value;
  if (a.length < 6)  return msg('pwMsg', 'La contraseña debe tener mínimo 6 caracteres.', 'err');
  if (a !== b)       return msg('pwMsg', 'Las contraseñas no coinciden.', 'err');
  msg('pwMsg', 'Actualizando…');
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) return msg('pwMsg', error.message, 'err');
  $('pwNueva').value = ''; $('pwRepetir').value = '';
  msg('pwMsg', 'Contraseña actualizada.', 'ok');
  toast('Contraseña actualizada');
};

/* ---------------------------------------------------------
   SOPORTE E INSTRUCCIONES
   --------------------------------------------------------- */
const HTML_INSTRUCCIONES = `
  <h2>Cómo reciclar en RECIKLA</h2>
  <div class="step"><div class="n">1</div><p><b>Busca una máquina.</b> En la pestaña Máquinas ves cuáles están cerca y qué tan llenas están.</p></div>
  <div class="step"><div class="n">2</div><p><b>Inicia sesión en la máquina.</b> Escanea el QR de la pantalla desde el botón central de la app, o escribe tu número de teléfono en la máquina.</p></div>
  <div class="step"><div class="n">3</div><p><b>Deposita los envases uno por uno.</b> La cámara identifica si es plástico, vidrio o lata. Máximo 20 envases por sesión.</p></div>
  <div class="step"><div class="n">4</div><p><b>Presiona FINALIZAR.</b> Los puntos se abonan a tu cuenta de inmediato.</p></div>
  <div class="step"><div class="n">5</div><p><b>Canjea.</b> Desde 2.000 puntos puedes pasarlos a Nequi, Daviplata o un bono.</p></div>
  <div class="card" style="margin-top:6px">
    <h2>Cuánto vale cada envase</h2>
    <div class="item"><div class="ic">🧴</div><div class="grow">Botella plástica (PET)</div><div class="pz">100 pts</div></div>
    <div class="item"><div class="ic">🍾</div><div class="grow">Botella de vidrio</div><div class="pz">200 pts</div></div>
    <div class="item"><div class="ic">🥤</div><div class="grow">Lata de aluminio</div><div class="pz">300 pts</div></div>
  </div>`;

const HTML_SOPORTE = `
  <h2>Soporte RECIKLA</h2>
  <p class="muted" style="margin-bottom:14px">¿Algo no funcionó? Escríbenos y lo resolvemos.</p>
  <div class="item"><div class="ic">📱</div><div class="grow">WhatsApp<br><span class="muted">Lun a sáb, 8am – 6pm</span></div><div class="pz">300 000 0000</div></div>
  <div class="item"><div class="ic">✉️</div><div class="grow">Correo</div><div class="pz">soporte@recikla.co</div></div>
  <div class="card" style="margin-top:12px">
    <h2>Preguntas frecuentes</h2>
    <p class="muted" style="margin-bottom:10px"><b style="color:var(--text)">La máquina no aceptó mi envase.</b><br>
      Solo se reciben botellas plásticas, de vidrio y latas. Deben estar vacías y sin aplastar.</p>
    <p class="muted" style="margin-bottom:10px"><b style="color:var(--text)">No veo mis puntos.</b><br>
      Los puntos se abonan al presionar FINALIZAR en la máquina. Desliza hacia abajo en Inicio para actualizar.</p>
    <p class="muted"><b style="color:var(--text)">¿Cuánto tarda un canje?</b><br>
      Entre 1 y 3 días hábiles según el método elegido.</p>
  </div>`;

$('qInstr').onclick  = () => abrirModal(HTML_INSTRUCCIONES);
$('qInstr2').onclick = () => abrirModal(HTML_INSTRUCCIONES);
$('qSoporte').onclick = () => abrirModal(HTML_SOPORTE);

/* ---------------------------------------------------------
   ARRANQUE
   --------------------------------------------------------- */
(async function main() {
  $('minCanje').textContent = nf(CFG.CANJE_MINIMO || 2000);

  // token que viene en la URL (?vincular=xxxx) al abrir el QR desde la cámara del celular
  const params = new URLSearchParams(location.search);
  if (params.get('vincular')) {
    tokenPendiente = params.get('vincular');
    history.replaceState({}, '', location.pathname);
  }

  if (!conectar()) {
    $('splash').classList.add('hide');
    ir('viewAuth');
    return abrirModal(`
      <h2>Falta configurar Supabase</h2>
      <p class="muted" style="margin-top:10px">Abre el archivo <b>config.js</b> de esta app y pega tu
      <b>Project URL</b> y tu <b>anon key</b> de Supabase. Encuentras el paso a paso en
      <b>GUIA-SUPABASE.md</b>.</p>`);
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) { await entrar(); } else { ir('viewAuth'); }
  $('splash').classList.add('hide');

  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT') { USUARIO = null; $('nav').style.display = 'none'; ir('viewAuth'); }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
