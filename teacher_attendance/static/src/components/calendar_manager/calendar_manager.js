/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Dialog } from "@web/core/dialog/dialog";

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
                "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];   // lunes primero

function pad(n) { return String(n).padStart(2, "0"); }

export class CalendarManager extends Component {
    static template = "teacher_attendance.CalendarManager";

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");
        this.action = useService("action");

        this.MONTHS = MONTHS;
        this.WEEKDAYS = WEEKDAYS;

        const thisYear = new Date().getFullYear();
        this.state = useState({
            year: thisYear,
            daysMap: {},          // 'YYYY-MM-DD' -> {id, name, day_type, is_recurring, note}
            isLoading: true,
            modal: { open: false },
        });

        onWillStart(async () => { await this.loadYear(); });
    }

    async loadYear() {
        this.state.isLoading = true;
        try {
            const days = await this.orm.call("attendance.calendar.day", "get_calendar_year", [this.state.year]);
            const map = {};
            for (const d of days) map[d.date] = d;
            this.state.daysMap = map;
        } catch (e) {
            this.notification.add("Error al cargar el calendario", { type: "danger" });
            this.state.daysMap = {};
        }
        this.state.isLoading = false;
    }

    // ── Navegación de año ───────────────────────────────
    get yearOptions() {
        const base = new Date().getFullYear();
        const opts = [];
        for (let y = base - 2; y <= base + 3; y++) opts.push(y);
        if (!opts.includes(this.state.year)) opts.push(this.state.year);
        return opts.sort((a, b) => a - b);
    }
    changeYear(y) { this.state.year = parseInt(y); this.loadYear(); }
    prevYear() { this.state.year -= 1; this.loadYear(); }
    nextYear() { this.state.year += 1; this.loadYear(); }
    onYearSelect(ev) { this.changeYear(ev.target.value); }

    // ── Construcción de la cuadrícula ───────────────────
    get calendar() {
        const year = this.state.year;
        return MONTHS.map((name, m) => {
            const firstDow = (new Date(year, m, 1).getDay() + 6) % 7;   // lunes=0
            const daysInMonth = new Date(year, m + 1, 0).getDate();
            const cells = [];
            for (let i = 0; i < firstDow; i++) cells.push(null);
            for (let d = 1; d <= daysInMonth; d++) {
                cells.push({ day: d, dateStr: `${year}-${pad(m + 1)}-${pad(d)}` });
            }
            while (cells.length % 7 !== 0) cells.push(null);
            const weeks = [];
            for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
            return { name, index: m, weeks };
        });
    }

    dayInfo(dateStr) { return this.state.daysMap[dateStr] || null; }
    dayClass(dateStr) {
        const info = this.dayInfo(dateStr);
        if (!info) return "";
        return info.day_type === 'holiday' ? 'cal-holiday' : 'cal-exception';
    }

    get summary() {
        let holiday = 0, exception = 0;
        for (const k in this.state.daysMap) {
            if (this.state.daysMap[k].day_type === 'holiday') holiday++;
            else exception++;
        }
        return { holiday, exception };
    }

    // ── Modal de día ────────────────────────────────────
    openDay(dateStr) {
        const info = this.dayInfo(dateStr);
        this.state.modal = info
            ? { open: true, dateStr, id: info.id, name: info.name,
                day_type: info.day_type, is_recurring: info.is_recurring,
                note: info.note || "", isExisting: true }
            : { open: true, dateStr, id: null, name: "",
                day_type: "holiday", is_recurring: false, note: "", isExisting: false };
    }
    closeModal() { this.state.modal = { open: false }; }

    get modalDateLabel() {
        const ds = this.state.modal.dateStr;
        if (!ds) return "";
        const [y, m, d] = ds.split("-").map(Number);
        return `${d} de ${MONTHS[m - 1]} de ${y}`;
    }

    async saveDay() {
        const mod = this.state.modal;
        if (!mod.name.trim()) {
            this.notification.add("La descripción es obligatoria", { type: "warning" });
            return;
        }
        const vals = {
            name: mod.name.trim(),
            date: mod.dateStr,
            day_type: mod.day_type,
            is_recurring: !!mod.is_recurring,
            note: mod.note || false,
        };
        try {
            if (mod.id) {
                await this.orm.write("attendance.calendar.day", [mod.id], vals);
                this.notification.add("Día actualizado", { type: "success" });
            } else {
                await this.orm.create("attendance.calendar.day", [vals]);
                this.notification.add("Día agregado al calendario", { type: "success" });
            }
            this.closeModal();
            await this.loadYear();
        } catch (e) {
            this.notification.add(e.data?.message || "Error al guardar el día", { type: "danger" });
        }
    }

    deleteDay() {
        const mod = this.state.modal;
        if (!mod.id) return;
        const warn = mod.is_recurring
            ? "Este día es recurrente: anularlo lo eliminará de TODOS los años. ¿Continuar?"
            : "¿Anular este día del calendario?";
        this.dialog.add(Dialog, {
            title: "Anular día",
            body: warn,
            confirm: async () => {
                try {
                    await this.orm.unlink("attendance.calendar.day", [mod.id]);
                    this.notification.add("Día anulado", { type: "success" });
                    this.closeModal();
                    await this.loadYear();
                } catch (e) {
                    this.notification.add(e.data?.message || "Error al anular", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    // ── Duplicar año anterior ───────────────────────────
    duplicatePrevYear() {
        const src = this.state.year - 1;
        this.dialog.add(Dialog, {
            title: "Duplicar año anterior",
            body: `Se copiarán los días puntuales de ${src} a ${this.state.year}. ` +
                  `Los recurrentes ya aplican automáticamente. ¿Continuar?`,
            confirm: async () => {
                try {
                    const res = await this.orm.call("attendance.calendar.day", "duplicate_year",
                        [src, this.state.year]);
                    this.notification.add(`${res.created} día(s) copiado(s) de ${src}`,
                        { type: res.created ? "success" : "warning" });
                    await this.loadYear();
                } catch (e) {
                    this.notification.add(e.data?.message || "Error al duplicar", { type: "danger" });
                }
            },
            cancel: () => {},
        });
    }

    goBack() {
        this.action.doAction("teacher_attendance.action_attendance_dashboard", { clearBreadcrumbs: true });
    }
}

registry.category("actions").add("action_calendar_manager", CalendarManager);
