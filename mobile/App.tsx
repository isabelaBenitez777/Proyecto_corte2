// ============================================================
// SPRINT 4: App Móvil — Detección de Intrusos IoT
// ============================================================
// React Native / Expo con 3 tabs:
//   1. Cámara   → Captura y envía imágenes al backend
//   2. Dashboard → Estado del sistema en tiempo real
//   3. Control  → Configuración de alarma, horario, detección
// ============================================================

import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { View, StyleSheet } from "react-native";

import CameraScreen from "./src/screens/CameraScreen";
import DashboardScreen from "./src/screens/DashboardScreen";
import ControlScreen from "./src/screens/ControlScreen";
import { COLORS } from "./src/theme";

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: COLORS.bgCard,
            borderTopColor: COLORS.border,
            borderTopWidth: 1,
            height: 65,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarActiveTintColor: COLORS.primary,
          tabBarInactiveTintColor: COLORS.textMuted,
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: "600",
          },
        }}
      >
        <Tab.Screen
          name="Camera"
          component={CameraScreen}
          options={{
            tabBarLabel: "Cámara",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="camera" size={size} color={color} />
            ),
          }}
        />
        <Tab.Screen
          name="Dashboard"
          component={DashboardScreen}
          options={{
            tabBarLabel: "Dashboard",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="grid" size={size} color={color} />
            ),
          }}
        />
        <Tab.Screen
          name="Control"
          component={ControlScreen}
          options={{
            tabBarLabel: "Control",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings" size={size} color={color} />
            ),
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
