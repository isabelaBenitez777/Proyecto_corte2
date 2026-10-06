-- ============================================================
-- SPRINT 1: ESQUEMA SUPABASE — DETECCIÓN DE INTRUSOS IoT
-- Optimizado para baja latencia y alta frecuencia de escritura
-- ============================================================

-- 0. Habilitar extensiones necesarias
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- Para gen_random_uuid()


-- 1. TABLA: devices (Registro de dispositivos ESP32)
-- ============================================================
-- Cada ESP32-S3 CAM se registra aquí con su token único.
-- El token se usa para autenticar las escrituras desde el ESP32.
CREATE TABLE public.devices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias       TEXT NOT NULL DEFAULT 'ESP32-CAM',
    token       TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_owner ON public.devices(owner_id);
CREATE INDEX idx_devices_token ON public.devices(token);

COMMENT ON TABLE public.devices IS 'Registro de dispositivos ESP32-S3 CAM. Cada uno tiene un token único para autenticar escrituras.';


-- 2. TABLA: device_status (Estado en tiempo real del dispositivo)
-- ============================================================
-- Relación 1:1 con devices. Se actualiza con UPSERT desde el ESP32.
-- Diseño: una sola fila por dispositivo, se sobreescribe (no crece).
CREATE TABLE public.device_status (
    device_id       UUID PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
    is_online       BOOLEAN NOT NULL DEFAULT FALSE,
    is_streaming    BOOLEAN NOT NULL DEFAULT FALSE,
    is_detecting    BOOLEAN NOT NULL DEFAULT FALSE,
    local_ip        INET,
    wifi_rssi       SMALLINT,
    free_heap       INTEGER,
    uptime_secs     INTEGER DEFAULT 0,
    last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.device_status IS 'Estado en tiempo real del ESP32. Relación 1:1 con devices. Se actualiza vía UPSERT, nunca crece.';


-- 3. TABLA: detection_logs (Eventos de detección de movimiento)
-- ============================================================
-- Esta tabla SÍ crece. Cada detección de movimiento genera un registro.
CREATE TABLE public.detection_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id       UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    confidence      REAL CHECK (confidence >= 0 AND confidence <= 100),
    frame_diff_pct  REAL,
    snapshot_url    TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_logs_device_time ON public.detection_logs(device_id, detected_at DESC);
CREATE INDEX idx_logs_created ON public.detection_logs(created_at);

COMMENT ON TABLE public.detection_logs IS 'Log de eventos de detección de movimiento. Crece con el tiempo. Indexado para queries recientes.';


-- 4. TABLA: alert_settings (Preferencias de alertas del usuario)
-- ============================================================
CREATE TABLE public.alert_settings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    device_id       UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
    email_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    email_address   TEXT,
    cooldown_secs   INTEGER NOT NULL DEFAULT 60,
    last_alert_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_alert_user_device UNIQUE (user_id, device_id)
);

CREATE INDEX idx_alert_user ON public.alert_settings(user_id);

COMMENT ON TABLE public.alert_settings IS 'Configuración de alertas por usuario y dispositivo. Cooldown anti-spam incluido.';


-- ============================================================
-- 5. POLÍTICAS DE SEGURIDAD (Row Level Security)
-- ============================================================

ALTER TABLE public.devices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_status    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.detection_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_settings   ENABLE ROW LEVEL SECURITY;

-- ---- devices ----
CREATE POLICY "Usuarios ven sus propios dispositivos"
    ON public.devices FOR SELECT
    USING (auth.uid() = owner_id);

CREATE POLICY "Usuarios crean sus propios dispositivos"
    ON public.devices FOR INSERT
    WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Usuarios actualizan sus propios dispositivos"
    ON public.devices FOR UPDATE
    USING (auth.uid() = owner_id)
    WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "Usuarios eliminan sus propios dispositivos"
    ON public.devices FOR DELETE
    USING (auth.uid() = owner_id);

-- ---- device_status ----
CREATE POLICY "Usuarios ven estado de sus dispositivos"
    ON public.device_status FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.devices d
            WHERE d.id = device_status.device_id
              AND d.owner_id = auth.uid()
        )
    );

-- ---- detection_logs ----
CREATE POLICY "Usuarios ven logs de sus dispositivos"
    ON public.detection_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.devices d
            WHERE d.id = detection_logs.device_id
              AND d.owner_id = auth.uid()
        )
    );

-- ---- alert_settings ----
CREATE POLICY "Usuarios ven sus configuraciones de alerta"
    ON public.alert_settings FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Usuarios crean sus configuraciones de alerta"
    ON public.alert_settings FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios actualizan sus configuraciones de alerta"
    ON public.alert_settings FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Usuarios eliminan sus configuraciones de alerta"
    ON public.alert_settings FOR DELETE
    USING (auth.uid() = user_id);


-- ============================================================
-- 6. TRIGGER: Auto-actualizar updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER set_updated_at_devices
    BEFORE UPDATE ON public.devices
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_device_status
    BEFORE UPDATE ON public.device_status
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_alert_settings
    BEFORE UPDATE ON public.alert_settings
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();


-- ============================================================
-- 7. HABILITAR REALTIME para tablas críticas
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_status;
ALTER PUBLICATION supabase_realtime ADD TABLE public.detection_logs;


-- ============================================================
-- 8. FUNCIÓN RPC: Dashboard en 1 sola llamada
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_dashboard_summary(p_device_id UUID)
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'status', (
            SELECT json_build_object(
                'is_online',      ds.is_online,
                'is_streaming',   ds.is_streaming,
                'is_detecting',   ds.is_detecting,
                'wifi_rssi',      ds.wifi_rssi,
                'last_heartbeat', ds.last_heartbeat
            )
            FROM public.device_status ds
            WHERE ds.device_id = p_device_id
        ),
        'recent_detections', (
            SELECT COALESCE(json_agg(row_to_json(sub)), '[]'::json)
            FROM (
                SELECT dl.id, dl.detected_at, dl.confidence, dl.frame_diff_pct
                FROM public.detection_logs dl
                WHERE dl.device_id = p_device_id
                ORDER BY dl.detected_at DESC
                LIMIT 20
            ) sub
        ),
        'total_detections_24h', (
            SELECT COUNT(*)
            FROM public.detection_logs dl
            WHERE dl.device_id = p_device_id
              AND dl.detected_at >= now() - INTERVAL '24 hours'
        )
    ) INTO result;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

COMMENT ON FUNCTION public.get_dashboard_summary IS 'Devuelve estado + últimas 20 detecciones + conteo 24h en UNA sola llamada.';
