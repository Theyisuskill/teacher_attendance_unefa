/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

function nowLocal() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDatetime(val) {
    if (!val) return "—";
    const d = new Date(val.replace(" ", "T") + "Z");
    return d.toLocaleString("es-VE", { dateStyle: "short", timeStyle: "short" });
}

export class ContingencyManager extends Component {
    static template = "teacher_attendance.ContingencyManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");

        this.state = useState({
            teachers: [],
            classrooms: [],
            recentLogs: [],
            isLoading: true,
            isSaving: false,
            formData: this._emptyForm(),
            lastResult: null,   // {success, message, entry_type}
        });

        onWillStart(async () => await this.loadAll());
    }

    _emptyForm() {
        return {
            teacher_id: "",
            classroom_id: "",
            entry_type: "checkin",
            entry_datetime: nowLocal(),
            justification: "",
        };
    }

    async loadAll() {
        this.state.isLoading = true;
        try {
            const [teachers, classrooms, logs] = await Promise.all([
                this.orm.searchRead("res.users",
                    [["attendance_role", "in", ["teacher", "coordinator", "admin"]], ["active", "=", true]],
                    ["name"], { order: "name asc" }),
                this.orm.searchRead("attendance.classroom", [], ["name", "code"], { order: "name asc" }),
                this.orm.call("attendance.log", "get_recent_contingency_logs", []),
            ]);
            this.state.teachers = teachers;
            this.state.classrooms = classrooms;
            this.state.recentLogs = logs;
        } catch (e) {
            this.notification.add("Error al cargar datos", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    resetForm() {
        this.state.formData = this._emptyForm();
        this.state.lastResult = null;
    }

    formatDatetime(val) { return fmtDatetime(val); }
    formatDuration(h) {
        if (!h) return "—";
        const hh = Math.floor(h);
        const mm = Math.round((h - hh) * 60);
        return mm > 0 ? `${hh}h ${mm}min` : `${hh}h`;
    }

    async submitContingency() {
        const { formData } = this.state;
        if (!formData.teacher_id || !formData.classroom_id) {
            this.notification.add("Seleccione docente y aula", { type: "warning" });
            return;
        }
        if (!formData.justification.trim()) {
            this.notification.add("La justificación es obligatoria para el registro manual", { type: "warning" });
            return;
        }
        if (!formData.entry_datetime) {
            this.notification.add("Ingrese la fecha y hora del registro", { type: "warning" });
            return;
        }

        this.state.isSaving = true;
        try {
            const result = await this.orm.call(
                "attendance.log",
                "action_create_contingency_log",
                [
                    parseInt(formData.teacher_id),
                    parseInt(formData.classroom_id),
                    formData.entry_type,
                    formData.entry_datetime,
                    formData.justification.trim(),
                ]
            );
            this.state.lastResult = { success: true, ...result };
            this.notification.add(result.message, { type: "success" });
            this.state.formData = this._emptyForm();
            await this.loadAll();
        } catch (e) {
            this.state.lastResult = { success: false, message: e.data?.message || "Error al registrar" };
            this.notification.add(e.data?.message || "Error al registrar la asistencia", { type: "danger" });
        }
        this.state.isSaving = false;
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_contingency_manager", ContingencyManager);
