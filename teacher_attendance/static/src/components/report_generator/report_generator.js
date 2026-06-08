/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const GROUP_OPTIONS = [
    { v: "day",      label: "Día" },
    { v: "week",     label: "Semana" },
    { v: "month",    label: "Mes" },
    { v: "quarter",  label: "Trimestre" },
    { v: "year",     label: "Año" },
    { v: "teacher",  label: "Docente" },
    { v: "subject",  label: "Asignatura" },
    { v: "section",  label: "Sección" },
    { v: "status",   label: "Estatus" },
];

// Columnas de estatus mostradas en la tabla y el gráfico
const COLS = [
    { key: "valid",     label: "Asistió",      cls: "rg-c-valid" },
    { key: "late",      label: "Retardo",      cls: "rg-c-late" },
    { key: "absent",    label: "Inasistencia", cls: "rg-c-absent" },
    { key: "outside",   label: "Fuera",        cls: "rg-c-outside" },
    { key: "manual",    label: "Manual",       cls: "rg-c-manual" },
    { key: "justified", label: "Justificados", cls: "rg-c-just" },
];

function todayISO()     { return new Date().toISOString().slice(0, 10); }
function firstOfMonth()  { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

export class ReportGenerator extends Component {
    static template = "teacher_attendance.ReportGenerator";

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");

        this.GROUP_OPTIONS = GROUP_OPTIONS;
        this.COLS = COLS;

        this.state = useState({
            dateFrom: firstOfMonth(),
            dateTo: todayISO(),
            groupBy: "month",
            filters: { teacher_id: "", subject_id: "", section: "", statuses: [] },
            options: { teachers: [], subjects: [], sections: [], statuses: [] },
            rows: [],
            totals: { counts: {}, total: 0, hours: 0, punctuality: 0 },
            isLoading: true,
        });

        onWillStart(async () => {
            try {
                this.state.options = await this.orm.call("attendance.log", "get_report_filter_options", []);
            } catch (e) {
                this.notification.add("No se pudieron cargar las opciones de filtro", { type: "danger" });
            }
            await this.run();
        });
    }

    get groupLabel() {
        return (GROUP_OPTIONS.find(g => g.v === this.state.groupBy) || {}).label || "";
    }

    async run() {
        this.state.isLoading = true;
        try {
            const res = await this.orm.call("attendance.log", "generate_report", [
                this.state.dateFrom, this.state.dateTo, this.state.groupBy,
                {
                    teacher_id: this.state.filters.teacher_id || false,
                    subject_id: this.state.filters.subject_id || false,
                    section: this.state.filters.section || false,
                    statuses: this.state.filters.statuses,
                },
            ]);
            this.state.rows = res.rows || [];
            this.state.totals = res.totals || { counts: {}, total: 0, hours: 0, punctuality: 0 };
        } catch (e) {
            this.notification.add(e.data?.message || "Error al generar el reporte", { type: "danger" });
            this.state.rows = [];
        }
        this.state.isLoading = false;
    }

    onParamChange() { this.run(); }

    toggleStatus(value) {
        const arr = this.state.filters.statuses;
        const i = arr.indexOf(value);
        if (i >= 0) arr.splice(i, 1); else arr.push(value);
        this.run();
    }
    isStatusOn(value) { return this.state.filters.statuses.includes(value); }

    clearFilters() {
        this.state.filters = { teacher_id: "", subject_id: "", section: "", statuses: [] };
        this.state.dateFrom = firstOfMonth();
        this.state.dateTo = todayISO();
        this.run();
    }

    // ── Helpers de celdas ───────────────────────────────
    cellValue(counts, key) {
        if (!counts) return 0;
        if (key === "justified") return (counts.late_justified || 0) + (counts.absent_justified || 0);
        return counts[key] || 0;
    }
    fmtHours(h) { return (h || 0).toFixed(1); }

    get hasData() { return this.state.rows.length > 0; }

    /** Valor máximo entre las columnas para escalar el gráfico. */
    get chartMax() {
        let max = 0;
        for (const c of COLS) max = Math.max(max, this.cellValue(this.state.totals.counts, c.key));
        return max || 1;
    }
    barWidth(key) {
        return Math.round(this.cellValue(this.state.totals.counts, key) / this.chartMax * 100);
    }

    // ── Exportar (server-side, desde la BD) ─────────────
    _exportUrl(kind, fmt) {
        const f = this.state.filters;
        const p = new URLSearchParams({
            kind, format: fmt,
            date_from: this.state.dateFrom, date_to: this.state.dateTo,
            group_by: this.state.groupBy,
        });
        if (f.teacher_id) p.set("teacher_id", f.teacher_id);
        if (f.subject_id) p.set("subject_id", f.subject_id);
        if (f.section) p.set("section", f.section);
        if (f.statuses.length) p.set("statuses", f.statuses.join(","));
        return `/teacher_attendance/report/export?${p.toString()}`;
    }
    exportFile(kind, fmt) {
        if (!this.hasData) {
            this.notification.add("No hay datos para exportar", { type: "warning" });
            return;
        }
        window.open(this._exportUrl(kind, fmt), "_blank");
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_report_generator", ReportGenerator);
