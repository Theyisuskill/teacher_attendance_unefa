/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

const ACTIVITY_LABELS = { clase: "Clase", asesoria: "Asesoría", defensa: "Defensa" };
const STATE_LABELS = {
    scheduled: "Programado", open: "En curso", expired: "Finalizado", cancelled: "Cancelado",
};

function pad(n) { return String(n).padStart(2, "0"); }

/** UTC "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM" en hora local (para datetime-local). */
function utcToLocalInput(utc) {
    if (!utc) return "";
    const d = new Date(utc.replace(" ", "T") + "Z");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDT(utc) {
    if (!utc) return "—";
    const d = new Date(utc.replace(" ", "T") + "Z");
    return d.toLocaleString("es-VE", { dateStyle: "short", timeStyle: "short" });
}
/** datetime-local por defecto: ahora + `h` horas, redondeado a la hora. */
function localInputIn(h) {
    const d = new Date();
    d.setHours(d.getHours() + h, 0, 0, 0);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class TempBlockManager extends Component {
    static template = "teacher_attendance.TempBlockManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.ACTIVITY_LABELS = ACTIVITY_LABELS;
        this.STATE_LABELS = STATE_LABELS;

        this.state = useState({
            blocks: [],
            classrooms: [],
            subjects: [],
            search: "",
            filterType: "",
            currentView: "list",     // 'list' | 'form'
            editing: null,
            isLoading: true,
            formData: this._emptyForm(),
        });

        onWillStart(async () => await this.loadAll());
    }

    _emptyForm() {
        return {
            name: "",
            activity_type: "defensa",
            subject_id: "",
            classroom_id: "",
            date_start: localInputIn(1),
            date_end: localInputIn(3),
            require_gps: false,
            note: "",
        };
    }

    async loadAll() {
        this.state.isLoading = true;
        try {
            const [blocks, classrooms, subjects] = await Promise.all([
                this.orm.searchRead("attendance.temp.block", [], [
                    "name", "activity_type", "subject_id", "classroom_id",
                    "date_start", "date_end", "require_gps", "active",
                    "registration_count", "total_hours", "state",
                ], { order: "date_start desc" }),
                this.orm.searchRead("attendance.classroom", [], ["name", "code"], { order: "name asc" }),
                this.orm.searchRead("attendance.subject", [], ["name", "code"], { order: "name asc" }),
            ]);
            this.state.blocks = blocks;
            this.state.classrooms = classrooms;
            this.state.subjects = subjects;
        } catch (e) {
            this.notification.add("Error al cargar los bloques temporales", { type: "danger" });
        }
        this.state.isLoading = false;
    }

    get filteredBlocks() {
        let list = this.state.blocks;
        const q = this.state.search.trim().toLowerCase();
        if (q) list = list.filter(b => (b.name || "").toLowerCase().includes(q));
        if (this.state.filterType) list = list.filter(b => b.activity_type === this.state.filterType);
        return list;
    }

    // ── Helpers de presentación ─────────────────────────
    fmtDT(v) { return fmtDT(v); }
    activityLabel(t) { return ACTIVITY_LABELS[t] || t; }
    stateLabel(s) { return STATE_LABELS[s] || s; }
    classroomName(b) { return b.classroom_id ? b.classroom_id[1] : "—"; }
    subjectName(b) { return b.subject_id ? b.subject_id[1] : ""; }

    // ── CRUD ────────────────────────────────────────────
    showCreateForm() {
        this.state.editing = null;
        this.state.formData = this._emptyForm();
        this.state.currentView = "form";
    }

    showEditForm(blockId) {
        const b = this.state.blocks.find(x => x.id === blockId);
        if (!b) return;
        this.state.editing = b;
        this.state.formData = {
            name: b.name || "",
            activity_type: b.activity_type || "defensa",
            subject_id: b.subject_id ? b.subject_id[0] : "",
            classroom_id: b.classroom_id ? b.classroom_id[0] : "",
            date_start: utcToLocalInput(b.date_start),
            date_end: utcToLocalInput(b.date_end),
            require_gps: !!b.require_gps,
            note: b.note || "",
        };
        this.state.currentView = "form";
    }

    cancelForm() {
        this.state.currentView = "list";
        this.state.editing = null;
        this.state.formData = this._emptyForm();
    }

    async saveBlock() {
        const f = this.state.formData;
        if (!f.name.trim()) {
            this.notification.add("El nombre de la actividad es obligatorio", { type: "warning" });
            return;
        }
        if (!f.classroom_id) {
            this.notification.add("Debe seleccionar un aula / lugar", { type: "warning" });
            return;
        }
        if (!f.date_start || !f.date_end || f.date_end <= f.date_start) {
            this.notification.add("La hora de fin debe ser posterior a la de inicio", { type: "warning" });
            return;
        }
        const vals = {
            name: f.name.trim(),
            activity_type: f.activity_type,
            subject_id: f.subject_id ? parseInt(f.subject_id) : false,
            classroom_id: parseInt(f.classroom_id),
            date_start: f.date_start,
            date_end: f.date_end,
            require_gps: !!f.require_gps,
            note: f.note || false,
        };
        try {
            if (this.state.editing) {
                await this.orm.call("attendance.temp.block", "write_from_ui",
                    [[this.state.editing.id], vals]);
                this.notification.add("Bloque actualizado", { type: "success" });
            } else {
                await this.orm.call("attendance.temp.block", "create_from_ui", [vals]);
                this.notification.add("Bloque temporal creado correctamente", { type: "success" });
            }
            await this.loadAll();
            this.cancelForm();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al guardar el bloque", { type: "danger" });
        }
    }

    deleteBlock(blockId) {
        this.dialog.add(Dialog, {
            title: "Eliminar bloque",
            body: "¿Confirma la eliminación de este bloque temporal? Los registros ya hechos se conservarán.",
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.temp.block", [blockId]);
                    this.notification.add("Bloque eliminado", { type: "success" });
                    await this.loadAll();
                } catch {
                    this.notification.add("No se pudo eliminar el bloque", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async toggleActive(blockId) {
        const b = this.state.blocks.find(x => x.id === blockId);
        if (!b) return;
        try {
            await this.orm.call("attendance.temp.block", "write_from_ui", [[blockId], { active: !b.active }]);
            this.notification.add(b.active ? "Bloque cancelado" : "Bloque reactivado", { type: "success" });
            await this.loadAll();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al cambiar el estado", { type: "danger" });
        }
    }

    regenerateToken(blockId) {
        this.dialog.add(Dialog, {
            title: "Regenerar QR",
            body: "El código QR anterior dejará de funcionar y se generará uno nuevo. ¿Continuar?",
            confirm: async () => {
                try {
                    await this.orm.call("attendance.temp.block", "action_regenerate_token", [[blockId]]);
                    this.notification.add("Nuevo QR generado", { type: "success" });
                    await this.loadAll();
                } catch (e) {
                    this.notification.add(e.data?.message || "Error al regenerar el QR", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    async showQrCard(blockId) {
        const data = await this.orm.call("attendance.temp.block", "get_block_card_data", [blockId]);
        if (!data || !data.qr_base64) {
            this.notification.add("El bloque no tiene QR generado", { type: "warning" });
            return;
        }
        const gpsLine = data.require_gps
            ? `<div><b>Ubicación:</b> GPS exigido (${data.classroom_name})</div>`
            : `<div><b>Ubicación:</b> ${data.classroom_name} (sin GPS)</div>`;
        const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><title>QR — ${data.name}</title>
<style>
  @page { size: A6; margin: 10mm; }
  * { box-sizing: border-box; font-family: 'Segoe UI', Arial, sans-serif; }
  body { background:#fff; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { border:2px solid #5273A8; border-radius:12px; padding:16px; max-width:250px; text-align:center; }
  .header { background:#5273A8; color:#fff; border-radius:8px; padding:8px 12px; margin-bottom:12px; }
  .header h2 { margin:0; font-size:1.05rem; font-weight:700; }
  .header p { margin:4px 0 0; font-size:0.62rem; opacity:0.85; letter-spacing:0.5px; text-transform:uppercase; }
  .qr-img { width:170px; height:170px; margin:0 auto 12px; display:block; border:1px solid #eee; border-radius:6px; }
  .info { text-align:left; font-size:0.72rem; line-height:1.6; color:#2d3748; }
  .info b { color:#5273A8; }
  .badge { display:inline-block; background:#DE979D; color:#7a2e34; border-radius:10px; padding:2px 10px; font-size:0.62rem; font-weight:700; margin-bottom:8px; }
  .flag { height:4px; background:linear-gradient(90deg,#F1D88B 33.33%,#6E8FC7 33.33% 66.66%,#DE979D 66.66%); border-radius:2px; margin-top:12px; }
  .footer { font-size:0.58rem; color:#a0aec0; margin-top:8px; }
</style></head>
<body><div class="card">
  <div class="header"><h2>UNEFA · Actividad</h2><p>Escanea para registrar</p></div>
  <div class="badge">${data.activity_type}</div>
  <img class="qr-img" src="data:image/png;base64,${data.qr_base64}" alt="QR"/>
  <div class="info">
    <div><b>Actividad:</b> ${data.name}</div>
    ${data.subject_name ? `<div><b>Materia:</b> ${data.subject_name}</div>` : ''}
    ${gpsLine}
    <div><b>Válido:</b> ${data.date_start} → ${data.date_end}</div>
  </div>
  <div class="flag"></div>
  <div class="footer">Universidad Nacional Experimental de las Fuerzas Armadas</div>
</div>
<script>window.onload=()=>{window.print();window.close();}</script>
</body></html>`;
        const win = window.open("", "_blank", "width=420,height=640");
        if (win) { win.document.write(html); win.document.close(); }
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_temp_block_manager", TempBlockManager);
