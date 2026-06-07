/** @odoo-module **/

import { Component, useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";

// Evento global disparado por ConfigManager cuando cambia un método
const CONFIG_CHANGED_EVENT = "attendance_config_changed";

export class UnefaNav extends Component {
    static template = "teacher_attendance.UnefaNav";
    static props = {};

    setup() {
        this.action = useService("action");
        this.orm = useService("orm");
        this.state = useState({
            open: false,
            expandedSections: { attendance: true, management: true, admin: true },
            hasAttendanceAccess: false,  // cualquier rol de asistencia
            isCoordinator: false,         // coordinador puro (no admin)
            isAdmin: false,               // admin del módulo o admin de Odoo
            userName: user.name,
            userInitial: user.name ? user.name.charAt(0).toUpperCase() : "U",
            methodConfig: { qr: true, carnet: true, kiosk: true },
        });

        onWillStart(async () => {
            // Orden de verificación: de mayor a menor privilegio
            // (group_admin implica group_coordinator implica group_teacher)
            const isAttendanceAdmin = await user.hasGroup("teacher_attendance.group_admin");
            const isOdooAdmin       = await user.hasGroup("base.group_system");
            this.state.isAdmin = isAttendanceAdmin || isOdooAdmin;

            // isCoordinator solo si NO es admin (evita doble sección)
            this.state.isCoordinator = !this.state.isAdmin
                && await user.hasGroup("teacher_attendance.group_coordinator");

            // Acceso al módulo: tiene algún rol de asistencia
            this.state.hasAttendanceAccess = this.state.isAdmin
                || this.state.isCoordinator
                || await user.hasGroup("teacher_attendance.group_teacher");

            if (this.state.hasAttendanceAccess) {
                await this._loadMethodConfig();
            }
        });

        // Escuchar cambios de config disparados por ConfigManager
        this._onConfigChanged = () => this._loadMethodConfig();
        window.addEventListener(CONFIG_CHANGED_EVENT, this._onConfigChanged);

        onWillUnmount(() => {
            window.removeEventListener(CONFIG_CHANGED_EVENT, this._onConfigChanged);
        });
    }

    async _loadMethodConfig() {
        try {
            const cfg = await this.orm.call("attendance.log", "get_method_config", []);
            this.state.methodConfig = { qr: cfg.qr, carnet: cfg.carnet, kiosk: cfg.kiosk };
        } catch (_) {
            // Si falla, mantiene los defaults (todo activo)
        }
    }

    get navSections() {
        const { qr, kiosk } = this.state.methodConfig;

        const attendanceItems = [
            qr    && { action: "attendance_scanner_action", label: "Escanear QR",      icon: "fa-qrcode"     },
                     { action: "action_attendance_log_my",  label: "Mis Registros",     icon: "fa-history",   isOwl: true },
            kiosk && { action: "attendance_kiosk_action",   label: "Modo Kiosko",       icon: "fa-desktop"    },
                     { action: "attendance_occupancy_map",  label: "Mapa de Ocupación", icon: "fa-map-marker" },
        ].filter(Boolean);

        const sections = [
            {
                id: "attendance",
                label: "Asistencia",
                icon: "fa-clipboard",
                items: attendanceItems,
            },
        ];

        if (this.state.isCoordinator) {
            sections.push({
                id: "management",
                label: "Gestión Académica",
                icon: "fa-cogs",
                items: [
                    { action: "action_attendance_log", label: "Todos los Registros", icon: "fa-list-alt", isOwl: true },
                    { action: "action_classroom_manager", label: "Aulas", icon: "fa-building" },
                    { action: "action_subject_manager", label: "Materias", icon: "fa-book" },
                    { action: "action_schedule_manager", label: "Carga Horaria", icon: "fa-calendar" },
                    { action: "action_substitution_manager", label: "Suplencias", icon: "fa-exchange" },
                    { action: "action_contingency_manager", label: "Contingencia", icon: "fa-exclamation-triangle" },
                    { action: "action_attendance_analysis", label: "Análisis", icon: "fa-bar-chart", isOwl: true },
                    { action: "action_attendance_config", label: "Configuración", icon: "fa-sliders" },
                ],
            });
        }

        if (this.state.isAdmin) {
            sections.push({
                id: "admin",
                label: "Administración",
                icon: "fa-shield",
                items: [
                    { action: "action_attendance_log", label: "Todos los Registros", icon: "fa-list-alt", isOwl: true },
                    { action: "action_classroom_manager", label: "Aulas", icon: "fa-building" },
                    { action: "action_subject_manager", label: "Materias", icon: "fa-book" },
                    { action: "action_substitution_manager", label: "Suplencias", icon: "fa-exchange" },
                    { action: "action_schedule_manager", label: "Carga Horaria", icon: "fa-calendar" },
                    { action: "action_contingency_manager", label: "Contingencia", icon: "fa-exclamation-triangle" },
                    { action: "action_attendance_analysis", label: "Análisis", icon: "fa-bar-chart", isOwl: true },
                    { action: "action_attendance_config", label: "Configuración", icon: "fa-sliders" },
                    { action: "action_user_manager", label: "Gestión de Usuarios", icon: "fa-users" },
                ],
            });
        }

        return sections;
    }

    get userRoleLabel() {
        if (this.state.isAdmin) return "Administrador";
        if (this.state.isCoordinator) return "Coordinador";
        return "Docente";  // group_teacher
    }

    toggle() {
        this.state.open = !this.state.open;
    }

    close() {
        this.state.open = false;
    }

    toggleSection(sectionId) {
        this.state.expandedSections[sectionId] = !this.state.expandedSections[sectionId];
    }

    isSectionExpanded(sectionId) {
        return this.state.expandedSections[sectionId] !== false;
    }

    navigateTo(item) {
        // Las acciones registradas en ir.actions.client en la BD necesitan el XML ID completo
        // (con prefijo de módulo) para que el servidor las encuentre.
        // Las acciones que solo están en el actionRegistry del cliente (scanner, kiosk, etc.)
        // funcionan directamente con el tag sin prefijo.
        const NEEDS_MODULE_PREFIX = new Set([
            'action_attendance_log',
            'action_attendance_log_my',
            'action_attendance_analysis',
            'action_contingency_manager',
            'action_schedule_manager',
            'action_user_manager',
            'action_classroom_manager',
            'action_subject_manager',
            'action_substitution_manager',
            'action_attendance_config',
        ]);
        const actionId = NEEDS_MODULE_PREFIX.has(item.action)
            ? `teacher_attendance.${item.action}`
            : item.action;
        this.action.doAction(actionId, { clearBreadcrumbs: true });
    }

    navigateToProfile() {
        this.state.open = false;
        // Abre el perfil nativo de Odoo — incluye cambio de contraseña y gestión de dispositivos
        this.action.doAction("base.action_res_users_my");
    }

    logout() {
        window.location = "/web/session/logout";
    }
}

registry.category("main_components").add("UnefaNav", { Component: UnefaNav });