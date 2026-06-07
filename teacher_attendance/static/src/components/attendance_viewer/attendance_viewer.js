/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { user as currentUser } from "@web/core/user";

const STATUS_LABELS = {
    valid:   'Asistió',
    late:    'Retardo',
    absent:  'Inasistencia',
    outside: 'Fuera del Radio',
    manual:  'Validado Manual',
    invalid: 'Inválido',
};
const STATUS_CLASS = {
    valid:   'av-badge-ok',
    late:    'av-badge-late',
    absent:  'av-badge-absent',
    outside: 'av-badge-outside',
    manual:  'av-badge-manual',
    invalid: 'av-badge-invalid',
};
const METHOD_LABELS = {
    qr:     'QR Aula',
    carnet: 'Carnet',
    kiosk:  'Kiosko PIN',
    manual: 'Manual',
};

function fmtDT(val) {
    if (!val) return '—';
    const d = new Date(val.replace(' ', 'T') + 'Z');
    return d.toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });
}
function fmtDur(h) {
    if (!h) return '—';
    const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    return mm > 0 ? `${hh}h ${mm}m` : `${hh}h`;
}
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
function firstOfMonth() {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
}

export class AttendanceViewer extends Component {
    static template = "teacher_attendance.AttendanceViewer";

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");

        // "mine" → Mis Registros | "all" → Todos los Registros
        this.viewMode = this.props.action?.tag === 'action_attendance_log_my' ? 'mine' : 'all';

        this.state = useState({
            logs: [],
            totalCount: 0,
            summary: { valid: 0, late: 0, absent: 0, outside: 0, manual: 0, totalHours: 0 },
            teachers: [],
            filterStatus: "",
            filterTeacher: "",
            filterDateFrom: firstOfMonth(),
            filterDateTo: todayISO(),
            currentPage: 1,
            isLoading: true,
            isCoordinator: false,
        });

        this.PAGE_SIZE = 25;
        this.STATUS_LABELS = STATUS_LABELS;
        this.STATUS_CLASS  = STATUS_CLASS;
        this.METHOD_LABELS = METHOD_LABELS;

        onWillStart(async () => {
            this.state.isCoordinator =
                await currentUser.hasGroup("teacher_attendance.group_coordinator") ||
                await currentUser.hasGroup("teacher_attendance.group_admin") ||
                await currentUser.hasGroup("base.group_system");

            if (this.state.isCoordinator && this.viewMode === 'all') {
                this.state.teachers = await this.orm.searchRead(
                    "res.users",
                    [["attendance_role", "in", ["teacher", "coordinator", "admin"]]],
                    ["name"], { order: "name asc" }
                );
            }
            await this.loadAll();
        });
    }

    _buildDomain() {
        const d = [];
        if (this.viewMode === 'mine') d.push(["teacher_id", "=", currentUser.userId]);
        if (this.state.filterTeacher) d.push(["teacher_id", "=", parseInt(this.state.filterTeacher)]);
        if (this.state.filterStatus)  d.push(["status", "=", this.state.filterStatus]);
        if (this.state.filterDateFrom) d.push(["check_in", ">=", this.state.filterDateFrom + " 00:00:00"]);
        if (this.state.filterDateTo)   d.push(["check_in", "<=", this.state.filterDateTo   + " 23:59:59"]);
        return d;
    }

    async loadAll() {
        this.state.isLoading = true;
        const domain = this._buildDomain();
        const offset = (this.state.currentPage - 1) * this.PAGE_SIZE;
        try {
            const [logs, total, groups] = await Promise.all([
                this.orm.searchRead("attendance.log", domain, [
                    "teacher_id", "classroom_id", "subject_id", "section",
                    "check_in", "check_out", "duration", "status", "method",
                    "is_substitution", "distance",
                ], { order: "check_in desc", limit: this.PAGE_SIZE, offset }),
                this.orm.searchCount("attendance.log", domain),
                this.orm.call("attendance.log", "read_group", [
                    domain, ["status", "duration:sum"], ["status"]
                ]),
            ]);
            this.state.logs = logs;
            this.state.totalCount = total;
            // Resumen
            const s = { valid: 0, late: 0, absent: 0, outside: 0, manual: 0, totalHours: 0 };
            for (const g of groups) {
                s[g.status] = g.status_count || 0;
                s.totalHours += g.duration || 0;
            }
            this.state.summary = s;
        } catch (e) {
            console.error(e);
        }
        this.state.isLoading = false;
    }

    onFilterChange() {
        this.state.currentPage = 1;
        this.loadAll();
    }

    onFilterTeacher(ev)  { this.state.filterTeacher = ev.target.value; this.onFilterChange(); }
    onFilterStatus(ev)   { this.state.filterStatus  = ev.target.value; this.onFilterChange(); }
    onFilterFrom(ev)     { this.state.filterDateFrom = ev.target.value; this.onFilterChange(); }
    onFilterTo(ev)       { this.state.filterDateTo   = ev.target.value; this.onFilterChange(); }

    clearFilters() {
        Object.assign(this.state, {
            filterTeacher: "", filterStatus: "",
            filterDateFrom: firstOfMonth(), filterDateTo: todayISO(), currentPage: 1,
        });
        this.loadAll();
    }

    get totalPages() { return Math.max(1, Math.ceil(this.state.totalCount / this.PAGE_SIZE)); }
    get pageNumbers() {
        const pages = [], tp = this.totalPages, cp = this.state.currentPage;
        const start = Math.max(1, cp - 2), end = Math.min(tp, cp + 2);
        for (let i = start; i <= end; i++) pages.push(i);
        return pages;
    }
    get showingFrom() { return (this.state.currentPage - 1) * this.PAGE_SIZE + 1; }
    get showingTo()   { return Math.min(this.state.currentPage * this.PAGE_SIZE, this.state.totalCount); }

    goToPage(p) {
        if (p < 1 || p > this.totalPages || p === this.state.currentPage) return;
        this.state.currentPage = p;
        this.loadAll();
    }

    formatDT(val)  { return fmtDT(val); }
    formatDur(val) { return fmtDur(val); }
    formatDist(m)  { return m ? `${Math.round(m)}m` : '—'; }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_attendance_log",    AttendanceViewer);
registry.category("actions").add("action_attendance_log_my", AttendanceViewer);
