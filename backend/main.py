"""
============================================================
SPRINT 3: Backend FastAPI — Detección de Intrusos
============================================================
Corre en el PC. Recibe imágenes del celular, detecta movimiento
con OpenCV, y dispara: alarma en ESP32 + email + log en Supabase.

Iniciar:  uvicorn main:app --host 0.0.0.0 --port 8000 --reload
Docs:     http://localhost:8000/docs
============================================================
"""

import os
import re
import json
import base64
import smtplib
import logging
from io import BytesIO
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.image import MIMEImage
from datetime import datetime, time as dtime
from contextlib import asynccontextmanager

import cv2
import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

# ============================================================
# 1. CONFIGURACIÓN
# ============================================================

load_dotenv()

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# ESP32
DEVICE_ID = os.getenv("DEVICE_ID", "")
ESP32_FALLBACK_IP = os.getenv("ESP32_FALLBACK_IP", "192.168.1.100")

# Email
SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_EMAIL = os.getenv("SMTP_EMAIL", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
ALERT_EMAIL = os.getenv("ALERT_EMAIL", "")

# Detección
DETECTION_THRESHOLD = float(os.getenv("DETECTION_THRESHOLD", "2.0"))     # % del frame cubierto por zonas en movimiento
PIXEL_THRESHOLD = int(os.getenv("PIXEL_THRESHOLD", "25"))                # Diferencia de brillo (0-255) para considerar un píxel "cambiado"
MIN_BLOB_AREA = float(os.getenv("MIN_BLOB_AREA", "0.3"))                 # % mínimo del frame para que una zona cuente (filtra ruido)
SCENE_CHANGE_THRESHOLD = float(os.getenv("SCENE_CHANGE_THRESHOLD", "0.6"))  # Similitud estructural mínima (0-1) con el fondo
STALE_SCENE_FRAMES = int(os.getenv("STALE_SCENE_FRAMES", "15"))          # Frames quietos seguidos para aceptar una escena nueva como fondo
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", "30"))

# Horario
SCHEDULE_START = os.getenv("SCHEDULE_START", "00:00")
SCHEDULE_END = os.getenv("SCHEDULE_END", "23:59")

# Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
logger = logging.getLogger("intruder-api")

# Archivo local donde se guarda el correo configurado desde la app
# Usamos .settings.json (oculto) para que uvicorn --reload no reinicie el servidor al guardarlo
SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".settings.json")
EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _load_settings() -> dict:
    """Lee settings.json (si existe)."""
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_settings(data: dict) -> None:
    """Guarda settings.json."""
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ============================================================
# 2. ESTADO EN MEMORIA
# ============================================================

class AppState:
    """Estado mutable del backend. Vive mientras el servidor corra."""

    def __init__(self):
        self.background: np.ndarray | None = None       # Fondo acumulado (float, grayscale+blur)
        self.previous_frame: np.ndarray | None = None   # Frame inmediatamente anterior (uint8)
        self.static_detections: int = 0                  # Detecciones seguidas con la escena quieta
        self.last_alert_time: datetime | None = None     # Último momento de alerta
        self.total_analyses: int = 0                      # Total de imágenes analizadas
        self.total_detections: int = 0                    # Total de movimientos detectados
        self.esp32_ip: str = ESP32_FALLBACK_IP            # IP del ESP32 (actualizada por heartbeat)
        self.last_detection_pct: float = 0.0              # Último % de diferencia
        self.detection_active: bool = True                # Detección habilitada/deshabilitada
        self.schedule_start: dtime = _parse_time(SCHEDULE_START)
        self.schedule_end: dtime = _parse_time(SCHEDULE_END)
        # Correo destino de alertas: el de la app tiene prioridad sobre el .env
        self.alert_email: str = _load_settings().get("alert_email") or ALERT_EMAIL


def _parse_time(s: str) -> dtime:
    """Parsea 'HH:MM' a objeto time."""
    parts = s.strip().split(":")
    return dtime(int(parts[0]), int(parts[1]))


state = AppState()


# ============================================================
# 3. CLIENTE HTTP COMPARTIDO (lifecycle con FastAPI)
# ============================================================

http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Crea el cliente HTTP al iniciar y lo cierra al apagar."""
    global http_client
    http_client = httpx.AsyncClient(timeout=httpx.Timeout(10.0))
    logger.info("🟢 Backend iniciado | Docs: http://localhost:8000/docs")
    _refresh_esp32_ip_sync()
    yield
    await http_client.aclose()
    logger.info("🔴 Backend detenido")


def _refresh_esp32_ip_sync():
    """Intenta leer la IP del ESP32 de Supabase al inicio (síncrono)."""
    if not SUPABASE_URL or not SUPABASE_KEY or not DEVICE_ID:
        logger.warning("⚠ Supabase no configurado. Usando IP fallback: %s", ESP32_FALLBACK_IP)
        return
    try:
        resp = httpx.get(
            f"{SUPABASE_URL}/rest/v1/device_status?device_id=eq.{DEVICE_ID}&select=local_ip",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            timeout=5.0,
        )
        data = resp.json()
        if data and data[0].get("local_ip"):
            state.esp32_ip = data[0]["local_ip"]
            logger.info("✅ ESP32 IP desde Supabase: %s", state.esp32_ip)
    except Exception as e:
        logger.warning("⚠ No se pudo leer IP del ESP32: %s. Usando fallback: %s", e, ESP32_FALLBACK_IP)


# ============================================================
# 4. APP FASTAPI
# ============================================================

app = FastAPI(
    title="Detección de Intrusos - Backend",
    version="Sprint 3",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Permitir la app Expo y cualquier origen
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# 5. MODELOS (Pydantic)
# ============================================================

class ImagePayload(BaseModel):
    """Imagen enviada por la app móvil."""
    image: str = Field(..., description="Imagen JPEG en base64")


class AnalysisResponse(BaseModel):
    """Respuesta del análisis de movimiento."""
    motion_detected: bool
    diff_percentage: float
    changed_pixels: int
    total_pixels: int
    alarm_triggered: bool
    within_schedule: bool
    cooldown_active: bool
    message: str


class SchedulePayload(BaseModel):
    """Configuración de franja horaria."""
    start: str = Field(..., pattern=r"^\d{2}:\d{2}$", examples=["22:00"])
    end: str = Field(..., pattern=r"^\d{2}:\d{2}$", examples=["06:00"])


class AlertEmailPayload(BaseModel):
    """Correo destino de las alertas (configurado por el usuario)."""
    email: str = Field(..., examples=["usuario@gmail.com"])


# ============================================================
# 6. DETECCIÓN DE MOVIMIENTO (OpenCV)
# ============================================================

MORPH_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))


def _scene_similarity(gray: np.ndarray, background: np.ndarray) -> float:
    """
    Similitud estructural (correlación normalizada, -1..1) entre el frame y el fondo.

    Es inmune a cambios globales de brillo/exposición, así que detecta lo que el
    diff de píxeles se pierde: un objeto muy cerca de la cámara (desenfocado,
    de color uniforme y con la autoexposición compensando) o la cámara tapada.
    """
    h, w = gray.shape
    size = (64, max(1, round(64 * h / w)))
    cur = cv2.resize(gray, size, interpolation=cv2.INTER_AREA)
    bg = cv2.resize(background, size, interpolation=cv2.INTER_AREA)

    # Fondo sin textura (ej. cuarto oscuro): la correlación no es confiable
    if bg.std() < 8:
        return 1.0
    # Imagen actual casi uniforme con un fondo con textura = cámara tapada
    if cur.std() < 8:
        return 0.0
    return float(cv2.matchTemplate(cur, bg, cv2.TM_CCOEFF_NORMED)[0][0])


def detect_motion(current_frame: np.ndarray) -> tuple[bool, float, int, int]:
    """
    Detecta movimiento combinando tres señales:

      1. Diff contra el fondo acumulado → intrusos lentos o que se quedan quietos.
      2. Diff contra el frame anterior → movimientos rápidos que el fondo
         (que se actualiza lento) todavía no "ve" bien.
      3. Similitud estructural con el fondo → objetos muy cerca de la cámara
         o cámara tapada, donde el diff de brillo falla por la autoexposición.

    Las zonas cambiadas se limpian (apertura morfológica) y solo cuentan las
    manchas de tamaño >= MIN_BLOB_AREA, rellenando sus huecos interiores; así el
    ruido del sensor no suma y un objeto grande/uniforme cuenta completo.

    Returns: (detected, percentage, changed_pixels, total_pixels)
    """
    gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)

    # Blur 5x5: suficiente contra ruido del sensor; uno más grande borra
    # los bordes de objetos movidos (que ya vienen borrosos por velocidad)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    total = gray.size

    # Primera imagen, o cambió la resolución/orientación: nueva referencia
    if state.background is None or state.background.shape != gray.shape:
        state.background = gray.astype("float")
        state.previous_frame = gray
        state.static_detections = 0
        logger.info("📸 Frame de referencia almacenado (%dx%d)", gray.shape[1], gray.shape[0])
        return False, 0.0, 0, total

    background = cv2.convertScaleAbs(state.background)

    # Compensar autoexposición del celular y cambios suaves de luz: igualar el
    # brillo medio al del fondo para que no cuente como movimiento.
    # (Si la luz cambia más que esto, lo cubre el reemplazo de escena estable.)
    cur_median = float(np.median(gray))
    if cur_median > 0:
        gain = float(np.clip(np.median(background) / cur_median, 0.7, 1.4))
        gray = cv2.convertScaleAbs(gray, alpha=gain)

    # 1 y 2: diferencias contra el fondo y contra el frame anterior
    _, bg_mask = cv2.threshold(cv2.absdiff(background, gray), PIXEL_THRESHOLD, 255, cv2.THRESH_BINARY)
    _, frame_mask = cv2.threshold(cv2.absdiff(state.previous_frame, gray), PIXEL_THRESHOLD, 255, cv2.THRESH_BINARY)
    frame_change_pct = np.count_nonzero(frame_mask) / total * 100.0

    mask = cv2.bitwise_or(bg_mask, frame_mask)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, MORPH_KERNEL)        # quita puntos sueltos de ruido
    mask = cv2.dilate(mask, MORPH_KERNEL, iterations=2)                # une fragmentos del mismo objeto

    # Solo manchas grandes; el área del contorno incluye los huecos interiores
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = total * MIN_BLOB_AREA / 100.0
    changed = int(min(total, sum(a for a in (cv2.contourArea(c) for c in contours) if a >= min_area)))
    percentage = changed / total * 100.0

    # 3: cambio estructural de la escena (objeto muy cerca / cámara tapada)
    similarity = _scene_similarity(gray, background)
    scene_changed = similarity < SCENE_CHANGE_THRESHOLD

    detected = percentage >= DETECTION_THRESHOLD or scene_changed
    if scene_changed:
        logger.info("👁 Cambio de escena: similitud %.2f (objeto cerca o cámara tapada)", similarity)

    # Si la escena cambió pero lleva varios frames quieta (cámara movida,
    # luz encendida, objeto dejado), se acepta como el nuevo fondo para no
    # quedar alertando para siempre.
    if detected and frame_change_pct < 0.5:
        state.static_detections += 1
    else:
        state.static_detections = 0

    if state.static_detections >= STALE_SCENE_FRAMES:
        state.background = gray.astype("float")
        state.static_detections = 0
        logger.info("🔄 Escena estable %d frames: nuevo fondo de referencia", STALE_SCENE_FRAMES)
    else:
        # Fondo gradual: lento con detección (no absorber al intruso),
        # más rápido sin ella (ajustarse a cambios de luz)
        alpha = 0.02 if detected else 0.1
        cv2.accumulateWeighted(gray, state.background, alpha)

    state.previous_frame = gray

    return detected, round(percentage, 2), changed, total


# ============================================================
# 7. VALIDACIÓN DE HORARIO
# ============================================================

def is_within_schedule() -> bool:
    """Verifica si la hora actual está dentro de la franja de vigilancia."""
    now = datetime.now().time()
    start = state.schedule_start
    end = state.schedule_end

    # Caso normal: 08:00 - 18:00
    if start <= end:
        return start <= now <= end

    # Caso nocturno: 22:00 - 06:00 (cruza medianoche)
    return now >= start or now <= end


def is_cooldown_active() -> bool:
    """Verifica si estamos dentro del período de cooldown anti-spam."""
    if state.last_alert_time is None:
        return False
    elapsed = (datetime.now() - state.last_alert_time).total_seconds()
    return elapsed < COOLDOWN_SECONDS


# ============================================================
# 8. ACCIONES POST-DETECCIÓN
# ============================================================

async def trigger_esp32_alarm():
    """Envía GET /alarm/on al ESP32."""
    url = f"http://{state.esp32_ip}/alarm/on"
    try:
        resp = await http_client.get(url, timeout=5.0)
        logger.info("🚨 ESP32 alarma activada (HTTP %d)", resp.status_code)
        return True
    except Exception as e:
        logger.error("⚠ ESP32 no alcanzable (%s): %s", url, e)
        return False


async def log_to_supabase(diff_pct: float, changed: int):
    """Inserta un registro en detection_logs de Supabase."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        logger.warning("⚠ Supabase no configurado, log omitido")
        return

    payload = {
        "device_id": DEVICE_ID,
        "confidence": round(min(diff_pct * 10, 100), 1),  # Escalar % a 0-100
        "frame_diff_pct": diff_pct,
        "metadata": {
            "changed_pixels": changed,
            "source": "phone_camera",
            "backend": "fastapi",
        },
    }

    try:
        resp = await http_client.post(
            f"{SUPABASE_URL}/rest/v1/detection_logs",
            json=payload,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )
        logger.info("📝 Log guardado en Supabase (HTTP %d)", resp.status_code)
    except Exception as e:
        logger.error("⚠ Error guardando log: %s", e)


def send_alert_email(diff_pct: float, jpeg_bytes: bytes | None = None):
    """Envía email de alerta con la foto adjunta (síncrono, correr en background)."""
    recipient = state.alert_email
    if not SMTP_EMAIL or not SMTP_PASSWORD or not recipient:
        logger.warning("⚠ Email no configurado, alerta omitida")
        return

    try:
        msg = MIMEMultipart()
        msg["From"] = SMTP_EMAIL
        msg["To"] = recipient
        msg["Subject"] = f"🚨 ALERTA: Movimiento detectado ({diff_pct:.1f}%)"

        body = (
            f"Se detectó movimiento en el sistema de vigilancia.\n\n"
            f"📊 Diferencia: {diff_pct:.1f}% de píxeles cambiaron\n"
            f"🕐 Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
            f"Revisa la app para más detalles."
        )
        msg.attach(MIMEText(body, "plain"))

        # Adjuntar imagen si está disponible
        if jpeg_bytes:
            img_attachment = MIMEImage(jpeg_bytes, name="captura.jpg")
            msg.attach(img_attachment)

        # Manejo de conexión SMTP con timeout
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=10) as server:
            server.ehlo()
            if SMTP_PORT == 587:
                server.starttls()
                server.ehlo()
            server.login(SMTP_EMAIL, SMTP_PASSWORD)
            server.send_message(msg)

        logger.info("📧 Email de alerta enviado a %s", recipient)

    except Exception as e:
        logger.error("⚠ Error enviando email a %s. Verifica tu SMTP_PASSWORD (App Password sin espacios) en .env: %s", recipient, e)


# ============================================================
# 9. ENDPOINTS
# ============================================================

@app.post("/analyze", response_model=AnalysisResponse)
async def analyze_image(payload: ImagePayload, background_tasks: BackgroundTasks):
    """
    Endpoint principal. La app envía una imagen base64.
    El backend analiza movimiento y dispara acciones si es necesario.
    """
    # Decodificar imagen base64 → numpy array
    try:
        img_bytes = base64.b64decode(payload.image)
        img_array = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

        if frame is None:
            raise ValueError("No se pudo decodificar la imagen")

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Imagen inválida: {e}")

    # Redimensionar a 320 de ancho si es más grande, conservando la proporción
    # (fotos verticales del celular no se deforman)
    h, w = frame.shape[:2]
    if w > 320:
        frame = cv2.resize(frame, (320, round(h * 320 / w)), interpolation=cv2.INTER_AREA)

    # Detectar movimiento
    state.total_analyses += 1
    detected, diff_pct, changed, total = detect_motion(frame)
    state.last_detection_pct = diff_pct

    # Evaluar si debemos disparar alarma
    within_schedule = is_within_schedule()
    cooldown = is_cooldown_active()
    alarm_triggered = False
    message = "Sin movimiento"

    if detected and state.detection_active:
        if not within_schedule:
            message = "Movimiento detectado pero FUERA de franja horaria"
            logger.info("⏰ %s (%.1f%%)", message, diff_pct)

        elif cooldown:
            remaining = COOLDOWN_SECONDS - (datetime.now() - state.last_alert_time).seconds
            message = f"Movimiento detectado pero en cooldown ({remaining}s restantes)"
            logger.info("⏳ %s", message)

        else:
            # ¡ALARMA REAL!
            state.total_detections += 1
            state.last_alert_time = datetime.now()
            alarm_triggered = True
            message = f"🚨 INTRUSO DETECTADO ({diff_pct:.1f}% cambio)"

            logger.warning("🚨 MOVIMIENTO #%d | %.1f%% | Disparando acciones...",
                           state.total_detections, diff_pct)

            # Acción 1: Log en Supabase (en background, no bloquea la respuesta)
            background_tasks.add_task(log_to_supabase, diff_pct, changed)

            # Acción 2: Email con foto (en background, no bloquea la respuesta)
            background_tasks.add_task(send_alert_email, diff_pct, img_bytes)

    return AnalysisResponse(
        motion_detected=detected,
        diff_percentage=diff_pct,
        changed_pixels=changed,
        total_pixels=total,
        alarm_triggered=alarm_triggered,
        within_schedule=within_schedule,
        cooldown_active=cooldown,
        message=message,
    )


@app.get("/status")
async def get_status():
    """Estado completo del backend."""
    return {
        "backend": "online",
        "detection_active": state.detection_active,
        "total_analyses": state.total_analyses,
        "total_detections": state.total_detections,
        "last_diff_pct": state.last_detection_pct,
        "last_alert": state.last_alert_time.isoformat() if state.last_alert_time else None,
        "cooldown_seconds": COOLDOWN_SECONDS,
        "cooldown_active": is_cooldown_active(),
        "schedule": {
            "start": state.schedule_start.strftime("%H:%M"),
            "end": state.schedule_end.strftime("%H:%M"),
            "currently_active": is_within_schedule(),
        },
        "esp32_ip": state.esp32_ip,
        "has_reference_frame": state.background is not None,
        "alert_email": state.alert_email,
        "email_configured": bool(SMTP_EMAIL and SMTP_PASSWORD and state.alert_email),
    }


@app.get("/alert-email")
async def get_alert_email():
    """Devuelve el correo al que se envían las alertas."""
    return {"email": state.alert_email}


@app.post("/alert-email")
async def set_alert_email(payload: AlertEmailPayload):
    """Guarda el correo destino de las alertas (desde la app)."""
    email = payload.email.strip()
    if not EMAIL_REGEX.match(email):
        raise HTTPException(status_code=400, detail="Correo inválido")
    state.alert_email = email
    settings = _load_settings()
    settings["alert_email"] = email
    _save_settings(settings)
    logger.info("📧 Correo de alertas actualizado: %s", email)
    return {"email": email}


@app.post("/alert-email/test")
async def test_alert_email(background_tasks: BackgroundTasks):
    """Envía un correo de prueba al correo configurado."""
    if not SMTP_EMAIL or not SMTP_PASSWORD:
        raise HTTPException(status_code=400, detail="SMTP no configurado en el .env del backend")
    if not state.alert_email:
        raise HTTPException(status_code=400, detail="No hay correo de alertas configurado")
    background_tasks.add_task(send_alert_email, 0.0, None)
    return {"sent_to": state.alert_email}


@app.post("/schedule")
async def set_schedule(payload: SchedulePayload):
    """Configura la franja horaria de vigilancia."""
    state.schedule_start = _parse_time(payload.start)
    state.schedule_end = _parse_time(payload.end)
    logger.info("🕐 Horario actualizado: %s - %s", payload.start, payload.end)
    return {
        "schedule": {"start": payload.start, "end": payload.end},
        "currently_active": is_within_schedule(),
    }


@app.post("/detection/on")
async def detection_on():
    """Activa la detección de movimiento."""
    state.detection_active = True
    logger.info("🟢 Detección ACTIVADA")
    return {"detection": "on"}


@app.post("/detection/off")
async def detection_off():
    """Desactiva la detección de movimiento."""
    state.detection_active = False
    logger.info("🔴 Detección DESACTIVADA")
    return {"detection": "off"}


@app.post("/alarm/trigger")
async def manual_alarm():
    """Dispara la alarma del ESP32 manualmente (para testing)."""
    success = await trigger_esp32_alarm()
    return {"alarm": "triggered", "esp32_reached": success}


@app.post("/alarm/silence")
async def manual_silence():
    """Silencia la alarma del ESP32."""
    try:
        resp = await http_client.get(f"http://{state.esp32_ip}/alarm/off", timeout=5.0)
        return {"alarm": "silenced", "esp32_status": resp.status_code}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ESP32 no alcanzable: {e}")


@app.post("/reset-reference")
async def reset_reference():
    """Resetea el frame de referencia (útil si cambia la escena)."""
    state.background = None
    state.previous_frame = None
    state.static_detections = 0
    logger.info("🔄 Frame de referencia reseteado")
    return {"reference": "reset", "message": "La próxima imagen será el nuevo frame de referencia"}


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    """Panel HTML mínimo para verificar que el backend funciona."""
    schedule_status = "🟢 ACTIVO" if is_within_schedule() else "🔴 FUERA DE HORARIO"
    detection_status = "🟢 ON" if state.detection_active else "🔴 OFF"

    return f"""
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>Backend - Detección de Intrusos</title>
    <style>
        body{{background:#111;color:#eee;font-family:system-ui;padding:24px;max-width:600px;margin:0 auto}}
        h1{{color:#4fc3f7}} .card{{background:#1a1a1a;padding:16px;border-radius:10px;margin:12px 0}}
        code{{color:#81c784}} .stat{{display:flex;justify-content:space-between;padding:4px 0}}
    </style></head>
    <body>
        <h1>🛡️ Backend de Detección de Intrusos</h1>
        <div class="card">
            <div class="stat"><span>Detección:</span><span>{detection_status}</span></div>
            <div class="stat"><span>Horario:</span><span>{schedule_status}</span></div>
            <div class="stat"><span>Imágenes analizadas:</span><span>{state.total_analyses}</span></div>
            <div class="stat"><span>Intrusiones detectadas:</span><span>{state.total_detections}</span></div>
            <div class="stat"><span>Último cambio:</span><span>{state.last_detection_pct:.1f}%</span></div>
            <div class="stat"><span>ESP32 IP:</span><span>{state.esp32_ip}</span></div>
        </div>
        <div class="card">
            <p><strong>Endpoints:</strong></p>
            <p><code>POST /analyze</code> — Enviar imagen base64 para análisis</p>
            <p><code>GET  /status</code> — Estado JSON del backend</p>
            <p><code>POST /alarm/trigger</code> — Disparar alarma manualmente</p>
            <p><code>POST /alarm/silence</code> — Silenciar alarma</p>
            <p><code>POST /schedule</code> — Configurar franja horaria</p>
            <p><code>GET  /docs</code> — Documentación interactiva (Swagger)</p>
        </div>
    </body></html>
    """


# ============================================================
# 10. MAIN
# ============================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
