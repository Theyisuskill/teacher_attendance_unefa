/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const STATUS_LABELS = {
    valid:   'Asistió',
    late:    'Retardo',
    absent:  'Inasistencia',
    outside: 'Fuera del Radio',
    manual:  'Validado Manual',
    invalid: 'Inválido',
    late_justified:   'Retardo Justificado',
    absent_justified: 'Falta Justificada',
};
const STATUS_CLASS = {
    late:             'jm-badge-late',
    absent:           'jm-badge-absent',
    late_justified:   'jm-badge-late-just',
    absent_justified: 'jm-badge-absent-just',
    valid:            'jm-badge-ok',
    outside:          'jm-badge-outside',
    manual:           'jm-badge-manual',
    invalid:          'jm-badge-invalid',
};

// Grupos de estatus para el filtro
const STATUS_GROUPS = {
    pending:   ['late', 'absent'],
    justified: ['late_justified', 'absent_justified'],
    all:       ['late', 'absent', 'late_justified', 'absent_justified'],
};

function todayISO()     { return new Date().toISOString().slice(0, 10); }
function firstOfMonth()  { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

function fmtDT(val) {
    if (!val) return '—';
    const d = new Date(val.replace(' ', 'T') + 'Z');
    return d.toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Interfaz de Coordinación para justificar Retardos e Inasistencias en lote.
 * Filtros de búsqueda + selección múltiple + aval/motivo. Editable y reversible,
 * con historial en el chatter de cada registro.
 */
export class JustificationManager extends Component {
    static template = "teacher_attendance.JustificationManager";

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");

        this.STATUS_LABELS = STATUS_LABELS;
        this.STATUS_CLASS = STATUS_CLASS;

        this.state = useState({
            logs: [],
            teachers: [],
            classrooms: [],
            statusGroup: "pending",          // 'pending' | 'justified' | 'all'
            filterTeacher: "",
            filterClassroom: "",
            filterDateFrom: firstOfMonth(),
            filterDateTo: todayISO(),
            selected: {},                    // { [logId]: true }
            avalNumber: "",
            reason: "",
            isLoading: true,
            isSaving: false,
        });

        onWillStart(async () => {
            const [teachers, classrooms] = await Promise.all([
                this.orm.searchRead("res.users",
                    [["attendance_role", "in", ["teacher", "coordinator", "admin"]]],
                    ["name"], { order: "name asc" }),
                this.orm.searchRead("attendance.classroom", [], ["name", "code"], { order: "name asc" }),
            ]);
            this.state.teachers = teachers;
            this.state.classrooms = classrooms;
            await this.loadLogs();
        });
    }

    _buildDomain() {
        const d = [["status", "in", STATUS_GROUPS[this.state.statusGroup]]];
        if (this.state.filterTeacher)   d.push(["teacher_id", "=", parseInt(this.state.filterTeacher)]);
        if (this.state.filterClassroom) d.push(["classroom_id", "=", parseInt(this.state.filterClassroom)]);
        if (this.state.filterDateFrom)  d.push(["check_in", ">=", this.state.filterDateFrom + " 00:00:00"]);
        if (this.state.filterDateTo)    d.push(["check_in", "<=", this.state.filterDateTo + " 23:59:59"]);
        return d;
    }

    async loadLogs() {
        this.state.isLoading = true;
        try {
            const logs = await this.orm.searchRead(
                "attendance.log", this._buildDomain(),
                ["teacher_id", "classroom_id", "subject_id", "check_in", "status",
                 "justification_aval", "justification_reason",
                 "justification_approver_id", "justification_date"],
                { order: "check_in desc", limit: 200 }
            );
            this.state.logs = logs;
            // Limpiar selección de registros que ya no están en la lista
            const ids = new Set(logs.map(l => l.id));
            for (const k of Object.keys(this.state.selected)) {
                if (!ids.has(parseInt(k))) delete this.state.selected[k];
            }
        } catch (e) {
            this.notification.add("Error al cargar los registros", { type: "danger" });
            this.state.logs = [];
        }
        this.state.isLoading = false;
    }

    // ── Filtros ─────────────────────────────────────────
    setStatusGroup(group) { this.state.statusGroup = group; this.state.selected = {}; this.loadLogs(); }
    onFilterChange() { this.loadLogs(); }
    clearFilters() {
        Object.assign(this.state, {
            filterTeacher: "", filterClassroom: "",
            filterDateFrom: firstOfMonth(), filterDateTo: todayISO(),
        });
        this.loadLogs();
    }

    // ── Selección ───────────────────────────────────────
    toggleRow(id) {
        if (this.state.selected[id]) {
            delete this.state.selected[id];
        } else {
            this.state.selected[id] = true;
        }
        this._maybePrefillFromSelection();
    }
    isSelected(id) { return !!this.state.selected[id]; }

    get selectedIds() { return Object.keys(this.state.selected).map(Number); }
    get selectedCount() { return this.selectedIds.length; }

    get allVisibleSelected() {
        return this.state.logs.length > 0 && this.state.logs.every(l => this.state.selected[l.id]);
    }
    toggleSelectAll() {
        if (this.allVisibleSelected) {
            this.state.selected = {};
        } else {
            const sel = {};
            for (const l of this.state.logs) sel[l.id] = true;
            this.state.selected = sel;
        }
        this._maybePrefillFromSelection();
    }

    /** Si hay exactamente un registro ya justificado seleccionado, precarga su aval/motivo para editar. */
    _maybePrefillFromSelection() {
        const ids = this.selectedIds;
        if (ids.length === 1) {
            const log = this.state.logs.find(l => l.id === ids[0]);
            if (log && (log.status === 'late_justified' || log.status === 'absent_justified')) {
                this.state.avalNumber = log.justification_aval || "";
                this.state.reason = log.justification_reason || "";
            }
        }
    }

    // ── Helpers de presentación ─────────────────────────
    formatDT(val) { return fmtDT(val); }
    statusLabel(s) { return STATUS_LABELS[s] || s; }
    statusClass(s) { return STATUS_CLASS[s] || 'jm-badge-default'; }
    approverName(log) { return log.justification_approver_id ? log.justification_approver_id[1] : '—'; }

    get selectionHasJustifiable() {
        return this.selectedIds.some(id => {
            const l = this.state.logs.find(x => x.id === id);
            return l && (l.status === 'late' || l.status === 'absent'
                      || l.status === 'late_justified' || l.status === 'absent_justified');
        });
    }
    get selectionHasJustified() {
        return this.selectedIds.some(id => {
            const l = this.state.logs.find(x => x.id === id);
            return l && (l.status === 'late_justified' || l.status === 'absent_justified');
        });
    }

    // ── Acciones ────────────────────────────────────────
    async justifySelected() {
        if (this.state.isSaving) return;
        if (!this.selectedCount) {
            this.notification.add("Seleccione al menos un registro", { type: "warning" });
            return;
        }
        if (!this.state.avalNumber.trim()) {
            this.notification.add("El número de aval es obligatorio", { type: "warning" });
            return;
        }
        if (!this.state.reason.trim()) {
            this.notification.add("El motivo es obligatorio", { type: "warning" });
            return;
        }
        this.state.isSaving = true;
        try {
            const res = await this.orm.call("attendance.log", "action_justify_records", [], {
                record_ids: this.selectedIds,
                reason: this.state.reason.trim(),
                aval_number: this.state.avalNumber.trim(),
            });
            let msg = `${res.justified} registro(s) justificado(s)`;
            if (res.skipped) msg += ` · ${res.skipped} omitido(s) (no justificables)`;
            this.notification.add(msg, { type: res.justified ? "success" : "warning" });
            this.state.selected = {};
            this.state.avalNumber = "";
            this.state.reason = "";
            await this.loadLogs();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al justificar", { type: "danger" });
        }
        this.state.isSaving = false;
    }

    async revertSelected() {
        if (this.state.isSaving) return;
        if (!this.selectedCount) {
            this.notification.add("Seleccione al menos un registro", { type: "warning" });
            return;
        }
        this.state.isSaving = true;
        try {
            const res = await this.orm.call("attendance.log", "action_revert_justification", [], {
                record_ids: this.selectedIds,
            });
            let msg = `${res.reverted} justificación(es) revertida(s)`;
            if (res.skipped) msg += ` · ${res.skipped} omitido(s)`;
            this.notification.add(msg, { type: res.reverted ? "success" : "warning" });
            this.state.selected = {};
            await this.loadLogs();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al revertir", { type: "danger" });
        }
        this.state.isSaving = false;
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_justification_manager", JustificationManager);
