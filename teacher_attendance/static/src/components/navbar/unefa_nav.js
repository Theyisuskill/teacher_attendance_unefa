/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user } from "@web/core/user";

export class UnefaNav extends Component {
    static template = "teacher_attendance.UnefaNav";
    static props = {};

    setup() {
        this.action = useService("action");
        this.state = useState({
            open: false,
            expandedSections: { attendance: true },
            isCoordinator: false,
            isAdmin: false,
            userName: user.name,
            userInitial: user.name ? user.name.charAt(0).toUpperCase() : "U",
        });

        onWillStart(async () => {
            this.state.isCoordinator = await user.hasGroup("teacher_attendance.group_coordinator");
            this.state.isAdmin = await user.hasGroup("base.group_system");
            if (this.state.isCoordinator) {
                this.state.expandedSections.management = true;
            }
            if (this.state.isAdmin) {
                this.state.expandedSections.admin = true;
            }
        });
    }

    get navSections() {
        const sections = [
            {
                id: "attendance",
                label: "Asistencia",
                icon: "fa-clipboard",
                items: [
                    { action: "attendance_scanner_action", label: "Escanear QR", icon: "fa-qrcode" },
                    { action: "action_attendance_log_my", label: "Mis Registros", icon: "fa-history", isOdooAction: true },
                    { action: "attendance_kiosk_action", label: "Modo Kiosko", icon: "fa-desktop" },
                    { action: "attendance_occupancy_map", label: "Mapa de Ocupación", icon: "fa-map-marker" },
                ],
            },
        ];

        if (this.state.isCoordinator) {
            sections.push({
                id: "management",
                label: "Gestión Académica",
                icon: "fa-cogs",
                items: [
                    { action: "action_attendance_log", label: "Todos los Registros", icon: "fa-list-alt", isOdooAction: true },
                    { action: "action_classroom_manager", label: "Aulas", icon: "fa-building" },
                    { action: "action_subject_manager", label: "Materias", icon: "fa-book" },
                    { action: "action_substitution_manager", label: "Suplencias", icon: "fa-exchange" },
                    { action: "action_attendance_analysis", label: "Análisis", icon: "fa-bar-chart", isOdooAction: true },
                ],
            });
        }

        if (this.state.isAdmin) {
            sections.push({
                id: "admin",
                label: "Administración",
                icon: "fa-shield",
                items: [
                    { action: "action_attendance_log", label: "Todos los Registros", icon: "fa-list-alt", isOdooAction: true },
                    { action: "action_classroom_manager", label: "Aulas", icon: "fa-building" },
                    { action: "action_subject_manager", label: "Materias", icon: "fa-book" },
                    { action: "action_substitution_manager", label: "Suplencias", icon: "fa-exchange" },
                    { action: "action_attendance_analysis", label: "Análisis", icon: "fa-bar-chart", isOdooAction: true },
                    { action: "action_user_manager", label: "Gestión de Usuarios", icon: "fa-users" },
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

    toggleSection(sectionId) {
        this.state.expandedSections[sectionId] = !this.state.expandedSections[sectionId];
    }

    isSectionExpanded(sectionId) {
        return this.state.expandedSections[sectionId] || false;
    }

    navigateTo(item) {
        this.state.open = false;
        const actionId = item.isOdooAction ? `teacher_attendance.${item.action}` : item.action;
        this.action.doAction(actionId, { clearBreadcrumbs: true });
    }

    logout() {
        window.location = "/web/session/logout";
    }
}

registry.category("main_components").add("UnefaNav", { Component: UnefaNav });
