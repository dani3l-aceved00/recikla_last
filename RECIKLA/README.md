# RECIKLA · Ecosistema completo

Proyecto de máquinas inteligentes de reciclaje que pagan al usuario por cada envase.
Tres piezas conectadas entre sí:

```
RECIKLA/
├── maquina/          → pantalla de la máquina (cámara + visión artificial)
├── movil/            → app del usuario (PWA instalable)
├── supabase/         → base de datos, funciones y seguridad
├── GUIA-SUPABASE.md  → paso a paso para crear la base de datos
└── README.md
```

---

## Cómo se conecta todo

```
   APP MÓVIL                 SUPABASE                    MÁQUINA
 ┌────────────┐          ┌──────────────┐           ┌──────────────┐
 │ Registro   │────────▶ │  auth.users  │           │  Bienvenida  │
 │ Inicio     │          │  usuarios    │ ◀──────── │  QR / teléf. │
 │ Máquinas   │ ◀─────── │  maquinas    │           │  Reciclar    │
 │ Escáner QR │────────▶ │  tokens_qr   │ ◀──────── │  (cámara)    │
 │ Canje      │          │  sesiones    │ ◀──────── │  Finalizar   │
 │ Perfil     │          │  objetos     │           └──────────────┘
 └────────────┘          │  retiros     │
                         └──────────────┘
```

**Flujo con QR:** la máquina pide a Supabase un token de un solo uso (3 min de vida) y lo
muestra como QR. El usuario lo escanea desde la app ya autenticada → la app vincula su
cuenta al token → la máquina detecta el cambio y abre la sesión con su nombre.

**Flujo con teléfono:** el usuario escribe su número en la máquina, esta consulta la
función `buscar_usuario_telefono`, muestra el nombre y continúa.

**Al finalizar:** `finalizar_sesion` cierra la sesión, suma los puntos al balance del
usuario y la máquina vuelve a la pantalla de bienvenida.

---

## Puntos por material

| Material | Puntos | Equivalente |
|---|---|---|
| Botella plástica (PET) | 100 | $100 COP |
| Botella de vidrio | 200 | $200 COP |
| Lata de aluminio | 300 | $300 COP |

Máximo **20 envases por sesión**. El tope está validado en la base de datos, no solo en la
pantalla, para que no se pueda saltar desde el navegador.

---

## Puesta en marcha

### 1. Base de datos
Sigue **`GUIA-SUPABASE.md`** completo. Al terminar tendrás un *Project URL* y una *anon key*.

### 2. Configurar
Pega esos dos valores en `maquina/config.js` y en `movil/config.js`.

### 3. Subir a GitHub
```bash
git init
git add .
git commit -m "RECIKLA: máquina + app móvil + base de datos"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/RECIKLA.git
git push -u origin main
```

### 4. Desplegar en Vercel (dos proyectos, un solo repo)

**Proyecto A — la máquina**
1. vercel.com → *Add New* → *Project* → importa el repo `RECIKLA`.
2. **Project Name**: `recikla-maquina`
3. **Framework Preset**: `Other`
4. **Root Directory**: presiona *Edit* y elige la carpeta **`maquina`**
5. Deploy → te queda `https://recikla-maquina.vercel.app`

**Proyecto B — la app móvil**
1. Repite *Add New → Project* con el **mismo repo**.
2. **Project Name**: `recikla-movil`
3. **Framework Preset**: `Other`
4. **Root Directory**: **`movil`**
5. Deploy → te queda `https://recikla-movil.vercel.app`

### 5. Cerrar el círculo
Pon la URL real de la app móvil en `maquina/config.js` → `URL_APP_MOVIL`, haz commit y
sube. Eso es lo que se codifica dentro del QR.

> Ambas apps necesitan **HTTPS** para usar la cámara. Vercel lo da por defecto.

---

## La app de la máquina

- Pantalla dividida: flujo del usuario a la izquierda, cámara en vivo a la derecha.
- Detección con **COCO-SSD** (ubica el envase) + **MobileNet v2** (clasifica el material)
  + heurísticas de forma, brillo metálico y color del vidrio.
- Estados: `ESPERANDO` · `ACEPTADO` · `INVALIDO`, con la etiqueta `PLASTICO` / `VIDRIO` / `LATA`.
- Exige 4 cuadros seguidos coincidentes antes de aceptar, y se bloquea hasta que retiras el
  envase: así se ingresan **uno por uno** sin doble conteo.
- **Atajos de respaldo para la sustentación:** `1` = LATA, `2` = PLASTICO, `3` = VIDRIO.
  Se desactivan con `ATAJOS_ACTIVOS: false` en `config.js`.
- **Modo demo local:** si `config.js` no tiene las llaves de Supabase, la máquina funciona
  sola sin base de datos. Útil para probar la cámara antes de montar el backend.

### Instalar varias máquinas
Agrega la fila en la tabla `maquinas` y despliega otra copia cambiando `CODIGO_MAQUINA`
(`M-002`, `M-003`, …). El nivel de llenado de cada una se actualiza solo y se ve en la app móvil.

---

## La app móvil

| Pantalla | Qué hace |
|---|---|
| **Registro / Login** | Nombre, usuario, teléfono, correo, fecha de nacimiento y contraseña |
| **Inicio** | Balance en puntos y en pesos, máquinas cerca, actividad reciente, soporte e instrucciones |
| **Máquinas** | Mapa y lista con el % de llenado en tiempo real |
| **Escanear** | Lector de QR para iniciar sesión en la máquina sin escribir nada |
| **Canjear** | Convierte puntos en Nequi, Daviplata, Bancolombia o bono (mínimo 2.000) |
| **Perfil** | Datos personales editables y cambio de contraseña |

Es una **PWA**: desde Chrome en Android o Safari en iPhone se puede *Agregar a la pantalla
de inicio* y se abre como una app, sin barra de navegador.

---

## Seguridad

- **RLS activo en las 6 tablas.** Cada usuario solo lee su perfil, sus sesiones y sus canjes.
- `tokens_qr` no es accesible desde el navegador: solo a través de funciones.
- Las operaciones de la máquina son funciones `security definer` que validan antes de
  escribir (sesión activa, material válido, tope de 20, máquina existente).
- La llave `anon` es pública por diseño; la `service_role` **nunca** va en el código.

Limitación conocida de esta versión de prueba: el ingreso por teléfono no pide PIN, para que
la demostración sea rápida. En `GUIA-SUPABASE.md` está explicado cómo agregarlo.
