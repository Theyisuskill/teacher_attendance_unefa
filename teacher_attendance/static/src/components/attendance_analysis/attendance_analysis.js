/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user as currentUser } from "@web/core/user";

function isoToday()      { return new Date().toISOString().slice(0, 10); }
function isoFirstMonth() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }
function isoMonday()     {
    const d = new Date();
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d.toISOString().slice(0, 10);
}

export class AttendanceAnalysis extends Component {
    static template = "teacher_attendance.AttendanceAnalysis";

    setup() {
        this.orm  = useService("orm");
        this.action = useService("action");

        this.state = useState({
            period: 'month',
            dateFrom: isoFirstMonth(),
            dateTo: isoToday(),
            isLoading: true,
            isCoordinator: false,
            // Totales globales
            totals: { valid: 0, late: 0, absent: 0, outside: 0, manual: 0, totalHours: 0, totalLogs: 0 },
            // Tabla por docente
            teacherRows: [],
        });

        onWillStart(async () => {
            this.state.isCoordinator =
                await currentUser.hasGroup("teacher_attendance.group_coordinator") ||
                await currentUser.hasGroup("teacher_attendance.group_admin") ||
                await currentUser.hasGroup("base.group_system");
            await this.loadStats();
        });
    }

    get punctuality() {
        const { valid, totalLogs } = this.state.totals;
        if (!totalLogs) return 0;
        return Math.round((valid / totalLogs) * 100);
    }

    setPeriod(period) {
        this.state.period = period;
        if (period === 'week')  { this.state.dateFrom = isoMonday();     this.state.dateTo = isoToday(); }
        if (period === 'month') { this.state.dateFrom = isoFirstMonth(); this.state.dateTo = isoToday(); }
        // 'custom' → user edits the date inputs directly
        if (period !== 'custom') this.loadStats();
    }

    onDateChange() { this.loadStats(); }

    async loadStats() {
        this.state.isLoading = true;
        const baseDomain = [
            ["check_in", ">=", this.state.dateFrom + " 00:00:00"],
            ["check_in", "<=", this.state.dateTo   + " 23:59:59"],
        ];

        try {
            // ── Totales globales por estatus ──
            const byStatus = await this.orm.call(
                "attendance.log", "read_group",
                [baseDomain, ["status", "duration:sum"], ["status"]]
            );
            const t = { valid: 0, late: 0, absent: 0, outside: 0, manual: 0, totalHours: 0, totalLogs: 0 };
            for (const g of byStatus) {
                t[g.status] = (g[g.status + '_count'] ?? g.status_count) || 0;
                t.totalHours += g.duration || 0;
                t.totalLogs  += g.status_count || 0;
            }
            this.state.totals = t;

            // ── Tabla por docente (solo para coordinadores) ──
            if (this.state.isCoordinator) {
                const byTeacher = await this.orm.call(
                    "attendance.log", "read_group",
                    [baseDomain, ["teacher_id", "status", "duration:sum"], ["teacher_id", "status"]]
                );
                // Agrupar en un mapa por docente
                const teacherMap = new Map();
                for (const g of byTeacher) {
                    const tid  = g.teacher_id[0];
                    const name = g.teacher_id[1];
                    if (!teacherMap.has(tid)) {
                        teacherMap.set(tid, { name, valid: 0, late: 0, absent: 0, hours: 0, total: 0 });
                    }
                    const row = teacherMap.get(tid);
                    const cnt = g.status_count || 0;
                    row[g.status] = (row[g.status] || 0) + cnt;
                    row.hours += g.duration || 0;
                    row.total += cnt;
                }
                // Ordenar por nombre
                this.state.teacherRows = Array.from(teacherMap.values())
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(r => ({
                        ...r,
                        punctuality: r.total ? Math.round((r.valid / r.total) * 100) : 0,
                        hours: r.hours.toFixed(1),
                    }));
            }
        } catch (e) {
            console.error(e);
        }
        this.state.isLoading = false;
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_attendance_analysis", AttendanceAnalysis);
