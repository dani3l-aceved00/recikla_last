/* ============================================================
   RECIKLA · MÁQUINA — Configuración
   Reemplaza los 3 valores de abajo con los tuyos y listo.
   ============================================================ */
window.RECIKLA_CONFIG = {

  // 1) Supabase → Project Settings → Data API → Project URL
  SUPABASE_URL: 'https://hepmxhsayblvownlllrt.supabase.co/rest/v1/',

  // 2) Supabase → Project Settings → API Keys → anon / public
  //    (esta clave es pública, es seguro dejarla aquí: las tablas están protegidas con RLS)
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhlcG14aHNheWJsdm93bmxsbHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwOTQyOTQsImV4cCI6MjEwNDY3MDI5NH0.WQwXhnOluIM071pH9fM8ZxCSs8O3cVc9l_76b594jxg',

  // 3) URL donde desplegaste la app móvil (sin barra al final).
  //    Es lo que se codifica dentro del QR de la pantalla de bienvenida.
  URL_APP_MOVIL: 'https://recikla-movil.vercel.app',

  // 4) Qué máquina es esta. Debe existir en la tabla "maquinas".
  CODIGO_MAQUINA: 'M-001',

  // ---- Ajustes de operación ----
  MAX_OBJETOS: 20,                                  // tope de envases por sesión
  PUNTOS: { plastico: 100, vidrio: 200, lata: 300 }, // debe coincidir con el SQL
  SEGUNDOS_RESUMEN: 12,                             // tiempo del recibo antes de volver al inicio
  ATAJOS_ACTIVOS: true                              // teclas 1/2/3 de respaldo en la demo
};
