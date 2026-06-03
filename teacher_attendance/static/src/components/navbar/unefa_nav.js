/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";

/**
 * Panel lateral de navegación UNEFA — global.
 * Se registra en main_components, por lo que está presente en todas
 * las pantallas del backend. Sustituye a la barra de menú superior de Odoo
 * (oculta por CSS) como única vía de navegación de la app.
 */
export class UnefaNav extends Component {
    static template = "teacher_attendance.UnefaNav";
    static props = {};

    setup() {
        this.action = useService("action");
        this.state = useState({
            open: false,
            isCoordinator: false,
            userName: user.name,
        });

        onWillStart(async () => {
            this.state.isCoordinator = await user.hasGroup("teacher_attendance.group_coordinator");
        });
    }

    get navSections() {
        const sections = [
            {
                label: "Asistencia",
                items: [
                    { action: "action_attendance_dashboard", label: "Escanear QR", icon: "fa-qrcode" },
                    { action: "action_attendance_log_my", label: "Mis Registros", icon: "fa-history" },
                    { action: "action_attendance_kiosk", label: "Modo Kiosko", icon: "fa-desktop" },
                ],
            },
        ];
        if (this.state.isCoordinator) {
            sections.push({
                label: "Gestión",
                items: [
                    { action: "action_attendance_log", label: "Registros", icon: "fa-list-alt" },
                    { action: "action_attendance_classroom", label: "Aulas", icon: "fa-building" },
                    { action: "action_attendance_subject", label: "Materias", icon: "fa-book" },
                    { action: "action_attendance_substitution", label: "Suplencias", icon: "fa-exchange" },
                    { action: "action_attendance_analysis", label: "Análisis", icon: "fa-bar-chart" },
                    { action: "action_occupancy_map", label: "Mapa de Ocupación", icon: "fa-map-marker" },
                ],
            });
        }
        return sections;
    }

    toggle() {
        this.state.open = !this.state.open;
    }

    close() {
        this.state.open = false;
    }

    navigateTo(action) {
        this.state.open = false;
        this.action.doAction("teacher_attendance." + action);
    }

    logout() {
        window.location = "/web/session/logout";
    }
}

registry.category("main_components").add("UnefaNav", { Component: UnefaNav });
