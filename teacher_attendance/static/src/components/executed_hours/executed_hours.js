/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

function isoToday()      { return new Date().toISOString().slice(0, 10); }
function isoFirstMonth() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }
function isoMonday()     {
    const d = new Date();
    const day = d.getDay() || 7;            // domingo (0) → 7
    d.setDate(d.getDate() - day + 1);       // lunes de esta semana
    return d.toISOString().slice(0, 10);
}

/**
 * Reporte de "Horas Acumuladas Ejecutadas" discriminadas por tipo de actividad
 * (Clase / Asesoría / Defensa), por docente, con filtro de fechas y exportación.
 * Para coordinadores/administradores.
 */
export class ExecutedHours extends Component {
    static template = "teacher_attendance.ExecutedHours";

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");

        this.state = useState({
            period: 'month',                 // 'week' | 'month' | 'custom'
            dateFrom: isoFirstMonth(),
            dateTo: isoToday(),
            isLoading: true,
            rows: [],
            totals: { clase: 0, asesoria: 0, defensa: 0, total: 0 },
        });

        onWillStart(async () => { await this.loadReport(); });
    }

    setPeriod(period) {
        this.state.period = period;
        if (period === 'week')  { this.state.dateFrom = isoMonday();     this.state.dateTo = isoToday(); }
        if (period === 'month') { this.state.dateFrom = isoFirstMonth(); this.state.dateTo = isoToday(); }
        if (period !== 'custom') this.loadReport();
    }

    onDateChange() { this.loadReport(); }

    async loadReport() {
        this.state.isLoading = true;
        try {
            const res = await this.orm.call(
                "attendance.log", "get_executed_hours_report", [],
                { date_from: this.state.dateFrom, date_to: this.state.dateTo }
            );
            this.state.rows = res.rows || [];
            this.state.totals = res.totals || { clase: 0, asesoria: 0, defensa: 0, total: 0 };
        } catch (e) {
            this.notification.add(
                e.data?.message || "Error al cargar el reporte de horas ejecutadas",
                { type: "danger" }
            );
            this.state.rows = [];
            this.state.totals = { clase: 0, asesoria: 0, defensa: 0, total: 0 };
        }
        this.state.isLoading = false;
    }

    /** Formatea horas decimales a 1 decimal con sufijo h. */
    fmt(h) { return (h || 0).toFixed(1); }

    get hasData() { return this.state.rows.length > 0; }

    /** Porcentaje de un tipo respecto al total global (para la barra de distribución). */
    pct(value) {
        const t = this.state.totals.total;
        if (!t) return 0;
        return Math.round((value / t) * 100);
    }

    /** Exporta el reporte server-side (PDF o XLSX) desde la BD. */
    exportFile(fmt) {
        if (!this.hasData) {
            this.notification.add("No hay datos para exportar", { type: "warning" });
            return;
        }
        const p = new URLSearchParams({
            kind: "executed", format: fmt,
            date_from: this.state.dateFrom, date_to: this.state.dateTo,
        });
        window.open(`/teacher_attendance/report/export?${p.toString()}`, "_blank");
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_executed_hours", ExecutedHours);
