// ============================================================
// SPRINT 2: ESP32-S3 — Actuador IoT (Buzzer + LED + HTTP)
// ============================================================
//
// Rol: recibe comandos HTTP del backend FastAPI para activar/
//      desactivar la alarma física (buzzer + LED rojo).
//      Envía heartbeat periódico a Supabase con su estado.
//
// Endpoints:
//   GET  /              → Página HTML de control (para testing)
//   GET  /alarm/on      → Activar alarma (buzzer pulsante + LED)
//   GET  /alarm/off     → Desactivar alarma
//   GET  /status        → JSON con estado del dispositivo
//
// Conexiones físicas:
//   GPIO 4 → Buzzer pasivo → GND
//   GPIO 2 → Resistencia 220Ω → LED rojo → GND
//
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#include "esp_http_server.h"
#include "config.h"
#include "time.h"

// ============================================================
// 1. ESTADO GLOBAL
// ============================================================

static httpd_handle_t server = NULL;

// Estado de la alarma
static volatile bool alarm_active  = false;
static unsigned long alarm_start   = 0;       // Cuándo se activó
static unsigned long alarm_last_toggle = 0;   // Último cambio on/off del pulso
static bool buzzer_is_on = false;             // Estado actual del pulso

// Heartbeat
static unsigned long last_heartbeat = 0;

// Wi-Fi AP Mode
static bool is_ap_mode = false;
static unsigned long last_wifi_retry = 0;
#define WIFI_RETRY_INTERVAL 60000 // Intentar STA cada 60s si está en AP

// Estadísticas
static uint32_t alarm_trigger_count = 0;


// ============================================================
// 2. CONTROL DE ALARMA (NO BLOQUEANTE)
// ============================================================
// La alarma pulsa: ON 400ms → OFF 200ms → ON 400ms → ...
// Se auto-apaga después de ALARM_TIMEOUT_MS (30s) por seguridad.
// NUNCA usa delay(), así el servidor HTTP sigue respondiendo.

void alarmOn() {
    if (!alarm_active) {
        alarm_active = true;
        alarm_start = millis();
        alarm_trigger_count++;
        buzzer_is_on = true;
        alarm_last_toggle = millis();

        // Encender buzzer y LED
        ledcWriteTone(BUZZER_PIN, BUZZER_FREQ_HZ);
        digitalWrite(LED_ALARM_PIN, HIGH);

        DBG("🚨 ALARMA ACTIVADA (#%u)", alarm_trigger_count);
    }
}

void alarmOff() {
    if (alarm_active || buzzer_is_on) {
        alarm_active = false;
        buzzer_is_on = false;

        // Apagar todo
        ledcWriteTone(BUZZER_PIN, 0);
        digitalWrite(LED_ALARM_PIN, LOW);

        unsigned long duration = millis() - alarm_start;
        DBG("🔇 ALARMA DESACTIVADA (duró %lu ms)", duration);
    }
}

// Llamar en cada iteración del loop() para manejar el pulso
void alarmUpdate() {
    if (!alarm_active) return;

    unsigned long now = millis();

    // ---- Auto-apagado por timeout ----
    if (now - alarm_start >= ALARM_TIMEOUT_MS) {
        DBG("⏰ Alarma auto-apagada por timeout (%d s)", ALARM_TIMEOUT_MS / 1000);
        alarmOff();
        return;
    }

    // ---- Patrón pulsante ----
    if (buzzer_is_on) {
        // El buzzer está sonando → ¿ya pasó el tiempo ON?
        if (now - alarm_last_toggle >= ALARM_PULSE_ON_MS) {
            ledcWriteTone(BUZZER_PIN, 0);        // Silenciar
            digitalWrite(LED_ALARM_PIN, LOW);
            buzzer_is_on = false;
            alarm_last_toggle = now;
        }
    } else {
        // El buzzer está en silencio → ¿ya pasó el tiempo OFF?
        if (now - alarm_last_toggle >= ALARM_PULSE_OFF_MS) {
            ledcWriteTone(BUZZER_PIN, BUZZER_FREQ_HZ);  // Sonar
            digitalWrite(LED_ALARM_PIN, HIGH);
            buzzer_is_on = true;
            alarm_last_toggle = now;
        }
    }
}


// ============================================================
// 3. HANDLER: ACTIVAR ALARMA
// ============================================================

static esp_err_t alarm_on_handler(httpd_req_t *req) {
    alarmOn();

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    char resp[128];
    snprintf(resp, sizeof(resp),
        "{\"alarm\":\"on\",\"timeout_sec\":%d,\"trigger_count\":%u}",
        ALARM_TIMEOUT_MS / 1000, alarm_trigger_count);
    return httpd_resp_sendstr(req, resp);
}


// ============================================================
// 4. HANDLER: DESACTIVAR ALARMA
// ============================================================

static esp_err_t alarm_off_handler(httpd_req_t *req) {
    alarmOff();

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_sendstr(req, "{\"alarm\":\"off\"}");
}


// ============================================================
// 5. HANDLER: STATUS (JSON)
// ============================================================

static esp_err_t status_handler(httpd_req_t *req) {
    // Obtener timestamp ISO8601
    struct tm timeinfo;
    char time_str[30] = "N/A";
    if (getLocalTime(&timeinfo, 100)) {
        strftime(time_str, sizeof(time_str), "%Y-%m-%dT%H:%M:%S", &timeinfo);
    }

    char json[512];
    int len = snprintf(json, sizeof(json),
        "{"
            "\"device\":\"ESP32-S3\","
            "\"role\":\"actuator\","
            "\"alarm_active\":%s,"
            "\"alarm_triggers\":%u,"
            "\"wifi_rssi\":%d,"
            "\"ip\":\"%s\","
            "\"free_heap\":%u,"
            "\"uptime_sec\":%lu,"
            "\"local_time\":\"%s\","
            "\"network_mode\":\"%s\""
        "}",
        alarm_active ? "true" : "false",
        alarm_trigger_count,
        is_ap_mode ? 0 : WiFi.RSSI(),
        is_ap_mode ? WiFi.softAPIP().toString().c_str() : WiFi.localIP().toString().c_str(),
        (unsigned int)ESP.getFreeHeap(),
        millis() / 1000,
        time_str,
        is_ap_mode ? "AP" : "STA"
    );

    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, json, len);
}


// ============================================================
// 6. HANDLER: PÁGINA HTML DE CONTROL (para testing/demo)
// ============================================================

static const char INDEX_HTML[] PROGMEM = R"rawhtml(
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>ESP32 - Alarma IoT</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{background:#111;color:#eee;font-family:system-ui;padding:20px;max-width:480px;margin:0 auto}
        h1{font-size:1.4em;margin-bottom:16px;color:#4fc3f7;text-align:center}
        .card{background:#1a1a1a;border-radius:12px;padding:16px;margin-bottom:12px}
        .btn-row{display:flex;gap:10px;margin:16px 0}
        button{flex:1;padding:14px;border:none;border-radius:10px;font-size:1.1em;
               cursor:pointer;font-weight:700;transition:all 0.2s}
        button:active{transform:scale(0.97)}
        .on{background:#e53935;color:#fff;box-shadow:0 4px 15px rgba(229,57,53,0.4)}
        .off{background:#43a047;color:#fff;box-shadow:0 4px 15px rgba(67,160,71,0.3)}
        #indicator{width:20px;height:20px;border-radius:50%;display:inline-block;margin-right:8px;
                   transition:background 0.3s}
        .active{background:#e53935;box-shadow:0 0 12px #e53935}
        .inactive{background:#43a047;box-shadow:0 0 8px #43a047}
        #status{font-family:monospace;font-size:0.85em;white-space:pre-wrap;color:#aaa}
    </style>
</head>
<body>
    <h1>🛡️ Alarma IoT - ESP32</h1>
    <div class="card">
        <span id="indicator" class="inactive"></span>
        <strong id="alarm-label">Alarma inactiva</strong>
    </div>
    <div class="btn-row">
        <button class="on" onclick="cmd('on')">🚨 ACTIVAR</button>
        <button class="off" onclick="cmd('off')">🔇 SILENCIAR</button>
    </div>
    <div class="card" id="status">Cargando...</div>
    <script>
        function cmd(action){
            fetch('/alarm/'+action).then(r=>r.json()).then(upd).catch(e=>console.error(e));
        }
        function upd(){
            fetch('/status').then(r=>r.json()).then(d=>{
                const on = d.alarm_active;
                document.getElementById('indicator').className = on ? 'active' : 'inactive';
                document.getElementById('alarm-label').textContent = on ? '🚨 ALARMA ACTIVA' : '✅ Alarma inactiva';
                document.getElementById('status').textContent =
                    `IP: ${d.ip}  |  RSSI: ${d.wifi_rssi} dBm\n`+
                    `Activaciones: ${d.alarm_triggers}  |  Heap: ${d.free_heap}\n`+
                    `Uptime: ${d.uptime_sec}s  |  Hora: ${d.local_time}`;
            }).catch(()=>{
                document.getElementById('status').textContent='⚠ Sin conexión';
            });
        }
        upd(); setInterval(upd, 2000);
    </script>
</body>
</html>
)rawhtml";

static esp_err_t index_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, INDEX_HTML, strlen(INDEX_HTML));
}


// ============================================================
// 7. HANDLER: CORS PREFLIGHT (para peticiones del backend)
// ============================================================
// El backend FastAPI envía un OPTIONS antes del GET/POST real.
// Sin esto, el navegador bloquea la petición por CORS.

static esp_err_t cors_handler(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, NULL, 0);
}


// ============================================================
// 8. INICIALIZACIÓN DEL SERVIDOR HTTP
// ============================================================

bool startServer() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = HTTP_PORT;
    config.max_uri_handlers = 10;

    if (httpd_start(&server, &config) != ESP_OK) {
        DBG("❌ Error iniciando servidor HTTP");
        return false;
    }

    // Rutas
    httpd_uri_t uri_index     = { .uri="/",          .method=HTTP_GET,     .handler=index_handler };
    httpd_uri_t uri_alarm_on  = { .uri="/alarm/on",  .method=HTTP_GET,     .handler=alarm_on_handler };
    httpd_uri_t uri_alarm_off = { .uri="/alarm/off", .method=HTTP_GET,     .handler=alarm_off_handler };
    httpd_uri_t uri_status    = { .uri="/status",    .method=HTTP_GET,     .handler=status_handler };
    // CORS preflight para cada ruta de alarma
    httpd_uri_t uri_cors_on   = { .uri="/alarm/on",  .method=HTTP_OPTIONS, .handler=cors_handler };
    httpd_uri_t uri_cors_off  = { .uri="/alarm/off", .method=HTTP_OPTIONS, .handler=cors_handler };

    httpd_register_uri_handler(server, &uri_index);
    httpd_register_uri_handler(server, &uri_alarm_on);
    httpd_register_uri_handler(server, &uri_alarm_off);
    httpd_register_uri_handler(server, &uri_status);
    httpd_register_uri_handler(server, &uri_cors_on);
    httpd_register_uri_handler(server, &uri_cors_off);

    DBG("✅ Servidor HTTP en puerto %d", HTTP_PORT);
    return true;
}


// ============================================================
// 9. HEARTBEAT A SUPABASE (HTTPS)
// ============================================================
// Envía el estado del ESP32 a la tabla device_status de Supabase
// cada HEARTBEAT_INTERVAL_MS usando la REST API con UPSERT.
// Esto permite al backend FastAPI conocer la IP del ESP32
// para enviarle comandos de alarma.

void sendHeartbeat() {
    if (is_ap_mode || WiFi.status() != WL_CONNECTED) {
        return; // No hay internet para Supabase en modo AP
    }

    // Obtener timestamp ISO8601
    struct tm timeinfo;
    char timestamp[30] = "";
    if (getLocalTime(&timeinfo, 100)) {
        strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
    }

    // Construir payload JSON
    char payload[512];
    snprintf(payload, sizeof(payload),
        "{"
            "\"device_id\":\"%s\","
            "\"is_online\":true,"
            "\"is_streaming\":false,"
            "\"is_detecting\":%s,"
            "\"local_ip\":\"%s\","
            "\"wifi_rssi\":%d,"
            "\"free_heap\":%u,"
            "\"uptime_secs\":%lu,"
            "\"last_heartbeat\":\"%s\""
        "}",
        DEVICE_ID,
        alarm_active ? "true" : "false",  // Reutilizamos is_detecting como "alarm_active"
        WiFi.localIP().toString().c_str(),
        WiFi.RSSI(),
        (unsigned int)ESP.getFreeHeap(),
        millis() / 1000,
        timestamp
    );

    // Construir URL del endpoint REST
    String url = String(SUPABASE_URL) + "/rest/v1/device_status";

    // HTTPS request
    WiFiClientSecure client;
    client.setInsecure();   // Saltar verificación de certificado (OK para examen)

    HTTPClient http;
    http.begin(client, url);
    http.addHeader("apikey", SUPABASE_SERVICE_KEY);
    http.addHeader("Authorization", String("Bearer ") + SUPABASE_SERVICE_KEY);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("Prefer", "resolution=merge-duplicates");  // UPSERT

    int code = http.POST(payload);

    if (code >= 200 && code < 300) {
        DBG("💓 Heartbeat enviado (HTTP %d) | IP: %s | RSSI: %d",
            code, WiFi.localIP().toString().c_str(), WiFi.RSSI());
    } else {
        DBG("⚠ Heartbeat falló (HTTP %d): %s", code, http.getString().c_str());
    }

    http.end();
}


// ============================================================
// 10. Wi-Fi + NTP
// ============================================================

bool connectWiFi() {
    DBG("📡 Conectando a Wi-Fi: %s", WIFI_SSID);
    WiFi.disconnect(true);
    delay(500);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED) {
        if (millis() - start > WIFI_TIMEOUT_MS) {
            DBG("❌ Wi-Fi timeout");
            return false;
        }
        delay(500);
        Serial.print(".");
    }

    DBG("✅ Wi-Fi: %s | IP: %s | RSSI: %d dBm",
        WIFI_SSID, WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return true;
}

void startAP() {
    DBG("\n📡 Iniciando modo Access Point (AP)...");
    WiFi.disconnect(true);
    delay(500);
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    delay(500);
    DBG("✅ AP Iniciado | SSID: %s | IP: %s", AP_SSID, WiFi.softAPIP().toString().c_str());
}

void syncTime() {
    configTime(GMT_OFFSET_SEC, DST_OFFSET_SEC, NTP_SERVER);
    DBG("🕐 Sincronizando reloj con NTP...");

    struct tm timeinfo;
    if (getLocalTime(&timeinfo, 5000)) {
        char buf[30];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &timeinfo);
        DBG("✅ Hora sincronizada: %s", buf);
    } else {
        DBG("⚠ NTP no respondió (continuando sin hora exacta)");
    }
}


// ============================================================
// 11. SETUP
// ============================================================

void setup() {
    Serial.begin(SERIAL_BAUD);
    delay(1000);

    DBG("========================================");
    DBG("  SISTEMA DE DETECCIÓN DE INTRUSOS");
    DBG("  ESP32-S3 — Actuador de Alarma");
    DBG("  Sprint 2 (Arquitectura revisada)");
    DBG("========================================");

    // ---- Hardware ----
    pinMode(LED_ALARM_PIN, OUTPUT);
    digitalWrite(LED_ALARM_PIN, LOW);

    // Buzzer con LEDC (PWM para generar tono)
    ledcAttach(BUZZER_PIN, BUZZER_FREQ_HZ, BUZZER_RESOLUTION);
    ledcWriteTone(BUZZER_PIN, 0);   // Asegurar silencio al inicio
    DBG("✅ Hardware: Buzzer (GPIO %d) + LED (GPIO %d)", BUZZER_PIN, LED_ALARM_PIN);

    // ---- Wi-Fi ----
    if (!connectWiFi()) {
        DBG("\n⚠ Wi-Fi STA falló. Iniciando AP de respaldo...");
        startAP();
        is_ap_mode = true;
        last_wifi_retry = millis();
    }

    // ---- NTP ----
    syncTime();

    // ---- mDNS: accesible como http://alarm.local ----
    if (MDNS.begin("alarm")) {
        DBG("✅ mDNS: http://alarm.local");
        MDNS.addService("http", "tcp", HTTP_PORT);
    }

    // ---- Servidor HTTP ----
    if (!startServer()) {
        DBG("❌ Servidor falló. Reiniciando...");
        delay(3000);
        ESP.restart();
    }

    // ---- Primer heartbeat ----
    sendHeartbeat();

    // ---- Test rápido de hardware (beep + flash de 200ms) ----
    DBG("🔔 Test de hardware...");
    ledcWriteTone(BUZZER_PIN, BUZZER_FREQ_HZ);
    digitalWrite(LED_ALARM_PIN, HIGH);
    delay(200);
    ledcWriteTone(BUZZER_PIN, 0);
    digitalWrite(LED_ALARM_PIN, LOW);
    DBG("✅ Hardware verificado");

    DBG("========================================");
    DBG("🟢 SISTEMA OPERATIVO");
    String currentIP = is_ap_mode ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
    DBG("   Modo:   %s", is_ap_mode ? "AP (Respaldo)" : "STA (Conectado)");
    DBG("   Panel:  http://%s/", currentIP.c_str());
    DBG("   mDNS:   http://alarm.local/");
    DBG("   Status: http://%s/status", currentIP.c_str());
    DBG("   Alarma: /alarm/on  |  /alarm/off");
    DBG("   Heap:   %u bytes libres", (unsigned int)ESP.getFreeHeap());
    DBG("========================================");
}


// ============================================================
// 12. LOOP PRINCIPAL
// ============================================================
// Tres responsabilidades:
//   1. Actualizar el patrón pulsante de la alarma
//   2. Enviar heartbeat periódico a Supabase
//   3. Reconectar Wi-Fi si se cae

void loop() {
    // ---- 1. Actualizar alarma (patrón pulsante no bloqueante) ----
    alarmUpdate();

    unsigned long now = millis();

    // ---- 2. Reconexión Wi-Fi ----
    if (is_ap_mode) {
        if (now - last_wifi_retry >= WIFI_RETRY_INTERVAL) {
            last_wifi_retry = now;
            DBG("🔄 Intentando reconectar a Wi-Fi STA...");
            if (connectWiFi()) {
                is_ap_mode = false;
            } else {
                startAP(); // Volver a AP si falla
                is_ap_mode = true;
            }
        }
    } else {
        if (WiFi.status() != WL_CONNECTED) {
            DBG("⚠ Wi-Fi desconectado. Reconectando...");
            alarmOff();   // Apagar alarma si no hay red
            if (connectWiFi()) {
                is_ap_mode = false;
            } else {
                startAP();
                is_ap_mode = true;
                last_wifi_retry = millis();
            }
            return;
        }
    }

    // ---- 3. Heartbeat periódico ----
    if (!is_ap_mode && now - last_heartbeat >= HEARTBEAT_INTERVAL_MS) {
        last_heartbeat = now;
        sendHeartbeat();
    }

    // Yield mínimo (el servidor HTTP corre en su propio task)
    delay(10);
}
