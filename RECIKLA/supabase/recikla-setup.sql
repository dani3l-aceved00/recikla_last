-- ============================================================
--  RECIKLA · Estructura completa de la base de datos
--  Pega TODO este archivo en Supabase → SQL Editor → Run
--  Se puede volver a ejecutar sin romper nada.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TABLAS
-- ------------------------------------------------------------

-- Perfil del usuario (se crea solo al registrarse en la app móvil)
create table if not exists public.usuarios (
  id               uuid primary key references auth.users(id) on delete cascade,
  nombre_completo  text not null,
  nombre_usuario   text unique,
  telefono         text unique,
  correo           text,
  fecha_nacimiento date,
  puntos           integer not null default 0,
  creado_en        timestamptz not null default now()
);

-- Máquinas RECIKLA instaladas
create table if not exists public.maquinas (
  id               uuid primary key default gen_random_uuid(),
  codigo           text unique not null,
  nombre           text not null,
  direccion        text,
  ciudad           text,
  lat              double precision,
  lng              double precision,
  capacidad_max    integer not null default 400,
  objetos_actuales integer not null default 0,
  estado           text not null default 'activa'
                   check (estado in ('activa','mantenimiento','llena','fuera_servicio')),
  actualizado_en   timestamptz not null default now()
);

-- Cada visita de un usuario a una máquina
create table if not exists public.sesiones (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid references public.usuarios(id) on delete set null,
  maquina_id     uuid references public.maquinas(id),
  iniciada_en    timestamptz not null default now(),
  finalizada_en  timestamptz,
  total_objetos  integer not null default 0,
  total_puntos   integer not null default 0,
  estado         text not null default 'activa'
                 check (estado in ('activa','finalizada','cancelada'))
);

-- Cada envase individual depositado
create table if not exists public.objetos (
  id           bigserial primary key,
  sesion_id    uuid not null references public.sesiones(id) on delete cascade,
  material     text not null check (material in ('plastico','vidrio','lata')),
  puntos       integer not null,
  detectado_en timestamptz not null default now()
);

-- Códigos QR temporales que muestra la máquina para el inicio de sesión rápido
create table if not exists public.tokens_qr (
  token      text primary key,
  maquina_id uuid not null references public.maquinas(id) on delete cascade,
  usuario_id uuid references public.usuarios(id) on delete set null,
  estado     text not null default 'pendiente'
             check (estado in ('pendiente','vinculado','usado','expirado')),
  creado_en  timestamptz not null default now(),
  expira_en  timestamptz not null default now() + interval '3 minutes'
);

-- Solicitudes de canje / retiro de puntos
create table if not exists public.retiros (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references public.usuarios(id) on delete cascade,
  puntos        integer not null check (puntos > 0),
  metodo        text not null,
  destino       text,
  estado        text not null default 'solicitado'
                check (estado in ('solicitado','pagado','rechazado')),
  solicitado_en timestamptz not null default now()
);

create index if not exists idx_sesiones_usuario on public.sesiones(usuario_id, iniciada_en desc);
create index if not exists idx_objetos_sesion   on public.objetos(sesion_id);
create index if not exists idx_retiros_usuario  on public.retiros(usuario_id, solicitado_en desc);


-- ------------------------------------------------------------
-- 2. CREACIÓN AUTOMÁTICA DEL PERFIL AL REGISTRARSE
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usuarios (id, nombre_completo, nombre_usuario, telefono, correo, fecha_nacimiento)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'nombre_completo',''), 'Usuario RECIKLA'),
    nullif(new.raw_user_meta_data->>'nombre_usuario',''),
    regexp_replace(coalesce(new.raw_user_meta_data->>'telefono',''), '\D', '', 'g'),
    new.email,
    nullif(new.raw_user_meta_data->>'fecha_nacimiento','')::date
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ------------------------------------------------------------
-- 3. FUNCIONES QUE USA LA MÁQUINA
--    (security definer = la máquina puede operar sin exponer las tablas)
-- ------------------------------------------------------------

-- 3.1 Generar un código QR temporal para la pantalla de bienvenida
create or replace function public.crear_token_qr(p_maquina_codigo text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_maq public.maquinas; v_token text;
begin
  select * into v_maq from public.maquinas where codigo = p_maquina_codigo;
  if v_maq.id is null then
    raise exception 'La máquina % no está registrada', p_maquina_codigo;
  end if;

  update public.tokens_qr set estado = 'expirado'
   where estado = 'pendiente' and expira_en < now();

  v_token := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.tokens_qr (token, maquina_id) values (v_token, v_maq.id);

  return json_build_object(
    'token', v_token,
    'maquina', v_maq.nombre,
    'codigo', v_maq.codigo,
    'expira_en', now() + interval '3 minutes'
  );
end;
$$;

-- 3.2 La máquina consulta si alguien ya escaneó el QR
create or replace function public.estado_token_qr(p_token text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_t public.tokens_qr; v_u public.usuarios;
begin
  select * into v_t from public.tokens_qr where token = p_token;
  if v_t.token is null then
    return json_build_object('estado','inexistente');
  end if;
  if v_t.estado = 'pendiente' and v_t.expira_en < now() then
    return json_build_object('estado','expirado');
  end if;
  select * into v_u from public.usuarios where id = v_t.usuario_id;
  return json_build_object(
    'estado', v_t.estado,
    'usuario_id', v_t.usuario_id,
    'nombre', v_u.nombre_completo,
    'nombre_usuario', v_u.nombre_usuario,
    'puntos', v_u.puntos
  );
end;
$$;

-- 3.3 Buscar usuario por número de teléfono (ingreso manual en la máquina)
create or replace function public.buscar_usuario_telefono(p_telefono text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_u public.usuarios;
begin
  select * into v_u from public.usuarios
   where telefono = regexp_replace(p_telefono, '\D', '', 'g')
   limit 1;
  if v_u.id is null then
    return json_build_object('encontrado', false);
  end if;
  return json_build_object(
    'encontrado', true,
    'usuario_id', v_u.id,
    'nombre', v_u.nombre_completo,
    'nombre_usuario', v_u.nombre_usuario,
    'puntos', v_u.puntos
  );
end;
$$;

-- 3.4 Abrir la sesión de reciclaje
create or replace function public.iniciar_sesion_maquina(
  p_usuario_id uuid,
  p_maquina_codigo text,
  p_token text default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_maq public.maquinas; v_ses public.sesiones;
begin
  select * into v_maq from public.maquinas where codigo = p_maquina_codigo;
  if v_maq.id is null then raise exception 'Máquina % no registrada', p_maquina_codigo; end if;
  if v_maq.estado <> 'activa' then raise exception 'La máquina está en estado %', v_maq.estado; end if;

  -- cierra sesiones colgadas del mismo usuario
  update public.sesiones set estado = 'cancelada', finalizada_en = now()
   where usuario_id = p_usuario_id and estado = 'activa';

  insert into public.sesiones (usuario_id, maquina_id)
  values (p_usuario_id, v_maq.id)
  returning * into v_ses;

  if p_token is not null then
    update public.tokens_qr set estado = 'usado' where token = p_token;
  end if;

  return json_build_object('sesion_id', v_ses.id, 'maquina', v_maq.nombre, 'codigo', v_maq.codigo);
end;
$$;

-- 3.5 Registrar un envase detectado (máximo 20 por sesión)
create or replace function public.registrar_objeto(p_sesion_id uuid, p_material text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_ses public.sesiones; v_puntos int; v_max int := 20;
begin
  select * into v_ses from public.sesiones where id = p_sesion_id for update;
  if v_ses.id is null then raise exception 'La sesión no existe'; end if;
  if v_ses.estado <> 'activa' then raise exception 'La sesión ya fue finalizada'; end if;

  if v_ses.total_objetos >= v_max then
    return json_build_object('ok', false, 'motivo', 'limite',
      'total_objetos', v_ses.total_objetos, 'total_puntos', v_ses.total_puntos, 'limite', true);
  end if;

  v_puntos := case p_material
                when 'plastico' then 100
                when 'vidrio'   then 200
                when 'lata'     then 300
              end;
  if v_puntos is null then raise exception 'Material % no válido', p_material; end if;

  insert into public.objetos (sesion_id, material, puntos)
  values (p_sesion_id, p_material, v_puntos);

  update public.sesiones
     set total_objetos = total_objetos + 1,
         total_puntos  = total_puntos + v_puntos
   where id = p_sesion_id
  returning * into v_ses;

  update public.maquinas
     set objetos_actuales = least(capacidad_max, objetos_actuales + 1),
         actualizado_en = now(),
         estado = case when objetos_actuales + 1 >= capacidad_max then 'llena' else estado end
   where id = v_ses.maquina_id;

  return json_build_object('ok', true, 'puntos', v_puntos,
    'total_objetos', v_ses.total_objetos, 'total_puntos', v_ses.total_puntos,
    'limite', v_ses.total_objetos >= v_max, 'restantes', v_max - v_ses.total_objetos);
end;
$$;

-- 3.6 Finalizar y abonar los puntos a la cuenta
create or replace function public.finalizar_sesion(p_sesion_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_ses public.sesiones; v_u public.usuarios;
begin
  update public.sesiones
     set estado = 'finalizada', finalizada_en = now()
   where id = p_sesion_id and estado = 'activa'
  returning * into v_ses;

  if v_ses.id is null then
    select * into v_ses from public.sesiones where id = p_sesion_id;
    if v_ses.id is null then raise exception 'La sesión no existe'; end if;
  end if;

  if v_ses.usuario_id is not null and v_ses.total_puntos > 0 then
    update public.usuarios set puntos = puntos + v_ses.total_puntos
     where id = v_ses.usuario_id
    returning * into v_u;
  else
    select * into v_u from public.usuarios where id = v_ses.usuario_id;
  end if;

  return json_build_object(
    'total_objetos', v_ses.total_objetos,
    'total_puntos',  v_ses.total_puntos,
    'balance',       coalesce(v_u.puntos, 0),
    'nombre',        v_u.nombre_completo
  );
end;
$$;


-- ------------------------------------------------------------
-- 4. FUNCIONES QUE USA LA APP MÓVIL
-- ------------------------------------------------------------

-- 4.1 Verificar si un teléfono o usuario ya están tomados (antes de registrar)
create or replace function public.disponibilidad(p_telefono text, p_nombre_usuario text)
returns json
language sql security definer set search_path = public
as $$
  select json_build_object(
    'telefono_libre', not exists (
      select 1 from public.usuarios where telefono = regexp_replace(p_telefono,'\D','','g')),
    'usuario_libre', not exists (
      select 1 from public.usuarios where lower(nombre_usuario) = lower(p_nombre_usuario))
  );
$$;

-- 4.2 El usuario vincula su cuenta al QR que muestra la máquina
create or replace function public.vincular_token_qr(p_token text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_t public.tokens_qr; v_u public.usuarios; v_maq public.maquinas;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión en la app'; end if;

  select * into v_t from public.tokens_qr where token = p_token for update;
  if v_t.token is null then raise exception 'Código QR no válido'; end if;
  if v_t.expira_en < now() then raise exception 'El código expiró. Toca la pantalla de la máquina para generar uno nuevo'; end if;
  if v_t.estado <> 'pendiente' then raise exception 'Este código ya fue utilizado'; end if;

  update public.tokens_qr set usuario_id = auth.uid(), estado = 'vinculado' where token = p_token;

  select * into v_u from public.usuarios where id = auth.uid();
  select * into v_maq from public.maquinas where id = v_t.maquina_id;

  return json_build_object('ok', true, 'maquina', v_maq.nombre,
                           'codigo', v_maq.codigo, 'nombre', v_u.nombre_completo);
end;
$$;

-- 4.3 Solicitar canje / retiro de puntos
create or replace function public.solicitar_retiro(p_puntos int, p_metodo text, p_destino text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_u public.usuarios; v_min int := 2000;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión'; end if;
  select * into v_u from public.usuarios where id = auth.uid() for update;
  if p_puntos < v_min then raise exception 'El canje mínimo es de % puntos', v_min; end if;
  if p_puntos > v_u.puntos then raise exception 'No tienes puntos suficientes'; end if;

  insert into public.retiros (usuario_id, puntos, metodo, destino)
  values (auth.uid(), p_puntos, p_metodo, p_destino);

  update public.usuarios set puntos = puntos - p_puntos where id = auth.uid()
  returning * into v_u;

  return json_build_object('ok', true, 'balance', v_u.puntos);
end;
$$;


-- ------------------------------------------------------------
-- 5. PERMISOS DE EJECUCIÓN
-- ------------------------------------------------------------
grant execute on function public.crear_token_qr(text)                    to anon, authenticated;
grant execute on function public.estado_token_qr(text)                   to anon, authenticated;
grant execute on function public.buscar_usuario_telefono(text)           to anon, authenticated;
grant execute on function public.iniciar_sesion_maquina(uuid,text,text)  to anon, authenticated;
grant execute on function public.registrar_objeto(uuid,text)             to anon, authenticated;
grant execute on function public.finalizar_sesion(uuid)                  to anon, authenticated;
grant execute on function public.disponibilidad(text,text)               to anon, authenticated;
grant execute on function public.vincular_token_qr(text)                 to authenticated;
grant execute on function public.solicitar_retiro(int,text,text)         to authenticated;


-- ------------------------------------------------------------
-- 6. SEGURIDAD A NIVEL DE FILA (RLS)
--    Nadie puede leer ni escribir las tablas directamente,
--    salvo sus propios datos. Todo lo demás pasa por las funciones.
-- ------------------------------------------------------------
alter table public.usuarios  enable row level security;
alter table public.maquinas  enable row level security;
alter table public.sesiones  enable row level security;
alter table public.objetos   enable row level security;
alter table public.tokens_qr enable row level security;
alter table public.retiros   enable row level security;

drop policy if exists "perfil propio lectura"    on public.usuarios;
drop policy if exists "perfil propio escritura"  on public.usuarios;
create policy "perfil propio lectura"   on public.usuarios for select using (auth.uid() = id);
create policy "perfil propio escritura" on public.usuarios for update using (auth.uid() = id);

drop policy if exists "maquinas visibles" on public.maquinas;
create policy "maquinas visibles" on public.maquinas for select to anon, authenticated using (true);

drop policy if exists "sesiones propias" on public.sesiones;
create policy "sesiones propias" on public.sesiones for select using (auth.uid() = usuario_id);

drop policy if exists "objetos propios" on public.objetos;
create policy "objetos propios" on public.objetos for select using (
  exists (select 1 from public.sesiones s where s.id = objetos.sesion_id and s.usuario_id = auth.uid())
);

drop policy if exists "retiros propios" on public.retiros;
create policy "retiros propios" on public.retiros for select using (auth.uid() = usuario_id);

-- tokens_qr: sin políticas => solo accesible desde las funciones security definer


-- ------------------------------------------------------------
-- 7. MÁQUINAS DE PRUEBA (Barranquilla)
-- ------------------------------------------------------------
insert into public.maquinas (codigo, nombre, direccion, ciudad, lat, lng, capacidad_max, objetos_actuales)
values
  ('M-001','RECIKLA Centro Comercial Buenavista','Cra 53 #98-99','Barranquilla', 11.0043, -74.8092, 400, 128),
  ('M-002','RECIKLA Universidad del Norte','Km 5 Vía Puerto Colombia','Barranquilla', 11.0192, -74.8506, 400, 342),
  ('M-003','RECIKLA Parque Sagrado Corazón','Cra 43 #70-30','Barranquilla', 10.9975, -74.8010, 300, 61),
  ('M-004','RECIKLA Éxito Country','Cra 51B #87-50','Barranquilla', 11.0110, -74.8180, 400, 389),
  ('M-005','RECIKLA Terminal de Transportes','Calle 54 #6-250','Soledad', 10.9142, -74.7830, 500, 90)
on conflict (codigo) do nothing;

-- ============================================================
--  LISTO. Revisa Table Editor: deben aparecer 6 tablas y 5 máquinas.
-- ============================================================
