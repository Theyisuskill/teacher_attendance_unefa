/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

export class ConfigManager extends Component {
    static template = "teacher_attendance.ConfigManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");

        this.state = useState({
            isLoading: true,
            config: {
                qr: true,
                carnet: true,
                kiosk: true,
                device_validation: false,
            },
        });

        onWillStart(async () => {
            await this.loadConfig();
        });
    }

    get methodOptions() {
        return [
            {
                key: "qr",
                icon: "fa-qrcode",
                label: "QR de Aula",
                description: "El docente escanea el código QR del aula con su dispositivo y firma digitalmente.",
            },
            {
                key: "carnet",
                icon: "fa-id-card",
                label: "Carnet (Cédula)",
                description: "Una cámara fija escanea el QR del carnet del docente y registra entrada/salida automáticamente.",
            },
            {
                key: "kiosk",
                icon: "fa-desktop",
                label: "Kiosko PIN",
                description: "El docente marca asistencia en una pantalla fija ingresando su PIN de 4 dígitos.",
            },
            {
                key: "device_validation",
                icon: "fa-mobile",
                label: "Validación de Dispositivo",
                description: "Cada docente solo puede registrar asistencia desde su dispositivo vinculado. Evita que un docente firme por otro. El primer registro vincula el dispositivo automáticamente.",
            },
        ];
    }

    async loadConfig() {
        this.state.isLoading = true;
        try {
            const config = await this.orm.call("attendance.log", "get_method_config", []);
            this.state.config = config;
        } catch (error) {
            this.notification.add("Error al cargar la configuración", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    async toggleMethod(key) {
        const newValue = !this.state.config[key];
        // No permitir deshabilitar todos los métodos de registro
        if (!newValue && key !== "device_validation") {
            const methodKeys = ["qr", "carnet", "kiosk"];
            const enabledCount = methodKeys.filter((k) => this.state.config[k]).length;
            if (enabledCount <= 1) {
                this.notification.add("Debe haber al menos un método de registro habilitado", { type: "warning" });
                return;
            }
        }
        try {
            await this.orm.call("attendance.log", "set_method_config", [key, newValue]);
            this.state.config[key] = newValue;
            this.notification.add(
                newValue ? "Método habilitado" : "Método deshabilitado",
                { type: "success" }
            );
            // Notificar al navbar para que actualice los ítems del menú dinámicamente
            window.dispatchEvent(new CustomEvent("attendance_config_changed"));
        } catch (error) {
            this.notification.add(error.data?.message || "Error al guardar la configuración", { type: "danger" });
        }
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_attendance_config", ConfigManager);
