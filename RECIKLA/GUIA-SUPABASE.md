# Guía paso a paso — Crear la base de datos de RECIKLA en Supabase

Tiempo estimado: **15 minutos**. No necesitas saber SQL: solo copiar y pegar.

---

## Paso 1 · Crear la cuenta y el proyecto

1. Entra a **https://supabase.com** y presiona *Start your project*.
2. Inicia sesión con tu cuenta de GitHub (la misma de `dani3l-aceved00` sirve).
3. Presiona **New project** y llena:
   - **Name**: `recikla`
   - **Database Password**: inventa una y **guárdala en un papel** (no la vas a usar en la app, pero Supabase la pide).
   - **Region**: `East US (North Virginia)` — es la más cercana a Colombia entre las gratuitas.
   - **Plan**: Free.
4. Presiona **Create new project** y espera 1–2 minutos mientras se aprovisiona.

---

## Paso 2 · Crear las tablas y funciones

1. En el menú lateral izquierdo entra a **SQL Editor** (ícono `</>`).
2. Presiona **New query**.
3. Abre el archivo **`supabase/recikla-setup.sql`** de este proyecto, cópialo **completo** y pégalo en el editor.
4. Presiona **Run** (o `Ctrl + Enter`).
5. Debe aparecer `Success. No rows returned`.

**Verificación:** entra a **Table Editor**. Deben existir 6 tablas:
`usuarios`, `maquinas`, `sesiones`, `objetos`, `tokens_qr`, `retiros`.
Abre `maquinas`: deben aparecer 5 máquinas de prueba en Barranquilla.

---

## Paso 3 · Desactivar la confirmación por correo

Si no haces esto, cada usuario que se registre tendrá que ir a su correo antes de poder entrar —
en una demostración eso te frena.

1. Menú lateral → **Authentication** → **Sign In / Providers** → **Email**.
2. Desactiva **Confirm email**.
3. **Save**.

> Para una app real esto se deja activado. Para la sustentación, apagado.

---

## Paso 4 · Copiar tus dos llaves

1. Menú lateral → **Project Settings** (el engranaje) → **Data API**.
   - Copia el **Project URL**. Se ve así: `https://abcdefghijk.supabase.co`
2. En **Project Settings** → **API Keys**.
   - Copia la llave **`anon` / `public`** (empieza por `eyJ...` o `sb_publishable_...`).
   - **No copies** la `service_role`. Esa es secreta y nunca va en el navegador.

> La llave `anon` es pública a propósito. La seguridad la da el **RLS** que ya quedó
> configurado en el paso 2: cada usuario solo puede ver sus propios datos, y las
> operaciones de la máquina pasan por funciones controladas.

---

## Paso 5 · Pegar las llaves en las dos apps

Abre estos dos archivos y reemplaza los valores:

**`maquina/config.js`**
```js
SUPABASE_URL: 'https://abcdefghijk.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi...',
URL_APP_MOVIL: 'https://recikla-movil.vercel.app',   // la URL real de tu app móvil
CODIGO_MAQUINA: 'M-001',
```

**`movil/config.js`**
```js
SUPABASE_URL: 'https://abcdefghijk.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi...',
```

Guarda, haz commit y sube a GitHub. Vercel redespliega solo.

---

## Paso 6 · Probar que todo quedó conectado

1. Abre la **app móvil** → *Crear cuenta* → llena los datos → *Crear mi cuenta*.
   - Debe entrar directo al Inicio con balance en 0.
   - En Supabase → Table Editor → `usuarios` debe aparecer tu fila.
2. Abre la **app de la máquina**. Arriba a la derecha debe decir *Conectado a Supabase*.
3. En la máquina presiona *Ingresar con número de teléfono*, escribe el teléfono que registraste
   y presiona *Buscar mi cuenta*: debe salir tu nombre.
4. Recicla 2 o 3 envases y presiona **FINALIZAR**.
5. Vuelve a la app móvil, entra a Inicio: el balance ya debe reflejar los puntos.
6. Prueba el QR: en la máquina, escanea el código desde el botón central de la app móvil.
   La máquina debe abrir tu sesión sola.

---

## Preguntas que te puede hacer el jurado

**¿Dónde está la seguridad si la llave está en el código?**
En el *Row Level Security* de PostgreSQL. La llave `anon` solo permite lo que las políticas
autorizan: cada usuario lee su propio perfil, sus sesiones y sus canjes. Las tablas
`tokens_qr` no son accesibles directamente desde el navegador. Las operaciones de la
máquina (abrir sesión, registrar envase, abonar puntos) están encapsuladas en funciones
`security definer`, que validan antes de escribir.

**¿Cómo evitan que alguien reclame los puntos de otro?**
El QR de la máquina es un token de un solo uso que expira en 3 minutos y queda ligado al
usuario que lo escaneó desde su sesión autenticada.

**¿Y el ingreso por teléfono?**
En esta versión de prueba basta el número, para que la demo sea rápida. En producción se
agrega un PIN de 4 dígitos definido desde la app (un campo más en `usuarios` y una
validación en `buscar_usuario_telefono`), o un código OTP por SMS.

**¿Cuánto cuesta?**
El plan gratuito de Supabase cubre 500 MB de base de datos y 50.000 usuarios activos al mes.
Para el piloto no cuesta nada.

---

## Si algo sale mal

| Síntoma | Causa más probable | Solución |
|---|---|---|
| La máquina dice *Modo demo local* | `config.js` sigue con los valores de ejemplo | Pega la URL y la anon key reales |
| *Invalid API key* | Copiaste la `service_role` o te faltó un carácter | Vuelve a copiar la `anon` completa |
| Al registrarme no entra | La confirmación por correo sigue activa | Paso 3 de esta guía |
| *La máquina M-001 no está registrada* | No corriste el bloque de datos de prueba | Vuelve a ejecutar el SQL completo |
| *new row violates row-level security* | Se ejecutó solo una parte del SQL | Ejecuta el archivo completo otra vez |
| El QR no hace nada | `URL_APP_MOVIL` apunta a una URL que no existe | Pon la URL real de tu app móvil desplegada |
