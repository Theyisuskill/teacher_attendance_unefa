/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

const DAY_LABELS = {
    "0": "Lunes", "1": "Martes", "2": "Miércoles",
    "3": "Jueves", "4": "Viernes", "5": "Sábado", "6": "Domingo",
};
const DAY_ORDER = ["0", "1", "2", "3", "4", "5", "6"];

function floatToHHMM(val) {
    if (!val && val !== 0) return "--:--";
    const h = Math.floor(val);
    const m = Math.round((val - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Convierte "HH:MM" (string de input type=time) a float decimal
function hhmmToFloat(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(":").map(Number);
    return h + m / 60;
}

export class ScheduleManager extends Component {
    static template = "teacher_attendance.ScheduleManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.state = useState({
            schedules: [],
            teachers: [],
            teacherProfiles: [],   // con dedicación + límites
            classrooms: [],
            subjects: [],
            loadSummary: [],       // carga horaria vs dedicación
            filterTeacherId: "",
            filterClassroomId: "",
            filterDay: "",
            currentView: "list",
            editingSchedule: null,
            isLoading: true,
            formData: this._emptyForm(),
        });

        onWillStart(async () => await this.loadAll());
    }

    _emptyForm() {
        return {
            teacher_id: "",
            classroom_id: "",
            subject_id: "",
            section: "",
            activity_type: "clase",
            day_of_week: "0",
            start_hour: "07:00",   // string HH:MM para input type=time
            end_hour:   "09:00",
        };
    }

    // ── Data loading ───────────────────────────────────
    async loadAll() {
        this.state.isLoading = true;
        try {
            const [schedules, teacherProfiles, classrooms, subjects, loadSummary] = await Promise.all([
                this.orm.searchRead("attendance.schedule", [], [
                    "teacher_id", "classroom_id", "subject_id",
                    "section", "activity_type", "day_of_week", "start_hour", "end_hour", "duration",
                ], { order: "teacher_id, day_of_week, start_hour" }),
                this.orm.searchRead("res.users",
                    [["attendance_role", "in", ["teacher", "coordinator", "admin"]]],
                    ["name", "teacher_dedication"], { order: "name asc" }),
                this.orm.searchRead("attendance.classroom", [], ["name", "code"], { order: "name asc" }),
                this.orm.searchRead("attendance.subject", [], ["name", "code"], { order: "name asc" }),
                this.orm.call("attendance.schedule", "get_teachers_load_summary", []),
            ]);
            this.state.schedules = schedules;
            this.state.teachers = teacherProfiles;       // para el dropdown
            this.state.teacherProfiles = teacherProfiles;
            this.state.classrooms = classrooms;
            this.state.subjects = subjects;
            this.state.loadSummary = loadSummary;
        } catch (e) {
            this.notification.add("Error al cargar horarios", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    // ── Filters & computed ──────────────────────────────
    get filteredSchedules() {
        let list = this.state.schedules;
        const tid = parseInt(this.state.filterTeacherId);
        const cid = parseInt(this.state.filterClassroomId);
        if (tid) list = list.filter(s => s.teacher_id[0] === tid);
        if (cid) list = list.filter(s => s.classroom_id[0] === cid);
        if (this.state.filterDay) list = list.filter(s => s.day_of_week === this.state.filterDay);
        return list;
    }

    /**
     * Agrupa los horarios filtrados por docente.
     * Cada entrada: { teacher_id, teacher_name, totalHours, byDay: { "0": [...], "1": [...], ... } }
     */
    get groupedByTeacher() {
        const map = new Map();
        for (const s of this.filteredSchedules) {
            const tid = s.teacher_id[0];
            if (!map.has(tid)) {
                map.set(tid, {
                    teacher_id: tid,
                    teacher_name: s.teacher_id[1],
                    totalHours: 0,
                    byDay: {},
                });
            }
            const entry = map.get(tid);
            entry.totalHours += (s.duration || 0);
            if (!entry.byDay[s.day_of_week]) entry.byDay[s.day_of_week] = [];
            entry.byDay[s.day_of_week].push(s);
        }
        return Array.from(map.values()).sort((a, b) => a.teacher_name.localeCompare(b.teacher_name));
    }

    get dayOrder() { return DAY_ORDER; }
    get dayLabels() { return DAY_LABELS; }

    formatHour(val) { return floatToHHMM(val); }

    // Retorna el resumen de carga para un teacher_id dado
    loadInfoFor(teacherId) {
        return this.state.loadSummary.find(s => s.teacher_id === teacherId) || null;
    }

    loadStatusIcon(info) {
        if (!info || !info.dedication) return "";
        if (info.status === "over")  return "fa-exclamation-circle";
        if (info.status === "under") return "fa-exclamation-triangle";
        return "fa-check-circle";
    }

    loadStatusClass(info) {
        if (!info || !info.dedication) return "";
        if (info.status === "over")  return "load-over";
        if (info.status === "under") return "load-under";
        return "load-ok";
    }

    loadStatusText(info) {
        if (!info) return "";
        const h = info.total_hours ? info.total_hours.toFixed(1) : "0";
        if (!info.dedication) return `${h}h/semana`;
        return `${h}h / ${info.min_hours}-${info.max_hours}h (${info.ded_label})`;
    }

    onFilterTeacher(ev) { this.state.filterTeacherId = ev.target.value; }
    onFilterClassroom(ev) { this.state.filterClassroomId = ev.target.value; }
    onFilterDay(ev) { this.state.filterDay = ev.target.value; }

    clearFilters() {
        this.state.filterTeacherId = "";
        this.state.filterClassroomId = "";
        this.state.filterDay = "";
    }

    // ── CRUD ───────────────────────────────────────────
    showCreateForm(preTeacherId) {
        this.state.editingSchedule = null;
        const form = this._emptyForm();
        // t-att-value usa IDs numéricos; t-model los compara como strings en HTML,
        // así que guardamos el número directamente y HTML hace la comparación correctamente.
        if (preTeacherId) form.teacher_id = preTeacherId;
        this.state.formData = form;
        this.state.currentView = "form";
    }

    showEditForm(scheduleId) {
        const s = this.state.schedules.find(x => x.id === scheduleId);
        if (!s) return;
        this.state.editingSchedule = s;
        this.state.formData = {
            teacher_id: s.teacher_id[0],
            classroom_id: s.classroom_id[0],
            subject_id: s.subject_id[0],
            section: s.section || "",
            activity_type: s.activity_type || "clase",
            day_of_week: s.day_of_week,
            start_hour: floatToHHMM(s.start_hour),   // float → HH:MM para el input
            end_hour:   floatToHHMM(s.end_hour),
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editingSchedule = null;
        this.state.formData = this._emptyForm();
    }

    async saveSchedule() {
        const { formData, editingSchedule } = this.state;
        if (!formData.teacher_id || !formData.classroom_id || !formData.subject_id || !formData.day_of_week) {
            this.notification.add("Docente, aula, materia y día son obligatorios", { type: "warning" });
            return;
        }
        // Convertir HH:MM → float para el backend
        const sh = hhmmToFloat(formData.start_hour);
        const eh = hhmmToFloat(formData.end_hour);
        if (!formData.start_hour || !formData.end_hour || sh >= eh) {
            this.notification.add("La hora de fin debe ser posterior a la hora de inicio", { type: "warning" });
            return;
        }
        const vals = {
            teacher_id: parseInt(formData.teacher_id),
            classroom_id: parseInt(formData.classroom_id),
            subject_id: parseInt(formData.subject_id),
            section: formData.section || false,
            activity_type: formData.activity_type || "clase",
            day_of_week: formData.day_of_week,
            start_hour: sh,
            end_hour: eh,
        };
        try {
            if (editingSchedule) {
                await this.orm.write("attendance.schedule", [editingSchedule.id], vals);
                this.notification.add("Horario actualizado", { type: "success" });
            } else {
                await this.orm.create("attendance.schedule", [vals]);
                this.notification.add("Horario creado correctamente", { type: "success" });
            }
            await this.loadAll();
            this.cancelForm();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al guardar el horario", { type: "danger" });
        }
    }

    async showQrCard(scheduleId) {
        const data = await this.orm.call(
            "attendance.schedule", "get_qr_card_data", [scheduleId]
        );
        if (!data || !data.qr_base64) {
            this.notification.add("El aula no tiene QR generado aún", { type: "warning" });
            return;
        }
        // Abrir ventana de impresión con la tarjeta del bloque
        const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<title>QR — ${data.classroom_name}</title>
<style>
  @page { size: A6; margin: 10mm; }
  * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
  body { background:#fff; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { border:2px solid #5273A8; border-radius:12px; padding:16px; max-width:240px; text-align:center; }
  .header { background:#5273A8; color:#fff; border-radius:8px; padding:8px 12px; margin-bottom:12px; }
  .header h2 { margin:0; font-size:1.1rem; font-weight:700; }
  .header p  { margin:4px 0 0; font-size:0.65rem; opacity:0.8; letter-spacing:0.5px; }
  .qr-img { width:160px; height:160px; margin:0 auto 12px; display:block; border:1px solid #eee; border-radius:6px; }
  .info { text-align:left; font-size:0.72rem; line-height:1.6; color:#2d3748; }
  .info b { color:#5273A8; }
  .flag { height:4px; background:linear-gradient(90deg,#F1D88B 33.33%,#6E8FC7 33.33% 66.66%,#DE979D 66.66%); border-radius:2px; margin-top:12px; }
  .footer { font-size:0.6rem; color:#a0aec0; margin-top:8px; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <h2>UNEFA · Asistencia</h2>
    <p>Escanea para registrar tu asistencia</p>
  </div>
  <img class="qr-img" src="data:image/png;base64,${data.qr_base64}" alt="QR"/>
  <div class="info">
    <div><b>Aula:</b> ${data.classroom_name} (${data.classroom_code})</div>
    <div><b>Materia:</b> ${data.subject_name}${data.subject_code ? ' (' + data.subject_code + ')' : ''}</div>
    ${data.section ? `<div><b>Sección:</b> ${data.section}</div>` : ''}
    <div><b>Docente:</b> ${data.teacher_name}</div>
    <div><b>Horario:</b> ${data.day_name} ${data.start_hhmm}–${data.end_hhmm}</div>
  </div>
  <div class="flag"></div>
  <div class="footer">Universidad Nacional Experimental de las Fuerzas Armadas</div>
</div>
<script>window.onload=()=>{window.print();window.close();}</script>
</body></html>`;
        const win = window.open('', '_blank', 'width=400,height=600');
        if (win) { win.document.write(html); win.document.close(); }
    }

    deleteSchedule(scheduleId) {
        this.dialog.add(Dialog, {
            title: "Eliminar horario",
            body: "¿Confirma la eliminación de este bloque horario?",
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.schedule", [scheduleId]);
                    this.notification.add("Horario eliminado", { type: "success" });
                    await this.loadAll();
                } catch {
                    this.notification.add("No se pudo eliminar el horario", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    // Vista previa — ya es HH:MM porque el input es type=time
    get previewStart() { return this.state.formData.start_hour || "--:--"; }
    get previewEnd()   { return this.state.formData.end_hour   || "--:--"; }

    formatTotalHours(hours) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        return m > 0 ? `${h}h ${m}min` : `${h}h`;
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_schedule_manager", ScheduleManager);
