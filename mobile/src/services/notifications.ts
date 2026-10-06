// ============================================================
// NOTIFICACIONES — "Sistema armado" persistente + aviso de alarma
// ============================================================
// Requiere un development build (expo-dev-client); en Expo Go las
// notificaciones persistentes no funcionan, por eso todo va en try/catch.

import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

const CH_ARMED = "armed";
const CH_ALARM = "alarm";
const ARMED_ID = "system-armed";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let ready = false;

export async function initNotifications(): Promise<boolean> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CH_ARMED, {
        name: "Sistema armado",
        importance: Notifications.AndroidImportance.LOW, // silenciosa, fija
      });
      await Notifications.setNotificationChannelAsync(CH_ALARM, {
        name: "Alarmas de intrusión",
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500, 250, 500],
        lightColor: "#EF4444",
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    ready = status === "granted";
    return ready;
  } catch (e) {
    console.warn("Notificaciones no disponibles:", e);
    return false;
  }
}

/** Notificación fija (no se puede descartar) mientras el sistema está armado. */
export async function showArmedNotification() {
  if (!ready) return;
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: ARMED_ID,
      content: {
        title: "🛡️ Sistema armado",
        body: "Vigilancia activa. Toca para volver a la app.",
        sticky: true,
        autoDismiss: false,
        priority: Notifications.AndroidNotificationPriority.LOW,
        ...(Platform.OS === "android" ? { channelId: CH_ARMED } : {}),
      } as Notifications.NotificationContentInput,
      trigger: null,
    });
  } catch (e) {
    console.warn("No se pudo mostrar notificación armado:", e);
  }
}

export async function clearArmedNotification() {
  try {
    await Notifications.dismissNotificationAsync(ARMED_ID);
    await Notifications.cancelScheduledNotificationAsync(ARMED_ID);
  } catch {}
}

/** Aviso de alarma con hora y porcentaje. */
export async function notifyAlarm(diffPct: number) {
  if (!ready) return;
  try {
    const hora = new Date().toLocaleTimeString();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "🚨 ¡ALARMA! Intruso detectado",
        body: `Movimiento ${diffPct.toFixed(1)}% a las ${hora}`,
        sound: true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        ...(Platform.OS === "android" ? { channelId: CH_ALARM } : {}),
      } as Notifications.NotificationContentInput,
      trigger: null,
    });
  } catch (e) {
    console.warn("No se pudo mostrar notificación de alarma:", e);
  }
}
