# 🛡️ Sistema de Detección de Intrusos IoT

> **Proyecto Corte 2 — Desarrollo Móvil, Universidad de La Sabana**

Sistema de vigilancia inteligente que combina un celular (cámara), un backend con visión por computadora, y un ESP32 como actuador físico de alarma.

## 📐 Arquitectura

```
┌──────────────┐    base64/HTTP     ┌───────────────┐     HTTP      ┌──────────────┐
│  📱 App Móvil │ ─────────────────▶ │ 🖥️ Backend     │ ────────────▶ │ 🔧 ESP32-S3   │
│  (Expo/RN)   │                    │ (FastAPI +    │              │ (Buzzer+LED) │
│  Cámara      │ ◀───── JSON ────── │  OpenCV)      │              │              │
│  Dashboard   │                    │               │ ── HTTPS ──▶ │              │
│  Control     │                    │               │              │ Heartbeat ─▶ │
└──────────────┘                    └───────┬───────┘              └──────────────┘
                                            │
                                    HTTPS REST API
                                            │
                                    ┌───────▼───────┐
                                    │ 🗄️ Supabase    │
                                    │ (PostgreSQL + │
                                    │  Realtime)    │
                                    └───────────────┘
```

## 📁 Estructura del Proyecto

```
Proyecto_corte2/
├── mobile/              ← Sprint 4: App React Native / Expo
│   ├── App.tsx           ← Entrada principal con Tab Navigator
│   ├── src/
│   │   ├── config.ts     ← Configuración (URL backend, intervalos)
│   │   ├── theme.ts      ← Colores y estilos del diseño dark
│   │   ├── services/
│   │   │   └── api.ts    ← Llamadas HTTP al backend
│   │   └── screens/
│   │       ├── CameraScreen.tsx    ← Captura y vigilancia
│   │       ├── DashboardScreen.tsx ← Estado del sistema
│   │       └── ControlScreen.tsx   ← Configuración y alarma
│   └── app.json          ← Configuración de Expo
│
├── backend/             ← Sprint 3: Backend FastAPI + OpenCV
│   ├── main.py           ← Servidor, detección, alarma, email
│   ├── requirements.txt  ← Dependencias Python
│   ├── .env.example      ← Plantilla de variables de entorno
│   └── .env              ← Variables de entorno (no se sube a git)
│
├── esp32/               ← Sprint 2: Firmware ESP32-S3
│   ├── main.ino          ← Servidor HTTP + alarma + heartbeat
│   └── config.h          ← Wi-Fi, Supabase, pines, tiempos
│
└── supabase/            ← Sprint 1: Esquema de base de datos
    └── sprint1_schema.sql ← Tablas, RLS, triggers, funciones RPC
```

## 🚀 Cómo ejecutar

### 1. Supabase (Base de datos)
1. Crear un proyecto en [supabase.com](https://supabase.com)
2. Ejecutar `supabase/sprint1_schema.sql` en el SQL Editor
3. Copiar la URL y la `service_role` key

### 2. ESP32 (Actuador físico)
1. Abrir `esp32/main.ino` en Arduino IDE
2. Editar `esp32/config.h` con tu Wi-Fi, Supabase URL/key, y device UUID
3. Conectar buzzer a GPIO 4 y LED rojo a GPIO 2
4. Flashear al ESP32-S3

### 3. Backend (Servidor en tu PC)
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env     # Editar con tus credenciales
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```
Verificar en: http://localhost:8000/docs

### 4. App Móvil (Tu celular)
```bash
cd mobile
npm install
```

**⚠ Antes de ejecutar:** Editar `src/config.ts` y cambiar `BACKEND_URL` a la IP de tu PC:
```typescript
BACKEND_URL: "http://192.168.1.50:8000"  // ← Tu IP local
```

Para encontrar tu IP:
- **Windows**: `ipconfig` → IPv4 de tu red Wi-Fi
- **Mac**: `ifconfig en0` → inet

```bash
npx expo start
```
Escanear el QR con **Expo Go** en tu celular (misma red Wi-Fi).

## 📱 Pantallas de la App

| Cámara | Dashboard | Control |
|--------|-----------|---------|
| Captura automática cada 2s | Estado del backend y ESP32 | Toggle detección on/off |
| Detección de movimiento | Estadísticas en tiempo real | Activar/silenciar alarma |
| Flash rojo en alerta | Franja horaria | Configurar horario |
| Cambiar cámara frontal/trasera | Info del dispositivo | Resetear referencia |

## 🔧 Flujo de detección

1. **App** captura foto con la cámara del celular
2. **App** convierte a base64 y envía `POST /analyze` al backend
3. **Backend** decodifica la imagen y ejecuta OpenCV:
   - Convierte a escala de grises
   - Aplica Gaussian Blur (reduce ruido)
   - Calcula diferencia absoluta con frame anterior
   - Umbraliza y cuenta píxeles que cambiaron
4. Si el % de cambio supera el umbral:
   - **Backend** envía `GET /alarm/on` al ESP32
   - **Backend** inserta registro en Supabase
   - **Backend** envía email con foto adjunta (en background)
5. **ESP32** activa buzzer pulsante + LED rojo (auto-apaga en 30s)
6. **App** muestra resultado y badge de alarma

## ⚙️ Variables de entorno (.env)

| Variable | Descripción |
|----------|-------------|
| `SUPABASE_URL` | URL de tu proyecto Supabase |
| `SUPABASE_SERVICE_KEY` | Service role key |
| `DEVICE_ID` | UUID del dispositivo en tabla `devices` |
| `ESP32_FALLBACK_IP` | IP del ESP32 si no se lee de Supabase |
| `SMTP_EMAIL` | Gmail para enviar alertas |
| `SMTP_PASSWORD` | App Password de Gmail |
| `ALERT_EMAIL` | Email destino de alertas |
| `DETECTION_THRESHOLD` | % del frame cubierto por zonas en movimiento para detectar (default: 2.0) |
| `PIXEL_THRESHOLD` | Diferencia de brillo (0-255) para considerar un píxel cambiado (default: 25) |
| `MIN_BLOB_AREA` | % mínimo del frame de una zona para que cuente; filtra ruido (default: 0.3) |
| `SCENE_CHANGE_THRESHOLD` | Similitud mínima con el fondo; por debajo = objeto muy cerca / cámara tapada (default: 0.6) |
| `STALE_SCENE_FRAMES` | Frames quietos tras un cambio para aceptarlo como nuevo fondo (default: 15) |
| `COOLDOWN_SECONDS` | Segundos entre alertas (default: 30) |

## 🛠️ Tecnologías

- **Frontend**: React Native + Expo (TypeScript)
- **Backend**: FastAPI + OpenCV + Python
- **IoT**: ESP32-S3 + Arduino (C/C++)
- **Base de datos**: PostgreSQL (Supabase)
- **Comunicación**: HTTP REST + HTTPS + Realtime subscriptions
